/**
 * جدول وحدات القياس والتحويل بينها — المصدر الوحيد للحقيقة.
 *
 * وحدة الصنف في المخزون نصٌّ حرّ (كجم، لتر، علبة...)، والتصنيع يحتاج أن يجمع
 * بين وحدتين مختلفتين في معادلة واحدة: وزن الوحدة المنتجة يُقاس عادةً بالجرام
 * بينما المادة الخام تُصرف بالكيلوجرام. فيُطبَّع النص إلى وحدة معروفة، ويُحوَّل
 * بينها وبين أختها في البُعد نفسه (كتلة أو حجم) بمعامل ثابت.
 *
 * الوحدة الأساسية: الجرام للكتلة، والمليلتر للحجم. `perBase` هو عدد الوحدات
 * الأساسية في الوحدة الواحدة (الكيلوجرام = 1000 جرام).
 *
 * وحدات العدّ (قطعة، علبة، كرتون...) لا تُحوَّل: لا معامل ثابت يربط العلبة
 * بالقطعة، فتبقى كل وحدة مع نفسها ومعامل التحويل 1.
 */

export type UnitDimension = "mass" | "volume";

export interface UnitDefinition {
  /** التسمية المعتمدة التي تُعرض في الواجهة */
  key: string;
  dimension: UnitDimension;
  /** عدد الوحدات الأساسية (جرام/مليلتر) في الوحدة الواحدة */
  perBase: number;
  /** كل ما قد يكتبه المستخدم للوحدة نفسها (بعد التطبيع) */
  aliases: string[];
}

export const UNIT_TABLE: UnitDefinition[] = [
  {
    key: "مليجرام",
    dimension: "mass",
    perBase: 0.001,
    aliases: ["مليجرام", "مليغرام", "مجم", "ملجم", "ملغم", "mg", "milligram", "milligrams"],
  },
  {
    key: "جرام",
    dimension: "mass",
    perBase: 1,
    aliases: ["جرام", "غرام", "جم", "غم", "g", "gm", "gr", "gram", "grams"],
  },
  {
    key: "أوقية",
    dimension: "mass",
    perBase: 28.3495,
    aliases: ["اوقيه", "اونصه", "oz", "ounce", "ounces"],
  },
  {
    key: "رطل",
    dimension: "mass",
    perBase: 453.592,
    aliases: ["رطل", "باوند", "lb", "lbs", "pound", "pounds"],
  },
  {
    key: "كيلوجرام",
    dimension: "mass",
    perBase: 1000,
    aliases: [
      "كجم",
      "كغم",
      "كيلو",
      "كيلوجرام",
      "كيلوغرام",
      "كج",
      "kg",
      "kgs",
      "kilo",
      "kilos",
      "kilogram",
      "kilograms",
    ],
  },
  {
    key: "طن",
    dimension: "mass",
    perBase: 1_000_000,
    aliases: ["طن", "ton", "tons", "tonne", "tonnes", "t"],
  },
  {
    key: "مليلتر",
    dimension: "volume",
    perBase: 1,
    aliases: ["مل", "ملل", "مليلتر", "ميلليلتر", "ml", "milliliter", "milliliters"],
  },
  {
    key: "سنتيلتر",
    dimension: "volume",
    perBase: 10,
    aliases: ["سنتيلتر", "سل", "cl", "centiliter"],
  },
  {
    key: "لتر",
    dimension: "volume",
    perBase: 1000,
    aliases: ["لتر", "ل", "لترات", "l", "lt", "ltr", "liter", "liters", "litre", "litres"],
  },
  {
    key: "جالون",
    dimension: "volume",
    perBase: 3785.41,
    aliases: ["جالون", "gal", "gallon", "gallons"],
  },
];

/** أصغر وحدة عملية في كل بُعد — الوزن الافتراضي للوحدة المنتجة يُقاس بها. */
export const DIMENSION_SUBUNIT: Record<UnitDimension, string> = {
  mass: "جرام",
  volume: "مليلتر",
};

const DIACRITICS = /[ً-ْـ]/g;

/**
 * تطبيع نص الوحدة: تُحذف الحركات والمسافات وعلامات الترقيم، وتُوحَّد صور
 * الألف والياء والتاء المربوطة، كي يُطابق «كجم.» و«كِجم» و« KG » وحدةً واحدة.
 */
