/**
 * تخصيص بيانات المؤسسة الظاهرة على مطبوعات كل نموذج.
 *
 * الافتراضي أن كل مطبوعة تحمل الهوية كاملةً كما في `company_settings`. وهذا
 * الملف يقرأ الاستثناءات المسجَّلة لكل نموذج في `document_identity_fields`
 * ويقدّمها للواجهة وصفحة الطباعة، فيبقى مصدر أسماء الحقول وترتيبها واحداً
 * في الخادم والمتصفح معاً.
 *
 * غياب صف النموذج = الهوية كاملة، فلا يتغيّر سلوك نموذج لم يُخصَّص.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { documentIdentityFields } from "../db/schema.js";
import { asBool } from "./validate.js";

/** حقول الهوية القابلة للإظهار/الإخفاء لكل نموذج، بترتيب ظهورها على الورقة. */
export const IDENTITY_FIELDS = [
  { key: "showLogo", label: "الشعار", group: "الترويسة" },
  { key: "showCompanyName", label: "اسم المؤسسة", group: "الترويسة" },
  { key: "showCompanyNameEn", label: "الاسم بالإنجليزية", group: "الترويسة" },
  { key: "showCommercialRegister", label: "السجل التجاري", group: "الترويسة" },
  { key: "showTaxNumber", label: "الرقم الضريبي", group: "الترويسة" },
  { key: "showAddress", label: "العنوان", group: "الترويسة" },
  { key: "showCity", label: "المدينة", group: "الترويسة" },
  { key: "showCountry", label: "الدولة", group: "الترويسة" },
  { key: "showPhone", label: "الهاتف", group: "الترويسة والتذييل" },
  { key: "showEmail", label: "البريد الإلكتروني", group: "الترويسة والتذييل" },
  { key: "showWebsite", label: "الموقع الإلكتروني", group: "التذييل" },
  { key: "showHeaderNote", label: "ملاحظة الترويسة", group: "الترويسة" },
  { key: "showFooter", label: "نص التذييل", group: "التذييل" },
  { key: "showFooterNote", label: "ملاحظة التذييل", group: "التذييل" },
  { key: "showSignatures", label: "خانات التوقيع", group: "أسفل الورقة" },
  { key: "showWatermark", label: "العلامة المائية", group: "خلف المحتوى" },
] as const;

export type IdentityFieldKey = (typeof IDENTITY_FIELDS)[number]["key"];

const FIELD_KEYS = IDENTITY_FIELDS.map((field) => field.key) as IdentityFieldKey[];

export type IdentityFieldMap = Record<IdentityFieldKey, boolean>;

/** كل الحقول ظاهرة — حالة النموذج الذي لم يُخصَّص. */
export function allVisible(): IdentityFieldMap {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, true])) as IdentityFieldMap;
}

/**
 * قراءة تخصيص كل النماذج مرة واحدة: `{ docKey: { showTaxNumber: false, ... } }`.
 * النماذج التي لا صفّ لها لا تظهر في الخريطة أصلاً، فصفحة الطباعة تعرف أن
 * هويتها كاملة بلا فحص إضافي.
 */
export async function loadIdentityFieldMap(): Promise<Record<string, IdentityFieldMap>> {
  const db = getDb();
  const rows = await db.select().from(documentIdentityFields);

  const map: Record<string, IdentityFieldMap> = {};
  for (const row of rows) {
    map[row.docKey] = Object.fromEntries(
      FIELD_KEYS.map((key) => [key, row[key] !== false]),
    ) as IdentityFieldMap;
  }
  return map;
}

/** تخصيص نموذج واحد، أو `null` إن لم يُخصَّص بعد. */
export async function loadIdentityFields(docKey: string): Promise<IdentityFieldMap | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(documentIdentityFields)
    .where(eq(documentIdentityFields.docKey, docKey))
    .limit(1);

  if (!row) return null;
  return Object.fromEntries(
    FIELD_KEYS.map((key) => [key, row[key] !== false]),
  ) as IdentityFieldMap;
}

/**
 * قراءة الحقول من جسم الطلب: ما لم يُذكر يُعتبر ظاهراً، فالحفظ يُثبّت الصورة
 * الكاملة التي تراها الشاشة بدل دمج جزئي يترك حقلاً بقيمة قديمة.
 */
export function readIdentityFields(body: Record<string, unknown>): IdentityFieldMap | string {
  const source = (body.fields ?? body) as Record<string, unknown>;
  const result = allVisible();

  for (const key of FIELD_KEYS) {
    if (!(key in source)) continue;
    const flag = asBool(source[key]);
    if (flag === null) return `قيمة غير صالحة للحقل ${key}`;
    result[key] = flag;
  }

  return result;
}
