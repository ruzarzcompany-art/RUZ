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
  row,
  setAlert,
  setBusy,
  todayIso,
} from "../api.js";

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
  ["transferSales", "تحويلات"],
  ["deliverySales", "مبيعات التوصيل"],
  ["otherSales", "مبيعات أخرى"],
  ["discounts", "الخصومات"],
  ["refunds", "المرتجعات"],
  ["expenses", "مصروفات نقدية"],
  ["countedCash", "النقد المعدود في الدرج"],
];

const state = {
  can: () => false,
  canReview: false,
  closings: [],
  editingId: null,
};

/* ── النموذج ───────────────────────────────────────────────────── */

function readForm() {
  const payload = {
    businessDate: el("cashier-date").value,
    shift: el("cashier-shift").value,
    invoiceCount: Number(el("cashier-invoices").value || 0),
    notes: el("cashier-notes").value.trim(),
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

  state.editingId = closing?.id ?? null;
  updatePreview();
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
  const body = el("cashier-table").querySelector("tbody");
  body.textContent = "";

  for (const closing of state.closings) {
    const actions = document.createElement("span");
    actions.className = "row-actions";

    actions.append(
      button("تعبئة", {
        onClick: () => {
          fillForm(closing);
          el("cashier-form").scrollIntoView({ behavior: "smooth", block: "center" });
        },
      }),
    );

    if (state.canReview) {
      actions.append(
        button("اعتماد", { onClick: () => review(closing.id, "reviewed") }),
        button("اعتراض", { onClick: () => review(closing.id, "disputed") }),
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeClosing(closing),
        }),
      );
    }

    body.append(
      row([
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
      ]),
    );
  }

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

/* ── التهيئة ───────────────────────────────────────────────────── */

export function initCashierModule({ can }) {
  state.can = can;
  state.canReview = can("cashier.review");

  el("cashier-form").addEventListener("submit", submitClosing);
  el("cashier-reset").addEventListener("click", () => {
    fillForm(null);
    setAlert(el("cashier-result"), "");
  });

  for (const [key] of MONEY_FIELDS) {
    el(`cashier-${key}`).addEventListener("input", updatePreview);
  }

  el("cashier-filter-run").addEventListener("click", loadClosings);

  // صفوف «بالنيابة» لا تظهر إلا لمن يملك المراجعة
  el("cashier-onbehalf").hidden = !state.canReview;
  el("cashier-form").hidden = !can("cashier.submit");
}

/** يُستدعى عند فتح التبويب: تعبئة التقفيل الحالي إن وُجد ثم القائمة. */
export async function refreshCashierPanel() {
  if (state.can("cashier.submit")) {
    const today = await api("/cashier/closings/today");
    if (today.ok) {
      el("cashier-date").value = today.businessDate;
      el("cashier-today-note").textContent = `تاريخ العمل بتوقيت الفرع: ${today.businessDate}`;
      const existing = today.closings?.[0];
      if (existing && state.editingId === null) fillForm(existing);
      else updatePreview();
    }
  }

  await loadClosings();
}
