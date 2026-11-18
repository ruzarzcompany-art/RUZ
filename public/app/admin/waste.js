/**
 * تبويب «الهدر» في المخزون: مراجعة تسجيلات الموظفين (اعتماد / رفض)، والتقرير
 * حسب السبب والصنف والموظف، ونسبة الهدر من المبيعات، وحد التنبيه.
 */

import { api, el, formatDateTime, formatMoney, setAlert, setBusy, todayIso } from "../api.js";

const state = { report: null };
const branchId = () => el("inventory-branch").value || "";
const q = (extra = {}) => {
  const p = new URLSearchParams(extra);
  if (branchId()) p.set("branchId", branchId());
  return p.toString();
};
const qty = (v) => String(Math.round(Number(v || 0) * 1000) / 1000);

function cell(content) {
  const td = document.createElement("td");
  if (content instanceof Node) td.append(content);
  else td.textContent = content === null || content === undefined || content === "" ? "—" : String(content);
  return td;
}

function badge(text, tone) {
  const n = document.createElement("span");
  n.className = `badge ${tone}`;
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

async function review(entry, decision, button) {
  let quantity;
  let note = "";
  if (decision === "approve") {
    const typed = window.prompt(`الكمية المعتمدة من ${entry.itemName} (${entry.unit}) — عدّلها إن كانت مختلفة:`, qty(entry.quantity));
    if (typed === null) return;
    quantity = Number(typed);
    if (!(quantity > 0)) return setAlert(el("stk-alert"), "الكمية المعتمدة غير صالحة", "error");
  } else {
    const typed = window.prompt("سبب الرفض (إلزامي):", "");
    if (typed === null) return;
    note = typed.trim();
    if (!note) return setAlert(el("stk-alert"), "اكتب سبب الرفض", "error");
  }
  setBusy(button, true);
  const res = await api(`/waste/${entry.id}/review`, { method: "POST", body: { decision, quantity, note } });
  setBusy(button, false);
  setAlert(el("stk-alert"), res.ok ? res.message : res.error ?? "تعذّرت المراجعة", res.ok ? "ok" : "error");
  if (res.ok) await loadWaste();
}

function entryRow(e, canApprove) {
  const tr = document.createElement("tr");
  if (e.status === "pending") tr.className = "row--attention";
  const tone = e.status === "approved" ? "badge--ok" : e.status === "rejected" ? "badge--disputed" : "badge--warn";
  const actions = document.createElement("span");
  actions.className = "row-actions";
  if (e.status === "pending" && canApprove) {
    for (const [decision, label, cls] of [
      ["approve", "اعتماد", "btn btn--primary btn--xs"],
      ["reject", "رفض", "btn btn--danger btn--xs"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.onclick = () => review(e, decision, b);
      actions.append(b);
    }
  } else if (e.reviewedBy) {
    actions.textContent = `${e.reviewedBy}${e.reviewNote ? ` — ${e.reviewNote}` : ""}`;
  }
  tr.append(
    cell(`${e.businessDate} ${formatDateTime(e.occurredAt).split(" ").pop() ?? ""}`),
    cell(e.itemName),
    cell(`${qty(e.quantity)} ${e.unit}`),
    cell(formatMoney(e.totalCost)),
    cell(e.reasonLabel),
    cell(e.station),
    cell(e.recordedBy),
    cell(e.notes),
    cell(badge(e.status === "approved" ? "معتمد" : e.status === "rejected" ? "مرفوض" : "بانتظار الاعتماد", tone)),
    cell(actions),
  );
  return tr;
}

function groupRows(tableId, groups) {
  el(tableId)
    .querySelector("tbody")
    .replaceChildren(
      ...groups.map((g) => {
        const tr = document.createElement("tr");
        tr.append(cell(g.label), cell(String(g.count)), cell(formatMoney(g.value)));
        return tr;
      }),
    );
}

export async function loadWaste() {
  if (!el("wst-from").value) el("wst-from").value = `${todayIso().slice(0, 8)}01`;
  if (!el("wst-to").value) el("wst-to").value = todayIso();
  const res = await api(`/waste?${q({ from: el("wst-from").value, to: el("wst-to").value, status: el("wst-status").value })}`);
  if (!res.ok) return setAlert(el("stk-alert"), res.error ?? "تعذّر تحميل الهدر", "error");
  state.report = res;
  const t = res.totals;
  el("wst-limit").value = String(t.limitPercent);
  el("wst-limit-box").hidden = !res.canApprove;
  el("wst-totals").replaceChildren(
    tile("بانتظار الاعتماد", String(t.pending), t.pending ? "warn" : "good", t.pending ? formatMoney(t.pendingValue) : ""),
    tile("هدر معتمد", formatMoney(t.approvedValue), "", `${t.approved} تسجيل`),
    tile("مبيعات الفترة", formatMoney(t.sales)),
    tile("نسبة الهدر من المبيعات", t.percent === null ? "—" : `${t.percent}٪`, t.overLimit ? "bad" : "good", `الحد ${t.limitPercent}٪`),
    tile("مرفوض", String(t.rejected)),
  );
  el("wst-table").querySelector("tbody").replaceChildren(...res.entries.map((e) => entryRow(e, res.canApprove)));
  el("wst-empty").hidden = res.entries.length > 0;
  groupRows("wst-by-reason", res.byReason);
  groupRows("wst-by-item", res.byItem);
  groupRows("wst-by-employee", res.byEmployee);
}

async function saveLimit() {
  const b = el("wst-limit-save");
  setBusy(b, true);
  const res = await api("/waste/settings", { method: "PUT", body: { branchId: branchId() || undefined, limitPercent: Number(el("wst-limit").value) } });
  setBusy(b, false);
  setAlert(el("stk-alert"), res.ok ? res.message : res.error ?? "تعذّر الحفظ", res.ok ? "ok" : "error");
  if (res.ok) await loadWaste();
}

function printWaste() {
  const r = state.report;
  if (!r) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = r.entries
    .map((e) => `<tr><td>${esc(e.businessDate)}</td><td>${esc(e.itemName)}</td><td>${esc(qty(e.quantity))} ${esc(e.unit)}</td><td>${esc(formatMoney(e.totalCost))}</td><td>${esc(e.reasonLabel)}</td><td>${esc(e.station)}</td><td>${esc(e.recordedBy)}</td><td>${esc(e.statusLabel)}</td><td>${esc(e.reviewedBy)}</td></tr>`)
    .join("");
  const group = (title, list) => `<h3>${title}</h3><table><thead><tr><th>البند</th><th>العدد</th><th>القيمة</th></tr></thead><tbody>${list.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.count}</td><td>${esc(formatMoney(g.value))}</td></tr>`).join("")}</tbody></table>`;
  const t = r.totals;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير الهدر</title>
<style>@page{size:A4 landscape;margin:12mm}body{font-family:Tahoma,Arial,sans-serif;color:#111}h1{font-size:19px;margin:0 0 4px}h3{font-size:14px;margin:16px 0 6px}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #999;padding:4px;text-align:right}th{background:#eee}.sum{margin:8px 0;font-size:13px}.sign{display:flex;gap:40px;margin-top:36px}.sign div{flex:1;border-top:1px solid #333;padding-top:6px;text-align:center}</style></head>
<body><h1>تقرير الهدر — ${esc(r.branchName)}</h1><div>الفترة ${esc(r.from)} إلى ${esc(r.to)}</div>
<div class="sum">هدر معتمد: ${esc(formatMoney(t.approvedValue))} · بانتظار الاعتماد: ${t.pending} (${esc(formatMoney(t.pendingValue))}) · مبيعات الفترة: ${esc(formatMoney(t.sales))} · نسبة الهدر: ${t.percent === null ? "—" : `${t.percent}٪`} (الحد ${t.limitPercent}٪)</div>
<table><thead><tr><th>التاريخ</th><th>الصنف</th><th>الكمية</th><th>القيمة</th><th>السبب</th><th>المحطة</th><th>سجّله</th><th>الحالة</th><th>راجعه</th></tr></thead><tbody>${rows || '<tr><td colspan="9">لا هدر مسجَّل في هذه الفترة.</td></tr>'}</tbody></table>
${group("حسب السبب", r.byReason)}${group("حسب الصنف", r.byItem)}${group("حسب الموظف", r.byEmployee)}
<div class="sign"><div>مدير الفرع</div><div>المالك</div><div>التاريخ</div></div>
<script>window.onload=()=>window.print()</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return setAlert(el("stk-alert"), "اسمح بالنوافذ المنبثقة لطباعة التقرير.", "warn");
  w.document.write(html);
  w.document.close();
}

export function initWaste() {
  el("wst-load").addEventListener("click", loadWaste);
  el("wst-status").addEventListener("change", loadWaste);
  el("wst-print").addEventListener("click", printWaste);
  el("wst-limit-save").addEventListener("click", saveLimit);
}
