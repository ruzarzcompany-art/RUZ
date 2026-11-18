/**
 * كشف ما يخرج بلا فاتورة — من جهتين مستقلتين:
 *
 * 1) جلسة طاولة بلا فاتورة: جهاز التحليل يسجّل لكل طاولة مرسومة متى جلس العملاء
 *    ومتى غادروا. كل جلسة طالت عن الحد تُطابَق بفاتورة محلية/سفري في فوديكس ضمن
 *    نافذة زمنية حولها (الطلب قد يسبق الجلوس عند الكاشير، والدفع قد يلي المغادرة).
 *    الجلسة التي لا تجد فاتورة → «اشتباه يحتاج مراجعة» للمالك مع رقم الطاولة.
 *    المطابقة واحد-لواحد، والمجموعة على طاولتين متزامنتين تُحسب بفاتورة واحدة.
 *
 * 2) فروقات الجرد: الرصيد الدفتري = المشتريات − استهلاك الوصفات − الهدر المعتمد.
 *    نقص المعدود عنه هو ما خرج بلا تسجيل (وجبة بلا فاتورة، هدر لم يُسجَّل، زيادة
 *    في الحصص). يُحوَّل إلى مبيعات تقريبية بنسبة تكلفة الطعام الفعلية للفترة.
 */

import { and, asc, eq, gte, inArray, isNotNull, lt, lte, ne } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { cashierClosings, controlTableSessions, foodicsOrders, inventoryItems, inventoryMovements } from "../db/schema.js";
import { businessDateNow } from "./dayClose.js";
import { createAlert, type BranchRow } from "./routes/surveillance.js";
import { safeTimeZone } from "./time.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/* ══ 1) جلسة طاولة بلا فاتورة ═════════════════════════════════════ */

/** أقصر جلسة تُعدّ «أكلاً على الطاولة» (أقل منها انتظار أو مرور). */
export const MIN_SESSION_MINUTES = 12;
/** الفاتورة تُقبل إن فُتحت/أُغلقت قبل الجلوس بهذا القدر أو بعد المغادرة بالقدر التالي. */
export const INVOICE_BEFORE_MINUTES = 30;
export const INVOICE_AFTER_MINUTES = 20;
/** مهلة بعد المغادرة قبل الحكم (حتى تصل الفاتورة من فوديكس). */
export const SETTLE_MINUTES = 30;

export interface SessionLike {
  id: number;
  tableLabel: string;
  seatedAt: Date;
  leftAt: Date;
  maxPeople: number;
}
export interface InvoiceLike {
  id: number;
  reference: string;
  at: Date[];
}

/**
 * يطابق الجلسات بالفواتير ويعيد الجلسات التي لم تجد فاتورة.
 * جلسة بلا فاتورة حرّة لكنها متزامنة (نصف مدتها فأكثر) مع جلسة مطابَقة تُعدّ
 * من نفس المجموعة (طاولتان متجاورتان بفاتورة واحدة) فلا تُعدّ اشتباهاً.
 */
