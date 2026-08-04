/**
 * النقدية والخزينة في لوحة الإدارة.
 *
 * أربعة أقسام في شاشة واحدة، كلها تقرأ من مسارات /api/finance/*:
 * 1) المتبقي النقدي في الدرج ليوم مختار (المبيعات النقدية − مصاريف اليوم).
 * 2) السجل الموحّد للمصاريف والمشتريات النقدية — فاتورة واحدة تُسجَّل مرة
 *    وتُخصم مرة، ويقرأ منها التقفيل اليومي والتقرير الشهري معاً.
 * 3) الرصيد النقدي الشهري: المرحّل + النقدي المتراكم − المصاريف = الصافي.
 * 4) تسوية الشبكات وتطبيقات التوصيل: العمولة والنسبة والضريبة تُحسب في
 *    الخادم من المبيعات والمستلم، ثم إقفال الشهر بترحيل أو تصفير.
 *
 * الإظهار والإخفاء يعتمد قدرات المستخدم القادمة من GET /finance/meta، وأزرار
 * «اعتماد الترحيل» و«تصفير» لا تُبنى أصلاً لمن لا يملك بندها — والخادم يرفض
 * الطلب على كل حال، فالإخفاء راحة للمستخدم لا حماية بحد ذاته.
 */

import {
  api,
  button,
  currentMonthKey,
  el,
  formatDateTime,
  formatMoney,
  row,
  setAlert,
  setBusy,
  todayIso,
} from "../api.js";
import { createPager } from "../pagination.js";

const SHIFT_LABELS = { morning: "صباحية", evening: "مسائية", full: "يوم كامل" };
const KIND_LABELS = { expense: "مصروف تشغيلي", purchase: "شراء بضاعة" };
const PROVIDER_LABELS = { network: "شبكة", delivery_app: "تطبيق توصيل" };
const SETTLEMENT_STATUS = { pending: "بانتظار السداد", confirmed: "مؤكَّدة" };

const expensesPager = createPager("cashbox-expenses-table", { unit: "فاتورة" });
const settlementsPager = createPager("cashbox-settlements-table", { unit: "تسوية" });

const state = {
  ready: false,
  /** قدرات المستخدم كما يعيدها الخادم (لا كما يفترضها المتصفح) */
  caps: {},
  meta: null,
  /** درجة المستخدم في بند ما ودرجة الحذف — تصلان من لوحة الإدارة */
  levelOf: () => 0,
  canDeleteIn: () => false,
  /** الفاتورة المفتوحة للتعديل، أو null لتسجيل فاتورة جديدة */
  editingExpenseId: null,
  monthClosings: [],
};

/* ── أدوات صغيرة ─────────────────────────────────────────────── */

/** شرائح أرقام في صف واحد (نفس شكل بقية الشاشات). */
function chipsInto(nodeId, items) {
  const box = el(nodeId);
  if (!box) return;
  box.textContent = "";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = item[2] ? "chip " + item[2] : "chip";
    const strong = document.createElement("strong");
    strong.textContent = item[1];
    chip.append(document.createTextNode(item[0] + ": "), strong);
    box.append(chip);
  }
}

function selectedBranch() {
  const node = el("cashbox-branch");
  return node ? node.value : "";
}

/** يضيف الفرع المختار إلى معاملات الاستعلام إن حُدّد. */
function withBranch(params) {
  const branch = selectedBranch();
  if (branch) params.set("branchId", branch);
  return params;
}

function query(params) {
  const text = params.toString();
  return text ? "?" + text : "";
}

function withBranchBody(body) {
  const branch = selectedBranch();
  if (branch) body.branchId = Number(branch);
  return body;
}

function numberOf(id) {
  return Number(el(id).value || 0);
}

function moneyCell(value, negativeIsBad) {
  const node = document.createElement("span");
  node.textContent = formatMoney(value);
  if (negativeIsBad) {
    node.classList.toggle("is-negative", Number(value) < -0.009);
    node.classList.toggle("is-positive", Number(value) > 0.009);
  }
  return node;
}

/* ── إشعارات ملخّص الإقفال ───────────────────────────────────── */

