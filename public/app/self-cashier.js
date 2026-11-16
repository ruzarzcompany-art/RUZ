/**
 * تقفيل اليوم من تطبيق الموظف (الكاشير).
 *
 * كل أرقام المبيعات تأتي من فوديكس آلياً. الكاشير يرى الأيام التي تنتظر
 * تأكيده (اليوم الجاري، وأي يوم أُقفل آلياً الساعة 4 فجراً ولم يؤكّده)،
 * فيكتب النقد المعدود في الدرج ومصاريف الدرج فقط ثم يؤكّد. الحساب النهائي
 * لفرق الصندوق في الخادم.
 */

import { api, el, formatMoney, setAlert, setBusy } from "./api.js";

const state = { ready: false, data: null };

const money = (v) => (v === null || v === undefined ? "—" : formatMoney(v));

function node(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c);
  return n;
}

function figureRow(label, value, strong) {
  return node("div", { className: `dc-row${strong ? " dc-row--strong" : ""}` }, node("span", { text: label }), node("span", { text: value }));
}

function expenseRow(list, item = { label: "", amount: "" }) {
  const label = node("input", { type: "text", placeholder: "البيان (غاز، دجاج، لبن ...)", maxlength: "120" });
  label.value = item.label;
  const amount = node("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "المبلغ" });
  amount.value = item.amount;
  const remove = node("button", { type: "button", className: "btn btn--ghost btn--xs", text: "حذف" });
  const row = node("div", { className: "dc-expense" }, label, amount, remove);
  remove.addEventListener("click", () => {
    row.remove();
    list.dispatchEvent(new Event("input", { bubbles: true }));
  });
  list.append(row);
  return row;
}

function readExpenses(list) {
  return [...list.querySelectorAll(".dc-expense")].map((row) => {
    const [label, amount] = row.querySelectorAll("input");
    return { label: label.value.trim(), amount: Number(amount.value || 0) };
  });
}

/** بطاقة يوم ينتظر التأكيد. */
function closingCard(c) {
  const card = node("article", { className: "dc-card" });
  const overdue = c.status === "auto_closed";
  card.append(
    node(
      "div",
      { className: "card__head" },
      node("h3", { className: "card__title card__title--xs", text: `يوم ${c.businessDate}` }),
      node("span", { className: `badge ${overdue ? "badge--disputed" : "badge--warn"}`, text: c.statusLabel }),
    ),
  );
  if (overdue) {
    card.append(node("p", { className: "hint", text: "هذا اليوم أُقفل آلياً الساعة 4 فجراً لأنه لم يُؤكَّد. أكّد النقد المعدود الآن — وصل تنبيه لمدير الفرع." }));
  }

  const figures = node(
    "div",
    { className: "dc-figures" },
    figureRow("إجمالي المبيعات (فوديكس)", money(c.totalSales)),
    figureRow("عدد الفواتير", String(c.invoiceCount)),
    figureRow("مبيعات النقد", money(c.cashSales)),
    figureRow("الشبكة", money(c.networkSales)),
    figureRow("تطبيقات التوصيل", money(c.deliverySales)),
    c.refunds ? figureRow("المرتجعات", money(c.refunds)) : null,
    figureRow("عهدة بداية الدرج", money(c.openingFloat)),
  );
  card.append(figures);

  const list = node("div", { className: "dc-expenses" });
  for (const e of c.expenseLines ?? []) expenseRow(list, e);
  const add = node("button", { type: "button", className: "btn btn--ghost btn--xs", text: "+ مصروف من الدرج" });
  add.addEventListener("click", () => expenseRow(list).querySelector("input").focus());

  const counted = node("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal", required: "required", placeholder: "اكتب النقد الموجود في الدرج" });
  const notes = node("textarea", { rows: "2", maxlength: "1000", placeholder: "ملاحظة (اختياري)" });
  notes.value = c.notes ?? "";

  const expected = node("strong");
  const diff = node("strong");
  const refundsCash = Math.max(0, Math.round((c.openingFloat + c.cashSales - c.expectedCash - (c.expenses ?? 0)) * 100) / 100);
  function preview() {
    const expenses = readExpenses(list).reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0);
    const exp = Math.round((c.openingFloat + c.cashSales - expenses - refundsCash) * 100) / 100;
    expected.textContent = formatMoney(exp);
    if (counted.value === "") {
      diff.textContent = "—";
      diff.className = "";
      return;
    }
    const d = Math.round((Number(counted.value) - exp) * 100) / 100;
    diff.textContent = d === 0 ? "مطابق" : `${d < 0 ? "عجز" : "زيادة"} ${formatMoney(Math.abs(d))}`;
    diff.className = d === 0 ? "dc-ok" : "dc-bad";
  }
  card.addEventListener("input", preview);

  const submit = node("button", { type: "submit", className: "btn btn--primary", text: "تأكيد التقفيل" });
  const form = node(
    "form",
    { className: "form-grid", novalidate: "novalidate" },
    node("h4", { className: "card__title card__title--xs", text: "مصاريف دفعتها من الدرج" }),
    list,
    add,
    figureRow("النقد المتوقّع في الدرج", "", true),
    node("label", { className: "field" }, node("span", { className: "field__label", text: "النقد المعدود في الدرج" }), counted),
    node("div", { className: "dc-row dc-row--strong" }, node("span", { text: "فرق الصندوق" }), diff),
    node("label", { className: "field" }, node("span", { className: "field__label", text: "ملاحظة" }), notes),
    submit,
  );
  form.querySelectorAll(".dc-row--strong")[0].lastChild.replaceWith(expected);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (counted.value === "") {
      setAlert(el("dc-alert"), "اكتب النقد المعدود في الدرج أولاً.", "error");
      counted.focus();
      return;
    }
    const expenses = readExpenses(list).filter((e) => e.label || e.amount);
    if (expenses.some((e) => !e.label || !(e.amount > 0))) {
      setAlert(el("dc-alert"), "كل مصروف يحتاج بياناً ومبلغاً أكبر من صفر.", "error");
      return;
    }
    if (!window.confirm(`تأكيد تقفيل يوم ${c.businessDate} بنقد معدود ${formatMoney(Number(counted.value))}؟ لا يمكن التعديل بعد التأكيد إلا عن طريق المدير.`)) return;
    setBusy(submit, true);
    const res = await api(`/dayclose/${c.id}/confirm`, {
      method: "POST",
      body: { countedCash: Number(counted.value), expenses, notes: notes.value.trim() },
    });
    setBusy(submit, false);
    if (!res.ok) {
      setAlert(el("dc-alert"), res.error ?? "تعذّر التأكيد", "error");
      return;
    }
    const d = res.closing?.difference ?? 0;
    setAlert(
      el("dc-alert"),
      d === 0 ? "تم تأكيد التقفيل — الصندوق مطابق." : `تم تأكيد التقفيل — ${d < 0 ? "عجز" : "زيادة"} ${formatMoney(Math.abs(d))}، وأُبلغ المدير.`,
      d === 0 ? "ok" : "warn",
    );
    await refreshSelfCashier();
  });
  card.append(form);
  preview();
  return card;
}

