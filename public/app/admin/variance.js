/**
 * المخزون ← الجرد: «فروقات الجرد — ما خرج بلا تسجيل».
 * الرصيد الدفتري = المشتريات − استهلاك الوصفات − الهدر المعتمد؛ فنقص المعدود عنه
 * هو ما خرج بلا فاتورة أو بلا تسجيل هدر. يُعرض بالصنف والقيمة ونسبته من الاستهلاك.
 */

import { api, el, formatMoney, setAlert, todayIso } from "../api.js";
import { enhanceTables } from "./table-tools.js";

const qty = (v) => String(Math.round(Number(v || 0) * 1000) / 1000);
const branchId = () => el("inventory-branch").value || "";

function cell(content, className = "") {
  const td = document.createElement("td");
  if (className) td.className = className;
  if (content instanceof Node) td.append(content);
  else td.textContent = content === null || content === undefined || content === "" ? "—" : String(content);
  return td;
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

export async function loadVariance() {
  if (!el("var-from").value) el("var-from").value = `${todayIso().slice(0, 8)}01`;
  if (!el("var-to").value) el("var-to").value = todayIso();
  const p = new URLSearchParams({ from: el("var-from").value, to: el("var-to").value });
  if (branchId()) p.set("branchId", branchId());
  const res = await api(`/stock/variance-report?${p.toString()}`);
  if (!res.ok) return setAlert(el("stk-alert"), res.error ?? "تعذّر تحميل فروقات الجرد", "error");
  const t = res.totals;
  el("var-totals").replaceChildren(
    tile("قيمة النقص", formatMoney(t.shortageValue), t.shortageValue > 0 ? "bad" : "good", `${t.shortageItems} صنف ناقص`),
    tile("قيمة الزيادة", formatMoney(t.surplusValue), "", "معدود أكثر من الدفتري"),
    tile("تكلفة الطعام من المبيعات", t.foodCostPercent === null ? "—" : `${t.foodCostPercent}٪`, "", `استهلاك ${formatMoney(t.consumptionCost)} من مبيعات ${formatMoney(t.sales)}`),
    tile("مبيعات تقريبية بلا فاتورة", t.estimatedUninvoicedSales === null ? "—" : formatMoney(t.estimatedUninvoicedSales), t.estimatedUninvoicedSales ? "bad" : "good", "حدّ أعلى: لو كان كل النقص وجبات بلا فاتورة"),
    tile("عمليات الجرد", String(t.counts), "", t.openingCounts ? `${t.openingCounts} منها جرد افتتاحي` : ""),
  );
  const only = el("var-filter").value;
  const lines = res.lines.filter((l) => (only === "short" ? l.variance < 0 && !l.opening : only === "real" ? !l.opening : true));
  el("var-table")
    .querySelector("tbody")
    .replaceChildren(
      ...lines.map((l) => {
        const tr = document.createElement("tr");
        if (l.variance < 0 && !l.opening) tr.className = "row--attention";
        const badge = document.createElement("span");
        badge.className = `badge ${l.opening ? "" : l.variance < 0 ? "badge--disputed" : l.variance > 0 ? "badge--warn" : "badge--ok"}`;
        badge.textContent = l.opening ? "جرد افتتاحي" : l.variance < 0 ? `ناقص ${qty(Math.abs(l.variance))}` : l.variance > 0 ? `زائد ${qty(l.variance)}` : "مطابق";
        tr.append(
          cell(l.date),
          cell(l.itemName),
          cell(`${qty(l.book)} ${l.unit}`),
          cell(`${qty(l.counted)} ${l.unit}`),
          cell(badge),
          cell(l.opening ? "—" : formatMoney(Math.abs(l.value))),
          cell(l.previousCount ? `${qty(l.consumption)} ${l.unit}` : "—"),
          cell(l.percentOfConsumption === null ? "—" : `${l.percentOfConsumption}٪`),
          cell(l.previousCount ?? "أول جرد"),
        );
        return tr;
      }),
    );
  el("var-empty").hidden = lines.length > 0;
}

export function initVariance() {
  el("var-load").addEventListener("click", loadVariance);
  el("var-filter").addEventListener("change", loadVariance);
  enhanceTables(el("var-card"));
}
