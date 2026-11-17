/**
 * تقفيل اليوم من فوديكس — يحلّ محلّ «تقفيل الكاشير» اليدوي و«النقدية والإقفال».
 *
 * الدورة:
 *   1. كل مزامنة لفوديكس (كل 10 دقائق) تبني/تحدّث تقفيل اليوم الجاري
 *      وأمس لكل فرع مربوط: المبيعات وطرق الدفع والشبكات وتطبيقات التوصيل
 *      والخصومات والمرتجعات وعدد الفواتير — كلها من فوديكس، بلا إدخال يدوي.
 *      الحالة `pending` = بانتظار تأكيد الكاشير للنقد المعدود.
 *   2. الكاشير يفتح التطبيق فيجد «أكّد تقفيل اليوم»: يرى أرقام فوديكس
 *      والنقد المتوقّع، ويكتب النقد المعدود في الدرج ومصاريف الدرج فقط،
 *      فيُحسب فرق الصندوق فوراً (الحالة `submitted`).
 *   3. الساعة 4 فجراً بتوقيت الفرع: يوم لم يؤكّده الكاشير يُقفل آلياً بأرقام
 *      فوديكس (الحالة `auto_closed` = «معلّق — لم يؤكّد الكاشير النقد») ويُرسل
 *      تنبيه لمدير الفرع، ويبقى ظاهراً للكاشير حتى يؤكّده. اليوم التالي يُفتح
 *      تلقائياً.
 *   4. المدير يراجع في «المالية ← تقفيل اليوم» (مراجَع / معترض عليه).
 *
 * عجز أو زيادة فوق الحد المسموح ينشئ تنبيهاً للمالك.
 */

import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  branches,
  cashierClosingLines,
  cashierClosings,
  employees,
  foodicsOrders,
  surveillanceSettings,
} from "../db/schema.js";
import { foodicsCredentials, foodicsDaySales } from "./foodics.js";
import { createAlert, dayRange, type BranchRow } from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone, wallPartsInZone } from "./time.js";
import { financeStartDate } from "./financeStart.js";

/** ساعة إقفال اليوم بتوقيت الفرع: ما قبلها يُحسب من اليوم السابق. */
export const DAY_CLOSE_HOUR = 4;

export type DayCloseStatus = "pending" | "auto_closed" | "submitted" | "reviewed" | "disputed";

export const STATUS_LABELS: Record<string, string> = {
  pending: "بانتظار تأكيد الكاشير",
  auto_closed: "معلّق — لم يؤكّد الكاشير",
  submitted: "أكّده الكاشير",
  reviewed: "مراجَع",
  disputed: "معترض عليه",
};

/** الحالات التي ما زالت تنتظر تأكيد الكاشير للنقد. */
export const OPEN_STATUSES = ["pending", "auto_closed"];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** تاريخ يوم العمل الجاري: قبل الساعة 4 فجراً يُعدّ من اليوم السابق. */
export function businessDateNow(timeZone: string, now = new Date()): string {
  const tz = safeTimeZone(timeZone);
  const hour = wallPartsInZone(now, tz).hour;
  return isoDateInZone(hour < DAY_CLOSE_HOUR ? new Date(now.getTime() - 86_400_000) : now, tz);
}

/** هل مضت ساعة الإقفال (4 فجراً) على يوم العمل `date`؟ */
export function dayIsOver(date: string, timeZone: string, now = new Date()): boolean {
  return businessDateNow(timeZone, now) > date;
}

/** النقد المسترجع من الفواتير المرتجعة (يخرج من الدرج). */
async function cashRefunds(branchId: number, date: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ total: foodicsOrders.total, paymentsJson: foodicsOrders.paymentsJson })
    .from(foodicsOrders)
    .where(and(eq(foodicsOrders.branchId, branchId), eq(foodicsOrders.businessDate, date), eq(foodicsOrders.state, "returned")));
  let sum = 0;
  for (const r of rows) {
    const pays = JSON.parse(r.paymentsJson || "[]") as Array<{ kind: string; amount: number }>;
    // فوديكس يسجّل دفعة المرتجع بالسالب (‎-39‎)؛ المبلغ الخارج من الدرج هو قيمتها المطلقة
    sum += pays.length ? pays.filter((p) => p.kind === "cash").reduce((s, p) => s + Math.abs(Number(p.amount || 0)), 0) : 0;
  }
  return round2(sum);
}

