/**
 * ملخّص المالية — أول ما يراه المالك أو المحاسب: مبيعات اليوم والشهر، فرق الصندوق،
 * ما يحتاج انتباهاً (أيام بلا تقفيل، تقفيلات تنتظر المراجعة، مبالغ لم تُحوَّل)،
 * ثم التفاصيل. كل الأرقام من التقفيلات والمصاريف والتسويات المحفوظة.
 */
import { api, currentMonthKey, formatMoney } from "../api.js";

const el = (id) => document.getElementById(id);
let goTo = () => {};

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

function attention(text, tone, action) {
  const row = document.createElement("div");
  row.className = `fin-attn fin-attn--${tone}`;
  const span = document.createElement("span");
  span.textContent = text;
  row.append(span);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--ghost btn--xs";
    button.textContent = action.label;
    button.addEventListener("click", () => goTo(action.panel));
    row.append(button);
  }
  return row;
}

function table(headers, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const node = document.createElement("table");
  node.className = "table";
  const head = node.createTHead().insertRow();
  for (const text of headers) {
    const th = document.createElement("th");
    th.textContent = text;
    head.append(th);
  }
  const body = node.createTBody();
  for (const cells of rows) {
    const tr = body.insertRow();
    for (const text of cells) tr.insertCell().textContent = text;
  }
  wrap.append(node);
  return wrap;
}

const shortDate = (iso) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;
const percent = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

