import type { NextFunction, Response } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  employeePermissionOverrides,
  permissions as permissionsTable,
  rolePermissions,
} from "../db/schema.js";
import type { AuthedRequest } from "./auth.js";

/**
 * الصلاحيات الذرّية في النظام. تُمنح للأدوار عبر `role_permissions`،
 * ويُفحص كل مسار بصلاحيته الخاصة.
 *
 * ملاحظة مهمة: `attendanceManualWrite` صلاحية **مدير الموارد البشرية تحديداً**
 * وتسمح بإنشاء/تعديل/حذف أي سجل حضور بكل حقوله. أما مدير الفرع فيملك
 * `attendanceCorrectCheckout` فقط: تصحيح وقت انصراف وردية أُقفلت تلقائياً.
 */
export const PERMISSIONS = {
  attendanceCheckIn: "attendance.check_in",
  attendanceReadOwn: "attendance.read_own",
  attendanceReadAll: "attendance.read_all",
  attendanceApprove: "attendance.approve",
  attendanceManualWrite: "attendance.manual_write",
  attendanceCorrectCheckout: "attendance.correct_checkout",
  employeesRead: "employees.read",
  employeesWrite: "employees.write",
  branchesRead: "branches.read",
  branchesWrite: "branches.write",
  reportsView: "reports.view",
  auditRead: "audit.read",
  formsSubmit: "forms.submit",
  formsReadOwn: "forms.read_own",
  formsReadAll: "forms.read_all",
  formsApprove: "forms.approve",
  bonusesManage: "bonuses.manage",
  contractsManage: "contracts.manage",
  salaryManage: "salary.manage",
  payrollManage: "payroll.manage",
  vouchersManage: "vouchers.manage",
  custodyManage: "custody.manage",
  schedulesManage: "schedules.manage",
  /** تخصيص صلاحيات عرض لموظف بعينه (فوق صلاحيات دوره) */
  permissionsManage: "permissions.manage",
  /** الكاشير يرفع تقفيله اليومي بنفسه */
  cashierSubmit: "cashier.submit",
  /** عرض تقفيلات كل الكاشيرات لا تقفيلاته فقط */
  cashierReadAll: "cashier.read_all",
  /** مراجعة/اعتماد التقفيل وتعديله بعد الرفع */
  cashierReview: "cashier.review",
  inventoryRead: "inventory.read",
  inventoryWrite: "inventory.write",
  /** إدارة أصناف المخزون نفسها (لا الحركات فقط) */
  inventoryItemsManage: "inventory.items_manage",
  /** لوحة الإعدادات الشاملة: الكيانات الأساسية وهوية المطبوعات */
  settingsManage: "settings.manage",
  /** طباعة/إصدار النماذج الرسمية من حزمة المستندات */
  documentsPrint: "documents.print",
  documentsReadAll: "documents.read_all",
  disciplinaryManage: "disciplinary.manage",
  /* أقسام العرض — تُستخدم لإظهار/إخفاء أقسام بعينها لموظف محدّد */
  sectionPayroll: "sections.payroll",
  sectionCashierClosing: "sections.cashier_closing",
  sectionReports: "sections.reports",
  sectionEmployeeFile: "sections.employee_file",
  sectionInventory: "sections.inventory",
  sectionSettings: "sections.settings",
  sectionDocuments: "sections.documents",
} as const;

