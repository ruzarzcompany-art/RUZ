/**
 * جدول دوام الموظف: قراءته، والحسابات المبنية عليه (التأخير، الخروج المبكر،
 * الدوام الإضافي، والساعات المتوقّعة شهرياً).
 *
 * قاعدة أساسية: الموظف الذي **لا** يملك صفاً في `work_schedules` تُحسب
 * حساباته بالافتراضات القديمة تماماً كما كانت (240 ساعة شهرياً من تعريف
 * الراتب) — فإضافة الجداول لا تغيّر أي مسير راتب قائم حتى يُعرَّف جدوله.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { workSchedules } from "../db/schema.js";
import { round2 } from "./validate.js";
import { safeTimeZone, wallPartsInZone, zonedWallTimeToUtc } from "./time.js";

export interface WorkSchedule {
  employeeId: number;
  shiftStart: string;
  shiftEnd: string;
  dailyHours: number;
  breakMinutes: number;
  daysOffPerMonth: number;
  offDays: string;
  graceMinutes: number;
  note: string;
}

/** عدد أيام الإجازة الشهرية المسموح اختيارها (متطلّب المواصفة: 2 أو 4). */
export const ALLOWED_DAYS_OFF = [2, 4] as const;

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

/** جدول دوام موظف واحد، أو `null` إن لم يُعرَّف له جدول. */
export async function getWorkSchedule(employeeId: number): Promise<WorkSchedule | null> {
  const db = getDb();
  const [row] = await db
    .select({
      employeeId: workSchedules.employeeId,
      shiftStart: workSchedules.shiftStart,
      shiftEnd: workSchedules.shiftEnd,
      dailyHours: workSchedules.dailyHours,
      breakMinutes: workSchedules.breakMinutes,
      daysOffPerMonth: workSchedules.daysOffPerMonth,
      offDays: workSchedules.offDays,
      graceMinutes: workSchedules.graceMinutes,
      note: workSchedules.note,
    })
    .from(workSchedules)
    .where(eq(workSchedules.employeeId, employeeId))
    .limit(1);

  return row ?? null;
}

/** عدد أيام الشهر الميلادي. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * عدد أيام العمل في الشهر = أيام الشهر − أيام الإجازة.
 * تُحسب أيام الإجازة من الأيام المحدَّدة تحديداً إن وُجدت، وإلا من العدد
 * الشهري المُختار (2 أو 4).
 */
export function workingDaysInMonth(
  schedule: WorkSchedule,
  year: number,
  month: number,
): number {
  const total = daysInMonth(year, month);
  const offDays = parseOffDays(schedule.offDays);

  let offCount = schedule.daysOffPerMonth;
  if (offDays.length > 0) {
    offCount = 0;
    for (let day = 1; day <= total; day += 1) {
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      if (offDays.includes(weekday)) offCount += 1;
    }
  }

  return Math.max(0, total - offCount);
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
  const offDays = parseOffDays(schedule.offDays);
  if (offDays.length === 0) return false;
  const parts = wallPartsInZone(instant, timeZone);
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
