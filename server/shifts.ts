import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { attendanceLogs, branches } from "../db/schema.js";
import { recordAudit } from "./audit.js";
import { getAutoCloseHour } from "./config.js";
import { nextZonedHourAfter, safeTimeZone } from "./time.js";

export const CHECK_IN = "check_in";
export const CHECK_OUT = "check_out";

/**
 * الحالات التي تُعتبر حركة فعلية (تفتح وردية أو تُقفلها).
 * `rejected` لا يفتح وردية — لكنه يُحفظ للمراجعة.
 */
export const EFFECTIVE_STATUSES = ["approved", "flagged"] as const;

/** أقصى مدة نبحث فيها عن ورديات مفتوحة (يوم واحد يكفي، ونوسّع للاحتياط). */
const LOOKBACK_DAYS = 14;

export interface LastLog {
  id: number;
  type: string;
  serverTime: Date;
  branchId: number;
  source: string;
}

/** آخر حركة فعلية للموظف (تحدّد ما إذا كانت لديه وردية مفتوحة). */
export async function lastEffectiveLog(employeeId: number): Promise<LastLog | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: attendanceLogs.id,
      type: attendanceLogs.type,
      serverTime: attendanceLogs.serverTime,
      branchId: attendanceLogs.branchId,
      source: attendanceLogs.source,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.employeeId, employeeId),
        inArray(attendanceLogs.status, [...EFFECTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(attendanceLogs.serverTime))
    .limit(1);

  return row ?? null;
}

/* ── سياسة أقل مدة بين الحضور والانصراف ────────────────────────
 * تمنع تكرار الدخول والخروج المتقارب: لا يُقبل تسجيل انصراف قبل مرور
 * المدة المحدَّدة في `branches.min_shift_hours` على الحضور المفتوح.
 * القيمة تُضبط لكل فرع من لوحة الإعدادات (بند «الفروع» في شاشة الصلاحيات)،
 * والافتراضي أربع ساعات، والقيمة 0 تُعطّل القاعدة.
 */

/** الافتراضي حين لا تحمل قاعدة البيانات قيمة صالحة. */
export const DEFAULT_MIN_SHIFT_HOURS = 4;

/** تطبيع قيمة الإعداد: رقم بين 0 و24، و0 يعني تعطيل القاعدة. */
export function normalizeMinShiftHours(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MIN_SHIFT_HOURS;
  if (value <= 0) return 0;
  return Math.min(value, 24);
}

