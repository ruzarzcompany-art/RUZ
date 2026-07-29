/**
 * صفحة طباعة المستندات.
 *
 * تدعم مسارين:
 *  1) حزمة النماذج الجديدة:
 *     `?doc=<key>&employeeId=&refId=&month=&branchId=&date=&from=&to=&closingId=`
 *     — تُملأ تلقائياً من `GET /api/documents/data` وتُسجَّل في «النماذج المُصدرة».
 *     الكشوف غير المرتبطة بموظف (كشف التحضير والانصراف، تقفيلات الكاشير)
 *     تستخدم `branchId` + `date` أو `from`/`to`.
 *  2) المسار القديم: `?doc=payroll|contract|voucher&id=<id>` — يبقى عاملاً
 *     لأن أزرار الطباعة في شاشات النماذج والرواتب تستخدمه.
 *
 * هوية المؤسسة (الشعار، التذييل، تصميم الورقة) تُطبَّق على المسارين معاً،
 * والتصدير إلى PDF يتم عبر طباعة المتصفح بدل مكتبة PDF على الخادم.
 */

import { api, el, formatDateTime, formatMoney, getToken, label, requireLogin } from "../api.js";
import {
  applyPaperDesign,
  documentFooter,
  documentHeader,
  documentMeta,
  loadIdentity,
  paperNote,
  PAPER_CHOICES,
  watermark,
} from "./identity.js";
import { TEMPLATES, legalNotice, pairs, signatures } from "./templates.js";

const params = new URLSearchParams(window.location.search);
const docKey = params.get("doc") ?? "payroll";
const legacyId = Number(params.get("id"));

const container = () => el("doc");

/* ── مقاس الورق ─────────────────────────────────────────────────
 * مقاس الورقة يأتي من إعدادات المؤسسة، لكن الطابعة قد تكون محمَّلة
 * بمقاس آخر (Letter مقابل A4 مثلاً). عند اختلاف المقاسين يقصّ المتصفح
 * المحتوى أو يُصغّره فيخرج نصف الكشف وتضيع بقية الصفحات، لذلك يوجد
 * مُبدِّل أعلى الصفحة يُعيد كتابة قاعدة `@page` فوراً ويُحفظ الاختيار
 * محلياً ليُطبَّق على المطبوعات التالية.
 */

const PAPER_PREF_KEY = "sijl:print:paper";

let activeIdentity = null;

function readPaperPreference() {
  try {
    const raw = window.localStorage.getItem(PAPER_PREF_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return null;
    const size = PAPER_CHOICES.some((choice) => choice.value === saved.size) ? saved.size : null;
    const orientation =
      saved.orientation === "landscape" || saved.orientation === "portrait"
        ? saved.orientation
        : null;
    return size || orientation ? { size, orientation } : null;
  } catch {
    return null;
  }
}

function savePaperPreference(size, orientation) {
  try {
    window.localStorage.setItem(PAPER_PREF_KEY, JSON.stringify({ size, orientation }));
  } catch {
    // التخزين المحلي قد يكون معطَّلاً — الاختيار يبقى فعّالاً لهذه الصفحة فقط
  }
}

/** يدمج اختيار المستخدم للورق فوق إعدادات المؤسسة. */
function withPaper(identity, override) {
  if (!override) return identity;
  return {
    ...identity,
    paperSize: override.size ?? identity.paperSize,
    paperOrientation: override.orientation ?? identity.paperOrientation,
  };
}

/** يطبّق تصميم الورقة ويحدّث السطر الإرشادي معاً. */
function applyDesign(identity) {
  activeIdentity = identity;
  applyPaperDesign(identity);
  el("print-note").textContent = paperNote(identity);
}

function onPaperChange() {
  const size = el("print-paper").value;
  const orientation = el("print-orientation").value;
  savePaperPreference(size, orientation);
  applyDesign({ ...(activeIdentity ?? {}), paperSize: size, paperOrientation: orientation });
}

/** يهيّئ مُبدِّل مقاس الورق واتجاهه ويضبطه على تصميم المستند الحالي. */
function setupPaperControls(identity) {
  const paperSelect = el("print-paper");
  const orientationSelect = el("print-orientation");
  if (!paperSelect || !orientationSelect) return;

  if (paperSelect.options.length === 0) {
    for (const choice of PAPER_CHOICES) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      paperSelect.append(option);
    }
    paperSelect.addEventListener("change", onPaperChange);
    orientationSelect.addEventListener("change", onPaperChange);
  }

  paperSelect.value = PAPER_CHOICES.some((choice) => choice.value === identity.paperSize)
    ? identity.paperSize
    : "A4";
  orientationSelect.value = identity.paperOrientation === "landscape" ? "landscape" : "portrait";
}