/** الكاشير الأكثر فواتير في اليوم (من ربط اسمه في فوديكس)، وإلا مدير الفرع. */
async function responsibleEmployee(branch: BranchRow, date: string): Promise<number | null> {
  const db = getDb();
  const [top] = await db
    .select({ id: foodicsOrders.cashierEmployeeId, n: sql<number>`count(*)::int` })
    .from(foodicsOrders)
    .where(and(eq(foodicsOrders.branchId, branch.id), eq(foodicsOrders.businessDate, date), sql`${foodicsOrders.cashierEmployeeId} is not null`))
    .groupBy(foodicsOrders.cashierEmployeeId)
    .orderBy(sql`2 desc`)
    .limit(1);
  if (top?.id) return top.id;
  if (branch.managerEmployeeId) return branch.managerEmployeeId;
  const [anyone] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.branchId, branch.id))
    .limit(1);
  return anyone?.id ?? null;
}

/** عهدة البداية: آخر عهدة مسجّلة للفرع (تبقى ثابتة غالباً). */
async function lastFloat(branchId: number, before: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ f: cashierClosings.openingFloat })
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branchId), sql`${cashierClosings.businessDate} < ${before}`))
    .orderBy(desc(cashierClosings.businessDate))
    .limit(1);
  return Number(row?.f ?? 0);
}

async function closingOf(branchId: number, date: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branchId), eq(cashierClosings.businessDate, date), eq(cashierClosings.shift, "full")))
    .orderBy(cashierClosings.id)
    .limit(1);
  return row ?? null;
}

async function expenseTotal(closingId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ s: sql<number>`coalesce(sum(${cashierClosingLines.amount}), 0)` })
    .from(cashierClosingLines)
    .where(and(eq(cashierClosingLines.closingId, closingId), eq(cashierClosingLines.category, "expense")));
  return round2(Number(row?.s ?? 0));
}

/**
 * يبني أو يحدّث تقفيل يوم من فوديكس. لا يمسّ النقد المعدود ولا مصاريف الدرج
 * ولا تقفيلاً مراجَعاً. يعيد null إن لم توجد فواتير لذلك اليوم.
 */