/**
 * إشعارات المستخدم نفسه فقط: يُرسلها الخادم لكل من يملك الترحيل أو التصفير
 * أو عرض الملخّص لحظة تجهيز ملخّص شهر أو اتخاذ قرار فيه.
 */
async function loadNotifications() {
  const box = el("cashbox-notices");
  const result = await api("/finance/notifications");
  box.textContent = "";

  const unread = result.ok
    ? (result.notifications || []).filter((item) => !item.isRead)
    : [];
  el("cashbox-notices-empty").hidden = unread.length > 0;

  for (const notice of unread) {
    const card = document.createElement("p");
    card.className = "alert alert--warn";
    const title = document.createElement("strong");
    title.textContent = notice.title;
    const seen = button("تم الاطلاع", {
      onClick: async () => {
        await api("/finance/notifications/" + notice.id + "/read", { method: "POST" });
        await loadNotifications();
      },
    });
    card.append(
      title,
      document.createTextNode(" — " + notice.body + " "),
      seen,
    );
    box.append(card);
  }
}

/* ══ أولاً: المتبقي النقدي في الدرج ══════════════════════════════ */

/**
 * وضع النقدية ليوم واحد: النقدي من التقفيلات، والمصاريف من السجل الموحّد،
 * والمتبقي = الفرق بينهما — مجموعاً وموزّعاً على الورديات.
 */
export async function loadCashPosition() {
  const params = withBranch(new URLSearchParams());
  const date = el("cashbox-date").value;
  if (date) params.set("date", date);

  const result = await api("/finance/cash-position" + query(params));
  const body = el("cashbox-position-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    chipsInto("cashbox-position-chips", []);
    setAlert(el("cashbox-position-result"), result.error || "تعذّر قراءة وضع النقدية", "error");
    return;
  }

  el("cashbox-date").value = result.businessDate;
  chipsInto("cashbox-position-chips", [
    ["المبيعات النقدية", formatMoney(result.cashSales)],
    ["مصاريف اليوم", formatMoney(result.expensesTotal)],
    ["المتبقي النقدي في الدرج", formatMoney(result.remainingCash)],
    ["عدد الفواتير", String((result.expenses || []).length)],
  ]);

  body.replaceChildren(
    ...(result.byShift || []).map((item) =>
      row([
        SHIFT_LABELS[item.shift] || item.shift,
        formatMoney(item.cashSales),
        formatMoney(item.expenses),
        moneyCell(item.remainingCash, true),
      ]),
    ),
  );
  el("cashbox-position-empty").hidden = (result.byShift || []).length > 0;

  setAlert(
    el("cashbox-position-result"),
    result.locked ? result.lockNote : "",
    result.locked ? "warn" : undefined,
  );
}

/* ══ ثانياً: السجل الموحّد للمصاريف والمشتريات ═══════════════════ */

/** إجمالي الفاتورة كما يحسبه الخادم: المبلغ الصريح إن وُجد، وإلا الكمية × السعر. */
function invoicePreview() {
  const explicit = numberOf("cashbox-exp-amount");
  const total = explicit > 0 ? explicit : numberOf("cashbox-exp-quantity") * numberOf("cashbox-exp-unitPrice");
  el("cashbox-exp-total").textContent = formatMoney(Math.round(total * 100) / 100);
}

function resetExpenseForm() {
  state.editingExpenseId = null;
  el("cashbox-exp-date").value = el("cashbox-date").value || todayIso();
  el("cashbox-exp-shift").value = "full";
  el("cashbox-exp-kind").value = "expense";
  el("cashbox-exp-description").value = "";
  el("cashbox-exp-invoice").value = "";
  el("cashbox-exp-quantity").value = "1";
  el("cashbox-exp-unitPrice").value = "0";
  el("cashbox-exp-amount").value = "0";
  el("cashbox-exp-supplier").value = "";
  el("cashbox-exp-notes").value = "";
  el("cashbox-exp-submit").textContent = "تسجيل الفاتورة";
  el("cashbox-exp-mode").textContent = "فاتورة جديدة";
  invoicePreview();
}

