import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  advances,
  attendanceLogs,
  bonuses,
  branches,
  employees,
  overtimeRequests,
  payrollSlips,
  salaryDefinitions,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  hasAnyPermission,
  hasModuleLevel,
  PERMISSIONS,
  requireAnyPermission,
  requireModuleDelete,
  requireModuleLevel,
} from "../rbac.js";
import {
  evaluateShift,
  expectedMonthlyHours,
  getWorkSchedule,
  monthBounds,
} from "../schedule.js";
import { CHECK_IN, CHECK_OUT, EFFECTIVE_STATUSES } from "../shifts.js";
import { monthKey, monthRangeInZone, safeTimeZone } from "../time.js";
import { asId, asMonthKey, asNumber, asString, round2 } from "../validate.js";

/** بيانات مسير راتب شهري واحد قبل الحفظ. */
export interface PayrollComputation {
  employeeId: number;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  branchName: string | null;
  periodYear: number;
  periodMonth: number;
  period: string;
  currency: string;
  hourlyRate: number;
  contractHoursPerMonth: number;
  overtimeMultiplier: number;
  basicSalary: number;
  housingAllowance: number;
  transportAllowance: number;
  otherAllowances: number;
  allowancesTotal: number;
  workedHours: number;
  shiftsCount: number;
  openShiftsCount: number;
  /** الساعات المتوقّعة حسب جدول الدوام (0 = لا جدول مُعرَّف) */
  expectedHours: number;
  /** إجمالي دقائق التأخير في الشهر حسب جدول الدوام */
  lateMinutes: number;
  /** ساعات زائدة عن الجدول محسوبة من الحضور الفعلي (للعلم، لا تُصرف تلقائياً) */
  scheduleOvertimeHours: number;
  /** مصدر ساعات العقد: schedule = جدول الدوام، salary = تعريف الراتب، default = الافتراض القديم */
  contractHoursSource: "schedule" | "salary" | "default";
  overtimeHours: number;
  overtimeAmount: number;
  bonusesAmount: number;
  advancesAmount: number;
  deductedHours: number;
  hoursDeductionAmount: number;
  otherDeductions: number;
  netPay: number;
  hasSalaryDefinition: boolean;
  notes: string;
}

const DEFAULT_CONTRACT_HOURS = 240;