function fail(message) {
  const node = container();
  node.textContent = "";
  const alert = document.createElement("p");
  alert.className = "alert alert--error";
  alert.textContent = message;
  node.append(alert);
}

/** يبني الورقة كاملة: علامة مائية + ترويسة + محتوى + توقيعات + تذييل. */
function compose(company, { title, subtitle, meta, body, signLabels, notice }) {
  const node = container();
  node.textContent = "";
  node.classList.add("sheet--custom");

  const mark = watermark(company);
  if (mark) node.append(mark);

  node.append(documentHeader(company, title, subtitle));

  if (meta && meta.length > 0) node.append(documentMeta(meta));

  for (const part of body) {
    if (part) node.append(part);
  }

  const legal = legalNotice(notice);
  if (legal) node.append(legal);

  if (company.showSignatures && signLabels && signLabels.length > 0) {
    node.append(signatures(signLabels));
  }

  const footer = documentFooter(company);
  if (footer) node.append(footer);
}

/* ── المسار الجديد: حزمة النماذج ───────────────────────────────── */

async function renderPackaged(company) {
  const query = new URLSearchParams({ doc: docKey });
  for (const key of [
    "employeeId",
    "refId",
    "month",
    "branchId",
    "date",
    "from",
    "to",
    "closingId",
    "itemId",
    "movementType",
  ]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }

  const result = await api(`/documents/data?${query.toString()}`);
  if (!result.ok) {
    fail(result.error ?? "تعذّر تحميل بيانات النموذج");
    return;
  }

  const template = TEMPLATES[docKey];
  if (!template) {
    fail("قالب هذا النموذج غير متاح في صفحة الطباعة.");
    return;
  }

  // إعدادات المؤسسة القادمة مع البيانات أحدث من النسخة المخزَّنة محلياً،
  // ويبقى اختيار المستخدم للورق فوقها لأنه يطابق الطابعة الفعلية.
  const identity = withPaper({ ...company, ...(result.company ?? {}) }, readPaperPreference());
  applyDesign(identity);
  setupPaperControls(identity);

  const subtitleParts = [
    result.employee ? `${result.employee.fullName} — ${result.employee.employeeCode}` : "",
    result.month ?? "",
    result.rosterSheet ? `كشف يوم ${result.rosterSheet.date}` : "",
    result.cashier && result.cashier.from !== result.cashier.to
      ? `${result.cashier.from} — ${result.cashier.to}`
      : "",
    result.inventory?.kind === "movement"
      ? `حركة رقم ${result.inventory.movement?.id ?? ""}`
      : "",
    result.inventory?.kind === "countSheet" ? `جرد يوم ${result.inventory.date}` : "",
  ].filter(Boolean);

  compose(identity, {
    title: result.doc?.title ?? docKey,
    subtitle: subtitleParts.join(" | "),
    meta: [
      ["التاريخ", result.today],
      ["الفرع", result.branch?.name],
      ["أصدره", result.issuedBy?.fullName],
    ],
    body: template.render(result),
    signLabels: template.signatures,
    notice: result.legalNotice,
  });

  // تسجيل النموذج في «النماذج المُصدرة» — لا يُعطّل الطباعة عند الفشل
  api("/documents/issues", {
    method: "POST",
    body: {
      docType: docKey,
      title: result.doc?.title,
      employeeId: result.employee?.id ?? null,
      branchId: result.branch?.id ?? null,
      refId: params.get("refId") ? Number(params.get("refId")) : null,
      payload: {
        month: result.month ?? null,
        date: result.rosterSheet?.date ?? null,
        from: result.cashier?.from ?? null,
        to: result.cashier?.to ?? null,
      },
    },
  }).catch(() => {});
}

