/**
 * الاستلام اليومي من تطبيق الموظف: مستندات الشراء والتحويل الواردة من فوديكس.
 * الموظف لا يكتب الكميات — يعدّ ثم يضغط «مطابق»، أو «يوجد فرق» ويكتب الواصل
 * فعلاً للصنف المختلف فقط. أي فرق يُبلَّغ للمالك.
 */

import { api, el, formatMoney, setAlert, setBusy } from "./api.js";

const qty = (v) => String(Math.round(Number(v || 0) * 1000) / 1000);

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function docCard(d) {
  const card = make("article", "dc-card");
  const head = make("div", "card__head");
  head.append(
    make("h3", "card__title card__title--xs", `${d.kindLabel} رقم ${d.reference}`),
    make("span", `badge ${d.state === "received" ? "badge--warn" : ""}`, d.state === "received" ? "مستلم في فوديكس — أكّده" : "متوقّع وصوله"),
  );
  card.append(head, make("p", "hint", [d.party, d.businessDate, d.total ? `القيمة ${formatMoney(d.total)}` : ""].filter(Boolean).join(" · ")));

  const list = make("div", "dc-figures");
  const inputs = [];
  for (const l of d.items) {
    const expected = l.received || l.ordered;
    const row = make("div", "dc-row");
    row.append(make("span", "", l.name), make("span", "", `${qty(expected)} ${l.unit}`));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.001";
    input.inputMode = "decimal";
    input.placeholder = "الواصل فعلاً";
    input.hidden = true;
    input.className = "rcv-actual";
    inputs.push({ line: l, expected, input });
    list.append(row, input);
  }
  card.append(list);

  const note = document.createElement("input");
  note.type = "text";
  note.maxLength = 500;
  note.placeholder = "ملاحظة (اختياري)";
  note.hidden = true;

  const ok = make("button", "btn btn--primary", "مطابق ✓");
  ok.type = "button";
  const diff = make("button", "btn btn--ghost", "يوجد فرق");
  diff.type = "button";
  const send = make("button", "btn btn--primary", "إرسال الفروق");
  send.type = "button";
  send.hidden = true;

  const submit = async (button, diffs) => {
    setBusy(button, true);
    const res = await api(`/stock/docs/${d.id}/confirm`, { method: "POST", body: { diffs, note: note.value.trim() } });
    setBusy(button, false);
    setAlert(el("rcv-alert"), res.ok ? res.message : res.error, res.ok ? (diffs.length ? "warn" : "ok") : "error");
    if (res.ok) await refreshSelfReceive();
  };

  ok.addEventListener("click", () => {
    if (window.confirm(`تأكيد أن ${d.kindLabel} رقم ${d.reference} وصل كاملاً ومطابقاً لفوديكس؟`)) submit(ok, []);
  });
  diff.addEventListener("click", () => {
    for (const x of inputs) x.input.hidden = false;
    note.hidden = false;
    send.hidden = false;
    ok.hidden = true;
    diff.hidden = true;
    inputs[0]?.input.focus();
  });
  send.addEventListener("click", () => {
    const diffs = inputs
      .filter((x) => x.input.value !== "" && Number(x.input.value) !== Number(x.expected))
      .map((x) => ({ sku: x.line.sku, name: x.line.name, actual: Number(x.input.value) }));
    if (!diffs.length) {
      setAlert(el("rcv-alert"), "اكتب الكمية الواصلة فعلاً للأصناف المختلفة فقط (اترك المطابق فارغاً).", "error");
      return;
    }
    submit(send, diffs);
  });

  const actions = make("div", "row row--wrap");
  actions.append(ok, diff, send);
  card.append(note, actions);
  return card;
}

export async function refreshSelfReceive() {
  const res = await api("/stock/mine");
  const box = el("rcv-mine");
  if (!res.ok || !res.available) {
    box.replaceChildren();
    el("rcv-mine-empty").hidden = false;
    return;
  }
  box.replaceChildren(...res.docs.map(docCard));
  el("rcv-mine-empty").hidden = res.docs.length > 0;
}
