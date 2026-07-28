import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { systemFlags } from "../db/schema.js";

/** علم يمنع إعادة بذر البيانات التجريبية بعد حذفها. */
export const DEMO_PURGED_FLAG = "demo_data_purged";

/** يقرأ قيمة علم تشغيلي، أو `null` إن لم يكن مضبوطاً. */
export async function readFlag(key: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ flagValue: systemFlags.flagValue })
    .from(systemFlags)
    .where(eq(systemFlags.flagKey, key))
    .limit(1);
  return row?.flagValue ?? null;
}

/** هل العلم مضبوط على قيمة صحيحة؟ */
export async function isFlagOn(key: string): Promise<boolean> {
  const value = await readFlag(key);
  return value === "1" || value === "true";
}

/** يضبط علماً تشغيلياً (upsert) — يبقى محفوظاً في قاعدة البيانات. */
export async function setFlag(
  key: string,
  value: string,
  options: { note?: string; setByEmployeeId?: number | null } = {},
): Promise<void> {
  const db = getDb();
  await db
    .insert(systemFlags)
    .values({
      flagKey: key,
      flagValue: value,
      note: options.note ?? "",
      setByEmployeeId: options.setByEmployeeId ?? null,
    })
    .onConflictDoUpdate({
      target: systemFlags.flagKey,
      set: {
        flagValue: value,
        note: options.note ?? "",
        setByEmployeeId: options.setByEmployeeId ?? null,
        updatedAt: new Date(),
      },
    });
}
