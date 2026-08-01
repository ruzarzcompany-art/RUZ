/**
 * تقفيل الكاشير اليومي.
 *
 * الكاشير يرفع تقفيله بنفسه (مبيعات، نقد، شبكة، مصروفات، النقد المعدود)
 * والخادم هو من يحسب النقد المتوقّع والفرق، فلا يمكن التلاعب بالحساب من
 * المتصفح. من يملك صلاحية المراجعة يرى تقفيلات الجميع ويعتمدها أو يعترض.
 */

import {
  api,
  button,
  el,
  formatMoney,
  openDocument,
  row,
  setAlert,
  setBusy,
  todayIso,
} from "../api.js";
import { createPager } from "../pagination.js";

const SHIFT_LABELS = { morning: "صباحية", evening: "مسائية", full: "يوم كامل" };
const CLOSING_STATUS = {
  submitted: "مرفوع",
  reviewed: "مُراجَع",
  disputed: "معترض عليه",
};

/** الحقول المالية بترتيب ظهورها في النموذج. */
const MONEY_FIELDS = [
  ["openingFloat", "عهدة بداية الوردية"],
  ["totalSales", "إجمالي المبيعات"],
  ["cashSales", "مبيعات نقدية"],
  ["cardSales", "مبيعات شبكة"],
  ["foodicsSales", "شبكة foodics"],
  ["transferSales", "تحويلات"],
  ["deliverySales", "مبيعات التوصيل"],
  ["otherSales", "مبيعات أخرى"],
  ["discounts", "الخصومات"],
  ["refunds", "المرتجعات"],
  ["expenses", "مصروفات نقدية"],
  ["countedCash", "النقد المعدود في الدرج"],
];

/** حقول يحسبها الخادم من البنود، فلا تُدخل يدوياً. */
const DERIVED_FIELDS = new Set(["cardSales", "deliverySales"]);

/** جدول كل تصنيف من بنود التقفيل. */
const LINE_TABLES = {
  network: {
    table: "cashier-lines-network",
    empty: "cashier-lines-network-empty",
    namePlaceholder: "اسم الشبكة أو الجهاز",
  },
  delivery_app: {
    table: "cashier-lines-delivery",
    empty: "cashier-lines-delivery-empty",
    namePlaceholder: "اسم التطبيق",
  },
};

/** تقسيم صفحات جداول الشاشة: التقفيلات وبنود كل تصنيف. */
const closingsPager = createPager("cashier-table", { unit: "تقفيل" });
const linePagers = {
  network: createPager(LINE_TABLES.network.table, { unit: "بند" }),
  delivery_app: createPager(LINE_TABLES.delivery_app.table, { unit: "تطبيق" }),
};

const state = {
  can: () => false,
  /** درجة المستخدم في بند «تقفيل الكاشير» (0..4) كما حسبها الخادم. */
  levelOf: () => 0,
  /** درجة الحذف المستقلة في البند نفسه. */
  canDeleteIn: () => false,
  canReview: false,
  closings: [],
  editingId: null,
  /** بنود الشبكة وتطبيقات التواصل للتقفيل المعروض في النموذج. */
  lines: [],
  defaultNetworkLines: [],
  defaultDeliveryApps: [],
  /** معرّف تقفيل اليوم المرفوع فعلاً — شرط تفعيل زر الطباعة. */
  todayClosingId: null,
};

/* ── بنود الشبكة وتطبيقات التواصل ──────────────────────────────── */

/** بنود البداية لتقفيل جديد: الشبكات والتطبيقات المُعرَّفة من الخادم بمبالغ صفرية. */
function defaultLines() {
  return [
    ...state.defaultNetworkLines.map((label) => ({
      category: "network",
      label,
      amount: 0,
      reference: "",
    })),
    ...state.defaultDeliveryApps.map((label) => ({
      category: "delivery_app",
      label,
      amount: 0,
      reference: "",
    })),
  ];
}

/**
 * يُعيد حساب الحقلين المشتقّين محلياً بنفس قاعدة الخادم:
 * الشبكة = مجموع بنود الشبكة + شبكة foodics، والتوصيل = مجموع بنود التطبيقات.
 */
function recomputeDerived() {
  const sum = (category) =>
    state.lines
      .filter((line) => line.category === category)
      .reduce((total, line) => total + Number(line.amount || 0), 0);

  const foodics = Number(el("cashier-foodicsSales").value || 0);
  el("cashier-cardSales").value = (Math.round((sum("network") + foodics) * 100) / 100).toFixed(2);
  el("cashier-deliverySales").value = (Math.round(sum("delivery_app") * 100) / 100).toFixed(2);
  updatePreview();
}

