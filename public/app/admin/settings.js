/**
 * لوحة الإعدادات الشاملة:
 *  1) هوية المؤسسة على المطبوعات — الشعار، البيانات، التذييل، وتصميم الورقة.
 *  2) محرّك الكيانات الأساسية — الفروع، الأقسام، المسميات الوظيفية، بنود
 *     الرواتب، أصناف المخزون: إضافة/تعديل/حفظ/حذف من شاشة واحدة.
 *
 * وصف الحقول يأتي من الخادم (`GET /settings/entities`) فتُبنى النماذج
 * والجداول تلقائياً، وأي كيان جديد يُضاف في الخادم يظهر هنا بلا تعديل.
 */

import { api, button, el, formatMoney, row, setAlert, setBusy } from "../api.js";

const TEXT_FIELDS = [
  ["companyName", "اسم المؤسسة"],
  ["companyNameEn", "الاسم بالإنجليزية"],
  ["legalForm", "الشكل القانوني"],
  ["commercialRegister", "السجل التجاري"],
  ["taxNumber", "الرقم الضريبي"],
  ["address", "العنوان"],
  ["city", "المدينة"],
  ["country", "الدولة"],
  ["phone", "الهاتف"],
  ["email", "البريد الإلكتروني"],
  ["website", "الموقع الإلكتروني"],
  ["currency", "العملة"],
  ["headerNote", "ملاحظة أعلى المطبوعة"],
  ["footerText", "نص التذييل"],
  ["footerNote", "ملاحظة التذييل"],
  ["watermarkText", "نص العلامة المائية"],
];

const PAPER_LABELS = { A4: "A4", A5: "A5", letter: "Letter" };
const ORIENTATION_LABELS = { portrait: "طولي", landscape: "عرضي" };
const FONT_LABELS = {
  system: "خط النظام",
  naskh: "نسخ",
  kufi: "كوفي",
  serif: "مذيّل (Serif)",
  mono: "ثابت العرض",
};

const BOOL_FLAGS = [
  ["showLogo", "إظهار الشعار"],
  ["showFooter", "إظهار التذييل"],
  ["showSignatures", "إظهار خانات التوقيع"],
  ["showWatermark", "إظهار العلامة المائية"],
];

const NUMBER_FIELDS = [
  ["marginMm", "هامش الصفحة (مم)", 0, 40, 1],
  ["baseFontPt", "حجم الخط (pt)", 7, 18, 0.5],
];

const state = {
  settings: null,
  /** حدود الخادم (مقاسات الورق، أقصى حجم للشعار) — تأتي مع `GET /settings/company` */
  meta: { maxLogoChars: 700_000 },
  entities: [],
  currentEntity: null,
  rows: [],
  editingId: null,
  /** قوائم مرجعية للحقول من نوع `ref` */
  refs: { employees: [], branches: [], departments: [] },
  can: () => false,
};

/* ── هوية المؤسسة ──────────────────────────────────────────────── */

function field(labelText, control) {
  const wrap = document.createElement("label");
  wrap.className = "field field--sm";
  const span = document.createElement("span");
  span.className = "field__label";
  span.textContent = labelText;
  wrap.append(span, control);
  return wrap;
}

function input(id, value, type = "text") {
  const node = document.createElement("input");
  node.id = id;
  node.type = type;
  node.value = value ?? "";
  return node;
}

function select(id, options, value) {
  const node = document.createElement("select");
  node.id = id;
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    node.append(option);
  }
  node.value = value ?? options[0]?.[0] ?? "";
  return node;
}

function renderCompanyForm() {
  const settings = state.settings ?? {};
  const grid = el("company-fields");
  grid.textContent = "";

  for (const [key, labelText] of TEXT_FIELDS) {
    grid.append(field(labelText, input(`company-${key}`, settings[key])));
  }

  const design = el("company-design");
  design.textContent = "";

  design.append(
    field(
      "حجم الورق",
      select(
        "company-paperSize",
        Object.entries(PAPER_LABELS),
        settings.paperSize ?? "A4",
      ),
    ),
    field(
      "اتجاه الورقة",
      select(
        "company-paperOrientation",
        Object.entries(ORIENTATION_LABELS),
        settings.paperOrientation ?? "portrait",
      ),
    ),
    field(
      "الخط",
      select("company-fontFamily", Object.entries(FONT_LABELS), settings.fontFamily ?? "system"),
    ),
  );

  for (const [key, labelText, min, max, step] of NUMBER_FIELDS) {
    const node = input(`company-${key}`, settings[key], "number");
    node.min = String(min);
    node.max = String(max);
    node.step = String(step);
    design.append(field(labelText, node));
  }

  design.append(
    field("لون التمييز", input("company-accentColor", settings.accentColor ?? "#0f766e", "color")),
    field("لون النص", input("company-textColor", settings.textColor ?? "#111827", "color")),
  );

  const flags = el("company-flags");
  flags.textContent = "";
  for (const [key, labelText] of BOOL_FLAGS) {
    const wrap = document.createElement("label");
    wrap.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `company-${key}`;
    box.checked = settings[key] !== false;
    const text = document.createElement("span");
    text.textContent = labelText;
    wrap.append(box, text);
    flags.append(wrap);
  }

  const preview = el("company-logo-preview");
  preview.textContent = "";
  if (settings.logoDataUrl) {
    const image = document.createElement("img");
    image.src = settings.logoDataUrl;
    image.alt = "شعار المؤسسة";
    image.className = "logo-preview";
    preview.append(image);
  } else {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "لا يوجد شعار مرفوع.";
    preview.append(empty);
  }
}

