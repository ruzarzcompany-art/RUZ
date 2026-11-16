/**
 * مخزون فوديكس → «سِجل»: الأصناف وأرصدتها، أوامر الشراء، والتحويلات بين الفروع،
 * ثم «الاستلام اليومي» الذي يؤكّده الموظف المستلِم من التطبيق.
 *
 * منع التلاعب:
 *   • الأرقام (الكميات والتكلفة والمورد) تأتي من فوديكس — لا يكتبها الموظف.
 *   • الموظف يؤكّد فقط: «مطابق» أو «يوجد فرق» مع الكمية الفعلية للصنف المختلف.
 *   • أي فرق → تنبيه للمالك. استلام لم يؤكَّد حتى 4 فجراً → تنبيه للمدير.
 *   • الجرد اليدوي يبقى الضلع الثالث: فوديكس ↔ الاستلام ↔ الجرد.
 *
 * أسماء حقول فوديكس تُقرأ بمرونة (عدّة أسماء لكل حقل) لأن الاستجابة تختلف
 * بين الحسابات؛ وزر «اختبار المخزون» يعرض الحقول الفعلية من حسابك.
 */

import { and, eq, lt, max, ne, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { branches, foodicsItemStock, foodicsStockDocs, inventoryItems, surveillanceSettings } from "../db/schema.js";
import { FoodicsError, foodicsCredentials, foodicsGet, foodicsList, num, pick, when, type Json } from "./foodics.js";
import { businessDateNow } from "./dayClose.js";
import { createAlert, type BranchRow } from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone } from "./time.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function envPaths(name: string, fallback: string[]): string[] {
  const custom = process.env[name]?.trim();
  return custom ? custom.split(",").map((p) => p.trim()).filter(Boolean) : fallback;
}

/** يجرّب المسارات بالترتيب ويعيد أول مسار يقبله فوديكس (404 = غير موجود في الحساب). */
async function listFirst(paths: string[], params: Record<string, string>, maxPages = 30): Promise<{ path: string; rows: Json[] } | null> {
  for (const path of paths) {
    try {
      return { path, rows: await foodicsList(path, params, maxPages) };
    } catch (error) {
      if (error instanceof FoodicsError && [400, 404, 422].includes(error.status)) {
        // قد يرفض فوديكس «include» غير معروف — نعيد بلا include قبل تجربة المسار التالي
        if (params.include) {
          try {
            const { include: _i, ...rest } = params;
            return { path, rows: await foodicsList(path, rest, maxPages) };
          } catch (retry) {
            if (!(retry instanceof FoodicsError && [400, 404, 422].includes(retry.status))) throw retry;
          }
        }
        continue;
      }
      throw error;
    }
  }
  return null;
}

const ITEM_PATHS = () => envPaths("FOODICS_ITEMS_PATH", ["inventory_items"]);
const PO_PATHS = () => envPaths("FOODICS_PO_PATH", ["purchase_orders", "purchasing"]);
const TRANSFER_PATHS = () => envPaths("FOODICS_TRANSFER_PATH", ["transfer_orders", "transfers"]);

async function foodicsBranchOf(branchId: number): Promise<string> {
  const db = getDb();
  const [row] = await db.select({ f: surveillanceSettings.foodicsBranchId }).from(surveillanceSettings).where(eq(surveillanceSettings.branchId, branchId));
  return row?.f ?? "";
}

/* ══ الأصناف وأرصدتها ═════════════════════════════════════════════ */

function itemCode(o: Json): string {
  const sku = String(pick(o, "sku", "code", "barcode") ?? "").trim();
  return sku || `FX-${String(o.id ?? "").slice(0, 12)}`;
}

/** رصيد الصنف في فرع فوديكس إن أرسله الحساب (في الصنف نفسه أو في قائمة فروعه). */
function stockOf(o: Json, foodicsBranchId: string): number | null {
  const list = (pick(o, "branches", "stock_levels", "levels", "warehouses") ?? []) as Json[];
  if (Array.isArray(list) && list.length) {
    const hit = list.find((b) => String(pick(b, "id", "branch_id", "branch.id") ?? "") === foodicsBranchId) ?? (list.length === 1 ? list[0] : null);
    if (hit) {
      const q = pick(hit, "pivot.quantity", "pivot.stock", "quantity", "stock", "on_hand", "available_quantity");
      if (q !== undefined) return round3(num(q));
    }
  }
  const direct = pick(o, "quantity", "stock", "on_hand", "available_quantity", "current_quantity", "inventory_quantity");
  return direct === undefined ? null : round3(num(direct));
}

