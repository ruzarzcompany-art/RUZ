/**
 * الهدر: موظف الهدر يسجّل ← المعتمِد يعتمد أو يرفض ← المعتمد يُخصم من المخزون.
 *
 *   • التسجيل من تطبيق الموظف لحظة الحدوث: صنف من قائمة المخزون، كمية، سبب.
 *   • لا يُخصم شيء من الرصيد قبل الاعتماد، والمعتمِد قد يصحّح الكمية.
 *   • القيمة بسعر آخر شراء للصنف. والخصم حركة «إخراج/هدر» واحدة لكل تسجيل.
 *   • هدر لم يُراجَع حتى نهاية يومه → تنبيه لمدير الفرع. وهدر يوم تجاوزت قيمته
 *     النسبة المعتمدة من مبيعاته → تنبيه للمالك.
 */

import { and, desc, eq, gte, inArray, lt, lte, ne } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { cashierClosings, employees, inventoryItems, inventoryMovements, wasteEntries, wasteSettings } from "../db/schema.js";
import { businessDateNow } from "./dayClose.js";
import { createAlert, type BranchRow } from "./routes/surveillance.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const WASTE_REASONS: Record<string, string> = {
  spoiled: "تالف / فاسد",
  expired: "منتهي الصلاحية",
  burnt: "محروق / خطأ طبخ",
  over_prep: "تحضير زائد لم يُبع",
  dropped: "سقط / انسكب",
  returned: "مرتجع عميل",
  other: "سبب آخر",
};
export const WASTE_STATUS: Record<string, string> = {
  pending: "بانتظار الاعتماد",
  approved: "معتمد — خُصم من المخزون",
  rejected: "مرفوض",
};
export const DEFAULT_WASTE_LIMIT = 3;

export async function wasteLimit(branchId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ p: wasteSettings.limitPercent }).from(wasteSettings).where(eq(wasteSettings.branchId, branchId));
  return row?.p ?? DEFAULT_WASTE_LIMIT;
}

export async function setWasteLimit(branchId: number, limitPercent: number) {
  const db = getDb();
  await db
    .insert(wasteSettings)
    .values({ branchId, limitPercent })
    .onConflictDoUpdate({ target: wasteSettings.branchId, set: { limitPercent, updatedAt: new Date() } });
}

/** أصناف المخزون الفعّالة لقائمة موظف الهدر (بلا أسعار ولا أرصدة). */
export async function wasteItems() {
  const db = getDb();
  return db
    .select({ id: inventoryItems.id, code: inventoryItems.code, name: inventoryItems.name, category: inventoryItems.category, unit: inventoryItems.unit })
    .from(inventoryItems)
    .where(eq(inventoryItems.isActive, true))
    .orderBy(inventoryItems.category, inventoryItems.name);
}

export async function recordWaste(input: { branch: BranchRow; employeeId: number; itemId: number; quantity: number; reason: string; station: string; notes: string }) {
  const db = getDb();
  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, input.itemId));
  if (!item || !item.isActive) return { error: "الصنف غير موجود في المخزون", status: 404 };
  const quantity = round3(input.quantity);
  const [saved] = await db
    .insert(wasteEntries)
    .values({
      branchId: input.branch.id,
      itemId: item.id,
      businessDate: businessDateNow(input.branch.timezone),
      quantity,
      unit: item.unit,
      reason: input.reason,
      station: input.station,
      notes: input.notes,
      unitCost: item.unitCost,
      totalCost: round2(quantity * item.unitCost),
      recordedByEmployeeId: input.employeeId,
    })
    .returning();
  return { entry: saved, item };
}