/** يزيد شهراً بصيغة `YYYY-MM` بمقدار `count` شهراً. */
function addMonths(period: string, count: number): string {
  const [year, month] = period.split("-").map(Number);
  const index = (year * 12 + (month - 1)) + count;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * قسط السلفة المستحق في شهر معيّن.
 *
 * `installmentMonths = 1` يخصم المبلغ كاملاً في شهر الخصم (السلوك السابق)،
 * وأكثر من ذلك يوزّعه بالتساوي بدءاً من شهر الخصم، والقسط الأخير يستوعب
 * فروق التقريب حتى لا يزيد مجموع الأقساط أو ينقص عن مبلغ السلفة.
 */
export function advanceInstallmentFor(
  advance: {
    amount: number | null;
    requestDate: string | null;
    deductionMonth: string | null;
    deductFromPayroll: boolean;
    installmentMonths?: number | null;
  },
  period: string,
): number {
  if (!advance.deductFromPayroll) return 0;

  const first = advance.deductionMonth || (advance.requestDate ?? "").slice(0, 7);
  if (!first) return 0;

  const total = round2(advance.amount ?? 0);
  const months = Math.max(1, Math.round(advance.installmentMonths ?? 1));

  for (let index = 0; index < months; index += 1) {
    if (addMonths(first, index) !== period) continue;
    const installment = round2(total / months);
    // القسط الأخير = المتبقي بعد الأقساط المتساوية السابقة
    return index === months - 1 ? round2(total - installment * (months - 1)) : installment;
  }

  return 0;
}

/**
 * ساعات العمل الفعلية = مجموع الفروق بين كل `check_in` وأول `check_out` بعده
 * داخل مدى الشهر بتوقيت الفرع. الورديات المفتوحة (بلا انصراف) تُحتسب صفراً
 * ويُذكر عددها في المسير حتى يعالجها المسؤول قبل الاعتماد.
 *
 * تُرجع أيضاً أزواج الورديات لتقييمها مقابل جدول الدوام (تأخير/دوام إضافي).
 */
export function pairShiftHours(
  logs: Array<{ type: string; serverTime: Date; deductedHours: number }>,
): {
  workedHours: number;
  shiftsCount: number;
  openShiftsCount: number;
  deductedHours: number;
  pairs: Array<{ checkIn: Date; checkOut: Date | null }>;
} {
  let workedMs = 0;
  let shiftsCount = 0;
  let openShiftsCount = 0;
  let deductedHours = 0;
  let openCheckIn: Date | null = null;
  const pairs: Array<{ checkIn: Date; checkOut: Date | null }> = [];

  for (const log of logs) {
    deductedHours += log.deductedHours ?? 0;

    if (log.type === CHECK_IN) {
      if (openCheckIn !== null) {
        openShiftsCount += 1;
        pairs.push({ checkIn: openCheckIn, checkOut: null });
      }
      openCheckIn = log.serverTime;
      continue;
    }

    if (log.type === CHECK_OUT && openCheckIn !== null) {
      const diff = log.serverTime.getTime() - openCheckIn.getTime();
      if (diff > 0) workedMs += diff;
      shiftsCount += 1;
      pairs.push({ checkIn: openCheckIn, checkOut: log.serverTime });
      openCheckIn = null;
    }
  }

  if (openCheckIn !== null) {
    openShiftsCount += 1;
    pairs.push({ checkIn: openCheckIn, checkOut: null });
  }

  return {
    workedHours: round2(workedMs / 3_600_000),
    shiftsCount,
    openShiftsCount,
    deductedHours: round2(deductedHours),
    pairs,
  };
}

/** حساب مسير رواتب شهر واحد لموظف واحد من بياناته الفعلية. */
export async function computePayroll(options: {
  employeeId: number;
  year: number;
  month: number;
}): Promise<PayrollComputation | null> {
  const db = getDb();
  const { employeeId, year, month } = options;

  const [employee] = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      fullName: employees.fullName,
      jobTitle: employees.jobTitle,
      branchId: employees.branchId,
      branchName: branches.name,
      branchTimezone: branches.timezone,
    })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(eq(employees.id, employeeId))
    .limit(1);

  if (!employee) return null;

  const timeZone = safeTimeZone(employee.branchTimezone);
  const { start, end } = monthRangeInZone(year, month, timeZone);
  const period = monthKey(year, month);

  const [salary] = await db
    .select()
    .from(salaryDefinitions)
    .where(eq(salaryDefinitions.employeeId, employeeId))
    .limit(1);

  const logs = await db
    .select({
      type: attendanceLogs.type,
      serverTime: attendanceLogs.serverTime,
      deductedHours: attendanceLogs.deductedHours,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.employeeId, employeeId),
        inArray(attendanceLogs.status, [...EFFECTIVE_STATUSES]),
        gte(attendanceLogs.serverTime, start),
        lt(attendanceLogs.serverTime, end),
      ),
    )
    .orderBy(asc(attendanceLogs.serverTime));

  const shift = pairShiftHours(logs);

  // تقييم الورديات مقابل جدول الدوام: التأخير والدوام الإضافي الفعلي
  // (تُحمَّل تواريخ الإجازة المحدّدة لهذا الشهر مع الجدول)
  const schedule = await getWorkSchedule(employeeId, monthBounds(year, month));
  let lateMinutes = 0;
  let scheduleOvertimeHours = 0;
  for (const pair of shift.pairs) {
    const evaluation = evaluateShift({
      schedule,
      checkIn: pair.checkIn,
      checkOut: pair.checkOut,
      timeZone,
    });
    lateMinutes += evaluation.lateMinutes;
    scheduleOvertimeHours += evaluation.overtimeHours;
  }
  const expectedHours = schedule ? expectedMonthlyHours(schedule, year, month) : 0;

  // الأوفرتايم المعتمد فقط، والسلف المعتمدة المخصومة على هذا الشهر
  const approvedOvertime = await db
    .select({ hours: overtimeRequests.hours, workDate: overtimeRequests.workDate })
    .from(overtimeRequests)
    .where(
      and(
        eq(overtimeRequests.employeeId, employeeId),
        eq(overtimeRequests.status, "approved"),
      ),
    );

  const overtimeHours = round2(
    approvedOvertime
      .filter((row) => (row.workDate ?? "").slice(0, 7) === period)
      .reduce((total, row) => total + (row.hours ?? 0), 0),
  );

  const approvedBonuses = await db
    .select({ amount: bonuses.amount, bonusDate: bonuses.bonusDate })
    .from(bonuses)
    .where(and(eq(bonuses.employeeId, employeeId), eq(bonuses.status, "approved")));

  const bonusesAmount = round2(
    approvedBonuses
      .filter((row) => (row.bonusDate ?? "").slice(0, 7) === period)
      .reduce((total, row) => total + (row.amount ?? 0), 0),
  );

  const approvedAdvances = await db
    .select({
      amount: advances.amount,
      requestDate: advances.requestDate,
      deductionMonth: advances.deductionMonth,
      deductFromPayroll: advances.deductFromPayroll,
      installmentMonths: advances.installmentMonths,
    })
    .from(advances)
    .where(and(eq(advances.employeeId, employeeId), eq(advances.status, "approved")));

  const advancesAmount = round2(
    approvedAdvances.reduce(
      (total, row) => total + advanceInstallmentFor(row, period),
      0,
    ),
  );

  const basicSalary = round2(salary?.basicSalary ?? 0);
  const housingAllowance = round2(salary?.housingAllowance ?? 0);
  const transportAllowance = round2(salary?.transportAllowance ?? 0);
  const otherAllowances = round2(salary?.otherAllowances ?? 0);
  const allowancesTotal = round2(housingAllowance + transportAllowance + otherAllowances);

  /**
   * ساعات العقد الشهرية: جدول الدوام أولاً (متطلّب «بدل الافتراضات الثابتة»)،
   * ثم تعريف الراتب، ثم الافتراض القديم 240 — فالموظف بلا جدول يبقى محسوباً
   * كما كان تماماً.
   */
  const contractHoursSource: "schedule" | "salary" | "default" =
    expectedHours > 0
      ? "schedule"
      : salary?.contractHoursPerMonth && salary.contractHoursPerMonth > 0
        ? "salary"
        : "default";
  const contractHoursPerMonth =
    contractHoursSource === "schedule"
      ? expectedHours
      : contractHoursSource === "salary"
        ? salary!.contractHoursPerMonth
        : DEFAULT_CONTRACT_HOURS;
  const overtimeMultiplier =
    salary?.overtimeMultiplier && salary.overtimeMultiplier > 0
      ? salary.overtimeMultiplier
      : 1.5;
  const hourlyRate = round2(
    salary?.hourlyRate && salary.hourlyRate > 0
      ? salary.hourlyRate
      : basicSalary / contractHoursPerMonth,
  );

  const overtimeAmount = round2(overtimeHours * hourlyRate * overtimeMultiplier);
  const hoursDeductionAmount = round2(shift.deductedHours * hourlyRate);
  const netPay = round2(
    basicSalary +
      allowancesTotal +
      overtimeAmount +
      bonusesAmount -
      advancesAmount -
      hoursDeductionAmount,
  );

  const notes: string[] = [];
  if (!salary) notes.push("لا يوجد تعريف راتب لهذا الموظف — الحساب على أساس صفر.");
  if (shift.openShiftsCount > 0) {
    notes.push(`${shift.openShiftsCount} وردية بلا انصراف لم تُحتسب ساعاتها.`);
  }
  if (!schedule) {
    notes.push("لا يوجد جدول دوام — التأخير غير محسوب وساعات العقد من تعريف الراتب.");
  } else if (lateMinutes > 0) {
    notes.push(`إجمالي التأخير ${Math.round(lateMinutes)} دقيقة حسب جدول الدوام.`);
  }
  // سياسة الأوفرتايم: تجاوز وقت الانصراف لا يُحتسب تلقائياً، بل بطلب معتمد فقط
  if (scheduleOvertimeHours > 0) {
    notes.push(
      `تجاوز الدوام المجدول بمقدار ${round2(scheduleOvertimeHours)} ساعة (للعلم فقط)؛ المحتسب في المسير ${overtimeHours} ساعة أوفرتايم معتمدة بطلب.`,
    );
  }

  return {
    employeeId,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    jobTitle: employee.jobTitle,
    branchName: employee.branchName ?? null,
    periodYear: year,
    periodMonth: month,
    period,
    currency: salary?.currency ?? "SAR",
    hourlyRate,
    contractHoursPerMonth,
    overtimeMultiplier,
    basicSalary,
    housingAllowance,
    transportAllowance,
    otherAllowances,
    allowancesTotal,
    workedHours: shift.workedHours,
    shiftsCount: shift.shiftsCount,
    openShiftsCount: shift.openShiftsCount,
    expectedHours,
    lateMinutes: Math.round(lateMinutes),
    scheduleOvertimeHours: round2(scheduleOvertimeHours),
    contractHoursSource,
    overtimeHours,
    overtimeAmount,
    bonusesAmount,
    advancesAmount,
    deductedHours: shift.deductedHours,
    hoursDeductionAmount,
    otherDeductions: 0,
    netPay,
    hasSalaryDefinition: Boolean(salary),
    notes: notes.join(" "),
  };
}