export const PERMISSION_CATALOG: Array<{ code: string; description: string }> = [
  { code: PERMISSIONS.attendanceCheckIn, description: "تسجيل الحضور والانصراف" },
  { code: PERMISSIONS.attendanceReadOwn, description: "عرض سجل الحضور الشخصي" },
  { code: PERMISSIONS.attendanceReadAll, description: "عرض سجلات حضور جميع الموظفين" },
  { code: PERMISSIONS.attendanceApprove, description: "اعتماد أو رفض سجلات الحضور" },
  {
    code: PERMISSIONS.attendanceManualWrite,
    description: "إضافة وتعديل سجلات الحضور يدوياً بكل حقولها (الموارد البشرية)",
  },
  {
    code: PERMISSIONS.attendanceCorrectCheckout,
    description: "تصحيح وقت الانصراف بعد الإقفال التلقائي مع خصم ساعات",
  },
  { code: PERMISSIONS.employeesRead, description: "عرض بيانات الموظفين" },
  { code: PERMISSIONS.employeesWrite, description: "إضافة وتعديل الموظفين" },
  { code: PERMISSIONS.branchesRead, description: "عرض الفروع" },
  { code: PERMISSIONS.branchesWrite, description: "إضافة وتعديل الفروع" },
  { code: PERMISSIONS.reportsView, description: "عرض التقارير" },
  { code: PERMISSIONS.auditRead, description: "عرض سجل التدقيق" },
  { code: PERMISSIONS.formsSubmit, description: "تقديم الطلبات (سلفة، أوفرتايم، إجازة)" },
  { code: PERMISSIONS.formsReadOwn, description: "عرض نماذج الموظف الخاصة به" },
  { code: PERMISSIONS.formsReadAll, description: "عرض نماذج جميع الموظفين" },
  { code: PERMISSIONS.formsApprove, description: "اعتماد أو رفض الطلبات وتعديلها" },
  { code: PERMISSIONS.bonusesManage, description: "إدارة المكافآت" },
  { code: PERMISSIONS.contractsManage, description: "إدارة عقود العمل" },
  { code: PERMISSIONS.salaryManage, description: "تعريف الرواتب والبدلات" },
  { code: PERMISSIONS.payrollManage, description: "توليد مسير الرواتب" },
  { code: PERMISSIONS.vouchersManage, description: "سندات القبض والصرف" },
  { code: PERMISSIONS.custodyManage, description: "إخراج العهد واستلامها" },
  { code: PERMISSIONS.schedulesManage, description: "تعريف جداول الدوام للموظفين" },
  {
    code: PERMISSIONS.permissionsManage,
    description: "تخصيص صلاحيات العرض لموظف بعينه",
  },
  { code: PERMISSIONS.sectionPayroll, description: "رؤية قسم الرواتب" },
  {
    code: PERMISSIONS.sectionCashierClosing,
    description: "رؤية قسم تقفيل الكاشير",
  },
  { code: PERMISSIONS.sectionReports, description: "رؤية شاشة التقارير" },
  {
    code: PERMISSIONS.sectionEmployeeFile,
    description: "رؤية ملف الموظف الكامل",
  },
  { code: PERMISSIONS.cashierSubmit, description: "رفع تقفيل الكاشير اليومي" },
  {
    code: PERMISSIONS.cashierReadAll,
    description: "عرض تقفيلات جميع الكاشيرات",
  },
  { code: PERMISSIONS.cashierReview, description: "مراجعة تقفيل الكاشير وتعديله" },
  { code: PERMISSIONS.inventoryRead, description: "عرض المخزون وحركاته" },
  { code: PERMISSIONS.inventoryWrite, description: "تسجيل حركة مخزون (إدخال/إخراج/جرد)" },
  { code: PERMISSIONS.inventoryItemsManage, description: "إدارة أصناف المخزون" },
  {
    code: PERMISSIONS.settingsManage,
    description: "لوحة الإعدادات: الكيانات الأساسية وهوية المطبوعات",
  },
  { code: PERMISSIONS.documentsPrint, description: "إصدار وطباعة النماذج الرسمية" },
  { code: PERMISSIONS.documentsReadAll, description: "عرض سجل النماذج المُصدرة" },
  { code: PERMISSIONS.disciplinaryManage, description: "إصدار الإنذارات التأديبية" },
  { code: PERMISSIONS.sectionInventory, description: "رؤية شاشة المخزون" },
  { code: PERMISSIONS.sectionSettings, description: "رؤية لوحة الإعدادات" },
  { code: PERMISSIONS.sectionDocuments, description: "رؤية شاشة النماذج القابلة للطباعة" },
];

/**
 * الأقسام والبنود القابلة للتخصيص لموظف بعينه من شاشة الموارد البشرية.
 * كل بند يقابل رمز صلاحية واحد يُفحص في الخادم وتُخفى واجهته في المتصفح،
 * و`group` يُستخدم لتجميع البنود في الواجهة فقط.
 */