function render(data) {
  const t = data.totals;
  const today = data.todayFigures;

  el("fh-today").replaceChildren(
    tile("مبيعات اليوم", today.closings ? formatMoney(today.sales) : "لا أرقام بعد", today.closings ? "" : "warn"),
    tile(
      "فرق الصندوق اليوم",
      today.closings ? formatMoney(today.difference) : "—",
      today.difference < 0 ? "bad" : today.closings ? "good" : "",
      today.difference < 0 ? "عجز" : today.difference > 0 ? "زيادة" : today.closings ? "مطابق" : "",
    ),
    tile("مصاريف ومشتريات اليوم", formatMoney(today.expenses)),
  );

  el("fh-month").replaceChildren(
    tile("مبيعات الشهر", formatMoney(t.sales), "", `متوسط اليوم ${formatMoney(t.averageDailySales)}`),
    tile("نقد", formatMoney(t.cashSales), "", percent(t.cashSales, t.sales)),
    tile("شبكة", formatMoney(t.cardSales), "", percent(t.cardSales, t.sales)),
    tile("تطبيقات التوصيل", formatMoney(t.deliverySales), "", percent(t.deliverySales, t.sales)),
    tile("المصاريف والمشتريات النقدية", formatMoney(t.expenses), "", percent(t.expenses, t.sales) + " من المبيعات"),
    tile("النقد المتبقي في الصندوق", formatMoney(t.remainingCash), t.remainingCash < 0 ? "bad" : "good", "النقد − المصاريف"),
    tile("عجز الصندوق", formatMoney(t.shortage), t.shortage > 0 ? "bad" : "good"),
    tile("زيادة الصندوق", formatMoney(t.surplus), t.surplus > 0 ? "warn" : ""),
    tile("الخصومات والمرتجعات", formatMoney(t.discounts + t.refunds), "", percent(t.discounts + t.refunds, t.sales) + " من المبيعات"),
  );

  const attn = el("fh-attention");
  attn.replaceChildren();
  if (t.closings === 0) {
    attn.append(attention("لا تقفيلات في هذا الشهر بعد — تُنشأ آلياً من فوديكس بعد ربطه", "warn", { label: "تقفيل اليوم", panel: "fin:close" }));
  } else if (data.missingDays.length) {
    const list = data.missingDays.slice(0, 10).map(shortDate).join("، ");
    attn.append(
      attention(
        `${data.missingDays.length} يوم بلا تقفيل: ${list}${data.missingDays.length > 10 ? " …" : ""}`,
        "bad",
        { label: "تقفيل اليوم", panel: "fin:close" },
      ),
    );
  }
  if (t.awaitingCash) {
    attn.append(attention(`${t.awaitingCash} يوم لم يؤكّد الكاشير نقده بعد`, "bad", { label: "تقفيل اليوم", panel: "fin:close" }));
  }
  if (t.pendingReview) {
    attn.append(attention(`${t.pendingReview} تقفيلة تنتظر مراجعتك`, "warn", { label: "راجِع", panel: "fin:close" }));
  }
  if (t.shortage > 0) attn.append(attention(`عجز الصندوق هذا الشهر ${formatMoney(t.shortage)} — التفصيل حسب الكاشير بالأسفل`, "bad"));
  if (data.receivablesTotal.outstanding > 0) {
    attn.append(
      attention(
        `${formatMoney(data.receivablesTotal.outstanding)} لم تُحوَّل بعد من الشبكات وتطبيقات التوصيل`,
        "warn",
        { label: "التسويات", panel: "fin:settle" },
      ),
    );
  }
  if (!attn.children.length) attn.append(attention("✓ لا شيء يحتاج إجراء الآن", "good"));

  // مبيعات الأيام: أعمدة بسيطة، والأحمر يوم فيه عجز
  const chart = el("fh-chart");
  chart.replaceChildren();
  const max = Math.max(1, ...data.days.map((day) => day.sales));
  for (const day of data.days) {
    const bar = document.createElement("div");
    bar.className = `fin-bar${day.difference < 0 ? " fin-bar--bad" : ""}`;
    bar.style.height = `${Math.max(4, Math.round((day.sales / max) * 100))}%`;
    bar.title = `${shortDate(day.date)} — ${formatMoney(day.sales)}${day.difference ? ` — فرق ${formatMoney(day.difference)}` : ""}`;
    const label = document.createElement("span");
    label.textContent = String(Number(day.date.slice(8, 10)));
    bar.append(label);
    chart.append(bar);
  }
  el("fh-chart-empty").hidden = data.days.length > 0;

  const cashiers = el("fh-cashiers");
  cashiers.replaceChildren(
    data.cashiers.length
      ? table(
          ["الكاشير", "عدد التقفيلات", "العجز", "الزيادة"],
          data.cashiers.map((c) => [c.name, String(c.closings), formatMoney(c.shortage), formatMoney(c.surplus)]),
        )
      : Object.assign(document.createElement("p"), { className: "empty", textContent: "لا تقفيلات في هذا الشهر." }),
  );

  const receivables = el("fh-receivables");
  receivables.replaceChildren(
    data.receivables.length
      ? table(
          ["الجهة", "النوع", "المستحق", "المحوّل فعلاً", "لم يُحوَّل"],
          data.receivables.map((r) => [r.name, r.typeLabel, formatMoney(r.due), formatMoney(r.received), formatMoney(r.outstanding)]),
        )
      : Object.assign(document.createElement("p"), { className: "empty", textContent: "لا مبيعات شبكة أو توصيل مسجّلة لهذا الشهر." }),
  );
}

export async function refreshFinanceHome() {
  const branch = el("fh-branch").value;
  const month = el("fh-month-input").value || currentMonthKey();
  const alert = el("fh-alert");
  const res = await api(`/finance/overview?month=${month}${branch ? `&branchId=${branch}` : ""}`);
  alert.hidden = res.ok;
  if (!res.ok) {
    alert.textContent = res.error ?? "تعذّر تحميل الملخّص";
    alert.className = "alert alert--error";
    return;
  }
  render(res);
}

export function initFinanceHome({ openPanel }) {
  goTo = openPanel;
  el("fh-month-input").value = currentMonthKey();
  el("fh-branch").addEventListener("change", refreshFinanceHome);
  el("fh-month-input").addEventListener("change", refreshFinanceHome);
  el("fh-refresh").addEventListener("click", refreshFinanceHome);
}
