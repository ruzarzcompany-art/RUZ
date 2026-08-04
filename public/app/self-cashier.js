/**
 * تقفيل الكاشير اليومي من تطبيق الموظف.
 *
 * نسخة مختصرة من شاشة اللوحة: الكاشير يرفع تقفيل نفسه فقط، بلا اختيار موظف
 * أو فرع. التحقّق والحساب النهائي في الخادم
 * (`POST /api/cashier/closings` بدرجة 1 في بند «تقفيل ورديتي»)، وما هنا
 * معاينة فورية للنقد المتوقّع والفرق فقط.
 */

import { api, button, el, formatMoney, row, setAlert, setBusy } from "./api.js";

/** الحقول المالية بالترتيب نفسه المعروض في الشاشة. */
const MONEY_FIELDS = [
  "openingFloat",
  "totalSales",
  "cashSales",
  "cardSales",
  "foodicsSales",
  "transferSales",
  "deliverySales",
  "otherSales",
  "discounts",
  "refunds",
  "expenses",
  "countedCash",
];

/** حقول يشتقّها الخادم من البنود والأسطر، فلا تُدخل يدوياً. */
const DERIVED_FIELDS = new Set(["cardSales", "deliverySales", "expenses"]);

const LINE_TABLES = {
  network: {
    table: "self-cash-network",
    empty: "self-cash-network-empty",
    namePlaceholder: "اسم الشبكة أو الجهاز",
  },
  delivery_app: {
    table: "self-cash-delivery",
    empty: "self-cash-delivery-empty",
    namePlaceholder: "اسم التطبيق",
  },
  expense: {
    table: "self-cash-expense",
    empty: "self-cash-expense-empty",
    namePlaceholder: "البيان (غاز، دجاج، لبن ...)",
  },
};

const STATUS_TEXT = {
  submitted: "مرفوع بانتظار المراجعة",
  reviewed: "تمّت مراجعته",
  disputed: "معترض عليه",
};

const state = {
  ready: false,
  businessDate: "",
  lines: [],
  defaultNetworkLines: [],
  defaultDeliveryApps: [],
  /**
   * مصاريف السجل الموحّد: مصاريف اليوم كاملة، ومصاريف الوردية المعروضة.
   * يحسبها الخادم من `cash_expenses` ويعيدها مع تقفيل اليوم، ومنها يظهر
   * «المتبقي النقدي» في الشاشة (المبيعات النقدية − هذه المصاريف).
   */
  dayExpenses: 0,
  registerExpenses: 0,
  /** ما بقي من السجل المنفصل القديم لليوم */
  legacyExpenses: 0,
  /** بند «المتبقي النقدي» المستقل كما يعيده الخادم */
  caps: { viewRemaining: false },
  /** تقفيلات اليوم المحمّلة من الخادم، مفتاحها الوردية. */
  byShift: new Map(),
};

/* ── البنود ────────────────────────────────────────────────── */

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

function renderLines(category) {
  const meta = LINE_TABLES[category];
  const body = el(meta.table).querySelector("tbody");
  const own = state.lines.filter((line) => line.category === category);
  // سطر المصروف بحقلين فقط: البيان والمبلغ
  const isExpense = category === "expense";

  body.replaceChildren(
    ...own.map((line) => {
      const cells = [
        lineField(line.label, {
          placeholder: meta.namePlaceholder,
          onInput: (value) => {
            line.label = value;
          },
        }),
      ];

      if (!isExpense) {
        cells.push(
          lineField(line.reference ?? "", {
            placeholder: "اختياري",
            onInput: (value) => {
              line.reference = value;
            },
          }),
        );
      }

      cells.push(
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
      );

      return row(cells);
    }),
  );

  el(meta.empty).hidden = own.length > 0;
}

function renderAllLines() {
  renderLines("network");
  renderLines("delivery_app");
  renderLines("expense");
  recomputeDerived();
}

function addLine(category) {
  state.lines.push({ category, label: "", amount: 0, reference: "" });
  renderLines(category);
}

/** الشبكة = مجموع بنودها + شبكة foodics، والتوصيل = مجموع بنود التطبيقات. */
function recomputeDerived() {
  const sum = (category) =>
    state.lines
      .filter((line) => line.category === category)
      .reduce((total, line) => total + Number(line.amount || 0), 0);

  const foodics = Number(el("self-cash-foodicsSales").value || 0);
  el("self-cash-cardSales").value = (Math.round((sum("network") + foodics) * 100) / 100).toFixed(2);
  el("self-cash-deliverySales").value = (Math.round(sum("delivery_app") * 100) / 100).toFixed(2);
  // كل مصروف مكتوب في الصفحة يُخصم تلقائياً من نقدي التقفيلة
  el("self-cash-expenses").value = (Math.round(sum("expense") * 100) / 100).toFixed(2);
  updatePreview();
}

/* ── المعاينة ──────────────────────────────────────────────── */

function updatePreview() {
  const value = (key) => Number(el(`self-cash-${key}`).value || 0);
  const expected =
    value("openingFloat") + value("cashSales") - value("expenses") - value("refunds");
  const difference = value("countedCash") - expected;

  el("self-cash-expected").textContent = formatMoney(expected);
  const diffNode = el("self-cash-difference");
  diffNode.textContent = formatMoney(difference);
  diffNode.classList.toggle("is-negative", difference < -0.009);
  diffNode.classList.toggle("is-positive", difference > 0.009);

  el("self-cash-diff-hint").textContent =
    difference < -0.009 ? "عجز في الدرج" : difference > 0.009 ? "زيادة في الدرج" : "مطابق";

  // مصاريف التقفيلة = أسطر المصروف المكتوبة هنا + ما بقي من السجل القديم
  const expensesTotal =
    Math.round((value("expenses") + state.legacyExpenses) * 100) / 100;
  const remaining = Math.round((value("cashSales") - expensesTotal) * 100) / 100;
  el("self-cash-register-expenses").textContent = formatMoney(expensesTotal);
  const remainingNode = el("self-cash-remaining");
  remainingNode.textContent = formatMoney(remaining);
  remainingNode.classList.toggle("is-negative", remaining < -0.009);
}

