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

import { and, eq, inArray, isNull, like, lt, max, ne, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { branches, foodicsConsumptionDays, foodicsItemStock, foodicsStockDocs, inventoryItems, inventoryMovements, surveillanceSettings } from "../db/schema.js";
import { FoodicsError, foodicsCredentials, foodicsGet, foodicsList, num, pick, when, type Json } from "./foodics.js";
import { businessDateNow } from "./dayClose.js";
import { financeStartDate } from "./financeStart.js";
import { createAlert, type BranchRow } from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone } from "./time.js";
import { alertPriceChanges } from "./priceReport.js";
import { runWasteTick } from "./waste.js";
import { checkTablesWithoutInvoice } from "./leakage.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function envPaths(name: string, fallback: string[]): string[] {
  const custom = process.env[name]?.trim();
  return custom ? custom.split(",").map((p) => p.trim()).filter(Boolean) : fallback;
}

/**
 * يجرّب المسارات بالترتيب ويعيد أول مسار يقبله فوديكس (404 = غير موجود في الحساب).
 * `include` قد يكون عدة بدائل مفصولة بـ «|» تُجرَّب بالترتيب، ثم بلا include.
 */
async function listFirst(paths: string[], params: Record<string, string>, maxPages = 30): Promise<{ path: string; rows: Json[]; include: string } | null> {
  const { include = "", ...rest } = params;
  const includes = [...include.split("|").filter(Boolean), ""];
  for (const path of paths) {
    for (const inc of includes) {
      try {
        return { path, include: inc, rows: await foodicsList(path, inc ? { ...rest, include: inc } : rest, maxPages) };
      } catch (error) {
        if (error instanceof FoodicsError && [400, 404, 422].includes(error.status)) {
          if (error.status === 404) break; // المسار غير موجود — لا فائدة من تجربة include آخر
          continue;
        }
        throw error;
      }
    }
  }
  return null;
}

const ITEM_PATHS = () => envPaths("FOODICS_ITEMS_PATH", ["inventory_items"]);
const PO_PATHS = () => envPaths("FOODICS_PO_PATH", ["purchase_orders", "purchasing"]);
const TRANSFER_PATHS = () => envPaths("FOODICS_TRANSFER_PATH", ["transfer_orders", "transfers"]);
/** أرصدة الأصناف الحالية: فوديكس لا يضعها في قائمة الأصناف نفسها في كل الحسابات. */
const PURCHASING_PATH = () => process.env.FOODICS_PURCHASING_PATH?.trim() || "inventory_transactions";
const LEVEL_PATHS = () =>
  envPaths("FOODICS_LEVELS_PATH", ["inventory_levels", "inventory_item_levels", "inventory/levels", "reports/inventory/levels", "reports/inventory_levels", "stock_levels"]);

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
  const got = await listFirst(ITEM_PATHS(), { include: "category,branches|category", per_page: "100" }, 60);
  if (!got) throw new FoodicsError("حساب فوديكس لا يتيح أصناف المخزون (تحقّق من اشتراك المخزون وصلاحية المفتاح)", 404);
  let items = 0;
  let stocks = 0;
  const byFoodicsId = new Map<string, number>();
  const byCode = new Map<string, number>();
  for (const o of got.rows) {
    const code = itemCode(o);
    const name = String(pick(o, "name_localized", "name") ?? code);
    // فوديكس لا يرسل تكلفة الصنف في كل الحسابات: لا نصفّر بها سعراً أُخذ من آخر فاتورة شراء
    const foodicsCost = round2(num(pick(o, "cost", "unit_cost", "average_cost")));
    const values = {
      name,
      category: String(pick(o, "category.name_localized", "category.name") ?? ""),
      unit: String(pick(o, "storage_unit", "ingredient_unit", "unit", "unit.name") ?? "قطعة"),
      ...(foodicsCost > 0 ? { unitCost: foodicsCost } : {}),
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
    if (saved) {
      byFoodicsId.set(String(o.id ?? ""), saved.id);
      byCode.set(code, saved.id);
    }
    const q = stockOf(o, foodicsBranchId);
    if (saved && q !== null) {
      await saveStock(branch.id, saved.id, q);
      stocks++;
    }
  }
  let levelsPath = "";
  if (stocks === 0) {
    // الرصيد ليس داخل الصنف: نقرأه من مسار الأرصدة المخصص
    const levels = await syncStockLevels(branch, foodicsBranchId, byFoodicsId, byCode);
    stocks = levels.stocks;
    levelsPath = levels.path;
  }
  return { items, stocks, path: got.path, levelsPath };
}

async function saveStock(branchId: number, itemId: number, quantity: number) {
  const db = getDb();
  await db
    .insert(foodicsItemStock)
    .values({ branchId, itemId, quantity, syncedAt: new Date() })
    .onConflictDoUpdate({ target: [foodicsItemStock.branchId, foodicsItemStock.itemId], set: { quantity, syncedAt: new Date() } });
}

