import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lt, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../db/index.js";
import {
  advances,
  attendanceLogs,
  bonuses,
  branches,
  cashierClosings,
  contracts,
  custodyItems,
  departments,
  disciplinaryActions,
  documentIssues,
  employees,
  leaveRequests,
  overtimeRequests,
  payrollSlips,
  roles,
  salaryDefinitions,
  vouchers,
  workSchedules,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { DEMO_EMPLOYEE_CODES } from "../demo.js";
import { PERMISSIONS, hasAnyPermission, requirePermission } from "../rbac.js";
import { CHECK_IN, CHECK_OUT, EFFECTIVE_STATUSES } from "../shifts.js";
import {
  isoDateInZone,
  monthKey,
  monthRangeInZone,
  safeTimeZone,
  wallPartsInZone,
} from "../time.js";
import {
  asDateOnly,
  asEnum,
  asId,
  asMonthKey,
  asNumber,
  asString,
  round2,
} from "../validate.js";
import { getOffDates, monthBounds, offScheduleLabel } from "../schedule.js";
import { loadLines as loadCashierLines } from "./cashier.js";
import { loadCompanySettings } from "./settings.js";

export const documentsRouter = Router();

/**
 * تنبيه قانوني عام يظهر على كل مستند ذي صياغة قانونية (العقد، الـNDA،
 * الإنذار، الإقرارات). النظام لا يقدّم استشارة قانونية.
 */
export const LEGAL_NOTICE =
  "هذا النموذج صيغة عامة لأغراض تنظيمية داخلية، وليس استشارة قانونية رسمية. " +
  "يُنصح بمراجعته من مستشار قانوني مختص ومطابقته لأحكام نظام العمل واللوائح " +
  "السارية في بلد التشغيل قبل الاعتماد أو التوقيع.";

const WARNING_LEVELS = ["notice", "first", "second", "final", "suspension"] as const;
const DISCIPLINARY_STATUSES = ["draft", "issued", "acknowledged", "cancelled"] as const;

interface DocSpec {
  key: string;
  title: string;
  group: string;
  description: string;
  /** هل يحتاج اختيار موظف؟ معظم النماذج هنا تُملأ من ملف موظف */
  needsEmployee: boolean;
  /** الجدول المرجعي الذي يُختار منه سجل (إن وُجد) */
  refType: string | null;
  refLabel: string;
  /** هل يحتاج شهراً بصيغة YYYY-MM؟ */
  needsMonth: boolean;
  /** هل تظهر عليه صياغة قانونية عامة؟ */
  legal: boolean;
  /** هل يحتاج اختيار فرع (نماذج تشمل كل موظفي الفرع)؟ */
  needsBranch?: boolean;
  /** هل يحتاج تاريخ يوم واحد؟ */
  needsDate?: boolean;
  /** هل يحتاج مدى تاريخي (من / إلى)؟ */
  needsRange?: boolean;
  /** لا يظهر في قائمة حزمة النماذج — تفتحه شاشته الخاصة (زر طباعة) */
  hidden?: boolean;
  /**
   * صلاحيات مطلوبة للنماذج غير المخصّصة لموظف بعينه (كشوف الفرع والكاشير).
   * يكفي امتلاك واحدة منها.
   */
  permissions?: readonly string[];
}

/**
 * حزمة النماذج القابلة للطباعة. الواجهة تبني القائمة من هذا الوصف،
 * وصفحة الطباعة تعرف من `key` أي قالب ترسم.
 */
export const DOC_CATALOG: DocSpec[] = [
  {
    key: "contract",
    title: "عقد عمل",
    group: "التعاقد والتعيين",
    description: "عقد عمل كامل بصياغة قانونية عامة يُملأ من ملف الموظف وتعريف راتبه.",
    needsEmployee: true,
    refType: "contracts",
    refLabel: "عقد مسجَّل (اختياري)",
    needsMonth: false,
    legal: true,
  },
  {
    key: "nda",
    title: "اتفاقية سرية (NDA)",
    group: "التعاقد والتعيين",
    description: "اتفاقية حفاظ على سرية الوصفات والأسعار وبيانات العملاء والمورّدين.",
    needsEmployee: true,
    refType: null,
    refLabel: "",
    needsMonth: false,
    legal: true,
  },
  {
    key: "appointment",
    title: "نموذج تعيين موظف",
    group: "التعاقد والتعيين",
    description: "قرار/نموذج تعيين يوضّح المسمى والقسم والفرع والراتب وتاريخ المباشرة.",
    needsEmployee: true,
    refType: null,
    refLabel: "",
    needsMonth: false,
    legal: true,
  },
  {
    key: "warning",
    title: "إنذار تأديبي",
    group: "الانضباط",
    description: "إنذار موثَّق بوصف الواقعة والإجراء المتخذ وإقرار الموظف بالاستلام.",
    needsEmployee: true,
    refType: "disciplinary_actions",
    refLabel: "إنذار مسجَّل",
    needsMonth: false,
    legal: true,
  },
  {
    key: "salary_receipt",
    title: "إقرار استلام راتب",
    group: "المالية",
    description: "إقرار باستلام صافي راتب شهر محدّد مع تفصيل المسير.",
    needsEmployee: true,
    refType: "payroll_slips",
    refLabel: "مسير راتب",
    needsMonth: true,
    legal: true,
  },
  {
    key: "receipt_voucher",
    title: "سند قبض",
    group: "المالية",
    description: "سند قبض مبلغ من الموظف أو لصالح المؤسسة.",
    needsEmployee: false,
    refType: "vouchers",
    refLabel: "سند قبض",
    needsMonth: false,
    legal: false,
  },
  {
    key: "payment_voucher",
    title: "سند صرف",
    group: "المالية",
    description: "سند صرف مبلغ للموظف أو لجهة أخرى.",
    needsEmployee: false,
    refType: "vouchers",
    refLabel: "سند صرف",
    needsMonth: false,
    legal: false,
  },
  {
    key: "advance",
    title: "طلب سلفة مالية",
    group: "المالية",
    description: "طلب سلفة مع شهر الخصم وإقرار الموظف بالخصم من الراتب.",
    needsEmployee: true,
    refType: "advances",
    refLabel: "طلب سلفة",
    needsMonth: false,
    legal: false,
  },
  {
    key: "bonus",
    title: "نموذج مكافأة",
    group: "المالية",
    description: "قرار صرف مكافأة بمبلغ وسبب وتاريخ.",
    needsEmployee: true,
    refType: "bonuses",
    refLabel: "مكافأة",
    needsMonth: false,
    legal: false,
  },
  {
    key: "custody",
    title: "نموذج إخراج عهدة",
    group: "العهد والمستندات",
    description: "تسليم عهدة (جهاز، زي، مفاتيح) بإقرار مسؤولية الموظف عنها.",
    needsEmployee: true,
    refType: "custody_items",
    refLabel: "عهدة",
    needsMonth: false,
    legal: true,
  },
  {
    key: "leave",
    title: "طلب إجازة رسمي",
    group: "الدوام والإجازات",
    description: "طلب إجازة بنوعها ومدتها وموافقة المسؤول.",
    needsEmployee: true,
    refType: "leave_requests",
    refLabel: "طلب إجازة",
    needsMonth: false,
    legal: false,
  },
  {
    key: "overtime",
    title: "نموذج أوفر تايم",
    group: "الدوام والإجازات",
    description: "توثيق ساعات العمل الإضافي وسببها واعتمادها.",
    needsEmployee: true,
    refType: "overtime_requests",
    refLabel: "طلب أوفرتايم",
    needsMonth: false,
    legal: false,
  },
  {
    key: "attendance_sheet",
    title: "كشف حضور شهري للتوقيع",
    group: "الدوام والإجازات",
    description: "كشف بأيام الشهر وأوقات الحضور والانصراف وخانة توقيع يدوي لكل يوم.",
    needsEmployee: true,
    refType: null,
    refLabel: "",
    needsMonth: true,
    legal: false,
  },
  {
    key: "attendance_roster_sheet",
    title: "ملف تحضير و الانصراف",
    group: "الدوام والإجازات",
    description:
      "كشف بكل الموظفين (الرقم الوظيفي، الاسم، الإقامة) مع خانات فارغة لوقت الحضور والتوقيع، " +
      "ووقت الانصراف والتوقيع، والملاحظات — يُطبع ويُعبّأ باليد في الفرع.",
    needsEmployee: false,
    refType: null,
    refLabel: "",
    needsMonth: false,
    legal: false,
    needsBranch: true,
    needsDate: true,
  },
  {
    key: "cashier_closing",
    title: "تقفيل كاشير — يوم واحد",
    group: "الكاشير",
    description: "طباعة تقفيل مرفوع بكل بنوده (الشبكات، شبكة foodics، تطبيقات التواصل).",
    needsEmployee: false,
    refType: null,
    refLabel: "",
    needsMonth: false,
    legal: false,
    hidden: true,
    permissions: [
      PERMISSIONS.cashierSubmit,
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.cashierReview,
    ],
  },
  {
    key: "cashier_closings_range",
    title: "تقفيلات الكاشير — يومي / شهري / مدى",
    group: "الكاشير",
    description: "كشف تقفيلات لفترة محدّدة مع إجماليّاتها وبنود الشبكة والتطبيقات.",
    needsEmployee: false,
    refType: null,
    refLabel: "",
    needsMonth: false,
    legal: false,
    needsBranch: true,
    needsRange: true,
    hidden: true,
    permissions: [
      PERMISSIONS.cashierSubmit,
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.cashierReview,
    ],
  },
];

const DOC_BY_KEY = new Map(DOC_CATALOG.map((doc) => [doc.key, doc]));

/* ── بيانات الموظف المُجمّعة للتعبئة التلقائية ─────────────────── */

async function loadEmployeeBundle(employeeId: number) {
  const db = getDb();
  const manager = alias(employees, "branch_manager");

  const [row] = await db
    .select({
      employee: employees,
      roleName: roles.nameAr,
      branch: branches,
      managerName: manager.fullName,
      managerJobTitle: manager.jobTitle,
    })
    .from(employees)
    .leftJoin(roles, eq(employees.roleId, roles.id))
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .leftJoin(manager, eq(branches.managerEmployeeId, manager.id))
    .where(eq(employees.id, employeeId))
    .limit(1);

  if (!row) return null;

  const [salary] = await db
    .select()
    .from(salaryDefinitions)
    .where(eq(salaryDefinitions.employeeId, employeeId))
    .limit(1);

  const [schedule] = await db
    .select()
    .from(workSchedules)
    .where(eq(workSchedules.employeeId, employeeId))
    .limit(1);

  // أيام الراحة قد تكون تواريخ محدّدة بدل أيام أسبوعية متكرّرة
  const scheduleOffDatesList =
    schedule && schedule.offMode === "dates" ? await getOffDates(employeeId) : [];

  const [department] = row.employee.department
    ? await db
        .select({ name: departments.name })
        .from(departments)
        .where(eq(departments.name, row.employee.department))
        .limit(1)
    : [];

  const allowances = salary
    ? round2(
        salary.housingAllowance + salary.transportAllowance + salary.otherAllowances,
      )
    : 0;

  return {
    employee: {
      id: row.employee.id,
      employeeCode: row.employee.employeeCode,
      fullName: row.employee.fullName,
      email: row.employee.email,
      phone: row.employee.phone,
      nationality: row.employee.nationality,
      nationalId: row.employee.nationalId,
      department: department?.name ?? row.employee.department,
      jobTitle: row.employee.jobTitle,
      roleName: row.roleName,
      hiredAt: row.employee.hiredAt,
      isActive: row.employee.isActive,
    },
    branch: row.branch
      ? {
          id: row.branch.id,
          code: row.branch.code,
          name: row.branch.name,
          address: row.branch.address,
          timezone: row.branch.timezone,
          managerName: row.managerName,
          managerJobTitle: row.managerJobTitle,
        }
      : null,
    salary: salary
      ? {
          basicSalary: salary.basicSalary,
          housingAllowance: salary.housingAllowance,
          transportAllowance: salary.transportAllowance,
          otherAllowances: salary.otherAllowances,
          allowancesTotal: allowances,
          totalPackage: round2(salary.basicSalary + allowances),
          currency: salary.currency,
          overtimeMultiplier: salary.overtimeMultiplier,
          contractHoursPerMonth: salary.contractHoursPerMonth,
          effectiveFrom: salary.effectiveFrom,
        }
      : null,
    schedule: schedule
      ? {
          shiftStart: schedule.shiftStart,
          shiftEnd: schedule.shiftEnd,
          dailyHours: schedule.dailyHours,
          breakMinutes: schedule.breakMinutes,
          daysOffPerMonth: schedule.daysOffPerMonth,
          offMode: schedule.offMode,
          offDays: schedule.offDays,
          offDates: scheduleOffDatesList,
          offDaysLabel: offScheduleLabel({ ...schedule, offDates: scheduleOffDatesList }),
          graceMinutes: schedule.graceMinutes,
        }
      : null,
  };
}

/** السجل المرجعي المطلوب لنموذج معيّن (سلفة، سند، عهدة ...). */
async function loadReference(
  refType: string,
  refId: number,
): Promise<Record<string, unknown> | null> {
  const db = getDb();

  switch (refType) {
    case "contracts": {
      const [row] = await db.select().from(contracts).where(eq(contracts.id, refId)).limit(1);
      return row ?? null;
    }
    case "disciplinary_actions": {
      const [row] = await db
        .select()
        .from(disciplinaryActions)
        .where(eq(disciplinaryActions.id, refId))
        .limit(1);
      return row ?? null;
    }
    case "payroll_slips": {
      const [row] = await db
        .select()
        .from(payrollSlips)
        .where(eq(payrollSlips.id, refId))
        .limit(1);
      return row ?? null;
    }
    case "vouchers": {
      const [row] = await db.select().from(vouchers).where(eq(vouchers.id, refId)).limit(1);
      return row ?? null;
    }
    case "advances": {
      const [row] = await db.select().from(advances).where(eq(advances.id, refId)).limit(1);
      return row ?? null;
    }
    case "bonuses": {
      const [row] = await db.select().from(bonuses).where(eq(bonuses.id, refId)).limit(1);
      return row ?? null;
    }
    case "custody_items": {
      const [row] = await db
        .select()
        .from(custodyItems)
        .where(eq(custodyItems.id, refId))
        .limit(1);
      return row ?? null;
    }
    case "leave_requests": {
      const [row] = await db
        .select()
        .from(leaveRequests)
        .where(eq(leaveRequests.id, refId))
        .limit(1);
      return row ?? null;
    }
    case "overtime_requests": {
      const [row] = await db
        .select()
        .from(overtimeRequests)
        .where(eq(overtimeRequests.id, refId))
        .limit(1);
      return row ?? null;
    }
    default:
      return null;
  }
}

/**
 * كشف الحضور الشهري: كل أيام الشهر بتوقيت الفرع مع أول حضور وآخر انصراف
 * وعدد الساعات — والباقي خانات توقيع يدوي في المطبوعة.
 */
async function loadAttendanceSheet(
  employeeId: number,
  month: string,
  timezone: string,
): Promise<{
  month: string;
  days: Array<{
    date: string;
    weekday: number;
    checkIn: string | null;
    checkOut: string | null;
    hours: number;
    isOffDay: boolean;
  }>;
  totalHours: number;
  workedDays: number;
}> {
  const db = getDb();
  const [yearText, monthText] = month.split("-");
  const year = Number.parseInt(yearText ?? "", 10);
  const monthNumber = Number.parseInt(monthText ?? "", 10);
  const { start, end } = monthRangeInZone(year, monthNumber, timezone);

  const [logs, [schedule]] = await Promise.all([
    db
      .select({
        type: attendanceLogs.type,
        serverTime: attendanceLogs.serverTime,
      })
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.employeeId, employeeId),
          gte(attendanceLogs.serverTime, start),
          lt(attendanceLogs.serverTime, end),
          inArray(attendanceLogs.status, [...EFFECTIVE_STATUSES]),
        ),
      )
      .orderBy(asc(attendanceLogs.serverTime)),
    db
      .select({ offDays: workSchedules.offDays, offMode: workSchedules.offMode })
      .from(workSchedules)
      .where(eq(workSchedules.employeeId, employeeId))
      .limit(1),
  ]);

  const offDays = new Set(
    (schedule?.offDays ?? "")
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((value) => Number.isInteger(value)),
  );

  // نمط التواريخ المحدّدة: أيام الراحة تُقرأ من تقويم الموظف لا من يوم الأسبوع
  const offDateSet =
    schedule?.offMode === "dates"
      ? new Set(await getOffDates(employeeId, monthBounds(year, monthNumber)))
      : new Set<string>();

  const byDate = new Map<
    string,
    { checkIn: Date | null; checkOut: Date | null; hours: number }
  >();

  const timeText = (instant: Date) => {
    const parts = wallPartsInZone(instant, timezone);
    return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  };

  // نربط كل حضور بأول انصراف بعده ونُسند الوردية ليوم الحضور
  let openCheckIn: Date | null = null;
  for (const log of logs) {
    if (log.type === CHECK_IN) {
      openCheckIn = log.serverTime;
      const key = isoDateInZone(log.serverTime, timezone);
      const entry = byDate.get(key) ?? { checkIn: null, checkOut: null, hours: 0 };
      if (entry.checkIn === null) entry.checkIn = log.serverTime;
      byDate.set(key, entry);
      continue;
    }

    if (log.type === CHECK_OUT && openCheckIn !== null) {
      const key = isoDateInZone(openCheckIn, timezone);
      const entry = byDate.get(key) ?? { checkIn: openCheckIn, checkOut: null, hours: 0 };
      entry.checkOut = log.serverTime;
      const diff = log.serverTime.getTime() - openCheckIn.getTime();
      if (diff > 0) entry.hours = round2(entry.hours + diff / 3_600_000);
      byDate.set(key, entry);
      openCheckIn = null;
    }
  }

  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const days: Array<{
    date: string;
    weekday: number;
    checkIn: string | null;
    checkOut: string | null;
    hours: number;
    isOffDay: boolean;
  }> = [];

  let totalHours = 0;
  let workedDays = 0;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const entry = byDate.get(date);
    const hours = entry?.hours ?? 0;
    totalHours = round2(totalHours + hours);
    if (entry?.checkIn) workedDays += 1;

    days.push({
      date,
      weekday,
      checkIn: entry?.checkIn ? timeText(entry.checkIn) : null,
      checkOut: entry?.checkOut ? timeText(entry.checkOut) : null,
      hours,
      isOffDay: schedule?.offMode === "dates" ? offDateSet.has(date) : offDays.has(weekday),
    });
  }

  return { month, days, totalHours, workedDays };
}

