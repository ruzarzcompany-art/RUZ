/**
 * المالية ← «البنك والمطابقة».
 *
 * كشف البنك (Excel/CSV) يُقرأ هنا في المتصفح بمكتبة SheetJS، وتُرسل حركاته
 * فقط إلى الخادم. بعدها تُثبَّت أسماء الجهات مرة واحدة، فيطابق الخادم
 * الإيداعات بمستحقات فوديكس والتحويلات بمشتريات الموردين.
 */

import { api, el, formatMoney, setAlert, setBusy, todayIso } from "../api.js";

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs";
const state = { can: () => false, data: null, branchId: () => "" };

const money = (v) => (v === null || v === undefined ? "—" : formatMoney(v));
const alertBox = () => el("fh-alert");

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "className") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
  return node;
}

function badge(text, tone = "") {
  return h("span", { className: `badge ${tone}` }, text);
}

function tile(label, value, tone = "", note = "") {
  return h(
    "div",
    { className: `fin-tile${tone ? ` fin-tile--${tone}` : ""}` },
    h("span", { className: "fin-tile__label" }, label),
    h("strong", { className: "fin-tile__value" }, value),
    note ? h("span", { className: "fin-tile__note" }, note) : null,
  );
}

function table(headers, rows) {
  return h(
    "div",
    { className: "table-wrap" },
    h("table", { className: "table" }, h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))), h("tbody", {}, rows)),
  );
}

function diffBadge(diff, expected) {
  if (!expected && !diff) return badge("—");
  if (Math.abs(diff) < 0.01) return badge("مطابق", "badge--ok");
  return badge(`${diff < 0 ? "ناقص" : "زائد"} ${formatMoney(Math.abs(diff))}`, diff < 0 ? "badge--disputed" : "badge--warn");
}

/* ── قراءة ملف البنك ─────────────────────────────────────────── */

function toIsoDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

const num = (v) => {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,\s]/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** يجد صف العناوين (Date/التاريخ، Credit/دائن ...) ثم يقرأ الحركات تحته. */
function rowsFromSheet(matrix) {
  const find = (cells, words) => cells.findIndex((c) => words.some((w) => String(c ?? "").trim().toLowerCase() === w));
  let header = -1;
  let col = {};
  for (let i = 0; i < Math.min(matrix.length, 40); i++) {
    const cells = matrix[i] ?? [];
    const date = find(cells, ["date", "التاريخ", "تاريخ العملية", "transaction date"]);
    const credit = find(cells, ["credit", "دائن", "إيداع", "ايداع"]);
    const debit = find(cells, ["debit", "مدين", "سحب"]);
    if (date >= 0 && credit >= 0 && debit >= 0) {
      header = i;
      col = {
        date,
        credit,
        debit,
        desc: find(cells, ["description", "الوصف", "البيان", "details"]),
        balance: find(cells, ["balance", "الرصيد"]),
      };
    }
    if (header >= 0 && i > header) break;
  }
  if (header < 0) throw new Error("لم أجد أعمدة (التاريخ، دائن، مدين) في الملف.");
  const out = [];
  for (const r of matrix.slice(header + 1)) {
    const date = toIsoDate(r?.[col.date]);
    if (!date) continue;
    const credit = Math.abs(num(r[col.credit]));
    const debit = Math.abs(num(r[col.debit]));
    if (!credit && !debit) continue;
    out.push({
      date,
      description: col.desc >= 0 ? String(r[col.desc] ?? "") : "",
      credit,
      debit,
      balance: col.balance >= 0 ? num(r[col.balance]) : null,
    });
  }
  return out;
}

async function readBankFile(file) {
  const XLSX = await import(XLSX_URL);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  let rows = [];
  let lastError = null;
  for (const name of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    try {
      rows = rows.concat(rowsFromSheet(matrix));
    } catch (e) {
      lastError = e;
    }
  }
  if (!rows.length) throw lastError ?? new Error("الملف لا يحوي حركات.");
  return rows;
}

