/**
 * جدول دوام الموظف: قراءته، والحسابات المبنية عليه (التأخير، الخروج المبكر،
 * الدوام الإضافي، والساعات المتوقّعة شهرياً).
 *
 * قاعدة أساسية: الموظف الذي **لا** يملك صفاً في `work_schedules` تُحسب
 * حساباته بالافتراضات القديمة تماماً كما كانت (240 ساعة شهرياً من تعريف
 * الراتب) — فإضافة الجداول لا تغيّر أي مسير راتب قائم حتى يُعرَّف جدوله.
 */

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { scheduleOffDates, workSchedules } from "../db/schema.js";
import { round2 } from "./validate.js";
import { safeTimeZone, wallPartsInZone, zonedWallTimeToUtc } from "./time.js";

export interface WorkSchedule {
  employeeId: number;
  shiftStart: string;
  shiftEnd: string;
  dailyHours: number;
  breakMinutes: number;
  daysOffPerMonth: number;
  /** `weekly` = أيام أسبوعية متكرّرة، `dates` = تواريخ محدّدة في التقويم */
  offMode: string;
  offDays: string;
  graceMinutes: number;
  note: string;
  /**
   * تواريخ الإجازة المحدّدة (`YYYY-MM-DD`) عندما يكون النمط `dates`.
   * تبقى اختيارية: الحسابات التي لا تُحمّلها تعود إلى العدد الشهري المُعرَّف.
   */
  offDates?: string[];
}

/** عدد أيام الإجازة الشهرية المسموح اختيارها من القائمة الجاهزة. */
export const ALLOWED_DAYS_OFF = [2, 4, 6, 8] as const;

/** الحد الأعلى لعدد أيام الإجازة الشهرية عند الإدخال الحر. */
export const MAX_DAYS_OFF_PER_MONTH = 15;

/** أنماط تحديد أيام الإجازة. */
export const OFF_MODES = ["weekly", "dates"] as const;
export type OffMode = (typeof OFF_MODES)[number];

/** أسماء أيام الأسبوع بترتيب `Date.getDay()` — 0 = الأحد. */
export const WEEKDAY_NAMES = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

/** `HH:MM` صالح؟ */
export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