/**
 * ملف تحضير و الانصراف: كل الموظفين النشطين (في فرع محدّد أو كل الفروع)
 * بالرقم الوظيفي والاسم والإقامة. أوقات الحضور والانصراف والتوقيعات
 * والملاحظات تبقى خانات فارغة تُعبّأ باليد في المطبوعة.
 */
async function loadRosterSheet(
  branchId: number | null,
  date: string,
): Promise<{
  date: string;
  branch: { id: number; name: string } | null;
  rows: Array<{
    employeeCode: string;
    fullName: string;
    nationalId: string;
    jobTitle: string;
    department: string;
    branchName: string;
  }>;
}> {
  const db = getDb();

  const filters: SQL[] = [eq(employees.isActive, true)];
  if (branchId !== null) filters.push(eq(employees.branchId, branchId));

  const rows = await db
    .select({
      employeeCode: employees.employeeCode,
      fullName: employees.fullName,
      nationalId: employees.nationalId,
      jobTitle: employees.jobTitle,
      department: employees.department,
      branchName: branches.name,
    })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(and(...filters))
    .orderBy(asc(employees.employeeCode))
    .limit(1000);

  let branch: { id: number; name: string } | null = null;
  if (branchId !== null) {
    const [found] = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);
    branch = found ?? null;
  }

  return {
    date,
    branch,
    rows: rows.map((row) => ({
      employeeCode: row.employeeCode,
      fullName: row.fullName,
      nationalId: row.nationalId ?? "",
      jobTitle: row.jobTitle,
      department: row.department,
      branchName: row.branchName ?? "",
    })),
  };
}