/** اعتماد (مع تصحيح اختياري للكمية) أو رفض. الاعتماد يُنشئ حركة الخصم مرة واحدة. */
export async function reviewWaste(input: { id: number; reviewerId: number; decision: "approve" | "reject"; quantity: number | null; note: string }) {
  const db = getDb();
  const [entry] = await db.select().from(wasteEntries).where(eq(wasteEntries.id, input.id));
  if (!entry) return { error: "تسجيل الهدر غير موجود", status: 404 };
  if (entry.status !== "pending") return { error: "رُوجع هذا التسجيل مسبقاً", status: 409 };

  if (input.decision === "reject") {
    const [saved] = await db
      .update(wasteEntries)
      .set({ status: "rejected", reviewedByEmployeeId: input.reviewerId, reviewedAt: new Date(), reviewNote: input.note })
      .where(and(eq(wasteEntries.id, entry.id), eq(wasteEntries.status, "pending")))
      .returning();
    return { entry: saved ?? entry };
  }

  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, entry.itemId));
  const quantity = round3(input.quantity ?? entry.quantity);
  const unitCost = item?.unitCost ?? entry.unitCost;
  const totalCost = round2(quantity * unitCost);
  // نحجز التسجيل أولاً (pending → approved) حتى لا تُنشأ حركتا خصم عند ضغطتين متزامنتين
  const [claimed] = await db
    .update(wasteEntries)
    .set({ status: "approved", quantity, unitCost, totalCost, reviewedByEmployeeId: input.reviewerId, reviewedAt: new Date(), reviewNote: input.note })
    .where(and(eq(wasteEntries.id, entry.id), eq(wasteEntries.status, "pending")))
    .returning();
  if (!claimed) return { error: "رُوجع هذا التسجيل مسبقاً", status: 409 };
  const [movement] = await db
    .insert(inventoryMovements)
    .values({
      branchId: entry.branchId,
      itemId: entry.itemId,
      movementType: "out",
      businessDate: entry.businessDate,
      quantity,
      unitCost,
      totalCost,
      reason: "waste",
      reference: `WST-${entry.id}`,
      sourceRef: `waste:${entry.id}`,
      notes: `هدر معتمد — ${WASTE_REASONS[entry.reason] ?? entry.reason}${entry.station ? ` — ${entry.station}` : ""}${entry.notes ? ` — ${entry.notes}` : ""}`.slice(0, 1000),
      createdByEmployeeId: entry.recordedByEmployeeId,
    })
    .returning({ id: inventoryMovements.id });
  const [saved] = await db.update(wasteEntries).set({ movementId: movement?.id ?? null }).where(eq(wasteEntries.id, entry.id)).returning();
  return { entry: saved ?? claimed };
}

async function namesOf(ids: Array<number | null>) {
  const list = [...new Set(ids.filter((x): x is number => Boolean(x)))];
  const map = new Map<number, string>();
  if (!list.length) return map;
  const db = getDb();
  const rows = await db.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, list));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

async function salesBetween(branchId: number, from: string, to: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ total: cashierClosings.totalSales })
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branchId), gte(cashierClosings.businessDate, from), lte(cashierClosings.businessDate, to)));
  return round2(rows.reduce((s, r) => s + (Number(r.total) || 0), 0));
}

function view(e: typeof wasteEntries.$inferSelect, item: { name: string; code: string } | undefined, names: Map<number, string>) {
  return {
    id: e.id,
    businessDate: e.businessDate,
    occurredAt: e.occurredAt,
    itemId: e.itemId,
    itemName: item?.name ?? "",
    itemCode: item?.code ?? "",
    quantity: e.quantity,
    unit: e.unit,
    reason: e.reason,
    reasonLabel: WASTE_REASONS[e.reason] ?? e.reason,
    station: e.station,
    notes: e.notes,
    unitCost: e.unitCost,
    totalCost: e.totalCost,
    status: e.status,
    statusLabel: WASTE_STATUS[e.status] ?? e.status,
    recordedBy: e.recordedByEmployeeId ? names.get(e.recordedByEmployeeId) ?? "" : "",
    reviewedBy: e.reviewedByEmployeeId ? names.get(e.reviewedByEmployeeId) ?? "" : "",
    reviewedAt: e.reviewedAt,
    reviewNote: e.reviewNote,
  };
}

async function viewRows(rows: Array<typeof wasteEntries.$inferSelect>) {
  const db = getDb();
  const itemIds = [...new Set(rows.map((r) => r.itemId))];
  const items = itemIds.length
    ? await db.select({ id: inventoryItems.id, name: inventoryItems.name, code: inventoryItems.code }).from(inventoryItems).where(inArray(inventoryItems.id, itemIds))
    : [];
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const names = await namesOf(rows.flatMap((r) => [r.recordedByEmployeeId, r.reviewedByEmployeeId]));
  return rows.map((r) => view(r, itemMap.get(r.itemId), names));
}

