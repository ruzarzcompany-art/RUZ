/**
 * تحويل الوحدات في المتصفح — يعمل على جدول الوحدات القادم من الخادم
 * (`meta.units` في `GET /inventory/items`)، فلا يُعرَّف الجدول هنا مرة ثانية.
 * المطلوب في الواجهة أن يُحسب الحقل الثالث أثناء الكتابة قبل الإرسال، ثم
 * يُعيد الخادم الحساب نفسه عند الحفظ فيبقى هو الفيصل.
 */

const DIACRITICS = /[ً-ْـ]/g;

let table = [];
let subunits = { mass: "جرام", volume: "مليلتر" };
let byAlias = new Map();

/** تطبيع نص الوحدة بالقواعد نفسها المستخدمة في الخادم. */
export function normalizeUnit(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(/[\s._\-/\\()،,]+/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

/** يُحمَّل جدول الوحدات من `meta.units` عند كل تحديث لقائمة الأصناف. */
export function setUnitTable(meta) {
  table = Array.isArray(meta?.table) ? meta.table : [];
  if (meta?.subunits) subunits = meta.subunits;

  byAlias = new Map();
  for (const definition of table) {
    byAlias.set(normalizeUnit(definition.key), definition);
    for (const alias of definition.aliases ?? []) byAlias.set(normalizeUnit(alias), definition);
  }
}

export function findUnit(value) {
  const normalized = normalizeUnit(value);
  if (normalized === "") return null;
  return byAlias.get(normalized) ?? null;
}

export function unitLabel(value) {
  return findUnit(value)?.key ?? String(value ?? "").trim();
}

/**
 * معامل تحويل كمية من `from` إلى `to`: من الجرام إلى الكيلوجرام = 0.001.
 * الوحدات غير المعروفة أو غير المتوافقة (وحدات العدّ) معاملها 1.
 */
export function conversionFactor(from, to) {
  const a = findUnit(from);
  const b = findUnit(to);
  if (!a || !b || a.dimension !== b.dimension) return 1;
  return a.perBase / b.perBase;
}

/** الوحدة الافتراضية لوزن الوحدة المنتجة: أصغر وحدة عملية في بُعد الخام. */
export function defaultWeightUnit(rawUnit) {
  const definition = findUnit(rawUnit);
  if (!definition) return String(rawUnit ?? "").trim();

  const subunit = findUnit(subunits[definition.dimension]);
  if (!subunit || definition.perBase <= subunit.perBase) return definition.key;
  return subunit.key;
}

/** وحدات وزن الوحدة المتاحة لمادة خام بوحدة معيّنة، مرتّبة تصاعدياً. */
export function weightUnitOptions(rawUnit) {
  const definition = findUnit(rawUnit);
  if (!definition) {
    const label = String(rawUnit ?? "").trim();
    return label === "" ? [] : [label];
  }

  return table
    .filter((entry) => entry.dimension === definition.dimension)
    .slice()
    .sort((a, b) => a.perBase - b.perBase)
    .map((entry) => entry.key);
}

/**
 * يملأ قائمة وحدات الوزن لمادة خام، ويحفظ اختيار المستخدم إن بقي متوافقاً
 * وإلا يعود إلى الوحدة الافتراضية (جرام مقابل الكيلوجرام).
 */
export function fillWeightUnitPicker(select, rawItem) {
  if (!select) return "";

  const rawUnit = rawItem?.unit ?? "";
  const options = rawItem?.weightUnits?.length ? rawItem.weightUnits : weightUnitOptions(rawUnit);
  const fallback = rawItem?.defaultWeightUnit || defaultWeightUnit(rawUnit);
  const previous = select.value;

  select.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option;
    node.textContent = option;
    select.append(node);
  }

  const keep = options.includes(previous) ? previous : fallback;
  if (keep && !options.includes(keep)) {
    const node = document.createElement("option");
    node.value = keep;
    node.textContent = keep;
    select.append(node);
  }

  select.value = keep ?? "";
  select.disabled = options.length <= 1;
  return select.value;
}
