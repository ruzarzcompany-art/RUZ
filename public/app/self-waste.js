/**
 * تسجيل الهدر من تطبيق الموظف: صنف من قائمة المخزون + كمية + سبب.
 * التسجيل يبقى «بانتظار الاعتماد»، ولا يُخصم من المخزون إلا بعد اعتماد المسؤول.
 */

import { api, el, setAlert, setBusy } from "./api.js";

const state = { ready: false, items: [] };
const NONE = "__none__";

function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

function fillItems() {
  const category = el("waste-category").value;
  const list = state.items.filter((i) => (category === "" ? true : (i.category || NONE) === category));
  el("waste-item").replaceChildren(option("", "— اختر الصنف —"), ...list.map((i) => option(String(i.id), `${i.name} (${i.unit})`)));
  showUnit();
}

function showUnit() {
  const item = state.items.find((i) => String(i.id) === el("waste-item").value);
  el("waste-qty-label").textContent = item ? `الكمية (${item.unit})` : "الكمية";
}

function entryRow(e) {
  const tr = document.createElement("tr");
  const tone = e.status === "approved" ? "badge--ok" : e.status === "rejected" ? "badge--disputed" : "badge--warn";
  const cells = [e.businessDate, e.itemName, `${e.quantity} ${e.unit}`, e.reasonLabel];
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = c;
    tr.append(td);
  }
  const td = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${tone}`;
  badge.textContent = e.status === "approved" ? "معتمد" : e.status === "rejected" ? `مرفوض${e.reviewNote ? `: ${e.reviewNote}` : ""}` : "بانتظار الاعتماد";
  td.append(badge);
  tr.append(td);
  return tr;
}

export async function refreshSelfWaste() {
  if (!state.items.length) {
    const res = await api("/waste/items");
    if (!res.ok) return setAlert(el("waste-alert"), res.error ?? "تعذّر تحميل الأصناف", "error");
    state.items = res.items;
    const categories = [...new Set(res.items.map((i) => i.category || NONE))];
    el("waste-category").replaceChildren(option("", "كل التصنيفات"), ...categories.map((c) => option(c, c === NONE ? "بدون تصنيف" : c)));
    el("waste-reason").replaceChildren(option("", "— اختر السبب —"), ...Object.entries(res.reasons).map(([k, v]) => option(k, v)));
    fillItems();
  }
  const mine = await api("/waste/mine");
  const rows = mine.ok ? mine.entries ?? [] : [];
  el("waste-mine").querySelector("tbody").replaceChildren(...rows.map(entryRow));
  el("waste-mine-empty").hidden = rows.length > 0;
}

async function submit(event) {
  event.preventDefault();
  const button = el("waste-submit");
  setBusy(button, true);
  const res = await api("/waste", {
    method: "POST",
    body: {
      itemId: Number(el("waste-item").value) || undefined,
      quantity: Number(el("waste-qty").value || 0),
      reason: el("waste-reason").value,
      station: el("waste-station").value,
      notes: el("waste-notes").value.trim(),
    },
  });
  setBusy(button, false);
  setAlert(el("waste-alert"), res.ok ? res.message : res.error ?? "تعذّر تسجيل الهدر", res.ok ? "ok" : "error");
  if (!res.ok) return;
  el("waste-qty").value = "";
  el("waste-notes").value = "";
  el("waste-item").value = "";
  showUnit();
  await refreshSelfWaste();
}

export function initSelfWaste() {
  if (state.ready) return;
  state.ready = true;
  el("waste-form").addEventListener("submit", submit);
  el("waste-category").addEventListener("change", fillItems);
  el("waste-item").addEventListener("change", showUnit);
}
