/**
 * بداية الحسابات: تاريخ يبدأ منه التقفيل اليومي ومطابقة البنك لكل فرع.
 * ما قبله يبقى محفوظاً كما هو، لكنه لا يُبنى له تقفيل ولا يظهر في المطابقة.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { financeSettings } from "../db/schema.js";

export async function financeStartDate(branchId: number): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select({ d: financeSettings.startDate }).from(financeSettings).where(eq(financeSettings.branchId, branchId));
  return row?.d ?? null;
}

export async function setFinanceStartDate(branchId: number, startDate: string | null) {
  const db = getDb();
  await db
    .insert(financeSettings)
    .values({ branchId, startDate })
    .onConflictDoUpdate({ target: financeSettings.branchId, set: { startDate, updatedAt: new Date() } });
}

/** يرفع بداية الفترة إلى بداية الحسابات إن كانت قبلها. */
export function clampFrom(from: string, start: string | null) {
  return start && from < start ? start : from;
}
