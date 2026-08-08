import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  accessRules,
  branches,
  companySettings,
  departments,
  employees,
  inventoryItems,
  jobTitles,
  salaryComponents,
  salaryDefinitions,
  workSchedules,
} from "../db/schema.js";
import { env, getSeedPassword } from "./config.js";
import { DEMO_PURGED_FLAG, isFlagOn } from "./flags.js";
import { hashPassword } from "./passwords.js";
import {
  derivedModuleDelete,
  derivedModuleLevel,
  isDeleteAvailable,
  MODULE_CATALOG,
  PERMISSIONS,
} from "./rbac.js";

/** يُعاد تصديرها حفاظاً على التوافق مع الاستدعاءات السابقة. */
export { PERMISSIONS };

/**
 * قوالب بداية للحسابات التجريبية — لا «أدوار».
 *
 * لم يعد في النظام جدول أدوار ولا حقل دور: `access_rules` هي مصدر الصلاحيات
 * الوحيد. وهذه القوائم قوالب في الكود تُترجَم عند البذر إلى **قواعد صريحة
 * بنطاق «موظف محدّد»** للحسابات التجريبية وحدها، ثم لا يبقى لها أثر: تعديل
 * القالب بعد ذلك لا يغيّر صلاحية أحد، وتعديل قاعدة الموظف من شاشة الصلاحيات
 * لا يعود البذر فيكتبه (`ON CONFLICT DO NOTHING`).
 *
 * الترجمة تجري بنفس حساب ترحيل البيانات: درجة البند هي أعلى درجة يملك
 * القالب رمزاً واحداً على الأقل من رموزها، ودرجة الحذف مستقلة.
 */