/**
 * تقفيلات الكاشير للطباعة: تقفيل واحد (`closingId`) أو كشف لفترة.
 * البنود المُضافة (الشبكات وتطبيقات التواصل) تُقرأ من `cashier_closing_lines`.
 */
async function loadCashierClosings(options: {
  closingId: number | null;
  branchId: number | null;
  employeeId: number | null;
  from: string | null;
  to: string | null;
}): Promise<{
  from: string | null;
  to: string | null;
  branch: { id: number; name: string } | null;
  closings: Array<Record<string, unknown>>;
  totals: Record<string, number>;
}> {
  const db = getDb();

  const filters: SQL[] = [];
  if (options.closingId !== null) filters.push(eq(cashierClosings.id, options.closingId));
  if (options.branchId !== null) filters.push(eq(cashierClosings.branchId, options.branchId));
  if (options.employeeId !== null) {
    filters.push(eq(cashierClosings.employeeId, options.employeeId));
  }
  if (options.from !== null) filters.push(gte(cashierClosings.businessDate, options.from));
  if (options.to !== null) filters.push(lte(cashierClosings.businessDate, options.to));

  const rows = await db
    .select({
      closing: cashierClosings,
      employeeName: employees.fullName,
      employeeCode: employees.employeeCode,
      branchName: branches.name,
    })
    .from(cashierClosings)
    .leftJoin(employees, eq(cashierClosings.employeeId, employees.id))
    .leftJoin(branches, eq(cashierClosings.branchId, branches.id))
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(asc(cashierClosings.businessDate), asc(cashierClosings.employeeId))
    .limit(500);

  const lines = await loadCashierLines(rows.map((row) => row.closing.id));

  const totals = {
    count: rows.length,
    totalSales: 0,
    cashSales: 0,
    cardSales: 0,
    foodicsSales: 0,
    transferSales: 0,
    deliverySales: 0,
    otherSales: 0,
    discounts: 0,
    refunds: 0,
    expenses: 0,
    countedCash: 0,
    expectedCash: 0,
    difference: 0,
    invoiceCount: 0,
  };

  const closings = rows.map((row) => {
    for (const key of Object.keys(totals)) {
      if (key === "count") continue;
      const value = (row.closing as unknown as Record<string, number>)[key];
      if (typeof value === "number") {
        totals[key as keyof typeof totals] = round2(totals[key as keyof typeof totals] + value);
      }
    }

    return {
      ...row.closing,
      employeeName: row.employeeName,
      employeeCode: row.employeeCode,
      branchName: row.branchName,
      lines: lines.get(row.closing.id) ?? [],
    };
  });

  let branch: { id: number; name: string } | null = null;
  if (options.branchId !== null) {
    const [found] = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.id, options.branchId))
      .limit(1);
    branch = found ?? null;
  }

  return { from: options.from, to: options.to, branch, closings, totals };
}

