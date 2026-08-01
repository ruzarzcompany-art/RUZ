/**
 * هوية المؤسسة على المطبوعات: الشعار، بيانات التذييل، وتصميم الورقة
 * (الحجم، الاتجاه، الهوامش، الخط، الألوان، العلامة المائية) تُقرأ من
 * `company_settings` وتُطبَّق تلقائياً على كل مستند يُطبع.
 */

import { api } from "../api.js?v=v8";

const PAPER_MM = {
  A4: { width: 210, height: 297, css: "A4" },
  A5: { width: 148, height: 210, css: "A5" },
  letter: { width: 216, height: 279, css: "letter" },
};

/** المقاسات المعروضة في مُبدِّل الورق أعلى صفحة الطباعة. */
export const PAPER_CHOICES = [
  { value: "A4", label: "A4 (210×297 مم)" },
  { value: "letter", label: "Letter (216×279 مم)" },
  { value: "A5", label: "A5 (148×210 مم)" },
];

const FONT_STACKS = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  naskh: '"IBM Plex Sans Arabic", "Noto Naskh Arabic", serif',
  kufi: '"Reem Kufi", "IBM Plex Sans Arabic", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
};

const FALLBACK = {
  companyName: "المؤسسة",
  paperSize: "A4",
  paperOrientation: "portrait",
  marginMm: 16,
  baseFontPt: 11,
  fontFamily: "system",
  accentColor: "#0f766e",
  textColor: "#111827",
  showLogo: true,
  showFooter: true,
  showSignatures: true,
  showWatermark: false,
  watermarkText: "",
  headerNote: "",
  footerText: "",
  footerNote: "",
  currency: "SAR",
};

let cached = null;
let cachedFields = {};

/** يقرأ إعدادات المؤسسة مرة واحدة لكل صفحة طباعة. */
export async function loadIdentity() {
  if (cached) return cached;
  const result = await api("/settings/company");
  cached =
    result.ok && result.settings ? { ...FALLBACK, ...result.settings } : { ...FALLBACK };
  cachedFields = (result.ok && result.printFields) || {};
  return cached;
}

/**
 * ما يُلغيه إخفاء كل حقل: تفريغ النص كافٍ لأن كل من يعرضه يتجاهل الفراغ
 * (`filter(Boolean)` في الترويسة والتذييل).
 */
const FIELD_BLANKS = {
  showCompanyName: ["companyName"],
  showCompanyNameEn: ["companyNameEn"],
  showCommercialRegister: ["commercialRegister"],
  showTaxNumber: ["taxNumber"],
  showAddress: ["address"],
  showCity: ["city"],
  showCountry: ["country"],
  showPhone: ["phone"],
  showEmail: ["email"],
  showWebsite: ["website"],
  showHeaderNote: ["headerNote"],
  showFooterNote: ["footerNote"],
};

/** حقول يحكمها مفتاح منطقي في كائن الهوية نفسه. */
const FIELD_SWITCHES = {
  showLogo: "showLogo",
  showFooter: "showFooter",
  showSignatures: "showSignatures",
  showWatermark: "showWatermark",
};

/**
 * هوية المؤسسة كما يجب أن تظهر على مطبوعة نموذج بعينه: نسخة مُنقّاة من
 * الإعدادات العامة بحسب ما اختاره المسؤول لهذا النموذج في
 * `document_identity_fields`.
 *
 * التنقية إخفاء فقط ولا تُفعّل شيئاً، فتبقى مفاتيح الإعدادات العامة
 * (الشعار، التذييل، التوقيعات، العلامة المائية) هي السلطة الأعلى: ما أغلقته
 * عامّاً لا يُعيده تخصيص نموذج. والنموذج الذي لم يُخصَّص يعود بالكائن نفسه.
 */
export function identityForDoc(company, docKey) {
  const fields = cachedFields[docKey];
  if (!fields) return company;

  const scoped = { ...company };

  for (const [key, targets] of Object.entries(FIELD_BLANKS)) {
    if (fields[key] === false) {
      for (const target of targets) scoped[target] = "";
    }
  }

  for (const [key, target] of Object.entries(FIELD_SWITCHES)) {
    if (fields[key] === false) scoped[target] = false;
  }

  // اسم المؤسسة: تفريغ النص وحده لا يكفي، فالترويسة تستبدله بالاسم الافتراضي
  if (fields.showCompanyName === false) scoped.hideCompanyName = true;

  return scoped;
}