/** يفتح فاتورة مسجّلة للتعديل (الدرجة الثالثة في البند). */
function editExpense(expense) {
  state.editingExpenseId = expense.id;
  el("cashbox-exp-date").value = expense.businessDate;
  el("cashbox-exp-shift").value = expense.shift;
  el("cashbox-exp-kind").value = expense.kind;
  el("cashbox-exp-description").value = expense.description;
  el("cashbox-exp-invoice").value = expense.invoiceNumber || "";
  el("cashbox-exp-quantity").value = String(expense.quantity);
  el("cashbox-exp-unitPrice").value = String(expense.unitPrice);
  el("cashbox-exp-amount").value = String(expense.amount);
  el("cashbox-exp-supplier").value = expense.supplier || "";
  el("cashbox-exp-notes").value = expense.notes || "";
  el("cashbox-exp-submit").textContent = "حفظ التعديل";
  el("cashbox-exp-mode").textContent = "تعديل الفاتورة رقم " + expense.id;
  invoicePreview();
  el("cashbox-expense-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function submitExpense(event) {
  event.preventDefault();
  const submit = el("cashbox-exp-submit");
  setBusy(submit, true);

  const body = withBranchBody({
    businessDate: el("cashbox-exp-date").value,
    shift: el("cashbox-exp-shift").value,
    kind: el("cashbox-exp-kind").value,
    description: el("cashbox-exp-description").value.trim(),
    invoiceNumber: el("cashbox-exp-invoice").value.trim(),
    quantity: numberOf("cashbox-exp-quantity"),
    unitPrice: numberOf("cashbox-exp-unitPrice"),
    amount: numberOf("cashbox-exp-amount"),
    supplier: el("cashbox-exp-supplier").value.trim(),
    notes: el("cashbox-exp-notes").value.trim(),
  });

  const result = state.editingExpenseId
    ? await api("/finance/expenses/" + state.editingExpenseId, { method: "PATCH", body })
    : await api("/finance/expenses", { method: "POST", body });

  setBusy(submit, false);
  setAlert(
    el("cashbox-exp-result"),
    result.ok ? (result.message || "تم الحفظ") : (result.error || "تعذّر حفظ الفاتورة"),
    result.ok ? "ok" : "error",
  );

  if (!result.ok) return;
  resetExpenseForm();
  await Promise.all([loadExpenses(), loadCashPosition(), loadMonthlyBalance()]);
}

async function removeExpense(expense) {
  const label = expense.description + " (" + formatMoney(expense.amount) + ")";
  if (!window.confirm("حذف فاتورة " + label + " من السجل؟ لا يمكن التراجع.")) return;
  const reason = window.prompt("سبب الحذف (يُسجَّل في التدقيق):", "") || "";

  const result = await api("/finance/expenses/" + expense.id, {
    method: "DELETE",
    body: { reason },
  });
  setAlert(
    el("cashbox-expenses-result"),
    result.ok ? (result.message || "تم الحذف") : (result.error || "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadExpenses(), loadCashPosition(), loadMonthlyBalance()]);
}

/** قائمة الفواتير بمرشّحاتها مع مجاميعها. */
export async function loadExpenses() {
  const params = withBranch(new URLSearchParams());
  const from = el("cashbox-expenses-from").value;
  const to = el("cashbox-expenses-to").value;
  const kind = el("cashbox-expenses-kind").value;
  const shift = el("cashbox-expenses-shift").value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (kind) params.set("kind", kind);
  if (shift) params.set("shift", shift);

  const result = await api("/finance/expenses" + query(params));
  if (!result.ok) {
    expensesPager.clear();
    chipsInto("cashbox-expenses-chips", []);
    setAlert(el("cashbox-expenses-result"), result.error || "تعذّر تحميل السجل", "error");
    return;
  }

  const expenses = result.expenses || [];
  expensesPager.render(expenses, (expense) => {
    const actions = document.createElement("span");
    actions.className = "row-actions";
    if (state.caps.writeExpenses && state.levelOf("cash_expenses") >= 3) {
      actions.append(button("تعديل", { onClick: () => editExpense(expense) }));
    }
    if (state.caps.writeExpenses && state.canDeleteIn("cash_expenses")) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeExpense(expense),
        }),
      );
    }

    return row([
      expense.businessDate,
      expense.description,
      expense.invoiceNumber || "—",
      String(expense.quantity),
      formatMoney(expense.unitPrice),
      formatMoney(expense.amount),
      KIND_LABELS[expense.kind] || expense.kind,
      SHIFT_LABELS[expense.shift] || expense.shift,
      expense.supplier || "—",
      expense.createdByName || "—",
      actions,
    ]);
  });

  el("cashbox-expenses-empty").hidden = expenses.length > 0;
  const summary = result.summary || {};
  chipsInto("cashbox-expenses-chips", [
    ["عدد الفواتير", String(summary.count || 0)],
    ["إجمالي المدفوع نقداً", formatMoney(summary.amount)],
    ["مصاريف تشغيلية", formatMoney(summary.expenses)],
    ["مشتريات", formatMoney(summary.purchases)],
  ]);
  setAlert(el("cashbox-expenses-result"), "");
}