function parsePeriod(value: unknown, fallbackFrom?: unknown): { year: number; month: number } | null {
  const key = asMonthKey(value) ?? asMonthKey(fallbackFrom);
  if (key === null) return null;
  const [year, month] = key.split("-");
  return { year: Number(year), month: Number(month) };
}

export const payrollRouter = Router();

const requirePayroll = requireAnyPermission(
  PERMISSIONS.payrollManage,
  PERMISSIONS.salaryManage,
);

/** معاينة حساب المسير قبل حفظه (لموظف واحد أو لفرع كامل). */
payrollRouter.get(
  "/payroll/preview",
  requireAuth,
  requirePayroll,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const period = parsePeriod(req.query.period, req.query.month);

    if (period === null) {
      res.status(400).json({ ok: false, error: "الشهر مطلوب بصيغة YYYY-MM (period)." });
      return;
    }

    const employeeId = asId(req.query.employeeId);
    const branchId = asId(req.query.branchId);

    const targets = employeeId
      ? [{ id: employeeId }]
      : await db
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.isActive, true),
              ...(branchId === null ? [] : [eq(employees.branchId, branchId)]),
            ),
          )
          .orderBy(asc(employees.employeeCode));

    const items: PayrollComputation[] = [];
    for (const target of targets) {
      const computed = await computePayroll({
        employeeId: target.id,
        year: period.year,
        month: period.month,
      });
      if (computed) items.push(computed);
    }

    res.json({
      ok: true,
      period: monthKey(period.year, period.month),
      count: items.length,
      totalNetPay: round2(items.reduce((total, item) => total + item.netPay, 0)),
      items,
    });
  },
);