/** يقرأ أرصدة الفرع من أول مسار أرصدة يتيحه الحساب ويربطها بالأصناف (بمعرّف فوديكس أو الرمز). */
async function syncStockLevels(branch: BranchRow, foodicsBranchId: string, byFoodicsId: Map<string, number>, byCode: Map<string, number>) {
  const params: Record<string, string> = { per_page: "100", include: "inventory_item|item" };
  if (foodicsBranchId) params["filter[branch_id]"] = foodicsBranchId;
  const got = await listFirst(LEVEL_PATHS(), params, 60).catch(() => null);
  if (!got) return { stocks: 0, path: "" };
  const totals = new Map<number, number>();
  for (const row of got.rows) {
    const bid = String(pick(row, "branch.id", "branch_id", "warehouse.id", "warehouse_id") ?? foodicsBranchId);
    if (foodicsBranchId && bid && bid !== foodicsBranchId) continue;
    const fid = String(pick(row, "inventory_item.id", "inventory_item_id", "item.id", "item_id") ?? "");
    const sku = String(pick(row, "inventory_item.sku", "item.sku", "sku") ?? "");
    const itemId = byFoodicsId.get(fid) ?? (sku ? byCode.get(sku) : undefined);
    const q = pick(row, "quantity", "on_hand", "stock", "available_quantity", "current_quantity", "level");
    if (!itemId || q === undefined) continue;
    totals.set(itemId, round3((totals.get(itemId) ?? 0) + num(q)));
  }
  for (const [itemId, q] of totals) await saveStock(branch.id, itemId, q);
  return { stocks: totals.size, path: got.path };
}

/* ══ أوامر الشراء والتحويلات ══════════════════════════════════════ */

interface DocLine {
  name: string;
  sku: string;
  unit: string;
  ordered: number;
  received: number;
  cost: number;
  /** معرّف الصنف في فوديكس — لربط السطر بصنف «سِجل» إن لم يكن له رمز SKU */
  fid?: string;
}

function docLines(o: Json): DocLine[] {
  if (Array.isArray(o.lines) && o.lines.every((l: Json) => typeof l?.received === "number" && "ordered" in l)) return o.lines as DocLine[];
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
  const receivedAt = when(pick(o, "received_at", "closed_at", "delivered_at", "completed_at", "posted_at"));
  if (receivedAt || lines.some((l) => l.received > 0)) {
    return { state: "received", receivedAt: receivedAt ?? when(pick(o, "updated_at")) };
  }
  return { state: "open", receivedAt: null };
}

async function upsertDoc(branch: BranchRow, kind: string, o: Json, party: string, stats: { docs: number; received: number; posted: number }, ctx: PostContext) {
  const db = getDb();
  const foodicsId = String(o.id ?? "");
  if (!foodicsId) return;
  const lines = docLines(o);
  const { state, receivedAt } = docState(o, lines);
  const tz = safeTimeZone(branch.timezone);
  const expectedAt = when(pick(o, "delivery_date", "expected_at", "business_date", "created_at"));
  const ref = receivedAt ?? expectedAt ?? new Date();
  const bd = String(o.business_date ?? "");
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(bd) ? bd : isoDateInZone(new Date(ref.getTime() - 4 * 3600_000), tz);
  const total = round2(num(pick(o, "total_cost", "total", "total_price")) || lines.reduce((s, l) => s + (l.received || l.ordered) * l.cost, 0));
  // تاريخ فاتورة المورد: به تُعرض المشتريات وتدخل المخزون. تاريخ مستقبلي = خطأ إدخال فيُهمل.
  const inv = String(pick(o, "invoice_date") ?? "").slice(0, 10);
  const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(inv) && inv <= ctx.today ? inv : null;
  const values = {
    reference: String(pick(o, "reference", "number", "code") ?? foodicsId),
    party,
    foodicsStatus: String(o.status ?? ""),
    state,
    businessDate,
    invoiceDate,
    invoiceNumber: String(pick(o, "invoice_number") ?? "").slice(0, 80),
    supplierName: kind === "purchase" ? String(pick(o, "supplier.name_localized", "supplier.name") ?? "").slice(0, 200) : "",
    supplierRep: String(pick(o, "supplier.contact_name") ?? "").slice(0, 120),
    supplierPhone: String(pick(o, "supplier.phone") ?? "").slice(0, 40),
    enteredBy: String(pick(o, "creator.name") ?? "").slice(0, 120),
    expectedAt,
    receivedAt,
    total,
    itemsJson: JSON.stringify(lines),
    syncedAt: new Date(),
  };
  // المستندات القديمة (أكثر من يومين) لا تُطلب من الموظف — تُحفظ للأرشيف فقط
  const today = businessDateNow(branch.timezone);
  const old = businessDate < isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 2 * 86_400_000), "UTC");
  const [saved] = await db
    .insert(foodicsStockDocs)
    .values({ branchId: branch.id, kind, foodicsId, ...values, confirmStatus: old ? "skipped" : "awaiting" })
    .onConflictDoUpdate({ target: [foodicsStockDocs.branchId, foodicsStockDocs.kind, foodicsStockDocs.foodicsId], set: values })
    .returning();
  stats.docs++;
  if (state === "received") stats.received++;
  if (saved) stats.posted += await postDocToStock(saved, ctx);
}