/* ══ ثالثاً: الرصيد النقدي الشهري ════════════════════════════════ */

/** الرصيد الشهري: يُعرض طوال الشهر لا في نهايته فقط. */
export async function loadMonthlyBalance() {
  if (!state.caps.viewMonthlySummary && !state.caps.readExpenses) return;
  const params = withBranch(new URLSearchParams());
  const month = el("cashbox-balance-month").value || currentMonthKey();
  params.set("month", month);

  const result = await api("/finance/monthly-balance" + query(params));
  const body = el("cashbox-balance-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    chipsInto("cashbox-balance-chips", []);
    setAlert(el("cashbox-balance-result"), result.error || "تعذّر قراءة الرصيد الشهري", "error");
    return;
  }

  const summary = result.summary || {};
  chipsInto("cashbox-balance-chips", [
    ["المرحّل من الشهر السابق", formatMoney(summary.openingBalance)],
    ["النقدي المتراكم من التقفيلات", formatMoney(summary.cashSalesTotal)],
    ["المصاريف والمشتريات النقدية", formatMoney(summary.expensesTotal)],
    ["الصافي الحالي", formatMoney(summary.netAmount)],
    ["عمولات مؤكَّدة", formatMoney(summary.commissionTotal)],
    ["ضريبة العمولات", formatMoney(summary.vatTotal)],
    ["حالة الشهر", result.statusLabel || "مفتوح"],
  ]);

  body.replaceChildren(
    ...(summary.days || []).map((day) =>
      row([
        day.businessDate,
        formatMoney(day.cashSales),
        formatMoney(day.expenses),
        moneyCell(day.remainingCash, true),
      ]),
    ),
  );
  el("cashbox-balance-empty").hidden = (summary.days || []).length > 0;
  setAlert(el("cashbox-balance-result"), "");
}

/* ══ رابعاً: تسوية الشبكات وتطبيقات التوصيل ══════════════════════ */

/** معاينة محلية للعمولة والنسبة والضريبة — الخادم هو من يحسبها ويحفظها. */
function settlementPreview() {
  const sales = numberOf("cashbox-set-sales");
  const received = numberOf("cashbox-set-received");
  const vatRate = numberOf("cashbox-set-vat");
  const included = el("cashbox-set-vatIncluded").checked;

  const commission = Math.round((sales - received) * 100) / 100;
  const rate = sales > 0 ? Math.round((commission / sales) * 10000) / 100 : 0;
  let vat = 0;
  if (vatRate > 0 && commission !== 0) {
    vat = included
      ? Math.round((commission - commission / (1 + vatRate / 100)) * 100) / 100
      : Math.round(commission * (vatRate / 100) * 100) / 100;
  }

  chipsInto("cashbox-set-preview", [
    ["العمولة", formatMoney(commission)],
    ["النسبة", String(rate) + "%"],
    ["الضريبة على العمولة", formatMoney(vat)],
  ]);
}

