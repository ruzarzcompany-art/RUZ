/**
 * تخصيص البيانات الظاهرة على مطبوعات كل نموذج: هوية المؤسسة وبيانات الموظف.
 *
 * الافتراضي أن كل مطبوعة تحمل الهوية كاملةً كما في `company_settings` وجدول
 * تعريف الموظف كاملاً. وهذا الملف يقرأ الاستثناءات المسجَّلة لكل نموذج في
 * `document_identity_fields` ويقدّمها للواجهة وصفحة الطباعة، فيبقى مصدر
 * أسماء الحقول وترتيبها واحداً في الخادم والمتصفح معاً.
 *
 * غياب صف النموذج = كل البيانات ظاهرة، فلا يتغيّر سلوك نموذج لم يُخصَّص.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { documentIdentityFields } from "../db/schema.js";
import { asBool } from "./validate.js";

/** حقول هوية المؤسسة القابلة للإظهار/الإخفاء، بترتيب ظهورها على الورقة. */
export const IDENTITY_FIELDS = [
  { key: "showLogo", label: "الشعار", group: "هوية المؤسسة — الترويسة" },
  { key: "showCompanyName", label: "اسم المؤسسة", group: "هوية المؤسسة — الترويسة" },
  {
    key: "showCompanyNameEn",
    label: "الاسم بالإنجليزية",
    group: "هوية المؤسسة — الترويسة",
  },
  {
    key: "showCommercialRegister",
    label: "السجل التجاري",
    group: "هوية المؤسسة — الترويسة",
  },
  { key: "showTaxNumber", label: "الرقم الضريبي", group: "هوية المؤسسة — الترويسة" },
  { key: "showAddress", label: "العنوان", group: "هوية المؤسسة — الترويسة" },
  { key: "showCity", label: "المدينة", group: "هوية المؤسسة — الترويسة" },
  { key: "showCountry", label: "الدولة", group: "هوية المؤسسة — الترويسة" },
  { key: "showPhone", label: "الهاتف", group: "هوية المؤسسة — الترويسة والتذييل" },
  {
    key: "showEmail",
    label: "البريد الإلكتروني",
    group: "هوية المؤسسة — الترويسة والتذييل",
  },
  { key: "showWebsite", label: "الموقع الإلكتروني", group: "هوية المؤسسة — التذييل" },
  {
    key: "showHeaderNote",
    label: "ملاحظة الترويسة",
    group: "هوية المؤسسة — الترويسة",
  },
  { key: "showFooter", label: "نص التذييل", group: "هوية المؤسسة — التذييل" },
  { key: "showFooterNote", label: "ملاحظة التذييل", group: "هوية المؤسسة — التذييل" },
  { key: "showSignatures", label: "خانات التوقيع", group: "أسفل الورقة" },
  { key: "showWatermark", label: "العلامة المائية", group: "خلف المحتوى" },
] as const;

/**
 * بيانات الموظف القابلة للإظهار/الإخفاء في جدول تعريف المستند. تُطبع كلها
 * اليوم، فالأصل ظهورها كي لا يتغيّر شكل مطبوعة قائمة.
 */
export const EMPLOYEE_FIELDS = [
  { key: "showJobTitle", label: "المسمى الوظيفي", group: "بيانات الموظف" },
  { key: "showDepartment", label: "القسم", group: "بيانات الموظف" },
  { key: "showBranch", label: "الفرع", group: "بيانات الموظف" },
  { key: "showManager", label: "المدير المسؤول", group: "بيانات الموظف" },
  { key: "showHiredAt", label: "تاريخ المباشرة", group: "بيانات الموظف" },
  {
    key: "showEmployeeEmail",
    label: "البريد الإلكتروني للموظف",
    group: "بيانات اتصال الموظف",
  },
  {
    key: "showEmployeePhone",
    label: "جوال الموظف",
    group: "بيانات اتصال الموظف",
  },
] as const;

/**
 * بيانات لا تُعطَّل ولا تُستثنى من أي نموذج: تعريف المستند وصاحبه. تُعرض في
 * الشاشة للعلم فقط، ولا مفتاح لها في قاعدة البيانات فلا سبيل لإخفائها.
 */
export const FIXED_FIELDS = [
  "تاريخ الاتفاقية / المستند",
  "اسم الموظف",
  "الرقم الوظيفي",
  "الجنسية",
  "رقم الهوية / الإقامة",
] as const;

/** كل ما يمكن تخصيصه لكل نموذج: هوية المؤسسة ثم بيانات الموظف. */
export const PRINT_FIELDS = [...IDENTITY_FIELDS, ...EMPLOYEE_FIELDS];

export type IdentityFieldKey = (typeof PRINT_FIELDS)[number]["key"];

const FIELD_KEYS = PRINT_FIELDS.map((field) => field.key) as IdentityFieldKey[];

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