/** «لقد تم الحضور في الساعة … بتاريخ …» بتوقيت الفرع. */
export function checkInNotice(checkInAt: Date, timezone: string | null): string {
  const zone = safeTimeZone(timezone ?? undefined);
  const time = checkInAt.toLocaleTimeString("ar", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = checkInAt.toLocaleDateString("ar", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `لقد تم الحضور في الساعة ${time} بتاريخ ${date}`;
}

export interface MinShiftVerdict {
  /** هل يُمنع الانصراف الآن؟ */
  blocked: boolean;
  /** المدة المطلوبة بالساعات كما هي مضبوطة للفرع (0 = القاعدة معطّلة). */
  minHours: number;
  /** المتبقي بالدقائق حتى يُسمح بالانصراف. */
  remainingMinutes: number;
  /** رسالة عربية جاهزة للعرض تذكر وقت الحضور وتاريخه. */
  message: string;
}

/** يقرّر هل مضت المدة الدنيا على الحضور المفتوح أم لا. */
export function evaluateMinShift(options: {
  checkInAt: Date;
  minShiftHours: unknown;
  timezone: string | null;
  now?: Date;
}): MinShiftVerdict {
  const minHours = normalizeMinShiftHours(options.minShiftHours);
  const now = options.now ?? new Date();
  const elapsedMs = now.getTime() - options.checkInAt.getTime();
  const requiredMs = minHours * 60 * 60 * 1000;

  if (minHours <= 0 || elapsedMs >= requiredMs) {
    return { blocked: false, minHours, remainingMinutes: 0, message: "" };
  }

  const remainingMinutes = Math.max(1, Math.ceil((requiredMs - elapsedMs) / 60000));
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  const remainingText =
    hours > 0
      ? `${hours} ساعة${minutes > 0 ? ` و${minutes} دقيقة` : ""}`
      : `${remainingMinutes} دقيقة`;

  return {
    blocked: true,
    minHours,
    remainingMinutes,
    message: `${checkInNotice(options.checkInAt, options.timezone)} — لا يمكن تسجيل الانصراف قبل مرور ${minHours} ساعة على الحضور. المتبقي ${remainingText}.`,
  };
}

export interface ClosedShift {
  employeeId: number;
  checkInLogId: number;
  checkOutLogId: number;
  closedAt: string;
}

/**
 * إقفال الورديات المفتوحة التي تجاوزت ساعة الإقفال (4:00 فجراً افتراضياً)
 * **بتوقيت فرع الوردية نفسه**.
 *
 * يُنفَّذ من مسارين: دالة مجدولة (`netlify/functions/close-shifts.mts`)
 * ومباشرةً عند أي عملية حضور — حتى يبقى السلوك صحيحاً في بيئات المعاينة
 * حيث لا تعمل الدوال المجدولة.
 */
export async function closeStaleShifts(options: {
  employeeId?: number;
  now?: Date;
} = {}): Promise<ClosedShift[]> {
  const db = getDb();
  const now = options.now ?? new Date();
  const hour = getAutoCloseHour();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .selectDistinct({ employeeId: attendanceLogs.employeeId })
    .from(attendanceLogs)
    .where(
      and(
        gte(attendanceLogs.serverTime, since),
        eq(attendanceLogs.type, CHECK_IN),
        inArray(attendanceLogs.status, [...EFFECTIVE_STATUSES]),
        ...(options.employeeId === undefined
          ? []
          : [eq(attendanceLogs.employeeId, options.employeeId)]),
      ),
    );

  const closed: ClosedShift[] = [];

  for (const candidate of candidates) {
    const last = await lastEffectiveLog(candidate.employeeId);
    if (!last || last.type !== CHECK_IN) continue;

    const [branch] = await db
      .select({ id: branches.id, timezone: branches.timezone, name: branches.name })
      .from(branches)
      .where(eq(branches.id, last.branchId))
      .limit(1);

    const timezone = safeTimeZone(branch?.timezone);
    const boundary = nextZonedHourAfter(last.serverTime, timezone, hour);

    if (boundary.getTime() > now.getTime()) continue;

    const reason = `إقفال تلقائي للوردية عند الساعة ${String(hour).padStart(2, "0")}:00 بتوقيت الفرع (لم يُسجَّل انصراف).`;

    const [inserted] = await db
      .insert(attendanceLogs)
      .values({
        employeeId: candidate.employeeId,
        branchId: last.branchId,
        type: CHECK_OUT,
        serverTime: boundary,
        // `flagged` لا `approved`: الوردية أُقفلت بلا انصراف فعلي، فتبقى
        // موسومة للمراجعة حتى يصحّح المسؤول وقت الانصراف الحقيقي.
        status: "flagged",
        source: "auto_close",
        withinGeofence: false,
        reason,
      })
      .returning({ id: attendanceLogs.id });

    if (!inserted) continue;

    await recordAudit({
      actorEmployeeId: null,
      action: "attendance.auto_close",
      entityType: "attendance_logs",
      entityId: inserted.id,
      before: { openCheckInLogId: last.id, checkInAt: last.serverTime },
      after: { checkOutAt: boundary, source: "auto_close" },
      reason,
    });

    closed.push({
      employeeId: candidate.employeeId,
      checkInLogId: last.id,
      checkOutLogId: inserted.id,
      closedAt: boundary.toISOString(),
    });
  }

  return closed;
}