/* ══ ترحيل المشتريات إلى مخزون «سِجل» ═════════════════════════════
 *
 * كل شراء مستلم في فوديكس يُسجَّل حركة «وارد» لكل صنف فيه بتاريخ فاتورة المورد
 * (لا بتاريخ إدخاله في فوديكس)، فيرتفع رصيد «سِجل» تلقائياً، ثم يُصحَّح أي خطأ
 * في الكمية عند الجرد (حركة الجرد تثبّت الرصيد على المعدود فعلاً).
 *   • الحركة مربوطة بالمستند عبر `sourceRef` فلا تتكرر، وتُحدَّث إن عُدّل المستند
 *     أو سجّل المستلِم كمية فعلية مختلفة، وتُحذف إن أُلغي.
 *   • ما قبل «بداية الحسابات» للفرع لا يُرحَّل.
 * ══════════════════════════════════════════════════════════════════ */

type DocRow = typeof foodicsStockDocs.$inferSelect;

interface PostContext {
  /** تاريخ اليوم في منطقة الفرع */
  today: string;
  /** بداية الحسابات — لا ترحيل قبلها */
  start: string | null;
  byCode: Map<string, number>;
  byName: Map<string, number>;
}

async function loadPostContext(branch: Pick<BranchRow, "id" | "timezone">): Promise<PostContext> {
  const db = getDb();
  const items = await db.select({ id: inventoryItems.id, code: inventoryItems.code, name: inventoryItems.name }).from(inventoryItems);
  const byCode = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const i of items) {
    byCode.set(i.code, i.id);
    if (i.name && !byName.has(i.name)) byName.set(i.name, i.id);
  }
  return {
    today: isoDateInZone(new Date(), safeTimeZone(branch.timezone)),
    start: await financeStartDate(branch.id),
    byCode,
    byName,
  };
}

/** صنف «سِجل» المقابل لسطر الشراء: بالرمز SKU ثم بالاسم، ويُنشأ إن لم يُسحب بعد. */
async function itemOfLine(l: DocLine, ctx: PostContext): Promise<number | null> {
  const code = l.sku.trim() || (l.fid ? `FX-${l.fid.slice(0, 12)}` : "");
  const known = (code ? ctx.byCode.get(code) : undefined) ?? (l.name ? ctx.byName.get(l.name) : undefined);
  if (known) return known;
  if (!code) return null;
  const db = getDb();
  const [created] = await db
    .insert(inventoryItems)
    .values({ code, name: l.name || code, unit: l.unit || "قطعة", unitCost: l.cost, note: "من فوديكس" })
    .onConflictDoUpdate({ target: inventoryItems.code, set: { updatedAt: new Date() } })
    .returning({ id: inventoryItems.id });
  if (!created) return null;
  ctx.byCode.set(code, created.id);
  return created.id;
}

/** تاريخ دخول المستند للمخزون: تاريخ الفاتورة، وإن لم يُكتب فتاريخ الإدخال في فوديكس. */
export const stockDateOf = (d: Pick<DocRow, "invoiceDate" | "businessDate">) => d.invoiceDate ?? d.businessDate;

/** يطابق حركات المخزون مع المستند (إضافة/تحديث/حذف) ويعيد عدد الحركات التي تغيّرت. */
async function postDocToStock(doc: DocRow, ctx: PostContext): Promise<number> {
  if (doc.kind !== "purchase") return 0;
  const db = getDb();
  const prefix = `fdoc:${doc.id}:`;
  const existing = await db.select().from(inventoryMovements).where(like(inventoryMovements.sourceRef, `${prefix}%`));
  const date = stockDateOf(doc);
  const wanted = new Map<string, { itemId: number; quantity: number; unitCost: number; totalCost: number }>();
  if (doc.state === "received" && date && (!ctx.start || date >= ctx.start)) {
    const lines = JSON.parse(doc.itemsJson || "[]") as DocLine[];
    const diffs = JSON.parse(doc.diffJson || "[]") as Array<{ sku: string; name: string; actual: number }>;
    for (const [index, l] of lines.entries()) {
      // إن سجّل المستلِم كمية فعلية مختلفة فهي التي دخلت المستودع
      const diff = diffs.find((d) => (d.sku && d.sku === l.sku) || d.name === l.name);
      const quantity = round3(diff ? num(diff.actual) : l.received || l.ordered);
      if (!(quantity > 0)) continue;
      const itemId = await itemOfLine(l, ctx);
      if (!itemId) continue;
      wanted.set(`${prefix}${index}`, { itemId, quantity, unitCost: l.cost, totalCost: round2(quantity * l.cost) });
    }
  }
  const notes = `من فوديكس${doc.party ? ` — ${doc.party}` : ""}${doc.invoiceNumber ? ` — فاتورة رقم ${doc.invoiceNumber}` : ""}`.slice(0, 1000);
  let changed = 0;
  const stale: number[] = [];
  for (const m of existing) {
    const w = wanted.get(m.sourceRef);
    if (!w) {
      stale.push(m.id);
      continue;
    }
    wanted.delete(m.sourceRef);
    if (m.itemId === w.itemId && m.quantity === w.quantity && m.unitCost === w.unitCost && m.businessDate === date && m.reference === doc.reference && m.notes === notes) continue;
    await db
      .update(inventoryMovements)
      .set({ itemId: w.itemId, quantity: w.quantity, unitCost: w.unitCost, totalCost: w.totalCost, businessDate: date!, reference: doc.reference, notes, updatedAt: new Date() })
      .where(eq(inventoryMovements.id, m.id));
    changed++;
  }
  if (stale.length) {
    await db.delete(inventoryMovements).where(inArray(inventoryMovements.id, stale));
    changed += stale.length;
  }
  if (wanted.size) {
    await db.insert(inventoryMovements).values(
      [...wanted].map(([sourceRef, w]) => ({
        branchId: doc.branchId,
        itemId: w.itemId,
        movementType: "in",
        businessDate: date!,
        quantity: w.quantity,
        unitCost: w.unitCost,
        totalCost: w.totalCost,
        reason: "purchase",
        reference: doc.reference,
        sourceRef,
        notes,
      })),
    );
    changed += wanted.size;
  }
  if (!doc.stockPostedAt) await db.update(foodicsStockDocs).set({ stockPostedAt: new Date() }).where(eq(foodicsStockDocs.id, doc.id));
  return changed;
}