/** يحوّل `HH:MM` إلى دقائق من منتصف الليل. */
export function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** أرقام أيام الإجازة من النص المخزَّن (`"5,6"` ← `[5, 6]`). */
export function parseOffDays(value: string | null | undefined): number[] {
  if (!value) return [];
  const days = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** نص عربي لأيام الإجازة. */
export function offDaysLabel(value: string | null | undefined): string {
  const days = parseOffDays(value);
  return days.length === 0 ? "غير محدّدة" : days.map((day) => WEEKDAY_NAMES[day]).join("، ");
}

/** `YYYY-MM-DD` صالح؟ */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/** يحوّل `Date` (أو نصاً) إلى `YYYY-MM-DD`. */
export function toIsoDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** أول وآخر يوم في شهر ميلادي بصيغة `YYYY-MM-DD`. */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`,
  };
}

/**
 * تواريخ إجازة موظف واحد داخل مدى تاريخي (اختياري) مرتّبة تصاعدياً.
 */
export async function getOffDates(
  employeeId: number,
  range?: { from?: string; to?: string },
): Promise<string[]> {
  const db = getDb();
  const filters = [eq(scheduleOffDates.employeeId, employeeId)];
  if (range?.from) filters.push(gte(scheduleOffDates.offDate, range.from));
  if (range?.to) filters.push(lte(scheduleOffDates.offDate, range.to));

  const rows = await db
    .select({ offDate: scheduleOffDates.offDate })
    .from(scheduleOffDates)
    .where(and(...filters));

  return rows.map((row) => toIsoDate(row.offDate)).sort();
}

/**
 * تواريخ إجازة عدة موظفين مجموعة بمعرّف الموظف — تُستخدم في التقارير حيث
 * تُقرأ الجداول كلها مرة واحدة.
 */
export async function getOffDatesFor(
  employeeIds: number[],
  range?: { from?: string; to?: string },
): Promise<Map<number, string[]>> {
  const grouped = new Map<number, string[]>();
  if (employeeIds.length === 0) return grouped;

  const db = getDb();
  const filters = [inArray(scheduleOffDates.employeeId, employeeIds)];
  if (range?.from) filters.push(gte(scheduleOffDates.offDate, range.from));
  if (range?.to) filters.push(lte(scheduleOffDates.offDate, range.to));

  const rows = await db
    .select({
      employeeId: scheduleOffDates.employeeId,
      offDate: scheduleOffDates.offDate,
    })
    .from(scheduleOffDates)
    .where(and(...filters));

  for (const row of rows) {
    const list = grouped.get(row.employeeId) ?? [];
    list.push(toIsoDate(row.offDate));
    grouped.set(row.employeeId, list);
  }

  for (const list of grouped.values()) list.sort();
  return grouped;
}

/** هل الجدول يعتمد تواريخ محدّدة بدل الأيام الأسبوعية؟ */
export function usesOffDates(schedule: WorkSchedule): boolean {
  return schedule.offMode === "dates";
}

/** نص مقروء لأيام الإجازة حسب نمط الجدول — يُستخدم في الجداول والمطبوعات. */
export function offScheduleLabel(schedule: {
  offMode?: string | null;
  offDays?: string | null;
  offDates?: string[] | null;
}): string {
  if (schedule.offMode === "dates") {
    const dates = schedule.offDates ?? [];
    return dates.length === 0 ? "تواريخ محدّدة (لم تُختر بعد)" : dates.join("، ");
  }
  return offDaysLabel(schedule.offDays);
}

/**
 * جدول دوام موظف واحد، أو `null` إن لم يُعرَّف له جدول.
 *
 * عندما يكون النمط `dates` تُحمَّل تواريخ الإجازة معه؛ ويمكن حصرها بشهر
 * واحد عبر `range` لتقليل الصفوف في حسابات الرواتب الشهرية.
 */
export async function getWorkSchedule(
  employeeId: number,
  range?: { from?: string; to?: string },
): Promise<WorkSchedule | null> {
  const db = getDb();
  const [row] = await db
    .select({
      employeeId: workSchedules.employeeId,
      shiftStart: workSchedules.shiftStart,
      shiftEnd: workSchedules.shiftEnd,
      dailyHours: workSchedules.dailyHours,
      breakMinutes: workSchedules.breakMinutes,
      daysOffPerMonth: workSchedules.daysOffPerMonth,
      offMode: workSchedules.offMode,
      offDays: workSchedules.offDays,
      graceMinutes: workSchedules.graceMinutes,
      note: workSchedules.note,
    })
    .from(workSchedules)
    .where(eq(workSchedules.employeeId, employeeId))
    .limit(1);

  if (!row) return null;
  if (row.offMode !== "dates") return row;

  return { ...row, offDates: await getOffDates(employeeId, range) };
}

/** عدد أيام الشهر الميلادي. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * عدد أيام العمل في الشهر = أيام الشهر − أيام الإجازة.
 *
 * - نمط `dates`  : تُحسب تواريخ الإجازة الواقعة في هذا الشهر إن حُمّلت، وإلا
 *                  يُستخدم العدد الشهري المُعرَّف.
 * - نمط `weekly` : تُحسب من الأيام الأسبوعية المحدّدة إن وُجدت، وإلا من العدد
 *                  الشهري المُعرَّف.
 */
export function workingDaysInMonth(
  schedule: WorkSchedule,
  year: number,
  month: number,
): number {
  const total = daysInMonth(year, month);
  const offCount = offDaysCountInMonth(schedule, year, month);
  return Math.max(0, total - offCount);
}

/** عدد أيام الإجازة الفعلية في شهر معيّن حسب نمط الجدول. */
export function offDaysCountInMonth(
  schedule: WorkSchedule,
  year: number,
  month: number,
): number {
  const total = daysInMonth(year, month);

  if (usesOffDates(schedule)) {
    if (!schedule.offDates) return Math.min(total, Math.max(0, schedule.daysOffPerMonth));
    const { from, to } = monthBounds(year, month);
    const inMonth = schedule.offDates.filter((date) => date >= from && date <= to);
    return inMonth.length;
  }

  const offDays = parseOffDays(schedule.offDays);
  if (offDays.length === 0) return Math.min(total, Math.max(0, schedule.daysOffPerMonth));

  let offCount = 0;
  for (let day = 1; day <= total; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (offDays.includes(weekday)) offCount += 1;
  }
  return offCount;
}

/** الساعات المتوقّعة في الشهر حسب الجدول (ساعات يومية × أيام العمل). */
export function expectedMonthlyHours(
  schedule: WorkSchedule,
  year: number,
  month: number,
): number {
  return round2(workingDaysInMonth(schedule, year, month) * schedule.dailyHours);
}

/** هل هذا التاريخ (بتوقيت الفرع) يوم إجازة حسب الجدول؟ */
export function isOffDay(schedule: WorkSchedule, instant: Date, timeZone: string): boolean {
  const parts = wallPartsInZone(instant, timeZone);

  if (usesOffDates(schedule)) {
    if (!schedule.offDates || schedule.offDates.length === 0) return false;
    const pad = (value: number) => String(value).padStart(2, "0");
    const iso = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    return schedule.offDates.includes(iso);
  }

  const offDays = parseOffDays(schedule.offDays);
  if (offDays.length === 0) return false;
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return offDays.includes(weekday);
}

export interface ShiftEvaluation {
  workedHours: number;
  /** دقائق التأخير بعد فترة السماح (0 إن لم يتأخّر أو لا جدول) */
  lateMinutes: number;
  /** دقائق الخروج قبل نهاية الوردية */
  earlyLeaveMinutes: number;
  /** الساعات الزائدة عن الساعات اليومية المتعاقد عليها */
  overtimeHours: number;
  /** الساعات المتوقّعة لهذه الوردية */
  expectedHours: number;
  isOffDay: boolean;
  hasSchedule: boolean;
}

/**
 * تقييم وردية واحدة (حضور + انصراف) مقابل جدول الدوام بتوقيت الفرع.
 * بلا جدول: تُحتسب الساعات فقط ويبقى التأخير والدوام الإضافي صفراً — وهو
 * سلوك النظام قبل إضافة الجداول.
 */
export function evaluateShift(options: {
  schedule: WorkSchedule | null;
  checkIn: Date;
  checkOut: Date | null;
  timeZone: string;
}): ShiftEvaluation {
  const { schedule, checkIn, checkOut } = options;
  const timeZone = safeTimeZone(options.timeZone);

  const workedHours =
    checkOut === null
      ? 0
      : round2(Math.max(0, checkOut.getTime() - checkIn.getTime()) / 3_600_000);

  if (!schedule) {
    return {
      workedHours,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeHours: 0,
      expectedHours: 0,
      isOffDay: false,
      hasSchedule: false,
    };
  }

  const parts = wallPartsInZone(checkIn, timeZone);
  const startMinutes = isTimeOfDay(schedule.shiftStart)
    ? timeToMinutes(schedule.shiftStart)
    : 0;
  const endMinutes = isTimeOfDay(schedule.shiftEnd) ? timeToMinutes(schedule.shiftEnd) : 0;

  const scheduledStart = zonedWallTimeToUtc(
    {
      ...parts,
      hour: Math.floor(startMinutes / 60),
      minute: startMinutes % 60,
      second: 0,
    },
    timeZone,
  );

  // وردية تنتهي بعد منتصف الليل: نهايتها في اليوم التالي بتوقيت الفرع
  const crossesMidnight = endMinutes <= startMinutes;
  const scheduledEnd = new Date(
    scheduledStart.getTime() +
      ((crossesMidnight ? endMinutes + 24 * 60 : endMinutes) - startMinutes) * 60_000,
  );

  const grace = Math.max(0, schedule.graceMinutes);
  const lateMinutes = Math.max(
    0,
    Math.round((checkIn.getTime() - scheduledStart.getTime()) / 60_000) - grace,
  );

  const earlyLeaveMinutes =
    checkOut === null
      ? 0
      : Math.max(0, Math.round((scheduledEnd.getTime() - checkOut.getTime()) / 60_000));

  const dailyHours = schedule.dailyHours > 0 ? schedule.dailyHours : 0;
  const overtimeHours = checkOut === null ? 0 : round2(Math.max(0, workedHours - dailyHours));

  return {
    workedHours,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeHours,
    expectedHours: round2(dailyHours),
    isOffDay: isOffDay(schedule, checkIn, timeZone),
    hasSchedule: true,
  };
}
