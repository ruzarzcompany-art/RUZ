import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  branches,
  companySettings,
  departments,
  employees,
  inventoryItems,
  jobTitles,
  permissions,
  rolePermissions,
  roles,
  salaryComponents,
  salaryDefinitions,
  workSchedules,
} from "../db/schema.js";
import { env, getSeedPassword } from "./config.js";
import { DEMO_PURGED_FLAG, isFlagOn } from "./flags.js";
import { hashPassword } from "./passwords.js";
import { PERMISSION_CATALOG, PERMISSIONS } from "./rbac.js";

/** يُعاد تصديرها حفاظاً على التوافق مع الاستدعاءات السابقة. */
export { PERMISSIONS };

const ROLE_SEED: Array<{
  name: string;
  nameAr: string;
  description: string;
  permissions: string[];
}> = [
  {
    name: "super_admin",
    nameAr: "مدير النظام",
    description: "صلاحيات كاملة على النظام",
    permissions: Object.values(PERMISSIONS),
  },
  {
    /**
     * مدير الموارد البشرية هو الوحيد (مع مدير النظام) الذي يملك
     * `attendance.manual_write`: إضافة/تعديل/حذف أي سجل حضور بكل حقوله.
     */
    name: "hr_manager",
    nameAr: "مدير الموارد البشرية",
    description: "إدارة الموظفين والحضور والنماذج والرواتب",
    permissions: [
      PERMISSIONS.attendanceCheckIn,
      PERMISSIONS.attendanceReadOwn,
      PERMISSIONS.attendanceReadAll,
      PERMISSIONS.attendanceApprove,
      PERMISSIONS.attendanceManualWrite,
      PERMISSIONS.attendanceCorrectCheckout,
      PERMISSIONS.employeesRead,
      PERMISSIONS.employeesWrite,
      PERMISSIONS.branchesRead,
      PERMISSIONS.branchesWrite,
      PERMISSIONS.reportsView,
      PERMISSIONS.auditRead,
      PERMISSIONS.formsSubmit,
      PERMISSIONS.formsReadOwn,
      PERMISSIONS.formsReadAll,
      PERMISSIONS.formsApprove,
      PERMISSIONS.bonusesManage,
      PERMISSIONS.contractsManage,
      PERMISSIONS.salaryManage,
      PERMISSIONS.payrollManage,
      PERMISSIONS.vouchersManage,
      PERMISSIONS.custodyManage,
      PERMISSIONS.schedulesManage,
      PERMISSIONS.permissionsManage,
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.cashierReview,
      PERMISSIONS.inventoryRead,
      PERMISSIONS.inventoryWrite,
      PERMISSIONS.inventoryItemsManage,
      PERMISSIONS.settingsManage,
      PERMISSIONS.documentsPrint,
      PERMISSIONS.documentsReadAll,
      PERMISSIONS.disciplinaryManage,
      PERMISSIONS.sectionPayroll,
      PERMISSIONS.sectionCashierClosing,
      PERMISSIONS.sectionReports,
      PERMISSIONS.sectionEmployeeFile,
      PERMISSIONS.sectionInventory,
      PERMISSIONS.sectionSettings,
      PERMISSIONS.sectionDocuments,
    ],
  },
  {
    /** مدير الفرع: يصحّح انصراف الورديات المُقفلة تلقائياً، لكن بلا إدخال يدوي كامل. */
    name: "branch_manager",
    nameAr: "مدير فرع",
    description: "إدارة موظفي الفرع وحضورهم واعتماد طلباتهم",
    permissions: [
      PERMISSIONS.attendanceCheckIn,
      PERMISSIONS.attendanceReadOwn,
      PERMISSIONS.attendanceReadAll,
      PERMISSIONS.attendanceApprove,
      PERMISSIONS.attendanceCorrectCheckout,
      PERMISSIONS.employeesRead,
      PERMISSIONS.branchesRead,
      PERMISSIONS.branchesWrite,
      PERMISSIONS.reportsView,
      PERMISSIONS.formsSubmit,
      PERMISSIONS.formsReadOwn,
      PERMISSIONS.formsReadAll,
      PERMISSIONS.formsApprove,
      PERMISSIONS.custodyManage,
      PERMISSIONS.cashierSubmit,
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.cashierReview,
      PERMISSIONS.inventoryRead,
      PERMISSIONS.inventoryWrite,
      PERMISSIONS.inventoryItemsManage,
      PERMISSIONS.documentsPrint,
      PERMISSIONS.documentsReadAll,
      PERMISSIONS.disciplinaryManage,
      PERMISSIONS.sectionReports,
      PERMISSIONS.sectionCashierClosing,
      PERMISSIONS.sectionEmployeeFile,
      PERMISSIONS.sectionInventory,
      PERMISSIONS.sectionDocuments,
    ],
  },
  {
    name: "shift_supervisor",
    nameAr: "مشرف وردية",
    description: "متابعة حضور الوردية والطلبات",
    permissions: [
      PERMISSIONS.attendanceCheckIn,
      PERMISSIONS.attendanceReadOwn,
      PERMISSIONS.attendanceReadAll,
      PERMISSIONS.employeesRead,
      PERMISSIONS.branchesRead,
      PERMISSIONS.formsSubmit,
      PERMISSIONS.formsReadOwn,
      PERMISSIONS.formsReadAll,
      PERMISSIONS.cashierSubmit,
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.inventoryRead,
      PERMISSIONS.inventoryWrite,
      PERMISSIONS.sectionPayroll,
      PERMISSIONS.sectionEmployeeFile,
      PERMISSIONS.sectionInventory,
    ],
  },
  {
    name: "staff",
    nameAr: "موظف",
    description: "تسجيل الحضور وعرض سجله ونماذجه الشخصية",
    permissions: [
      PERMISSIONS.attendanceCheckIn,
      PERMISSIONS.attendanceReadOwn,
      PERMISSIONS.branchesRead,
      PERMISSIONS.formsSubmit,
      PERMISSIONS.formsReadOwn,
      /**
       * الكاشير يرفع تقفيله اليومي بنفسه؛ ولمنع موظف بعينه من ذلك
       * يُستخدم التخصيص الفردي (`deny cashier.submit`).
       */
      PERMISSIONS.cashierSubmit,
      /**
       * الموظف يرى مسيّرات رواتبه وملفه الشخصي بشكل افتراضي؛ وللموارد البشرية
       * تعطيل أي قسم منها لموظف بعينه عبر التخصيص الفردي (`deny`).
       */
      PERMISSIONS.sectionPayroll,
      PERMISSIONS.sectionEmployeeFile,
    ],
  },
];

function seedNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(env(name) ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * بذر البيانات الأساسية. العملية idempotent بالكامل: تستخدم
 * `ON CONFLICT DO NOTHING` فلا تُكرّر الصفوف ولا تُعيد كتابة أي تعديل لاحق.
 */
async function runSeed(): Promise<void> {
  const db = getDb();

  await db.insert(permissions).values(PERMISSION_CATALOG).onConflictDoNothing();

  await db
    .insert(roles)
    .values(
      ROLE_SEED.map(({ name, nameAr, description }) => ({
        name,
        nameAr,
        description,
      })),
    )
    .onConflictDoNothing();

  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const allPermissions = await db
    .select({ id: permissions.id, code: permissions.code })
    .from(permissions);

  const roleIdByName = new Map(allRoles.map((r) => [r.name, r.id]));
  const permissionIdByCode = new Map(allPermissions.map((p) => [p.code, p.id]));

  const links = ROLE_SEED.flatMap((role) => {
    const roleId = roleIdByName.get(role.name);
    if (!roleId) return [];
    return role.permissions.flatMap((code) => {
      const permissionId = permissionIdByCode.get(code);
      return permissionId ? [{ roleId, permissionId }] : [];
    });
  });

  if (links.length > 0) {
    await db.insert(rolePermissions).values(links).onConflictDoNothing();
  }

  // الفرع الافتراضي — إحداثياته قابلة للتعديل عبر متغيّرات البيئة أو الواجهة
  await db
    .insert(branches)
    .values({
      code: "BR-001",
      name: env("SEED_BRANCH_NAME") ?? "الفرع الرئيسي",
      address: env("SEED_BRANCH_ADDRESS") ?? "الرياض، المملكة العربية السعودية",
      latitude: seedNumber("SEED_BRANCH_LAT", 24.7136),
      longitude: seedNumber("SEED_BRANCH_LNG", 46.6753),
      radiusMeters: Math.round(seedNumber("SEED_BRANCH_RADIUS_METERS", 150)),
    })
    .onConflictDoNothing();

  const [branch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(sql`${branches.code} = 'BR-001'`)
    .limit(1);

  const passwordHash = hashPassword(getSeedPassword());

  /**
   * البيانات التجريبية (حسابات العرض وتعريفات رواتبها وجداولها وأصناف
   * المخزون الافتراضية) تُبذر مرة واحدة فقط. وإذا حذفها المسؤول من لوحة
   * الإعدادات يُضبط العلم `demo_data_purged` فلا تُعاد في أي إقلاع لاحق —
   * وإلا لعادت مع أول طلب بعد الحذف.
   */
  const demoPurged = await isFlagOn(DEMO_PURGED_FLAG);

  if (!demoPurged) {
    await db
      .insert(employees)
      .values([
        {
          employeeCode: "EMP-1000",
          fullName: "سالم المدير",
          email: "manager@restaurant-hr.local",
          phone: "0500000000",
          nationality: "سعودي",
          nationalId: "1000000000",
          department: "الإدارة",
          passwordHash,
          jobTitle: "مدير الفرع",
          roleId: roleIdByName.get("branch_manager") ?? null,
          branchId: branch?.id ?? null,
          hiredAt: new Date(),
        },
        {
          employeeCode: "EMP-1001",
          fullName: "أحمد الموظف",
          email: "staff@restaurant-hr.local",
          phone: "0500000001",
          nationality: "سعودي",
          nationalId: "1000000001",
          department: "الكاشير",
          passwordHash,
          jobTitle: "كاشير",
          roleId: roleIdByName.get("staff") ?? null,
          branchId: branch?.id ?? null,
          hiredAt: new Date(),
        },
        {
          employeeCode: "EMP-1002",
          fullName: "نورة الموارد البشرية",
          email: "hr@restaurant-hr.local",
          phone: "0500000002",
          nationality: "سعودي",
          nationalId: "1000000002",
          department: "الموارد البشرية",
          passwordHash,
          jobTitle: "مدير الموارد البشرية",
          roleId: roleIdByName.get("hr_manager") ?? null,
          branchId: branch?.id ?? null,
          hiredAt: new Date(),
        },
      ])
      .onConflictDoNothing();

    // تعريفات رواتب تجريبية للحسابات المبذورة حتى يعمل مسير الرواتب من أول تشغيل
    const seededEmployees = await db
      .select({ id: employees.id, code: employees.employeeCode })
      .from(employees)
      .where(sql`${employees.employeeCode} in ('EMP-1000', 'EMP-1001', 'EMP-1002')`);

    const demoSalaries: Record<string, { basic: number; housing: number; transport: number }> =
      {
        "EMP-1000": { basic: 9000, housing: 1500, transport: 500 },
        "EMP-1001": { basic: 4500, housing: 750, transport: 300 },
        "EMP-1002": { basic: 11000, housing: 2000, transport: 600 },
      };

    const salaryRows = seededEmployees.flatMap((employee) => {
      const demo = demoSalaries[employee.code];
      if (!demo) return [];
      return [
        {
          employeeId: employee.id,
          basicSalary: demo.basic,
          housingAllowance: demo.housing,
          transportAllowance: demo.transport,
          note: "تعريف راتب تجريبي — عدّله من شاشة الموارد البشرية.",
        },
      ];
    });

    if (salaryRows.length > 0) {
      await db.insert(salaryDefinitions).values(salaryRows).onConflictDoNothing();
    }

    // جداول دوام تجريبية (8 ساعات، إجازتان أسبوعياً = 4 أيام شهرياً: الجمعة والسبت)
    const scheduleRows = seededEmployees.map((employee) => ({
      employeeId: employee.id,
      shiftStart: "09:00",
      shiftEnd: "17:00",
      dailyHours: 8,
      daysOffPerMonth: 4,
      offDays: "5,6",
      graceMinutes: 10,
      note: "جدول دوام تجريبي — عدّله من شاشة الموارد البشرية.",
    }));

    if (scheduleRows.length > 0) {
      await db.insert(workSchedules).values(scheduleRows).onConflictDoNothing();
    }

    // مدير الفرع الافتراضي — يُضبط مرة واحدة فقط ولا يُعاد كتابته بعد أي تعديل
    const manager = seededEmployees.find((item) => item.code === "EMP-1000");
    if (branch && manager) {
      await db
        .update(branches)
        .set({ managerEmployeeId: manager.id })
        .where(and(eq(branches.id, branch.id), isNull(branches.managerEmployeeId)));
    }
  }

  // ------------------------------------------------- إعدادات المؤسسة والمطبوعات
  // صف واحد (`default`) يُنشأ مرة واحدة ثم يُعدَّل من لوحة الإعدادات.
  await db
    .insert(companySettings)
    .values({
      settingsKey: "default",
      companyName: env("SEED_COMPANY_NAME") ?? "مؤسسة المطعم",
      address: env("SEED_BRANCH_ADDRESS") ?? "الرياض، المملكة العربية السعودية",
      city: "الرياض",
      footerText: "هذا المستند صادر إلكترونياً من نظام سِجل لإدارة موظفي المطعم.",
      footerNote: "للاستفسار: الموارد البشرية",
    })
    .onConflictDoNothing();

  // ------------------------------------------- كيانات لوحة الإعدادات الأساسية
  await db
    .insert(departments)
    .values([
      { name: "الإدارة", branchId: branch?.id ?? null },
      { name: "الموارد البشرية", branchId: branch?.id ?? null },
      { name: "المطبخ", branchId: branch?.id ?? null },
      { name: "الكاشير", branchId: branch?.id ?? null },
      { name: "الصالة والتقديم", branchId: branch?.id ?? null },
      { name: "التوصيل", branchId: branch?.id ?? null },
    ])
    .onConflictDoNothing();

  await db
    .insert(jobTitles)
    .values([
      { name: "مدير الفرع", defaultBasicSalary: 9000 },
      { name: "مدير الموارد البشرية", defaultBasicSalary: 11000 },
      { name: "مشرف وردية", defaultBasicSalary: 6000 },
      { name: "كاشير", defaultBasicSalary: 4500 },
      { name: "طاهي", defaultBasicSalary: 5000 },
      { name: "مساعد طاهي", defaultBasicSalary: 3800 },
      { name: "عامل تقديم", defaultBasicSalary: 3500 },
      { name: "سائق توصيل", defaultBasicSalary: 4000 },
    ])
    .onConflictDoNothing();

  await db
    .insert(salaryComponents)
    .values([
      { code: "HOUSING", name: "بدل سكن", kind: "allowance", calculation: "percent", defaultValue: 25 },
      { code: "TRANSPORT", name: "بدل نقل", kind: "allowance", calculation: "fixed", defaultValue: 300 },
      { code: "FOOD", name: "بدل إعاشة", kind: "allowance", calculation: "fixed", defaultValue: 200 },
      { code: "OTHER_ALLOWANCE", name: "بدلات أخرى", kind: "allowance", calculation: "fixed" },
      { code: "GOSI", name: "التأمينات الاجتماعية", kind: "deduction", calculation: "percent", defaultValue: 9.75 },
      { code: "ADVANCE", name: "خصم سلفة", kind: "deduction", calculation: "fixed" },
      { code: "PENALTY", name: "خصم جزائي", kind: "deduction", calculation: "fixed" },
    ])
    .onConflictDoNothing();

  // أصناف مخزون افتراضية حتى تعمل شاشة المخزون من أول تشغيل
  if (!demoPurged) {
    await db
      .insert(inventoryItems)
      .values([
        { code: "ITM-001", name: "دقيق", category: "مواد أولية", unit: "كجم", unitCost: 4, minQuantity: 25 },
        { code: "ITM-002", name: "زيت قلي", category: "مواد أولية", unit: "لتر", unitCost: 12, minQuantity: 20 },
        { code: "ITM-003", name: "دجاج طازج", category: "مواد أولية", unit: "كجم", unitCost: 18, minQuantity: 30 },
        { code: "ITM-004", name: "علب تغليف", category: "مستهلكات", unit: "علبة", unitCost: 0.7, minQuantity: 200 },
        { code: "ITM-005", name: "أكياس", category: "مستهلكات", unit: "كيس", unitCost: 0.2, minQuantity: 300 },
      ])
      .onConflictDoNothing();
  }
}

/**
 * يُعيد بذر البيانات التجريبية عند الطلب (بعد إلغاء علم الحذف) — يستخدمه
 * مسار «إعادة البيانات التجريبية» في لوحة الإعدادات.
 */
export async function reseedNow(): Promise<void> {
  seedPromise = undefined;
  await ensureSeeded();
}

let seedPromise: Promise<void> | undefined;

/**
 * يُنفّذ البذر مرة واحدة لكل نسخة من الخادم (عند الإقلاع/أول طلب).
 * الترحيلات نفسها تُطبّقها منصّة Netlify تلقائياً قبل نشر أي إصدار.
 */
export function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((error) => {
      seedPromise = undefined; // اسمح بإعادة المحاولة في الطلب التالي
      throw error;
    });
  }
  return seedPromise;
}