/** مبيعات كل جهة كما رُصدت في التقفيلات — منها يُملأ نموذج التسوية. */
export async function loadProviders() {
  if (!state.caps.readSettlements) return;
  const params = withBranch(new URLSearchParams());
  const from = el("cashbox-providers-from").value;
  const to = el("cashbox-providers-to").value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const result = await api("/finance/settlements/providers" + query(params));
  const body = el("cashbox-providers-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    setAlert(el("cashbox-providers-result"), result.error || "تعذّر قراءة مبيعات الجهات", "error");
    return;
  }

  const providers = result.providers || [];
  body.replaceChildren(
    ...providers.map((provider) => {
      const actions = document.createElement("span");
      actions.className = "row-actions";
      if (state.caps.manageSettlements) {
        actions.append(
          button("تسجيل تسوية", {
            onClick: () => {
              el("cashbox-set-provider").value = provider.providerName;
              el("cashbox-set-type").value = provider.providerType;
              el("cashbox-set-from").value = result.from;
              el("cashbox-set-to").value = result.to;
              el("cashbox-set-sales").value = String(provider.salesAmount);
              el("cashbox-set-received").value = "0";
              settlementPreview();
              el("cashbox-settlement-form").scrollIntoView({ behavior: "smooth", block: "center" });
            },
          }),
        );
      }

      return row([
        provider.providerName,
        PROVIDER_LABELS[provider.providerType] || provider.providerType,
        formatMoney(provider.salesAmount),
        formatMoney(provider.settledSales),
        formatMoney(provider.settledReceived),
        String(provider.openSettlements || 0),
        actions,
      ]);
    }),
  );
  el("cashbox-providers-empty").hidden = providers.length > 0;
  setAlert(el("cashbox-providers-result"), "");
}

async function submitSettlement(event) {
  event.preventDefault();
  const submit = el("cashbox-set-submit");
  setBusy(submit, true);

  const body = withBranchBody({
    providerName: el("cashbox-set-provider").value.trim(),
    providerType: el("cashbox-set-type").value,
    periodFrom: el("cashbox-set-from").value,
    periodTo: el("cashbox-set-to").value,
    salesAmount: numberOf("cashbox-set-sales"),
    receivedAmount: numberOf("cashbox-set-received"),
    vatRate: numberOf("cashbox-set-vat"),
    vatIncluded: el("cashbox-set-vatIncluded").checked,
    reference: el("cashbox-set-reference").value.trim(),
    notes: el("cashbox-set-notes").value.trim(),
  });

  const result = await api("/finance/settlements", { method: "POST", body });
  setBusy(submit, false);
  setAlert(
    el("cashbox-set-result"),
    result.ok ? (result.message || "تم التسجيل") : (result.error || "تعذّر تسجيل التسوية"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadSettlements(), loadProviders()]);
}

/**
 * تأكيد السداد: يُدخل المحاسب المبلغ الواصل للبنك فقط، والخادم يحسب العمولة
 * ونسبتها وضريبتها ويثبّت تاريخ التأكيد واسم المحاسب.
 */
async function confirmSettlement(settlement) {
  const received = window.prompt(
    "المبلغ المستلم في البنك لـ" + settlement.providerName + " (المبيعات " + formatMoney(settlement.salesAmount) + "):",
    String(settlement.receivedAmount || ""),
  );
  if (received === null) return;

  const vat = window.prompt("نسبة الضريبة على العمولة % (اختياري — اتركها كما هي إن لم تُطبَّق):", String(settlement.vatRate || 0));
  if (vat === null) return;

  const result = await api("/finance/settlements/" + settlement.id + "/confirm", {
    method: "POST",
    body: { receivedAmount: Number(received || 0), vatRate: Number(vat || 0) },
  });

  setAlert(
    el("cashbox-settlements-result"),
    result.ok
      ? "تم تأكيد السداد — العمولة " +
        formatMoney(result.figures.commissionAmount) +
        " بنسبة " +
        String(result.figures.commissionRate) +
        "% وضريبة " +
        formatMoney(result.figures.vatAmount)
      : (result.error || "تعذّر تأكيد السداد"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadSettlements(), loadProviders(), loadMonthlyBalance()]);
}