/**
 * تخصيص بيانات الموظف لمطبوعة نموذج بعينه، كما هو محفوظ (أو `null` للنموذج
 * الذي لم يُخصَّص). القوالب تقرأه بقاعدة «الغائب ظاهر» (`!== false`) فلا
 * تُكرَّر القيم الافتراضية في المتصفح.
 */
export function employeeFieldsForDoc(docKey) {
  return cachedFields[docKey] ?? null;
}

/**
 * هامش أمان أفقي (مم) يُقتطع من هامش `@page` ويُضاف حشواً داخل الورقة.
 * السبب: كثير من مسارات الطباعة لا تحترم هوامش `@page` — خيار «بلا هوامش»
 * في نافذة الطباعة، وطباعة أندرويد/الويب-فيو، ومنطقة الطابعة غير القابلة
 * للطبع — فيلتصق المحتوى بحرف الورقة ويُقصّ طرفه (سطر «التاريخ / الفرع /
 * أصدره» أول المتأثرين) مع بقاء المعاينة داخل المتصفح سليمة. الحشو جزء من
 * المحتوى فلا يُلغيه أي إعداد، وخصمه من `@page` يُبقي مجموع الهامش كما
 * ضُبط في إعدادات المؤسسة فتتطابق المعاينة مع الورقة المطبوعة.
 */
const SAFE_PAD_MM = 8;

/**
 * أدنى حشو يبقى مهما صغُر الهامش المضبوط: الطابعات لا تطبع الشريط الأخير من
 * حرف الورقة، فهامش صفر يعني قصّ النص حتماً ولو كانت المعاينة سليمة.
 */
const MIN_PAD_MM = 5;

/**
 * يطبّق تصميم الورقة على الصفحة: متغيّرات CSS + قاعدة `@page`
 * (حجم الورق والاتجاه والهوامش) حتى تخرج الطباعة بالمقاس المطلوب.
 */
export function applyPaperDesign(company) {
  const paper = PAPER_MM[company.paperSize] ?? PAPER_MM.A4;
  const landscape = company.paperOrientation === "landscape";
  const width = landscape ? paper.height : paper.width;
  const margin = Number.isFinite(company.marginMm) ? company.marginMm : 16;
  const font = Number.isFinite(company.baseFontPt) ? company.baseFontPt : 11;

  // الهامش الأفقي يتوزّع بين `@page` وحشو الورقة، ومجموعهما = الهامش المضبوط
  const safePad = Math.max(Math.min(Math.max(margin, 0), SAFE_PAD_MM), MIN_PAD_MM);
  const sideMargin = Math.max(0, margin - safePad);
  // رأسياً لا يمكن حشو كل صفحة (الحشو الرأسي يقع على أول الصندوق وآخره فقط)
  // فيبقى الحدّ الأدنى على هامش `@page` نفسه حتى لا يلتصق أول سطر بحرف الورقة
  const blockMargin = Math.max(margin, MIN_PAD_MM);

  const root = document.body;
  root.style.setProperty("--sheet-paper-w", `${width}mm`);
  root.style.setProperty("--sheet-margin", `${margin}mm`);
  root.style.setProperty("--sheet-safe-pad", `${safePad}mm`);
  root.style.setProperty("--sheet-font", `${font}pt`);
  root.style.setProperty("--sheet-accent", company.accentColor || FALLBACK.accentColor);
  root.style.setProperty("--sheet-text", company.textColor || FALLBACK.textColor);
  root.style.setProperty(
    "--sheet-family",
    FONT_STACKS[company.fontFamily] ?? FONT_STACKS.system,
  );

  let style = document.getElementById("paper-rule");
  if (!style) {
    style = document.createElement("style");
    style.id = "paper-rule";
    document.head.append(style);
  }
  style.textContent =
    `@page { size: ${paper.css} ${landscape ? "landscape" : "portrait"}; ` +
    `margin: ${blockMargin}mm ${sideMargin}mm; }`;
}

/**
 * سطر إرشادي بإعدادات نافذة الطباعة الصحيحة. أشهر سبب لخروج نصف الكشف
 * أو ضياع بقية الصفحات هو اختيار ورق أو مقياس مختلف عن تصميم المستند،
 * فيُذكر المقاس المطلوب صريحاً للمستخدم قبل الطباعة.
 */