/* ── دليل النماذج ──────────────────────────────────────────────── */

documentsRouter.get(
  "/documents/catalog",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const canPrint = await hasAnyPermission(req, [
      PERMISSIONS.documentsPrint,
      PERMISSIONS.formsReadAll,
    ]);

    res.json({
      ok: true,
      documents: DOC_CATALOG.filter((doc) => !doc.hidden),
      legalNotice: LEGAL_NOTICE,
      canPrintForOthers: canPrint,
      warningLevels: WARNING_LEVELS,
    });
  },
);

/**
 * بيانات نموذج جاهزة للطباعة: هوية المؤسسة + ملف الموظف + السجل المرجعي.
 * الموظف يستطيع طباعة نماذج ملفه هو؛ وطباعة نماذج الآخرين تحتاج
 * صلاحية `documents.print`.
 */
documentsRouter.get(
  "/documents/data",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const doc = DOC_BY_KEY.get(String(req.query.doc ?? ""));

    if (!doc) {
      res.status(404).json({ ok: false, error: "نموذج غير معروف" });
      return;
    }

    const requestedEmployeeId = asId(req.query.employeeId);
    const employeeId = requestedEmployeeId ?? (doc.needsEmployee ? actor.id : null);

    if (doc.needsEmployee && employeeId === null) {
      res.status(400).json({ ok: false, error: "اختر الموظف أولاً" });
      return;
    }

    const isSelf = employeeId !== null && employeeId === actor.id;
    const canPrintOthers = await hasAnyPermission(req, [
      PERMISSIONS.documentsPrint,
      PERMISSIONS.formsReadAll,
    ]);

    if (employeeId !== null && !isSelf && !canPrintOthers) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية طباعة نماذج موظف آخر" });
      return;
    }

    /**
     * النماذج الجماعية (كشف الفرع، تقفيلات الكاشير) لا تُخصّص لموظف،
     * فصلاحيتها تُفحص من وصف النموذج نفسه.
     */
    if (employeeId === null) {
      const required = doc.permissions ?? [
        PERMISSIONS.documentsPrint,
        PERMISSIONS.formsReadAll,
        PERMISSIONS.attendanceReadAll,
      ];
      if (!(await hasAnyPermission(req, [...required]))) {
        res.status(403).json({ ok: false, error: "لا تملك صلاحية طباعة هذا الكشف" });
        return;
      }
    }

    const bundle = employeeId === null ? null : await loadEmployeeBundle(employeeId);
    if (doc.needsEmployee && !bundle) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const timezone = safeTimeZone(bundle?.branch?.timezone ?? "Asia/Riyadh");

    let reference: Record<string, unknown> | null = null;
    if (doc.refType) {
      const refId = asId(req.query.refId);
      if (refId !== null) {
        reference = await loadReference(doc.refType, refId);
        if (!reference) {
          res.status(404).json({ ok: false, error: "السجل المرجعي غير موجود" });
          return;
        }
      }
    }

    // سند القبض/الصرف: نمنع خلط النوعين في نفس النموذج
    if (
      (doc.key === "receipt_voucher" || doc.key === "payment_voucher") &&
      reference &&
      reference.type !== (doc.key === "receipt_voucher" ? "receipt" : "payment")
    ) {
      res.status(400).json({ ok: false, error: "نوع السند لا يطابق النموذج المختار" });
      return;
    }

    let attendanceSheet: Awaited<ReturnType<typeof loadAttendanceSheet>> | null = null;
    let month: string | null = null;
    if (doc.needsMonth) {
      const parts = wallPartsInZone(new Date(), timezone);
      month = asMonthKey(req.query.month) ?? monthKey(parts.year, parts.month);
      if (doc.key === "attendance_sheet" && employeeId !== null) {
        attendanceSheet = await loadAttendanceSheet(employeeId, month, timezone);
      }
    }

    // مسير الراتب للشهر المطلوب إن لم يُحدَّد سجل بعينه
    if (doc.key === "salary_receipt" && !reference && employeeId !== null && month) {
      const db = getDb();
      const [yearText, monthText] = month.split("-");
      const [slip] = await db
        .select()
        .from(payrollSlips)
        .where(
          and(
            eq(payrollSlips.employeeId, employeeId),
            eq(payrollSlips.periodYear, Number.parseInt(yearText ?? "0", 10)),
            eq(payrollSlips.periodMonth, Number.parseInt(monthText ?? "0", 10)),
          ),
        )
        .limit(1);
      reference = slip ?? null;
    }

    const company = await loadCompanySettings();

    /* كشوف الفرع والكاشير: الفرع والتاريخ/المدى تُقرأ من الرابط */
    const requestedBranchId = asId(req.query.branchId);
    const branchId =
      doc.needsBranch || doc.key === "cashier_closing"
        ? (requestedBranchId ?? actor.branchId ?? null)
        : null;

    let sheetTimezone = timezone;
    if (branchId !== null) {
      const db = getDb();
      const [branchRow] = await db
        .select({ timezone: branches.timezone })
        .from(branches)
        .where(eq(branches.id, branchId))
        .limit(1);
      sheetTimezone = safeTimeZone(branchRow?.timezone ?? timezone);
    }

    const sheetToday = isoDateInZone(new Date(), sheetTimezone);

    let rosterSheet: Awaited<ReturnType<typeof loadRosterSheet>> | null = null;
    if (doc.key === "attendance_roster_sheet") {
      rosterSheet = await loadRosterSheet(
        branchId,
        asDateOnly(req.query.date) ?? sheetToday,
      );
    }

    let cashier: Awaited<ReturnType<typeof loadCashierClosings>> | null = null;
    if (doc.key === "cashier_closing" || doc.key === "cashier_closings_range") {
      // من لا يملك الاطّلاع الكامل يطبع تقفيلاته هو فقط
      const canReadAllClosings = await hasAnyPermission(req, [
        PERMISSIONS.cashierReadAll,
        PERMISSIONS.cashierReview,
        PERMISSIONS.reportsView,
      ]);
      const scopeEmployeeId = canReadAllClosings
        ? (asId(req.query.employeeId) ?? null)
        : actor.id;

      if (doc.key === "cashier_closing") {
        const closingId = asId(req.query.refId) ?? asId(req.query.closingId);
        if (closingId === null) {
          res.status(400).json({ ok: false, error: "لا يوجد تقفيل مرفوع لطباعته" });
          return;
        }
        cashier = await loadCashierClosings({
          closingId,
          branchId: null,
          employeeId: scopeEmployeeId,
          from: null,
          to: null,
        });
        if (cashier.closings.length === 0) {
          res.status(404).json({ ok: false, error: "التقفيل غير موجود أو لا تملك صلاحية طباعته" });
          return;
        }
      } else {
        const from = asDateOnly(req.query.from) ?? sheetToday;
        const to = asDateOnly(req.query.to) ?? from;
        if (to < from) {
          res.status(400).json({ ok: false, error: "تاريخ النهاية قبل تاريخ البداية" });
          return;
        }
        cashier = await loadCashierClosings({
          closingId: null,
          branchId,
          employeeId: scopeEmployeeId,
          from,
          to,
        });
      }
    }

    res.json({
      ok: true,
      doc,
      legalNotice: doc.legal ? LEGAL_NOTICE : "",
      company,
      month,
      attendanceSheet,
      rosterSheet,
      cashier,
      reference,
      ...(bundle ?? { employee: null, branch: null, salary: null, schedule: null }),
      // كشوف الفرع لا تملك حزمة موظف، فيُملأ الفرع من الكشف نفسه ليظهر في الترويسة
      ...(bundle ? {} : { branch: rosterSheet?.branch ?? cashier?.branch ?? null }),
      issuedBy: { id: actor.id, fullName: actor.fullName, jobTitle: actor.jobTitle },
      generatedAt: new Date().toISOString(),
      timezone: bundle ? timezone : sheetTimezone,
      today: bundle ? isoDateInZone(new Date(), timezone) : sheetToday,
    });
  },
);