/**
 * سعر وحدة الصنف = سعر الوحدة في آخر فاتورة شراء له من فوديكس (بتاريخ الفاتورة)،
 * فتُحسب قيمة المخزون بسعر الشراء الفعلي بدل تكلفة فوديكس الفارغة.
 */
export async function applyLastPurchaseCosts(): Promise<number> {
  const db = getDb();
  const res = await db.execute(sql`
    update inventory_items i
       set unit_cost = m.unit_cost, updated_at = now()
      from (
        select distinct on (item_id) item_id, unit_cost
          from inventory_movements
         where movement_type = 'in' and reason = 'purchase' and source_ref like 'fdoc:%' and unit_cost > 0
         order by item_id, business_date desc, id desc
      ) m
     where m.item_id = i.id and i.unit_cost is distinct from m.unit_cost
    returning i.id`);
  const rows = (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
  return rows.length;
}

/** يرحّل من المحفوظ ما لم يُرحَّل بعد (مستندات لم يعد فوديكس يعيدها في السحب). */
async function postPendingDocs(branch: BranchRow, ctx: PostContext): Promise<number> {
  const db = getDb();
  const pending = await db
    .select()
    .from(foodicsStockDocs)
    .where(and(eq(foodicsStockDocs.branchId, branch.id), eq(foodicsStockDocs.kind, "purchase"), isNull(foodicsStockDocs.stockPostedAt)))
    .limit(300);
  let changed = 0;
  for (const d of pending) changed += await postDocToStock(d, ctx);
  return changed;
}

/** يسحب أوامر الشراء والتحويلات المحدَّثة منذ آخر مزامنة (أو آخر 30 يوماً أول مرة). */
export async function syncStockDocs(branch: BranchRow, options: { days?: number } = {}) {
  const db = getDb();
  const foodicsBranchId = await foodicsBranchOf(branch.id);
  if (!foodicsBranchId) throw new FoodicsError("الفرع غير مربوط بفرع في فوديكس");
  const [last] = await db.select({ at: max(foodicsStockDocs.syncedAt) }).from(foodicsStockDocs).where(eq(foodicsStockDocs.branchId, branch.id));
  const ctx = await loadPostContext(branch);
  if (!options.days) {
    // مستندات محفوظة قبل ترحيل المشتريات للمخزون: سحب كامل مرة واحدة لجلب تاريخ الفاتورة
    const [unposted] = await db
      .select({ id: foodicsStockDocs.id })
      .from(foodicsStockDocs)
      .where(and(eq(foodicsStockDocs.branchId, branch.id), eq(foodicsStockDocs.kind, "purchase"), isNull(foodicsStockDocs.stockPostedAt)))
      .limit(1);
    if (unposted) {
      const sinceStart = ctx.start ? Math.ceil((Date.now() - new Date(`${ctx.start}T00:00:00Z`).getTime()) / 86_400_000) + 3 : 30;
      options = { days: Math.min(90, Math.max(30, sinceStart)) };
    }
  }
  const since = options.days
    ? new Date(Date.now() - options.days * 86_400_000)
    : last?.at
      ? new Date(new Date(last.at).getTime() - 3 * 3600_000)
      : new Date(Date.now() - 30 * 86_400_000);
  const after = since.toISOString().slice(0, 19).replace("T", " ");
  const stats = { docs: 0, received: 0, posted: 0, priced: 0, priceAlerts: 0, purchasePath: "", transferPath: "", notes: [] as string[] };
  // فلتر «updated_after» لا يقبله فوديكس على كل المسارات (كان يعيد صفراً):
  // في السحب الكامل نطلب بلا فلتر تاريخ ونفلتر نحن حسب آخر تحديث.
  const recent = (o: Json) => {
    const at = when(pick(o, "updated_at", "created_at", "business_date"));
    return !at || at >= since;
  };
  const dateFilter: Record<string, string> = options.days ? {} : { "filter[updated_after]": after };

  let pos = await listFirst(PO_PATHS(), {
    "filter[branch_id]": foodicsBranchId,
    ...dateFilter,
    include: "items,supplier,branch|items,supplier|items",
    per_page: "50",
  });
  if (pos && !pos.rows.length && !options.days) {
    pos = await listFirst(PO_PATHS(), { "filter[branch_id]": foodicsBranchId, include: "items,supplier,branch|items,supplier|items", per_page: "50" }, 5);
  }
  if (pos) {
    stats.purchasePath = pos.path;
    for (const o of pos.rows) {
      if (!recent(o)) continue;
      // بعض الحسابات تتجاهل فلتر الفرع — نتأكد بأنفسنا
      const bid = String(pick(o, "branch.id", "branch_id", "warehouse.id") ?? foodicsBranchId);
      if (bid !== foodicsBranchId) continue;
      await upsertDoc(branch, "purchase", o, String(pick(o, "supplier.name_localized", "supplier.name") ?? ""), stats, ctx);
    }
  } else stats.notes.push("أوامر الشراء غير متاحة في الحساب");

  const transfers = await listFirst(TRANSFER_PATHS(), {
    ...dateFilter,
    include: "items,branch,warehouse,destination,source|items,branch,warehouse|items",
    per_page: "50",
  });
  if (transfers) {
    stats.transferPath = transfers.path;
    for (const o of transfers.rows) {
      if (!recent(o)) continue;
      const to = String(pick(o, "destination.id", "destination_branch_id", "to_branch.id", "warehouse.id") ?? "");
      const from = String(pick(o, "source.id", "branch.id", "branch_id", "from_branch.id") ?? "");
      if (to === foodicsBranchId) {
        await upsertDoc(branch, "transfer_in", o, String(pick(o, "source.name", "branch.name", "from_branch.name") ?? "فرع آخر"), stats, ctx);
      } else if (from === foodicsBranchId) {
        await upsertDoc(branch, "transfer_out", o, String(pick(o, "destination.name", "warehouse.name", "to_branch.name") ?? "فرع آخر"), stats, ctx);
      }
    }
  } else stats.notes.push("التحويلات غير متاحة في الحساب");

  // «الشراء المباشر» في فوديكس (حركة مخزون نوع 1 — مراجع PUR-…): هذا هو الاستلام
  // الفعلي في المطعم، وأوامر الشراء قليلة الاستخدام. الأحدث أولاً ونتوقف عند الأقدم.
  const sinceDate = isoDateInZone(since, safeTimeZone(branch.timezone));
  const maxPages = options.days ? 8 : 2;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const body = await foodicsGet(PURCHASING_PATH(), {
        "filter[type]": "1",
        "filter[branch_id]": foodicsBranchId,
        sort: "-business_date",
        include: "items,supplier,creator",
        per_page: "50",
        page: String(page),
      });
      const rows = (Array.isArray(body.data) ? body.data : []) as Json[];
      let older = false;
      for (const o of rows) {
        if (String(o.business_date ?? "") < sinceDate) {
          older = true;
          // مستند أقدم عُدّل حديثاً في فوديكس (كمية أو تاريخ فاتورة) يُعاد سحبه
          const touched = when(pick(o, "updated_at"));
          if (!touched || touched < since) continue;
        }
        // سطور الشراء: pivot.quantity = الكمية المستلمة، pivot.cost = تكلفة السطر كاملة
        const lines: DocLine[] = ((o.items ?? []) as Json[]).map((i) => {
          const q = round3(num(pick(i, "pivot.quantity", "quantity")));
          const lineCost = num(pick(i, "pivot.cost", "cost"));
          return {
            name: String(pick(i, "name_localized", "name") ?? ""),
            sku: String(i.sku ?? ""),
            unit: String(pick(i, "storage_unit", "ingredient_unit") ?? ""),
            ordered: q,
            received: q,
            cost: q ? round2(lineCost / q) : 0,
            fid: String(i.id ?? ""),
          };
        });
        const creator = String(pick(o, "creator.name") ?? "");
        await upsertDoc(branch, "purchase", { ...o, items: undefined, lines, total_cost: round2(lines.reduce((s, l) => s + l.received * l.cost, 0)) }, `${String(pick(o, "supplier.name_localized", "supplier.name") ?? "")}${creator ? ` — أدخله ${creator}` : ""}`, stats, ctx);
      }
      const last = Number(body.meta?.last_page ?? 0);
      if (older || !rows.length || (last && page >= last)) break;
    }
    stats.purchasePath = stats.purchasePath ? `${stats.purchasePath} + ${PURCHASING_PATH()}` : PURCHASING_PATH();
  } catch (error) {
    if (!(error instanceof FoodicsError && [400, 404, 422].includes(error.status))) throw error;
    stats.notes.push("حركات الشراء غير متاحة في الحساب");
  }
  stats.posted += await postPendingDocs(branch, ctx);
  stats.priced = await applyLastPurchaseCosts();
  stats.priceAlerts = await alertPriceChanges(branch).catch((error) => {
    console.error("[inventory] فحص تغيّر الأسعار:", error);
    return 0;
  });
  return stats;
}

