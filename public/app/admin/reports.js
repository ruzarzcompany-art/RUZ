/**
 * شاشة التقارير: الحضور والانصراف، الرواتب، السلف، الأوفرتايم، المكافآت،
 * الإجازات — مع تصفية بالفرع/الموظف/التاريخ، وتصدير CSV، وطباعة.
 *
 * الخادم يُرجع وصفاً موحّداً `{ columns, rows, summary }` فتُبنى كل التقارير
 * بنفس الشيفرة، والتصدير يستخدم نفس المسار مع `format=csv`.
 */

import {
  api,
  downloadFile,
  el,
  formatDate,
  formatDateTime,
  formatMoney,
  setAlert,
  setBusy,
} from "../api.js";

const REPORT_TITLES = {
  attendance: "تقرير الحضور والانصراف",
  payroll: "تقرير الرواتب",
  advances: "تقرير السلف",
  overtime: "تقرير الأوفرتايم",
  bonuses: "تقرير المكافآت",
  leaves: "تقرير الإجازات",
};

/** آخر تقرير مُحمَّل — يُستخدم للطباعة بلا إعادة استعلام. */
let current = null;

function filterQuery() {
  const params = new URLSearchParams();
  const branchId = el("report-branch").value;
  const employeeId = el("report-employee").value;
  const from = el("report-from").value;
  const to = el("report-to").value;

  if (branchId) params.set("branchId", branchId);
  if (employeeId) params.set("employeeId", employeeId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const query = params.toString();
  return query ? `?${query}` : "";
}

/** تنسيق خلية حسب نوع العمود المُعلَن من الخادم. */
function formatCell(value, type) {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "money") return formatMoney(value);
  if (type === "datetime") return formatDateTime(value);
  if (type === "date") return formatDate(value);
  if (type === "hours") return `${Number(value).toFixed(2)}`;
  if (type === "number") return String(value);
  return String(value);
}

function renderReport(payload) {
  current = payload;

  const table = el("report-table");
  const head = table.querySelector("thead tr");
  const body = table.querySelector("tbody");
  head.textContent = "";
  body.textContent = "";

  for (const column of payload.columns) {
    const cell = document.createElement("th");
    cell.textContent = column.label;
    head.append(cell);
  }

  for (const item of payload.rows) {
    const line = document.createElement("tr");
    for (const column of payload.columns) {
      const cell = document.createElement("td");
      cell.textContent = formatCell(item[column.key], column.type);
      line.append(cell);
    }
    body.append(line);
  }

  const summary = el("report-summary");
  summary.textContent = "";
  for (const item of payload.summary ?? []) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const strong = document.createElement("strong");
    strong.textContent = item.value;
    chip.append(document.createTextNode(`${item.label}: `), strong);
    summary.append(chip);
  }

  el("report-empty").hidden = payload.rows.length > 0;
}

export async function runReport() {
  const kind = el("report-kind").value;
  const run = el("report-run");

  setBusy(run, true);
  const result = await api(`/reports/${kind}${filterQuery()}`);
  setBusy(run, false);

  if (!result.ok) {
    setAlert(el("report-result"), result.error ?? "تعذّر تحميل التقرير", "error");
    return;
  }

  setAlert(el("report-result"), "");
  renderReport(result);

  if (result.filters?.scope === "own") {
    setAlert(el("report-result"), "التقرير محصور على بياناتك حسب صلاحياتك.", "warn");
  }
}

async function exportCsv() {
  const kind = el("report-kind").value;
  const query = filterQuery();
  const separator = query ? "&" : "?";
  const result = await downloadFile(
    `/reports/${kind}${query}${separator}format=csv`,
    `${kind}-${el("report-from").value || "all"}.csv`,
  );

  setAlert(
    el("report-result"),
    result.ok ? "تم تنزيل ملف CSV." : (result.error ?? "تعذّر التصدير"),
    result.ok ? "ok" : "error",
  );
}

/**
 * الطباعة: نبني صفحة مستقلة بالجدول الحالي في نافذة جديدة ثم نطبعها،
 * فلا تتأثر شاشة اللوحة ولا تحتاج قواعد طباعة خاصة.
 */
function printReport() {
  if (!current) {
    setAlert(el("report-result"), "اعرض التقرير أولاً ثم اطبعه.", "warn");
    return;
  }

  const window_ = window.open("", "_blank", "width=1024,height=768");
  if (!window_) {
    setAlert(el("report-result"), "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة.", "error");
    return;
  }

  const escape = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const filters = [
    el("report-branch").selectedOptions[0]?.textContent,
    el("report-employee").selectedOptions[0]?.textContent,
    el("report-from").value ? `من ${el("report-from").value}` : "",
    el("report-to").value ? `إلى ${el("report-to").value}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const header = current.columns.map((column) => `<th>${escape(column.label)}</th>`).join("");
  const rows = current.rows
    .map(
      (item) =>
        `<tr>${current.columns
          .map((column) => `<td>${escape(formatCell(item[column.key], column.type))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const summary = (current.summary ?? [])
    .map((item) => `<li>${escape(item.label)}: <strong>${escape(item.value)}</strong></li>`)
    .join("");

  window_.document.write(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>${escape(current.title ?? REPORT_TITLES[current.report] ?? "تقرير")}</title>
<style>
  body { font-family: "IBM Plex Sans Arabic", system-ui, sans-serif; padding: 16px; color: #1a180f; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.meta { font-size: 12px; color: #4a442f; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #cfc9b4; padding: 4px 6px; text-align: right; }
  th { background: #f2eee0; }
  ul { font-size: 12px; padding-inline-start: 18px; }
  @page { size: A4 landscape; margin: 12mm; }
</style></head>
<body>
  <h1>${escape(current.title ?? "تقرير")}</h1>
  <p class="meta">${escape(filters || "بلا تصفية")} — طُبع في ${escape(new Date().toLocaleString("ar"))}</p>
  <table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>
  <ul>${summary}</ul>
</body></html>`);
  window_.document.close();
  window_.focus();
  window_.print();
}

export function initReportsModule() {
  el("report-run").addEventListener("click", runReport);
  el("report-csv").addEventListener("click", exportCsv);
  el("report-print").addEventListener("click", printReport);
  el("report-kind").addEventListener("change", () => {
    setAlert(el("report-result"), "");
  });
}