/** السجلات المرجعية المتاحة لموظف في نموذج معيّن (لقائمة الاختيار). */
documentsRouter.get(
  "/documents/references",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const doc = DOC_BY_KEY.get(String(req.query.doc ?? ""));

    if (!doc) {
      res.status(404).json({ ok: false, error: "نموذج غير معروف" });
      return;
    }

    if (!doc.refType) {
      res.json({ ok: true, references: [] });
      return;
    }

    const employeeId = asId(req.query.employeeId) ?? actor.id;
    const isSelf = employeeId === actor.id;
    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.documentsPrint,
      PERMISSIONS.formsReadAll,
    ]);

    if (!isSelf && !canReadAll) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض سجلات موظف آخر" });
      return;
    }

    const describe = (id: number, label: string) => ({ id, label });
    let references: Array<{ id: number; label: string }> = [];

    switch (doc.refType) {
      case "contracts": {
        const rows = await db
          .select()
          .from(contracts)
          .where(eq(contracts.employeeId, employeeId))
          .orderBy(desc(contracts.startDate))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.contractNumber} — ${row.startDate}`),
        );
        break;
      }
      case "disciplinary_actions": {
        const rows = await db
          .select()
          .from(disciplinaryActions)
          .where(eq(disciplinaryActions.employeeId, employeeId))
          .orderBy(desc(disciplinaryActions.incidentDate))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.incidentDate} — ${row.level}`),
        );
        break;
      }
      case "payroll_slips": {
        const rows = await db
          .select()
          .from(payrollSlips)
          .where(eq(payrollSlips.employeeId, employeeId))
          .orderBy(desc(payrollSlips.periodYear), desc(payrollSlips.periodMonth))
          .limit(50);
        references = rows.map((row) =>
          describe(
            row.id,
            `${monthKey(row.periodYear, row.periodMonth)} — ${row.netPay} ${row.currency}`,
          ),
        );
        break;
      }
      case "vouchers": {
        const type = doc.key === "receipt_voucher" ? "receipt" : "payment";
        const rows = await db
          .select()
          .from(vouchers)
          .where(eq(vouchers.type, type))
          .orderBy(desc(vouchers.voucherDate))
          .limit(80);
        references = rows.map((row) =>
          describe(row.id, `${row.voucherNumber} — ${row.amount} — ${row.voucherDate}`),
        );
        break;
      }
      case "advances": {
        const rows = await db
          .select()
          .from(advances)
          .where(eq(advances.employeeId, employeeId))
          .orderBy(desc(advances.requestDate))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.requestDate} — ${row.amount} — ${row.status}`),
        );
        break;
      }
      case "bonuses": {
        const rows = await db
          .select()
          .from(bonuses)
          .where(eq(bonuses.employeeId, employeeId))
          .orderBy(desc(bonuses.bonusDate))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.bonusDate} — ${row.amount}`),
        );
        break;
      }
      case "custody_items": {
        const rows = await db
          .select()
          .from(custodyItems)
          .where(eq(custodyItems.employeeId, employeeId))
          .orderBy(desc(custodyItems.issuedAt))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.itemName} — ${row.issuedAt}`),
        );
        break;
      }
      case "leave_requests": {
        const rows = await db
          .select()
          .from(leaveRequests)
          .where(eq(leaveRequests.employeeId, employeeId))
          .orderBy(desc(leaveRequests.startDate))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.startDate} → ${row.endDate} — ${row.leaveType}`),
        );
        break;
      }
      case "overtime_requests": {
        const rows = await db
          .select()
          .from(overtimeRequests)
          .where(eq(overtimeRequests.employeeId, employeeId))
          .orderBy(desc(overtimeRequests.workDate))
          .limit(50);
        references = rows.map((row) =>
          describe(row.id, `${row.workDate} — ${row.hours} ساعة`),
        );
        break;
      }
      default:
        references = [];
    }

    res.json({ ok: true, references });
  },
);

