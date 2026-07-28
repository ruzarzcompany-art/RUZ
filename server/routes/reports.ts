/**
 * التقارير: الحضور والانصراف، الرواتب، السلف، الأوفرتايم، المكافآت، الإجازات.
 *
 * كل تقرير يُرجَع بوصف موحّد `{ report, columns, rows, summary }` حتى تبنيه
 * الواجهة كجدول واحد عام قابل للطباعة، ونفس المسار مع `?format=csv` يُرجع
 * ملف CSV بترميز UTF-8 (مع BOM حتى يفتح Excel العربية صحيحاً).
 *
 * التصفية: `branchId` و`employeeId` و`from`/`to` (بصيغة YYYY-MM-DD).
 * حدود التاريخ تُفسَّر بتوقيت UTC لسجلات الحضور، وبالشهر الميلادي لتقرير
 * الرواتب (`YYYY-MM` مستخرج من from/to).
 */

import { Router, type Response } from "express";
import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../db/index.js";
import {
  advances,
  attendanceLogs,
  bonuses,
  branches,
  cashierClosings,
  documentIssues,
  employees,
  inventoryItems,
  inventoryMovements,
  leaveRequests,
  overtimeRequests,
  payrollSlips,
  workSchedules,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { hasAnyPermission, PERMISSIONS, requirePermission } from "../rbac.js";
import { evaluateShift, type WorkSchedule } from "../schedule.js";
import { safeTimeZone } from "../time.js";
import { asDateOnly, asId, round2 } from "../validate.js";
import { DOC_CATALOG } from "./documents.js";

export const reportsRouter = Router();

/* ── نموذج التقرير الموحّد ─────────────────────────────────────── */

type ColumnType = "text" | "number" | "hours" | "money" | "date" | "datetime";

interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

interface ReportPayload {
  report: string;
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  summary: Array<{ label: string; value: string }>;
  filters: {
    branchId: number | null;
    employeeId: number | null;
    from: string | null;
    to: string | null;
    scope: "own" | "all";
  };
}

interface Filters {
  branchId: number | null;
  employeeId: number | null;
  from: string | null;
  to: string | null;
  scope: "own" | "all";
}

/** يقرأ معاملات التصفية، ويحصر النتيجة على الموظف نفسه إن لم يملك صلاحية العرض الشامل. */
async function readFilters(
  req: AuthedRequest,
  readAllPermission: string,
): Promise<Filters> {
  const canReadAll = await hasAnyPermission(req, [
    readAllPermission,
    PERMISSIONS.employeesRead,
  ]);

  const requestedEmployeeId = asId(req.query.employeeId);

  return {
    branchId: canReadAll ? asId(req.query.branchId) : null,
    employeeId: canReadAll ? requestedEmployeeId : req.employee!.id,
    from: asDateOnly(req.query.from),
    to: asDateOnly(req.query.to),
    scope: canReadAll ? "all" : "own",
  };
}

/** بداية يوم `from` نهاية يوم `to` (شامل) بتوقيت UTC. */
function instantRange(filters: Filters): { start: Date | null; end: Date | null } {
  return {
    start: filters.from ? new Date(`${filters.from}T00:00:00Z`) : null,
    end: filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : null,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/"/g, '""');
  return /[",\n\r;]/.test(text) ? `"${text}"` : text;
}

/** يحوّل التقرير إلى CSV بعناوين عربية و BOM ليقرأه Excel بترميز صحيح. */
function toCsv(payload: ReportPayload): string {
  const header = payload.columns.map((column) => csvCell(column.label)).join(",");
  const lines = payload.rows.map((row) =>
    payload.columns.map((column) => csvCell(row[column.key])).join(","),
  );
  const summary = payload.summary.map(
    (item) => `${csvCell(item.label)},${csvCell(item.value)}`,
  );
  return `﻿${[header, ...lines, "", ...summary].join("\r\n")}\r\n`;
}

/** يرسل التقرير كـJSON أو كملف CSV حسب `?format=csv`. */
function sendReport(req: AuthedRequest, res: Response, payload: ReportPayload): void {
  if (String(req.query.format ?? "").toLowerCase() === "csv") {
    const stamp = [payload.filters.from, payload.filters.to].filter(Boolean).join("_");
    const filename = `${payload.report}${stamp ? `_${stamp}` : ""}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(toCsv(payload));
    return;
  }
  res.json({ ok: true, ...payload });
}

const STATUS_LABELS: Record<string, string> = {
  approved: "معتمد",
  rejected: "مرفوض",
  pending: "بانتظار الاعتماد",
  flagged: "بحاجة مراجعة",
  draft: "مسودة",
  final: "نهائي",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const CASHIER_SHIFT_LABELS: Record<string, string> = {
  morning: "صباحية",
  evening: "مسائية",
  full: "يوم كامل",
};

const CASHIER_STATUS_LABELS: Record<string, string> = {
  submitted: "مرفوعة",
  reviewed: "مُراجعة",
  disputed: "معترض عليها",
};

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  in: "إدخال",
  out: "إخراج",
  count: "جرد",
};

const MOVEMENT_REASON_LABELS: Record<string, string> = {
  purchase: "شراء",
  consumption: "استهلاك",
  waste: "هالك",
  transfer: "تحويل",
  stocktake: "جرد",
  other: "أخرى",
};

/** عناوين النماذج العربية لتقرير «النماذج المُصدرة». */
const DOC_TITLES = new Map(DOC_CATALOG.map((doc) => [doc.key, doc.title]));

const LEAVE_TYPE_LABELS: Record<string, string> = {
  annual: "سنوية",
  sick: "مرضية",
  unpaid: "بدون راتب",
  emergency: "طارئة",
  other: "أخرى",
};

/* ── تقرير الحضور والانصراف ───────────────────────────────────── */

/**
 * يبني صفاً لكل وردية (حضور + انصراف مقابله) مع ساعات العمل ودقائق التأخير
 * المحسوبة من جدول دوام الموظف. السجلات المرفوضة (خارج النطاق) تُدرَج أيضاً
 * بحالتها ومسافتها حتى يراها المسؤول.
 */
reportsRouter.get(
  "/reports/attendance",
  requireAuth,
  requirePermission(PERMISSIONS.reportsView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const filters = await readFilters(req, PERMISSIONS.attendanceReadAll);
    const { start, end } = instantRange(filters);

    const conditions: SQL[] = [];
    if (filters.employeeId) conditions.push(eq(attendanceLogs.employeeId, filters.employeeId));
    if (filters.branchId) conditions.push(eq(attendanceLogs.branchId, filters.branchId));
    if (start) conditions.push(gte(attendanceLogs.serverTime, start));
    if (end) conditions.push(lte(attendanceLogs.serverTime, end));

    const logs = await db
      .select({
        id: attendanceLogs.id,
        employeeId: attendanceLogs.employeeId,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        department: employees.department,
        branchName: branches.name,
        timezone: branches.timezone,
        type: attendanceLogs.type,
        serverTime: attendanceLogs.serverTime,
        status: attendanceLogs.status,
        source: attendanceLogs.source,
        distanceMeters: attendanceLogs.distanceMeters,
        withinGeofence: attendanceLogs.withinGeofence,
        faceVerified: attendanceLogs.faceVerified,
        deductedHours: attendanceLogs.deductedHours,
      })
      .from(attendanceLogs)
      .leftJoin(employees, eq(attendanceLogs.employeeId, employees.id))
      .leftJoin(branches, eq(attendanceLogs.branchId, branches.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(attendanceLogs.employeeId), asc(attendanceLogs.serverTime));

    const scheduleRows = await db.select().from(workSchedules);
    const scheduleByEmployee = new Map<number, WorkSchedule>(
      scheduleRows.map((row) => [row.employeeId, row as WorkSchedule]),
    );

    type Log = (typeof logs)[number];
    const rows: Array<Record<string, unknown>> = [];

    /** يضيف صف وردية واحدة (قد يكون انصرافها مفقوداً). */
    const pushShift = (checkIn: Log | null, checkOut: Log | null): void => {
      const anchor = checkIn ?? checkOut;
      if (!anchor) return;

      const timeZone = safeTimeZone(anchor.timezone ?? "Asia/Riyadh");
      const evaluation = checkIn
        ? evaluateShift({
            schedule: scheduleByEmployee.get(anchor.employeeId) ?? null,
            checkIn: checkIn.serverTime,
            checkOut: checkOut?.serverTime ?? null,
            timeZone,
          })
        : null;

      const deducted = round2((checkIn?.deductedHours ?? 0) + (checkOut?.deductedHours ?? 0));
      const workedHours = round2(Math.max(0, (evaluation?.workedHours ?? 0) - deducted));

      rows.push({
        date: anchor.serverTime.toLocaleDateString("en-CA", { timeZone }),
        employeeCode: anchor.employeeCode ?? "",
        fullName: anchor.fullName ?? "",
        department: anchor.department ?? "",
        branchName: anchor.branchName ?? "",
        checkIn: checkIn ? checkIn.serverTime.toISOString() : "",
        checkOut: checkOut ? checkOut.serverTime.toISOString() : "",
        workedHours,
        lateMinutes: evaluation?.lateMinutes ?? 0,
        earlyLeaveMinutes: evaluation?.earlyLeaveMinutes ?? 0,
        overtimeHours: evaluation?.overtimeHours ?? 0,
        deductedHours: deducted,
        status: statusLabel(checkOut?.status ?? anchor.status),
        source: anchor.source,
        distanceMeters:
          anchor.distanceMeters === null ? "" : Math.round(anchor.distanceMeters),
        withinGeofence: anchor.withinGeofence ? "نعم" : "لا",
        faceVerified: anchor.faceVerified ? "نعم" : "لا",
        hasSchedule: evaluation?.hasSchedule ? "نعم" : "لا",
      });
    };

    // المزاوجة: كل حضور يُقابل أول انصراف بعده لنفس الموظف
    let openCheckIn: Log | null = null;
    let currentEmployee: number | null = null;

    for (const log of logs) {
      if (log.employeeId !== currentEmployee) {
        if (openCheckIn) pushShift(openCheckIn, null);
        openCheckIn = null;
        currentEmployee = log.employeeId;
      }

      if (log.type === "check_in") {
        if (openCheckIn) pushShift(openCheckIn, null); // حضور بلا انصراف
        openCheckIn = log;
        continue;
      }

      if (log.type === "check_out") {
        pushShift(openCheckIn, log);
        openCheckIn = null;
      }
    }
    if (openCheckIn) pushShift(openCheckIn, null);

    const totalHours = round2(rows.reduce((sum, row) => sum + Number(row.workedHours ?? 0), 0));
    const totalLate = Math.round(
      rows.reduce((sum, row) => sum + Number(row.lateMinutes ?? 0), 0),
    );
    const totalOvertime = round2(
      rows.reduce((sum, row) => sum + Number(row.overtimeHours ?? 0), 0),
    );

    sendReport(req, res, {
      report: "attendance",
      title: "تقرير الحضور والانصراف",
      columns: [
        { key: "date", label: "التاريخ", type: "date" },
        { key: "employeeCode", label: "الرقم الوظيفي", type: "text" },
        { key: "fullName", label: "الموظف", type: "text" },
        { key: "department", label: "القسم", type: "text" },
        { key: "branchName", label: "الفرع", type: "text" },
        { key: "checkIn", label: "الحضور", type: "datetime" },
        { key: "checkOut", label: "الانصراف", type: "datetime" },
        { key: "workedHours", label: "ساعات العمل", type: "hours" },
        { key: "lateMinutes", label: "التأخير (دقيقة)", type: "number" },
        { key: "earlyLeaveMinutes", label: "خروج مبكر (دقيقة)", type: "number" },
        { key: "overtimeHours", label: "ساعات إضافية", type: "hours" },
        { key: "deductedHours", label: "ساعات مخصومة", type: "hours" },
        { key: "status", label: "الحالة", type: "text" },
        { key: "source", label: "المصدر", type: "text" },
        { key: "distanceMeters", label: "المسافة (م)", type: "number" },
        { key: "withinGeofence", label: "داخل النطاق", type: "text" },
        { key: "faceVerified", label: "الوجه مُطابَق", type: "text" },
        { key: "hasSchedule", label: "له جدول دوام", type: "text" },
      ],
      rows,
      summary: [
        { label: "عدد الورديات", value: String(rows.length) },
        { label: "إجمالي ساعات العمل", value: String(totalHours) },
        { label: "إجمالي التأخير (دقيقة)", value: String(totalLate) },
        { label: "إجمالي الساعات الإضافية", value: String(totalOvertime) },
      ],
      filters,
    });
  },
);

/* ── تقرير الرواتب ────────────────────────────────────────────── */

/** رقم تسلسلي للشهر يسهّل المقارنة: 2026-03 ← 2026*12+3. */
function monthOrdinal(isoDate: string): number {
  const [year, month] = isoDate.split("-");
  return Number(year) * 12 + Number(month);
}

reportsRouter.get(
  "/reports/payroll",
  requireAuth,
  requirePermission(PERMISSIONS.reportsView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const filters = await readFilters(req, PERMISSIONS.formsReadAll);

    // قسم الرواتب قابل للتعطيل لموظف بعينه عبر التخصيص الفردي
    const canSeePayroll = await hasAnyPermission(req, [
      PERMISSIONS.payrollManage,
      PERMISSIONS.sectionPayroll,
    ]);
    if (!canSeePayroll && filters.scope === "all") {
      res.status(403).json({ ok: false, error: "قسم الرواتب غير مُتاح لك" });
      return;
    }

    const conditions: SQL[] = [];
    if (filters.employeeId) conditions.push(eq(payrollSlips.employeeId, filters.employeeId));
    if (filters.branchId) conditions.push(eq(employees.branchId, filters.branchId));
    if (filters.from) {
      conditions.push(
        sql`${payrollSlips.periodYear} * 12 + ${payrollSlips.periodMonth} >= ${monthOrdinal(filters.from)}`,
      );
    }
    if (filters.to) {
      conditions.push(
        sql`${payrollSlips.periodYear} * 12 + ${payrollSlips.periodMonth} <= ${monthOrdinal(filters.to)}`,
      );
    }

    const slips = await db
      .select({
        slip: payrollSlips,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        department: employees.department,
        branchName: branches.name,
      })
      .from(payrollSlips)
      .leftJoin(employees, eq(payrollSlips.employeeId, employees.id))
      .leftJoin(branches, eq(employees.branchId, branches.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(payrollSlips.periodYear), asc(payrollSlips.periodMonth), asc(employees.employeeCode));

    const rows = slips.map(({ slip, ...meta }) => ({
      period: `${slip.periodYear}-${String(slip.periodMonth).padStart(2, "0")}`,
      employeeCode: meta.employeeCode ?? "",
      fullName: meta.fullName ?? "",
      department: meta.department ?? "",
      branchName: meta.branchName ?? "",
      basicSalary: slip.basicSalary,
      allowancesTotal: slip.allowancesTotal,
      workedHours: slip.workedHours,
      expectedHours: slip.expectedHours,
      lateMinutes: slip.lateMinutes,
      overtimeHours: slip.overtimeHours,
      overtimeAmount: slip.overtimeAmount,
      bonusesAmount: slip.bonusesAmount,
      advancesAmount: slip.advancesAmount,
      deductedHours: slip.deductedHours,
      hoursDeductionAmount: slip.hoursDeductionAmount,
      otherDeductions: slip.otherDeductions,
      netPay: slip.netPay,
      status: statusLabel(slip.status),
    }));

    const totalNet = round2(rows.reduce((sum, row) => sum + Number(row.netPay ?? 0), 0));
    const totalAdvances = round2(
      rows.reduce((sum, row) => sum + Number(row.advancesAmount ?? 0), 0),
    );

    sendReport(req, res, {
      report: "payroll",
      title: "تقرير الرواتب",
      columns: [
        { key: "period", label: "الشهر", type: "text" },
        { key: "employeeCode", label: "الرقم الوظيفي", type: "text" },
        { key: "fullName", label: "الموظف", type: "text" },
        { key: "department", label: "القسم", type: "text" },
        { key: "branchName", label: "الفرع", type: "text" },
        { key: "basicSalary", label: "الراتب الأساسي", type: "money" },
        { key: "allowancesTotal", label: "البدلات", type: "money" },
        { key: "workedHours", label: "ساعات العمل", type: "hours" },
        { key: "expectedHours", label: "الساعات المتوقّعة", type: "hours" },
        { key: "lateMinutes", label: "التأخير (دقيقة)", type: "number" },
        { key: "overtimeHours", label: "ساعات إضافية", type: "hours" },
        { key: "overtimeAmount", label: "قيمة الإضافي", type: "money" },
        { key: "bonusesAmount", label: "المكافآت", type: "money" },
        { key: "advancesAmount", label: "السلف المخصومة", type: "money" },
        { key: "deductedHours", label: "ساعات مخصومة", type: "hours" },
        { key: "hoursDeductionAmount", label: "قيمة خصم الساعات", type: "money" },
        { key: "otherDeductions", label: "خصومات أخرى", type: "money" },
        { key: "netPay", label: "الصافي", type: "money" },
        { key: "status", label: "الحالة", type: "text" },
      ],
      rows,
      summary: [
        { label: "عدد المسيّرات", value: String(rows.length) },
        { label: "إجمالي الصافي", value: String(totalNet) },
        { label: "إجمالي السلف المخصومة", value: String(totalAdvances) },
      ],
      filters,
    });
  },
);

/* ── تقارير النماذج (السلف، الأوفرتايم، المكافآت، الإجازات) ────── */

/**
 * مُنشئ عام لتقارير النماذج المرتبطة بالموظف: نفس التصفية ونفس شكل الرد،
 * ويختلف فقط الجدول وعمود التاريخ والأعمدة المعروضة.
 */
function formReport<TTable extends typeof advances | typeof overtimeRequests | typeof bonuses | typeof leaveRequests>(options: {
  path: string;
  report: string;
  title: string;
  table: TTable;
  dateColumn: TTable["_"]["columns"][keyof TTable["_"]["columns"]];
  columns: ReportColumn[];
  mapRow: (row: any) => Record<string, unknown>;
  summarize: (rows: Array<Record<string, unknown>>) => Array<{ label: string; value: string }>;
}): void {
  reportsRouter.get(
    options.path,
    requireAuth,
    requirePermission(PERMISSIONS.reportsView),
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const filters = await readFilters(req, PERMISSIONS.formsReadAll);
      const table = options.table as any;

      const conditions: SQL[] = [];
      if (filters.employeeId) conditions.push(eq(table.employeeId, filters.employeeId));
      if (filters.branchId) conditions.push(eq(employees.branchId, filters.branchId));
      if (filters.from) conditions.push(gte(options.dateColumn as any, filters.from));
      if (filters.to) conditions.push(lte(options.dateColumn as any, filters.to));

      const found = await db
        .select({
          item: table,
          employeeCode: employees.employeeCode,
          fullName: employees.fullName,
          department: employees.department,
          branchName: branches.name,
        })
        .from(table)
        .leftJoin(employees, eq(table.employeeId, employees.id))
        .leftJoin(branches, eq(employees.branchId, branches.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(options.dateColumn as any), asc(employees.employeeCode));

      const rows = found.map((row) =>
        options.mapRow({
          ...row.item,
          employeeCode: row.employeeCode ?? "",
          fullName: row.fullName ?? "",
          department: row.department ?? "",
          branchName: row.branchName ?? "",
        }),
      );

      sendReport(req, res, {
        report: options.report,
        title: options.title,
        columns: [
          { key: "employeeCode", label: "الرقم الوظيفي", type: "text" },
          { key: "fullName", label: "الموظف", type: "text" },
          { key: "department", label: "القسم", type: "text" },
          { key: "branchName", label: "الفرع", type: "text" },
          ...options.columns,
        ],
        rows,
        summary: options.summarize(rows),
        filters,
      });
    },
  );
}

const sumOf = (rows: Array<Record<string, unknown>>, key: string): number =>
  round2(rows.reduce((total, row) => total + Number(row[key] ?? 0), 0));

const identity = (row: any) => ({
  employeeCode: row.employeeCode,
  fullName: row.fullName,
  department: row.department,
  branchName: row.branchName,
});

formReport({
  path: "/reports/advances",
  report: "advances",
  title: "تقرير السلف",
  table: advances,
  dateColumn: advances.requestDate,
  columns: [
    { key: "requestDate", label: "تاريخ الطلب", type: "date" },
    { key: "amount", label: "المبلغ", type: "money" },
    { key: "deductionMonth", label: "شهر الخصم", type: "text" },
    { key: "status", label: "الحالة", type: "text" },
    { key: "reason", label: "السبب", type: "text" },
    { key: "decisionNote", label: "ملاحظة القرار", type: "text" },
  ],
  mapRow: (row) => ({
    ...identity(row),
    requestDate: row.requestDate,
    amount: row.amount,
    deductionMonth: row.deductionMonth ?? "",
    status: statusLabel(row.status),
    reason: row.reason,
    decisionNote: row.decisionNote,
  }),
  summarize: (rows) => [
    { label: "عدد السلف", value: String(rows.length) },
    { label: "إجمالي المبالغ", value: String(sumOf(rows, "amount")) },
  ],
});

formReport({
  path: "/reports/overtime",
  report: "overtime",
  title: "تقرير الأوفرتايم",
  table: overtimeRequests,
  dateColumn: overtimeRequests.workDate,
  columns: [
    { key: "workDate", label: "تاريخ العمل", type: "date" },
    { key: "hours", label: "الساعات", type: "hours" },
    { key: "status", label: "الحالة", type: "text" },
    { key: "reason", label: "السبب", type: "text" },
    { key: "decisionNote", label: "ملاحظة القرار", type: "text" },
  ],
  mapRow: (row) => ({
    ...identity(row),
    workDate: row.workDate,
    hours: row.hours,
    status: statusLabel(row.status),
    reason: row.reason,
    decisionNote: row.decisionNote,
  }),
  summarize: (rows) => [
    { label: "عدد الطلبات", value: String(rows.length) },
    { label: "إجمالي الساعات", value: String(sumOf(rows, "hours")) },
  ],
});

formReport({
  path: "/reports/bonuses",
  report: "bonuses",
  title: "تقرير المكافآت",
  table: bonuses,
  dateColumn: bonuses.bonusDate,
  columns: [
    { key: "bonusDate", label: "تاريخ المكافأة", type: "date" },
    { key: "amount", label: "المبلغ", type: "money" },
    { key: "status", label: "الحالة", type: "text" },
    { key: "reason", label: "السبب", type: "text" },
  ],
  mapRow: (row) => ({
    ...identity(row),
    bonusDate: row.bonusDate,
    amount: row.amount,
    status: statusLabel(row.status),
    reason: row.reason,
  }),
  summarize: (rows) => [
    { label: "عدد المكافآت", value: String(rows.length) },
    { label: "إجمالي المبالغ", value: String(sumOf(rows, "amount")) },
  ],
});

formReport({
  path: "/reports/leaves",
  report: "leaves",
  title: "تقرير الإجازات",
  table: leaveRequests,
  dateColumn: leaveRequests.startDate,
  columns: [
    { key: "leaveType", label: "نوع الإجازة", type: "text" },
    { key: "startDate", label: "من", type: "date" },
    { key: "endDate", label: "إلى", type: "date" },
    { key: "days", label: "الأيام", type: "number" },
    { key: "status", label: "الحالة", type: "text" },
    { key: "reason", label: "السبب", type: "text" },
    { key: "decisionNote", label: "ملاحظة القرار", type: "text" },
  ],
  mapRow: (row) => ({
    ...identity(row),
    leaveType: LEAVE_TYPE_LABELS[row.leaveType] ?? row.leaveType,
    startDate: row.startDate,
    endDate: row.endDate,
    days: row.days,
    status: statusLabel(row.status),
    reason: row.reason,
    decisionNote: row.decisionNote,
  }),
  summarize: (rows) => [
    { label: "عدد الطلبات", value: String(rows.length) },
    { label: "إجمالي الأيام", value: String(sumOf(rows, "days")) },
  ],
});

/* ── تقارير التشغيل: الكاشير، المخزون، النماذج المُصدرة ────────── */

/** تقرير تقفيلات الكاشير اليومية مع الفروقات (عجز/زيادة). */
reportsRouter.get(
  "/reports/cashier",
  requireAuth,
  requirePermission(PERMISSIONS.reportsView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const filters = await readFilters(req, PERMISSIONS.cashierReadAll);

    const conditions: SQL[] = [];
    if (filters.employeeId) conditions.push(eq(cashierClosings.employeeId, filters.employeeId));
    if (filters.branchId) conditions.push(eq(cashierClosings.branchId, filters.branchId));
    if (filters.from) conditions.push(gte(cashierClosings.businessDate, filters.from));
    if (filters.to) conditions.push(lte(cashierClosings.businessDate, filters.to));

    const found = await db
      .select({
        closing: cashierClosings,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        branchName: branches.name,
      })
      .from(cashierClosings)
      .leftJoin(employees, eq(cashierClosings.employeeId, employees.id))
      .leftJoin(branches, eq(cashierClosings.branchId, branches.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(cashierClosings.businessDate), asc(branches.name));

    const rows = found.map((row) => ({
      businessDate: row.closing.businessDate,
      branchName: row.branchName ?? "",
      employeeCode: row.employeeCode ?? "",
      fullName: row.fullName ?? "",
      shift: CASHIER_SHIFT_LABELS[row.closing.shift] ?? row.closing.shift,
      totalSales: row.closing.totalSales,
      cashSales: row.closing.cashSales,
      cardSales: row.closing.cardSales,
      transferSales: row.closing.transferSales,
      deliverySales: row.closing.deliverySales,
      discounts: row.closing.discounts,
      refunds: row.closing.refunds,
      expenses: row.closing.expenses,
      expectedCash: row.closing.expectedCash,
      countedCash: row.closing.countedCash,
      difference: row.closing.difference,
      invoiceCount: row.closing.invoiceCount,
      status: CASHIER_STATUS_LABELS[row.closing.status] ?? row.closing.status,
      notes: row.closing.notes,
    }));

    const shortages = rows.filter((row) => Number(row.difference) < 0);
    const surpluses = rows.filter((row) => Number(row.difference) > 0);

    sendReport(req, res, {
      report: "cashier",
      title: "تقرير تقفيلات الكاشير",
      columns: [
        { key: "businessDate", label: "التاريخ", type: "date" },
        { key: "branchName", label: "الفرع", type: "text" },
        { key: "employeeCode", label: "الرقم الوظيفي", type: "text" },
        { key: "fullName", label: "الكاشير", type: "text" },
        { key: "shift", label: "الوردية", type: "text" },
        { key: "totalSales", label: "إجمالي المبيعات", type: "money" },
        { key: "cashSales", label: "نقد", type: "money" },
        { key: "cardSales", label: "شبكة", type: "money" },
        { key: "transferSales", label: "تحويل", type: "money" },
        { key: "deliverySales", label: "توصيل", type: "money" },
        { key: "discounts", label: "خصومات", type: "money" },
        { key: "refunds", label: "مرتجعات", type: "money" },
        { key: "expenses", label: "مصروفات", type: "money" },
        { key: "expectedCash", label: "النقد المتوقّع", type: "money" },
        { key: "countedCash", label: "النقد المعدود", type: "money" },
        { key: "difference", label: "الفارق", type: "money" },
        { key: "invoiceCount", label: "عدد الفواتير", type: "number" },
        { key: "status", label: "الحالة", type: "text" },
        { key: "notes", label: "ملاحظات", type: "text" },
      ],
      rows,
      summary: [
        { label: "عدد التقفيلات", value: String(rows.length) },
        { label: "إجمالي المبيعات", value: String(sumOf(rows, "totalSales")) },
        { label: "إجمالي النقد", value: String(sumOf(rows, "cashSales")) },
        { label: "إجمالي الشبكة", value: String(sumOf(rows, "cardSales")) },
        { label: "صافي الفروقات", value: String(sumOf(rows, "difference")) },
        { label: "تقفيلات بعجز", value: String(shortages.length) },
        { label: "تقفيلات بزيادة", value: String(surpluses.length) },
      ],
      filters,
    });
  },
);

/** تقرير حركة المخزون اليومية (إدخال/إخراج/جرد) لكل فرع. */
reportsRouter.get(
  "/reports/inventory",
  requireAuth,
  requirePermission(PERMISSIONS.reportsView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const filters = await readFilters(req, PERMISSIONS.inventoryRead);
    const itemId = asId(req.query.itemId);

    const conditions: SQL[] = [];
    if (filters.branchId) conditions.push(eq(inventoryMovements.branchId, filters.branchId));
    if (itemId) conditions.push(eq(inventoryMovements.itemId, itemId));
    if (filters.from) conditions.push(gte(inventoryMovements.businessDate, filters.from));
    if (filters.to) conditions.push(lte(inventoryMovements.businessDate, filters.to));

    const found = await db
      .select({
        movement: inventoryMovements,
        itemCode: inventoryItems.code,
        itemName: inventoryItems.name,
        unit: inventoryItems.unit,
        branchName: branches.name,
        createdByName: employees.fullName,
      })
      .from(inventoryMovements)
      .leftJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
      .leftJoin(branches, eq(inventoryMovements.branchId, branches.id))
      .leftJoin(employees, eq(inventoryMovements.createdByEmployeeId, employees.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(inventoryMovements.businessDate), asc(inventoryItems.code));

    const rows = found.map((row) => ({
      businessDate: row.movement.businessDate,
      branchName: row.branchName ?? "",
      itemCode: row.itemCode ?? "",
      itemName: row.itemName ?? "",
      unit: row.unit ?? "",
      movementType: MOVEMENT_TYPE_LABELS[row.movement.movementType] ?? row.movement.movementType,
      quantity: row.movement.quantity,
      unitCost: row.movement.unitCost,
      totalCost: row.movement.totalCost,
      reason: MOVEMENT_REASON_LABELS[row.movement.reason] ?? row.movement.reason,
      variance: row.movement.variance,
      reference: row.movement.reference,
      createdByName: row.createdByName ?? "",
      notes: row.movement.notes,
    }));

    const quantityOf = (type: string) =>
      round2(
        rows
          .filter((row) => row.movementType === MOVEMENT_TYPE_LABELS[type])
          .reduce((total, row) => total + Number(row.quantity ?? 0), 0),
      );

    sendReport(req, res, {
      report: "inventory",
      title: "تقرير حركة المخزون",
      columns: [
        { key: "businessDate", label: "التاريخ", type: "date" },
        { key: "branchName", label: "الفرع", type: "text" },
        { key: "itemCode", label: "كود الصنف", type: "text" },
        { key: "itemName", label: "الصنف", type: "text" },
        { key: "unit", label: "الوحدة", type: "text" },
        { key: "movementType", label: "نوع الحركة", type: "text" },
        { key: "quantity", label: "الكمية", type: "number" },
        { key: "unitCost", label: "تكلفة الوحدة", type: "money" },
        { key: "totalCost", label: "الإجمالي", type: "money" },
        { key: "reason", label: "السبب", type: "text" },
        { key: "variance", label: "فرق الجرد", type: "number" },
        { key: "reference", label: "المرجع", type: "text" },
        { key: "createdByName", label: "سجّلها", type: "text" },
        { key: "notes", label: "ملاحظات", type: "text" },
      ],
      rows,
      summary: [
        { label: "عدد الحركات", value: String(rows.length) },
        { label: "إجمالي الوارد", value: String(quantityOf("in")) },
        { label: "إجمالي الصادر", value: String(quantityOf("out")) },
        { label: "إجمالي التكلفة", value: String(sumOf(rows, "totalCost")) },
        { label: "صافي فروق الجرد", value: String(sumOf(rows, "variance")) },
      ],
      filters,
    });
  },
);

/** تقرير النماذج والمستندات المُصدرة: من طبع ماذا ولأي موظف ومتى. */
reportsRouter.get(
  "/reports/documents",
  requireAuth,
  requirePermission(PERMISSIONS.reportsView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const filters = await readFilters(req, PERMISSIONS.documentsReadAll);
    const { start, end } = instantRange(filters);
    const docType = typeof req.query.doc === "string" ? req.query.doc.trim() : "";

    const target = alias(employees, "doc_report_employee");
    const issuer = alias(employees, "doc_report_issuer");

    const conditions: SQL[] = [];
    if (filters.employeeId) conditions.push(eq(documentIssues.employeeId, filters.employeeId));
    if (filters.branchId) conditions.push(eq(documentIssues.branchId, filters.branchId));
    if (docType) conditions.push(eq(documentIssues.docType, docType));
    if (start) conditions.push(gte(documentIssues.issuedAt, start));
    if (end) conditions.push(lte(documentIssues.issuedAt, end));

    const found = await db
      .select({
        issue: documentIssues,
        employeeCode: target.employeeCode,
        fullName: target.fullName,
        issuedByName: issuer.fullName,
        branchName: branches.name,
      })
      .from(documentIssues)
      .leftJoin(target, eq(documentIssues.employeeId, target.id))
      .leftJoin(issuer, eq(documentIssues.issuedByEmployeeId, issuer.id))
      .leftJoin(branches, eq(documentIssues.branchId, branches.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(documentIssues.issuedAt));

    const rows = found.map((row) => ({
      issuedAt: row.issue.issuedAt,
      docType: DOC_TITLES.get(row.issue.docType) ?? row.issue.docType,
      title: row.issue.title,
      employeeCode: row.employeeCode ?? "",
      fullName: row.fullName ?? "",
      branchName: row.branchName ?? "",
      issuedByName: row.issuedByName ?? "",
      notes: row.issue.notes,
    }));

    const perType = new Map<string, number>();
    for (const row of rows) {
      perType.set(row.docType, (perType.get(row.docType) ?? 0) + 1);
    }

    sendReport(req, res, {
      report: "documents",
      title: "تقرير النماذج المُصدرة",
      columns: [
        { key: "issuedAt", label: "تاريخ الإصدار", type: "datetime" },
        { key: "docType", label: "النموذج", type: "text" },
        { key: "title", label: "العنوان", type: "text" },
        { key: "employeeCode", label: "الرقم الوظيفي", type: "text" },
        { key: "fullName", label: "الموظف", type: "text" },
        { key: "branchName", label: "الفرع", type: "text" },
        { key: "issuedByName", label: "أصدره", type: "text" },
        { key: "notes", label: "ملاحظات", type: "text" },
      ],
      rows,
      summary: [
        { label: "عدد النماذج", value: String(rows.length) },
        ...[...perType.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 8)
          .map(([type, total]) => ({ label: type, value: String(total) })),
      ],
      filters,
    });
  },
);

/** فهرس التقارير المتاحة — تبني منه الواجهة قائمة الاختيار. */
reportsRouter.get(
  "/reports",
  requireAuth,
  requirePermission(PERMISSIONS.reportsView),
  (_req: AuthedRequest, res: Response) => {
    res.json({
      ok: true,
      reports: [
        { key: "attendance", title: "الحضور والانصراف", path: "/reports/attendance" },
        { key: "payroll", title: "الرواتب", path: "/reports/payroll" },
        { key: "advances", title: "السلف", path: "/reports/advances" },
        { key: "overtime", title: "الأوفرتايم", path: "/reports/overtime" },
        { key: "bonuses", title: "المكافآت", path: "/reports/bonuses" },
        { key: "leaves", title: "الإجازات", path: "/reports/leaves" },
        { key: "cashier", title: "تقفيلات الكاشير", path: "/reports/cashier" },
        { key: "inventory", title: "حركة المخزون", path: "/reports/inventory" },
        { key: "documents", title: "النماذج المُصدرة", path: "/reports/documents" },
      ],
    });
  },
);