export function normalizeUnit(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(/[\s._\-/\\()،,]+/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

const BY_ALIAS = new Map<string, UnitDefinition>();
for (const definition of UNIT_TABLE) {
  BY_ALIAS.set(normalizeUnit(definition.key), definition);
  for (const alias of definition.aliases) BY_ALIAS.set(normalizeUnit(alias), definition);
}

/** تعريف الوحدة إن كانت معروفة، أو `null` لوحدات العدّ والوحدات غير المعروفة. */
export function findUnit(value: unknown): UnitDefinition | null {
  const normalized = normalizeUnit(value);
  if (normalized === "") return null;
  return BY_ALIAS.get(normalized) ?? null;
}

/** التسمية المعتمدة للوحدة، أو النص كما كتبه المستخدم إن كانت غير معروفة. */
export function unitLabel(value: unknown): string {
  return findUnit(value)?.key ?? String(value ?? "").trim();
}

/** هل الوحدتان قابلتان للتحويل بينهما (البُعد نفسه أو الوحدة نفسها)؟ */
export function unitsCompatible(from: unknown, to: unknown): boolean {
  const a = findUnit(from);
  const b = findUnit(to);
  if (a && b) return a.dimension === b.dimension;
  return normalizeUnit(from) === normalizeUnit(to);
}

/**
 * معامل تحويل كمية من الوحدة `from` إلى الوحدة `to`:
 * `قيمة_بـto = قيمة_بـfrom × conversionFactor(from, to)`.
 *
 * مثال: من الجرام إلى الكيلوجرام = 0.001، فـ50 جرام = 0.05 كجم.
 * الوحدات غير المعروفة أو غير المتوافقة تُعامل بمعامل 1 (تبقى كما هي) بدل
 * رفض العملية، فوحدات العدّ لا تملك معاملاً أصلاً.
 */
export function conversionFactor(from: unknown, to: unknown): number {
  const a = findUnit(from);
  const b = findUnit(to);
  if (!a || !b || a.dimension !== b.dimension) return 1;
  return a.perBase / b.perBase;
}

/**
 * الوحدة الافتراضية لوزن الوحدة المنتجة: أصغر وحدة عملية في بُعد وحدة الخام
 * (الكيلوجرام ← جرام، اللتر ← مليلتر)، لأن وزن الوحدة الواحدة يُقاس بالجرامات
 * عادةً. وإن كانت وحدة الخام أصغر من ذلك أو غير معروفة فهي نفسها.
 */
export function defaultWeightUnit(rawUnit: unknown): string {
  const definition = findUnit(rawUnit);
  if (!definition) return String(rawUnit ?? "").trim();

  const subunit = findUnit(DIMENSION_SUBUNIT[definition.dimension]);
  if (!subunit || definition.perBase <= subunit.perBase) return definition.key;
  return subunit.key;
}

/** الوحدات المتاحة لوزن الوحدة المنتجة: كل وحدات بُعد الخام مرتّبة تصاعدياً. */
export function weightUnitOptions(rawUnit: unknown): string[] {
  const definition = findUnit(rawUnit);
  if (!definition) {
    const label = String(rawUnit ?? "").trim();
    return label === "" ? [] : [label];
  }

  return UNIT_TABLE.filter((entry) => entry.dimension === definition.dimension)
    .sort((a, b) => a.perBase - b.perBase)
    .map((entry) => entry.key);
}

/**
 * الوحدة المعتمدة لوزن الوحدة: ما اختاره المستخدم إن كان متوافقاً مع وحدة
 * الخام، وإلا الوحدة الافتراضية. هذا يمنع خلط الجرام بوحدة حجم أو عدّ.
 */
export function resolveWeightUnit(rawUnit: unknown, requested: unknown): string {
  const requestedLabel = String(requested ?? "").trim();
  if (requestedLabel === "") return defaultWeightUnit(rawUnit);
  if (!unitsCompatible(rawUnit, requestedLabel)) return defaultWeightUnit(rawUnit);
  return unitLabel(requestedLabel);
}

/** الجدول كما يُرسل إلى المتصفح ليحسب التحويل نفسه أثناء الكتابة. */
export function unitMeta() {
  return { table: UNIT_TABLE, subunits: DIMENSION_SUBUNIT };
}