/* ── سجل النماذج المُصدرة ──────────────────────────────────────── */

documentsRouter.post(
  "/documents/issues",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const doc = DOC_BY_KEY.get(String(body.docType ?? ""));

    if (!doc) {
      res.status(400).json({ ok: false, error: "نموذج غير معروف" });
      return;
    }

    const employeeId = asId(body.employeeId);
    const isSelf = employeeId === null || employeeId === actor.id;
    const canPrintOthers = await hasAnyPermission(req, [
      PERMISSIONS.documentsPrint,
      PERMISSIONS.formsReadAll,
    ]);

    if (!isSelf && !canPrintOthers) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية إصدار نماذج موظف آخر" });
      return;
    }

    let branchId = asId(body.branchId);
    if (branchId === null && employeeId !== null) {
      const [row] = await db
        .select({ branchId: employees.branchId })
        .from(employees)
        .where(eq(employees.id, employeeId))
        .limit(1);
      branchId = row?.branchId ?? null;
    }

    const payloadRaw = body.payload;
    let payload = "";
    if (payloadRaw !== undefined && payloadRaw !== null) {
      try {
        payload = JSON.stringify(payloadRaw).slice(0, 4000);
      } catch {
        payload = "";
      }
    }

    const [saved] = await db
      .insert(documentIssues)
      .values({
        docType: doc.key,
        title: asString(body.title, 200) ?? doc.title,
        employeeId,
        branchId,
        refType: doc.refType ?? "",
        refId: asId(body.refId),
        payload,
        notes: asString(body.notes, 1000) ?? "",
        issuedByEmployeeId: actor.id,
      })
      .returning();

    res.status(201).json({ ok: true, issue: saved });
  },
);