/* ══ الاستهلاك من فوديكس → خصم من مخزون «سِجل» ════════════════════
 *
 * فوديكس يسجّل لكل طلب مبيعات «استهلاكاً» (حركة مخزون نوع 8، مراجعها OC-…)
 * بكميات المواد حسب وصفة المنتج، و«مرتجع طلب» (نوع 9، OR-…) يعيد ما أُرجع.
 * نجمع صافي اليوم لكل صنف في حركة «إخراج/استهلاك» واحدة بتاريخ يوم العمل،
 * فيصير رصيد «سِجل» = المشتريات − الاستهلاك − الهدر المعتمد، والفرق عند
 * الجرد هو ما خرج بلا تسجيل. اليوم الجاري وأمس يُعاد سحبهما كل نبضة، وما
 * قبلهما من «بداية الحسابات» يُستكمل تدريجياً ولا يُعاد بعد اكتماله.
 * ══════════════════════════════════════════════════════════════════ */

const dayBefore = (iso: string, days = 1) => new Date(new Date(`${iso}T12:00:00Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);

async function consumptionOfDay(foodicsBranchId: string, date: string) {
  const totals = new Map<string, { line: DocLine; quantity: number; cost: number }>();
  for (const [type, sign] of [["8", 1], ["9", -1]] as const) {
    for (let page = 1; page <= 40; page++) {
      const body = await foodicsGet(PURCHASING_PATH(), {
        "filter[type]": type,
        "filter[branch_id]": foodicsBranchId,
        "filter[business_date]": date,
        include: "items",
        per_page: "50",
        page: String(page),
      });
      const rows = (Array.isArray(body.data) ? body.data : []) as Json[];
      for (const o of rows) {
        // بعض الحسابات تتجاهل فلتر التاريخ — نتأكد بأنفسنا
        if (String(o.business_date ?? "") !== date || pick(o, "deleted_at")) continue;
        for (const i of (o.items ?? []) as Json[]) {
          const quantity = num(pick(i, "pivot.quantity", "quantity"));
          if (!quantity) continue;
          const sku = String(i.sku ?? "");
          const fid = String(i.id ?? "");
          const key = sku || fid;
          if (!key) continue;
          const t = totals.get(key) ?? {
            line: { name: String(pick(i, "name_localized", "name") ?? ""), sku, unit: String(pick(i, "storage_unit", "ingredient_unit") ?? ""), ordered: 0, received: 0, cost: 0, fid },
            quantity: 0,
            cost: 0,
          };
          t.quantity += sign * quantity;
          t.cost += sign * num(pick(i, "pivot.cost", "cost"));
          totals.set(key, t);
        }
      }
      const last = Number(body.meta?.last_page ?? 0);
      if (!rows.length || (last && page >= last)) break;
    }
  }
  return totals;
}

/** يطابق حركات استهلاك يوم واحد مع فوديكس ويعيد عدد الحركات التي تغيّرت. */
async function syncConsumptionDay(branch: BranchRow, foodicsBranchId: string, date: string, ctx: PostContext): Promise<number> {
  const db = getDb();
  const totals = await consumptionOfDay(foodicsBranchId, date);
  const prefix = `fcons:${branch.id}:${date}:`;
  const wanted = new Map<string, { itemId: number; quantity: number; unitCost: number; totalCost: number }>();
  for (const t of totals.values()) {
    const quantity = round3(t.quantity);
    if (!(quantity > 0)) continue;
    const itemId = await itemOfLine(t.line, ctx);
    if (!itemId) continue;
    const ref = `${prefix}${itemId}`;
    const before = wanted.get(ref);
    const q = round3((before?.quantity ?? 0) + quantity);
    const c = round2((before?.totalCost ?? 0) + Math.max(0, t.cost));
    wanted.set(ref, { itemId, quantity: q, unitCost: q ? round2(c / q) : 0, totalCost: c });
  }
  const existing = await db.select().from(inventoryMovements).where(like(inventoryMovements.sourceRef, `${prefix}%`));
  let changed = 0;
  const stale: number[] = [];
  for (const m of existing) {
    const w = wanted.get(m.sourceRef);
    if (!w) {
      stale.push(m.id);
      continue;
    }
    wanted.delete(m.sourceRef);
    if (m.quantity === w.quantity && m.totalCost === w.totalCost) continue;
    await db.update(inventoryMovements).set({ quantity: w.quantity, unitCost: w.unitCost, totalCost: w.totalCost, updatedAt: new Date() }).where(eq(inventoryMovements.id, m.id));
    changed++;
  }
  if (stale.length) {
    await db.delete(inventoryMovements).where(inArray(inventoryMovements.id, stale));
    changed += stale.length;
  }
  if (wanted.size) {
    await db.insert(inventoryMovements).values(
      [...wanted].map(([sourceRef, w]) => ({
        branchId: branch.id,
        itemId: w.itemId,
        movementType: "out",
        businessDate: date,
        quantity: w.quantity,
        unitCost: w.unitCost,
        totalCost: w.totalCost,
        reason: "consumption",
        reference: `استهلاك ${date}`,
        sourceRef,
        notes: "من فوديكس — استهلاك الطلبات حسب الوصفات (بعد خصم مرتجعات الطلبات)",
      })),
    );
    changed += wanted.size;
  }
  await db
    .insert(foodicsConsumptionDays)
    .values({ branchId: branch.id, businessDate: date, lines: totals.size, syncedAt: new Date() })
    .onConflictDoUpdate({ target: [foodicsConsumptionDays.branchId, foodicsConsumptionDays.businessDate], set: { lines: totals.size, syncedAt: new Date() } });
  return changed;
}

/**
 * الإنتاج في فوديكس → مخزون «سِجل»: الصنف المصنَّع (أرز مطبوخ، خلطة…) يدخل رصيده
 * بحركة «إنتاج» (نوع 5، مراجعها PRD-…) وتُخصم خاماته بحركة «استهلاك إنتاج»
 * (نوع 7، PC-…). بدونهما يُخصم المصنَّع مع كل طلب ولا يدخل أبداً فيبقى سالباً.
 * الحركات قليلة، فتُسحب أحدث صفحة لكل نوع وتُجمع لكل يوم وصنف.
 */
export async function syncProduction(branch: BranchRow, ctx: PostContext): Promise<number> {
  const foodicsBranchId = await foodicsBranchOf(branch.id);
  if (!foodicsBranchId) return 0;
  const db = getDb();
  const start = ctx.start ?? dayBefore(ctx.today, 30);
  const wanted = new Map<string, { itemId: number; date: string; type: "in" | "out"; quantity: number; totalCost: number }>();
  let oldest = ctx.today;
  for (const [type, direction, tag] of [["5", "in", "fprod"], ["7", "out", "fpc"]] as const) {
    let body: Json;
    try {
      body = await foodicsGet(PURCHASING_PATH(), { "filter[type]": type, "filter[branch_id]": foodicsBranchId, sort: "-business_date", include: "items", per_page: "50" });
    } catch (error) {
      if (error instanceof FoodicsError && [400, 404, 422].includes(error.status)) continue;
      throw error;
    }
    for (const o of (Array.isArray(body.data) ? body.data : []) as Json[]) {
      const date = String(o.business_date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || pick(o, "deleted_at")) continue;
      if (date < oldest) oldest = date;
      for (const i of (o.items ?? []) as Json[]) {
        const quantity = Math.abs(num(pick(i, "pivot.quantity", "quantity")));
        if (!quantity) continue;
        const line: DocLine = { name: String(pick(i, "name_localized", "name") ?? ""), sku: String(i.sku ?? ""), unit: String(pick(i, "storage_unit", "ingredient_unit") ?? ""), ordered: 0, received: 0, cost: 0, fid: String(i.id ?? "") };
        const itemId = await itemOfLine(line, ctx);
        if (!itemId) continue;
        const ref = `${tag}:${branch.id}:${date}:${itemId}`;
        const w = wanted.get(ref) ?? { itemId, date, type: direction, quantity: 0, totalCost: 0 };
        w.quantity = round3(w.quantity + quantity);
        w.totalCost = round2(w.totalCost + Math.abs(num(pick(i, "pivot.cost", "cost"))));
        wanted.set(ref, w);
      }
    }
  }
  const existing = (
    await db
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.branchId, branch.id), sql`(${inventoryMovements.sourceRef} like ${`fprod:${branch.id}:%`} or ${inventoryMovements.sourceRef} like ${`fpc:${branch.id}:%`})`))
  ).filter((m) => m.businessDate >= oldest);
  let changed = 0;
  const stale: number[] = [];
  for (const m of existing) {
    const w = wanted.get(m.sourceRef);
    if (!w) {
      stale.push(m.id);
      continue;
    }
    wanted.delete(m.sourceRef);
    if (m.quantity === w.quantity && m.totalCost === w.totalCost) continue;
    await db.update(inventoryMovements).set({ quantity: w.quantity, totalCost: w.totalCost, unitCost: w.quantity ? round2(w.totalCost / w.quantity) : 0, updatedAt: new Date() }).where(eq(inventoryMovements.id, m.id));
    changed++;
  }
  if (stale.length) {
    await db.delete(inventoryMovements).where(inArray(inventoryMovements.id, stale));
    changed += stale.length;
  }
  if (wanted.size) {
    await db.insert(inventoryMovements).values(
      [...wanted].map(([sourceRef, w]) => ({
        branchId: branch.id,
        itemId: w.itemId,
        movementType: w.type,
        businessDate: w.date,
        quantity: w.quantity,
        unitCost: w.quantity ? round2(w.totalCost / w.quantity) : 0,
        totalCost: w.totalCost,
        reason: "manufacture",
        reference: w.type === "in" ? `إنتاج ${w.date}` : `خامات إنتاج ${w.date}`,
        sourceRef,
        notes: w.type === "in" ? "من فوديكس — صنف مصنَّع دخل المخزون" : "من فوديكس — خامات استُهلكت في الإنتاج",
      })),
    );
    changed += wanted.size;
  }
  return changed;
}

/** اليوم وأمس دائماً، ثم استكمال الأيام السابقة من بداية الحسابات ما دام في الوقت متّسع. */
export async function syncConsumption(branch: BranchRow, budgetMs = 8_000) {
  const stats = { days: 0, movements: 0, remaining: 0, production: 0 };
  const foodicsBranchId = await foodicsBranchOf(branch.id);
  if (!foodicsBranchId) return stats;
  const db = getDb();
  const started = Date.now();
  const ctx = await loadPostContext(branch);
  const today = businessDateNow(branch.timezone);
  const yesterday = dayBefore(today);
  const start = ctx.start ?? dayBefore(today, 30);
  const done = new Set(
    (await db.select({ d: foodicsConsumptionDays.businessDate }).from(foodicsConsumptionDays).where(eq(foodicsConsumptionDays.branchId, branch.id))).map((r) => r.d),
  );
  const backlog: string[] = [];
  for (let d = dayBefore(yesterday); d >= start && backlog.length < 120; d = dayBefore(d)) if (!done.has(d)) backlog.push(d);
  const queue = [today, yesterday].filter((d) => d >= start).concat(backlog);
  try {
    stats.production = await syncProduction(branch, ctx);
    for (const [index, date] of queue.entries()) {
      if (index >= 2 && Date.now() - started > budgetMs) {
        stats.remaining = queue.length - index;
        break;
      }
      stats.movements += await syncConsumptionDay(branch, foodicsBranchId, date, ctx);
      stats.days++;
    }
  } catch (error) {
    if (!(error instanceof FoodicsError && [400, 404, 422].includes(error.status))) throw error;
  }
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

  // الكمية الفعلية التي سجّلها المستلِم هي التي تدخل رصيد المخزون
  if (saved) {
    try {
      const [branch] = await db.select({ id: branches.id, timezone: branches.timezone }).from(branches).where(eq(branches.id, doc.branchId));
      if (branch) await postDocToStock(saved, await loadPostContext(branch));
    } catch (error) {
      console.error("[inventory] ترحيل الاستلام للمخزون:", error);
    }
  }

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
      await syncConsumption(branch, 6_000);
    } catch (error) {
      console.error(`[inventory] فرع ${branch.id}:`, (error as Error).message);
    }
    // فواتير رفعها المحاسب للتوّ تُربط باستلامات المورد المصوَّرة المعتمدة
    await import("./supplierReceipts.js")
      .then((m) => m.linkReceipts(branch.id))
      .catch((error) => console.error(`[supplier-receipt] فرع ${branch.id}:`, (error as Error).message));
    reminded += await remindUnconfirmed(branch);
    await runWasteTick(branch).catch((error) => console.error(`[waste] فرع ${branch.id}:`, (error as Error).message));
    await checkTablesWithoutInvoice(branch).catch((error) => console.error(`[leakage] فرع ${branch.id}:`, (error as Error).message));
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
    /** تاريخ العرض والمخزون: تاريخ الفاتورة، وإن لم يُكتب فتاريخ الإدخال في فوديكس */
    date: stockDateOf(d),
    invoiceDate: d.invoiceDate,
    invoiceNumber: d.invoiceNumber,
    supplierRep: [d.supplierRep, d.supplierPhone].filter(Boolean).join(" · "),
    enteredBy: d.enteredBy,
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
  const levels = await sample(LEVEL_PATHS(), foodicsBranchId ? { "filter[branch_id]": foodicsBranchId } : {});
  let branchPivot = "";
  try {
    const body = await foodicsGet(ITEM_PATHS()[0], { include: "branches", per_page: "1" });
    const b = body.data?.[0]?.branches?.[0];
    if (b) branchPivot = JSON.stringify(b).slice(0, 600);
  } catch {
    /* اختياري */
  }
  return {
    levels,
    branchPivot,
    items: await sample(ITEM_PATHS(), { include: "category,branches" }),
    purchaseOrders: await sample(PO_PATHS(), { include: "items,supplier", ...(foodicsBranchId ? { "filter[branch_id]": foodicsBranchId } : {}) }),
    transfers: await sample(TRANSFER_PATHS(), { include: "items" }),
  };
}


/**
 * فحص قراءة فقط لأي مسار مخزون في فوديكس (للمالك): يعيد أول سجلين كما هما
 * لمعرفة أسماء الحقول الفعلية في الحساب. لا يكتب شيئاً في فوديكس.
 */
const PROBE_PATH = /^(inventory|purchase|transfer|warehouse|branches|supplier|reports\/inventory|stock|quantity_adjust|inventory_count|production|waste)[a-z_/0-9-]*$/;
const PRIVATE_KEYS = new Set(["pin", "email", "cc_emails", "password", "token", "api_token"]);

/** يحذف الحقول الحساسة (رموز الدخول والبريد) من رد فوديكس قبل إعادته. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !PRIVATE_KEYS.has(k))
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

/**
 * تصدير للتحليل فقط: صفحة كاملة (50 صفاً) من مسار مخزون في فوديكس كما هي،
 * بلا حفظ أي شيء في «سِجل». للمدير فقط، وبنفس قائمة المسارات المسموحة للفحص.
 */
export async function exportFoodics(path: string, params: Record<string, string>) {
  if (!PROBE_PATH.test(path)) throw new FoodicsError("المسار غير مسموح", 400);
  const body = await foodicsGet(path, { ...params, per_page: "50" });
  return { path, meta: body.meta ?? null, data: scrub(Array.isArray(body.data) ? body.data : []) };
}

export async function probeFoodics(path: string, params: Record<string, string>) {
  if (!PROBE_PATH.test(path)) {
    throw new FoodicsError("المسار غير مسموح للفحص", 400);
  }
  const body = await foodicsGet(path, { per_page: "2", ...params });
  const rows = Array.isArray(body.data) ? body.data.slice(0, 2) : body.data;
  return { path, meta: body.meta ?? null, sample: JSON.stringify(rows, null, 1).slice(0, 8000) };
}
