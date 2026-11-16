/**
 * تبويبات شاشة المخزون: الأرصدة من فوديكس · الاستلام اليومي · الجرد · السجل.
 */

import { api, el, formatDateTime, formatMoney, setAlert, setBusy, todayIso } from "../api.js";
import { createPager } from "../pagination.js";

const state = { tab: "stock", can: () => false, items: [], docs: [], onCount: null, onLog: null, branchName: "" };
const stockPager = createPager("stk-table", { unit: "صنف" });
const rcvPager = createPager("rcv-table", { unit: "مستند" });

const money = (v) => (v === null || v === undefined ? "—" : formatMoney(v));
const qty = (v) => (v === null || v === undefined ? "—" : String(Math.round(v * 1000) / 1000));

function badge(text, tone = "") {
  const n = document.createElement("span");
  n.className = `badge ${tone}`;
  n.textContent = text;
  return n;
}

function tile(label, value, tone = "", note = "") {
  const node = document.createElement("div");
  node.className = `fin-tile${tone ? ` fin-tile--${tone}` : ""}`;
  node.innerHTML = '<span class="fin-tile__label"></span><strong class="fin-tile__value"></strong>';
  node.children[0].textContent = label;
  node.children[1].textContent = value;
  if (note) {
    const n = document.createElement("span");
    n.className = "fin-tile__note";
    n.textContent = note;
    node.append(n);
  }
  return node;
}

function tr(cells, className = "") {
  const row = document.createElement("tr");
  if (className) row.className = className;
  for (const c of cells) {
    const td = document.createElement("td");
    if (c instanceof Node) td.append(c);
    else td.textContent = c === null || c === undefined ? "—" : String(c);
    row.append(td);
  }
  return row;
}

const branchId = () => el("inventory-branch").value || "";
const q = (extra = {}) => {
  const p = new URLSearchParams(extra);
  if (branchId()) p.set("branchId", branchId());
  return p.toString();
};

/* ── الأرصدة ──────────────────────────────────────────────────── */

function drawItems() {
  const term = el("stk-q").value.trim().toLowerCase();
  const filter = el("stk-filter").value;
  const list = state.items.filter((i) => {
    if (term && !`${i.name} ${i.code} ${i.category}`.toLowerCase().includes(term)) return false;
    if (filter === "low") return i.low;
    if (filter === "nostock") return i.quantity === null;
    return true;
  });
  el("stk-empty").hidden = state.items.length > 0;
  stockPager.render(list, (i) =>
    tr(
      [i.code, i.name, i.category || "—", i.quantity === null ? badge("—") : i.low ? badge(qty(i.quantity), "badge--disputed") : qty(i.quantity), i.unit, i.minQuantity ? qty(i.minQuantity) : "—", money(i.unitCost), money(i.value)],
      i.low ? "row--attention" : "",
    ),
  );
}

async function loadItems() {
  const res = await api(`/stock/items?${q()}`);
  if (!res.ok) return setAlert(el("stk-alert"), res.error ?? "تعذّر تحميل الأرصدة", "error");
  state.items = res.items;
  const t = res.totals;
  el("stk-totals").replaceChildren(
    tile("الأصناف", String(t.items), "", `${t.withStock} برصيد من فوديكس`),
    tile("قيمة المخزون", money(t.value)),
    tile("تحت حد إعادة الطلب", String(t.low), t.low ? "bad" : "good"),
    tile("آخر تحديث للأرصدة", t.lastSync ? formatDateTime(t.lastSync) : "لم يُسحب بعد", t.lastSync ? "" : "warn"),
  );
  drawItems();
}

async function syncNow() {
  const b = el("stk-sync");
  setBusy(b, true);
  setAlert(el("stk-alert"), "جارٍ سحب الأصناف والأرصدة وأوامر الشراء والتحويلات من فوديكس…", "");
  const res = await api("/stock/sync", { method: "POST", body: { branchId: branchId() || undefined, full: true } });
  setBusy(b, false);
  if (!res.ok) return setAlert(el("stk-alert"), res.error, "error");
  const notes = res.docs.notes?.length ? ` ملاحظات: ${res.docs.notes.join("، ")}.` : "";
  setAlert(
    el("stk-alert"),
    `تم: ${res.items.items} صنف (${res.items.stocks} برصيد)، و${res.docs.docs} مستند شراء/تحويل منها ${res.docs.received} مستلم في فوديكس.${notes}`,
    "ok",
  );
  await Promise.all([loadItems(), state.tab === "receive" ? loadDocs() : null]);
}