/** حفظ (أو تحديث) مسير راتب موظف لشهر — صف واحد لكل موظف/شهر. */
payrollRouter.post(
  "/payroll/slips",
  requireAuth,
  requireAnyPermission(PERMISSIONS.payrollManage),
  requireModuleLevel("payroll", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const period = parsePeriod(req.body?.period, req.body?.month);
    const employeeId = asId(req.body?.employeeId);

    if (period === null || employeeId === null) {
      res.status(400).json({
        ok: false,
        error: "معرّف الموظف والشهر (YYYY-MM) مطلوبان.",
      });
      return;
    }

    const computed = await computePayroll({
      employeeId,
      year: period.year,
      month: period.month,
    });

    if (!computed) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const otherDeductions = Math.max(0, round2(asNumber(req.body?.otherDeductions) ?? 0));
    const extraNote = asString(req.body?.notes, 1000) ?? "";
    const netPay = round2(computed.netPay - otherDeductions);

    // اعتماد المسير إجراء موافقة: يحتاج الدرجة الرابعة في بند «مسير الرواتب»،
    // أما توليده كمسوّدة فيكفيه بلوغ درجة «رفع/تسجيل حركة».
    const wantsApproval = req.body?.status === "approved";
    if (wantsApproval && !(await hasModuleLevel(req, "payroll", 4))) {
      res.status(403).json({
        ok: false,
        error: "لا تملك صلاحية اعتماد مسير الرواتب — يمكنك حفظه كمسوّدة فقط.",
      });
      return;
    }

    const values = {
      employeeId,
      periodYear: computed.periodYear,
      periodMonth: computed.periodMonth,
      basicSalary: computed.basicSalary,
      allowancesTotal: computed.allowancesTotal,
      overtimeHours: computed.overtimeHours,
      overtimeAmount: computed.overtimeAmount,
      bonusesAmount: computed.bonusesAmount,
      advancesAmount: computed.advancesAmount,
      deductedHours: computed.deductedHours,
      hoursDeductionAmount: computed.hoursDeductionAmount,
      otherDeductions,
      workedHours: computed.workedHours,
      expectedHours: computed.expectedHours,
      lateMinutes: computed.lateMinutes,
      netPay,
      hourlyRate: computed.hourlyRate,
      currency: computed.currency,
      status: wantsApproval ? "approved" : "draft",
      notes: [computed.notes, extraNote].filter(Boolean).join(" ").slice(0, 1000),
      generatedByEmployeeId: actor.id,
      generatedAt: new Date(),
    };

    const [before] = await db
      .select()
      .from(payrollSlips)
      .where(
        and(
          eq(payrollSlips.employeeId, employeeId),
          eq(payrollSlips.periodYear, computed.periodYear),
          eq(payrollSlips.periodMonth, computed.periodMonth),
        ),
      )
      .limit(1);

    const [saved] = await db
      .insert(payrollSlips)
      .values(values)
      .onConflictDoUpdate({
        target: [
          payrollSlips.employeeId,
          payrollSlips.periodYear,
          payrollSlips.periodMonth,
        ],
        set: values,
      })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: before ? "payroll.update" : "payroll.create",
      entityType: "payroll_slips",
      entityId: saved.id,
      before,
      after: saved,
      reason: asString(req.body?.reason, 500) ?? "",
      ipAddress: clientIp(req),
    });

    res.status(before ? 200 : 201).json({
      ok: true,
      message: `تم حفظ مسير راتب ${computed.fullName} لشهر ${computed.period}`,
      item: saved,
      computation: computed,
    });
  },
);