/** يسحب أصناف المخزون من فوديكس إلى أصناف «سِجل» (بالرمز SKU) ويحفظ رصيد الفرع. */
export async function syncInventoryItems(branch: BranchRow) {
  const db = getDb();
  const foodicsBranchId = await foodicsBranchOf(branch.id);
  const got = await listFirst(ITEM_PATHS(), { include: "category,branches", per_page: "100" }, 60);
  if (!got) throw new FoodicsError("حساب فوديكس لا يتيح أصناف المخزون (تحقّق من اشتراك المخزون وصلاحية المفتاح)", 404);
  let items = 0;
  let stocks = 0;
  for (const o of got.rows) {
    const code = itemCode(o);
    const name = String(pick(o, "name_localized", "name") ?? code);
    const values = {
      name,
      category: String(pick(o, "category.name_localized", "category.name") ?? ""),
      unit: String(pick(o, "storage_unit", "ingredient_unit", "unit", "unit.name") ?? "قطعة"),
      unitCost: round2(num(pick(o, "cost", "unit_cost", "average_cost"))),
      minQuantity: num(pick(o, "minimum_level", "min_level", "par_level", "reorder_level")),
      isActive: !pick(o, "deleted_at"),
      updatedAt: new Date(),
    };
    const [saved] = await db
      .insert(inventoryItems)
      .values({ code, ...values, note: "من فوديكس" })
      .onConflictDoUpdate({ target: inventoryItems.code, set: values })
      .returning({ id: inventoryItems.id });
    items++;
    const q = stockOf(o, foodicsBranchId);
    if (saved && q !== null) {
      await db
        .insert(foodicsItemStock)
        .values({ branchId: branch.id, itemId: saved.id, quantity: q, syncedAt: new Date() })
        .onConflictDoUpdate({ target: [foodicsItemStock.branchId, foodicsItemStock.itemId], set: { quantity: q, syncedAt: new Date() } });
      stocks++;
    }
  }
  return { items, stocks, path: got.path };
}

/* ══ أوامر الشراء والتحويلات ══════════════════════════════════════ */

interface DocLine {
  name: string;
  sku: string;
  unit: string;
  ordered: number;
  received: number;
  cost: number;
}

function docLines(o: Json): DocLine[] {
  const list = (pick(o, "items", "inventory_items", "lines", "products") ?? []) as Json[];
  if (!Array.isArray(list)) return [];
  return list.map((i) => {
    const ordered = num(pick(i, "pivot.quantity", "quantity", "ordered_quantity", "requested_quantity"));
    const receivedRaw = pick(i, "pivot.received_quantity", "received_quantity", "pivot.receivedQuantity", "delivered_quantity");
    return {
      name: String(pick(i, "name_localized", "name", "inventory_item.name_localized", "inventory_item.name", "item.name") ?? ""),
      sku: String(pick(i, "sku", "inventory_item.sku", "item.sku") ?? ""),
      unit: String(pick(i, "storage_unit", "unit", "inventory_item.storage_unit", "pivot.unit") ?? ""),
      ordered: round3(ordered),
      received: round3(receivedRaw === undefined ? 0 : num(receivedRaw)),
      cost: round2(num(pick(i, "pivot.cost", "cost", "unit_cost", "pivot.unit_cost"))),
    };
  });
}

/** حالة المستند: مستلم/ملغى/مفتوح — من الطوابع الزمنية أو الكميات المستلمة. */
function docState(o: Json, lines: DocLine[]): { state: string; receivedAt: Date | null } {
  if (pick(o, "deleted_at", "cancelled_at", "canceled_at", "rejected_at")) return { state: "cancelled", receivedAt: null };
  const receivedAt = when(pick(o, "received_at", "closed_at", "delivered_at", "completed_at"));
  if (receivedAt || lines.some((l) => l.received > 0)) {
    return { state: "received", receivedAt: receivedAt ?? when(pick(o, "updated_at")) };
  }
  return { state: "open", receivedAt: null };
}