/* ── تعبئة الشاشة من تقفيل محفوظ ───────────────────────────── */

/** يعرض تقفيل الوردية المختارة إن كان مرفوعاً، أو نموذجاً فارغاً. */
function applyShift() {
  const shift = el("self-cash-shift").value;
  const closing = state.byShift.get(shift) ?? null;
  const badge = el("self-cash-status");

  for (const field of MONEY_FIELDS) {
    el(`self-cash-${field}`).value = closing ? Number(closing[field] ?? 0) : 0;
  }
  el("self-cash-invoices").value = closing ? Number(closing.invoiceCount ?? 0) : 0;
  el("self-cash-notes").value = closing?.notes ?? "";

  // ما بقي من السجل المنفصل القديم = مصاريف اليوم/الوردية − أسطر التقفيلة
  const savedExpenseLines = (closing?.lines ?? [])
    .filter((line) => line.category === "expense")
    .reduce((total, line) => total + Number(line.amount || 0), 0);
  const dayTotal = closing
    ? Number(closing.registerExpenses ?? 0)
    : state.dayExpenses;
  state.legacyExpenses = Math.max(
    0,
    Math.round((dayTotal - savedExpenseLines) * 100) / 100,
  );

  state.lines = closing?.lines?.length
    ? closing.lines.map((line) => ({ ...line }))
    : defaultLines();

  badge.textContent = closing ? (STATUS_TEXT[closing.status] ?? closing.status) : "لم يُرفع بعد";
  badge.classList.toggle("badge--ok", closing?.status === "reviewed");
  badge.classList.toggle("badge--warn", closing?.status === "disputed");

  // التقفيل المُراجَع لا يعدّله الكاشير — الخادم يرفض التعديل بـ 409
  const locked = closing?.status === "reviewed";
  el("self-cash-submit").disabled = locked;
  el("self-cash-submit").textContent = closing ? "تحديث التقفيل" : "رفع التقفيل";
  if (locked) {
    setAlert(
      el("self-cash-result"),
      "تقفيل هذه الوردية تمّت مراجعته. راجع مدير فرعك لأي تعديل.",
      "warn",
    );
  } else {
    setAlert(el("self-cash-result"), "");
  }

  renderAllLines();
}

/* ── التحميل والحفظ ────────────────────────────────────────── */

/** يقرأ تقفيلات اليوم للموظف نفسه ويعبّئ الشاشة. */
export async function refreshSelfCashier() {
  const result = await api("/cashier/closings/today");
  if (!result.ok) {
    setAlert(el("self-cash-result"), result.error ?? "تعذّر تحميل تقفيل اليوم", "error");
    return;
  }

  state.businessDate = result.businessDate;
  state.defaultNetworkLines = result.defaultNetworkLines ?? [];
  state.defaultDeliveryApps = result.defaultDeliveryApps ?? [];
  state.dayExpenses = Number(result.cashPosition?.expenses ?? 0);
  // «المتبقي النقدي» بند مستقل في الصلاحيات — الخادم هو من يقرّره
  state.caps.viewRemaining = result.can?.viewRemaining === true;
  el("self-cash-remaining-chip").hidden = !state.caps.viewRemaining;
  state.byShift = new Map((result.closings ?? []).map((closing) => [closing.shift, closing]));

  el("self-cash-date").value = result.businessDate;
  applyShift();
}

async function submitClosing(event) {
  event.preventDefault();
  const submit = el("self-cash-submit");
  setBusy(submit, true);

  const body = {
    businessDate: state.businessDate || undefined,
    shift: el("self-cash-shift").value,
    invoiceCount: Number(el("self-cash-invoices").value || 0),
    notes: el("self-cash-notes").value.trim(),
    lines: state.lines
      .filter((line) => line.label.trim() !== "")
      .map((line) => ({
        category: line.category,
        label: line.label.trim(),
        amount: Number(line.amount || 0),
        reference: (line.reference ?? "").trim(),
      })),
  };

  for (const field of MONEY_FIELDS) {
    if (DERIVED_FIELDS.has(field)) continue;
    body[field] = Number(el(`self-cash-${field}`).value || 0);
  }

  const result = await api("/cashier/closings", { method: "POST", body });
  setBusy(submit, false);

  if (!result.ok) {
    setAlert(el("self-cash-result"), result.error ?? "تعذّر رفع التقفيل", "error");
    return;
  }

  await refreshSelfCashier();
  setAlert(el("self-cash-result"), result.message ?? "تم رفع التقفيل", "ok");
}

/** يربط أحداث الشاشة مرة واحدة عند أول فتح. */
export function initSelfCashier() {
  if (state.ready) return;
  state.ready = true;

  el("self-cash-form").addEventListener("submit", submitClosing);
  el("self-cash-shift").addEventListener("change", applyShift);
  el("self-cash-add-network").addEventListener("click", () => addLine("network"));
  el("self-cash-add-delivery").addEventListener("click", () => addLine("delivery_app"));
  el("self-cash-add-expense").addEventListener("click", () => addLine("expense"));

  for (const field of MONEY_FIELDS) {
    if (DERIVED_FIELDS.has(field)) continue;
    el(`self-cash-${field}`).addEventListener("input", recomputeDerived);
  }
}
