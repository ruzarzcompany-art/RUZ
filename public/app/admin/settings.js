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
import { pickLocation } from "../map-picker.js";
import { createPager } from "../pagination.js";

/** تقسيم صفحات جدول سجلات الكيان المعروض (فروع، أقسام، أصناف...). */
const entityPager = createPager("entity-table", { unit: "سجل" });

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

/**
 * يصغّر الصور النقطية الكبيرة داخل المتصفح حتى تنزل تحت الحد المسموح،
 * فلا يُرفض الشعار لمجرّد أن الملف الأصلي بدقّة عالية.
 * يُعاد نفس الـData URL إذا كان الملف SVG أو تعذّر التصغير.
 */
async function shrinkImageDataUrl(dataUrl, maxChars) {
  if (dataUrl.length <= maxChars) return dataUrl;
  if (dataUrl.startsWith("data:image/svg+xml")) return dataUrl;

  const image = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
  if (!image || !image.width || !image.height) return dataUrl;

  let width = image.width;
  let height = image.height;
  let out = dataUrl;

  // نُنقص الأبعاد تدريجياً حتى نصل إلى حجم مقبول أو إلى حدّ أدنى معقول
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const scale = Math.min(1, 900 / Math.max(width, height)) * (attempt === 0 ? 1 : 0.8);
    width = Math.max(60, Math.round(width * scale));
    height = Math.max(60, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(image, 0, 0, width, height);

    out = canvas.toDataURL("image/png");
    if (out.length > maxChars) out = canvas.toDataURL("image/jpeg", 0.82);
    if (out.length <= maxChars) return out;
    if (width <= 60 || height <= 60) break;
  }

  return out;
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

  if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,/.test(dataUrl)) {
    setAlert(
      el("settings-result"),
      "صيغة الملف غير مدعومة. اختر صورة PNG أو JPEG أو WebP أو SVG.",
      "error",
    );
    return;
  }

  // الشعار يُخزَّن كـData URL داخل الصف، فنصغّره قبل الإرسال عند الحاجة
  const maxChars = state.meta.maxLogoChars;
  try {
    dataUrl = await shrinkImageDataUrl(dataUrl, maxChars);
  } catch {
    /* نُكمل بالملف الأصلي ويتحقّق الفحص التالي من الحجم */
  }

  if (dataUrl.length > maxChars) {
    const kb = Math.round((maxChars * 3) / 4 / 1024);
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
    result.ok ? "تم رفع الشعار وحفظه." : (result.error ?? "تعذّر رفع الشعار"),
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
    return select(
      id,
      (spec.values ?? []).map((item) => [item, spec.valueLabels?.[item] ?? item]),
      value ?? spec.values?.[0],
    );
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

  renderLocationPicker(form, record);

  state.editingId = record?.id ?? null;
  el("entity-submit").textContent = record ? "حفظ التعديل" : `إضافة ${entity.singular}`;
  el("entity-cancel").hidden = !record;
}

/* ── تحديد الموقع على الخريطة ───────────────────────────────────
 * الكيانات التي تحمل حقلي `latitude` و`longitude` (الفروع) يصعب تعبئتها
 * يدوياً: من يعرف إحداثيات فرعه؟ لذلك نضيف زرّين — واحد يفتح خريطة لاختيار
 * النقطة، وآخر يقرأ موقع الجهاز الحالي — ويكتبان الناتج في الحقلين نفسهما.
 */

const hasLocationFields = (entity) =>
  Boolean(entity) &&
  entity.fields.some((spec) => spec.key === "latitude") &&
  entity.fields.some((spec) => spec.key === "longitude");

function readLocationInputs() {
  const latitude = Number(el("entity-field-latitude")?.value);
  const longitude = Number(el("entity-field-longitude")?.value);
  return {
    latitude: Number.isFinite(latitude) && latitude !== 0 ? latitude : undefined,
    longitude: Number.isFinite(longitude) && longitude !== 0 ? longitude : undefined,
  };
}

function writeLocationInputs(point, statusNode) {
  el("entity-field-latitude").value = String(point.latitude);
  el("entity-field-longitude").value = String(point.longitude);
  statusNode.textContent = `تم تحديد الموقع: ${point.latitude} ، ${point.longitude} — لا تنسَ الحفظ.`;
}