async function testFields() {
  const b = el("stk-test");
  setBusy(b, true);
  const res = await api("/stock/test", { method: "POST", body: { branchId: branchId() || undefined } });
  setBusy(b, false);
  const box = el("stk-fields");
  box.hidden = false;
  if (!res.ok) {
    box.textContent = res.error;
    return;
  }
  const line = (label, r) =>
    `${label}: ${r.available ? `متاح (${r.path}) — ${r.total} سجل — الحقول: ${r.fields.join("، ") || "—"}${r.itemFields.length ? ` — حقول الأصناف داخله: ${r.itemFields.join("، ")}` : ""}` : "غير متاح في الحساب"}`;
  box.textContent = [line("الأصناف", res.items), line("أوامر الشراء", res.purchaseOrders), line("التحويلات", res.transfers)].join("\n");
  box.style.whiteSpace = "pre-line";
}

/* ── الاستلام اليومي ───────────────────────────────────────────── */

const CONFIRM_TONE = { awaiting: "badge--warn", confirmed: "badge--ok", disputed: "badge--disputed", skipped: "" };
const STATE_TEXT = { open: "لم يُستلم بعد", received: "مستلم", cancelled: "ملغى" };

function showDoc(d) {
  const box = el("rcv-detail");
  box.hidden = false;
  const h = document.createElement("h3");
  h.className = "card__title card__title--sm";
  h.textContent = `${d.kindLabel} رقم ${d.reference}${d.party ? ` — ${d.party}` : ""}`;
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const t = document.createElement("table");
  t.className = "table";
  t.innerHTML = "<thead><tr><th>الصنف</th><th>الرمز</th><th>المطلوب</th><th>المستلم في فوديكس</th><th>الواصل فعلاً</th><th>التكلفة</th></tr></thead>";
  const body = t.createTBody();
  for (const l of d.items) {
    const diff = d.diffs.find((x) => (x.sku && x.sku === l.sku) || x.name === l.name);
    body.append(tr([l.name, l.sku || "—", `${qty(l.ordered)} ${l.unit}`, l.received ? `${qty(l.received)} ${l.unit}` : "—", diff ? badge(`${qty(diff.actual)} ${l.unit}`, "badge--disputed") : d.confirmStatus === "confirmed" ? badge("مطابق", "badge--ok") : "—", money(l.cost)], diff ? "row--attention" : ""));
  }
  wrap.append(t);
  const info = document.createElement("p");
  info.className = "hint";
  info.textContent = [
    `التاريخ ${d.businessDate}`,
    `الحالة في فوديكس: ${STATE_TEXT[d.state] ?? d.state}`,
    d.confirmedBy ? `أكّده ${d.confirmedBy} ${formatDateTime(d.confirmedAt)}` : "",
    d.confirmNote ? `ملاحظة: ${d.confirmNote}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn--ghost btn--xs";
  close.textContent = "إغلاق";
  close.onclick = () => {
    box.hidden = true;
  };
  box.replaceChildren(h, info, wrap, close);
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadDocs() {
  if (!el("rcv-from").value) el("rcv-from").value = todayIso();
  if (!el("rcv-to").value) el("rcv-to").value = todayIso();
  const res = await api(`/stock/docs?${q({ from: el("rcv-from").value, to: el("rcv-to").value, confirm: el("rcv-status").value })}`);
  if (!res.ok) return setAlert(el("stk-alert"), res.error ?? "تعذّر تحميل الاستلامات", "error");
  state.docs = res.docs;
  state.branchName = res.branchName;
  const t = res.totals;
  el("rcv-totals").replaceChildren(
    tile("المستندات", String(t.docs)),
    tile("القيمة", money(t.value)),
    tile("مستلم ولم يُؤكَّد", String(t.awaiting), t.awaiting ? "warn" : "good"),
    tile("فيها فرق", String(t.disputed), t.disputed ? "bad" : "good"),
  );
  el("rcv-empty").hidden = res.docs.length > 0;
  rcvPager.render(res.docs, (d) => {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn--ghost btn--xs";
    open.textContent = "الأصناف";
    open.onclick = () => showDoc(d);
    return tr(
      [d.businessDate, d.kindLabel, d.reference, d.party || "—", String(d.items.length), money(d.total), badge(STATE_TEXT[d.state] ?? d.state, d.state === "received" ? "badge--ok" : ""), badge(d.confirmLabel, CONFIRM_TONE[d.confirmStatus]), d.confirmedBy || "—", open],
      d.confirmStatus === "disputed" ? "row--attention" : "",
    );
  });
}

/** نموذج الاستلام اليومي للطباعة: كل المستندات وأصنافها مع خانات التوقيع. */
function printDaily() {
  const docs = state.docs.filter((d) => d.state !== "cancelled");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const blocks = docs
    .map(
      (d) => `<section><h3>${esc(d.kindLabel)} رقم ${esc(d.reference)} — ${esc(d.party)} <small>${esc(d.businessDate)} · ${esc(d.confirmLabel)}</small></h3>
<table><thead><tr><th>الصنف</th><th>الرمز</th><th>الكمية في فوديكس</th><th>الوحدة</th><th>الواصل فعلاً</th><th>ملاحظة</th></tr></thead><tbody>
${d.items.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.sku)}</td><td>${qty(l.received || l.ordered)}</td><td>${esc(l.unit)}</td><td></td><td></td></tr>`).join("")}
</tbody></table></section>`,
    )
    .join("");
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>نموذج الاستلام اليومي</title>
<style>body{font-family:Tahoma,Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}h3{font-size:15px;margin:18px 0 6px}small{color:#555;font-weight:normal}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #999;padding:6px;text-align:right}th{background:#eee}.sign{display:flex;gap:40px;margin-top:40px}.sign div{flex:1;border-top:1px solid #333;padding-top:6px;text-align:center}</style></head>
<body><h1>نموذج الاستلام اليومي — ${esc(state.branchName)}</h1><div>الفترة: ${esc(el("rcv-from").value)} إلى ${esc(el("rcv-to").value)} · الكميات من فوديكس، والموظف يكتب الواصل فعلاً</div>
${blocks || "<p>لا مستندات في هذه الفترة.</p>"}
<div class="sign"><div>المستلِم</div><div>مدير الفرع</div><div>التاريخ والوقت</div></div>
<script>window.onload=()=>window.print()</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return setAlert(el("stk-alert"), "اسمح بالنوافذ المنبثقة لطباعة النموذج.", "warn");
  w.document.write(html);
  w.document.close();
}