async function loadCompany() {
  const result = await api("/settings/company");
  if (!result.ok) {
    setAlert(el("settings-result"), result.error ?? "تعذّر تحميل الإعدادات", "error");
    return;
  }
  state.settings = result.settings;
  if (result.meta) state.meta = { ...state.meta, ...result.meta };
  renderCompanyForm();
}

async function saveCompany() {
  const submit = el("company-save");
  setBusy(submit, true);

  const payload = {};
  for (const [key] of TEXT_FIELDS) payload[key] = el(`company-${key}`).value.trim();
  for (const [key] of NUMBER_FIELDS) payload[key] = Number(el(`company-${key}`).value);
  for (const [key] of BOOL_FLAGS) payload[key] = el(`company-${key}`).checked;
  payload.paperSize = el("company-paperSize").value;
  payload.paperOrientation = el("company-paperOrientation").value;
  payload.fontFamily = el("company-fontFamily").value;
  payload.accentColor = el("company-accentColor").value;
  payload.textColor = el("company-textColor").value;

  const result = await api("/settings/company", { method: "PUT", body: payload });
  setBusy(submit, false);

  if (result.ok) state.settings = result.settings;
  setAlert(
    el("settings-result"),
    result.ok ? "تم حفظ إعدادات المؤسسة والمطبوعات." : (result.error ?? "تعذّر الحفظ"),
    result.ok ? "ok" : "error",
  );
}

/** يقرأ ملف الشعار كـData URL ويرفعه إلى قاعدة البيانات. */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("تعذّر قراءة الملف"));
    reader.readAsDataURL(file);
  });
}

async function uploadLogo(file) {
  if (!file) return;

  let dataUrl;
  try {
    dataUrl = await readFileAsDataUrl(file);
  } catch {
    setAlert(el("settings-result"), "تعذّر قراءة ملف الشعار.", "error");
    return;
  }

  // الشعار يُخزَّن كـData URL داخل الصف، فنمنع الملفات الضخمة قبل الإرسال
  if (dataUrl.length > state.meta.maxLogoChars) {
    const kb = Math.round((state.meta.maxLogoChars * 3) / 4 / 1024);
    setAlert(
      el("settings-result"),
      `حجم الشعار كبير. اختر صورة أصغر من نحو ${kb} كيلوبايت (PNG أو SVG مضغوط).`,
      "error",
    );
    return;
  }

  const result = await api("/settings/company/logo", {
    method: "POST",
    body: { logoDataUrl: dataUrl },
  });

  if (result.ok) {
    state.settings = { ...state.settings, logoDataUrl: dataUrl };
    renderCompanyForm();
  }

  setAlert(
    el("settings-result"),
    result.ok ? "تم رفع الشعار." : (result.error ?? "تعذّر رفع الشعار"),
    result.ok ? "ok" : "error",
  );
}

async function removeLogo() {
  const result = await api("/settings/company/logo", { method: "DELETE" });
  if (result.ok) {
    state.settings = { ...state.settings, logoDataUrl: "" };
    renderCompanyForm();
  }
  setAlert(
    el("settings-result"),
    result.ok ? "تم حذف الشعار." : (result.error ?? "تعذّر حذف الشعار"),
    result.ok ? "ok" : "error",
  );
}

/* ── محرّك الكيانات ────────────────────────────────────────────── */

function refOptions(refEntity) {
  const list = state.refs[refEntity] ?? [];
  return [["", "— بدون —"], ...list.map((item) => [String(item.id), item.name])];
}