export async function upsertDayClose(branch: BranchRow, date: string) {
  const db = getDb();
  const start = await financeStartDate(branch.id);
  if (start && date < start) return null;
  const sales = await foodicsDaySales(branch.id, date);
  const existing = await closingOf(branch.id, date);
  if (!sales.orders && !existing) return null;
  if (existing?.status === "reviewed") return existing;

  const refundsCash = await cashRefunds(branch.id, date);
  const card = round2(sales.card);
  const figures = {
    totalSales: sales.total,
    cashSales: sales.cash,
    cardSales: round2(card + sales.foodicsPay),
    foodicsSales: sales.foodicsPay,
    deliverySales: sales.deliveryApps,
    otherSales: sales.other,
    transferSales: 0,
    discounts: sales.discounts,
    refunds: sales.refunds,
    invoiceCount: sales.invoices,
  };

  let closing;
  if (existing) {
    const expenses = await expenseTotal(existing.id);
    const expectedCash = round2(existing.openingFloat + figures.cashSales - expenses - refundsCash);
    const confirmed = !OPEN_STATUSES.includes(existing.status);
    [closing] = await db
      .update(cashierClosings)
      .set({
        ...figures,
        expenses,
        expectedCash,
        difference: confirmed ? round2(existing.countedCash - expectedCash) : 0,
        updatedAt: new Date(),
      })
      .where(eq(cashierClosings.id, existing.id))
      .returning();
  } else {
    const employeeId = await responsibleEmployee(branch, date);
    if (!employeeId) return null;
    const openingFloat = await lastFloat(branch.id, date);
    // قيد التفرّد (فرع، موظف، تاريخ، وردية): إن وُجد تقفيل قديم لنفس الموظف يُعاد استخدامه
    const [clash] = await db
      .select({ id: cashierClosings.id })
      .from(cashierClosings)
      .where(and(eq(cashierClosings.branchId, branch.id), eq(cashierClosings.employeeId, employeeId), eq(cashierClosings.businessDate, date), eq(cashierClosings.shift, "full")));
    if (clash) return clash;
    [closing] = await db
      .insert(cashierClosings)
      .values({
        branchId: branch.id,
        employeeId,
        businessDate: date,
        shift: "full",
        openingFloat,
        ...figures,
        expenses: 0,
        countedCash: 0,
        expectedCash: round2(openingFloat + figures.cashSales - refundsCash),
        difference: 0,
        // يبدأ «بانتظار التأكيد» دائماً؛ نبض الإقفال يحوّله لمعلّق بعد 4 فجراً ويبلّغ المدير
        status: "pending",
        notes: "",
      })
      .returning();
  }
  if (!closing) return null;

  // بنود الشبكات وتطبيقات التوصيل من فوديكس (تُستبدل كل مرة؛ أسطر المصاريف تبقى)
  await db
    .delete(cashierClosingLines)
    .where(and(eq(cashierClosingLines.closingId, closing.id), inArray(cashierClosingLines.category, ["network", "delivery_app"])));
  const lines = sales.methods
    .filter((m) => (m.kind === "card" || m.kind === "foodics" || m.kind === "delivery_app") && m.amount !== 0)
    .map((m, i) => ({
      closingId: closing.id,
      category: m.kind === "delivery_app" ? "delivery_app" : "network",
      label: m.name,
      amount: m.amount,
      reference: "فوديكس",
      sortOrder: i,
    }));
  if (lines.length) await db.insert(cashierClosingLines).values(lines);
  return closing;
}

/**
 * عهدة الصندوق النقدية: مبلغ ثابت يبقى داخل الدرج كل يوم (فكة).
 * تُطبَّق على كل تقفيلات الفرع من التاريخ المحدد فما بعد (عدا المراجَعة)،
 * ويُعاد حساب النقد المتوقّع والفرق. الأيام الجديدة ترث آخر عهدة تلقائياً.
 */
export async function setOpeningFloat(branchId: number, from: string, amount: number) {
  const db = getDb();
  const value = round2(amount);
  const rows = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branchId), gte(cashierClosings.businessDate, from), ne(cashierClosings.status, "reviewed")));
  for (const row of rows) {
    const refundsCash = await cashRefunds(branchId, row.businessDate);
    const expectedCash = round2(value + row.cashSales - row.expenses - refundsCash);
    const confirmed = !OPEN_STATUSES.includes(row.status);
    await db
      .update(cashierClosings)
      .set({
        openingFloat: value,
        expectedCash,
        difference: confirmed ? round2(row.countedCash - expectedCash) : 0,
        updatedAt: new Date(),
      })
      .where(eq(cashierClosings.id, row.id));
  }
  return { updated: rows.length, amount: value };
}

/** العهدة الحالية للفرع = عهدة آخر تقفيل. */
export async function currentFloat(branchId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ f: cashierClosings.openingFloat })
    .from(cashierClosings)
    .where(eq(cashierClosings.branchId, branchId))
    .orderBy(desc(cashierClosings.businessDate))
    .limit(1);
  return Number(row?.f ?? 0);
}