export const SECTION_CATALOG: Array<{
  code: string;
  label: string;
  hint: string;
  group: string;
}> = [
  {
    code: PERMISSIONS.sectionPayroll,
    label: "قسم الرواتب",
    hint: "عرض مسيّرات الرواتب وتقرير الرواتب",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionCashierClosing,
    label: "قسم تقفيل الكاشير",
    hint: "عرض سندات القبض والصرف وتقفيل الكاشير",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionReports,
    label: "شاشة التقارير",
    hint: "عرض شاشة التقارير وتصديرها",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionEmployeeFile,
    label: "ملف الموظف الكامل",
    hint: "عرض بيانات ملف الموظف وجدول دوامه",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionInventory,
    label: "شاشة المخزون",
    hint: "عرض حركة المخزون اليومية والأصناف",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionDocuments,
    label: "شاشة النماذج والمستندات",
    hint: "عرض حزمة النماذج القابلة للطباعة",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.sectionSettings,
    label: "لوحة الإعدادات",
    hint: "عرض لوحة الإعدادات الشاملة",
    group: "الشاشات",
  },
  {
    code: PERMISSIONS.reportsView,
    label: "التقارير (صلاحية أساسية)",
    hint: "الصلاحية التي تسمح بقراءة بيانات التقارير من الخادم",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.attendanceReadAll,
    label: "حضور جميع الموظفين",
    hint: "عرض سجلات حضور بقية الفريق",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.formsReadAll,
    label: "نماذج جميع الموظفين",
    hint: "عرض نماذج وطلبات بقية الفريق",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.cashierReadAll,
    label: "تقفيلات جميع الكاشيرات",
    hint: "عرض تقفيلات الفرع كاملة لا تقفيلاته الشخصية فقط",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.documentsReadAll,
    label: "سجل النماذج المُصدرة",
    hint: "عرض من طبع أي نموذج ومتى",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.inventoryRead,
    label: "قراءة المخزون",
    hint: "عرض الأصناف والأرصدة والحركات",
    group: "صلاحيات القراءة",
  },
  {
    code: PERMISSIONS.cashierSubmit,
    label: "رفع تقفيل الكاشير",
    hint: "السماح لهذا الموظف برفع تقفيله اليومي",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.cashierReview,
    label: "مراجعة التقفيل",
    hint: "اعتماد أو الاعتراض على تقفيلات الكاشير",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.inventoryWrite,
    label: "تسجيل حركة مخزون",
    hint: "إدخال/إخراج/جرد الأصناف",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.inventoryItemsManage,
    label: "إدارة أصناف المخزون",
    hint: "إضافة وتعديل الأصناف نفسها",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.documentsPrint,
    label: "إصدار النماذج الرسمية",
    hint: "طباعة العقود والإنذارات والإقرارات",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.disciplinaryManage,
    label: "الإنذارات التأديبية",
    hint: "إنشاء الإنذارات وإصدارها",
    group: "صلاحيات التنفيذ",
  },
  {
    code: PERMISSIONS.settingsManage,
    label: "تعديل الإعدادات",
    hint: "إضافة/تعديل/حذف الكيانات الأساسية وهوية المطبوعات",
    group: "صلاحيات التنفيذ",
  },
];


/** صلاحيات الدور — تُقرأ من قاعدة البيانات لكل طلب. */
export async function permissionCodesForRole(
  roleId: number | null,
): Promise<string[]> {
  if (roleId === null) return [];
  const db = getDb();
  const rows = await db
    .select({ code: permissionsTable.code })
    .from(rolePermissions)
    .innerJoin(
      permissionsTable,
      eq(rolePermissions.permissionId, permissionsTable.id),
    )
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.code);
}

export interface PermissionOverride {
  permissionCode: string;
  effect: string;
  note: string;
}

/** التخصيصات الفردية لموظف بعينه (allow/deny) فوق صلاحيات دوره. */
export async function permissionOverridesForEmployee(
  employeeId: number | null,
): Promise<PermissionOverride[]> {
  if (employeeId === null) return [];
  const db = getDb();
  return db
    .select({
      permissionCode: employeePermissionOverrides.permissionCode,
      effect: employeePermissionOverrides.effect,
      note: employeePermissionOverrides.note,
    })
    .from(employeePermissionOverrides)
    .where(eq(employeePermissionOverrides.employeeId, employeeId));
}

/**
 * الصلاحية الفعلية للموظف = صلاحيات دوره + ما مُنح له فردياً − ما سُحب منه.
 * تُستخدم في كل فحوص الصلاحيات وفي الرد على `/auth/me` حتى تتوافق الواجهة
 * مع ما يفرضه الخادم فعلياً.
 */
export async function effectivePermissionCodes(options: {
  employeeId: number | null;
  roleId: number | null;
}): Promise<string[]> {
  const [roleCodes, overrides] = await Promise.all([
    permissionCodesForRole(options.roleId),
    permissionOverridesForEmployee(options.employeeId),
  ]);

  const codes = new Set(roleCodes);
  for (const override of overrides) {
    if (override.effect === "deny") codes.delete(override.permissionCode);
    else codes.add(override.permissionCode);
  }
  return [...codes];
}

/** هل يملك الموظف صلاحية واحدة على الأقل من القائمة؟ */
export async function hasAnyPermission(
  req: AuthedRequest,
  codes: string[],
): Promise<boolean> {
  const owned = await effectivePermissionCodes({
    employeeId: req.employee?.id ?? null,
    roleId: req.employee?.roleId ?? null,
  });
  return codes.some((code) => owned.includes(code));
}

/** وسيط يتحقق من امتلاك الموظف صلاحية مُحدّدة عبر دوره. */
export function requirePermission(code: string) {
  return requireAnyPermission(code);
}

/** وسيط يقبل أي صلاحية من عدة صلاحيات (مثل: الموارد البشرية أو مدير الفرع). */
export function requireAnyPermission(...codes: string[]) {
  return async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (await hasAnyPermission(req, codes)) {
      next();
      return;
    }
    res.status(403).json({ ok: false, error: "لا تملك صلاحية تنفيذ هذا الإجراء" });
  };
}