/** يبني حقل إدخال واحداً حسب وصفه القادم من الخادم. */
function entityControl(spec, value) {
  const id = `entity-field-${spec.key}`;

  if (spec.kind === "bool") {
    const node = document.createElement("input");
    node.type = "checkbox";
    node.id = id;
    node.checked = value === undefined ? true : Boolean(value);
    return node;
  }

  if (spec.kind === "enum") {
    return select(id, (spec.values ?? []).map((item) => [item, item]), value ?? spec.values?.[0]);
  }

  if (spec.kind === "ref") {
    return select(id, refOptions(spec.refEntity), value === null ? "" : String(value ?? ""));
  }

  const node = document.createElement("input");
  node.id = id;
  node.value = value === null || value === undefined ? "" : String(value);

  if (spec.kind === "number" || spec.kind === "int" || spec.kind === "money") {
    node.type = "number";
    node.step = spec.kind === "int" ? "1" : "any";
    if (spec.min !== undefined) node.min = String(spec.min);
    if (spec.maxValue !== undefined) node.max = String(spec.maxValue);
  }

  if (spec.required) node.required = true;
  return node;
}

function renderEntityForm(record) {
  const entity = state.currentEntity;
  const form = el("entity-fields");
  form.textContent = "";
  if (!entity) return;

  for (const spec of entity.fields) {
    const control = entityControl(spec, record ? record[spec.key] : undefined);
    const wrapped = field(spec.label + (spec.required ? " *" : ""), control);
    if (spec.hint) {
      const hint = document.createElement("span");
      hint.className = "field__hint";
      hint.textContent = spec.hint;
      wrapped.append(hint);
    }
    form.append(wrapped);
  }

  state.editingId = record?.id ?? null;
  el("entity-submit").textContent = record ? "حفظ التعديل" : `إضافة ${entity.singular}`;
  el("entity-cancel").hidden = !record;
}

function cellText(spec, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (spec.kind === "bool") return value ? "نعم" : "لا";
  if (spec.kind === "money") return formatMoney(value, state.settings?.currency ?? "SAR");
  if (spec.kind === "ref") {
    const list = state.refs[spec.refEntity] ?? [];
    return list.find((item) => item.id === Number(value))?.name ?? `#${value}`;
  }
  return String(value);
}

function renderEntityTable() {
  const entity = state.currentEntity;
  const table = el("entity-table");
  const head = table.querySelector("thead tr");
  const body = table.querySelector("tbody");
  head.textContent = "";
  body.textContent = "";

  if (!entity) return;

  // نعرض أول ستة حقول فقط حتى يبقى الجدول مقروءاً على الجوال
  const shown = entity.fields.slice(0, 6);
  for (const spec of shown) {
    const cell = document.createElement("th");
    cell.textContent = spec.label;
    head.append(cell);
  }
  head.append(document.createElement("th"));

  const canManage = state.can(entity.managePermission) || state.can("settings.manage");

  for (const record of state.rows) {
    const cells = shown.map((spec) => cellText(spec, record[spec.key]));
    const actions = document.createElement("span");
    actions.className = "row-actions";

    if (canManage) {
      actions.append(
        button("تعديل", {
          onClick: () => {
            renderEntityForm(record);
            el("entity-form").scrollIntoView({ behavior: "smooth", block: "center" });
          },
        }),
        button("حذف", {
          className: "btn btn--danger btn--xs",
          onClick: () => deleteEntityRow(record),
        }),
      );
    }

    body.append(row([...cells, actions]));
  }

  el("entity-empty").hidden = state.rows.length > 0;
  el("entity-form").hidden = !canManage;
}

async function loadEntityRows() {
  const entity = state.currentEntity;
  if (!entity) return;

  // القوائم المرجعية أولاً حتى تُبنى حقول `ref` والجدول بأسماء صحيحة
  await refreshRefs();

  const result = await api(`/settings/entities/${entity.key}`);
  if (!result.ok) {
    state.rows = [];
    renderEntityTable();
    setAlert(el("entity-result"), result.error ?? "تعذّر تحميل السجلات", "error");
    return;
  }

  state.rows = result.rows ?? [];
  setAlert(el("entity-result"), "");
  renderEntityTable();
  renderEntityForm(null);
}

/** يحدّث القوائم المرجعية (فروع/أقسام) بعد أي تعديل عليها. */
async function refreshRefs() {
  const needed = new Set(
    (state.currentEntity?.fields ?? [])
      .filter((spec) => spec.kind === "ref")
      .map((spec) => spec.refEntity),
  );

  for (const key of needed) {
    if (key === "employees") continue; // تأتي من قائمة الموظفين العامة
    const result = await api(`/settings/entities/${key}`);
    if (!result.ok) continue;
    state.refs[key] = (result.rows ?? []).map((item) => ({
      id: item.id,
      name: item.name ?? item.code ?? `#${item.id}`,
    }));
  }
}

