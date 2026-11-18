/**
 * أدوات الجداول لقسم كامل: تقسيم صفحات (5 / 10 / 100 سطر) وزر طباعة لكل جدول،
 * دون تعديل كود رسم أي جدول. تُراقَب صفوف الجدول؛ فكلما أعاد القسم رسمها
 * طُبّق التقسيم من الصفحة الأولى. الطباعة تُخرج كل الصفوف لا الصفحة المعروضة.
 */

const SIZES = [5, 10, 100];
const DEFAULT_SIZE = 10;
const tools = new WeakMap();

function titleOf(table) {
  // أقرب عنوان يسبق الجدول داخل بطاقته، وإلا عنوان البطاقة
  let node = table.closest(".table-wrap") ?? table;
  while (node) {
    let prev = node.previousElementSibling;
    while (prev) {
      if (/^H[1-4]$/.test(prev.tagName)) return prev.textContent.trim();
      const inner = prev.querySelector?.("h1,h2,h3,h4");
      if (inner) return inner.textContent.trim();
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
    if (!node || node.matches("main")) break;
  }
  return document.title;
}

function printTable(table) {
  const clone = table.cloneNode(true);
  for (const row of clone.querySelectorAll("tr")) row.hidden = false;
  // الحقول تُطبع بقيمها، والأزرار لا تُطبع
  const live = table.querySelectorAll("input, select, textarea");
  clone.querySelectorAll("input, select, textarea").forEach((field, index) => {
    const source = live[index];
    const text = source?.tagName === "SELECT" ? source.selectedOptions[0]?.textContent ?? "" : source?.value ?? "";
    field.replaceWith(document.createTextNode(text));
  });
  for (const node of clone.querySelectorAll("button, .row-actions, img, canvas")) node.remove();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const branch = document.querySelector("#sv-branch")?.selectedOptions?.[0]?.textContent ?? "";
  const date = document.querySelector("#sv-date")?.value ?? "";
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(titleOf(table))}</title>
<style>@page{size:A4 landscape;margin:12mm}body{font-family:Tahoma,Arial,sans-serif;color:#111}h1{font-size:18px;margin:0 0 4px}.meta{font-size:12px;color:#444;margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #999;padding:4px;text-align:right;vertical-align:top}th{background:#eee}</style></head>
<body><h1>${esc(titleOf(table))}</h1><div class="meta">${esc([branch, date, `عدد السطور: ${clone.tBodies[0]?.rows.length ?? 0}`, `طُبع ${new Date().toLocaleString("ar-SA")}`].filter(Boolean).join(" · "))}</div>
${clone.outerHTML}<script>window.onload=()=>window.print()</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

function build(table) {
  const bar = document.createElement("div");
  bar.className = "pager table-tools";
  const range = document.createElement("span");
  range.className = "pager__range";
  const previous = document.createElement("button");
  const next = document.createElement("button");
  for (const [node, text] of [[previous, "السابق"], [next, "التالي"]]) {
    node.type = "button";
    node.className = "btn btn--ghost btn--xs pager__nav";
    node.textContent = text;
  }
  const size = document.createElement("label");
  size.className = "pager__size";
  const sizeText = document.createElement("span");
  sizeText.textContent = "عدد السطور";
  const select = document.createElement("select");
  select.className = "pager__select";
  for (const value of SIZES) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    select.append(option);
  }
  select.value = String(DEFAULT_SIZE);
  size.append(sizeText, select);
  const print = document.createElement("button");
  print.type = "button";
  print.className = "btn btn--ghost btn--xs";
  print.textContent = "طباعة";
  const pages = document.createElement("div");
  pages.className = "pager__pages";
  pages.append(previous, next);
  bar.append(range, pages, size, print);
  (table.closest(".table-wrap") ?? table).after(bar);

  const tool = { table, bar, range, previous, next, page: 1, size: DEFAULT_SIZE };
  previous.addEventListener("click", () => {
    tool.page--;
    apply(tool, false);
  });
  next.addEventListener("click", () => {
    tool.page++;
    apply(tool, false);
  });
  select.addEventListener("change", () => {
    tool.size = Number(select.value);
    tool.page = 1;
    apply(tool, false);
  });
  print.addEventListener("click", () => printTable(table));
  return tool;
}

function apply(tool, detectChange = true) {
  const body = tool.table.tBodies[0];
  const rows = body ? [...body.rows] : [];
  // التحديث الدوري يعيد رسم الصفوف: تبقى الصفحة الحالية كما هي ما دامت موجودة
  void detectChange;
  const last = Math.max(1, Math.ceil(rows.length / tool.size));
  tool.page = Math.min(Math.max(1, tool.page), last);
  const start = (tool.page - 1) * tool.size;
  rows.forEach((row, index) => {
    row.hidden = index < start || index >= start + tool.size;
  });
  tool.bar.hidden = rows.length === 0;
  tool.range.textContent = rows.length ? `${start + 1}–${Math.min(rows.length, start + tool.size)} من ${rows.length}` : "";
  tool.previous.disabled = tool.page <= 1;
  tool.next.disabled = tool.page >= last;
}

/** يضيف التقسيم والطباعة لكل جداول القسم الحالية والتي تُنشأ لاحقاً. */
export function enhanceTables(root) {
  if (!root || root.dataset.tableTools) return;
  root.dataset.tableTools = "1";
  let queued = false;
  const sweep = () => {
    queued = false;
    for (const table of root.querySelectorAll("table")) {
      if (table.dataset.noTools !== undefined) continue;
      let tool = tools.get(table);
      if (!tool || !tool.bar.isConnected) {
        tool = build(table);
        tools.set(table, tool);
      }
      apply(tool);
    }
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sweep);
  }).observe(root, { childList: true, subtree: true });
  sweep();
}