documentsRouter.get(
  "/documents/issues",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.documentsReadAll,
      PERMISSIONS.reportsView,
    ]);

    const employeeFilter = asId(req.query.employeeId);
    const docType = asString(req.query.doc, 60);
    const from = asDateOnly(req.query.from);
    const to = asDateOnly(req.query.to);

    const target = alias(employees, "doc_employee");
    const issuer = alias(employees, "doc_issuer");

    const conditions = [
      canReadAll
        ? employeeFilter === null
          ? undefined
          : eq(documentIssues.employeeId, employeeFilter)
        : eq(documentIssues.employeeId, actor.id),
      docType ? eq(documentIssues.docType, docType) : undefined,
      from === null ? undefined : gte(documentIssues.issuedAt, new Date(`${from}T00:00:00Z`)),
      to === null
        ? undefined
        : lte(documentIssues.issuedAt, new Date(`${to}T23:59:59.999Z`)),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        issue: documentIssues,
        employeeName: target.fullName,
        employeeCode: target.employeeCode,
        issuedByName: issuer.fullName,
        branchName: branches.name,
      })
      .from(documentIssues)
      .leftJoin(target, eq(documentIssues.employeeId, target.id))
      .leftJoin(issuer, eq(documentIssues.issuedByEmployeeId, issuer.id))
      .leftJoin(branches, eq(documentIssues.branchId, branches.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(documentIssues.issuedAt))
      .limit(300);

    res.json({
      ok: true,
      scope: canReadAll ? "all" : "own",
      issues: rows.map((row) => ({
        ...row.issue,
        docTitle: DOC_BY_KEY.get(row.issue.docType)?.title ?? row.issue.docType,
        employeeName: row.employeeName,
        employeeCode: row.employeeCode,
        issuedByName: row.issuedByName,
        branchName: row.branchName,
      })),
    });
  },
);

/**
 * حذف سطر واحد من سجل النماذج المُصدرة.
 *
 * السجل تاريخي، لكن التجربة تتركه مليئاً بمستندات وهمية، فيُتاح حذفها لمن
 * يملك صلاحية قراءة السجل كاملاً مع أثر في التدقيق.
 */
documentsRouter.delete(
  "/documents/issues/:id",
  requireAuth,
  requirePermission(PERMISSIONS.documentsReadAll),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(documentIssues)
      .where(eq(documentIssues.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "السجل غير موجود" });
      return;
    }

    await db.delete(documentIssues).where(eq(documentIssues.id, id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "document_issue.delete",
      entityType: "document_issues",
      entityId: id,
      before,
      reason: asString(req.body?.reason, 500) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف السجل من سجل النماذج المُصدرة." });
  },
);

/**
 * حذف جماعي لسجل النماذج المُصدرة: ما قبل تاريخ، أو ما صدر للحسابات
 * التجريبية، أو السجل كله. يتطلّب كتابة كلمة التأكيد.
 */