/** تأكيد الكاشير: النقد المعدود ومصاريف الدرج وملاحظة. */
export async function confirmDayClose(input: {
  closingId: number;
  employeeId: number;
  branchId: number | null;
  canReview: boolean;
  countedCash: number;
  openingFloat?: number | null;
  expenses: Array<{ label: string; amount: number }>;
  notes: string;
}) {
  const db = getDb();
  const [closing] = await db.select().from(cashierClosings).where(eq(cashierClosings.id, input.closingId));
  if (!closing) return { error: "التقفيل غير موجود", status: 404 };
  if (!input.canReview && closing.branchId !== input.branchId) return { error: "هذا التقفيل لفرع آخر", status: 403 };
  if (closing.status === "reviewed") return { error: "تمّت مراجعة هذا اليوم. راجع مدير الفرع لأي تعديل.", status: 409 };
  if (!input.canReview && !OPEN_STATUSES.includes(closing.status)) {
    return { error: "أُكّد هذا التقفيل مسبقاً. راجع مدير الفرع لأي تعديل.", status: 409 };
  }
  const [branch] = await db.select().from(branches).where(eq(branches.id, closing.branchId));

  await db.delete(cashierClosingLines).where(and(eq(cashierClosingLines.closingId, closing.id), eq(cashierClosingLines.category, "expense")));
  const expenseLines = input.expenses
    .filter((e) => e.label && e.amount > 0)
    .slice(0, 30)
    .map((e, i) => ({ closingId: closing.id, category: "expense", label: e.label, amount: round2(e.amount), reference: "", sortOrder: 100 + i }));
  if (expenseLines.length) await db.insert(cashierClosingLines).values(expenseLines);
  const expenses = round2(expenseLines.reduce((s, e) => s + e.amount, 0));

  const openingFloat =
    input.canReview && input.openingFloat !== null && input.openingFloat !== undefined ? round2(input.openingFloat) : closing.openingFloat;
  const refundsCash = await cashRefunds(closing.branchId, closing.businessDate);
  const expectedCash = round2(openingFloat + closing.cashSales - expenses - refundsCash);
  const difference = round2(input.countedCash - expectedCash);

  // الموظف المؤكِّد يصبح صاحب التقفيل (إن لم يتعارض مع تقفيل آخر له في نفس اليوم)
  let employeeId = closing.employeeId;
  if (!input.canReview && input.employeeId !== closing.employeeId) {
    const [clash] = await db
      .select({ id: cashierClosings.id })
      .from(cashierClosings)
      .where(and(eq(cashierClosings.branchId, closing.branchId), eq(cashierClosings.employeeId, input.employeeId), eq(cashierClosings.businessDate, closing.businessDate), eq(cashierClosings.shift, closing.shift)));
    if (!clash) employeeId = input.employeeId;
  }

  const [saved] = await db
    .update(cashierClosings)
    .set({
      employeeId,
      openingFloat,
      expenses,
      countedCash: round2(input.countedCash),
      expectedCash,
      difference,
      notes: input.notes,
      status: input.canReview && !OPEN_STATUSES.includes(closing.status) ? closing.status : "submitted",
      updatedAt: new Date(),
    })
    .where(eq(cashierClosings.id, closing.id))
    .returning();

  // عجز أو زيادة فوق الحد المسموح → تنبيه للمالك
  if (branch) {
    const [settings] = await db.select().from(surveillanceSettings).where(eq(surveillanceSettings.branchId, branch.id));
    const tolerance = Number(settings?.salesGapTolerance ?? 5);
    if (Math.abs(difference) > tolerance) {
      await createAlert({
        branchId: branch.id,
        alertType: "cash_difference",
        occurredAt: new Date(),
        location: "الكاشير",
        employeeIds: [employeeId],
        confidence: "high",
        details: `تقفيل يوم ${closing.businessDate}: النقد المعدود ${round2(input.countedCash)} مقابل المتوقّع ${expectedCash} — ${difference < 0 ? "عجز" : "زيادة"} ${Math.abs(difference)} ريال (الحد المسموح ${tolerance}).`,
        source: "auto",
        sourceRef: `cash-diff:${closing.id}:${round2(input.countedCash)}:${expenses}`,
      }).catch((error) => console.error("[dayclose] تنبيه فرق الصندوق:", error));
    }
  }
  return { closing: saved };
}