function renderLive(data) {
  const box = el("dc-live");
  box.replaceChildren();
  if (!data.live) return;
  const t = data.todayClosing;
  box.append(
    node("h3", { className: "card__title card__title--xs", text: `اليوم الجاري ${data.today} — من فوديكس الآن` }),
    node(
      "div",
      { className: "dc-figures" },
      figureRow("المبيعات", money(data.live.total)),
      figureRow("النقد", money(data.live.cash)),
      figureRow("الشبكة", money(data.live.card)),
      figureRow("التطبيقات", money(data.live.delivery)),
      figureRow("الفواتير", String(data.live.invoices)),
    ),
    node("p", { className: "hint", text: `اليوم يُقفل الساعة ${data.closeHour} فجراً. ${t && !t.awaitingCash ? "أكّدت تقفيل اليوم." : "أكّد التقفيل في نهاية ورديتك."}` }),
  );
}

export async function refreshSelfCashier() {
  const res = await api("/dayclose/mine");
  const badge = el("dc-badge");
  if (!res.ok || !res.available) {
    badge.textContent = "غير متاح";
    el("dc-pending").replaceChildren();
    el("dc-empty").hidden = false;
    el("dc-empty").textContent = res.reason ?? res.error ?? "تقفيل اليوم غير متاح لحسابك.";
    return;
  }
  state.data = res;
  renderLive(res);
  const pending = res.pending ?? [];
  badge.textContent = pending.length ? `${pending.length} بانتظار تأكيدك` : "لا شيء معلّق";
  badge.className = `badge ${pending.length ? "badge--warn" : "badge--ok"}`;
  // أقدم يوم معلّق مفتوح للتأكيد، والبقية مطويّة حتى لا تطول الشاشة
  el("dc-pending").replaceChildren(
    ...pending.map((c, i) => {
      const card = closingCard(c);
      if (i === 0) return card;
      const wrap = document.createElement("details");
      wrap.className = "dc-fold";
      const summary = document.createElement("summary");
      summary.textContent = `يوم ${c.businessDate} — ${c.statusLabel} — مبيعات ${formatMoney(c.totalSales)}`;
      wrap.append(summary, card);
      return wrap;
    }),
  );
  el("dc-empty").hidden = pending.length > 0;
}

export function initSelfCashier() {
  if (state.ready) return;
  state.ready = true;
}