function lineField(value, { type = "text", placeholder = "", onInput }) {
  const input = document.createElement("input");
  input.type = type;
  input.className = "input--cell";
  input.placeholder = placeholder;
  if (type === "number") {
    input.step = "any";
    input.min = "0";
  }
  input.value = value;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/**
 * بنود تصنيف واحد. `page` يمرّ إلى المُقسِّم: البند المضاف حديثاً يُعرض في آخر
 * صفحة حتى لا يختفي عن الكاشير، والحذف يُبقيه في مكانه.
 */
function renderLines(category, { page = "keep" } = {}) {
  const meta = LINE_TABLES[category];
  const own = state.lines.filter((line) => line.category === category);

  linePagers[category].render(
    own,
    (line) =>
      row([
        lineField(line.label, {
          placeholder: meta.namePlaceholder,
          onInput: (value) => {
            line.label = value;
          },
        }),
        lineField(line.reference ?? "", {
          placeholder: "اختياري",
          onInput: (value) => {
            line.reference = value;
          },
        }),
        lineField(line.amount ?? 0, {
          type: "number",
          onInput: (value) => {
            line.amount = Number(value || 0);
            recomputeDerived();
          },
        }),
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => {
            state.lines = state.lines.filter((item) => item !== line);
            renderLines(category);
            recomputeDerived();
          },
        }),
      ]),
    { page },
  );

  el(meta.empty).hidden = own.length > 0;
}

function renderAllLines() {
  renderLines("network", { page: "first" });
  renderLines("delivery_app", { page: "first" });
}

function addLine(category) {
  state.lines.push({ category, label: "", amount: 0, reference: "" });
  renderLines(category, { page: "last" });
  recomputeDerived();
}

/* ── النموذج ───────────────────────────────────────────────────── */

function readForm() {
  const payload = {
    businessDate: el("cashier-date").value,
    shift: el("cashier-shift").value,
    invoiceCount: Number(el("cashier-invoices").value || 0),
    notes: el("cashier-notes").value.trim(),
    // البنود تُرسل كاملة في كل مرة: الخادم يستبدل بنود التقفيل بها
    lines: state.lines
      .filter((line) => line.label.trim() !== "")
      .map((line, index) => ({
        category: line.category,
        label: line.label.trim(),
        amount: Number(line.amount || 0),
        reference: (line.reference ?? "").trim(),
        sortOrder: index,
      })),
  };

  for (const [key] of MONEY_FIELDS) {
    payload[key] = Number(el(`cashier-${key}`).value || 0);
  }

  if (state.canReview) {
    const branchId = el("cashier-branch").value;
    const employeeId = el("cashier-employee").value;
    if (branchId) payload.branchId = Number(branchId);
    if (employeeId) payload.employeeId = Number(employeeId);
  }

  return payload;
}

function fillForm(closing) {
  el("cashier-date").value = closing?.businessDate ?? todayIso();
  el("cashier-shift").value = closing?.shift ?? "full";
  el("cashier-invoices").value = closing?.invoiceCount ?? 0;
  el("cashier-notes").value = closing?.notes ?? "";

  for (const [key] of MONEY_FIELDS) {
    el(`cashier-${key}`).value = closing?.[key] ?? 0;
  }

  // تقفيل محفوظ بلا بنود (مُدخل قبل هذه الميزة) يبدأ من البنود الافتراضية
  state.lines =
    closing?.lines && closing.lines.length > 0
      ? closing.lines.map((line) => ({
          category: line.category,
          label: line.label,
          amount: Number(line.amount ?? 0),
          reference: line.reference ?? "",
        }))
      : defaultLines();

  state.editingId = closing?.id ?? null;
  renderAllLines();
  recomputeDerived();
}

/**
 * معاينة محلية للفرق قبل الإرسال — الخادم يُعيد حسابها وهو المرجع،
 * لكن رؤيتها فوراً تساعد الكاشير على اكتشاف خطأ الإدخال.
 */
function updatePreview() {
  const value = (key) => Number(el(`cashier-${key}`).value || 0);
  const expected =
    value("openingFloat") + value("cashSales") - value("expenses") - value("refunds");
  const difference = value("countedCash") - expected;

  el("cashier-expected").textContent = formatMoney(expected);
  const diffNode = el("cashier-difference");
  diffNode.textContent = formatMoney(difference);
  diffNode.classList.toggle("is-negative", difference < -0.009);
  diffNode.classList.toggle("is-positive", difference > 0.009);

  el("cashier-diff-hint").textContent =
    difference < -0.009 ? "عجز في الدرج" : difference > 0.009 ? "زيادة في الدرج" : "مطابق";
}

/** زر طباعة تقفيل اليوم لا يعمل قبل رفع التقفيل فعلاً. */
function updatePrintState() {
  const ready = state.todayClosingId !== null;
  el("cashier-print").disabled = !ready;
  el("cashier-print-hint").textContent = ready
    ? "يمكنك الآن طباعة تقفيل اليوم كما هو محفوظ في الخادم."
    : "الطباعة تتاح بعد رفع تقفيل اليوم فقط.";
}

