/**
 * تقرير تغيّر أسعار الشراء (يومي / أسبوعي / شهري) مع مقارنة فترتين.
 *
 * المصدر: مستندات الشراء المستلمة من فوديكس بتاريخ فاتورة المورد.
 *   • مقارنة الفترتين: متوسط سعر الوحدة لكل صنف في الفترة الحالية مقابل الفترة
 *     السابقة (وإن لم يُشترَ فيها فآخر سعر شراء قبل الفترة).
 *   • كل تغيّر سعر: كل فاتورة اختلف فيها سعر الصنف عن آخر شراء له قبلها، مع
 *     المورد ومندوبه، والمشتري (من أدخل الشراء في فوديكس)، والمستلِم (من أكّد
 *     الاستلام في «سِجل»).
 *   • التغيّر الأكبر من الحد (10٪ افتراضياً) يُعلَّم، ويُرسل به تنبيه للمالك
 *     عند دخول الفاتورة.
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { employees, foodicsStockDocs } from "../db/schema.js";
import { createAlert, type BranchRow } from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone } from "./time.js";

export type PricePeriod = "day" | "week" | "month";
export const PRICE_ALERT_PERCENT = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const addDays = (iso: string, days: number) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** الفترة الحالية والسابقة لها: يوم ↔ اليوم السابق، 7 أيام ↔ 7 قبلها، شهر ↔ الشهر السابق. */
export function pricePeriods(period: PricePeriod, anchor: string) {
  if (period === "day") return { cur: { from: anchor, to: anchor }, prev: { from: addDays(anchor, -1), to: addDays(anchor, -1) } };
  if (period === "week") return { cur: { from: addDays(anchor, -6), to: anchor }, prev: { from: addDays(anchor, -13), to: addDays(anchor, -7) } };
  const [y, m] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    cur: { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) },
    prev: { from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) },
  };
}

interface Line {
  name: string;
  sku: string;
  unit: string;
  ordered: number;
  received: number;
  cost: number;
}

interface Purchase {
  key: string;
  name: string;
  sku: string;
  unit: string;
  date: string;
  enteredDate: string;
  cost: number;
  quantity: number;
  docId: number;
  reference: string;
  invoiceNumber: string;
  supplier: string;
  rep: string;
  buyer: string;
  receiver: string;
}

/** كل سطور الشراء المستلمة للفرع حتى تاريخ معيّن، مرتبة بتاريخ الفاتورة. */
async function loadPurchases(branchId: number, from: string, to: string): Promise<Purchase[]> {
  const db = getDb();
  const docDate = sql<string>`coalesce(${foodicsStockDocs.invoiceDate}, ${foodicsStockDocs.businessDate})`;
  const docs = await db
    .select()
    .from(foodicsStockDocs)
    .where(and(eq(foodicsStockDocs.branchId, branchId), eq(foodicsStockDocs.kind, "purchase"), eq(foodicsStockDocs.state, "received"), gte(docDate, from), lte(docDate, to)))
    .orderBy(docDate, foodicsStockDocs.id);
  const ids = [...new Set(docs.map((d) => d.confirmedByEmployeeId).filter((x): x is number => Boolean(x)))];
  const names = new Map<number, string>();
  if (ids.length) {
    const rows = await db.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, ids));
    for (const r of rows) names.set(r.id, r.name);
  }
  const out: Purchase[] = [];
  for (const d of docs) {
    // المستندات المحفوظة قبل فصل الحقول: «المورد — أدخله فلان»
    const [partySupplier, partyBuyer] = d.party.split(" — أدخله ");
    const date = d.invoiceDate ?? d.businessDate;
    if (!date) continue;
    for (const l of JSON.parse(d.itemsJson || "[]") as Line[]) {
      const quantity = l.received || l.ordered;
      if (!(l.cost > 0) || !(quantity > 0)) continue;
      out.push({
        key: l.sku || l.name,
        name: l.name,
        sku: l.sku,
        unit: l.unit,
        date,
        enteredDate: d.businessDate ?? date,
        cost: l.cost,
        quantity,
        docId: d.id,
        reference: d.reference,
        invoiceNumber: d.invoiceNumber,
        supplier: d.supplierName || partySupplier || "",
        rep: [d.supplierRep, d.supplierPhone].filter(Boolean).join(" · "),
        buyer: d.enteredBy || partyBuyer || "",
        receiver: d.confirmedByEmployeeId ? names.get(d.confirmedByEmployeeId) ?? "" : "",
      });
    }
  }
  return out;
}

