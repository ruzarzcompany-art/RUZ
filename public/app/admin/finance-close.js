/**
 * شاشة «المالية» بتبويباتها الداخلية:
 *   الملخّص · تقفيل اليوم (من فوديكس) · الشبكات والتطبيقات · إقفال الشهر.
 *
 * «تقفيل اليوم» يحلّ محلّ شاشتي «تقفيل الكاشير» و«النقدية والإقفال»:
 * الأرقام من فوديكس، والكاشير يؤكّد النقد من تطبيقه، والمدير يراجع هنا.
 */

import { api, el, formatDateTime, formatMoney, setAlert, setBusy, todayIso } from "../api.js";
import { createPager } from "../pagination.js";
import { refreshCashboxPanel } from "./cashbox.js";
import { refreshFinanceHome } from "./finance-home.js";
import { initBankPanel, loadBank } from "./bank.js";

const state = { tab: "summary", can: () => false, openMain: null, rows: [] };
const pager = createPager("dc-table", { unit: "يوم" });

const money = (v) => (v === null || v === undefined ? "—" : formatMoney(v));

const STATUS_TONE = {
  pending: "badge--warn",
  auto_closed: "badge--disputed",
  submitted: "",
  reviewed: "badge--ok",
  disputed: "badge--disputed",
};

function badge(text, tone) {
  const n = document.createElement("span");
  n.className = `badge ${tone ?? ""}`;
  n.textContent = text;
  return n;
}

function tile(label, value, tone = "", note = "") {
  const node = document.createElement("div");
  node.className = `fin-tile${tone ? ` fin-tile--${tone}` : ""}`;
  const l = document.createElement("span");
  l.className = "fin-tile__label";
  l.textContent = label;
  const v = document.createElement("strong");
  v.className = "fin-tile__value";
  v.textContent = value;
  node.append(l, v);
  if (note) {
    const n = document.createElement("span");
    n.className = "fin-tile__note";
    n.textContent = note;
    node.append(n);
  }
  return node;
}

function diffCell(r) {
  if (r.difference === null) return badge("لم يُعَدّ", "badge--warn");
  if (r.difference === 0) return badge("مطابق", "badge--ok");
  return badge(`${r.difference < 0 ? "عجز" : "زيادة"} ${formatMoney(Math.abs(r.difference))}`, r.difference < 0 ? "badge--disputed" : "badge--warn");
}

function cell(content) {
  const td = document.createElement("td");
  if (content instanceof Node) td.append(content);
  else td.textContent = content === null || content === undefined ? "—" : String(content);
  return td;
}

function renderRow(r) {
  const tr = document.createElement("tr");
  if (r.status === "auto_closed") tr.className = "row--attention";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn btn--ghost btn--xs";
  open.textContent = "تفاصيل";
  open.addEventListener("click", () => showDetail(r));
  tr.append(
    cell(r.businessDate),
    cell(r.employeeName || "—"),
    cell(money(r.totalSales)),
    cell(money(r.cashSales)),
    cell(money(r.networkSales)),
    cell(money(r.deliverySales)),
    cell(r.expenses ? money(r.expenses) : "—"),
    cell(money(r.expectedCash)),
    cell(money(r.countedCash)),
    cell(diffCell(r)),
    cell(badge(r.statusLabel, STATUS_TONE[r.status])),
    cell(open),
  );
  return tr;
}

function listTable(title, items) {
  const wrap = document.createElement("div");
  const h = document.createElement("h4");
  h.className = "card__title card__title--xs";
  h.textContent = title;
  wrap.append(h);
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "لا يوجد";
    wrap.append(p);
    return wrap;
  }
  const t = document.createElement("table");
  t.className = "table";
  const body = t.createTBody();
  for (const i of items) {
    const tr = body.insertRow();
    tr.insertCell().textContent = i.label;
    tr.insertCell().textContent = formatMoney(i.amount);
  }
  const tw = document.createElement("div");
  tw.className = "table-wrap";
  tw.append(t);
  wrap.append(tw);
  return wrap;
}