function printToday() {
  if (state.todayClosingId === null) {
    setAlert(el("cashier-result"), "ارفع تقفيل اليوم أولاً ثم اطبعه.", "warn");
    return;
  }
  openDocument("cashier_closing", { closingId: state.todayClosingId });
}

async function submitClosing(event) {
  event.preventDefault();
  const submit = el("cashier-submit");
  setBusy(submit, true);

  const result = await api("/cashier/closings", { method: "POST", body: readForm() });
  setBusy(submit, false);

  setAlert(
    el("cashier-result"),
    result.ok ? result.message : (result.error ?? "تعذّر رفع التقفيل"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    state.editingId = result.closing?.id ?? null;
    state.todayClosingId = result.closing?.id ?? state.todayClosingId;
    updatePrintState();
    await loadClosings();
  }
}

/* ── قائمة التقفيلات ───────────────────────────────────────────── */

function statusChip(status) {
  const chip = document.createElement("span");
  chip.className = `badge badge--${status}`;
  chip.textContent = CLOSING_STATUS[status] ?? status;
  return chip;
}

function differenceCell(value) {
  const node = document.createElement("span");
  node.textContent = formatMoney(value);
  node.classList.toggle("is-negative", value < -0.009);
  node.classList.toggle("is-positive", value > 0.009);
  return node;
}

async function review(id, status) {
  const reviewNote = window.prompt(
    status === "reviewed" ? "ملاحظة الاعتماد (اختياري):" : "سبب الاعتراض:",
    "",
  );
  if (reviewNote === null) return;

  const result = await api(`/cashier/closings/${id}/review`, {
    method: "PATCH",
    body: { status, reviewNote },
  });

  setAlert(
    el("cashier-list-result"),
    result.ok
      ? status === "reviewed"
        ? "تم اعتماد التقفيل."
        : "تم تسجيل الاعتراض."
      : (result.error ?? "تعذّر تحديث الحالة"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) await loadClosings();
}

async function removeClosing(closing) {
  if (!window.confirm(`حذف تقفيل ${closing.businessDate}؟ لا يمكن التراجع.`)) return;
  const result = await api(`/cashier/closings/${closing.id}`, { method: "DELETE" });
  setAlert(
    el("cashier-list-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await loadClosings();
}

function renderClosings() {
  closingsPager.render(state.closings, (closing) => {
    const actions = document.createElement("span");
    actions.className = "row-actions";

    actions.append(
      button("تعبئة", {
        onClick: () => {
          fillForm(closing);
          el("cashier-form").scrollIntoView({ behavior: "smooth", block: "center" });
        },
      }),
      button("طباعة", {
        onClick: () => openDocument("cashier_closing", { closingId: closing.id }),
      }),
    );

    // الاعتماد/الاعتراض إجراء موافقة (الدرجة الرابعة)، والتعديل يحتاج
    // الثالثة، والحذف درجته المستقلة — والخادم يفرضها جميعاً على كل حال.
    if (state.canReview && state.levelOf("cashier_closing") >= 4) {
      actions.append(
        button("اعتماد", { onClick: () => review(closing.id, "reviewed") }),
        button("اعتراض", { onClick: () => review(closing.id, "disputed") }),
      );
    }

    if (state.canReview && state.canDeleteIn("cashier_closing")) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeClosing(closing),
        }),
      );
    }

    return row([
      closing.businessDate,
      closing.branchName ?? "—",
      closing.employeeName ?? "—",
      SHIFT_LABELS[closing.shift] ?? closing.shift,
      formatMoney(closing.totalSales),
      formatMoney(closing.cashSales),
      formatMoney(closing.cardSales),
      formatMoney(closing.expectedCash),
      formatMoney(closing.countedCash),
      differenceCell(closing.difference),
      statusChip(closing.status),
      actions,
    ]);
  });

  el("cashier-empty").hidden = state.closings.length > 0;
}

function renderSummary(summary) {
  const box = el("cashier-summary");
  box.textContent = "";
  if (!summary) return;

  const items = [
    ["عدد التقفيلات", String(summary.count ?? 0)],
    ["إجمالي المبيعات", formatMoney(summary.totalSales)],
    ["النقد", formatMoney(summary.cashSales)],
    ["الشبكة", formatMoney(summary.cardSales)],
    ["شبكة foodics", formatMoney(summary.foodicsSales)],
    ["تطبيقات التواصل", formatMoney(summary.deliverySales)],
    ["صافي الفروقات", formatMoney(summary.difference)],
  ];

  for (const [labelText, value] of items) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const strong = document.createElement("strong");
    strong.textContent = value;
    chip.append(document.createTextNode(`${labelText}: `), strong);
    box.append(chip);
  }
}