export interface PriceEvent {
  date: string;
  enteredDate: string;
  name: string;
  sku: string;
  unit: string;
  previousCost: number;
  previousDate: string;
  previousSupplier: string;
  cost: number;
  percent: number;
  quantity: number;
  /** أثر التغيّر على هذه الفاتورة بالريال (موجب = دفعنا أكثر) */
  impact: number;
  flagged: boolean;
  docId: number;
  reference: string;
  invoiceNumber: string;
  supplier: string;
  rep: string;
  buyer: string;
  receiver: string;
}

/** كل مرة اختلف فيها سعر الصنف عن آخر شراء له في فاتورة سابقة. */
function priceEvents(purchases: Purchase[], threshold: number): PriceEvent[] {
  const last = new Map<string, Purchase>();
  const events: PriceEvent[] = [];
  for (const p of purchases) {
    const before = last.get(p.key);
    if (before && before.docId !== p.docId) {
      const percent = round2(((p.cost - before.cost) / before.cost) * 100);
      if (Math.abs(percent) >= 0.5) {
        events.push({
          date: p.date,
          enteredDate: p.enteredDate,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          previousCost: before.cost,
          previousDate: before.date,
          previousSupplier: before.supplier,
          cost: p.cost,
          percent,
          quantity: round3(p.quantity),
          impact: round2((p.cost - before.cost) * p.quantity),
          flagged: Math.abs(percent) > threshold,
          docId: p.docId,
          reference: p.reference,
          invoiceNumber: p.invoiceNumber,
          supplier: p.supplier,
          rep: p.rep,
          buyer: p.buyer,
          receiver: p.receiver,
        });
      }
    }
    last.set(p.key, p);
  }
  return events;
}

export async function priceReport(branch: BranchRow, period: PricePeriod, anchor: string, threshold = PRICE_ALERT_PERCENT) {
  const { cur, prev } = pricePeriods(period, anchor);
  // نرجع 180 يوماً قبل الفترة السابقة لإيجاد «آخر سعر» للأصناف قليلة الشراء
  const purchases = await loadPurchases(branch.id, addDays(prev.from, -180), cur.to);
  const events = priceEvents(purchases, threshold).filter((e) => e.date >= cur.from && e.date <= cur.to);

  const groups = new Map<string, Purchase[]>();
  for (const p of purchases) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
  const avg = (list: Purchase[]) => {
    const quantity = list.reduce((s, p) => s + p.quantity, 0);
    const value = list.reduce((s, p) => s + p.quantity * p.cost, 0);
    return { quantity: round3(quantity), value: round2(value), price: quantity ? round2(value / quantity) : 0 };
  };
  const items = [];
  for (const list of groups.values()) {
    const inCur = list.filter((p) => p.date >= cur.from && p.date <= cur.to);
    if (!inCur.length) continue;
    const inPrev = list.filter((p) => p.date >= prev.from && p.date <= prev.to);
    const older = list.filter((p) => p.date < cur.from);
    const lastBefore = older[older.length - 1];
    const now = avg(inCur);
    const before = inPrev.length ? avg(inPrev).price : lastBefore?.cost ?? 0;
    const percent = before ? round2(((now.price - before) / before) * 100) : null;
    const head = inCur[inCur.length - 1];
    items.push({
      name: head.name,
      sku: head.sku,
      unit: head.unit,
      currentPrice: now.price,
      currentQuantity: now.quantity,
      currentValue: now.value,
      purchases: inCur.length,
      previousPrice: before || null,
      /** period = متوسط الفترة السابقة، last = آخر شراء قبل الفترة، none = أول شراء */
      basis: inPrev.length ? "period" : lastBefore ? "last" : "none",
      previousDate: inPrev.length ? null : lastBefore?.date ?? null,
      percent,
      impact: before ? round2((now.price - before) * now.quantity) : 0,
      flagged: percent !== null && Math.abs(percent) > threshold,
      suppliers: [...new Set(inCur.map((p) => p.supplier).filter(Boolean))].join("، "),
    });
  }
  items.sort((a, b) => Math.abs(b.percent ?? 0) - Math.abs(a.percent ?? 0) || a.name.localeCompare(b.name, "ar"));
  events.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.date.localeCompare(a.date) || Math.abs(b.percent) - Math.abs(a.percent));
  const compared = items.filter((i) => i.percent !== null);
  return {
    period,
    cur,
    prev,
    threshold,
    branchName: branch.name,
    items,
    events,
    totals: {
      items: items.length,
      up: compared.filter((i) => (i.percent ?? 0) >= 0.5).length,
      down: compared.filter((i) => (i.percent ?? 0) <= -0.5).length,
      flagged: items.filter((i) => i.flagged).length,
      flaggedEvents: events.filter((e) => e.flagged).length,
      currentValue: round2(items.reduce((s, i) => s + i.currentValue, 0)),
      impact: round2(items.reduce((s, i) => s + i.impact, 0)),
    },
  };
}