function renderLocationPicker(form, record) {
  const entity = state.currentEntity;
  if (!hasLocationFields(entity)) return;

  const wrap = document.createElement("div");
  wrap.className = "field field--sm";

  const label = document.createElement("span");
  label.className = "field__label";
  label.textContent = "الموقع على الخريطة";

  const buttons = document.createElement("div");
  buttons.className = "row row--wrap";

  const status = document.createElement("span");
  status.className = "field__hint";
  status.setAttribute("role", "status");
  status.textContent =
    record?.latitude || record?.longitude
      ? `الموقع الحالي: ${record.latitude} ، ${record.longitude}`
      : "لم يُحدَّد موقع بعد — افتح الخريطة وضع العلامة على المكان.";

  buttons.append(
    button("تحديد على الخريطة", {
      className: "btn btn--ghost btn--sm",
      onClick: async () => {
        const point = await pickLocation({
          ...readLocationInputs(),
          title: `موقع ${entity.singular}`,
        });
        if (point) writeLocationInputs(point, status);
      },
    }),
    button("موقعي الحالي", {
      className: "btn btn--ghost btn--sm",
      onClick: () => {
        if (!navigator.geolocation) {
          status.textContent = "المتصفح لا يدعم تحديد الموقع — استخدم الخريطة.";
          return;
        }

        status.textContent = "جاري تحديد موقعك…";
        navigator.geolocation.getCurrentPosition(
          (position) => {
            writeLocationInputs(
              {
                latitude: Math.round(position.coords.latitude * 1e6) / 1e6,
                longitude: Math.round(position.coords.longitude * 1e6) / 1e6,
              },
              status,
            );
          },
          () => {
            status.textContent = "تعذّر قراءة موقع الجهاز — حدّد المكان من الخريطة.";
          },
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
        );
      },
    }),
  );

  wrap.append(label, buttons, status);
  form.append(wrap);
}

function cellText(spec, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (spec.kind === "bool") return value ? "نعم" : "لا";
  if (spec.kind === "money") return formatMoney(value, state.settings?.currency ?? "SAR");
  if (spec.kind === "ref") {
    const list = state.refs[spec.refEntity] ?? [];
    return list.find((item) => item.id === Number(value))?.name ?? `#${value}`;
  }
  if (spec.kind === "enum") return spec.valueLabels?.[String(value)] ?? String(value);
  return String(value);
}

function renderEntityTable() {
  const entity = state.currentEntity;
  const table = el("entity-table");
  const head = table.querySelector("thead tr");
  head.textContent = "";

  if (!entity) {
    entityPager.clear();
    return;
  }

  // نعرض أول سبعة حقول فقط حتى يبقى الجدول مقروءاً على الجوال
  const shown = entity.fields.slice(0, 7);
  for (const spec of shown) {
    const cell = document.createElement("th");
    cell.textContent = spec.label;
    head.append(cell);
  }
  head.append(document.createElement("th"));

  const canManage = state.can(entity.managePermission) || state.can("settings.manage");

  entityPager.render(state.rows, (record) => {
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

    return row([...cells, actions]);
  });

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

/* ── البيانات التجريبية ────────────────────────────────────────── */

const DEMO_LABELS = {
  demoEmployees: "حسابات تجريبية",
  demoItems: "أصناف تجريبية",
  attendanceLogs: "سجلات حضور",
};

function paintDemoStatus(status) {
  const box = el("demo-status");
  box.textContent = "";

  for (const [key, labelText] of Object.entries(DEMO_LABELS)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const strong = document.createElement("strong");
    strong.textContent = String(status?.[key] ?? 0);
    chip.append(document.createTextNode(`${labelText}: `), strong);
    box.append(chip);
  }

  const flag = document.createElement("span");
  flag.className = "chip";
  flag.textContent = status?.purged
    ? "البذر التجريبي موقوف — لن تعود البيانات التجريبية"
    : "البذر التجريبي مُفعّل";
  box.append(flag);
}

async function loadDemoData() {
  if (!state.can("settings.manage")) return;

  const result = await api("/admin/demo-data");
  if (!result.ok) {
    setAlert(el("demo-result"), result.error ?? "تعذّر قراءة حالة البيانات التجريبية", "error");
    return;
  }

  paintDemoStatus(result);
}

async function purgeDemoData() {
  const node = el("demo-purge");
  const scope = el("demo-scope").value;
  const confirm = el("demo-confirm").value.trim();

  if (!window.confirm("حذف البيانات التجريبية نهائياً؟ لا يمكن الرجوع عن هذه العملية.")) return;

  setBusy(node, true);
  const result = await api("/admin/demo-data/purge", {
    method: "POST",
    body: { scope, confirm },
  });
  setBusy(node, false);

  setAlert(
    el("demo-result"),
    result.ok ? result.message : (result.error ?? "تعذّر الحذف"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    el("demo-confirm").value = "";
    await loadDemoData();
    await loadSummary();
  }
}

async function restoreDemoData() {
  const node = el("demo-restore");
  if (!window.confirm("إعادة بذر البيانات التجريبية الآن؟")) return;

  setBusy(node, true);
  const result = await api("/admin/demo-data/restore", { method: "POST" });
  setBusy(node, false);

  setAlert(
    el("demo-result"),
    result.ok ? result.message : (result.error ?? "تعذّر إعادة البيانات"),
    result.ok ? "ok" : "error",
  );

  if (result.ok) {
    await loadDemoData();
    await loadSummary();
  }
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

  // حذف البيانات التجريبية متاح لمن يملك إدارة الإعدادات فقط
  el("demo-card").hidden = !can("settings.manage");
  el("demo-refresh").addEventListener("click", loadDemoData);
  el("demo-purge").addEventListener("click", purgeDemoData);
  el("demo-restore").addEventListener("click", restoreDemoData);
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
  await loadDemoData();
  if (state.entities.length === 0) {
    await loadEntities();
  } else {
    await loadEntityRows();
  }
}