/** قائمة المسيرات — الموظف يرى مسيراته فقط. */
payrollRouter.get(
  "/payroll/slips",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.payrollManage,
      PERMISSIONS.salaryManage,
    ]);

    const requested = asId(req.query.employeeId);
    const employeeId = canReadAll ? requested : actor.id;
    const period = parsePeriod(req.query.period);

    // قسم الرواتب قابل للتعطيل لموظف بعينه عبر التخصيص الفردي للصلاحيات
    if (!canReadAll && !(await hasAnyPermission(req, [PERMISSIONS.sectionPayroll]))) {
      res.status(403).json({ ok: false, error: "قسم الرواتب غير مُتاح لك" });
      return;
    }

    const rows = await db
      .select({
        row: payrollSlips,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        jobTitle: employees.jobTitle,
      })
      .from(payrollSlips)
      .leftJoin(employees, eq(payrollSlips.employeeId, employees.id))
      .where(
        and(
          ...(employeeId === null ? [] : [eq(payrollSlips.employeeId, employeeId)]),
          ...(period === null
            ? []
            : [
                eq(payrollSlips.periodYear, period.year),
                eq(payrollSlips.periodMonth, period.month),
              ]),
        ),
      )
      .orderBy(desc(payrollSlips.periodYear), desc(payrollSlips.periodMonth), asc(payrollSlips.id))
      .limit(500);

    res.json({
      ok: true,
      scope: canReadAll ? "all" : "own",
      items: rows.map((entry) => ({
        ...entry.row,
        period: monthKey(entry.row.periodYear, entry.row.periodMonth),
        employeeCode: entry.employeeCode,
        fullName: entry.fullName,
        jobTitle: entry.jobTitle,
      })),
    });
  },
);

