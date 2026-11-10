/**
 * الربط مع فوديكس (Foodics API v5) والرقابة الثلاثية.
 *
 * يسحب من فوديكس آلياً — بلا إدخال يدوي:
 *   • الفواتير: الحالة، أوقات الفتح والإغلاق وانتهاء التجهيز، الإجمالي،
 *     الخصم، طرق الدفع، الأصناف، ومن أنشأها.
 *   • الهدر وتعديلات الكميات من مخزون فوديكس.
 *
 * ثم يطابق:
 *   1. فتح الدرج المرصود بالكاميرا ↔ فواتير فوديكس في نفس الدقائق.
 *   2. الإلغاء والخصم والاسترجاع في فوديكس ↔ حد التكرار لكل كاشير.
 *   3. وقت تجهيز الطلب من فوديكس ↔ الحد المعتمد (تأخير الزبائن).
 *   4. مبيعات فوديكس ↔ تقفيل الكاشير (الإجمالي والنقد).
 *   5. هدر فوديكس ↔ فرق الجرد اليدوي ↔ هدر الكاميرات.
 *
 * كل ما يخرج من المطابقة «تنبيه يحتاج مراجعة» — لا حكم آلياً على أحد.
 *
 * ملاحظة: أسماء حقول فوديكس تُقرأ بمرونة (عدّة أسماء محتملة لكل حقل) لأن
 * الاستجابة تختلف بين الحسابات والإصدارات؛ وزر «اختبار الاتصال» يعرض
 * الحقول الفعلية الواردة من حسابك للتحقق.
 */

import { and, asc, eq, gte, inArray, like, lt, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  branches,
  cashierClosings,
  employees,
  foodicsConnection,
  foodicsInventoryEvents,
  foodicsOrders,
  inventoryItems,
  inventoryMovements,
  surveillanceAlerts,
  surveillanceCameras,
  surveillanceFrames,
  surveillancePosEvents,
  surveillanceSettings,
  surveillanceWaste,
} from "../db/schema.js";
import { decryptString, encryptString } from "./crypto.js";
import {
  createAlert,
  dayRange,
  ingestOrder,
  ingestPosEvent,
  settingsFor,
  type BranchRow,
} from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone, wallPartsInZone } from "./time.js";

export const DEFAULT_FOODICS_BASE = "https://api.foodics.com/v5";

/* ══ المفتاح والاتصال ══════════════════════════════════════════════ */

export async function foodicsCredentials(): Promise<{ token: string; base: string; source: "env" | "db" } | null> {
  const envToken = process.env.FOODICS_API_TOKEN?.trim();
  const envBase = process.env.FOODICS_API_BASE?.trim();
  if (envToken) return { token: envToken, base: envBase || DEFAULT_FOODICS_BASE, source: "env" };
  const db = getDb();
  const [row] = await db.select().from(foodicsConnection).where(eq(foodicsConnection.id, 1));
  if (!row?.tokenEnc) return null;
  try {
    return { token: decryptString(row.tokenEnc), base: row.apiBase || envBase || DEFAULT_FOODICS_BASE, source: "db" };
  } catch {
    return null;
  }
}

export async function saveFoodicsToken(token: string, apiBase: string, employeeId: number | null) {
  const db = getDb();
  const values = {
    id: 1,
    tokenEnc: token ? encryptString(token) : "",
    apiBase,
    updatedByEmployeeId: employeeId,
    updatedAt: new Date(),
  };
  await db
    .insert(foodicsConnection)
    .values(values)
    .onConflictDoUpdate({ target: foodicsConnection.id, set: values });
}

export class FoodicsError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, any>;