/* ── التبويبات ─────────────────────────────────────────────────── */

async function showTab(tab) {
  state.tab = tab;
  for (const n of el("inv-tabs").querySelectorAll(".tab")) n.classList.toggle("is-active", n.dataset.inv === tab);
  for (const n of document.querySelectorAll("#panel-inventory [data-inv-tab]")) n.hidden = n.dataset.invTab !== tab;
  setAlert(el("stk-alert"), "");
  if (tab === "stock") await loadItems();
  if (tab === "receive") await loadDocs();
  if (tab === "count") await state.onCount?.();
  if (tab === "log") await state.onLog?.();
}

export async function refreshInventoryTabs() {
  await showTab(state.tab);
}

export function initInventoryTabs({ can, onCount, onLog }) {
  state.can = can;
  state.onCount = onCount;
  state.onLog = onLog;
  for (const n of document.querySelectorAll("[data-stk-manage]")) n.hidden = !can("inventory.items_manage");
  el("inv-tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) showTab(t.dataset.inv);
  });
  el("inventory-branch").addEventListener("change", () => showTab(state.tab));
  el("stk-sync").addEventListener("click", syncNow);
  el("stk-test").addEventListener("click", testFields);
  el("stk-q").addEventListener("input", drawItems);
  el("stk-filter").addEventListener("change", drawItems);
  el("rcv-load").addEventListener("click", loadDocs);
  el("rcv-status").addEventListener("change", loadDocs);
  el("rcv-print").addEventListener("click", printDaily);
}


