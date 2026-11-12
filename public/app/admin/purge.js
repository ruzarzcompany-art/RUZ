/**
 * تصفية الأرقام السابقة (الإعدادات): معاينة ← نسخة احتياطية ← حذف نهائي.
 *
 * الخادم لا يحذف إلا بعد تنزيل نسخة احتياطية مطابقة وكتابة كلمة التأكيد
 * (`/api/purge/*`)؛ هذه الشاشة ترتّب الخطوات فقط.
 */

import { api, button, downloadFile, row, setAlert, setBusy } from "../api.js";

const SCOPES = [
  ["cashier", "تقفيلات الكاشير", "التقفيلات اليومية وبنودها (شبكة، تطبيقات توصيل، نقد)."],
  ["cash", "النقدية والإقفال", "المصاريف والمشتريات النقدية، تسويات الشبكات والتوصيل ودفعاتها، إقفالات الشهر وإشعاراتها."],
  ["inventory", "حركات المخزون", "حركات الإدخال والإخراج والجرد واستلام المشتريات. الأصناف وأسعارها تبقى."],
  ["surveillance", "سجلات الرقابة", "تنبيهات الكاميرات ولقطاتها وأحداث الكاشير والهدر والتقارير اليومية. إعدادات الكاميرات تبقى."],
];

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else element[key] = value;
  }
  element.append(...children);
  return element;
}

/** أول يوم في الشهر الحالي — البداية الجديدة الافتراضية. */
function firstOfThisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function mountPurge(container) {
  const state = { previewKey: "", backedUpKey: "", total: 0 };

  const before = node("input", { type: "date", value: firstOfThisMonth() });
  const checks = SCOPES.map(([value, label, hint]) => {
    const input = node("input", { type: "checkbox", value });
    input.style.width = "auto";
    const head = node("span", {}, [input, node("strong", { text: label })]);
    head.style.cssText = "display:flex;align-items:center;gap:0.5rem";
    return {
      input,
      label: node("label", { class: "field field--wide" }, [
        head,
        node("span", { class: "hint", text: hint }),
      ]),
    };
  });

  const tableBody = node("tbody");
  const table = node("table", { class: "table", hidden: true }, [
    node("thead", {}, [node("tr", {}, ["النطاق", "الجدول", "عدد السجلات التي ستُحذف"].map((text) => node("th", { text })))]),
    tableBody,
  ]);
  const alert = node("p", { class: "alert", role: "status", hidden: true });
  const confirm = node("input", { type: "text", placeholder: "اكتب: تصفية", maxLength: 20 });

  const previewButton = button("1) معاينة ما سيُحذف", { className: "btn btn--ghost btn--sm", onClick: preview });
  const backupButton = button("2) تنزيل النسخة الاحتياطية", { className: "btn btn--ghost btn--sm", onClick: backup });
  const runButton = button("3) حذف نهائي", { className: "btn btn--danger btn--sm", onClick: run });

  const chosen = () => checks.filter((check) => check.input.checked).map((check) => check.input.value);
  const key = () => `${before.value}|${chosen().join(",")}`;
  const query = () => new URLSearchParams({ before: before.value, scopes: chosen().join(",") });

  function sync() {
    backupButton.disabled = state.previewKey !== key() || state.total === 0;
    runButton.disabled = state.backedUpKey !== key();
    confirm.disabled = runButton.disabled;
  }

  // أي تغيير في التاريخ أو النطاقات يُبطل المعاينة والنسخة السابقتين
  for (const input of [before, ...checks.map((check) => check.input)]) {
    input.addEventListener("change", () => {
      table.hidden = true;
      sync();
    });
  }

  async function preview(trigger) {
    if (chosen().length === 0) {
      setAlert(alert, "اختر نطاقاً واحداً على الأقل.", "error");
      return;
    }
    setBusy(trigger, true);
    const response = await api(`/purge/preview?${query()}`);
    setBusy(trigger, false);
    if (!response.ok) {
      setAlert(alert, response.error ?? "تعذّرت المعاينة", "error");
      return;
    }

    const labels = response.meta.scopeLabels;
    tableBody.replaceChildren(
      ...response.tables.map((entry) => row([labels[entry.scope] ?? entry.scope, entry.label, entry.count])),
    );
    table.hidden = false;
    state.previewKey = key();
    state.backedUpKey = "";
    state.total = response.total;
    setAlert(
      alert,
      response.total === 0
        ? `لا توجد سجلات قبل ${response.before} في النطاقات المختارة — لا شيء يُحذف.`
        : `سيُحذف ${response.total} سجل مما قبل ${response.before}. نزّل النسخة الاحتياطية ثم أكّد الحذف.`,
      response.total === 0 ? "ok" : "warn",
    );
    sync();
  }

  async function backup(trigger) {
    setBusy(trigger, true);
    const response = await downloadFile(`/purge/backup?${query()}`, `sijill-backup-before-${before.value}.xls`);
    setBusy(trigger, false);
    if (!response.ok) {
      setAlert(alert, response.error ?? "تعذّر تنزيل النسخة الاحتياطية", "error");
      return;
    }
    state.backedUpKey = key();
    setAlert(
      alert,
      "نُزّلت النسخة الاحتياطية. افتح الملف وتأكد من محتواه واحفظه في مكان آمن، ثم اكتب «تصفية» واضغط «حذف نهائي». الحذف لا يمكن التراجع عنه.",
      "warn",
    );
    sync();
  }

  async function run(trigger) {
    setBusy(trigger, true);
    const response = await api("/purge/run", {
      method: "POST",
      body: { before: before.value, scopes: chosen(), confirm: confirm.value },
    });
    setBusy(trigger, false);
    if (!response.ok) {
      setAlert(alert, response.error ?? "تعذّرت التصفية", "error");
      return;
    }
    state.previewKey = "";
    state.backedUpKey = "";
    state.total = 0;
    confirm.value = "";
    table.hidden = true;
    setAlert(alert, response.message, "ok");
    sync();
  }

  container.replaceChildren(
    node("p", {
      class: "hint",
      text:
        "للبدء من جديد: يُحذف نهائياً ما قبل «تاريخ البداية الجديدة» في النطاقات التي تختارها فقط. " +
        "بيانات الموظفين والحضور والرواتب والأصناف والإعدادات وسجل التدقيق لا تُمس.",
    }),
    node("label", { class: "field field--sm" }, [
      node("span", { class: "field__label", text: "تاريخ البداية الجديدة (يُحذف ما قبله)" }),
      before,
    ]),
    ...checks.map((check) => check.label),
    node("div", { class: "row row--wrap" }, [previewButton, backupButton]),
    node("div", { class: "table-wrap" }, [table]),
    node("div", { class: "row row--wrap" }, [confirm, runButton]),
    alert,
  );
  sync();
}