async function foodicsGet(path: string, params: Record<string, string> = {}): Promise<Json> {
  const creds = await foodicsCredentials();
  if (!creds) throw new FoodicsError("مفتاح فوديكس غير مضبوط");
  const url = new URL(`${creds.base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      const wait = Math.min(Number(response.headers.get("retry-after") ?? 2) || 2, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new FoodicsError("فوديكس رفض المفتاح (غير صالح أو بلا صلاحية كافية)", response.status);
    }
    if (!response.ok) throw new FoodicsError(`فوديكس ردّ بالرمز ${response.status} على ${path}`, response.status);
    return (await response.json()) as Json;
  }
  throw new FoodicsError("فوديكس: تجاوز حد الطلبات، سيُعاد المحاولة لاحقاً", 429);
}

/** يقرأ كل صفحات قائمة (حتى `maxPages`). */
async function foodicsList(path: string, params: Record<string, string>, maxPages = 30): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await foodicsGet(path, { ...params, page: String(page) });
    const data = Array.isArray(body.data) ? body.data : [];
    out.push(...data);
    const last = Number(body.meta?.last_page ?? body.meta?.lastPage ?? 0);
    const hasNext = last ? page < last : Boolean(body.links?.next) && data.length > 0;
    if (!hasNext) break;
  }
  return out;
}

/* ══ قراءة حقول فوديكس بمرونة ════════════════════════════════════ */

function pick(obj: Json | null | undefined, ...keys: string[]): any {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = key.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? Number(n) : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** فوديكس يعيد التواريخ بصيغة "YYYY-MM-DD HH:mm:ss" بتوقيت UTC. */
function when(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CHANNEL_OF: Record<number, string> = { 1: "dine_in", 2: "takeaway", 3: "delivery", 4: "drive_thru" };

/**
 * حالة الفاتورة في فوديكس: 4 مغلقة (مدفوعة)، 5 مرتجعة، 3 و7 ملغاة/مرفوضة،
 * 1 و2 مفتوحة. أي رقم آخر يُحفظ كما هو بحالة other.
 */
function stateOf(status: number): string {
  if (status === 4) return "closed";
  if (status === 5) return "returned";
  if (status === 3 || status === 7) return "void";
  if (status === 1 || status === 2) return "open";
  return "other";
}

const DELIVERY_APP_RE = /hunger|هنجر|keeta|كيتا|jahez|جاهز|chefz|شيفز|ذا ?شيف|careem|كريم|marsool|مرسول|toyou|تويو|ninja|نينجا|talabat|طلبات/i;
const CASH_RE = /cash|نقد|كاش/i;
const FOODICS_PAY_RE = /foodics|فودكس|فوديكس/i;

interface Payment {
  name: string;
  /** cash | card | foodics | delivery_app | other */
  kind: string;
  amount: number;
}

function paymentKind(name: string, type: number): string {
  if (CASH_RE.test(name) || type === 1) return "cash";
  if (FOODICS_PAY_RE.test(name)) return "foodics";
  if (DELIVERY_APP_RE.test(name)) return "delivery_app";
  if (type === 2 || /mada|مدى|visa|فيزا|master|ماستر|card|شبكة|بطاقة|stc|apple|ابل/i.test(name)) return "card";
  return "other";
}

function parsePayments(order: Json): Payment[] {
  const list = Array.isArray(order.payments) ? order.payments : [];
  return list.map((p: Json) => {
    const name = String(pick(p, "payment_method.name_localized", "payment_method.name", "name") ?? "دفع");
    const type = num(pick(p, "payment_method.type", "type"));
    return { name, kind: paymentKind(name, type), amount: round2(num(pick(p, "amount", "tendered"))) };
  });
}

interface Item {
  name: string;
  sku: string;
  quantity: number;
  voided: boolean;
  amount: number;
  kitchenDoneAt: Date | null;
}

function parseItems(order: Json): Item[] {
  const list = Array.isArray(order.products) ? order.products : [];
  return list.map((p: Json) => {
    const status = num(p.status);
    const voided = Boolean(pick(p, "void_reason", "void_reason_id", "voided_at")) || p.is_void === true;
    return {
      name: String(pick(p, "product.name_localized", "product.name", "name") ?? ""),
      sku: String(pick(p, "product.sku", "sku") ?? ""),
      quantity: num(pick(p, "quantity")),
      voided: voided || status === 3,
      amount: round2(num(pick(p, "total_price", "unit_price"))),
      kitchenDoneAt: when(pick(p, "kitchen_done_at", "kitchen_prepared_at", "prepared_at", "kitchen_served_at")),
    };
  });
}

/* ══ مزامنة الفواتير ═════════════════════════════════════════════ */

async function employeeByName(name: string, cache: Map<string, number | null>): Promise<number | null> {
  const key = name.trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  const db = getDb();
  const rows = await db
    .select({ id: employees.id, fullName: employees.fullName, code: employees.employeeCode })
    .from(employees);
  const lower = key.toLowerCase();
  const hit =
    rows.find((r) => r.fullName.trim().toLowerCase() === lower || r.code.toLowerCase() === lower) ??
    rows.find((r) => r.fullName.toLowerCase().includes(lower) || lower.includes(r.fullName.trim().toLowerCase()));
  cache.set(key, hit?.id ?? null);
  return hit?.id ?? null;
}

interface SyncStats {
  orders: number;
  posEvents: number;
  prepOrders: number;
  waste: number;
  drawerMatched: number;
  drawerUnmatched: number;
  alerts: number[];
  notes: string[];
  /** آخر updated_at عولج — تُستأنف منه المزامنة إن انقطعت بسبب المهلة */
  resumeFrom: Date | null;
  partial: boolean;
}

async function posEventExists(branchId: number, key: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: surveillancePosEvents.id })
    .from(surveillancePosEvents)
    .where(
      and(
        eq(surveillancePosEvents.branchId, branchId),
        eq(surveillancePosEvents.source, "foodics"),
        like(surveillancePosEvents.notes, `[${key}]%`),
      ),
    );
  return Boolean(row);
}

async function syncOrders(branch: BranchRow, foodicsBranchId: string, since: Date, stats: SyncStats, deadline: number) {
  const db = getDb();
  const updatedAfter = since.toISOString().slice(0, 19).replace("T", " ");
  const params: Record<string, string> = {
    "filter[branch_id]": foodicsBranchId,
    "filter[updated_after]": updatedAfter,
    include: "products.product,payments.payment_method,creator",
    sort: "updated_at",
    per_page: "100",
  };
  const list = await foodicsList("orders", params);
  list.sort((a, b) => String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")));
  const nameCache = new Map<string, number | null>();

  for (const o of list) {
    if (Date.now() > deadline) {
      stats.partial = true;
      break;
    }
    const foodicsId = String(o.id ?? "");
    if (!foodicsId) continue;
    const updatedAt = when(o.updated_at);
    if (updatedAt) stats.resumeFrom = updatedAt;
    const status = num(o.status);
    const state = stateOf(status);
    const items = parseItems(o);
    const payments = parsePayments(o);
    const openedAt = when(pick(o, "opened_at", "created_at"));
    const closedAt = when(pick(o, "closed_at"));
    const itemDone = items.map((i) => i.kitchenDoneAt).filter((d): d is Date => Boolean(d));
    const kitchenDoneAt =
      when(pick(o, "kitchen_done_at", "kitchen_ready_at", "ready_at", "prepared_at")) ??
      (itemDone.length ? new Date(Math.max(...itemDone.map((d) => d.getTime()))) : null);
    const creatorName = String(pick(o, "creator.name", "closer.name", "cashier.name") ?? "");
    const cashierId = await employeeByName(creatorName, nameCache);
    const reference = String(pick(o, "reference", "number", "check_number") ?? foodicsId);
    const total = round2(num(pick(o, "total_price", "total", "subtotal_price")));
    const discount = round2(num(pick(o, "discount_amount", "total_discount", "discount")));
    const channel = CHANNEL_OF[num(o.type)] ?? "dine_in";

    const values = {
      branchId: branch.id,
      foodicsId,
      reference,
      businessDate: (pick(o, "business_date") as string | undefined)?.slice(0, 10) ?? null,
      channel,
      status,
      state,
      openedAt,
      closedAt,
      kitchenDoneAt,
      total,
      discount,
      paymentsJson: JSON.stringify(payments),
      itemsJson: JSON.stringify(items.map(({ kitchenDoneAt: _k, ...rest }) => rest)),
      creatorName,
      cashierEmployeeId: cashierId,
      syncedAt: new Date(),
    };
    await db
      .insert(foodicsOrders)
      .values(values)
      .onConflictDoUpdate({ target: [foodicsOrders.branchId, foodicsOrders.foodicsId], set: values });
    stats.orders++;

    const at = closedAt ?? openedAt ?? new Date();
    const posBase = {
      cashierEmployeeId: cashierId ?? undefined,
      cashierName: creatorName,
      orderRef: reference,
      occurredAt: at.toISOString(),
    };

    // ── أحداث الكاشير الحساسة: الإلغاء، الاسترجاع، الخصم ──
    const events: Array<{ key: string; eventType: string; amount: number; note: string }> = [];
    if (state === "void") events.push({ key: `foodics:${foodicsId}:void`, eventType: "void", amount: total, note: "فاتورة ملغاة في فوديكس" });
    if (state === "returned") events.push({ key: `foodics:${foodicsId}:refund`, eventType: "refund", amount: total, note: "فاتورة مرتجعة في فوديكس" });
    if (discount > 0 && state !== "void") events.push({ key: `foodics:${foodicsId}:discount`, eventType: "discount", amount: discount, note: "خصم على الفاتورة في فوديكس" });
    items.forEach((item, index) => {
      if (item.voided && state !== "void") {
        events.push({
          key: `foodics:${foodicsId}:item${index}`,
          eventType: "void",
          amount: item.amount,
          note: `إلغاء صنف «${item.name}» × ${item.quantity} من الفاتورة`,
        });
      }
    });
    for (const event of events) {
      if (await posEventExists(branch.id, event.key)) continue;
      const result = await ingestPosEvent(
        branch,
        { ...posBase, eventType: event.eventType, amount: event.amount, notes: `[${event.key}] ${event.note}` },
        "foodics",
        null,
      );
      stats.posEvents++;
      stats.alerts.push(...result.alerts);
    }

    // ── توقيت التجهيز (تأخير الزبائن): فقط إن أرسلت فوديكس وقت انتهاء المطبخ ──
    if (openedAt && kitchenDoneAt && kitchenDoneAt >= openedAt && state !== "void") {
      const result = await ingestOrder(
        branch,
        {
          orderRef: reference,
          itemName: "",
          channel: channel === "drive_thru" ? "takeaway" : channel,
          registeredAt: openedAt.toISOString(),
          deliveredAt: kitchenDoneAt.toISOString(),
          hasInvoice: true,
          preparedByEmployeeId: undefined,
          notes: "من فوديكس",
        },
        "foodics",
        null,
      );
      stats.prepOrders++;
      stats.alerts.push(...result.alerts);
    }
  }
}

/* ══ مزامنة الهدر من مخزون فوديكس ════════════════════════════════ */

const WASTE_RE = /waste|هدر|تالف|spoil|expir|منتهي|damage|تلف|rotten|فاسد/i;

/** مسارات مخزون فوديكس المحتملة لتعديلات الكميات والهدر — يُجرَّب الأول المتاح. */
function wastePaths(): string[] {
  const custom = process.env.FOODICS_WASTE_PATH?.trim();
  return custom ? [custom] : ["quantity_adjustments", "inventory_adjustments", "waste"];
}

async function syncWaste(branch: BranchRow, foodicsBranchId: string, since: Date, stats: SyncStats) {
  const db = getDb();
  const tz = safeTimeZone(branch.timezone);
  let docs: Json[] | null = null;
  let usedPath = "";
  for (const path of wastePaths()) {
    try {
      docs = await foodicsList(
        path,
        {
          "filter[branch_id]": foodicsBranchId,
          "filter[updated_after]": since.toISOString().slice(0, 19).replace("T", " "),
          include: "items,reason,branch",
          per_page: "100",
        },
        10,
      );
      usedPath = path;
      break;
    } catch (error) {
      if (error instanceof FoodicsError && (error.status === 404 || error.status === 400)) continue;
      throw error;
    }
  }
  if (!docs) {
    stats.notes.push("لم يُعثر على مسار الهدر/تعديل الكميات في حساب فوديكس (ضع FOODICS_WASTE_PATH إن كان مختلفاً)");
    return;
  }

  for (const doc of docs) {
    const docId = String(doc.id ?? "");
    const reason = String(pick(doc, "reason.name_localized", "reason.name", "reason", "notes") ?? "");
    const occurredAt = when(pick(doc, "business_date", "submitted_at", "created_at", "updated_at")) ?? new Date();
    const lines = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.lines) ? doc.lines : [];
    for (const [index, line] of lines.entries()) {
      const sku = String(pick(line, "sku", "item.sku") ?? "");
      const quantity = num(pick(line, "pivot.quantity", "quantity", "pivot.adjusted_quantity"));
      const lineReason = String(pick(line, "pivot.reason", "reason.name", "reason") ?? "") || reason;
      const kind = WASTE_RE.test(lineReason) || usedPath === "waste" ? "waste" : "adjustment";
      const key = `${usedPath}:${docId}:${sku || index}`;
      const values = {
        branchId: branch.id,
        foodicsKey: key,
        kind,
        occurredAt,
        businessDate: isoDateInZone(occurredAt, tz),
        itemName: String(pick(line, "name_localized", "name", "item.name") ?? "").slice(0, 150),
        sku,
        quantity: Math.abs(quantity),
        unit: String(pick(line, "storage_unit", "ingredient_unit", "unit") ?? "").slice(0, 30),
        cost: round2(num(pick(line, "pivot.cost", "cost")) * (pick(line, "pivot.cost") !== undefined ? Math.abs(quantity) : 1)),
        reason: lineReason.slice(0, 200),
        syncedAt: new Date(),
      };
      const inserted = await db
        .insert(foodicsInventoryEvents)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: foodicsInventoryEvents.id });
      if (!inserted.length) continue;
      stats.waste++;
      if (kind === "waste") {
        await db.insert(surveillanceWaste).values({
          branchId: branch.id,
          occurredAt,
          itemName: values.itemName || sku || "صنف",
          quantity: values.quantity,
          unit: values.unit,
          reason: /expir|منتهي/i.test(lineReason) ? "expired" : /spoil|تالف|فاسد|rotten/i.test(lineReason) ? "spoiled" : "other",
          station: "مخزون فوديكس",
          notes: `[foodics:${key}] ${lineReason}`.slice(0, 500),
        });
      }
    }
  }
}

/* ══ المطابقة 1: فتح الدرج ↔ فواتير فوديكس ═══════════════════════ */

function hhmm(at: Date, tz: string): string {
  const p = wallPartsInZone(at, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

async function matchDrawerEvents(branch: BranchRow, settings: Awaited<ReturnType<typeof settingsFor>>, syncedUntil: Date, stats: SyncStats) {
  const db = getDb();
  const tz = safeTimeZone(branch.timezone);
  const windowMs = Math.max(1, settings.foodicsMatchMinutes) * 60_000;
  const pending = await db
    .select()
    .from(surveillancePosEvents)
    .where(
      and(
        eq(surveillancePosEvents.branchId, branch.id),
        eq(surveillancePosEvents.eventType, "drawer_no_sale"),
        eq(surveillancePosEvents.matchStatus, ""),
        gte(surveillancePosEvents.occurredAt, new Date(Date.now() - 3 * 86_400_000)),
        // لا نحكم قبل أن تغطي المزامنة نافذة الحدث كاملة
        lte(surveillancePosEvents.occurredAt, new Date(syncedUntil.getTime() - windowMs)),
      ),
    )
    .limit(200);

  for (const event of pending) {
    const from = new Date(event.occurredAt.getTime() - windowMs);
    const to = new Date(event.occurredAt.getTime() + windowMs);
    const near = await db
      .select()
      .from(foodicsOrders)
      .where(
        and(
          eq(foodicsOrders.branchId, branch.id),
          sql`(${foodicsOrders.closedAt} BETWEEN ${from} AND ${to} OR ${foodicsOrders.openedAt} BETWEEN ${from} AND ${to})`,
        ),
      )
      .orderBy(asc(foodicsOrders.closedAt))
      .limit(5);
    const cashOrders = near.filter((o) => o.state === "closed" || o.state === "returned");
    const matched = cashOrders.length > 0;
    const note = matched
      ? `مطابقة فوديكس: ${cashOrders
          .map((o) => `فاتورة #${o.reference} ${o.closedAt ? hhmm(o.closedAt, tz) : ""} بمبلغ ${o.total}${o.creatorName ? ` (${o.creatorName})` : ""}`)
          .join("، ")} — يرجَّح أن فتح الدرج مبرَّر.`
      : `مطابقة فوديكس: لا توجد أي فاتورة مغلقة في فوديكس خلال ±${settings.foodicsMatchMinutes} دقيقة من فتح الدرج — الاشتباه قائم ويحتاج مراجعة المقطع.`;

    await db
      .update(surveillancePosEvents)
      .set({ matchStatus: matched ? "matched" : "unmatched", matchNote: note.slice(0, 800) })
      .where(eq(surveillancePosEvents.id, event.id));
    if (matched) stats.drawerMatched++;
    else stats.drawerUnmatched++;

    // تحديث تنبيه الكاميرا المقابل (نفس الكاميرا، خلال دقيقة من الحدث)
    const alerts = await db
      .select({ id: surveillanceAlerts.id, details: surveillanceAlerts.details, status: surveillanceAlerts.status })
      .from(surveillanceAlerts)
      .where(
        and(
          eq(surveillanceAlerts.branchId, branch.id),
          eq(surveillanceAlerts.alertType, "drawer_no_sale"),
          gte(surveillanceAlerts.occurredAt, new Date(event.occurredAt.getTime() - 90_000)),
          lte(surveillanceAlerts.occurredAt, new Date(event.occurredAt.getTime() + 90_000)),
          event.cameraId ? eq(surveillanceAlerts.cameraId, event.cameraId) : sql`true`,
        ),
      );
    for (const alert of alerts) {
      if (alert.details.includes("مطابقة فوديكس")) continue;
      await db
        .update(surveillanceAlerts)
        .set({
          details: `${alert.details}\n${note}`.slice(0, 2000),
          // المطابقة تُغيّر الثقة فقط؛ الحسم يبقى للمراجعة البشرية
          confidence: matched ? "low" : "high",
          updatedAt: new Date(),
        })
        .where(eq(surveillanceAlerts.id, alert.id));
    }
  }
}

/* ══ المطابقة 4 و5: المبيعات والهدر لكل يوم ═════════════════════ */

export async function foodicsDaySales(branchId: number, date: string, cashierEmployeeId?: number | null) {
  const db = getDb();
  const rows = await db
    .select()
    .from(foodicsOrders)
    .where(
      and(
        eq(foodicsOrders.branchId, branchId),
        eq(foodicsOrders.businessDate, date),
        cashierEmployeeId ? eq(foodicsOrders.cashierEmployeeId, cashierEmployeeId) : sql`true`,
      ),
    );
  const byMethod = new Map<string, { name: string; kind: string; amount: number }>();
  let total = 0;
  let discounts = 0;
  let refunds = 0;
  let voids = 0;
  let invoices = 0;
  for (const o of rows) {
    if (o.state === "closed") {
      invoices++;
      total += o.total;
      discounts += o.discount;
      for (const p of JSON.parse(o.paymentsJson) as Payment[]) {
        const current = byMethod.get(p.name) ?? { name: p.name, kind: p.kind, amount: 0 };
        current.amount += p.amount;
        byMethod.set(p.name, current);
      }
    } else if (o.state === "returned") {
      refunds += o.total;
    } else if (o.state === "void") {
      voids += o.total;
    }
  }
  const methods = [...byMethod.values()].map((m) => ({ ...m, amount: round2(m.amount) }));
  const sumKind = (kind: string) => round2(methods.filter((m) => m.kind === kind).reduce((s, m) => s + m.amount, 0));
  return {
    orders: rows.length,
    invoices,
    total: round2(total),
    discounts: round2(discounts),
    refunds: round2(refunds),
    voids: round2(voids),
    cash: sumKind("cash"),
    card: sumKind("card"),
    foodicsPay: sumKind("foodics"),
    deliveryApps: sumKind("delivery_app"),
    other: sumKind("other"),
    methods,
  };
}

async function checkSalesGap(branch: BranchRow, date: string, tolerance: number, stats: SyncStats) {
  const db = getDb();
  const closings = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branch.id), eq(cashierClosings.businessDate, date)));
  if (!closings.length) return;
  const sales = await foodicsDaySales(branch.id, date);
  if (!sales.orders) return;
  const closingTotal = round2(closings.reduce((s, c) => s + c.totalSales, 0));
  const closingCash = round2(closings.reduce((s, c) => s + c.cashSales, 0));
  const totalGap = round2(closingTotal - sales.total);
  const cashGap = round2(closingCash - sales.cash);
  if (Math.abs(totalGap) <= tolerance && Math.abs(cashGap) <= tolerance) return;
  const result = await createAlert({
    branchId: branch.id,
    alertType: "sales_gap",
    occurredAt: dayRange(date, branch.timezone).end,
    location: "الكاشير",
    employeeIds: [...new Set(closings.map((c) => c.employeeId).filter((id): id is number => Boolean(id)))],
    confidence: "high",
    details: `يوم ${date}: إجمالي التقفيل ${closingTotal} مقابل فوديكس ${sales.total} (فرق ${totalGap})، والنقد في التقفيل ${closingCash} مقابل نقد فوديكس ${sales.cash} (فرق ${cashGap}). الحد المسموح ${tolerance} ريال.`,
    source: "auto",
    sourceRef: `sales-gap:${date}:${closingTotal}:${closingCash}`,
  });
  stats.alerts.push(result.id);
}

export async function inventoryTriple(branchId: number, date: string, timeZone: string) {
  const db = getDb();
  const { start, end } = dayRange(date, timeZone);
  const [fWaste, movements, camWaste, items] = await Promise.all([
    db
      .select()
      .from(foodicsInventoryEvents)
      .where(and(eq(foodicsInventoryEvents.branchId, branchId), eq(foodicsInventoryEvents.businessDate, date))),
    db
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.branchId, branchId), eq(inventoryMovements.businessDate, date))),
    db
      .select()
      .from(surveillanceWaste)
      .where(and(eq(surveillanceWaste.branchId, branchId), gte(surveillanceWaste.occurredAt, start), lt(surveillanceWaste.occurredAt, end))),
    db.select({ id: inventoryItems.id, code: inventoryItems.code, name: inventoryItems.name, unit: inventoryItems.unit }).from(inventoryItems),
  ]);

  type RowT = { item: string; code: string; unit: string; foodicsWaste: number; foodicsAdjust: number; manualWaste: number; countVariance: number; cameraWaste: number };
  const rows = new Map<string, RowT>();
  const norm = (s: string) => s.trim().toLowerCase();
  const itemById = new Map(items.map((i) => [i.id, i]));
  const keyFor = (code: string, name: string) => {
    const hit = items.find((i) => (code && norm(i.code) === norm(code)) || norm(i.name) === norm(name));
    return hit ? `item:${hit.id}` : `name:${norm(name || code)}`;
  };
  const get = (key: string, name: string, code: string, unit: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { item: name, code, unit, foodicsWaste: 0, foodicsAdjust: 0, manualWaste: 0, countVariance: 0, cameraWaste: 0 };
      rows.set(key, r);
    }
    return r;
  };

  for (const e of fWaste) {
    const r = get(keyFor(e.sku, e.itemName), e.itemName, e.sku, e.unit);
    if (e.kind === "waste") r.foodicsWaste += e.quantity;
    else r.foodicsAdjust += e.quantity;
  }
  for (const m of movements) {
    const item = itemById.get(m.itemId);
    if (!item) continue;
    const r = get(`item:${item.id}`, item.name, item.code, item.unit);
    if (m.movementType === "out" && m.reason === "waste") r.manualWaste += m.quantity;
    if (m.movementType === "count") r.countVariance += m.variance;
  }
  for (const w of camWaste) {
    if (w.notes.startsWith("[foodics:")) continue; // منقول من فوديكس، ليس مشاهدة كاميرا
    const r = get(keyFor("", w.itemName), w.itemName, "", w.unit);
    r.cameraWaste += 1;
  }

  return [...rows.values()]
    .map((r) => {
      const shortage = r.countVariance < 0 ? -r.countVariance : 0;
      const explained = r.foodicsWaste + r.manualWaste;
      const unexplained = shortage > 0 && explained === 0;
      return {
        ...r,
        foodicsWaste: Math.round(r.foodicsWaste * 1000) / 1000,
        manualWaste: Math.round(r.manualWaste * 1000) / 1000,
        countVariance: Math.round(r.countVariance * 1000) / 1000,
        flag: unexplained ? "unexplained_shortage" : r.cameraWaste > 0 && explained === 0 ? "camera_only" : "",
      };
    })
    .sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0));
}

async function checkWasteGap(branch: BranchRow, date: string, stats: SyncStats) {
  const rows = await inventoryTriple(branch.id, date, branch.timezone);
  for (const r of rows.filter((x) => x.flag)) {
    const details =
      r.flag === "unexplained_shortage"
        ? `الصنف «${r.item}» يوم ${date}: الجرد اليدوي أظهر نقصاً ${-r.countVariance} ${r.unit} بلا هدر مسجّل في فوديكس ولا في حركة المخزون.${r.cameraWaste ? ` الكاميرات رصدت ${r.cameraWaste} مشاهدة هدر.` : ""}`
        : `الصنف «${r.item}» يوم ${date}: الكاميرات رصدت ${r.cameraWaste} مشاهدة هدر بلا أي هدر مسجّل في فوديكس أو المخزون.`;
    const result = await createAlert({
      branchId: branch.id,
      alertType: "waste_gap",
      occurredAt: dayRange(date, branch.timezone).end,
      location: "المستودع",
      confidence: r.flag === "unexplained_shortage" ? "high" : "medium",
      details,
      source: "auto",
      sourceRef: `waste-gap:${date}:${r.code || r.item}`.slice(0, 200),
    });
    stats.alerts.push(result.id);
  }
}

/* ══ تشغيل المزامنة ══════════════════════════════════════════════ */

export async function syncBranch(branch: BranchRow, options: { force?: boolean; budgetMs?: number } = {}) {
  const db = getDb();
  const settings = await settingsFor(branch.id);
  const [row] = await db.select().from(surveillanceSettings).where(eq(surveillanceSettings.branchId, branch.id));
  const foodicsBranchId = row?.foodicsBranchId ?? "";
  if (!foodicsBranchId) throw new FoodicsError("الفرع غير مربوط بفرع في فوديكس");

  const now = new Date();
  const last = row?.foodicsLastSyncAt;
  // تداخل 20 دقيقة مع المزامنة السابقة لالتقاط التعديلات المتأخرة؛ وأول مرة يومان
  const since = last && !options.force ? new Date(last.getTime() - 20 * 60_000) : new Date(now.getTime() - 2 * 86_400_000);
  const stats: SyncStats = {
    orders: 0,
    posEvents: 0,
    prepOrders: 0,
    waste: 0,
    drawerMatched: 0,
    drawerUnmatched: 0,
    alerts: [],
    notes: [],
    resumeFrom: null,
    partial: false,
  };
  const deadline = Date.now() + (options.budgetMs ?? 15_000);

  try {
    await syncOrders(branch, foodicsBranchId, since, stats, deadline);
    if (stats.partial) {
      // انقطاع بسبب المهلة: نحفظ نقطة الاستئناف ونكمل في الدورة التالية
      stats.notes.push("المزامنة جزئية (كمية كبيرة) — تُستكمل تلقائياً في الدورة التالية");
      await db
        .update(surveillanceSettings)
        .set({
          // +20 دقيقة تعادل التداخل المطروح عند الاستئناف، فتبدأ الدورة التالية من نقطة التوقف
          foodicsLastSyncAt: new Date((stats.resumeFrom ?? since).getTime() + 20 * 60_000),
          foodicsLastError: stats.notes.join(" | "),
        })
        .where(eq(surveillanceSettings.branchId, branch.id));
      return stats;
    }
    try {
      await syncWaste(branch, foodicsBranchId, since, stats);
    } catch (error) {
      stats.notes.push(`الهدر: ${(error as Error).message}`);
    }
    await matchDrawerEvents(branch, { ...settings, foodicsMatchMinutes: row?.foodicsMatchMinutes ?? 3 }, now, stats);

    // المبيعات والهدر تُطابق للأيام المنتهية فقط (أمس وما قبله بيومين)
    const tz = safeTimeZone(branch.timezone);
    for (let back = 1; back <= 2; back++) {
      const date = isoDateInZone(new Date(now.getTime() - back * 86_400_000), tz);
      await checkSalesGap(branch, date, row?.salesGapTolerance ?? 5, stats);
      await checkWasteGap(branch, date, stats);
    }

    await db
      .update(surveillanceSettings)
      .set({ foodicsLastSyncAt: now, foodicsLastError: stats.notes.join(" | ").slice(0, 500) })
      .where(eq(surveillanceSettings.branchId, branch.id));
  } catch (error) {
    await db
      .update(surveillanceSettings)
      .set({ foodicsLastError: (error as Error).message.slice(0, 500) })
      .where(eq(surveillanceSettings.branchId, branch.id));
    throw error;
  }
  return stats;
}

/** المزامنة الدورية لكل الفروع المربوطة. */
export async function runFoodicsSync(budgetMs = 26_000) {
  if (!(await foodicsCredentials())) return { branches: 0 };
  const db = getDb();
  const started = Date.now();
  const linked = await db
    .select({ branch: branches })
    .from(surveillanceSettings)
    .innerJoin(branches, eq(branches.id, surveillanceSettings.branchId))
    .where(ne(surveillanceSettings.foodicsBranchId, ""));
  let done = 0;
  for (const { branch } of linked) {
    if (Date.now() - started > budgetMs) break;
    try {
      await syncBranch(branch, { budgetMs: Math.max(5_000, budgetMs - (Date.now() - started) - 8_000) });
      done++;
    } catch (error) {
      console.error(`[foodics] فرع ${branch.id}:`, (error as Error).message);
    }
  }
  return { branches: done };
}

/** اختبار الاتصال: قائمة فروع فوديكس + أسماء حقول أول فاتورة للتحقق. */
export async function testFoodics() {
  const body = await foodicsGet("branches", { per_page: "50" });
  const list = (Array.isArray(body.data) ? body.data : []) as Json[];
  let orderFields: string[] = [];
  try {
    const orders = await foodicsGet("orders", { per_page: "1", include: "products.product,payments.payment_method,creator" });
    const first = Array.isArray(orders.data) ? orders.data[0] : null;
    if (first) {
      orderFields = Object.keys(first);
      const product = Array.isArray(first.products) ? first.products[0] : null;
      if (product) orderFields.push(...Object.keys(product).map((k) => `products.${k}`));
    }
  } catch {
    /* الفروع تكفي لإثبات الاتصال */
  }
  return {
    branches: list.map((b) => ({
      id: String(b.id),
      name: String(pick(b, "name_localized", "name") ?? ""),
      reference: String(b.reference ?? ""),
    })),
    orderFields,
  };
}

/* ══ تقرير الرقابة الثلاثية ليوم ═════════════════════════════════ */

export async function tripleReport(branch: BranchRow, date: string) {
  const db = getDb();
  const tz = safeTimeZone(branch.timezone);
  const { start, end } = dayRange(date, branch.timezone);
  const [sales, closings, posEvents, orders, frames, alerts, inventory] = await Promise.all([
    foodicsDaySales(branch.id, date),
    db.select().from(cashierClosings).where(and(eq(cashierClosings.branchId, branch.id), eq(cashierClosings.businessDate, date))),
    db
      .select()
      .from(surveillancePosEvents)
      .where(and(eq(surveillancePosEvents.branchId, branch.id), gte(surveillancePosEvents.occurredAt, start), lt(surveillancePosEvents.occurredAt, end)))
      .orderBy(asc(surveillancePosEvents.occurredAt)),
    db
      .select()
      .from(foodicsOrders)
      .where(and(eq(foodicsOrders.branchId, branch.id), eq(foodicsOrders.businessDate, date))),
    db
      .select({ capturedAt: surveillanceFrames.capturedAt, peopleCount: surveillanceFrames.peopleCount, zone: surveillanceCameras.zone })
      .from(surveillanceFrames)
      .innerJoin(surveillanceCameras, eq(surveillanceCameras.id, surveillanceFrames.cameraId))
      .where(
        and(
          eq(surveillanceFrames.branchId, branch.id),
          gte(surveillanceFrames.capturedAt, start),
          lt(surveillanceFrames.capturedAt, end),
          inArray(surveillanceCameras.zone, ["dining", "entrance", "cashier"]),
        ),
      ),
    db
      .select({ alertType: surveillanceAlerts.alertType, status: surveillanceAlerts.status })
      .from(surveillanceAlerts)
      .where(and(eq(surveillanceAlerts.branchId, branch.id), gte(surveillanceAlerts.occurredAt, start), lt(surveillanceAlerts.occurredAt, end))),
    inventoryTriple(branch.id, date, branch.timezone),
  ]);

  const closingTotal = round2(closings.reduce((s, c) => s + c.totalSales, 0));
  const closingCash = round2(closings.reduce((s, c) => s + c.cashSales, 0));

  // الكاشيرات: إلغاء/خصم/استرجاع من فوديكس
  const byCashier = new Map<string, { name: string; void: number; discount: number; refund: number; amount: number }>();
  for (const e of posEvents.filter((p) => p.source === "foodics")) {
    const name = e.cashierName || "غير معروف";
    const r = byCashier.get(name) ?? { name, void: 0, discount: 0, refund: 0, amount: 0 };
    if (e.eventType === "void") r.void++;
    if (e.eventType === "discount") r.discount++;
    if (e.eventType === "refund") r.refund++;
    r.amount += e.amount;
    byCashier.set(name, r);
  }

  // تأخير الزبائن: من أوقات المطبخ في فوديكس
  const prep = orders
    .filter((o) => o.openedAt && o.kitchenDoneAt && o.state !== "void")
    .map((o) => (o.kitchenDoneAt!.getTime() - o.openedAt!.getTime()) / 60_000);
  const settings = await settingsFor(branch.id);
  const count = (type: string) => alerts.filter((a) => a.alertType === type).length;

  // ساعة بساعة: فواتير فوديكس مقابل أعلى عدد أشخاص رصدته الكاميرات (مؤشر تقريبي)
  const hours = new Map<number, { invoices: number; peopleMax: number }>();
  for (const o of orders) {
    if (o.state !== "closed" || !o.openedAt) continue;
    const h = wallPartsInZone(o.openedAt, tz).hour;
    const r = hours.get(h) ?? { invoices: 0, peopleMax: 0 };
    r.invoices++;
    hours.set(h, r);
  }
  for (const f of frames) {
    const h = wallPartsInZone(f.capturedAt, tz).hour;
    const r = hours.get(h) ?? { invoices: 0, peopleMax: 0 };
    r.peopleMax = Math.max(r.peopleMax, f.peopleCount);
    hours.set(h, r);
  }

  return {
    date,
    branch: { id: branch.id, name: branch.name },
    sales: {
      foodics: sales,
      closings: { count: closings.length, total: closingTotal, cash: closingCash },
      totalGap: closings.length ? round2(closingTotal - sales.total) : null,
      cashGap: closings.length ? round2(closingCash - sales.cash) : null,
    },
    drawer: posEvents
      .filter((p) => p.eventType === "drawer_no_sale")
      .map((p) => ({ at: p.occurredAt, cashier: p.cashierName, match: p.matchStatus || "pending", note: p.matchNote })),
    cashiers: [...byCashier.values()].map((c) => ({ ...c, amount: round2(c.amount) })),
    service: {
      ordersWithKitchenTime: prep.length,
      avgPrepMinutes: prep.length ? round2(prep.reduce((s, m) => s + m, 0) / prep.length) : null,
      overTarget: prep.filter((m) => m > settings.defaultPrepMinutes).length,
      targetMinutes: settings.defaultPrepMinutes,
      customerWaitAlerts: count("customer_wait"),
    },
    hourly: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, ...v })),
    inventory,
    alerts: {
      fridgeDoorOpen: count("fridge_door_open"),
      warehouseOffHours: count("warehouse_off_hours"),
      warehouseExit: count("warehouse_exit"),
      salesGap: count("sales_gap"),
      wasteGap: count("waste_gap"),
      drawer: count("drawer_no_sale"),
      repeatedPos: count("repeated_pos"),
    },
  };
}

export async function foodicsStatus(branchId: number) {
  const db = getDb();
  const creds = await foodicsCredentials();
  const [row] = await db.select().from(surveillanceSettings).where(eq(surveillanceSettings.branchId, branchId));
  const [{ orders }] = await db
    .select({ orders: sql<number>`count(*)::int` })
    .from(foodicsOrders)
    .where(eq(foodicsOrders.branchId, branchId));
  return {
    connected: Boolean(creds),
    tokenSource: creds?.source ?? null,
    apiBase: creds?.base ?? DEFAULT_FOODICS_BASE,
    foodicsBranchId: row?.foodicsBranchId ?? "",
    matchMinutes: row?.foodicsMatchMinutes ?? 3,
    salesGapTolerance: row?.salesGapTolerance ?? 5,
    lastSyncAt: row?.foodicsLastSyncAt ?? null,
    lastError: row?.foodicsLastError ?? "",
    ordersStored: Number(orders),
  };
}