export function unmatchedSessions(sessions: SessionLike[], invoices: InvoiceLike[]): SessionLike[] {
  const minute = 60_000;
  const eligible = sessions
    .filter((s) => s.leftAt.getTime() - s.seatedAt.getTime() >= MIN_SESSION_MINUTES * minute)
    .sort((a, b) => a.seatedAt.getTime() - b.seatedAt.getTime());
  const used = new Set<number>();
  const matched: SessionLike[] = [];
  const pending: SessionLike[] = [];
  for (const s of eligible) {
    const from = s.seatedAt.getTime() - INVOICE_BEFORE_MINUTES * minute;
    const to = s.leftAt.getTime() + INVOICE_AFTER_MINUTES * minute;
    const mid = (s.seatedAt.getTime() + s.leftAt.getTime()) / 2;
    let best: InvoiceLike | null = null;
    let bestGap = Infinity;
    for (const inv of invoices) {
      if (used.has(inv.id)) continue;
      const times = inv.at.map((d) => d.getTime()).filter((t) => t >= from && t <= to);
      if (!times.length) continue;
      const gap = Math.min(...times.map((t) => Math.abs(t - mid)));
      if (gap < bestGap) {
        best = inv;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      matched.push(s);
    } else pending.push(s);
  }
  return pending.filter((s) => {
    const length = s.leftAt.getTime() - s.seatedAt.getTime();
    return !matched.some((m) => {
      const overlap = Math.min(s.leftAt.getTime(), m.leftAt.getTime()) - Math.max(s.seatedAt.getTime(), m.seatedAt.getTime());
      return overlap >= length / 2;
    });
  });
}

const hhmm = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/** نبض دوري: ينبّه المالك عن كل جلسة طاولة انتهت بلا فاتورة مطابقة. */
export async function checkTablesWithoutInvoice(branch: BranchRow): Promise<number> {
  const db = getDb();
  const now = Date.now();
  const since = new Date(now - 20 * 3600_000);
  const sessions = await db
    .select()
    .from(controlTableSessions)
    .where(and(eq(controlTableSessions.branchId, branch.id), gte(controlTableSessions.seatedAt, since), isNotNull(controlTableSessions.leftAt)))
    .orderBy(asc(controlTableSessions.seatedAt));
  if (!sessions.length) return 0;
  const orders = await db
    .select({ id: foodicsOrders.id, reference: foodicsOrders.reference, openedAt: foodicsOrders.openedAt, closedAt: foodicsOrders.closedAt })
    .from(foodicsOrders)
    .where(
      and(
        eq(foodicsOrders.branchId, branch.id),
        // العميل قد يجلس وطلبه مسجَّل «سفري»: المحلي والسفري معاً، لا التوصيل
        inArray(foodicsOrders.channel, ["dine_in", "takeaway", "drive_thru"]),
        ne(foodicsOrders.state, "void"),
        gte(foodicsOrders.openedAt, new Date(since.getTime() - 3600_000)),
      ),
    );
  // لا فواتير إطلاقاً في الفترة = مزامنة فوديكس متوقفة لا مخالفة: لا نُنبّه
  if (!orders.length) return 0;
  const invoices: InvoiceLike[] = orders.map((o) => ({ id: o.id, reference: o.reference, at: [o.openedAt, o.closedAt].filter((d): d is Date => Boolean(d)) }));
  const list: SessionLike[] = sessions.map((s) => ({ id: s.id, tableLabel: s.tableLabel, seatedAt: s.seatedAt, leftAt: s.leftAt!, maxPeople: s.maxPeople }));
  const settled = now - SETTLE_MINUTES * 60_000;
  const tz = safeTimeZone(branch.timezone);
  let created = 0;
  for (const s of unmatchedSessions(list, invoices)) {
    // يُنبَّه عن الجلسات الحديثة فقط (آخر 3 ساعات) حتى لا تتدفّق تنبيهات عن يوم مضى
    if (s.leftAt.getTime() > settled || s.leftAt.getTime() < now - 3 * 3600_000) continue;
    const minutes = Math.round((s.leftAt.getTime() - s.seatedAt.getTime()) / 60_000);
    const res = await createAlert({
      branchId: branch.id,
      alertType: "table_no_invoice",
      occurredAt: s.seatedAt,
      location: `طاولة ${s.tableLabel}`,
      confidence: "medium",
      details: `جلس عملاء على طاولة ${s.tableLabel} من ${hhmm(s.seatedAt, tz)} إلى ${hhmm(s.leftAt, tz)} (${minutes} دقيقة${s.maxPeople ? `، حتى ${s.maxPeople} أشخاص` : ""}) ولم توجد في فوديكس فاتورة محلية أو سفري تقابل الجلسة (من ${INVOICE_BEFORE_MINUTES} دقيقة قبل الجلوس إلى ${INVOICE_AFTER_MINUTES} بعد المغادرة).`,
      source: "auto",
      sourceRef: `table-noinv:${s.id}`,
      customerText: true,
    }).catch((error) => {
      console.error("[leakage] تنبيه طاولة بلا فاتورة:", error);
      return null;
    });
    if (res && !("duplicate" in res && res.duplicate)) created++;
  }
  return created;
}

/* ══ 2) فروقات الجرد ═════════════════════════════════════════════ */

/** فروقات كل جرد في الفترة، مع استهلاك الصنف منذ جرده السابق وتقدير المبيعات غير المفوترة. */
export async function varianceReport(branch: BranchRow, from: string, to: string) {
  const db = getDb();
  const lookback = new Date(new Date(`${from}T12:00:00Z`).getTime() - 62 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ m: inventoryMovements, name: inventoryItems.name, code: inventoryItems.code, unit: inventoryItems.unit, itemCost: inventoryItems.unitCost })
    .from(inventoryMovements)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryMovements.itemId))
    .where(and(eq(inventoryMovements.branchId, branch.id), gte(inventoryMovements.businessDate, lookback), lte(inventoryMovements.businessDate, to)))
    .orderBy(asc(inventoryMovements.businessDate), asc(inventoryMovements.id));

  const byItem = new Map<number, typeof rows>();
  for (const r of rows) byItem.set(r.m.itemId, [...(byItem.get(r.m.itemId) ?? []), r]);

  const lines = [];
  for (const list of byItem.values()) {
    let previousCount: string | null = null;
    for (const r of list) {
      if (r.m.movementType !== "count") continue;
      const since = previousCount;
      previousCount = r.m.businessDate;
      if (r.m.businessDate < from) continue;
      const between = list.filter((x) => x.m.movementType === "out" && x.m.businessDate <= r.m.businessDate && (since === null || x.m.businessDate > since));
      const consumption = round3(between.filter((x) => x.m.reason === "consumption").reduce((s, x) => s + x.m.quantity, 0));
      const waste = round3(between.filter((x) => x.m.reason === "waste").reduce((s, x) => s + x.m.quantity, 0));
      const unitCost = r.itemCost || r.m.unitCost;
      lines.push({
        date: r.m.businessDate,
        itemName: r.name,
        itemCode: r.code,
        unit: r.unit,
        counted: r.m.quantity,
        book: round3(r.m.quantity - r.m.variance),
        variance: r.m.variance,
        value: round2(r.m.variance * unitCost),
        previousCount: since,
        consumption,
        waste,
        /** نسبة النقص من استهلاك الصنف منذ جرده السابق */
        percentOfConsumption: consumption > 0 && r.m.variance < 0 ? round2((Math.abs(r.m.variance) / consumption) * 100) : null,
        /** أول جرد للصنف: فرقه رصيد افتتاحي لا نقص */
        opening: since === null,
      });
    }
  }
  lines.sort((a, b) => b.date.localeCompare(a.date) || a.value - b.value);

  // نسبة تكلفة الطعام الفعلية: تكلفة استهلاك الوصفات ÷ المبيعات في الفترة نفسها
  const consumptionCost = round2(
    rows.filter((r) => r.m.movementType === "out" && r.m.reason === "consumption" && r.m.businessDate >= from).reduce((s, r) => s + (Number(r.m.totalCost) || 0), 0),
  );
  const salesRows = await db
    .select({ total: cashierClosings.totalSales })
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branch.id), gte(cashierClosings.businessDate, from), lte(cashierClosings.businessDate, to)));
  const sales = round2(salesRows.reduce((s, r) => s + (Number(r.total) || 0), 0));
  const foodCostRatio = sales > 0 && consumptionCost > 0 ? consumptionCost / sales : null;

  const real = lines.filter((l) => !l.opening);
  const shortageValue = round2(real.filter((l) => l.variance < 0).reduce((s, l) => s + Math.abs(l.value), 0));
  const surplusValue = round2(real.filter((l) => l.variance > 0).reduce((s, l) => s + l.value, 0));
  return {
    from,
    to,
    branchName: branch.name,
    today: businessDateNow(branch.timezone),
    lines,
    totals: {
      counts: lines.length,
      openingCounts: lines.length - real.length,
      shortageItems: real.filter((l) => l.variance < 0).length,
      shortageValue,
      surplusValue,
      sales,
      consumptionCost,
      foodCostPercent: foodCostRatio === null ? null : round2(foodCostRatio * 100),
      /** حدّ أعلى تقريبي: لو كان كل النقص وجبات بيعت بلا فاتورة */
      estimatedUninvoicedSales: foodCostRatio ? round2(shortageValue / foodCostRatio) : null,
    },
  };
}