export async function loadClosings() {
  const params = new URLSearchParams();
  const from = el("cashier-filter-from").value;
  const to = el("cashier-filter-to").value;
  const branchId = el("cashier-filter-branch").value;
  const status = el("cashier-filter-status").value;

  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (branchId) params.set("branchId", branchId);
  if (status) params.set("status", status);

  const query = params.toString();
  const result = await api(`/cashier/closings${query ? `?${query}` : ""}`);

  if (!result.ok) {
    state.closings = [];
    renderClosings();
    setAlert(el("cashier-list-result"), result.error ?? "تعذّر تحميل التقفيلات", "error");
    return;
  }

  state.closings = result.closings ?? [];
  state.canReview = state.can("cashier.review");
  renderClosings();
  renderSummary(result.summary);

  if (result.scope === "own") {
    setAlert(el("cashier-list-result"), "تعرض تقفيلاتك أنت فقط حسب صلاحياتك.", "warn");
  } else {
    setAlert(el("cashier-list-result"), "");
  }
}

/* ── مدى العرض والطباعة ────────────────────────────────────────── */

/** آخر يوم في شهر `YYYY-MM`. */
function monthEnd(month) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

/**
 * «يوم واحد» و«شهر» يملآن حقلي التاريخ تلقائياً ويقفلانهما،
 * و«من — إلى» يتركهما للمستخدم. العرض والطباعة يستخدمان النطاق نفسه.
 */
function applyPeriod() {
  const period = el("cashier-filter-period").value;
  const anchor = el("cashier-filter-from").value || el("cashier-date").value || todayIso();
  const fromNode = el("cashier-filter-from");
  const toNode = el("cashier-filter-to");

  if (period === "day") {
    fromNode.value = anchor;
    toNode.value = anchor;
  } else if (period === "month") {
    const month = anchor.slice(0, 7);
    fromNode.value = `${month}-01`;
    toNode.value = monthEnd(month);
  }

  toNode.readOnly = period !== "range";
}

function printRange() {
  const from = el("cashier-filter-from").value || todayIso();
  const to = el("cashier-filter-to").value || from;

  if (to < from) {
    setAlert(el("cashier-list-result"), "تاريخ النهاية قبل تاريخ البداية.", "error");
    return;
  }

  openDocument("cashier_closings_range", {
    from,
    to,
    branchId: el("cashier-filter-branch").value,
  });
}

/* ── التهيئة ───────────────────────────────────────────────────── */

export function initCashierModule({ can, levelOf, canDeleteIn }) {
  state.can = can;
  if (levelOf) state.levelOf = levelOf;
  if (canDeleteIn) state.canDeleteIn = canDeleteIn;
  state.canReview = can("cashier.review");

  el("cashier-form").addEventListener("submit", submitClosing);
  el("cashier-reset").addEventListener("click", () => {
    fillForm(null);
    setAlert(el("cashier-result"), "");
  });

  for (const [key] of MONEY_FIELDS) {
    if (DERIVED_FIELDS.has(key)) continue;
    el(`cashier-${key}`).addEventListener(
      "input",
      key === "foodicsSales" ? recomputeDerived : updatePreview,
    );
  }

  el("cashier-add-network").addEventListener("click", () => addLine("network"));
  el("cashier-add-delivery").addEventListener("click", () => addLine("delivery_app"));
  el("cashier-print").addEventListener("click", printToday);

  el("cashier-filter-run").addEventListener("click", loadClosings);
  el("cashier-filter-period").addEventListener("change", () => {
    applyPeriod();
    loadClosings();
  });
  el("cashier-filter-from").addEventListener("change", applyPeriod);
  el("cashier-print-range").addEventListener("click", printRange);

  // صفوف «بالنيابة» لا تظهر إلا لمن يملك المراجعة
  el("cashier-onbehalf").hidden = !state.canReview;
  el("cashier-form").hidden = !can("cashier.submit");
  updatePrintState();
}

/** يُستدعى عند فتح التبويب: تعبئة التقفيل الحالي إن وُجد ثم القائمة. */
export async function refreshCashierPanel() {
  if (state.can("cashier.submit")) {
    const today = await api("/cashier/closings/today");
    if (today.ok) {
      el("cashier-date").value = today.businessDate;
      el("cashier-today-note").textContent = `تاريخ العمل بتوقيت الفرع: ${today.businessDate}`;
      state.defaultNetworkLines = today.defaultNetworkLines ?? [];
      state.defaultDeliveryApps = today.defaultDeliveryApps ?? [];

      const existing = today.closings?.[0];
      state.todayClosingId = existing?.id ?? null;
      updatePrintState();

      if (existing && state.editingId === null) fillForm(existing);
      else if (state.lines.length === 0) fillForm(null);
      else recomputeDerived();
    }
  }

  await loadClosings();
}