async function upsertDoc(branch: BranchRow, kind: string, o: Json, party: string, stats: { docs: number; received: number }) {
  const db = getDb();
  const foodicsId = String(o.id ?? "");
  if (!foodicsId) return;
  const lines = docLines(o);
  const { state, receivedAt } = docState(o, lines);
  const tz = safeTimeZone(branch.timezone);
  const expectedAt = when(pick(o, "delivery_date", "expected_at", "business_date", "created_at"));
  const ref = receivedAt ?? expectedAt ?? new Date();
  const businessDate = isoDateInZone(new Date(ref.getTime() - 4 * 3600_000), tz);
  const total = round2(num(pick(o, "total_cost", "total", "total_price")) || lines.reduce((s, l) => s + (l.received || l.ordered) * l.cost, 0));
  const values = {
    reference: String(pick(o, "reference", "number", "code") ?? foodicsId),
    party,
    foodicsStatus: String(o.status ?? ""),
    state,
    businessDate,
    expectedAt,
    receivedAt,
    total,
    itemsJson: JSON.stringify(lines),
    syncedAt: new Date(),
  };
  // المستندات القديمة (أكثر من يومين) لا تُطلب من الموظف — تُحفظ للأرشيف فقط
  const today = businessDateNow(branch.timezone);
  const old = businessDate < isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 2 * 86_400_000), "UTC");
  await db
    .insert(foodicsStockDocs)
    .values({ branchId: branch.id, kind, foodicsId, ...values, confirmStatus: old ? "skipped" : "awaiting" })
    .onConflictDoUpdate({ target: [foodicsStockDocs.branchId, foodicsStockDocs.kind, foodicsStockDocs.foodicsId], set: values });
  stats.docs++;
  if (state === "received") stats.received++;
}

/** يسحب أوامر الشراء والتحويلات المحدَّثة منذ آخر مزامنة (أو آخر 30 يوماً أول مرة). */
export async function syncStockDocs(branch: BranchRow, options: { days?: number } = {}) {
  const db = getDb();
  const foodicsBranchId = await foodicsBranchOf(branch.id);
  if (!foodicsBranchId) throw new FoodicsError("الفرع غير مربوط بفرع في فوديكس");
  const [last] = await db.select({ at: max(foodicsStockDocs.syncedAt) }).from(foodicsStockDocs).where(eq(foodicsStockDocs.branchId, branch.id));
  const since = options.days
    ? new Date(Date.now() - options.days * 86_400_000)
    : last?.at
      ? new Date(new Date(last.at).getTime() - 3 * 3600_000)
      : new Date(Date.now() - 30 * 86_400_000);
  const after = since.toISOString().slice(0, 19).replace("T", " ");
  const stats = { docs: 0, received: 0, purchasePath: "", transferPath: "", notes: [] as string[] };

  const pos = await listFirst(PO_PATHS(), {
    "filter[branch_id]": foodicsBranchId,
    "filter[updated_after]": after,
    include: "items,supplier,branch",
    per_page: "50",
  });
  if (pos) {
    stats.purchasePath = pos.path;
    for (const o of pos.rows) {
      // بعض الحسابات تتجاهل فلتر الفرع — نتأكد بأنفسنا
      const bid = String(pick(o, "branch.id", "branch_id", "warehouse.id") ?? foodicsBranchId);
      if (bid !== foodicsBranchId) continue;
      await upsertDoc(branch, "purchase", o, String(pick(o, "supplier.name_localized", "supplier.name") ?? ""), stats);
    }
  } else stats.notes.push("أوامر الشراء غير متاحة في الحساب");

  const transfers = await listFirst(TRANSFER_PATHS(), {
    "filter[updated_after]": after,
    include: "items,branch,warehouse,destination,source",
    per_page: "50",
  });
  if (transfers) {
    stats.transferPath = transfers.path;
    for (const o of transfers.rows) {
      const to = String(pick(o, "destination.id", "destination_branch_id", "to_branch.id", "warehouse.id") ?? "");
      const from = String(pick(o, "source.id", "branch.id", "branch_id", "from_branch.id") ?? "");
      if (to === foodicsBranchId) {
        await upsertDoc(branch, "transfer_in", o, String(pick(o, "source.name", "branch.name", "from_branch.name") ?? "فرع آخر"), stats);
      } else if (from === foodicsBranchId) {
        await upsertDoc(branch, "transfer_out", o, String(pick(o, "destination.name", "warehouse.name", "to_branch.name") ?? "فرع آخر"), stats);
      }
    }
  } else stats.notes.push("التحويلات غير متاحة في الحساب");
  return stats;
}

/* ══ تأكيد الاستلام ═══════════════════════════════════════════════ */

export const KIND_LABELS: Record<string, string> = {
  purchase: "شراء من مورد",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
};
export const CONFIRM_LABELS: Record<string, string> = {
  awaiting: "بانتظار تأكيد الاستلام",
  confirmed: "مطابق",
  disputed: "يوجد فرق",
  skipped: "أرشيف",
};

