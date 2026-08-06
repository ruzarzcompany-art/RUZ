/**
 * قفل الشهر: الإقفال يقع في نهاية الشهر لا قبلها، وبعدها تبقى مهلة عشرة
 * أيام يُصحَّح فيها ما تأخّر. فإذا انقضت المهلة أو اتُّخذ قرار الشهر (ترحيل
 * أو تصفير) صار الشهر مقفلاً فلا يُعدّل عليه — لا تقفيلة، ولا فاتورة مصروف،
 * ولا تسوية.
 *
 * الحارس في وحدة مستقلة صغيرة كي يستدعيه مسار الكاشير ومسار النقدية معاً
 * بلا استيراد دائري بينهما.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { branches, monthlyCashClosings } from "../db/schema.js";
import { MONTH_STATUS_LABELS, monthBounds } from "./finance.js";
import { isoDateInZone, safeTimeZone } from "./time.js";

/**
 * مهلة تصحيح بعد نهاية الشهر: الإقفال يقع في نهاية الشهر لا قبلها، ويبقى
 * الشهر بعدها مفتوحاً عشرة أيام لتصحيح تقفيلة تأخّرت أو دفعة وصلت متأخّرة.
 * فإذا انقضت المهلة أو اتُّخذ قرار الشهر عاد القفل كما كان حرفياً.
 */
export const MONTH_CLOSE_GRACE_DAYS = 10;

/** آخر يوم تُقبل فيه تصحيحات الشهر (نهاية الشهر + المهلة). */
export function monthCloseWindowEnd(periodTo: string): string {
  const end = new Date(String(periodTo).slice(0, 10) + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + MONTH_CLOSE_GRACE_DAYS);
  return end.toISOString().slice(0, 10);
}

export interface MonthLock {
  id: number;
  branchId: number;
  periodYear: number;
  periodMonth: number;
  status: string;
  lockedAt: Date | null;
}

/**
 * يعيد قفل الشهر الذي يقع فيه هذا التاريخ في هذا الفرع، أو `null` إن كان
 * الشهر مفتوحاً. الشهر بلا صفّ إقفال مفتوحٌ دائماً — ولهذا لا تتأثر أي
 * بيانات أو تقفيلات سابقة بهذه الإضافة: لا صفوف إقفال لها فلا قفل عليها.
 */
export async function monthLockFor(
  branchId: number | null,
  isoDate: string | null,
): Promise<MonthLock | null> {
  if (branchId === null || !isoDate) return null;

  const year = Number.parseInt(String(isoDate).slice(0, 4), 10);
  const month = Number.parseInt(String(isoDate).slice(5, 7), 10);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;

  const db = getDb();
  const [row] = await db
    .select({
      id: monthlyCashClosings.id,
      branchId: monthlyCashClosings.branchId,
      periodYear: monthlyCashClosings.periodYear,
      periodMonth: monthlyCashClosings.periodMonth,
      status: monthlyCashClosings.status,
      lockedAt: monthlyCashClosings.lockedAt,
    })
    .from(monthlyCashClosings)
    .where(
      and(
        eq(monthlyCashClosings.branchId, branchId),
        eq(monthlyCashClosings.periodYear, year),
        eq(monthlyCashClosings.periodMonth, month),
      ),
    )
    .limit(1);

  if (!row || row.lockedAt === null) return null;

  /*
   * القفل لا يسري قبل أوانه: ما دام الشهر «بانتظار الاعتماد» واليوم داخل
   * مهلته (نهاية الشهر + المهلة) فالشهر مفتوح للتصحيح، فلا يُغلق شهر جارٍ
   * في وجه تقفيلات أيامه ولا تسوياته. وبانقضاء المهلة أو باتخاذ القرار
   * يعود القفل كما كان بلا استثناء.
   */
  if (row.status === "pending_approval") {
    const [branch] = await db
      .select({ timezone: branches.timezone })
      .from(branches)
      .where(eq(branches.id, row.branchId))
      .limit(1);
    const today = isoDateInZone(
      new Date(),
      safeTimeZone(branch?.timezone ?? "Asia/Riyadh"),
    );
    const bounds = monthBounds(row.periodYear, row.periodMonth);
    if (today <= monthCloseWindowEnd(bounds.to)) return null;
  }

  return row;
}

/** رسالة الرفض الموحّدة — تُشرح للمستخدم لماذا رُفض التعديل. */
export function monthLockMessage(lock: MonthLock): string {
  const label = MONTH_STATUS_LABELS[lock.status] ?? lock.status;
  return (
    "شهر " +
    String(lock.periodMonth) +
    "/" +
    String(lock.periodYear) +
    " مقفل (" +
    label +
    ") فلا يقبل أي تعديل. راجع صاحب صلاحية الإقفال الشهري."
  );
}