async function removeSettlement(settlement) {
  if (!window.confirm("حذف تسوية " + settlement.providerName + "؟")) return;
  const reason = window.prompt("سبب الحذف (يُسجَّل في التدقيق):", "") || "";
  const result = await api("/finance/settlements/" + settlement.id, {
    method: "DELETE",
    body: { reason },
  });
  setAlert(
    el("cashbox-settlements-result"),
    result.ok ? (result.message || "تم الحذف") : (result.error || "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadSettlements(), loadProviders()]);
}

/** سجل التسويات: الجهة، المبيعات، المستلم، العمولة، النسبة، الضريبة، المحاسب. */
export async function loadSettlements() {
  if (!state.caps.readSettlements) return;
  const params = withBranch(new URLSearchParams());
  const from = el("cashbox-providers-from").value;
  const to = el("cashbox-providers-to").value;
  const status = el("cashbox-settlements-status").value;
  const type = el("cashbox-settlements-type").value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (status) params.set("status", status);
  if (type) params.set("providerType", type);

  const result = await api("/finance/settlements" + query(params));
  if (!result.ok) {
    settlementsPager.clear();
    setAlert(el("cashbox-settlements-result"), result.error || "تعذّر تحميل التسويات", "error");
    return;
  }

  const settlements = result.settlements || [];
  settlementsPager.render(settlements, (settlement) => {
    const actions = document.createElement("span");
    actions.className = "row-actions";

    if (settlement.status === "pending" && state.caps.confirmSettlements) {
      actions.append(
        button("تأكيد السداد", {
          className: "btn btn--primary btn--xs",
          onClick: () => confirmSettlement(settlement),
        }),
      );
    }
    if (settlement.status === "pending" && state.caps.manageSettlements && state.canDeleteIn("settlements")) {
      actions.append(
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => removeSettlement(settlement),
        }),
      );
    }

    return row([
      settlement.providerName,
      PROVIDER_LABELS[settlement.providerType] || settlement.providerType,
      settlement.periodFrom + " ← " + settlement.periodTo,
      formatMoney(settlement.salesAmount),
      formatMoney(settlement.receivedAmount),
      moneyCell(settlement.commissionAmount, false),
      String(settlement.commissionRate) + "%",
      formatMoney(settlement.vatAmount),
      SETTLEMENT_STATUS[settlement.status] || settlement.status,
      settlement.confirmedAt ? formatDateTime(settlement.confirmedAt) : "—",
      settlement.confirmedByName || "—",
      actions,
    ]);
  });

  el("cashbox-settlements-empty").hidden = settlements.length > 0;
  const summary = result.summary || {};
  chipsInto("cashbox-settlements-chips", [
    ["عدد التسويات", String(summary.count || 0)],
    ["بانتظار السداد", String(summary.pending || 0)],
    ["المبيعات", formatMoney(summary.salesAmount)],
    ["المستلم المؤكَّد", formatMoney(summary.receivedAmount)],
    ["العمولات", formatMoney(summary.commissionAmount)],
    ["الضريبة", formatMoney(summary.vatAmount)],
  ]);
}

/* ══ خامساً: إقفال الشهر والترحيل ════════════════════════════════ */

/**
 * قرار الشهر بضغطة واحدة.
 *
 * الزر لا يُبنى إلا لمن يملك بنده (carryForward أو resetBalance)، والخادم يفحص
 * الصلاحية حسب القرار نفسه — فمن يملك الترحيل وحده لا يستطيع التصفير.
 */