/* ── المسار القديم: مسير راتب، عقد مسجَّل، سند ─────────────────── */

async function renderLegacyPayroll(company) {
  const result = await api(`/payroll/slips/${legacyId}`);
  if (!result.ok) {
    fail(result.error ?? "تعذّر تحميل المسير");
    return;
  }

  const slip = result.item;
  const currency = slip.currency ?? company.currency ?? "SAR";

  const table = document.createElement("table");
  table.className = "sheet__table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of ["البند", "القيمة"]) {
    const th = document.createElement("th");
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  const lines = [
    ["الراتب الأساسي", slip.basicSalary],
    ["إجمالي البدلات", slip.allowancesTotal],
    [`الأوفرتايم (${slip.overtimeHours ?? 0} ساعة)`, slip.overtimeAmount],
    ["المكافآت", slip.bonusesAmount],
    ["السلف المخصومة", -(slip.advancesAmount ?? 0)],
    [`خصم الساعات (${slip.deductedHours ?? 0} ساعة)`, -(slip.hoursDeductionAmount ?? 0)],
    ["خصومات أخرى", -(slip.otherDeductions ?? 0)],
  ];

  for (const [name, value] of lines) {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = name;
    const valueCell = document.createElement("td");
    valueCell.textContent = formatMoney(value, currency);
    tr.append(nameCell, valueCell);
    tbody.append(tr);
  }

  const total = document.createElement("tr");
  total.className = "is-total";
  const totalLabel = document.createElement("td");
  totalLabel.textContent = "صافي المستحق";
  const totalValue = document.createElement("td");
  totalValue.textContent = formatMoney(slip.netPay, currency);
  total.append(totalLabel, totalValue);
  tbody.append(total);
  table.append(thead, tbody);

  const notes = document.createElement("p");
  notes.className = "sheet__note";
  notes.textContent = slip.notes ? `ملاحظات: ${slip.notes}` : "";

  compose(company, {
    title: "مسير راتب شهري",
    subtitle: `الشهر ${slip.period} — ${slip.fullName ?? ""}`,
    meta: [["الفرع", slip.branchName], ["الرقم الوظيفي", slip.employeeCode]],
    body: [
      pairs([
        ["الموظف", `${slip.employeeCode ?? ""} — ${slip.fullName ?? ""}`],
        ["المسمى الوظيفي", slip.jobTitle],
        ["الفرع", slip.branchName],
        ["الشهر", slip.period],
        ["ساعات العمل الفعلية", `${slip.workedHours ?? 0} ساعة`],
        ["أجر الساعة", formatMoney(slip.hourlyRate, currency)],
      ]),
      table,
      slip.notes ? notes : null,
    ],
    signLabels: ["الموظف", "الموارد البشرية", "المدير المالي"],
  });
}

async function loadForm(resource) {
  const result = await api(`/forms/${resource}/${legacyId}`);
  return result.ok ? result.item : null;
}