async function upload(event) {
  event.preventDefault();
  const input = el("bank-file");
  const file = input.files?.[0];
  if (!file) return setAlert(alertBox(), "اختر ملف كشف البنك أولاً.", "error");
  if (/\.pdf$/i.test(file.name)) return setAlert(alertBox(), "ملف PDF لا يُقرأ هنا بعد — صدّر الكشف من البنك بصيغة Excel.", "error");
  const button = event.target.querySelector("button[type=submit]");
  setBusy(button, true);
  try {
    const rows = await readBankFile(file);
    const res = await api("/bank/import", { method: "POST", body: { branchId: state.branchId(), rows, fileName: file.name } });
    setAlert(alertBox(), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
    if (res.ok) {
      input.value = "";
      if (res.from) el("bank-from").value = res.from;
      if (res.to) el("bank-to").value = res.to;
      await loadBank();
    }
  } catch (e) {
    setAlert(alertBox(), `تعذّر قراءة الملف: ${e.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

/* ── العرض ─────────────────────────────────────────────────────── */

function partiesCard(d) {
  const cats = d.categoryLabels;
  const listId = (k) => `bank-names-${k}`;
  const datalists = [
    h("datalist", { id: listId("sales") }, d.methodNames.map((n) => h("option", { value: n }))),
    h("datalist", { id: listId("supplier") }, d.supplierNames.map((n) => h("option", { value: n }))),
  ];
  const editable = state.can("settlements.manage");
  const rows = d.parties.map((p) => {
    const cat = h(
      "select",
      { disabled: !editable },
      Object.entries(cats).map(([k, v]) => h("option", { value: k, selected: k === p.rule.category }, v)),
    );
    const name = h("input", { type: "text", value: p.rule.mappedName, placeholder: "الاسم المطابق", disabled: !editable });
    const lag = h("input", { type: "number", min: "0", max: "30", step: "1", value: String(p.rule.lagDays), style: "width:4.5em", disabled: !editable });
    const sync = () => {
      const c = cat.value;
      name.hidden = !(c === "sales_provider" || c === "supplier");
      lag.hidden = c !== "sales_provider";
      name.setAttribute("list", c === "sales_provider" ? listId("sales") : listId("supplier"));
      name.placeholder = c === "sales_provider" ? "طريقة الدفع في فوديكس" : "اسم المورد";
    };
    cat.addEventListener("change", sync);
    sync();
    const tr = h(
      "tr",
      {},
      h("td", {}, p.counterparty),
      h("td", {}, p.direction === "in" ? badge("وارد", "badge--ok") : badge("صادر")),
      h("td", {}, String(p.count)),
      h("td", {}, money(p.total)),
      h("td", {}, cat),
      h("td", {}, name),
      h("td", {}, lag),
      h("td", {}, p.rule.confirmed ? badge("مثبّت", "badge--ok") : badge("مقترح", "badge--warn")),
    );
    tr._rule = () => ({ counterparty: p.counterparty, category: cat.value, mappedName: name.hidden ? "" : name.value.trim(), lagDays: Number(lag.value) || 0 });
    return tr;
  });
  const save = h("button", { type: "button", className: "btn btn--primary btn--sm" }, "تثبيت الأسماء");
  save.addEventListener("click", async () => {
    setBusy(save, true);
    const res = await api("/bank/rules", { method: "PUT", body: { branchId: state.branchId(), rules: rows.map((r) => r._rule()) } });
    setBusy(save, false);
    setAlert(alertBox(), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
    if (res.ok) await loadBank();
  });
  return h(
    "section",
    { className: "card" },
    h("h3", { className: "card__title card__title--sm" }, `تثبيت الجهات (${d.totals.unconfirmed} بانتظار التثبيت)`),
    h(
      "p",
      { className: "hint" },
      "راجع البند والاسم المقترح لكل جهة ثم اضغط «تثبيت الأسماء» مرة واحدة؛ الكشوف القادمة توزَّع تلقائياً. مهلة الوصول = بعد كم يوم يصل مبلغ اليوم للبنك (1 لفودكس باي والشبكة، 0 للتطبيقات التي تحوّل على دفعات).",
    ),
    datalists,
    table(["الجهة في كشف البنك", "الاتجاه", "عدد", "المبلغ", "البند", "الاسم المطابق", "مهلة الوصول (يوم)", "الحالة"], rows),
    editable ? h("div", { className: "row" }, save) : null,
  );
}

function salesCard(d) {
  const detail = h("div");
  const rows = d.sales.map((s) =>
    h(
      "tr",
      {},
      h("td", {}, s.provider),
      h("td", {}, s.senders.length ? s.senders.join("، ") : badge("لا توجد جهة في البنك", "badge--warn")),
      h("td", {}, money(s.expected)),
      h("td", {}, money(s.received)),
      h("td", {}, diffBadge(s.difference, s.expected)),
      h("td", {}, s.feeRate === null ? "—" : `${s.feeRate}%`),
      h(
        "td",
        {},
        s.days.length || s.deposits.length
          ? h("button", { type: "button", className: "btn btn--ghost btn--xs", onclick: () => showSalesDetail(detail, s) }, "تفاصيل")
          : "",
      ),
    ),
  );
  return h(
    "section",
    { className: "card" },
    h("h3", { className: "card__title card__title--sm" }, "مطابقة المبيعات: مستحقات فوديكس ↔ الإيداعات"),
    d.firstSalesDay && d.firstSalesDay > d.from
      ? h("p", { className: "hint" }, `فواتير فوديكس المحفوظة تبدأ من ${d.firstSalesDay}؛ ما قبله يظهر «ناقص» لأن المستحق صفر. اسحب الفواتير السابقة من «الرقابة ← فواتير فوديكس» لتكتمل المطابقة.`)
      : null,
    table(["طريقة الدفع (فوديكس)", "الجهة في البنك", "المستحق", "الواصل", "الفرق", "العمولة", ""], rows),
    h("p", { className: "hint" }, "الفرق السالب الصغير (نحو 1–2٪) عمولة الجهة عادةً؛ الفرق الكبير أو يوم بلا إيداع يحتاج مراجعة. التطبيقات تحوّل على دفعات، فتُقارن بمجموع الفترة."),
    detail,
  );
}

function showSalesDetail(box, s) {
  const parts = [h("h4", { className: "card__title card__title--xs" }, `تفاصيل ${s.provider}`)];
  if (s.days.length) {
    parts.push(
      table(
        ["يوم المبيعات", "المستحق", "يوم الإيداع", "الواصل", "الفرق", "العمولة"],
        s.days.map((r) =>
          h(
            "tr",
            {},
            h("td", {}, r.salesDate),
            h("td", {}, money(r.expected)),
            h("td", {}, r.depositDate),
            h("td", {}, money(r.received)),
            h("td", {}, diffBadge(r.difference, r.expected)),
            h("td", {}, r.feeRate === null ? "—" : `${r.feeRate}%`),
          ),
        ),
      ),
    );
  } else {
    parts.push(table(["تاريخ الإيداع", "المبلغ"], s.deposits.map((x) => h("tr", {}, h("td", {}, x.date), h("td", {}, money(x.amount))))));
  }
  box.replaceChildren(...parts);
}

/* ── مطابقة المشتريات: مربع بفلاتر (مورد، مدة، تاريخ، مبلغ) وطباعة ── */

const pur = { filters: { supplier: "", kind: "", period: "", from: "", to: "", min: "", max: "" }, size: 10, page: 1 };

function isoShift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** حدود «المدة» السريعة داخل الفترة المعروضة. */
function periodBounds(period, d) {
  const today = todayIso();
  if (period === "7") return [isoShift(today, -6), today];
  if (period === "30") return [isoShift(today, -29), today];
  if (period === "month") return [`${today.slice(0, 8)}01`, today];
  if (period === "prev") {
    const first = new Date(`${today.slice(0, 8)}01T12:00:00Z`);
    const lastPrev = new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10);
    return [`${lastPrev.slice(0, 8)}01`, lastPrev];
  }
  return [d.from, d.to];
}

function filteredPurchases(d) {
  const f = pur.filters;
  const [pFrom, pTo] = periodBounds(f.period, d);
  const from = f.from || pFrom;
  const to = f.to || pTo;
  const min = f.min === "" ? null : Number(f.min);
  const max = f.max === "" ? null : Number(f.max);
  const lines = (d.purchaseLines ?? []).filter(
    (l) =>
      (!f.supplier || l.supplier === f.supplier) &&
      (!f.kind || l.kind === f.kind) &&
      (!from || !l.date || l.date >= from) &&
      (!to || !l.date || l.date <= to) &&
      (min === null || l.amount >= min) &&
      (max === null || l.amount <= max),
  );
  const map = new Map();
  for (const l of lines) {
    const s = map.get(l.supplier) ?? { supplier: l.supplier, invoices: 0, invoiceCount: 0, paid: 0, payments: 0 };
    if (l.kind === "invoice") {
      s.invoices += l.amount;
      s.invoiceCount++;
    } else {
      s.paid += l.amount;
      s.payments++;
    }
    map.set(l.supplier, s);
  }
  const summary = [...map.values()]
    .map((s) => ({ ...s, invoices: Math.round(s.invoices * 100) / 100, paid: Math.round(s.paid * 100) / 100, difference: Math.round((s.paid - s.invoices) * 100) / 100 }))
    .sort((a, b) => Math.max(b.invoices, b.paid) - Math.max(a.invoices, a.paid));
  return { lines, summary, from, to };
}

function purchaseResult(s) {
  if (!s.invoiceCount) return badge("دفعة بلا فاتورة مسجّلة", "badge--warn");
  if (!s.payments) return badge("فاتورة لم تُدفع من البنك", "");
  return diffBadge(s.difference, s.invoices);
}

function printPurchases(d) {
  const { lines, summary, from, to } = filteredPurchases(d);
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const f = pur.filters;
  const totalInv = summary.reduce((a, s) => a + s.invoices, 0);
  const totalPaid = summary.reduce((a, s) => a + s.paid, 0);
  const resultText = (s) => (!s.invoiceCount ? "دفعة بلا فاتورة" : !s.payments ? "لم تُدفع من البنك" : Math.abs(s.difference) < 0.01 ? "مطابق" : `${s.difference < 0 ? "ناقص" : "زائد"} ${money(Math.abs(s.difference))}`);
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>مطابقة المشتريات</title>
<style>@page{size:A4;margin:12mm}body{font-family:Tahoma,Arial,sans-serif;color:#111}h1{font-size:18px;margin:0 0 4px}h3{font-size:14px;margin:16px 0 6px}.meta{font-size:12px;color:#444}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #999;padding:4px;text-align:right}th{background:#eee}tfoot td{font-weight:bold;background:#f6f6f6}</style></head>
<body><h1>مطابقة المشتريات: فواتير الموردين ↔ التحويلات</h1>
<div class="meta">الفترة ${esc(from)} إلى ${esc(to)}${f.supplier ? ` · المورد: ${esc(f.supplier)}` : " · كل الموردين"}${f.kind ? ` · ${f.kind === "invoice" ? "الفواتير فقط" : "التحويلات فقط"}` : ""}${f.min !== "" ? ` · من مبلغ ${esc(f.min)}` : ""}${f.max !== "" ? ` · إلى مبلغ ${esc(f.max)}` : ""}</div>
<h3>الملخّص حسب المورد</h3>
<table><thead><tr><th>المورد</th><th>الفواتير</th><th>العدد</th><th>المدفوع من البنك</th><th>العدد</th><th>النتيجة</th></tr></thead>
<tbody>${summary.map((s) => `<tr><td>${esc(s.supplier)}</td><td>${esc(money(s.invoices))}</td><td>${s.invoiceCount}</td><td>${esc(money(s.paid))}</td><td>${s.payments}</td><td>${esc(resultText(s))}</td></tr>`).join("") || '<tr><td colspan="6">لا نتائج.</td></tr>'}</tbody>
<tfoot><tr><td>الإجمالي</td><td>${esc(money(totalInv))}</td><td></td><td>${esc(money(totalPaid))}</td><td></td><td>${esc(money(totalPaid - totalInv))}</td></tr></tfoot></table>
<h3>التفصيل (${lines.length} سطر)</h3>
<table><thead><tr><th>التاريخ</th><th>المورد</th><th>النوع</th><th>المبلغ</th><th>المرجع</th><th>المصدر</th></tr></thead>
<tbody>${lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.supplier)}</td><td>${l.kind === "invoice" ? "فاتورة" : "تحويل"}</td><td>${esc(money(l.amount))}</td><td>${esc(l.reference)}</td><td>${esc(l.source)}</td></tr>`).join("") || '<tr><td colspan="6">لا نتائج.</td></tr>'}</tbody></table>
<script>window.onload=()=>window.print()</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return setAlert(alertBox(), "اسمح بالنوافذ المنبثقة للطباعة.", "warn");
  w.document.write(html);
  w.document.close();
}

function purchasesCard(d) {
  const card = h("section", { className: "card" });
  const f = pur.filters;
  const suppliers = [...new Set((d.purchaseLines ?? []).map((l) => l.supplier))].sort((a, b) => a.localeCompare(b, "ar"));
  if (f.supplier && !suppliers.includes(f.supplier)) f.supplier = "";

  const field = (label, control) => h("label", { className: "field field--sm" }, h("span", { className: "field__label" }, label), control);
  const select = (key, options) => {
    const node = h("select", {}, options.map(([value, text]) => h("option", { value }, text)));
    node.value = f[key];
    node.addEventListener("change", () => {
      f[key] = node.value;
      if (key === "period") {
        f.from = "";
        f.to = "";
      }
      pur.page = 1;
      draw();
    });
    return node;
  };
  const input = (key, type, attrs = {}) => {
    const node = h("input", { type, ...attrs });
    node.value = f[key];
    node.addEventListener("change", () => {
      f[key] = node.value;
      pur.page = 1;
      draw();
    });
    return node;
  };

  const body = h("div", {});
  function draw() {
    const { lines, summary, from, to } = filteredPurchases(d);
    const totalInv = summary.reduce((a, s) => a + s.invoices, 0);
    const totalPaid = summary.reduce((a, s) => a + s.paid, 0);
    const last = Math.max(1, Math.ceil(lines.length / pur.size));
    pur.page = Math.min(Math.max(1, pur.page), last);
    const start = (pur.page - 1) * pur.size;
    const sizeSelect = h("select", { className: "pager__select" }, [5, 10, 25, 100].map((n) => h("option", { value: String(n) }, String(n))));
    sizeSelect.value = String(pur.size);
    sizeSelect.addEventListener("change", () => {
      pur.size = Number(sizeSelect.value);
      pur.page = 1;
      draw();
    });
    const nav = (text, step, disabled) => h("button", { type: "button", className: "btn btn--ghost btn--xs pager__nav", disabled, onClick: () => ((pur.page += step), draw()) }, text);
    body.replaceChildren(
      h("p", { className: "hint" }, `المعروض: ${from} إلى ${to}${f.supplier ? ` — ${f.supplier}` : ""}`),
      h(
        "div",
        { className: "fin-tiles" },
        tile("الفواتير", money(totalInv), "", `${lines.filter((l) => l.kind === "invoice").length} فاتورة`),
        tile("المدفوع من البنك", money(totalPaid), "", `${lines.filter((l) => l.kind === "payment").length} تحويل`),
        tile("الفرق", money(Math.abs(totalPaid - totalInv)), totalPaid - totalInv < -0.01 ? "warn" : "good", totalPaid - totalInv < -0.01 ? "فواتير لم تُدفع بعد من البنك" : totalPaid - totalInv > 0.01 ? "مدفوع أكثر من الفواتير المسجّلة" : "مطابق"),
        tile("الموردون", String(summary.length)),
      ),
      table(
        ["المورد", "الفواتير (العدد)", "المدفوع من البنك (العدد)", "النتيجة"],
        summary.map((s) =>
          h(
            "tr",
            {},
            h("td", {}, h("button", { type: "button", className: "btn btn--ghost btn--xs", title: "عرض هذا المورد فقط", onClick: () => ((f.supplier = f.supplier === s.supplier ? "" : s.supplier), (pur.page = 1), rebuild()) }, s.supplier)),
            h("td", {}, s.invoiceCount ? `${money(s.invoices)} (${s.invoiceCount})` : "—"),
            h("td", {}, s.payments ? `${money(s.paid)} (${s.payments})` : "—"),
            h("td", {}, purchaseResult(s)),
          ),
        ),
      ),
      h("h3", { className: "card__title card__title--xs" }, `تفصيل الفواتير والتحويلات (${lines.length} سطر)`),
      table(
        ["التاريخ", "المورد", "النوع", "المبلغ", "المرجع", "المصدر"],
        lines.slice(start, start + pur.size).map((l) =>
          h("tr", {}, h("td", {}, l.date || "—"), h("td", {}, l.supplier), h("td", {}, badge(l.kind === "invoice" ? "فاتورة" : "تحويل", l.kind === "invoice" ? "" : "badge--ok")), h("td", {}, money(l.amount)), h("td", {}, l.reference || "—"), h("td", {}, l.source)),
        ),
      ),
      lines.length
        ? h(
            "div",
            { className: "pager" },
            h("span", { className: "pager__range" }, `${start + 1}–${Math.min(lines.length, start + pur.size)} من ${lines.length}`),
            h("div", { className: "pager__pages" }, nav("السابق", -1, pur.page <= 1), nav("التالي", 1, pur.page >= last)),
            h("label", { className: "pager__size" }, h("span", {}, "عدد السطور"), sizeSelect),
          )
        : h("p", { className: "empty" }, "لا فواتير ولا تحويلات بهذه الفلاتر."),
    );
  }
  function rebuild() {
    card.replaceWith(purchasesCard(d));
  }

  card.append(
    h("h3", { className: "card__title card__title--sm" }, "مطابقة المشتريات: فواتير الموردين ↔ التحويلات"),
    h(
      "div",
      { className: "row row--wrap" },
      field("المورد", select("supplier", [["", "كل الموردين"], ...suppliers.map((x) => [x, x])])),
      field("النوع", select("kind", [["", "فواتير وتحويلات"], ["invoice", "الفواتير فقط"], ["payment", "التحويلات فقط"]])),
      field("المدة", select("period", [["", "كل الفترة المعروضة"], ["7", "آخر 7 أيام"], ["30", "آخر 30 يوماً"], ["month", "هذا الشهر"], ["prev", "الشهر الماضي"]])),
      field("من تاريخ", input("from", "date")),
      field("إلى تاريخ", input("to", "date")),
      field("المبلغ من", input("min", "number", { min: "0", step: "any", placeholder: "0" })),
      field("المبلغ إلى", input("max", "number", { min: "0", step: "any" })),
      h("button", { type: "button", className: "btn btn--ghost btn--xs", onClick: () => ((pur.filters = { supplier: "", kind: "", period: "", from: "", to: "", min: "", max: "" }), (pur.page = 1), rebuild()) }, "مسح الفلاتر"),
      h("button", { type: "button", className: "btn btn--ghost btn--xs", onClick: () => printPurchases(d) }, "طباعة"),
    ),
    body,
    h("p", { className: "hint" }, "الفواتير من مشتريات فوديكس (بتاريخ الفاتورة) واستلام البضاعة غير النقدي، والتحويلات من كشف البنك. الفلاتر تعمل داخل الفترة المحمّلة أعلى الصفحة («من / إلى» ثم «عرض»). اكتب اسم المورد في «تثبيت الجهات» كما هو في الفواتير حتى تلتقي الدفعة بفاتورتها."),
  );
  draw();
  return card;
}

function categoriesCard(d) {
  return h(
    "section",
    { className: "card" },
    h("h3", { className: "card__title card__title--sm" }, "البنود"),
    table(
      ["البند", "وارد", "صادر", "عدد الحركات"],
      d.categories.map((c) => h("tr", {}, h("td", {}, c.label), h("td", {}, c.credit ? money(c.credit) : "—"), h("td", {}, c.debit ? money(c.debit) : "—"), h("td", {}, String(c.count)))),
    ),
  );
}

function transactionsCard(d) {
  const list = h("div");
  const filter = h(
    "select",
    {},
    h("option", { value: "" }, "كل البنود"),
    Object.entries(d.categoryLabels).map(([k, v]) => h("option", { value: k }, v)),
  );
  const render = () => {
    const items = d.transactions.filter((t) => !filter.value || t.category === filter.value);
    list.replaceChildren(
      table(
        ["التاريخ", "الجهة", "البند", "وارد", "صادر", "الرصيد"],
        items.map((t) =>
          h(
            "tr",
            { title: t.description },
            h("td", {}, t.date),
            h("td", {}, t.counterparty),
            h("td", {}, t.confirmed ? t.categoryLabel : `${t.categoryLabel} (مقترح)`),
            h("td", {}, t.credit ? money(t.credit) : ""),
            h("td", {}, t.debit ? money(t.debit) : ""),
            h("td", {}, money(t.balance)),
          ),
        ),
      ),
    );
  };
  filter.addEventListener("change", render);
  render();
  return h(
    "section",
    { className: "card" },
    h("div", { className: "card__head" }, h("h3", { className: "card__title card__title--sm" }, `حركات الكشف (${d.transactions.length})`), filter),
    list,
  );
}

export async function loadBank() {
  if (!el("bank-from").value) el("bank-from").value = `${todayIso().slice(0, 8)}01`;
  if (!el("bank-to").value) el("bank-to").value = todayIso();
  const q = new URLSearchParams({ from: el("bank-from").value, to: el("bank-to").value });
  if (state.branchId()) q.set("branchId", state.branchId());
  const box = el("bank-body");
  box.replaceChildren(h("p", { className: "hint" }, "جاري المطابقة…"));
  const res = await api(`/bank/reconcile?${q}`);
  if (!res.ok) {
    box.replaceChildren();
    setAlert(alertBox(), res.error ?? "تعذّر تحميل المطابقة", "error");
    return;
  }
  state.data = res;
  if (res.startDate && el("bank-from").value < res.startDate) el("bank-from").value = res.startDate;
  const t = res.totals;
  if (!t.transactions) {
    box.replaceChildren(h("p", { className: "empty" }, "لا حركات بنك في هذه الفترة — ارفع كشف الحساب أعلاه."));
    return;
  }
  const salesExpected = res.sales.reduce((s, x) => s + x.expected, 0);
  const salesReceived = res.sales.reduce((s, x) => s + x.received, 0);
  box.replaceChildren(
    res.startDate ? h("p", { className: "hint" }, `بداية الحسابات: ${res.startDate} — الحركات قبلها محفوظة ولا تدخل المطابقة.`) : null,
    h(
      "div",
      { className: "fin-tiles" },
      tile("الوارد", money(t.credits), "", `${t.transactions} حركة`),
      tile("الصادر", money(t.debits)),
      tile("الرصيد في آخر الفترة", money(t.closingBalance)),
      tile("مستحقات فوديكس", money(salesExpected), "", `الواصل منها ${formatMoney(salesReceived)}`),
      tile("جهات بانتظار التثبيت", String(t.unconfirmed), t.unconfirmed ? "bad" : "good"),
    ),
    partiesCard(res),
    salesCard(res),
    purchasesCard(res),
    categoriesCard(res),
    transactionsCard(res),
  );
}

async function removePeriod(button) {
  const from = el("bank-from").value;
  const to = el("bank-to").value;
  if (!confirm(`حذف حركات البنك من ${from} إلى ${to}؟ (أسماء الجهات المثبّتة تبقى)`)) return;
  setBusy(button, true);
  const q = new URLSearchParams({ from, to });
  if (state.branchId()) q.set("branchId", state.branchId());
  const res = await api(`/bank/transactions?${q}`, { method: "DELETE" });
  setBusy(button, false);
  setAlert(alertBox(), res.ok ? res.message : res.error, res.ok ? "ok" : "error");
  if (res.ok) await loadBank();
}

export function initBankPanel({ can, branchId }) {
  state.can = can;
  state.branchId = branchId;
  el("bank-upload-form").addEventListener("submit", upload);
  el("bank-load").addEventListener("click", loadBank);
  el("bank-delete").addEventListener("click", (e) => removePeriod(e.currentTarget));
  for (const node of document.querySelectorAll("[data-bank-manage]")) node.hidden = !can("settlements.manage");
}