/** تسجيلات الموظف نفسه في آخر ثلاثة أيام عمل. */
export async function myWaste(branch: BranchRow, employeeId: number) {
  const db = getDb();
  const today = businessDateNow(branch.timezone);
  const since = new Date(new Date(`${today}T12:00:00Z`).getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(wasteEntries)
    .where(and(eq(wasteEntries.recordedByEmployeeId, employeeId), gte(wasteEntries.businessDate, since)))
    .orderBy(desc(wasteEntries.id))
    .limit(50);
  return { today, entries: await viewRows(rows) };
}

/** تقرير الهدر لفترة: التسجيلات والمجاميع حسب السبب والصنف والموظف ونسبته من المبيعات. */
export async function wasteReport(branch: BranchRow, from: string, to: string, status: string) {
  const db = getDb();
  const conds = [eq(wasteEntries.branchId, branch.id), gte(wasteEntries.businessDate, from), lte(wasteEntries.businessDate, to)];
  if (["pending", "approved", "rejected"].includes(status)) conds.push(eq(wasteEntries.status, status));
  const rows = await db.select().from(wasteEntries).where(and(...conds)).orderBy(desc(wasteEntries.businessDate), desc(wasteEntries.id)).limit(2000);
  const entries = await viewRows(rows);
  const counted = entries.filter((e) => e.status !== "rejected");
  const group = (key: (e: (typeof entries)[number]) => string) => {
    const map = new Map<string, { label: string; count: number; value: number }>();
    for (const e of counted) {
      const k = key(e) || "—";
      const g = map.get(k) ?? { label: k, count: 0, value: 0 };
      g.count++;
      g.value = round2(g.value + e.totalCost);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  };
  const sales = await salesBetween(branch.id, from, to);
  const approvedValue = round2(entries.filter((e) => e.status === "approved").reduce((s, e) => s + e.totalCost, 0));
  const pendingValue = round2(entries.filter((e) => e.status === "pending").reduce((s, e) => s + e.totalCost, 0));
  const limitPercent = await wasteLimit(branch.id);
  const percent = sales > 0 ? round2(((approvedValue + pendingValue) / sales) * 100) : null;
  return {
    from,
    to,
    branchName: branch.name,
    entries,
    reasons: WASTE_REASONS,
    totals: {
      count: entries.length,
      pending: entries.filter((e) => e.status === "pending").length,
      approved: entries.filter((e) => e.status === "approved").length,
      rejected: entries.filter((e) => e.status === "rejected").length,
      approvedValue,
      pendingValue,
      sales,
      percent,
      limitPercent,
      overLimit: percent !== null && percent > limitPercent,
    },
    byReason: group((e) => e.reasonLabel),
    byItem: group((e) => e.itemName).slice(0, 20),
    byEmployee: group((e) => e.recordedBy),
  };
}

/** نبض دوري: تنبيه الهدر غير المراجَع بعد انتهاء يومه، وتجاوز حد الهدر لأمس. */
export async function runWasteTick(branch: BranchRow): Promise<number> {
  const db = getDb();
  const today = businessDateNow(branch.timezone);
  const yesterday = new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const since = new Date(new Date(`${today}T12:00:00Z`).getTime() - 4 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ date: wasteEntries.businessDate, status: wasteEntries.status, value: wasteEntries.totalCost })
    .from(wasteEntries)
    .where(and(eq(wasteEntries.branchId, branch.id), gte(wasteEntries.businessDate, since), lt(wasteEntries.businessDate, today), ne(wasteEntries.status, "rejected")));
  if (!rows.length) return 0;
  let created = 0;
  const push = async (alertType: string, sourceRef: string, details: string) => {
    const res = await createAlert({ branchId: branch.id, alertType, occurredAt: new Date(), location: "المطبخ", confidence: "high", details, source: "auto", sourceRef, customerText: true }).catch((error) => {
      console.error("[waste] تنبيه:", error);
      return null;
    });
    if (res && !("duplicate" in res && res.duplicate)) created++;
  };
  const pendingDates = [...new Set(rows.filter((r) => r.status === "pending").map((r) => r.date))];
  for (const date of pendingDates) {
    const list = rows.filter((r) => r.status === "pending" && r.date === date);
    await push("waste_not_reviewed", `waste-pending:${branch.id}:${date}`, `${list.length} تسجيل هدر ليوم ${date} بقيمة ${round2(list.reduce((s, r) => s + r.value, 0))} ريال لم يُعتمد ولم يُرفض حتى نهاية اليوم. افتح المخزون ← الهدر وراجعه.`);
  }
  const value = round2(rows.filter((r) => r.date === yesterday).reduce((s, r) => s + r.value, 0));
  if (value > 0) {
    const sales = await salesBetween(branch.id, yesterday, yesterday);
    const limit = await wasteLimit(branch.id);
    const percent = sales > 0 ? round2((value / sales) * 100) : null;
    if (percent !== null && percent > limit) {
      await push("waste_over_limit", `waste-limit:${branch.id}:${yesterday}`, `هدر يوم ${yesterday} بلغ ${value} ريال = ${percent}٪ من مبيعات اليوم (${sales} ريال)، والحد المعتمد ${limit}٪. راجع تقرير الهدر حسب الصنف والسبب والموظف.`);
    }
  }
  return created;
}
