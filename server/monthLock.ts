/**
 * قفل الشهر: ما إن يُجهَّز ملخّص إقفال شهر حتى يصير الشهر مقفلاً فلا يُعدّل
 * عليه — لا تقفيلة، ولا فاتورة مصروف، ولا تسوية. يبقى كذلك بحالة «بانتظار
 * الاعتماد» حتى يُتخذ القرار (ترحيل أو تصفير)، ثم يبقى مقفلاً بعده أيضاً.
 *
 * الحارس في وحدة مستقلة صغيرة كي يستدعيه مسار الكاشير ومسار النقدية معاً
 * بلا استيراد دائري بينهما.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { monthlyCashClosings } from "../db/schema.js";
import { MONTH_STATUS_LABELS } from "./finance.js";

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