async function decideMonth(closing, decision) {
  const isCarry = decision === "carry_forward";
  const confirmText = isCarry
    ? "اعتماد ترحيل صافي شهر " + closing.monthKey + " (" + formatMoney(closing.netAmount) + ") إلى بداية الشهر الجديد؟"
    : "تصفير رصيد شهر " + closing.monthKey + " والبدء من صفر؟ الصافي " + formatMoney(closing.netAmount) + " لن يُرحّل.";
  if (!window.confirm(confirmText)) return;

  const note = window.prompt("ملاحظة القرار (اختيارية — تُسجَّل في سجل المراجعة):", "") || "";
  const result = await api("/finance/monthly-closings/" + closing.id + "/decision", {
    method: "POST",
    body: { decision, note },
  });

  setAlert(
    el("cashbox-months-result"),
    result.ok ? result.message : (result.error || "تعذّر تنفيذ القرار"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) {
    await Promise.all([loadMonthClosings(), loadMonthlyBalance(), loadNotifications()]);
  }
}

/** تجهيز ملخّص شهر بعينه يدوياً (النظام يجهّز كل شهر منتهٍ تلقائياً عند العرض). */
async function prepareMonth() {
  const month = el("cashbox-prepare-month").value;
  if (!month) {
    setAlert(el("cashbox-months-result"), "اختر الشهر أولاً", "error");
    return;
  }
  const node = el("cashbox-prepare-run");
  setBusy(node, true);
  const result = await api("/finance/monthly-closings/prepare", {
    method: "POST",
    body: withBranchBody({ month }),
  });
  setBusy(node, false);

  setAlert(
    el("cashbox-months-result"),
    result.ok ? result.message : (result.error || "تعذّر تجهيز الملخّص"),
    result.ok ? "ok" : "error",
  );
  if (result.ok) await Promise.all([loadMonthClosings(), loadNotifications()]);
}

/** جدول إقفالات السنة: الملخّص والحالة والقرار ومن اتّخذه ومتى. */
export async function loadMonthClosings() {
  if (!state.caps.viewMonthlySummary) return;
  const params = withBranch(new URLSearchParams());
  const year = el("cashbox-year").value;
  if (year) params.set("year", year);

  const result = await api("/finance/monthly-closings" + query(params));
  const body = el("cashbox-months-table").querySelector("tbody");

  if (!result.ok) {
    body.replaceChildren();
    setAlert(el("cashbox-months-result"), result.error || "تعذّر تحميل إقفالات الشهور", "error");
    return;
  }

  state.monthClosings = result.closings || [];
  body.replaceChildren(
    ...state.monthClosings.map((closing) => {
      const actions = document.createElement("span");
      actions.className = "row-actions";

      // الأزرار للشهر المعلّق فقط، ولكل زر بنده المستقل في شاشة الصلاحيات
      if (closing.status === "pending_approval") {
        if (result.canCarryForward) {
          actions.append(
            button("اعتماد الترحيل", {
              className: "btn btn--primary btn--xs",
              onClick: () => decideMonth(closing, "carry_forward"),
            }),
          );
        }
        if (result.canReset) {
          actions.append(
            button("تصفير", {
              className: "btn btn--danger btn--xs",
              onClick: () => decideMonth(closing, "reset"),
            }),
          );
        }
        if (!result.canCarryForward && !result.canReset) {
          const note = document.createElement("span");
          note.className = "hint";
          note.textContent = "بانتظار صاحب الصلاحية";
          actions.append(note);
        }
      }

      const statusChip = document.createElement("span");
      statusChip.className = "badge badge--" + closing.status;
      statusChip.textContent = closing.statusLabel;

      return row([
        closing.monthKey,
        formatMoney(closing.openingBalance),
        formatMoney(closing.cashSalesTotal),
        formatMoney(closing.expensesTotal),
        moneyCell(closing.netAmount, true),
        formatMoney(closing.carriedAmount),
        statusChip,
        closing.decidedByName || "—",
        closing.decidedAt ? formatDateTime(closing.decidedAt) : "—",
        actions,
      ]);
    }),
  );

  el("cashbox-months-empty").hidden = state.monthClosings.length > 0;
  el("cashbox-months-note").textContent = result.prepared > 0
    ? "جُهّز ملخّص " + String(result.prepared) + " شهر تلقائياً وأُرسل إشعاره لأصحاب الصلاحية."
    : "";
}

/* ── التهيئة ─────────────────────────────────────────────────── */

/** يخفي الأقسام التي لا يملك المستخدم صلاحيتها بالكامل. */
function applyCapabilities() {
  el("cashbox-position-card").hidden = !state.caps.readExpenses;
  el("cashbox-expenses-card").hidden = !state.caps.readExpenses;
  el("cashbox-expense-form").hidden = !state.caps.writeExpenses;
  el("cashbox-balance-card").hidden = !(state.caps.viewMonthlySummary || state.caps.readExpenses);
  el("cashbox-settlements-card").hidden = !state.caps.readSettlements;
  el("cashbox-settlement-form").hidden = !state.caps.manageSettlements;
  el("cashbox-months-card").hidden = !state.caps.viewMonthlySummary;
  el("cashbox-prepare-row").hidden = !state.caps.viewMonthlySummary;
}

export function initCashboxModule({ can, levelOf, canDeleteIn }) {
  if (state.ready) return;
  state.ready = true;
  if (levelOf) state.levelOf = levelOf;
  if (canDeleteIn) state.canDeleteIn = canDeleteIn;

  el("cashbox-expense-form").addEventListener("submit", submitExpense);
  el("cashbox-exp-reset").addEventListener("click", resetExpenseForm);
  for (const id of ["cashbox-exp-quantity", "cashbox-exp-unitPrice", "cashbox-exp-amount"]) {
    el(id).addEventListener("input", invoicePreview);
  }

  el("cashbox-settlement-form").addEventListener("submit", submitSettlement);
  el("cashbox-set-reset").addEventListener("click", () => {
    el("cashbox-settlement-form").reset();
    el("cashbox-set-vatIncluded").checked = true;
    settlementPreview();
  });
  for (const id of ["cashbox-set-sales", "cashbox-set-received", "cashbox-set-vat"]) {
    el(id).addEventListener("input", settlementPreview);
  }
  el("cashbox-set-vatIncluded").addEventListener("change", settlementPreview);

  el("cashbox-position-run").addEventListener("click", loadCashPosition);
  el("cashbox-date").addEventListener("change", loadCashPosition);
  el("cashbox-expenses-run").addEventListener("click", loadExpenses);
  el("cashbox-balance-run").addEventListener("click", loadMonthlyBalance);
  el("cashbox-providers-run").addEventListener("click", async () => {
    await Promise.all([loadProviders(), loadSettlements()]);
  });
  el("cashbox-settlements-run").addEventListener("click", loadSettlements);
  el("cashbox-months-run").addEventListener("click", loadMonthClosings);
  el("cashbox-prepare-run").addEventListener("click", prepareMonth);
  el("cashbox-branch").addEventListener("change", refreshCashboxPanel);
}

/** يُستدعى عند فتح التبويب: يقرأ القدرات ثم يحمّل الأقسام المسموح بها. */
export async function refreshCashboxPanel() {
  const meta = await api("/finance/meta");
  if (!meta.ok) {
    setAlert(el("cashbox-alert"), meta.error || "لا تملك صلاحية شاشة النقدية", "error");
    return;
  }

  setAlert(el("cashbox-alert"), "");
  state.meta = meta;
  state.caps = meta.can || {};
  applyCapabilities();

  // الفروع تُملأ مرة واحدة: من لا يقرأ كل الفروع يجد فرعه وحده
  const branchSelect = el("cashbox-branch");
  if (branchSelect.options.length <= 1) {
    branchSelect.textContent = "";
    for (const branch of meta.branches || []) {
      const option = document.createElement("option");
      option.value = String(branch.id);
      option.textContent = branch.name;
      branchSelect.append(option);
    }
    if (meta.defaultBranchId) branchSelect.value = String(meta.defaultBranchId);
  }

  const today = meta.today || todayIso();
  const month = today.slice(0, 7);
  if (!el("cashbox-date").value) el("cashbox-date").value = today;
  if (!el("cashbox-exp-date").value) el("cashbox-exp-date").value = today;
  if (!el("cashbox-balance-month").value) el("cashbox-balance-month").value = month;
  if (!el("cashbox-expenses-from").value) el("cashbox-expenses-from").value = month + "-01";
  if (!el("cashbox-expenses-to").value) el("cashbox-expenses-to").value = today;
  if (!el("cashbox-providers-from").value) el("cashbox-providers-from").value = month + "-01";
  if (!el("cashbox-providers-to").value) el("cashbox-providers-to").value = today;
  if (!el("cashbox-year").value) el("cashbox-year").value = today.slice(0, 4);
  if (!el("cashbox-prepare-month").value) el("cashbox-prepare-month").value = month;

  el("cashbox-decision-hint").hidden = state.caps.carryForward || state.caps.resetBalance;
  invoicePreview();
  settlementPreview();

  await loadNotifications();
  if (state.caps.readExpenses) await Promise.all([loadCashPosition(), loadExpenses()]);
  await loadMonthlyBalance();
  if (state.caps.readSettlements) await Promise.all([loadProviders(), loadSettlements()]);
  if (state.caps.viewMonthlySummary) await loadMonthClosings();
}
