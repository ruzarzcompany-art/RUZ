/**
 * صفحة طباعة المستندات: مسير راتب، عقد عمل، سند قبض/صرف.
 * التصدير إلى PDF يتم عبر طباعة المتصفح (`@media print` في styles.css)
 * بدل إضافة مكتبة PDF إلى الخادم.
 */

import { api, el, formatDateTime, formatMoney, getToken, label, requireLogin } from "../api.js";

const params = new URLSearchParams(window.location.search);
const doc = params.get("doc") ?? "payroll";
const id = Number(params.get("id"));

const ORG_NAME = "سِجل — نظام موظفي المطعم";

function heading(title, subtitle) {
  const head = document.createElement("header");
  head.className = "sheet__head";

  const org = document.createElement("p");
  org.className = "sheet__org";
  org.textContent = ORG_NAME;

  const h1 = document.createElement("h1");
  h1.className = "sheet__title";
  h1.textContent = title;

  const sub = document.createElement("p");
  sub.className = "sheet__sub";
  sub.textContent = subtitle;

  head.append(org, h1, sub);
  return head;
}

function pairs(rows) {
  const table = document.createElement("table");
  table.className = "sheet__pairs";
  const body = document.createElement("tbody");

  for (const [key, value] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = key;
    const td = document.createElement("td");
    td.textContent = value ?? "—";
    tr.append(th, td);
    body.append(tr);
  }

  table.append(body);
  return table;
}

function signatures(labels) {
  const wrap = document.createElement("div");
  wrap.className = "sheet__signs";
  for (const text of labels) {
    const box = document.createElement("div");
    box.className = "sheet__sign";
    const caption = document.createElement("p");
    caption.textContent = text;
    const line = document.createElement("span");
    line.className = "sheet__line";
    box.append(caption, line);
    wrap.append(box);
  }
  return wrap;
}

function fail(message) {
  el("doc").textContent = "";
  const note = document.createElement("p");
  note.className = "alert alert--error";
  note.textContent = message;
  el("doc").append(note);
}

async function renderPayroll() {
  const result = await api(`/payroll/slips/${id}`);
  if (!result.ok) return fail(result.error ?? "تعذّر تحميل المسير");

  const slip = result.item;
  const currency = slip.currency ?? "SAR";
  const container = el("doc");
  container.textContent = "";

  container.append(
    heading("مسير راتب شهري", `الشهر ${slip.period} — ${slip.fullName ?? ""}`),
    pairs([
      ["الموظف", `${slip.employeeCode ?? ""} — ${slip.fullName ?? ""}`],
      ["المسمى الوظيفي", slip.jobTitle],
      ["الفرع", slip.branchName],
      ["الشهر", slip.period],
      ["ساعات العمل الفعلية", `${slip.workedHours ?? 0} ساعة`],
      ["أجر الساعة", formatMoney(slip.hourlyRate, currency)],
    ]),
  );

  const table = document.createElement("table");
  table.className = "sheet__table";

  const head = document.createElement("thead");
  head.append(
    (() => {
      const tr = document.createElement("tr");
      for (const text of ["البند", "القيمة"]) {
        const th = document.createElement("th");
        th.textContent = text;
        tr.append(th);
      }
      return tr;
    })(),
  );

  const body = document.createElement("tbody");
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
    const th = document.createElement("td");
    th.textContent = name;
    const td = document.createElement("td");
    td.textContent = formatMoney(value, currency);
    tr.append(th, td);
    body.append(tr);
  }

  const total = document.createElement("tr");
  total.className = "is-total";
  const totalLabel = document.createElement("td");
  totalLabel.textContent = "صافي المستحق";
  const totalValue = document.createElement("td");
  totalValue.textContent = formatMoney(slip.netPay, currency);
  total.append(totalLabel, totalValue);
  body.append(total);

  table.append(head, body);
  container.append(table);

  if (slip.notes) {
    const note = document.createElement("p");
    note.className = "sheet__note";
    note.textContent = `ملاحظات: ${slip.notes}`;
    container.append(note);
  }

  container.append(signatures(["الموظف", "الموارد البشرية", "المدير المالي"]));
}

async function loadForm(resource) {
  const result = await api(`/forms/${resource}/${id}`);
  return result.ok ? result.item : null;
}

async function renderContract() {
  const contract = await loadForm("contracts");
  if (!contract) return fail("العقد غير موجود أو لا تملك صلاحية عرضه.");

  const container = el("doc");
  container.textContent = "";
  container.append(
    heading("عقد عمل", `رقم العقد ${contract.contractNumber ?? "—"}`),
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
  );

  if (contract.terms) {
    const terms = document.createElement("section");
    terms.className = "sheet__terms";
    const title = document.createElement("h2");
    title.textContent = "الشروط والأحكام";
    const text = document.createElement("p");
    text.textContent = contract.terms;
    terms.append(title, text);
    container.append(terms);
  }

  container.append(signatures(["الطرف الأول (المنشأة)", "الطرف الثاني (الموظف)"]));
}

async function renderVoucher() {
  const voucher = await loadForm("vouchers");
  if (!voucher) return fail("السند غير موجود أو لا تملك صلاحية عرضه.");

  const container = el("doc");
  container.textContent = "";
  container.append(
    heading(
      voucher.type === "receipt" ? "سند قبض" : "سند صرف",
      `رقم السند ${voucher.voucherNumber ?? "—"}`,
    ),
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
    signatures([
      voucher.type === "receipt" ? "المستلم" : "المستفيد",
      "أمين الصندوق",
      "الاعتماد",
    ]),
  );
}

const RENDERERS = {
  payroll: renderPayroll,
  contract: renderContract,
  voucher: renderVoucher,
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

  if (!Number.isInteger(id) || id <= 0) {
    fail("معرّف المستند غير صالح.");
    return;
  }

  const renderer = RENDERERS[doc];
  if (!renderer) {
    fail("نوع المستند غير مدعوم.");
    return;
  }

  el("print-note").textContent = "اختر «حفظ كـPDF» من نافذة الطباعة لتصدير المستند.";
  await renderer();
}

boot();