function collectEntityValues() {
  const entity = state.currentEntity;
  const payload = {};

  for (const spec of entity.fields) {
    const node = el(`entity-field-${spec.key}`);
    if (!node) continue;

    if (spec.kind === "bool") {
      payload[spec.key] = node.checked;
      continue;
    }

    const raw = node.value.trim();
    if (spec.kind === "ref") {
      payload[spec.key] = raw === "" ? null : Number(raw);
      continue;
    }

    if (spec.kind === "number" || spec.kind === "int" || spec.kind === "money") {
      if (raw === "") {
        if (spec.required) payload[spec.key] = "";
        continue;
      }
      payload[spec.key] = Number(raw);
      continue;
    }

    payload[spec.key] = raw;
  }

  return payload;
}

async function submitEntity(event) {
  event.preventDefault();
  const entity = state.currentEntity;
  if (!entity) return;

  const submit = el("entity-submit");
  setBusy(submit, true);

  const payload = collectEntityValues();
  const result = state.editingId
    ? await api(`/settings/entities/${entity.key}/${state.editingId}`, {
        method: "PATCH",
        body: payload,
      })
    : await api(`/settings/entities/${entity.key}`, { method: "POST", body: payload });

  setBusy(submit, false);
  setAlert(
    el("entity-result"),
    result.ok
      ? `تم حفظ ${entity.singular}.`
      : (result.error ?? `تعذّر حفظ ${entity.singular}`),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    state.editingId = null;
    await loadEntityRows();
    await loadSummary();
  }
}

async function deleteEntityRow(record) {
  const entity = state.currentEntity;
  const name = record.name ?? record.code ?? `#${record.id}`;
  if (!window.confirm(`حذف ${entity.singular} «${name}»؟ لا يمكن التراجع.`)) return;

  const result = await api(`/settings/entities/${entity.key}/${record.id}`, {
    method: "DELETE",
  });

  setAlert(
    el("entity-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    await loadEntityRows();
    await loadSummary();
  }
}

async function loadSummary() {
  if (!state.can("settings.manage")) return;
  const result = await api("/settings/summary");
  if (!result.ok) return;

  const labels = {
    branches: "الفروع",
    departments: "الأقسام",
    jobTitles: "المسميات الوظيفية",
    salaryComponents: "بنود الرواتب",
    inventoryItems: "أصناف المخزون",
    activeEmployees: "الموظفون النشطون",
  };

  const box = el("settings-summary");
  box.textContent = "";
  for (const [key, value] of Object.entries(result.counts ?? {})) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    chip.append(document.createTextNode(`${labels[key] ?? key}: `), strong);
    box.append(chip);
  }
}

async function loadEntities() {
  const result = await api("/settings/entities");
  if (!result.ok) return;

  state.entities = result.entities ?? [];
  const picker = el("entity-kind");
  picker.textContent = "";

  for (const entity of state.entities) {
    const option = document.createElement("option");
    option.value = entity.key;
    option.textContent = entity.label;
    picker.append(option);
  }

  state.currentEntity = state.entities[0] ?? null;
  if (state.currentEntity) await loadEntityRows();
}

/* ── التهيئة ───────────────────────────────────────────────────── */

export function initSettingsModule({ can, employees }) {
  state.can = can;
  state.refs.employees = employees.map((employee) => ({
    id: employee.id,
    name: `${employee.employeeCode} — ${employee.fullName}`,
  }));

  el("company-save").addEventListener("click", saveCompany);
  el("company-logo-input").addEventListener("change", async (event) => {
    await uploadLogo(event.target.files?.[0]);
    event.target.value = "";
  });
  el("company-logo-remove").addEventListener("click", removeLogo);

  el("entity-kind").addEventListener("change", async (event) => {
    state.currentEntity =
      state.entities.find((entity) => entity.key === event.target.value) ?? null;
    state.editingId = null;
    await loadEntityRows();
  });

  el("entity-form").addEventListener("submit", submitEntity);
  el("entity-cancel").addEventListener("click", () => renderEntityForm(null));
}

/** يُستدعى عند فتح تبويب الإعدادات. */
export async function refreshSettingsPanel(employees) {
  if (employees) {
    state.refs.employees = employees.map((employee) => ({
      id: employee.id,
      name: `${employee.employeeCode} — ${employee.fullName}`,
    }));
  }

  await loadCompany();
  await loadSummary();
  if (state.entities.length === 0) {
    await loadEntities();
  } else {
    await loadEntityRows();
  }
}