async function renderLegacyContract(company) {
  const contract = await loadForm("contracts");
  if (!contract) {
    fail("العقد غير موجود أو لا تملك صلاحية عرضه.");
    return;
  }

  const terms = document.createElement("section");
  terms.className = "sheet__terms";
  if (contract.terms) {
    const title = document.createElement("h2");
    title.textContent = "الشروط والأحكام";
    const text = document.createElement("p");
    text.textContent = contract.terms;
    terms.append(title, text);
  }

  compose(company, {
    title: "عقد عمل",
    subtitle: `رقم العقد ${contract.contractNumber ?? "—"}`,
    meta: [["التاريخ", contract.startDate]],
    body: [
      pairs([
        ["الموظف", `${contract.employeeCode ?? ""} — ${contract.fullName ?? ""}`],
        ["المسمى الوظيفي", contract.jobTitle],
        ["تاريخ البداية", contract.startDate],
        ["تاريخ النهاية", contract.endDate ?? "غير محدّد (عقد مفتوح)"],
        ["الراتب الأساسي", formatMoney(contract.basicSalary)],
        ["إجمالي البدلات", formatMoney(contract.allowancesTotal)],
        ["فترة التجربة", `${contract.probationMonths ?? 0} شهر`],
        ["ساعات العمل", contract.workingHours],
        ["حالة العقد", label(contract.status)],
        ["تاريخ التوقيع", contract.signedAt ?? "—"],
      ]),
      contract.terms ? terms : null,
    ],
    signLabels: ["الطرف الأول (المنشأة)", "الطرف الثاني (الموظف)"],
    notice:
      "هذا النموذج صيغة عامة لأغراض تنظيمية داخلية، وليس استشارة قانونية رسمية. " +
      "يُنصح بمراجعته من مستشار قانوني مختص قبل الاعتماد أو التوقيع.",
  });
}

async function renderLegacyVoucher(company) {
  const voucher = await loadForm("vouchers");
  if (!voucher) {
    fail("السند غير موجود أو لا تملك صلاحية عرضه.");
    return;
  }

  compose(company, {
    title: voucher.type === "receipt" ? "سند قبض" : "سند صرف",
    subtitle: `رقم السند ${voucher.voucherNumber ?? "—"}`,
    meta: [["التاريخ", voucher.voucherDate]],
    body: [
      pairs([
        ["التاريخ", voucher.voucherDate],
        ["المبلغ", formatMoney(voucher.amount)],
        ["طريقة الدفع", label(voucher.method)],
        [
          "الموظف المرتبط",
          voucher.fullName ? `${voucher.employeeCode ?? ""} — ${voucher.fullName}` : "—",
        ],
        ["المستفيد", voucher.beneficiaryName || voucher.fullName || "—"],
        ["البيان", voucher.description],
        ["تاريخ الإنشاء", formatDateTime(voucher.createdAt)],
      ]),
    ],
    signLabels: [
      voucher.type === "receipt" ? "المستلم" : "المستفيد",
      "أمين الصندوق",
      "الاعتماد",
    ],
  });
}

const LEGACY = {
  payroll: renderLegacyPayroll,
  contract: renderLegacyContract,
  voucher: renderLegacyVoucher,
};

el("print-now").addEventListener("click", () => window.print());
el("print-back").addEventListener("click", () => {
  // الصفحة تُفتح عادةً في تبويب جديد؛ وإن لم تكن كذلك نرجع للخلف.
  window.close();
  if (!window.closed) history.back();
});

async function boot() {
  if (!getToken()) {
    requireLogin();
    return;
  }

  const company = withPaper(await loadIdentity(), readPaperPreference());
  applyDesign(company);
  setupPaperControls(company);

  // `?id=` يعني الطباعة القديمة لسجل بعينه (مسير/عقد/سند)
  const useLegacy = Number.isInteger(legacyId) && legacyId > 0 && LEGACY[docKey];
  if (useLegacy) {
    await LEGACY[docKey](company);
    return;
  }

  if (TEMPLATES[docKey]) {
    await renderPackaged(company);
    return;
  }

  fail("نوع المستند غير مدعوم.");
}

boot();