const fmt = (n: number) => n.toFixed(2);

/**
 * تنبيه المالك عند دخول فاتورة غيّرت سعر صنف بأكثر من الحد عن آخر شراء له.
 * يُفحص ما أُدخل في فوديكس اليوم وأمس فقط (فلا تُرسل تنبيهات عن فواتير قديمة)،
 * و`sourceRef` يمنع تكرار التنبيه لنفس الفاتورة والصنف والسعر.
 */
export async function alertPriceChanges(branch: BranchRow, threshold = PRICE_ALERT_PERCENT): Promise<number> {
  const today = isoDateInZone(new Date(), safeTimeZone(branch.timezone));
  const purchases = await loadPurchases(branch.id, addDays(today, -200), today);
  const fresh = priceEvents(purchases, threshold).filter((e) => e.flagged && e.enteredDate >= addDays(today, -1));
  let created = 0;
  for (const e of fresh) {
    const up = e.percent > 0;
    const details = [
      `${up ? "ارتفع" : "انخفض"} سعر «${e.name}» ${fmt(Math.abs(e.percent))}٪: من ${fmt(e.previousCost)} إلى ${fmt(e.cost)} ريال/${e.unit || "وحدة"}`,
      `(السعر السابق بتاريخ ${e.previousDate}${e.previousSupplier && e.previousSupplier !== e.supplier ? ` من ${e.previousSupplier}` : ""}).`,
      `الكمية ${e.quantity} — أثره على الفاتورة ${fmt(Math.abs(e.impact))} ريال ${up ? "زيادة" : "توفيراً"}.`,
      `المورد: ${e.supplier || "—"}. المندوب: ${e.rep || "غير مسجّل في فوديكس"}.`,
      `المشتري (أدخل الشراء في فوديكس): ${e.buyer || "—"}. المستلِم: ${e.receiver || "لم يؤكَّد الاستلام بعد"}.`,
      `${e.reference}${e.invoiceNumber ? ` — فاتورة رقم ${e.invoiceNumber}` : ""} بتاريخ ${e.date}.`,
    ].join(" ");
    const res = await createAlert({
      branchId: branch.id,
      alertType: "price_change",
      occurredAt: new Date(),
      location: "المشتريات",
      confidence: "high",
      details,
      source: "auto",
      // النص أسماء أصناف وموردين لا رصد كاميرا: لا يُطبَّق عليه فحص الأماكن الخاصة
      customerText: true,
      sourceRef: `price:${e.docId}:${(e.sku || e.name).slice(0, 60)}:${e.cost}`,
    }).catch((error) => {
      console.error("[inventory] تنبيه تغيّر السعر:", error);
      return null;
    });
    if (res && !("duplicate" in res && res.duplicate)) created++;
  }
  return created;
}