export async function confirmStockDoc(input: {
  docId: number;
  employeeId: number;
  branchId: number | null;
  canManage: boolean;
  diffs: Array<{ sku: string; name: string; actual: number }>;
  note: string;
}) {
  const db = getDb();
  const [doc] = await db.select().from(foodicsStockDocs).where(eq(foodicsStockDocs.id, input.docId));
  if (!doc) return { error: "المستند غير موجود", status: 404 };
  if (!input.canManage && doc.branchId !== input.branchId) return { error: "هذا المستند لفرع آخر", status: 403 };
  if (!input.canManage && doc.confirmStatus !== "awaiting") return { error: "أُكّد هذا الاستلام مسبقاً", status: 409 };
  if (doc.state === "cancelled") return { error: "المستند ملغى في فوديكس", status: 409 };

  const lines = JSON.parse(doc.itemsJson || "[]") as DocLine[];
  const diffs = input.diffs
    .map((d) => {
      const line = lines.find((l) => (d.sku && l.sku === d.sku) || l.name === d.name);
      const expected = line ? line.received || line.ordered : 0;
      return { sku: d.sku, name: line?.name ?? d.name, unit: line?.unit ?? "", expected, actual: round3(d.actual) };
    })
    .filter((d) => d.expected !== d.actual);

  const disputed = diffs.length > 0;
  const [saved] = await db
    .update(foodicsStockDocs)
    .set({
      confirmStatus: disputed ? "disputed" : "confirmed",
      confirmedByEmployeeId: input.employeeId,
      confirmedAt: new Date(),
      confirmNote: input.note,
      diffJson: JSON.stringify(diffs),
    })
    .where(eq(foodicsStockDocs.id, doc.id))
    .returning();

  if (disputed) {
    const text = diffs.map((d) => `${d.name}: فوديكس ${d.expected} ${d.unit} — الواصل فعلاً ${d.actual}`).join("، ");
    await createAlert({
      branchId: doc.branchId,
      alertType: "receipt_mismatch",
      occurredAt: new Date(),
      location: "المستودع",
      employeeIds: [input.employeeId],
      confidence: "high",
      details: `${KIND_LABELS[doc.kind] ?? doc.kind} رقم ${doc.reference}${doc.party ? ` (${doc.party})` : ""}: ${text}.${input.note ? ` ملاحظة المستلِم: ${input.note}` : ""}`,
      source: "auto",
      sourceRef: `receipt-diff:${doc.id}:${diffs.map((d) => d.actual).join("-")}`,
    }).catch((error) => console.error("[inventory] تنبيه فرق الاستلام:", error));
  }
  return { doc: saved, diffs };
}

/* ══ النبض الدوري ═════════════════════════════════════════════════ */

/** مزامنة المخزون لكل فرع مربوط + تنبيه الاستلام غير المؤكَّد بعد 4 فجراً. */
export async function runInventoryTick(budgetMs = 20_000) {
  if (!(await foodicsCredentials())) return { branches: 0, reminded: 0 };
  const db = getDb();
  const started = Date.now();
  const linked = await db
    .select({ branch: branches })
    .from(surveillanceSettings)
    .innerJoin(branches, eq(branches.id, surveillanceSettings.branchId))
    .where(ne(surveillanceSettings.foodicsBranchId, ""));
  let reminded = 0;
  for (const { branch } of linked) {
    if (Date.now() - started > budgetMs) break;
    try {
      await syncStockDocs(branch);
      // الأصناف وأرصدتها مرة كل ساعة تقريباً
      const [last] = await db.select({ at: max(foodicsItemStock.syncedAt) }).from(foodicsItemStock).where(eq(foodicsItemStock.branchId, branch.id));
      if (!last?.at || Date.now() - new Date(last.at).getTime() > 55 * 60_000) await syncInventoryItems(branch);
    } catch (error) {
      console.error(`[inventory] فرع ${branch.id}:`, (error as Error).message);
    }
    reminded += await remindUnconfirmed(branch);
  }
  return { branches: linked.length, reminded };
}