function showDetail(r) {
  el("dc-detail").hidden = false;
  el("dc-detail-title").textContent = `تقفيل يوم ${r.businessDate} — ${r.statusLabel}`;
  const body = el("dc-detail-body");
  const tiles = document.createElement("div");
  tiles.className = "fin-tiles";
  tiles.append(
    tile("المبيعات", money(r.totalSales), "", `${r.invoiceCount} فاتورة`),
    tile("النقد", money(r.cashSales)),
    tile("مستحقات الشبكة والتطبيقات", money(r.receivables)),
    tile("الخصومات", money(r.discounts)),
    tile("المرتجعات", money(r.refunds)),
    tile("عهدة البداية", money(r.openingFloat)),
    tile("النقد المتوقّع", money(r.expectedCash)),
    tile("النقد المعدود", money(r.countedCash)),
    tile(
      "فرق الصندوق",
      r.difference === null ? "لم يُعَدّ" : money(r.difference),
      r.difference === null ? "warn" : r.difference < 0 ? "bad" : r.difference > 0 ? "warn" : "good",
    ),
  );
  const info = document.createElement("p");
  info.className = "hint";
  info.textContent = [
    r.employeeName ? `الكاشير: ${r.employeeName}` : "",
    r.notes ? `ملاحظة الكاشير: ${r.notes}` : "",
    r.reviewedBy ? `راجعه: ${r.reviewedBy}${r.reviewNote ? ` — ${r.reviewNote}` : ""}` : "",
    `آخر تحديث: ${formatDateTime(r.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const parts = [tiles, info, listTable("الشبكة (من فوديكس)", r.network), listTable("تطبيقات التوصيل (من فوديكس)", r.delivery), listTable("مصاريف الدرج", r.expenseLines)];

  if (state.can("cashier.review")) {
    const actions = document.createElement("div");
    actions.className = "row row--wrap";
    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "ملاحظة المراجعة (اختياري)";
    note.maxLength = 500;
    const mk = (text, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = text;
      b.addEventListener("click", () => fn(b));
      return b;
    };
    const review = async (status, b) => {
      setBusy(b, true);
      const res = await api(`/cashier/closings/${r.id}/review`, { method: "PATCH", body: { status, reviewNote: note.value.trim() } });
      setBusy(b, false);
      setAlert(el("fh-alert"), res.ok ? "حُفظت المراجعة." : res.error, res.ok ? "ok" : "error");
      if (res.ok) await loadDayCloses();
    };
    const refresh = async (b) => {
      setBusy(b, true);
      const res = await api("/dayclose/refresh", { method: "POST", body: { branchId: branchId(), date: r.businessDate } });
      setBusy(b, false);
      setAlert(el("fh-alert"), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
      if (res.ok) await loadDayCloses();
    };
    actions.append(note);
    if (!r.awaitingCash) {
      actions.append(
        mk("مراجَع ✓", "btn btn--primary btn--xs", (b) => review("reviewed", b)),
        mk("اعتراض", "btn btn--ghost btn--xs", (b) => review("disputed", b)),
      );
    }
    actions.append(mk("تحديث من فوديكس", "btn btn--ghost btn--xs", refresh));
    if (r.awaitingCash) {
      const counted = document.createElement("input");
      counted.type = "number";
      counted.min = "0";
      counted.step = "0.01";
      counted.placeholder = "النقد المعدود (بالنيابة)";
      actions.append(
        counted,
        mk("تأكيد بالنيابة", "btn btn--ghost btn--xs", async (b) => {
          if (counted.value === "") return setAlert(el("fh-alert"), "اكتب النقد المعدود.", "error");
          setBusy(b, true);
          const res = await api(`/dayclose/${r.id}/confirm`, {
            method: "POST",
            body: { countedCash: Number(counted.value), expenses: r.expenseLines, notes: note.value.trim() || "أكّده المدير بالنيابة" },
          });
          setBusy(b, false);
          setAlert(el("fh-alert"), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
          if (res.ok) await loadDayCloses();
        }),
      );
    }
    parts.push(actions);
  }
  body.replaceChildren(...parts);
  el("dc-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function branchId() {
  return el("fh-branch").value || "";
}

export async function loadDayCloses() {
  if (!el("dc-from").value) el("dc-from").value = `${todayIso().slice(0, 8)}01`;
  if (!el("dc-to").value) el("dc-to").value = todayIso();
  const q = new URLSearchParams({ from: el("dc-from").value, to: el("dc-to").value });
  if (branchId()) q.set("branchId", branchId());
  const res = await api(`/dayclose?${q}`);
  if (!res.ok) {
    setAlert(el("fh-alert"), res.error ?? "تعذّر تحميل التقفيلات", "error");
    return;
  }
  const t = res.totals;
  if (document.activeElement !== el("dc-start-date")) el("dc-start-date").value = res.startDate ?? "";
  if (res.startDate && el("dc-from").value < res.startDate) el("dc-from").value = res.startDate;
  if (document.activeElement !== el("dc-float-amount")) el("dc-float-amount").value = String(res.openingFloat ?? 0);
  el("dc-totals").replaceChildren(
    tile("عهدة الصندوق", money(res.openingFloat ?? 0), "", "داخل الدرج يومياً"),
    tile("المبيعات", money(t.totalSales), "", `${t.days} يوم`),
    tile("النقد", money(t.cashSales)),
    tile("مستحقات الشبكة والتطبيقات", money(t.receivables), "", `شبكة ${formatMoney(t.networkSales)} · تطبيقات ${formatMoney(t.deliverySales)}`),
    tile("مصاريف الدرج", money(t.expenses)),
    tile("عجز الصندوق", money(t.shortage), t.shortage < 0 ? "bad" : "good"),
    tile("زيادة الصندوق", money(t.surplus), t.surplus > 0 ? "warn" : ""),
    tile("بانتظار تأكيد الكاشير", String(t.awaiting), t.awaiting ? "bad" : "good"),
  );
  state.rows = res.closings;
  el("dc-table-empty").hidden = res.closings.length > 0;
  pager.render(res.closings, renderRow);
}

async function rebuild(event) {
  event.preventDefault();
  const button = event.target.querySelector("button");
  setBusy(button, true);
  let res;
  let total = 0;
  // الأيام الكثيرة تُبنى على دفعات حتى لا تتجاوز مهلة الخادم
  for (let i = 0; i < 40; i++) {
    res = await api("/dayclose/rebuild", {
      method: "POST",
      body: { branchId: branchId(), from: el("dc-rebuild-from").value, to: el("dc-rebuild-to").value },
    });
    if (!res.ok) break;
    total = res.days;
    if (res.complete) break;
  }
  setBusy(button, false);
  setAlert(el("fh-alert"), res?.ok ? `بُنيت تقفيلات ${total} يوم من فوديكس.` : res?.error ?? "تعذّر إعادة البناء", res?.ok ? "ok" : "error");
  await loadDayCloses();
}

async function saveFloat(event) {
  event.preventDefault();
  const button = event.target.querySelector("button");
  setBusy(button, true);
  const res = await api("/dayclose/float", {
    method: "POST",
    body: { branchId: branchId(), amount: Number(el("dc-float-amount").value), from: el("dc-float-from").value },
  });
  setBusy(button, false);
  setAlert(el("fh-alert"), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
  if (res.ok) await loadDayCloses();
}

async function saveStartDate(event) {
  event.preventDefault();
  const button = event.target.querySelector("button");
  setBusy(button, true);
  const res = await api("/dayclose/start-date", { method: "PUT", body: { branchId: branchId(), startDate: el("dc-start-date").value || null } });
  setBusy(button, false);
  setAlert(el("fh-alert"), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
  if (res.ok) {
    if (res.startDate) el("dc-from").value = res.startDate;
    await loadDayCloses();
  }
}

const LOADERS = {
  summary: refreshFinanceHome,
  close: loadDayCloses,
  settle: async () => {
    syncCashboxBranch();
    await refreshCashboxPanel();
  },
  month: async () => {
    syncCashboxBranch();
    await refreshCashboxPanel();
  },
  bank: loadBank,
};

/** فرع شاشة الشبكات وإقفال الشهر يتبع فرع المالية المختار. */
function syncCashboxBranch() {
  const target = el("cashbox-branch");
  const value = branchId();
  if (value && [...target.options].some((o) => o.value === value)) target.value = value;
}

async function showTab(tab) {
  state.tab = tab;
  for (const node of el("fin-tabs").querySelectorAll(".tab")) node.classList.toggle("is-active", node.dataset.fin === tab);
  for (const node of document.querySelectorAll("#panel-finance [data-fin-tab]")) node.hidden = node.dataset.finTab !== tab;
  setAlert(el("cashbox-alert"), "");
  await LOADERS[tab]?.();
}

export async function openFinanceTab(tab) {
  state.tab = tab in LOADERS ? tab : "summary";
  const panel = el("panel-finance");
  // فتح تبويب «المالية» يحمّل التبويب الداخلي المختار؛ وإن كان مفتوحاً نبدّل فقط
  if (panel.hidden && state.openMain) await state.openMain();
  else await showTab(state.tab);
}

export async function refreshFinancePanel() {
  await showTab(state.tab);
}

export function initFinancePanel({ can, openMain }) {
  state.can = can;
  state.openMain = openMain;
  el("fin-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) showTab(tab.dataset.fin);
  });
  el("fh-branch").addEventListener("change", () => {
    if (state.tab !== "summary") LOADERS[state.tab]?.();
  });
  el("dc-load").addEventListener("click", loadDayCloses);
  el("dc-detail-close").addEventListener("click", () => {
    el("dc-detail").hidden = true;
  });
  for (const node of document.querySelectorAll("[data-dc-manage]")) node.hidden = !can("cashier.review");
  el("dc-rebuild-form").addEventListener("submit", rebuild);
  el("dc-float-form").addEventListener("submit", saveFloat);
  el("dc-start-form").addEventListener("submit", saveStartDate);
  initBankPanel({ can, branchId });
  el("dc-float-from").value = todayIso();
  el("dc-rebuild-from").value = `${todayIso().slice(0, 8)}01`;
  el("dc-rebuild-to").value = todayIso();
}