/** مسير واحد بكل تفاصيله (للطباعة). */
payrollRouter.get(
  "/payroll/slips/:id",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف غير صالح" });
      return;
    }

    const [row] = await db
      .select({
        row: payrollSlips,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        jobTitle: employees.jobTitle,
        branchName: branches.name,
      })
      .from(payrollSlips)
      .leftJoin(employees, eq(payrollSlips.employeeId, employees.id))
      .leftJoin(branches, eq(employees.branchId, branches.id))
      .where(eq(payrollSlips.id, id))
      .limit(1);

    if (!row) {
      res.status(404).json({ ok: false, error: "المسير غير موجود" });
      return;
    }

    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.payrollManage,
      PERMISSIONS.salaryManage,
    ]);

    if (!canReadAll && row.row.employeeId !== actor.id) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض هذا المسير" });
      return;
    }

    if (!canReadAll && !(await hasAnyPermission(req, [PERMISSIONS.sectionPayroll]))) {
      res.status(403).json({ ok: false, error: "قسم الرواتب غير مُتاح لك" });
      return;
    }

    res.json({
      ok: true,
      item: {
        ...row.row,
        period: monthKey(row.row.periodYear, row.row.periodMonth),
        employeeCode: row.employeeCode,
        fullName: row.fullName,
        jobTitle: row.jobTitle,
        branchName: row.branchName,
      },
    });
  },
);

/**
 * حذف مسير راتب محفوظ. المسير سجل مالي، فالحذف يحتاج صلاحية إدارة الرواتب
 * ويُوثَّق كاملاً في سجل التدقيق (بكل قيم الصف قبل الحذف) حتى يبقى أثر
 * لما حُذف ومن حذفه. حذف المسير لا يمسّ الحضور ولا السلف ولا المكافآت،
 * فإعادة توليده لنفس الشهر تعطي القيم ذاتها.
 */
payrollRouter.delete(
  "/payroll/slips/:id",
  requireAuth,
  requireAnyPermission(PERMISSIONS.payrollManage),
  requireModuleDelete("payroll"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف المسير غير صالح" });
      return;
    }

    const [before] = await db
      .select({
        row: payrollSlips,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
      })
      .from(payrollSlips)
      .leftJoin(employees, eq(payrollSlips.employeeId, employees.id))
      .where(eq(payrollSlips.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "المسير غير موجود" });
      return;
    }

    await db.delete(payrollSlips).where(eq(payrollSlips.id, id));

    const period = monthKey(before.row.periodYear, before.row.periodMonth);

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "payroll.delete",
      entityType: "payroll_slips",
      entityId: id,
      before: {
        ...before.row,
        period,
        employeeCode: before.employeeCode,
        fullName: before.fullName,
      },
      reason: asString(req.body?.reason, 500) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: `تم حذف مسير ${before.fullName ?? "الموظف"} لشهر ${period}`,
    });
  },
);