documentsRouter.post(
  "/documents/issues/purge",
  requireAuth,
  requirePermission(PERMISSIONS.documentsReadAll),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const scope = asEnum(req.body?.scope, ["before", "demo", "all"] as const) ?? "before";
    const confirm = asString(req.body?.confirm, 40) ?? "";

    if (confirm !== "حذف" && confirm.toUpperCase() !== "DELETE") {
      res.status(400).json({
        ok: false,
        error: "اكتب كلمة «حذف» للتأكيد — الحذف الجماعي لا يمكن الرجوع عنه.",
      });
      return;
    }

    let where: SQL | undefined;
    let describe = "كل السجل";

    if (scope === "before") {
      const before = asDateOnly(req.body?.before);
      if (before === null) {
        res.status(400).json({ ok: false, error: "حدّد التاريخ الذي يُحذف ما قبله." });
        return;
      }
      where = lt(documentIssues.issuedAt, new Date(`${before}T00:00:00.000Z`));
      describe = `قبل ${before}`;
    } else if (scope === "demo") {
      const demoRows = await db
        .select({ id: employees.id })
        .from(employees)
        .where(inArray(employees.employeeCode, [...DEMO_EMPLOYEE_CODES]));

      if (demoRows.length === 0) {
        res.status(400).json({
          ok: false,
          error: "لا توجد حسابات تجريبية في القاعدة — لا شيء لحذفه.",
        });
        return;
      }

      where = inArray(
        documentIssues.employeeId,
        demoRows.map((row) => row.id),
      );
      describe = "مستندات الحسابات التجريبية";
    }

    const removed = await db
      .delete(documentIssues)
      .where(where)
      .returning({ id: documentIssues.id });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "document_issue.purge",
      entityType: "document_issues",
      before: { scope, describe, ids: removed.map((item) => item.id) },
      after: { deleted: removed.length },
      reason: asString(req.body?.reason, 500) ?? `حذف جماعي: ${describe}`,
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      deleted: removed.length,
      scope,
      describe,
      message:
        removed.length === 0
          ? `لا توجد سجلات مطابقة (${describe}).`
          : `تم حذف ${removed.length} سجلاً من سجل النماذج المُصدرة (${describe}).`,
    });
  },
);

/* ── الإنذارات التأديبية ───────────────────────────────────────── */

documentsRouter.get(
  "/disciplinary",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.disciplinaryManage,
      PERMISSIONS.formsReadAll,
    ]);

    const employeeFilter = asId(req.query.employeeId);
    const conditions = [
      canReadAll
        ? employeeFilter === null
          ? undefined
          : eq(disciplinaryActions.employeeId, employeeFilter)
        : eq(disciplinaryActions.employeeId, actor.id),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        action: disciplinaryActions,
        employeeName: employees.fullName,
        employeeCode: employees.employeeCode,
      })
      .from(disciplinaryActions)
      .leftJoin(employees, eq(disciplinaryActions.employeeId, employees.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(disciplinaryActions.incidentDate))
      .limit(300);

    res.json({
      ok: true,
      scope: canReadAll ? "all" : "own",
      levels: WARNING_LEVELS,
      actions: rows.map((row) => ({
        ...row.action,
        employeeName: row.employeeName,
        employeeCode: row.employeeCode,
      })),
    });
  },
);

documentsRouter.post(
  "/disciplinary",
  requireAuth,
  requirePermission(PERMISSIONS.disciplinaryManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const employeeId = asId(body.employeeId);
    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "اختر الموظف" });
      return;
    }

    const incidentDate = asDateOnly(body.incidentDate);
    if (incidentDate === null) {
      res.status(400).json({ ok: false, error: "تاريخ الواقعة مطلوب بصيغة YYYY-MM-DD" });
      return;
    }

    const description = asString(body.incidentDescription, 2000) ?? "";
    if (description === "") {
      res.status(400).json({ ok: false, error: "وصف الواقعة مطلوب" });
      return;
    }

    const deductionRaw = asNumber(body.deductionAmount);
    const [saved] = await db
      .insert(disciplinaryActions)
      .values({
        employeeId,
        level: asEnum(body.level, WARNING_LEVELS) ?? "first",
        incidentDate,
        incidentDescription: description,
        violationType: asString(body.violationType, 120) ?? "other",
        actionTaken: asString(body.actionTaken, 1000) ?? "",
        deductionAmount: deductionRaw === null || deductionRaw < 0 ? 0 : round2(deductionRaw),
        status: asEnum(body.status, DISCIPLINARY_STATUSES) ?? "issued",
        notes: asString(body.notes, 1000) ?? "",
        createdByEmployeeId: actor.id,
      })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "disciplinary.create",
      entityType: "disciplinary_actions",
      entityId: saved?.id ?? null,
      after: saved,
      ipAddress: clientIp(req),
    });

    res.status(201).json({ ok: true, action: saved });
  },
);

documentsRouter.patch(
  "/disciplinary/:id",
  requireAuth,
  requirePermission(PERMISSIONS.disciplinaryManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الإنذار غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(disciplinaryActions)
      .where(eq(disciplinaryActions.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الإنذار غير موجود" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    const level = asEnum(body.level, WARNING_LEVELS);
    if (level !== null) patch.level = level;

    const status = asEnum(body.status, DISCIPLINARY_STATUSES);
    if (status !== null) {
      patch.status = status;
      if (status === "acknowledged" && !before.acknowledgedAt) {
        patch.acknowledgedAt = new Date();
      }
    }

    const incidentDate = asDateOnly(body.incidentDate);
    if (incidentDate !== null) patch.incidentDate = incidentDate;

    for (const [key, field, max] of [
      ["incidentDescription", "incidentDescription", 2000],
      ["violationType", "violationType", 120],
      ["actionTaken", "actionTaken", 1000],
      ["notes", "notes", 1000],
    ] as const) {
      if (!(key in body)) continue;
      const value = asString(body[key], max);
      if (value !== null) patch[field] = value;
    }

    const deduction = asNumber(body.deductionAmount);
    if (deduction !== null && deduction >= 0) patch.deductionAmount = round2(deduction);

    const [updated] = await db
      .update(disciplinaryActions)
      .set(patch)
      .where(eq(disciplinaryActions.id, id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "disciplinary.update",
      entityType: "disciplinary_actions",
      entityId: id,
      before,
      after: updated,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, action: updated });
  },
);

documentsRouter.delete(
  "/disciplinary/:id",
  requireAuth,
  requirePermission(PERMISSIONS.disciplinaryManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الإنذار غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(disciplinaryActions)
      .where(eq(disciplinaryActions.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الإنذار غير موجود" });
      return;
    }

    await db.delete(disciplinaryActions).where(eq(disciplinaryActions.id, id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "disciplinary.delete",
      entityType: "disciplinary_actions",
      entityId: id,
      before,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف الإنذار" });
  },
);