/**
 * نبض تقفيل اليوم (يُستدعى بعد كل مزامنة لفوديكس):
 *  - يحدّث تقفيل اليوم الجاري وأمس من فوديكس.
 *  - بعد 4 فجراً: يوم أمس غير المؤكَّد → `auto_closed` + تنبيه لمدير الفرع.
 */
export async function runDayCloseTick() {
  if (!(await foodicsCredentials())) return { branches: 0, autoClosed: 0 };
  const db = getDb();
  const linked = await db
    .select({ branch: branches })
    .from(surveillanceSettings)
    .innerJoin(branches, eq(branches.id, surveillanceSettings.branchId))
    .where(ne(surveillanceSettings.foodicsBranchId, ""));
  let autoClosed = 0;
  for (const { branch } of linked) {
    try {
      const today = businessDateNow(branch.timezone);
      const yesterday = isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000), "UTC");
      await upsertDayClose(branch, yesterday);
      await upsertDayClose(branch, today);
      autoClosed += await autoCloseOverdue(branch);
    } catch (error) {
      console.error(`[dayclose] فرع ${branch.id}:`, (error as Error).message);
    }
  }
  return { branches: linked.length, autoClosed };
}

/** يقفل آلياً كل يوم انتهى (بعد 4 فجراً) ولم يؤكّده الكاشير، ويبلّغ مدير الفرع. */
async function autoCloseOverdue(branch: BranchRow): Promise<number> {
  const db = getDb();
  const today = businessDateNow(branch.timezone);
  const overdue = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branch.id), eq(cashierClosings.status, "pending"), sql`${cashierClosings.businessDate} < ${today}`));
  const yesterday = isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000), "UTC");
  for (const c of overdue) {
    await db.update(cashierClosings).set({ status: "auto_closed", updatedAt: new Date() }).where(eq(cashierClosings.id, c.id));
    // التنبيه ليوم أمس فقط — الأيام الأقدم (بعد إعادة بناء مثلاً) تُعلَّق بصمت حتى لا تُغرق المدير
    if (c.businessDate < yesterday) continue;
    await createAlert({
      branchId: branch.id,
      alertType: "cashier_not_closed",
      occurredAt: dayRange(c.businessDate, branch.timezone).end,
      location: "الكاشير",
      employeeIds: [c.employeeId],
      confidence: "high",
      details: `لم يؤكّد الكاشير تقفيل يوم ${c.businessDate} حتى الساعة ${DAY_CLOSE_HOUR} فجراً. أُقفل اليوم آلياً بأرقام فوديكس (مبيعات ${c.totalSales}، نقد ${c.cashSales})، وبقي عدّ النقد معلّقاً حتى يؤكّده الكاشير.`,
      source: "auto",
      sourceRef: `not-closed:${branch.id}:${c.businessDate}`,
    }).catch((error) => console.error("[dayclose] تنبيه عدم التقفيل:", error));
  }
  return overdue.length;
}

/** يعيد بناء تقفيلات كل الأيام التي فيها فواتير فوديكس بين تاريخين (بعد التصفية مثلاً). */
export async function rebuildDayCloses(branch: BranchRow, from: string, to: string, budgetMs = 20_000) {
  const db = getDb();
  const started = Date.now();
  const dates = await db
    .selectDistinct({ d: sql<string>`${foodicsOrders.businessDate}::text` })
    .from(foodicsOrders)
    .where(and(eq(foodicsOrders.branchId, branch.id), gte(foodicsOrders.businessDate, from), lte(foodicsOrders.businessDate, to)))
    .orderBy(sql`1`);
  let done = 0;
  let last: string | null = null;
  for (const { d } of dates) {
    if (Date.now() - started > budgetMs) break;
    await upsertDayClose(branch, d);
    done++;
    last = d;
  }
  return { days: dates.length, done, last, complete: done === dates.length };
}
