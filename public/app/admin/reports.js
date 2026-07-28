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
  cashier: "تقرير تقفيلات الكاشير",
  inventory: "تقرير حركة المخزون",
  documents: "تقرير النماذج المُصدرة",
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

/** هوية المؤسسة للطباعة — تُقرأ مرة واحدة ثم تُخزَّن. */
let identity = null;

async function loadIdentity() {
  if (identity) return identity;
  const result = await api("/settings/company");
  identity = result.ok && result.settings ? result.settings : {};
  return identity;
}

/**
 * الطباعة: نبني صفحة مستقلة بالجدول الحالي في نافذة جديدة ثم نطبعها،
 * فلا تتأثر شاشة اللوحة ولا تحتاج قواعد طباعة خاصة. هوية المؤسسة
 * (الشعار والترويسة والتذييل وتصميم الورقة) تُطبَّق من لوحة الإعدادات.
 */
async function printReport() {
  if (!current) {
    setAlert(el("report-result"), "اعرض التقرير أولاً ثم اطبعه.", "warn");
    return;
  }

  const company = await loadIdentity();

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

  // التقارير جداول عريضة، فنُبقيها عرضية دائماً ونأخذ من الإعدادات ما يناسبها
  const margin = Number.isFinite(company.marginMm) ? company.marginMm : 12;
  const paper = company.paperSize === "letter" ? "letter" : company.paperSize === "A5" ? "A5" : "A4";
  const accent = /^#[0-9a-fA-F]{6}$/.test(company.accentColor ?? "") ? company.accentColor : "#4a442f";

  const logo =
    company.showLogo !== false && company.logoDataUrl
      ? `<img src="${escape(company.logoDataUrl)}" alt="" class="logo" />`
      : "";

  const identityLines = [
    [company.commercialRegister ? `س.ت: ${company.commercialRegister}` : "",
     company.taxNumber ? `الرقم الضريبي: ${company.taxNumber}` : ""].filter(Boolean).join(" — "),
    [company.address, company.city, company.country].filter(Boolean).join(" — "),
  ]
    .filter(Boolean)
    .map((line) => `<p class="ident">${escape(line)}</p>`)
    .join("");

  const footerLines =
    company.showFooter === false
      ? ""
      : [company.footerText, [company.website, company.phone, company.email].filter(Boolean).join(" | "), company.footerNote]
          .filter(Boolean)
          .map((line) => `<p>${escape(line)}</p>`)
          .join("");

  window_.document.write(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>${escape(current.title ?? REPORT_TITLES[current.report] ?? "تقرير")}</title>
<style>
  body { font-family: "IBM Plex Sans Arabic", system-ui, sans-serif; padding: 16px; color: #1a180f; }
  header.brand { display: flex; align-items: center; gap: 10px; border-bottom: 2px solid ${accent}; padding-bottom: 6px; margin-bottom: 10px; }
  header.brand .logo { max-height: 48px; max-width: 120px; object-fit: contain; }
  header.brand h2 { font-size: 15px; margin: 0; color: ${accent}; }
  header.brand .ident { font-size: 10px; margin: 1px 0; color: #4a442f; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.meta { font-size: 12px; color: #4a442f; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #cfc9b4; padding: 4px 6px; text-align: right; }
  th { background: #f2eee0; }
  thead { display: table-header-group; }
  ul { font-size: 12px; padding-inline-start: 18px; }
  footer.brand { margin-top: 14px; border-top: 1px solid #cfc9b4; padding-top: 6px; font-size: 10px; color: #4a442f; text-align: center; }
  footer.brand p { margin: 1px 0; }
  @page { size: ${paper} landscape; margin: ${margin}mm; }
</style></head>
<body>
  <header class="brand">
    ${logo}
    <div>
      <h2>${escape(company.companyName ?? "")}</h2>
      ${identityLines}
    </div>
  </header>
  <h1>${escape(current.title ?? "تقرير")}</h1>
  <p class="meta">${escape(filters || "بلا تصفية")} — طُبع في ${escape(new Date().toLocaleString("ar"))}</p>
  <table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>
  <ul>${summary}</ul>
  <footer class="brand">${footerLines}</footer>
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
