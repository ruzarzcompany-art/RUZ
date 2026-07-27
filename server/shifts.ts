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