export function paperNote(company) {
  const paper = PAPER_MM[company.paperSize] ?? PAPER_MM.A4;
  const landscape = company.paperOrientation === "landscape";
  const width = landscape ? paper.height : paper.width;
  const height = landscape ? paper.width : paper.height;
  const name = company.paperSize === "letter" ? "Letter" : (company.paperSize ?? "A4");
  return (
    `الورق: ${name} ${landscape ? "أفقي" : "عمودي"} (${width}×${height} مم). ` +
    "في نافذة الطباعة اختر هذا المقاس، واجعل المقياس 100٪ ونطاق الصفحات «الكل» " +
    "حتى تُطبع كل الصفحات كاملة. الهوامش «افتراضية» أو «بلا هوامش» كلتاهما " +
    "تعملان: الورقة تحتفظ بهامش أمان داخلي فلا يُقصّ النص. للتصدير اختر «حفظ كـPDF»."
  );
}

/** ترويسة المستند: الشعار + اسم المؤسسة وبياناتها + عنوان المستند. */
export function documentHeader(company, title, subtitle) {
  const head = document.createElement("header");
  head.className = "sheet__head";

  const brand = document.createElement("div");
  brand.className = "sheet__brand";

  if (company.showLogo && company.logoDataUrl) {
    const logo = document.createElement("img");
    logo.className = "sheet__logo";
    logo.src = company.logoDataUrl;
    logo.alt = company.companyName ?? "";
    brand.append(logo);
  }

  const text = document.createElement("div");
  text.className = "sheet__brand-text";
  if (!company.hideCompanyName) {
    const name = document.createElement("h2");
    name.textContent = company.companyName || FALLBACK.companyName;
    text.append(name);
  }

  const identityLines = [
    company.companyNameEn,
    [
      company.commercialRegister ? `س.ت: ${company.commercialRegister}` : "",
      company.taxNumber ? `الرقم الضريبي: ${company.taxNumber}` : "",
    ]
      .filter(Boolean)
      .join(" — "),
    [company.address, company.city, company.country].filter(Boolean).join(" — "),
    [company.phone, company.email].filter(Boolean).join(" — "),
  ].filter((line) => line && line.trim() !== "");

  for (const line of identityLines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    text.append(paragraph);
  }

  brand.append(text);
  head.append(brand);

  const h1 = document.createElement("h1");
  h1.className = "sheet__title";
  h1.textContent = title;
  head.append(h1);

  if (subtitle) {
    const sub = document.createElement("p");
    sub.className = "sheet__sub";
    sub.textContent = subtitle;
    head.append(sub);
  }

  if (company.headerNote) {
    const note = document.createElement("p");
    note.className = "sheet__headnote";
    note.textContent = company.headerNote;
    head.append(note);
  }

  return head;
}

/** سطر بيانات المستند: التاريخ والمرجع ومن أصدره. */
export function documentMeta(entries) {
  const wrap = document.createElement("div");
  wrap.className = "sheet__meta";
  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === "") continue;
    const span = document.createElement("span");
    span.textContent = `${key}: ${value}`;
    wrap.append(span);
  }
  return wrap;
}

/** تذييل المطبوعة ببيانات المؤسسة. */
export function documentFooter(company) {
  if (!company.showFooter) return null;

  const footer = document.createElement("footer");
  footer.className = "sheet__footer";

  const lines = [
    company.footerText,
    [company.website, company.phone, company.email].filter(Boolean).join(" | "),
    company.footerNote,
  ].filter((line) => line && line.trim() !== "");

  if (lines.length === 0) return null;

  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    footer.append(paragraph);
  }

  return footer;
}

/** العلامة المائية (نسخة، مسودة...) تُرسم خلف المحتوى. */
export function watermark(company) {
  if (!company.showWatermark) return null;
  const text = company.watermarkText || company.companyName;
  if (!text) return null;

  const mark = document.createElement("div");
  mark.className = "sheet__watermark";
  // النص في عنصر داخلي: الدوران عليه وحده فلا يتمدّد صندوق الورقة أفقياً
  const inner = document.createElement("span");
  inner.textContent = text;
  mark.append(inner);
  return mark;
}