const ACCESS_TEMPLATES: Record<string, string[]> = {
  /**
   * مدير الموارد البشرية هو الوحيد (مع من يُمنح مثله) الذي يملك
   * `attendance.manual_write`: إضافة/تعديل/حذف أي سجل حضور بكل حقوله.
   */
  hr_manager: [
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
    PERMISSIONS.sectionCashBook,
    PERMISSIONS.cashExpensesRead,
    PERMISSIONS.cashExpensesWrite,
    PERMISSIONS.settlementsRead,
    PERMISSIONS.settlementsManage,
    PERMISSIONS.settlementsConfirm,
    PERMISSIONS.monthlySummaryView,
    PERMISSIONS.monthlyCarryForward,
    PERMISSIONS.monthlyReset,
  ],
  /** مدير الفرع: يصحّح انصراف الورديات المُقفلة تلقائياً، لكن بلا إدخال يدوي كامل. */
  branch_manager: [
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
  staff: [
    PERMISSIONS.attendanceCheckIn,
    PERMISSIONS.attendanceReadOwn,
    PERMISSIONS.branchesRead,
    PERMISSIONS.formsSubmit,
    PERMISSIONS.formsReadOwn,
    /**
     * الكاشير يرفع تقفيله اليومي بنفسه؛ ولمنع موظف بعينه من ذلك تُسحب قاعدة
     * «تقفيل ورديتي» في شاشة الصلاحيات (درجة 0).
     */
    PERMISSIONS.cashierSubmit,
    /**
     * الموظف يرى مسيّرات رواتبه وملفه الشخصي بشكل افتراضي؛ ولمنع ذلك عن
     * موظف بعينه تُسحب قاعدة البند (درجة 0).
     */
    PERMISSIONS.sectionPayroll,
    PERMISSIONS.sectionEmployeeFile,
  ],
};

/** يترجم قالباً إلى قواعد صريحة بنطاق «موظف محدّد» جاهزة للإدراج. */
function templateRules(templateKey: string, employeeId: number) {
  const codes = new Set(ACCESS_TEMPLATES[templateKey] ?? []);
  const rows: Array<{
    scopeType: string;
    scopeKey: string;
    employeeId: number;
    moduleKey: string;
    level: number;
    canDelete: boolean;
    note: string;
  }> = [];

  for (const module of MODULE_CATALOG) {
    const level = derivedModuleLevel(module.key, codes);
    const canDelete = isDeleteAvailable(module.key) && derivedModuleDelete(module.key, codes);
    if (level === 0 && !canDelete) continue;
    rows.push({
      scopeType: "employee",
      scopeKey: String(employeeId),
      employeeId,
      moduleKey: module.key,
      level,
      canDelete,
      note: "قاعدة أولية للحساب التجريبي — عدّلها من شاشة الصلاحيات",
    });
  }

  return rows;
}

function seedNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(env(name) ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * بذر البيانات الأساسية. العملية idempotent بالكامل: تستخدم
 * `ON CONFLICT DO NOTHING` فلا تُكرّر الصفوف ولا تُعيد كتابة أي تعديل لاحق.
 */
async function runSeed(
  options: { forceDemoAccounts?: boolean } = {},
): Promise<void> {
  const db = getDb();

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

  /**
   * حارس إضافي: إن وُجد أي موظف في الملف فالنظام قيد الاستخدام فعلاً،
   * فلا تُبذر الحسابات التجريبية مرة أخرى. هذا يمنع عودة EMP-1000/1001/1002
   * بعد حذفها يدوياً من شاشة الموظفين ولو لم يُضبط العلم لأي سبب.
   */
  const [anyEmployee] = await db
    .select({ id: employees.id })
    .from(employees)
    .limit(1);

  const skipDemoAccounts =
    demoPurged || (!options.forceDemoAccounts && Boolean(anyEmployee));

  if (!skipDemoAccounts) {
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

    /**
     * صلاحيات الحسابات التجريبية تُكتب قواعد صريحة باسم كل حساب، فتبدأ
     * البيئة الجديدة وفيها حساب يفتح شاشة الصلاحيات (الموارد البشرية) بلا
     * حاجة إلى أي استنتاج من دور. والقواعد تُكتب مرة واحدة: أي تعديل لاحق
     * من الشاشة يبقى كما هو.
     */
    const demoTemplates: Record<string, string> = {
      "EMP-1000": "branch_manager",
      "EMP-1001": "staff",
      "EMP-1002": "hr_manager",
    };

    const ruleRows = seededEmployees.flatMap((employee) => {
      const template = demoTemplates[employee.code];
      return template ? templateRules(template, employee.id) : [];
    });

    if (ruleRows.length > 0) {
      await db.insert(accessRules).values(ruleRows).onConflictDoNothing();
    }

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
/**
 * بنود النقدية وإقفال الشهر التي يملكها الأونر افتراضياً.
 *
 * «الأونر» هنا هو من يملك بند «إدارة الصلاحيات» بدرجة التعديل — أي من بيده
 * منح الصلاحيات أصلاً. تُكتب له قواعد صريحة لهذه البنود مرة واحدة فقط
 * (ON CONFLICT DO NOTHING)، فيستطيع بعدها منحها أو سحبها من أي موظف من شاشة
 * «إدارة الصلاحيات» — وأي تعديل يجريه هناك لا يعود البذر فيكتبه.
 *
 * ومن لم تُمنح له هذه البنود لا يرى أزرار الترحيل والتصفير إطلاقاً، والخادم
 * يرفض طلبه لو استدعى المسار مباشرة.
 */
const CASH_CLOSING_GRANTS: Array<{
  moduleKey: string;
  level: number;
  canDelete: boolean;
}> = [
  { moduleKey: "cash_expenses", level: 3, canDelete: true },
  { moduleKey: "settlements", level: 4, canDelete: true },
  { moduleKey: "settlement_unconfirm", level: 1, canDelete: false },
  { moduleKey: "monthly_summary", level: 1, canDelete: false },
  { moduleKey: "monthly_carry_forward", level: 1, canDelete: false },
  { moduleKey: "monthly_reset", level: 1, canDelete: false },
];

/**
 * يمنح الأونر بنود النقدية وإقفال الشهر إن لم تكن ممنوحة له بعد.
 * إضافة خالصة: لا تُعدَّل قاعدة قائمة ولا تُسحب من أحد.
 */
export async function ensureCashClosingGrants(): Promise<void> {
  const db = getDb();

  const owners = await db
    .select({
      scopeType: accessRules.scopeType,
      scopeKey: accessRules.scopeKey,
      employeeId: accessRules.employeeId,
    })
    .from(accessRules)
    .where(
      and(eq(accessRules.moduleKey, "access_control"), gte(accessRules.level, 3)),
    );

  if (owners.length === 0) return;

  const rows = owners.flatMap((owner) =>
    CASH_CLOSING_GRANTS.map((grant) => ({
      scopeType: owner.scopeType,
      scopeKey: owner.scopeKey,
      employeeId: owner.employeeId,
      moduleKey: grant.moduleKey,
      level: grant.level,
      canDelete: grant.canDelete,
      note: "بند نقدية أولي للأونر — امنحه أو اسحبه من شاشة إدارة الصلاحيات",
    })),
  );

  await db.insert(accessRules).values(rows).onConflictDoNothing();
}

export async function reseedNow(): Promise<void> {
  // إعادة البيانات التجريبية طلب صريح من لوحة الإعدادات، فيتجاوز حارس «وجود موظفين».
  seedPromise = runSeed({ forceDemoAccounts: true })
    .then(ensureCashClosingGrants)
    .catch((error) => {
      seedPromise = undefined;
      throw error;
    });
  await seedPromise;
}

let seedPromise: Promise<void> | undefined;

/**
 * يُنفّذ البذر مرة واحدة لكل نسخة من الخادم (عند الإقلاع/أول طلب).
 * الترحيلات نفسها تُطبّقها منصّة Netlify تلقائياً قبل نشر أي إصدار.
 */
export function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed()
      // منح الأونر بنود النقدية وإقفال الشهر مرة واحدة (idempotent)
      .then(ensureCashClosingGrants)
      .catch((error) => {
        seedPromise = undefined; // اسمح بإعادة المحاولة في الطلب التالي
        throw error;
      });
  }
  return seedPromise;
}