async function remindUnconfirmed(branch: BranchRow): Promise<number> {
  const db = getDb();
  const today = businessDateNow(branch.timezone);
  const due = await db
    .select()
    .from(foodicsStockDocs)
    .where(
      and(
        eq(foodicsStockDocs.branchId, branch.id),
        eq(foodicsStockDocs.state, "received"),
        eq(foodicsStockDocs.confirmStatus, "awaiting"),
        lt(foodicsStockDocs.businessDate, today),
        sql`${foodicsStockDocs.remindedAt} is null`,
      ),
    )
    .limit(20);
  for (const d of due) {
    await db.update(foodicsStockDocs).set({ remindedAt: new Date() }).where(eq(foodicsStockDocs.id, d.id));
    await createAlert({
      branchId: branch.id,
      alertType: "receipt_not_confirmed",
      occurredAt: new Date(),
      location: "المستودع",
      confidence: "high",
      details: `${KIND_LABELS[d.kind] ?? d.kind} رقم ${d.reference}${d.party ? ` (${d.party})` : ""} بتاريخ ${d.businessDate} مستلم في فوديكس ولم يؤكّد أحد وصوله فعلاً حتى الساعة 4 فجراً. القيمة ${d.total} ريال.`,
      source: "auto",
      sourceRef: `receipt-unconfirmed:${d.id}`,
    }).catch((error) => console.error("[inventory] تنبيه عدم تأكيد الاستلام:", error));
  }
  return due.length;
}

/* ══ القراءة للشاشات ══════════════════════════════════════════════ */

export function docView(d: typeof foodicsStockDocs.$inferSelect, names: Map<number, string>) {
  return {
    id: d.id,
    kind: d.kind,
    kindLabel: KIND_LABELS[d.kind] ?? d.kind,
    reference: d.reference,
    party: d.party,
    state: d.state,
    foodicsStatus: d.foodicsStatus,
    businessDate: d.businessDate,
    expectedAt: d.expectedAt,
    receivedAt: d.receivedAt,
    total: d.total,
    items: JSON.parse(d.itemsJson || "[]") as DocLine[],
    confirmStatus: d.confirmStatus,
    confirmLabel: CONFIRM_LABELS[d.confirmStatus] ?? d.confirmStatus,
    confirmedBy: d.confirmedByEmployeeId ? names.get(d.confirmedByEmployeeId) ?? "" : "",
    confirmedAt: d.confirmedAt,
    confirmNote: d.confirmNote,
    diffs: JSON.parse(d.diffJson || "[]"),
  };
}

/** أرصدة الأصناف من فوديكس للفرع مع القيمة وحد إعادة الطلب. */
export async function itemsWithStock(branchId: number) {
  const db = getDb();
  const rows = await db
    .select({
      id: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      category: inventoryItems.category,
      unit: inventoryItems.unit,
      unitCost: inventoryItems.unitCost,
      minQuantity: inventoryItems.minQuantity,
      quantity: foodicsItemStock.quantity,
      syncedAt: foodicsItemStock.syncedAt,
    })
    .from(inventoryItems)
    .leftJoin(foodicsItemStock, and(eq(foodicsItemStock.itemId, inventoryItems.id), eq(foodicsItemStock.branchId, branchId)))
    .where(eq(inventoryItems.isActive, true))
    .orderBy(inventoryItems.category, inventoryItems.name);
  return rows.map((r) => ({
    ...r,
    value: r.quantity === null ? null : round2(r.quantity * r.unitCost),
    low: r.quantity !== null && r.minQuantity > 0 && r.quantity <= r.minQuantity,
  }));
}

/** حقول فوديكس الفعلية لأول صنف/أمر شراء/تحويل — للتحقق من القراءة الصحيحة. */
export async function testInventory(branch: BranchRow) {
  const foodicsBranchId = await foodicsBranchOf(branch.id);
  const sample = async (paths: string[], params: Record<string, string>) => {
    for (const path of paths) {
      try {
        const body = await foodicsGet(path, { ...params, per_page: "1" });
        const first = Array.isArray(body.data) ? body.data[0] : null;
        return { path, available: true, total: Number(body.meta?.total ?? 0), fields: first ? Object.keys(first) : [], itemFields: first?.items?.[0] ? Object.keys(first.items[0]) : [] };
      } catch (error) {
        if (error instanceof FoodicsError && [400, 404, 422].includes(error.status)) continue;
        throw error;
      }
    }
    return { path: paths.join(" | "), available: false, total: 0, fields: [], itemFields: [] };
  };
  return {
    items: await sample(ITEM_PATHS(), { include: "category,branches" }),
    purchaseOrders: await sample(PO_PATHS(), { include: "items,supplier", ...(foodicsBranchId ? { "filter[branch_id]": foodicsBranchId } : {}) }),
    transfers: await sample(TRANSFER_PATHS(), { include: "items" }),
  };
}

