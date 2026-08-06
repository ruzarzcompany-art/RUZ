/**
 * النقدية والخزينة: السجل الموحّد للمصاريف والمشتريات النقدية، المتبقي
 * النقدي في الدرج، الرصيد النقدي الشهري، تسوية الشبكات وتطبيقات التوصيل،
 * وإقفال الشهر والترحيل.
 *
 * مبدأ الإضافة: لا يُعدَّل أي جدول قائم ولا أي صف محفوظ. المصاريف تُقرأ من
 * جدولها الواحد (cash_expenses) والمبيعات النقدية من التقفيلات كما هي، ثم
 * يُحسب المتبقي والصافي **وقت العرض** — فلا مبلغ مخزَّن مرتين ولا خصم مزدوج.
 */

import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  cashExpenses,
  cashNotifications,
  cashierClosingLines,
  cashierClosings,
  employees,
  monthlyCashClosings,
  providerSettlementPayments,
  providerSettlements,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  PERMISSIONS,
  accessRulesByEmployee,
  buildAccessProfile,
  hasAnyPermission,
  hasModuleDelete,
  hasModuleLevel,
  requireAnyPermission,
  requireModuleDelete,
  requireModuleLevel,
  requirePermission,
} from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import {
  asDateOnly,
  asEnum,
  asId,
  asNumber,
  asString,
  round2,
} from "../validate.js";
import {
  EXPENSE_KINDS,
  MAX_AMOUNT,
  MONTH_DECISIONS,
  MONTH_STATUS_LABELS,
  PROVIDER_TYPES,
  aggregateMonthlySales,
  commissionRateOf,
  decisionOutcome,
  invoiceTotal,
  isValidPeriod,
  monthBounds,
  monthKeyOf,
  monthlyNet,
  monthlySettlementFigures,
  nextMonth,
  normalizeRate,
  parseMonthKey,
  paymentsTotal,
  previousMonth,
  remainingCash,
  settlementFigures,
  unsettledSales,
  type MonthDecision,
  type ProviderType,
} from "../finance.js";
import { monthLockFor, monthLockMessage } from "../monthLock.js";
import {
  DEFAULT_DELIVERY_APPS,
  DEFAULT_NETWORK_LINES,
} from "./cashier.js";

export const financeRouter = Router();

const SHIFTS = ["morning", "evening", "full"] as const;
const SETTLEMENT_FILTER_STATUSES = ["pending", "confirmed"] as const;

/* ── مساعدات مشتركة ─────────────────────────────────────────────── */

/** المنطقة الزمنية للفرع — تاريخ العمل يُحسب بها لا بتوقيت الجهاز. */
async function branchTimezone(branchId: number | null): Promise<string> {
  if (branchId === null) return "Asia/Riyadh";
  const db = getDb();
  const [row] = await db
    .select({ timezone: branches.timezone })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  return safeTimeZone(row?.timezone ?? "Asia/Riyadh");
}

/**
 * الفرع الذي يعمل عليه الطلب: من الطلب لمن يقرأ كل الفروع، ومن ملف الموظف
 * لغيره. من لا فرع له ولا يقرأ الكل يُرفض طلبه برسالة واضحة.
 */
async function resolveBranchId(
  req: AuthedRequest,
  requested: unknown,
): Promise<number | null> {
  const actor = req.employee!;
  const wide = await hasAnyPermission(req, [
    PERMISSIONS.cashierReadAll,
    PERMISSIONS.reportsView,
    PERMISSIONS.branchesRead,
  ]);
  const asked = asId(requested);
  if (wide && asked !== null) return asked;
  return actor.branchId ?? null;
}

/** مجموع حقل مالي في مجموعة صفوف — التجميع في الذاكرة لصغر المدى. */
function sumBy<T>(rows: T[], pick: (row: T) => number | null): number {
  return round2(rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0));
}

/** فودكس تُرصد في عمود مستقل في التقفيلة لا كبند، فتُسمّى هنا مرة واحدة. */
const FOODICS_LABEL = "شبكة فودكس (Foodics)";

/**
 * أسطر المصروف المكتوبة داخل صفحة تقفيل الكاشير.
 *
 * بعد نقل المصاريف إلى صفحة التقفيل صار هذا هو مصدرها الأول، ويبقى جدول
 * `cash_expenses` مصدراً ثانياً لما سُجّل قبل النقل فقط — فلا تضيع فاتورة
 * قديمة ولا تُخصم فاتورة مرتين، لأن المصدرين لا يشتركان في صفٍّ واحد.
 */
async function closingExpenseLines(
  branchId: number,
  from: string,
  to: string,
): Promise<
  Array<{ businessDate: string; shift: string; label: string; amount: number }>
> {
  const db = getDb();
  const rows = await db
    .select({
      businessDate: cashierClosings.businessDate,
      shift: cashierClosings.shift,
      label: cashierClosingLines.label,
      amount: cashierClosingLines.amount,
    })
    .from(cashierClosingLines)
    .innerJoin(
      cashierClosings,
      eq(cashierClosingLines.closingId, cashierClosings.id),
    )
    .where(
      and(
        eq(cashierClosings.branchId, branchId),
        eq(cashierClosingLines.category, "expense"),
        gte(cashierClosings.businessDate, from),
        lte(cashierClosings.businessDate, to),
      ),
    );

  return rows.map((row) => ({
    businessDate: row.businessDate,
    shift: row.shift,
    label: row.label,
    amount: Number(row.amount) || 0,
  }));
}

/**
 * مبيعات كل جهة **مجمّعة على الشهر كله** من بنود التقفيلات اليومية.
 *
 * التسوية شهرية لا يومية: التحويلات لا تصل يوماً بيوم، فتتجمّع المبالغ طوال
 * الشهر ثم تُسوّى الجهة مرة واحدة على المجمَّع عند وصول الحوالة إلى البنك —
 * وبهذا يصير مقام النسبة مبيعات الشهر كاملة فتخرج النسبة صحيحة.
 *
 * والشبكات مفصولة عن تطبيقات التوصيل: كل نوع يُستدعى وحده بتجميعه الخاص.
 */
async function monthlyProviderSales(
  branchId: number,
  from: string,
  to: string,
  providerType: ProviderType,
): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      label: cashierClosingLines.label,
      amount: cashierClosingLines.amount,
    })
    .from(cashierClosingLines)
    .innerJoin(
      cashierClosings,
      eq(cashierClosingLines.closingId, cashierClosings.id),
    )
    .where(
      and(
        eq(cashierClosings.branchId, branchId),
        eq(cashierClosingLines.category, providerType),
        gte(cashierClosings.businessDate, from),
        lte(cashierClosings.businessDate, to),
      ),
    );

  const buckets = new Map<string, Array<{ amount: number }>>();
  for (const row of rows) {
    const label = (row.label ?? "").trim();
    if (!label) continue;
    const list = buckets.get(label) ?? [];
    list.push({ amount: Number(row.amount) || 0 });
    buckets.set(label, list);
  }

  if (providerType === "network") {
    const foodicsRows = await db
      .select({ foodicsSales: cashierClosings.foodicsSales })
      .from(cashierClosings)
      .where(
        and(
          eq(cashierClosings.branchId, branchId),
          gte(cashierClosings.businessDate, from),
          lte(cashierClosings.businessDate, to),
        ),
      );
    const foodicsTotal = sumBy(foodicsRows, (row) => row.foodicsSales);
    if (foodicsTotal !== 0) buckets.set(FOODICS_LABEL, [{ amount: foodicsTotal }]);
  }

  const totals = new Map<string, number>();
  for (const [label, list] of buckets) totals.set(label, aggregateMonthlySales(list));
  return totals;
}

/* ══ مساعدات التسوية الشهرية: الدفعات والمرحّل والمتوقع والفعلي ══════ */

/** دفعات تسوية واحدة مرتّبة بتاريخها. */
async function settlementPaymentRows(settlementId: number) {
  const db = getDb();
  return db
    .select()
    .from(providerSettlementPayments)
    .where(eq(providerSettlementPayments.settlementId, settlementId))
    .orderBy(
      asc(providerSettlementPayments.paymentDate),
      asc(providerSettlementPayments.id),
    );
}

/** مجموع وعدد الدفعات لكل تسوية في استعلام واحد. */
async function paymentsBySettlement(
  ids: number[],
): Promise<Map<number, { total: number; count: number }>> {
  const map = new Map<number, { total: number; count: number }>();
  if (ids.length === 0) return map;
  const db = getDb();
  const rows = await db
    .select({
      settlementId: providerSettlementPayments.settlementId,
      amount: providerSettlementPayments.amount,
    })
    .from(providerSettlementPayments)
    .where(inArray(providerSettlementPayments.settlementId, ids));
  for (const row of rows) {
    const before = map.get(row.settlementId) ?? { total: 0, count: 0 };
    map.set(row.settlementId, {
      total: round2(before.total + (Number(row.amount) || 0)),
      count: before.count + 1,
    });
  }
  return map;
}

/**
 * المخصوم الفعلي المخزَّن إن كان المحاسب قد أدخله فعلاً، وإلا `null`.
 *
 * التمييز ضروري للتوافق: الصفوف القديمة لا تحمل مخصوماً فعلياً ولا مرحّلاً،
 * فتُعاد إلى السلوك القديم حرفياً (العمولة = المستحق − المستلم، والمرحّل صفر)
 * ولا يتغيّر رقم واحد فيها.
 */
function storedActualDeducted(
  row: { actualDeducted?: number | null; carriedOutAmount?: number | null } | null,
): number | null {
  if (!row) return null;
  const actual = Number(row.actualDeducted) || 0;
  const carried = Number(row.carriedOutAmount) || 0;
  if (actual > 0 || carried > 0) return round2(actual);
  return null;
}

/** ما لم يُحوَّل في شهرٍ ما، لكل جهة: أساس الترحيل إلى الشهر الذي يليه. */
async function carriedOutByProvider(
  branchId: number,
  providerType: ProviderType,
  year: number,
  month: number,
): Promise<Map<string, number>> {
  const db = getDb();
  const { from, to } = monthBounds(year, month);
  const rows = await db
    .select({
      providerName: providerSettlements.providerName,
      carriedOutAmount: providerSettlements.carriedOutAmount,
    })
    .from(providerSettlements)
    .where(
      and(
        eq(providerSettlements.branchId, branchId),
        eq(providerSettlements.providerType, providerType),
        gte(providerSettlements.periodFrom, from),
        lte(providerSettlements.periodTo, to),
      ),
    )
    .orderBy(desc(providerSettlements.id));

  const map = new Map<string, number>();
  for (const row of rows) {
    const amount = round2(Number(row.carriedOutAmount) || 0);
    if (amount <= 0) continue;
    map.set(row.providerName, round2((map.get(row.providerName) ?? 0) + amount));
  }
  return map;
}

/** صفّ جهة واحدة في الشاشة الشهرية بعد حساب كل أرقامها. */
interface MonthlyProviderRow {
  providerName: string;
  providerType: ProviderType;
  monthlySales: number;
  carriedInAmount: number;
  carriedFromMonth: string;
  settlementBase: number;
  contractRate: number;
  expectedAmount: number;
  actualDeducted: number;
  varianceAmount: number;
  carriedOutAmount: number;
  carriedToMonth: string;
  receivedAmount: number;
  paymentsCount: number;
  paymentsTotal: number;
  commissionAmount: number;
  commissionRate: number;
  vatRate: number;
  vatAmount: number;
  vatIncluded: boolean;
  settledSales: number;
  unsettledSales: number;
  settlementId: number | null;
  status: string;
  reference: string;
  notes: string;
  confirmedByName: string;
  confirmedAt: Date | null;
}

/**
 * صفوف الشهر لنوع واحد (الشبكات وحدها أو التطبيقات وحدها) بكامل أرقامها.
 *
 * مصدرٌ واحد للحقيقة تستخدمه الشاشة والتقرير والترحيل جميعاً، فلا يختلف رقم
 * بين موضع وموضع. والمبيعات تُجمَّع في الخادم من التقفيلات اليومية، والمرحّل
 * الداخل من الشهر السابق، والمستلم من مجموع الدفعات — لا شيء منها من المتصفح.
 */
async function monthlyProviderRows(
  branchId: number,
  providerType: ProviderType,
  year: number,
  month: number,
): Promise<{
  from: string;
  to: string;
  monthKey: string;
  rows: MonthlyProviderRow[];
}> {
  const db = getDb();
  const { from, to } = monthBounds(year, month);
  const monthKey = monthKeyOf(year, month);
  const sales = await monthlyProviderSales(branchId, from, to, providerType);

  const settlementRows = await db
    .select()
    .from(providerSettlements)
    .where(
      and(
        eq(providerSettlements.branchId, branchId),
        eq(providerSettlements.providerType, providerType),
        gte(providerSettlements.periodFrom, from),
        lte(providerSettlements.periodTo, to),
      ),
    )
    .orderBy(desc(providerSettlements.id));

  const previous = previousMonth(year, month);
  const carryIn = await carriedOutByProvider(
    branchId,
    providerType,
    previous.year,
    previous.month,
  );
  const payments = await paymentsBySettlement(settlementRows.map((row) => row.id));

  const names = new Set<string>([
    ...sales.keys(),
    ...settlementRows.map((row) => row.providerName),
    ...carryIn.keys(),
  ]);

  const rows: MonthlyProviderRow[] = [...names].map((providerName) => {
    const monthlySales = round2(sales.get(providerName) ?? 0);
    const own = settlementRows.filter((row) => row.providerName === providerName);
    const current = own[0] ?? null;
    const confirmed = current?.status === "confirmed";
    const stat = current
      ? (payments.get(current.id) ?? { total: 0, count: 0 })
      : { total: 0, count: 0 };

    // المرحّل المُثبَّت له أولوية على المعاينة: ما رُحّل رسمياً لا يُعاد حسابه
    const carriedFromMonth = current?.carriedFromMonth ?? "";
    const carriedInAmount = carriedFromMonth
      ? round2(Number(current?.carriedInAmount) || 0)
      : round2(carryIn.get(providerName) ?? 0);

    // المستلم = مجموع الدفعات إن وُجدت، وإلا الرقم المحفوظ (توافقاً مع القديم)
    const receivedAmount =
      stat.count > 0 ? stat.total : round2(Number(current?.receivedAmount) || 0);

    const figures = monthlySettlementFigures({
      monthlySales,
      carriedInAmount,
      receivedAmount,
      // بلا تسوية مسجّلة: لا خصم ولا مطالبة — كل الأساس ينتظر التحويل
      actualDeducted: current ? storedActualDeducted(current) : 0,
      contractRate: current ? Number(current.contractRate) || 0 : 0,
      vatRate: current ? Number(current.vatRate) || 0 : 0,
      vatIncluded: current ? current.vatIncluded !== false : true,
    });

    return {
      providerName,
      providerType,
      monthlySales,
      carriedInAmount,
      carriedFromMonth,
      settlementBase: figures.settlementBase,
      contractRate: figures.contractRate,
      expectedAmount: figures.expectedAmount,
      actualDeducted: current ? figures.actualDeducted : 0,
      varianceAmount: current ? figures.varianceAmount : 0,
      carriedOutAmount: figures.carriedOutAmount,
      carriedToMonth: current?.carriedToMonth ?? "",
      receivedAmount,
      paymentsCount: stat.count,
      paymentsTotal: stat.total,
      commissionAmount: confirmed ? figures.commissionAmount : 0,
      commissionRate: confirmed ? figures.commissionRate : 0,
      vatRate: figures.vatRate,
      vatAmount: confirmed ? figures.vatAmount : 0,
      vatIncluded: figures.vatIncluded,
      settledSales: sumBy(own, (row) => row.salesAmount),
      unsettledSales: unsettledSales(
        monthlySales,
        sumBy(own, (row) => row.salesAmount),
      ),
      settlementId: current?.id ?? null,
      status: current?.status ?? "open",
      reference: current?.reference ?? "",
      notes: current?.notes ?? "",
      confirmedByName: current?.confirmedByName ?? "",
      confirmedAt: current?.confirmedAt ?? null,
    };
  });

  rows.sort((a, b) => b.settlementBase - a.settlementBase);
  return { from, to, monthKey, rows };
}

/** مجاميع قسم واحد: الأساس والمتوقع والفعلي والفرق والمرحّل. */
function providerTotals(rows: MonthlyProviderRow[]) {
  const confirmedRows = rows.filter((row) => row.status === "confirmed");
  const confirmedBase = sumBy(confirmedRows, (row) => row.settlementBase);
  const confirmedCommission = sumBy(confirmedRows, (row) => row.commissionAmount);
  return {
    providers: rows.length,
    monthlySales: sumBy(rows, (row) => row.monthlySales),
    carriedInAmount: sumBy(rows, (row) => row.carriedInAmount),
    settlementBase: sumBy(rows, (row) => row.settlementBase),
    contractRate: commissionRateOf(
      sumBy(rows, (row) => row.expectedAmount),
      sumBy(rows, (row) => row.settlementBase),
    ),
    expectedAmount: sumBy(rows, (row) => row.expectedAmount),
    actualDeducted: sumBy(rows, (row) => row.actualDeducted),
    varianceAmount: sumBy(rows, (row) => row.varianceAmount),
    receivedAmount: sumBy(rows, (row) => row.receivedAmount),
    carriedOutAmount: sumBy(rows, (row) => row.carriedOutAmount),
    commissionAmount: confirmedCommission,
    /** النسبة على المجمَّع المؤكَّد: العمولة ÷ الأساس المستحق × 100 */
    commissionRate: commissionRateOf(confirmedCommission, confirmedBase),
    vatAmount: sumBy(confirmedRows, (row) => row.vatAmount),
    paymentsCount: rows.reduce((total, row) => total + row.paymentsCount, 0),
    open: rows.filter((row) => row.status === "open").length,
    pending: rows.filter((row) => row.status === "pending").length,
    confirmed: confirmedRows.length,
    carryingProviders: rows.filter((row) => row.carriedOutAmount > 0).length,
  };
}

/** اسم النوع كما يُعرض في التقرير. */
const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  network: "الشبكات",
  delivery_app: "تطبيقات التوصيل",
};

/**
 * يعيد حساب أرقام تسوية محفوظة بعد أي تغيير في دفعاتها أو حقولها.
 *
 * الحساب في الخادم دائماً: المستلم = مجموع الدفعات، والمتوقع من نسبة العقد،
 * والفرق = الفعلي − المتوقع، والمرحّل = الأساس − المحوّل − الفعلي. فلا يكتب
 * المتصفح رقماً محسوباً ولا يختلف صفٌّ عن معادلته.
 */
async function recomputeSettlement(settlementId: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(providerSettlements)
    .where(eq(providerSettlements.id, settlementId))
    .limit(1);
  if (!row) return null;

  const payments = await settlementPaymentRows(settlementId);
  const receivedAmount =
    payments.length > 0
      ? paymentsTotal(payments)
      : round2(Number(row.receivedAmount) || 0);

  const figures = monthlySettlementFigures({
    monthlySales: round2(Number(row.salesAmount) || 0),
    carriedInAmount: round2(Number(row.carriedInAmount) || 0),
    receivedAmount,
    actualDeducted: storedActualDeducted(row),
    contractRate: Number(row.contractRate) || 0,
    vatRate: Number(row.vatRate) || 0,
    vatIncluded: row.vatIncluded !== false,
  });

  const [updated] = await db
    .update(providerSettlements)
    .set({
      receivedAmount: figures.receivedAmount,
      commissionAmount: figures.commissionAmount,
      commissionRate: figures.commissionRate,
      vatAmount: figures.vatAmount,
      commissionBeforeVat: figures.commissionBeforeVat,
      expectedAmount: figures.expectedAmount,
      actualDeducted: figures.actualDeducted,
      varianceAmount: figures.varianceAmount,
      carriedOutAmount: figures.carriedOutAmount,
      updatedAt: new Date(),
    })
    .where(eq(providerSettlements.id, settlementId))
    .returning();

  return { before: row, settlement: updated, figures, payments };
}

/** يتحقّق أن مبلغاً مُدخلاً ضمن الحدود المعقولة. */
function moneyOrError(value: unknown, allowZero = true): number | string {
  const num = asNumber(value);
  if (num === null) return allowZero ? 0 : "المبلغ مطلوب";
  if (num < 0) return "لا تُقبل مبالغ سالبة";
  if (num > MAX_AMOUNT) return "المبلغ المُدخل كبير بشكل غير منطقي";
  return round2(num);
}

/** يمنع أي كتابة داخل شهر مقفل ويشرح السبب. */
async function blockedByMonthLock(
  branchId: number | null,
  isoDate: string | null,
  res: Response,
): Promise<boolean> {
  const lock = await monthLockFor(branchId, isoDate);
  if (!lock) return false;
  res.status(409).json({ ok: false, error: monthLockMessage(lock) });
  return true;
}

/**
 * قفل الشهر يمنع الكتابة على شهرٍ أُقفل، غير أنّ تسوية الشهر تبقى داخل
 * فترتها (نهاية الشهر + المهلة) مفتوحةً لدفعاتها المتأخّرة كي تُسجَّل على
 * شهرها الصحيح لا على الشهر التالي. فما دام اليوم داخل الفترة يُستثنى عمل
 * التسوية وحده، وبعد انقضائها يعود قفل الشهر كما كان بلا استثناء.
 */
async function blockedBySettlementLock(
  branchId: number | null,
  periodFrom: string | null,
  periodTo: string | null,
  res: Response,
): Promise<boolean> {
  const lock = await monthLockFor(branchId, periodFrom);
  if (!lock) return false;
  if (periodTo) {
    const timezone = await branchTimezone(branchId);
    const today = isoDateInZone(new Date(), timezone);
    if (today <= settlementWindowEnd(periodTo)) return false;
  }
  res.status(409).json({ ok: false, error: monthLockMessage(lock) });
  return true;
}

/* ══ أولاً: السجل الموحّد للمصاريف والمشتريات النقدية ═══════════════ */

/**
 * قائمة الفواتير مع مرشّحات المدة والفرع والوردية والنوع.
 * من لا يقرأ كل الفروع يُقصر عرضه على فرعه تلقائياً.
 */
financeRouter.get(
  "/finance/expenses",
  requireAuth,
  requirePermission(PERMISSIONS.cashExpensesRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const branchId = await resolveBranchId(req, req.query.branchId);

    const month = parseMonthKey(req.query.month);
    const bounds = month ? monthBounds(month.year, month.month) : null;
    const from = asDateOnly(req.query.from) ?? bounds?.from ?? null;
    const to = asDateOnly(req.query.to) ?? bounds?.to ?? null;
    const shift = asEnum(req.query.shift, SHIFTS);
    const kind = asEnum(req.query.kind, EXPENSE_KINDS);

    const conditions = [
      branchId === null ? undefined : eq(cashExpenses.branchId, branchId),
      from === null ? undefined : gte(cashExpenses.businessDate, from),
      to === null ? undefined : lte(cashExpenses.businessDate, to),
      shift === null ? undefined : eq(cashExpenses.shift, shift),
      kind === null ? undefined : eq(cashExpenses.kind, kind),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        expense: cashExpenses,
        branchName: branches.name,
        createdByName: employees.fullName,
      })
      .from(cashExpenses)
      .leftJoin(branches, eq(cashExpenses.branchId, branches.id))
      .leftJoin(employees, eq(cashExpenses.createdByEmployeeId, employees.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(cashExpenses.businessDate), desc(cashExpenses.id))
      .limit(1000);

    const expenses = rows.map((row) => ({
      ...row.expense,
      branchName: row.branchName,
      createdByName: row.createdByName,
    }));

    res.json({
      ok: true,
      expenses,
      summary: {
        count: expenses.length,
        amount: sumBy(expenses, (item) => item.amount),
        expenses: sumBy(
          expenses.filter((item) => item.kind === "expense"),
          (item) => item.amount,
        ),
        purchases: sumBy(
          expenses.filter((item) => item.kind === "purchase"),
          (item) => item.amount,
        ),
      },
      filters: { branchId, from, to, shift, kind },
    });
  },
);

/**
 * تسجيل فاتورة نقدية واحدة.
 *
 * الفاتورة تُسجَّل **مرة واحدة**: رقم الفاتورة فريد داخل الفرع، ومحاولة
 * إعادة تسجيله تُرفض برسالة تذكر تاريخ التسجيل الأول — فلا يُخصم المبلغ
 * مرتين لا في تقفيلة اليوم ولا في التقرير الشهري.
 */
financeRouter.post(
  "/finance/expenses",
  requireAuth,
  requirePermission(PERMISSIONS.cashExpensesWrite),
  requireModuleLevel("cash_expenses", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const branchId = await resolveBranchId(req, body.branchId);
    if (branchId === null) {
      res.status(400).json({
        ok: false,
        error: "لا يوجد فرع مرتبط بالحساب. راجع الموارد البشرية.",
      });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const today = isoDateInZone(new Date(), timezone);
    const businessDate = asDateOnly(body.businessDate) ?? today;

    if (businessDate > today) {
      res
        .status(400)
        .json({ ok: false, error: "لا يمكن تسجيل مصروف بتاريخ لم يأتِ بعد" });
      return;
    }

    if (await blockedByMonthLock(branchId, businessDate, res)) return;

    const description = asString(body.description, 200);
    if (!description) {
      res.status(400).json({
        ok: false,
        error: "البيان مطلوب (غاز، دجاج، لبن ...)",
      });
      return;
    }

    const invoiceNumber = asString(body.invoiceNumber, 80) ?? "";
    const kind = asEnum(body.kind, EXPENSE_KINDS) ?? "expense";
    const shift = asEnum(body.shift, SHIFTS) ?? "full";

    const quantityRaw = asNumber(body.quantity);
    const quantity =
      quantityRaw === null || quantityRaw <= 0 ? 1 : round2(quantityRaw);

    const unitPrice = moneyOrError(body.unitPrice);
    if (typeof unitPrice === "string") {
      res.status(400).json({ ok: false, error: unitPrice });
      return;
    }
    const explicitAmount = moneyOrError(body.amount);
    if (typeof explicitAmount === "string") {
      res.status(400).json({ ok: false, error: explicitAmount });
      return;
    }

    const amount = invoiceTotal({ quantity, unitPrice, amount: explicitAmount });
    if (amount <= 0) {
      res.status(400).json({
        ok: false,
        error: "أدخل سعر الوحدة أو المبلغ الإجمالي — المبلغ صفر لا يُسجَّل",
      });
      return;
    }

    if (invoiceNumber) {
      const [duplicate] = await db
        .select({
          id: cashExpenses.id,
          businessDate: cashExpenses.businessDate,
          amount: cashExpenses.amount,
        })
        .from(cashExpenses)
        .where(
          and(
            eq(cashExpenses.branchId, branchId),
            eq(cashExpenses.invoiceNumber, invoiceNumber),
          ),
        )
        .limit(1);

      if (duplicate) {
        res.status(409).json({
          ok: false,
          error:
            "الفاتورة رقم " +
            invoiceNumber +
            " مسجّلة مسبقاً بتاريخ " +
            duplicate.businessDate +
            " بمبلغ " +
            String(duplicate.amount) +
            " — تُسجَّل مرة واحدة وتُخصم مرة واحدة.",
          existingId: duplicate.id,
        });
        return;
      }
    }

    const [saved] = await db
      .insert(cashExpenses)
      .values({
        branchId,
        businessDate,
        shift,
        kind,
        description,
        invoiceNumber,
        quantity,
        unitPrice,
        amount,
        supplier: asString(body.supplier, 160) ?? "",
        notes: asString(body.notes, 500) ?? "",
        createdByEmployeeId: actor.id,
      })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "cash.expense.create",
      entityType: "cash_expenses",
      entityId: saved?.id ?? null,
      after: saved,
      reason: description,
      ipAddress: clientIp(req),
    });

    res
      .status(201)
      .json({ ok: true, expense: saved, message: "تم تسجيل الفاتورة في السجل" });
  },
);

/** تعديل فاتورة مسجّلة (الدرجة الثالثة) — ممنوع داخل شهر مقفل. */
financeRouter.patch(
  "/finance/expenses/:id",
  requireAuth,
  requirePermission(PERMISSIONS.cashExpensesWrite),
  requireModuleLevel("cash_expenses", 3),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الفاتورة غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(cashExpenses)
      .where(eq(cashExpenses.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الفاتورة غير موجودة" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const businessDate = asDateOnly(body.businessDate) ?? before.businessDate;

    // الشهر القديم والشهر الجديد كلاهما يجب أن يكون مفتوحاً
    if (await blockedByMonthLock(before.branchId, before.businessDate, res)) return;
    if (await blockedByMonthLock(before.branchId, businessDate, res)) return;

    const description = asString(body.description, 200) ?? before.description;
    const invoiceNumber =
      body.invoiceNumber === undefined
        ? before.invoiceNumber
        : (asString(body.invoiceNumber, 80) ?? "");

    if (invoiceNumber && invoiceNumber !== before.invoiceNumber) {
      const [duplicate] = await db
        .select({ id: cashExpenses.id, businessDate: cashExpenses.businessDate })
        .from(cashExpenses)
        .where(
          and(
            eq(cashExpenses.branchId, before.branchId),
            eq(cashExpenses.invoiceNumber, invoiceNumber),
            ne(cashExpenses.id, id),
          ),
        )
        .limit(1);

      if (duplicate) {
        res.status(409).json({
          ok: false,
          error:
            "الفاتورة رقم " +
            invoiceNumber +
            " مسجّلة مسبقاً بتاريخ " +
            duplicate.businessDate,
        });
        return;
      }
    }

    const quantityRaw = asNumber(body.quantity);
    const quantity =
      quantityRaw === null || quantityRaw <= 0 ? before.quantity : round2(quantityRaw);

    const unitPriceRaw = body.unitPrice === undefined ? before.unitPrice : body.unitPrice;
    const unitPrice = moneyOrError(unitPriceRaw);
    if (typeof unitPrice === "string") {
      res.status(400).json({ ok: false, error: unitPrice });
      return;
    }

    const amountRaw = body.amount === undefined ? before.amount : body.amount;
    const explicitAmount = moneyOrError(amountRaw);
    if (typeof explicitAmount === "string") {
      res.status(400).json({ ok: false, error: explicitAmount });
      return;
    }

    const amount = invoiceTotal({ quantity, unitPrice, amount: explicitAmount });
    if (amount <= 0) {
      res
        .status(400)
        .json({ ok: false, error: "المبلغ الإجمالي يجب أن يكون أكبر من صفر" });
      return;
    }

    const [updated] = await db
      .update(cashExpenses)
      .set({
        businessDate,
        shift: asEnum(body.shift, SHIFTS) ?? before.shift,
        kind: asEnum(body.kind, EXPENSE_KINDS) ?? before.kind,
        description,
        invoiceNumber,
        quantity,
        unitPrice,
        amount,
        supplier: asString(body.supplier, 160) ?? before.supplier,
        notes: asString(body.notes, 500) ?? before.notes,
        updatedAt: new Date(),
      })
      .where(eq(cashExpenses.id, id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "cash.expense.update",
      entityType: "cash_expenses",
      entityId: id,
      before,
      after: updated,
      reason: asString(body.reason, 300) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, expense: updated, message: "تم تعديل الفاتورة" });
  },
);

/** حذف فاتورة — خانة الحذف المستقلة، وممنوع داخل شهر مقفل. */
financeRouter.delete(
  "/finance/expenses/:id",
  requireAuth,
  requirePermission(PERMISSIONS.cashExpensesWrite),
  requireModuleDelete("cash_expenses"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الفاتورة غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(cashExpenses)
      .where(eq(cashExpenses.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الفاتورة غير موجودة" });
      return;
    }

    if (await blockedByMonthLock(before.branchId, before.businessDate, res)) return;

    await db.delete(cashExpenses).where(eq(cashExpenses.id, id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "cash.expense.delete",
      entityType: "cash_expenses",
      entityId: id,
      before,
      reason: asString(req.body?.reason, 300) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف الفاتورة من السجل" });
  },
);

/* ══ ثانياً: المتبقي النقدي في التقفيلة ═════════════════════════════ */

/**
 * المتبقي النقدي الفعلي في درج الكاشير ليوم (ووردية) في فرع:
 * المبيعات النقدية من التقفيلات − مصاريف اليوم/الوردية من السجل الموحّد.
 *
 * لا يُخزَّن هذا الرقم في أي عمود: يُحسب وقت العرض من مصدرين اثنين لا ثالث
 * لهما، فيستحيل أن يُخصم مصروف مرتين مهما تكرّر فتح الشاشة.
 */
financeRouter.get(
  "/finance/cash-position",
  requireAuth,
  requirePermission(PERMISSIONS.cashExpensesRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const branchId = await resolveBranchId(req, req.query.branchId);
    const timezone = await branchTimezone(branchId);
    const businessDate =
      asDateOnly(req.query.date) ?? isoDateInZone(new Date(), timezone);

    const closingRows =
      branchId === null
        ? []
        : await db
            .select({
              id: cashierClosings.id,
              shift: cashierClosings.shift,
              employeeId: cashierClosings.employeeId,
              employeeName: employees.fullName,
              cashSales: cashierClosings.cashSales,
              totalSales: cashierClosings.totalSales,
              countedCash: cashierClosings.countedCash,
              expectedCash: cashierClosings.expectedCash,
              difference: cashierClosings.difference,
              status: cashierClosings.status,
            })
            .from(cashierClosings)
            .leftJoin(employees, eq(cashierClosings.employeeId, employees.id))
            .where(
              and(
                eq(cashierClosings.branchId, branchId),
                eq(cashierClosings.businessDate, businessDate),
              ),
            )
            .orderBy(asc(cashierClosings.shift));

    const expenseRows =
      branchId === null
        ? []
        : await db
            .select()
            .from(cashExpenses)
            .where(
              and(
                eq(cashExpenses.branchId, branchId),
                eq(cashExpenses.businessDate, businessDate),
              ),
            )
            .orderBy(asc(cashExpenses.id));

    // أسطر المصروف المكتوبة في صفحة التقفيل — المصدر الأول بعد النقل
    const lineExpenses =
      branchId === null
        ? []
        : await closingExpenseLines(branchId, businessDate, businessDate);

    const expenseEntries = [
      ...lineExpenses.map((row) => ({
        shift: row.shift,
        description: row.label,
        amount: row.amount,
        source: "closing" as const,
      })),
      ...expenseRows.map((row) => ({
        shift: row.shift,
        description: row.description,
        amount: Number(row.amount) || 0,
        source: "register" as const,
      })),
    ];

    const cashSales = sumBy(closingRows, (row) => row.cashSales);
    const expensesTotal = sumBy(expenseEntries, (row) => row.amount);

    const byShift = SHIFTS.map((shift) => {
      const shiftCash = sumBy(
        closingRows.filter((row) => row.shift === shift),
        (row) => row.cashSales,
      );
      const shiftExpenses = sumBy(
        expenseEntries.filter((row) => row.shift === shift),
        (row) => row.amount,
      );
      return {
        shift,
        cashSales: shiftCash,
        expenses: shiftExpenses,
        remainingCash: remainingCash(shiftCash, shiftExpenses),
      };
    }).filter((row) => row.cashSales !== 0 || row.expenses !== 0);

    const lock = await monthLockFor(branchId, businessDate);

    res.json({
      ok: true,
      branchId,
      businessDate,
      timezone,
      cashSales,
      expensesTotal,
      remainingCash: remainingCash(cashSales, expensesTotal),
      byShift,
      closings: closingRows,
      expenses: expenseEntries,
      locked: lock !== null,
      lockNote: lock === null ? "" : monthLockMessage(lock),
    });
  },
);

/* ══ ثالثاً: الرصيد النقدي الشهري ══════════════════════════════════ */

/**
 * رصيد بداية الشهر = ما رُحّل من الشهر السابق بعد قراره.
 * الشهر السابق بلا قرار (أو بلا صفّ أصلاً) يعني بداية من صفر — وهو حال كل
 * الشهور السابقة لهذه الإضافة، فلا يتغيّر عليها شيء.
 */
async function openingBalanceFor(
  branchId: number,
  year: number,
  month: number,
): Promise<number> {
  const db = getDb();
  const previous = previousMonth(year, month);
  const [row] = await db
    .select({
      status: monthlyCashClosings.status,
      carriedAmount: monthlyCashClosings.carriedAmount,
    })
    .from(monthlyCashClosings)
    .where(
      and(
        eq(monthlyCashClosings.branchId, branchId),
        eq(monthlyCashClosings.periodYear, previous.year),
        eq(monthlyCashClosings.periodMonth, previous.month),
      ),
    )
    .limit(1);

  if (!row || row.status === "pending_approval") return 0;
  return round2(Number(row.carriedAmount) || 0);
}

export interface MonthlySummary {
  branchId: number;
  periodYear: number;
  periodMonth: number;
  monthKey: string;
  from: string;
  to: string;
  openingBalance: number;
  cashSalesTotal: number;
  totalSalesTotal: number;
  expensesTotal: number;
  purchasesTotal: number;
  operatingExpensesTotal: number;
  settlementsReceived: number;
  commissionTotal: number;
  vatTotal: number;
  netAmount: number;
  closingsCount: number;
  expensesCount: number;
  settlementsCount: number;
  days: Array<{
    businessDate: string;
    cashSales: number;
    expenses: number;
    remainingCash: number;
  }>;
}

/**
 * ملخّص شهر كامل لفرع: يُستدعى من شاشة الرصيد الشهري ومن تجهيز الإقفال معاً
 * فلا يختلف رقم الشاشة عن رقم الإشعار.
 */
async function monthlySummaryFor(
  branchId: number,
  year: number,
  month: number,
): Promise<MonthlySummary> {
  const db = getDb();
  const { from, to } = monthBounds(year, month);

  const closingRows = await db
    .select({
      businessDate: cashierClosings.businessDate,
      cashSales: cashierClosings.cashSales,
      totalSales: cashierClosings.totalSales,
    })
    .from(cashierClosings)
    .where(
      and(
        eq(cashierClosings.branchId, branchId),
        gte(cashierClosings.businessDate, from),
        lte(cashierClosings.businessDate, to),
      ),
    );

  // مصاريف الشهر من مصدرين لا ثالث لهما: أسطر التقفيلات، وما بقي من السجل
  // المنفصل القديم. لا صفَّ مشترك بينهما فلا يُخصم مبلغ مرتين.
  const legacyExpenseRows = await db
    .select({
      businessDate: cashExpenses.businessDate,
      kind: cashExpenses.kind,
      amount: cashExpenses.amount,
    })
    .from(cashExpenses)
    .where(
      and(
        eq(cashExpenses.branchId, branchId),
        gte(cashExpenses.businessDate, from),
        lte(cashExpenses.businessDate, to),
      ),
    );

  const lineExpenseRows = (await closingExpenseLines(branchId, from, to)).map(
    (row) => ({
      businessDate: row.businessDate,
      kind: "expense",
      amount: row.amount,
    }),
  );

  const expenseRows = [...lineExpenseRows, ...legacyExpenseRows];

  const settlementRows = await db
    .select({
      receivedAmount: providerSettlements.receivedAmount,
      commissionAmount: providerSettlements.commissionAmount,
      vatAmount: providerSettlements.vatAmount,
    })
    .from(providerSettlements)
    .where(
      and(
        eq(providerSettlements.branchId, branchId),
        eq(providerSettlements.status, "confirmed"),
        gte(providerSettlements.periodFrom, from),
        lte(providerSettlements.periodFrom, to),
      ),
    );

  const openingBalance = await openingBalanceFor(branchId, year, month);
  const cashSalesTotal = sumBy(closingRows, (row) => row.cashSales);
  const expensesTotal = sumBy(expenseRows, (row) => row.amount);

  const dayKeys = [
    ...new Set([
      ...closingRows.map((row) => row.businessDate),
      ...expenseRows.map((row) => row.businessDate),
    ]),
  ].sort();

  const days = dayKeys.map((businessDate) => {
    const dayCash = sumBy(
      closingRows.filter((row) => row.businessDate === businessDate),
      (row) => row.cashSales,
    );
    const dayExpenses = sumBy(
      expenseRows.filter((row) => row.businessDate === businessDate),
      (row) => row.amount,
    );
    return {
      businessDate,
      cashSales: dayCash,
      expenses: dayExpenses,
      remainingCash: remainingCash(dayCash, dayExpenses),
    };
  });

  return {
    branchId,
    periodYear: year,
    periodMonth: month,
    monthKey: monthKeyOf(year, month),
    from,
    to,
    openingBalance,
    cashSalesTotal,
    totalSalesTotal: sumBy(closingRows, (row) => row.totalSales),
    expensesTotal,
    purchasesTotal: sumBy(
      expenseRows.filter((row) => row.kind === "purchase"),
      (row) => row.amount,
    ),
    operatingExpensesTotal: sumBy(
      expenseRows.filter((row) => row.kind !== "purchase"),
      (row) => row.amount,
    ),
    settlementsReceived: sumBy(settlementRows, (row) => row.receivedAmount),
    commissionTotal: sumBy(settlementRows, (row) => row.commissionAmount),
    vatTotal: sumBy(settlementRows, (row) => row.vatAmount),
    netAmount: monthlyNet({ openingBalance, cashSalesTotal, expensesTotal }),
    closingsCount: closingRows.length,
    expensesCount: expenseRows.length,
    settlementsCount: settlementRows.length,
    days,
  };
}

/**
 * الرصيد النقدي الشهري — يُعرض طوال الشهر لا في نهايته فقط، وموضعه صفحة
 * تقفيل الكاشير نفسها أسفل أرقام اليوم.
 *
 * بندٌ **مستقل** في إدارة الصلاحيات (`cash_monthly_balance`): من لا يملكه
 * يُرفض طلبه هنا فلا يصله الرقم أصلاً، ولا يُكتفى بإخفاء القسم في المتصفح.
 */
financeRouter.get(
  "/finance/monthly-balance",
  requireAuth,
  requirePermission(PERMISSIONS.cashMonthlyBalanceView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const branchId = await resolveBranchId(req, req.query.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const today = isoDateInZone(new Date(), timezone);
    const period =
      parseMonthKey(req.query.month) ?? {
        year: Number.parseInt(today.slice(0, 4), 10),
        month: Number.parseInt(today.slice(5, 7), 10),
      };

    if (!isValidPeriod(period.year, period.month)) {
      res.status(400).json({ ok: false, error: "الشهر المطلوب غير صالح" });
      return;
    }

    const summary = await monthlySummaryFor(branchId, period.year, period.month);

    const [closingRow] = await db
      .select()
      .from(monthlyCashClosings)
      .where(
        and(
          eq(monthlyCashClosings.branchId, branchId),
          eq(monthlyCashClosings.periodYear, period.year),
          eq(monthlyCashClosings.periodMonth, period.month),
        ),
      )
      .limit(1);

    res.json({
      ok: true,
      summary,
      monthClosing: closingRow ?? null,
      statusLabel: closingRow
        ? (MONTH_STATUS_LABELS[closingRow.status] ?? closingRow.status)
        : "مفتوح",
      timezone,
      today,
    });
  },
);

/* ══ رابعاً: تسوية الشبكات وتطبيقات التوصيل ═════════════════════════ */

/**
 * مبيعات كل جهة كما رُصدت في التقفيلات خلال مدة، مع ما سُوّي منها فعلاً.
 * تُبنى منها الشاشة فلا يُدخل المحاسب رقم المبيعات يدوياً.
 */
financeRouter.get(
  "/finance/settlements/providers",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const branchId = await resolveBranchId(req, req.query.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const month = parseMonthKey(req.query.month);
    const bounds = month ? monthBounds(month.year, month.month) : null;
    const from = asDateOnly(req.query.from) ?? bounds?.from ?? null;
    const to = asDateOnly(req.query.to) ?? bounds?.to ?? null;

    if (from === null || to === null) {
      res.status(400).json({ ok: false, error: "حدّد مدة التسوية (من — إلى)" });
      return;
    }

    const lineRows = await db
      .select({
        category: cashierClosingLines.category,
        label: cashierClosingLines.label,
        amount: cashierClosingLines.amount,
      })
      .from(cashierClosingLines)
      .innerJoin(
        cashierClosings,
        eq(cashierClosingLines.closingId, cashierClosings.id),
      )
      .where(
        and(
          eq(cashierClosings.branchId, branchId),
          gte(cashierClosings.businessDate, from),
          lte(cashierClosings.businessDate, to),
        ),
      );

    const foodicsRows = await db
      .select({ foodicsSales: cashierClosings.foodicsSales })
      .from(cashierClosings)
      .where(
        and(
          eq(cashierClosings.branchId, branchId),
          gte(cashierClosings.businessDate, from),
          lte(cashierClosings.businessDate, to),
        ),
      );

    const buckets = new Map<string, { providerType: string; providerName: string; salesAmount: number }>();
    const push = (providerType: string, providerName: string, amount: number) => {
      const key = providerType + "::" + providerName;
      const current = buckets.get(key);
      if (current) current.salesAmount = round2(current.salesAmount + amount);
      else buckets.set(key, { providerType, providerName, salesAmount: round2(amount) });
    };

    for (const row of lineRows) {
      const label = (row.label ?? "").trim();
      if (!label) continue;
      push(row.category === "delivery_app" ? "delivery_app" : "network", label, Number(row.amount) || 0);
    }

    const foodicsTotal = sumBy(foodicsRows, (row) => row.foodicsSales);
    if (foodicsTotal !== 0) push("network", "شبكة فودكس (Foodics)", foodicsTotal);

    // ما سُوّي فعلاً من المدة نفسها — كي لا تُسوّى الجهة مرتين
    const settled = await db
      .select({
        providerType: providerSettlements.providerType,
        providerName: providerSettlements.providerName,
        salesAmount: providerSettlements.salesAmount,
        receivedAmount: providerSettlements.receivedAmount,
        status: providerSettlements.status,
      })
      .from(providerSettlements)
      .where(
        and(
          eq(providerSettlements.branchId, branchId),
          gte(providerSettlements.periodFrom, from),
          lte(providerSettlements.periodTo, to),
        ),
      );

    const providers = [...buckets.values()].map((item) => {
      const rows = settled.filter(
        (row) =>
          row.providerType === item.providerType &&
          row.providerName === item.providerName,
      );
      return {
        ...item,
        settledSales: sumBy(rows, (row) => row.salesAmount),
        settledReceived: sumBy(
          rows.filter((row) => row.status === "confirmed"),
          (row) => row.receivedAmount,
        ),
        openSettlements: rows.filter((row) => row.status === "pending").length,
      };
    });

    providers.sort((a, b) => b.salesAmount - a.salesAmount);

    res.json({
      ok: true,
      branchId,
      from,
      to,
      providers,
      defaults: {
        network: DEFAULT_NETWORK_LINES,
        delivery_app: DEFAULT_DELIVERY_APPS,
      },
    });
  },
);

/**
 * التجميع الشهري لجهات نوع واحد: الشبكات وحدها أو تطبيقات التوصيل وحدها.
 *
 * قسمان مستقلان في الشاشة، وكل قسم ينادي هذا المسار بنوعه فيحصل على مبيعات
 * كل جهة مجمّعة على الشهر كله من التقفيلات اليومية، مضافاً إليها المرحّل من
 * الشهر السابق، ومعها نسبة العقد والمتوقع والمخصوم الفعلي والفرق ودفعات
 * التحويل وما سيُرحَّل إلى الشهر الجديد.
 */
financeRouter.get(
  "/finance/settlements/monthly",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsRead),
  async (req: AuthedRequest, res: Response) => {
    const branchId = await resolveBranchId(req, req.query.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const providerType =
      asEnum(req.query.providerType, PROVIDER_TYPES) ?? "network";
    const timezone = await branchTimezone(branchId);
    const today = isoDateInZone(new Date(), timezone);
    const period = parseMonthKey(req.query.month) ?? {
      year: Number.parseInt(today.slice(0, 4), 10),
      month: Number.parseInt(today.slice(5, 7), 10),
    };

    if (!isValidPeriod(period.year, period.month)) {
      res.status(400).json({ ok: false, error: "الشهر المطلوب غير صالح" });
      return;
    }

    const { from, to, monthKey, rows } = await monthlyProviderRows(
      branchId,
      providerType,
      period.year,
      period.month,
    );

    const previous = previousMonth(period.year, period.month);
    const next = nextMonth(period.year, period.month);

    res.json({
      ok: true,
      branchId,
      providerType,
      month: monthKey,
      previousMonth: monthKeyOf(previous.year, previous.month),
      nextMonth: monthKeyOf(next.year, next.month),
      from,
      to,
      providers: rows,
      totals: providerTotals(rows),
      defaults:
        providerType === "network" ? DEFAULT_NETWORK_LINES : DEFAULT_DELIVERY_APPS,
      today,
      /** التسوية النهائية تقع عند آخر يوم في الشهر لا قبله */
      monthEnd: to,
      isMonthEnded: today > to,
    });
  },
);

/**
 * تسجيل أو تعديل تسوية **شهرية** لجهة واحدة — والتسوية النهائية في نهاية الشهر.
 *
 * المبيعات لا تأتي من المتصفح إطلاقاً: الخادم يجمعها من تقفيلات الشهر نفسه،
 * ثم يضيف إليها ما رُحّل من الشهر السابق فيصير «الأساس المستحق». وعليه:
 *   المتوقع خصمه = الأساس × نسبة العقد ÷ 100
 *   الفرق        = المخصوم الفعلي − المتوقع
 *   المرحّل      = الأساس − المحوّل − المخصوم الفعلي (لا يقلّ عن صفر)
 * والمستلم = مجموع دفعات التحويل إن سُجِّلت دفعات، وإلا الرقم المُدخل.
 *
 * وإن لم يُدخل المحاسب مخصوماً فعلياً فالنتيجة مطابقة للسلوك السابق حرفياً:
 * العمولة = المستحق − المستلم، والنسبة = العمولة ÷ المستحق × 100، ولا ترحيل.
 */
financeRouter.post(
  "/finance/settlements/monthly",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleLevel("settlements", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const branchId = await resolveBranchId(req, body.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const providerType = asEnum(body.providerType, PROVIDER_TYPES) ?? "network";
    const providerName = asString(body.providerName, 120);
    if (!providerName) {
      res.status(400).json({ ok: false, error: "اسم الجهة مطلوب" });
      return;
    }

    const period = parseMonthKey(body.month);
    if (!period) {
      res.status(400).json({ ok: false, error: "حدّد الشهر بصيغة YYYY-MM" });
      return;
    }

    const { from, to } = monthBounds(period.year, period.month);
    const monthKey = monthKeyOf(period.year, period.month);
    if (await blockedByMonthLock(branchId, from, res)) return;

    const sales = await monthlyProviderSales(branchId, from, to, providerType);
    const salesAmount = round2(sales.get(providerName) ?? 0);

    const [existing] = await db
      .select()
      .from(providerSettlements)
      .where(
        and(
          eq(providerSettlements.branchId, branchId),
          eq(providerSettlements.providerType, providerType),
          eq(providerSettlements.providerName, providerName),
          eq(providerSettlements.periodFrom, from),
          eq(providerSettlements.periodTo, to),
        ),
      )
      .limit(1);

    if (existing && existing.status === "confirmed") {
      res.status(409).json({
        ok: false,
        error:
          "تسوية " +
          providerName +
          " لشهر " +
          monthKey +
          " مؤكَّدة مسبقاً ولا تُعدَّل — احذفها بصلاحية الحذف إن لزم.",
      });
      return;
    }

    /*
     * فصل «الإضافة» عن «التعديل» فصلاً حقيقياً: إنشاء تسوية شهر لم تُسجَّل بعد
     * يكفيه درجة الإضافة (2)، أما الكتابة فوق تسوية قائمة فهي تعديل لا إضافة،
     * فتُطلب درجة التعديل (3) — ولا يكفي أن يملك الرمز الذرّي وحده.
     */
    if (existing && !(await hasModuleLevel(req, "settlements", 3))) {
      res.status(403).json({
        ok: false,
        error:
          "تسوية " +
          providerName +
          " لشهر " +
          monthKey +
          " مسجَّلة مسبقاً، وتغييرها يحتاج درجة «إضافة / تعديل» في بند تسوية الشبكات.",
      });
      return;
    }

    // المرحّل الداخل: مثبَّتاً إن سُجِّل رسمياً، وإلا معاينةً من غير المحوّل سابقاً
    const previous = previousMonth(period.year, period.month);
    const previousKey = monthKeyOf(previous.year, previous.month);
    const carryIn = await carriedOutByProvider(
      branchId,
      providerType,
      previous.year,
      previous.month,
    );
    const previewCarry = round2(carryIn.get(providerName) ?? 0);
    const carriedInAmount = existing?.carriedFromMonth
      ? round2(Number(existing.carriedInAmount) || 0)
      : previewCarry;
    const carriedFromMonth = existing?.carriedFromMonth
      ? existing.carriedFromMonth
      : previewCarry > 0
        ? previousKey
        : "";

    const baseAmount = round2(salesAmount + carriedInAmount);
    if (baseAmount <= 0) {
      res.status(400).json({
        ok: false,
        error:
          "لا مبيعات مجمّعة ولا مبالغ مرحّلة لـ" +
          providerName +
          " في شهر " +
          monthKey +
          " — التسوية تقع على المجمَّع الشهري من التقفيلات مع المرحّل.",
      });
      return;
    }

    // المستلم من الدفعات إن وُجدت: لا يُكتب رقم مجمّع بيد أحد فوق الدفعات
    const payments = existing ? await settlementPaymentRows(existing.id) : [];
    let received = 0;
    if (payments.length > 0) {
      received = paymentsTotal(payments);
    } else {
      const value = moneyOrError(body.receivedAmount);
      if (typeof value === "string") {
        res.status(400).json({ ok: false, error: value });
        return;
      }
      received = value;
    }

    const contractRate =
      body.contractRate === undefined || body.contractRate === null
        ? existing
          ? Number(existing.contractRate) || 0
          : 0
        : normalizeRate(body.contractRate);

    // المخصوم الفعلي: رقم من كشف الجهة. غيابه يعني الرجوع للسلوك القديم تماماً
    let actualDeducted: number | null = null;
    if (
      body.actualDeducted === undefined ||
      body.actualDeducted === null ||
      body.actualDeducted === ""
    ) {
      actualDeducted = storedActualDeducted(existing ?? null);
    } else {
      const value = moneyOrError(body.actualDeducted);
      if (typeof value === "string") {
        res.status(400).json({ ok: false, error: value });
        return;
      }
      if (value > baseAmount) {
        res.status(400).json({
          ok: false,
          error:
            "المخصوم الفعلي (" +
            String(value) +
            ") أكبر من الأساس المستحق (" +
            String(baseAmount) +
            ") — راجع كشف الجهة.",
        });
        return;
      }
      actualDeducted = value;
    }

    const vatRateRaw = asNumber(body.vatRate);
    const vatRate =
      vatRateRaw === null || vatRateRaw < 0 || vatRateRaw > 100
        ? existing
          ? Number(existing.vatRate) || 0
          : 0
        : vatRateRaw;
    const vatIncluded =
      body.vatIncluded === undefined
        ? existing
          ? existing.vatIncluded !== false
          : true
        : body.vatIncluded !== false;

    // التأكيد إجراء موافقة ببنده المستقل، فلا يكفي «تسجيل تسوية»
    const confirm = body.confirm === true;
    if (confirm && !(await hasModuleLevel(req, "settlements", 4))) {
      res.status(403).json({
        ok: false,
        error:
          "الاعتماد درجة مستقلة: لا تملك «صلاحية إعطاء الموافقات» في بند تسوية الشبكات",
      });
      return;
    }

    const figures = monthlySettlementFigures({
      monthlySales: salesAmount,
      carriedInAmount,
      receivedAmount: received,
      actualDeducted,
      contractRate,
      vatRate,
      vatIncluded,
    });

    const now = new Date();
    const payload = {
      branchId,
      providerType,
      providerName,
      periodFrom: from,
      periodTo: to,
      // مبيعات الشهر وحدها هنا؛ المرحّل عمودٌ مستقل فلا يُحسب مبلغ مرتين
      salesAmount: figures.monthlySales,
      receivedAmount: figures.receivedAmount,
      commissionAmount: figures.commissionAmount,
      commissionRate: figures.commissionRate,
      vatRate: figures.vatRate,
      vatAmount: figures.vatAmount,
      vatIncluded: figures.vatIncluded,
      commissionBeforeVat: figures.commissionBeforeVat,
      contractRate: figures.contractRate,
      expectedAmount: figures.expectedAmount,
      actualDeducted: figures.actualDeducted,
      varianceAmount: figures.varianceAmount,
      carriedInAmount: figures.carriedInAmount,
      carriedOutAmount: figures.carriedOutAmount,
      carriedFromMonth,
      carriedToMonth: existing?.carriedToMonth ?? "",
      status: confirm ? "confirmed" : "pending",
      reference: asString(body.reference, 120) ?? existing?.reference ?? "",
      notes: asString(body.notes, 500) ?? existing?.notes ?? "",
      updatedAt: now,
      confirmedByEmployeeId: confirm ? actor.id : (existing?.confirmedByEmployeeId ?? null),
      confirmedByName: confirm ? (actor.fullName ?? "") : (existing?.confirmedByName ?? ""),
      confirmedAt: confirm ? now : (existing?.confirmedAt ?? null),
    };

    const [saved] = existing
      ? await db
          .update(providerSettlements)
          .set(payload)
          .where(eq(providerSettlements.id, existing.id))
          .returning()
      : await db
          .insert(providerSettlements)
          .values({ ...payload, createdByEmployeeId: actor.id })
          .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: confirm ? "settlement.month.confirm" : "settlement.month.save",
      entityType: "provider_settlements",
      entityId: saved?.id ?? null,
      before: existing ?? null,
      after: saved,
      reason:
        providerName +
        " — شهر " +
        monthKey +
        ": مبيعات " +
        String(figures.monthlySales) +
        " + مرحّل " +
        String(figures.carriedInAmount) +
        " = أساس " +
        String(figures.settlementBase) +
        "، محوّل " +
        String(figures.receivedAmount) +
        "، متوقع " +
        String(figures.expectedAmount) +
        " بنسبة عقد " +
        String(figures.contractRate) +
        "%، مخصوم فعلي " +
        String(figures.actualDeducted) +
        "، فرق " +
        String(figures.varianceAmount) +
        "، مرحّل للشهر التالي " +
        String(figures.carriedOutAmount),
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      settlement: saved,
      figures,
      month: monthKey,
      paymentsCount: payments.length,
      message: confirm
        ? "تم تأكيد التسوية الشهرية — مخصوم فعلي " +
          String(figures.actualDeducted) +
          " مقابل متوقع " +
          String(figures.expectedAmount) +
          "، والمرحّل للشهر الجديد " +
          String(figures.carriedOutAmount)
        : "حُفظت التسوية الشهرية — المرحّل المتوقع للشهر الجديد " +
          String(figures.carriedOutAmount),
    });
  },
);

/* ══ دفعات التحويل: إضافة مبالغ للتسوية وتعديلها ═══════════════════ */

/** يقرأ تسوية بمعرّفها أو يردّ 404. */
async function settlementOr404(id: number, res: Response) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(providerSettlements)
    .where(eq(providerSettlements.id, id))
    .limit(1);
  if (!row) {
    res.status(404).json({ ok: false, error: "التسوية غير موجودة" });
    return null;
  }
  return row;
}

/** دفعات تسوية واحدة مع مجموعها — كل دفعة مرئية للمراجعة. */
financeRouter.get(
  "/finance/settlements/:id/payments",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsRead),
  requireModuleLevel("settlement_payments", 1),
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التسوية غير صالح" });
      return;
    }
    const settlement = await settlementOr404(id, res);
    if (!settlement) return;

    const payments = await settlementPaymentRows(id);
    res.json({
      ok: true,
      settlementId: id,
      providerName: settlement.providerName,
      providerType: settlement.providerType,
      month: String(settlement.periodFrom).slice(0, 7),
      payments,
      totals: {
        count: payments.length,
        amount: paymentsTotal(payments),
      },
      canManage: await hasAnyPermission(req, [PERMISSIONS.settlementsManage]),
    });
  },
);

/**
 * إضافة مبلغ محوَّل إلى تسوية الشهر.
 *
 * الحوالة تصل على دفعات متفرّقة، فكل دفعة صفٌّ بتاريخها ومرجعها. وبعد كل
 * إضافة يُعاد حساب التسوية كاملة في الخادم: المستلم = مجموع الدفعات، ويُحدَّث
 * المرحّل إلى الشهر الجديد تلقائياً. ولا تُلمس أي بيانات سابقة.
 */
financeRouter.post(
  "/finance/settlements/:id/payments",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleLevel("settlement_payments", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التسوية غير صالح" });
      return;
    }
    const settlement = await settlementOr404(id, res);
    if (!settlement) return;

    if (settlement.status === "confirmed") {
      res.status(409).json({
        ok: false,
        error: "التسوية مؤكَّدة ولا تُضاف إليها دفعات — أعد فتحها بالحذف إن لزم",
      });
      return;
    }
    if (
      await blockedBySettlementLock(
        settlement.branchId,
        settlement.periodFrom,
        settlement.periodTo,
        res,
      )
    )
      return;

    const amount = moneyOrError(body.amount, false);
    if (typeof amount === "string") {
      res.status(400).json({ ok: false, error: amount });
      return;
    }
    if (amount <= 0) {
      res.status(400).json({ ok: false, error: "مبلغ الدفعة مطلوب" });
      return;
    }

    const timezone = await branchTimezone(settlement.branchId);
    const paymentDate =
      asDateOnly(body.paymentDate) ?? isoDateInZone(new Date(), timezone);

    const [created] = await db
      .insert(providerSettlementPayments)
      .values({
        settlementId: id,
        paymentDate,
        amount,
        reference: asString(body.reference, 120) ?? "",
        notes: asString(body.notes, 500) ?? "",
        createdByEmployeeId: actor.id,
      })
      .returning();

    const result = await recomputeSettlement(id);

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.payment.add",
      entityType: "provider_settlement_payments",
      entityId: created?.id ?? null,
      before: null,
      after: created,
      reason:
        settlement.providerName +
        ": دفعة " +
        String(amount) +
        " بتاريخ " +
        paymentDate +
        " — صار المحوّل " +
        String(result?.figures.receivedAmount ?? amount) +
        " والمرحّل " +
        String(result?.figures.carriedOutAmount ?? 0),
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      payment: created,
      settlement: result?.settlement ?? null,
      figures: result?.figures ?? null,
      payments: result?.payments ?? [],
      message:
        "أُضيفت الدفعة — مجموع المحوّل " +
        String(result?.figures.receivedAmount ?? amount) +
        " والمتبقي للترحيل " +
        String(result?.figures.carriedOutAmount ?? 0),
    });
  },
);

/** تعديل دفعة محفوظة (مبلغها أو تاريخها أو مرجعها) ثم إعادة الحساب. */
financeRouter.patch(
  "/finance/settlements/payments/:paymentId",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleLevel("settlement_payments", 3),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const paymentId = asId(req.params.paymentId);
    if (paymentId === null) {
      res.status(400).json({ ok: false, error: "معرّف الدفعة غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(providerSettlementPayments)
      .where(eq(providerSettlementPayments.id, paymentId))
      .limit(1);
    if (!before) {
      res.status(404).json({ ok: false, error: "الدفعة غير موجودة" });
      return;
    }

    const settlement = await settlementOr404(before.settlementId, res);
    if (!settlement) return;
    if (settlement.status === "confirmed") {
      res.status(409).json({
        ok: false,
        error: "التسوية مؤكَّدة ولا تُعدَّل دفعاتها",
      });
      return;
    }
    if (await blockedByMonthLock(settlement.branchId, settlement.periodFrom, res))
      return;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.amount !== undefined) {
      const amount = moneyOrError(body.amount, false);
      if (typeof amount === "string") {
        res.status(400).json({ ok: false, error: amount });
        return;
      }
      if (amount <= 0) {
        res.status(400).json({ ok: false, error: "مبلغ الدفعة مطلوب" });
        return;
      }
      patch.amount = amount;
    }
    if (body.paymentDate !== undefined) {
      const date = asDateOnly(body.paymentDate);
      if (!date) {
        res.status(400).json({ ok: false, error: "تاريخ الدفعة غير صالح" });
        return;
      }
      patch.paymentDate = date;
    }
    if (body.reference !== undefined)
      patch.reference = asString(body.reference, 120) ?? "";
    if (body.notes !== undefined) patch.notes = asString(body.notes, 500) ?? "";

    const [updated] = await db
      .update(providerSettlementPayments)
      .set(patch)
      .where(eq(providerSettlementPayments.id, paymentId))
      .returning();

    const result = await recomputeSettlement(before.settlementId);

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.payment.update",
      entityType: "provider_settlement_payments",
      entityId: paymentId,
      before,
      after: updated,
      reason:
        settlement.providerName +
        ": تعديل دفعة — صار المحوّل " +
        String(result?.figures.receivedAmount ?? 0) +
        " والمرحّل " +
        String(result?.figures.carriedOutAmount ?? 0),
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      payment: updated,
      settlement: result?.settlement ?? null,
      figures: result?.figures ?? null,
      payments: result?.payments ?? [],
      message: "تم تعديل الدفعة وإعادة حساب التسوية",
    });
  },
);

/** حذف دفعة أُدخلت خطأً — بصلاحية الحذف وحدها، ثم إعادة الحساب. */
financeRouter.delete(
  "/finance/settlements/payments/:paymentId",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleDelete("settlement_payments"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;

    const paymentId = asId(req.params.paymentId);
    if (paymentId === null) {
      res.status(400).json({ ok: false, error: "معرّف الدفعة غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(providerSettlementPayments)
      .where(eq(providerSettlementPayments.id, paymentId))
      .limit(1);
    if (!before) {
      res.status(404).json({ ok: false, error: "الدفعة غير موجودة" });
      return;
    }

    const settlement = await settlementOr404(before.settlementId, res);
    if (!settlement) return;
    if (settlement.status === "confirmed") {
      res.status(409).json({
        ok: false,
        error: "التسوية مؤكَّدة ولا تُحذف دفعاتها",
      });
      return;
    }
    if (await blockedByMonthLock(settlement.branchId, settlement.periodFrom, res))
      return;

    await db
      .delete(providerSettlementPayments)
      .where(eq(providerSettlementPayments.id, paymentId));

    const result = await recomputeSettlement(before.settlementId);

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.payment.delete",
      entityType: "provider_settlement_payments",
      entityId: paymentId,
      before,
      after: null,
      reason:
        settlement.providerName +
        ": حذف دفعة " +
        String(Number(before.amount) || 0) +
        " — صار المحوّل " +
        String(result?.figures.receivedAmount ?? 0),
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      settlement: result?.settlement ?? null,
      figures: result?.figures ?? null,
      payments: result?.payments ?? [],
      message: "تم حذف الدفعة وإعادة حساب التسوية",
    });
  },
);

/* ══ ترحيل غير المحوّل إلى الشهر الجديد وتقرير نهاية الشهر ════════ */

/**
 * ترحيل ما لم يُحوَّل من شهرٍ إلى الشهر الذي يليه — لكل الشبكات والتطبيقات.
 *
 * ما لم تُحوِّله الجهة لا يُلغى ولا يُنسى: يُنقل إلى أساس تسوية الشهر الجديد
 * فيُسوّى متى وصل ولو تأخّر شهوراً. والعملية **إضافة لا حذف**: لا يُمسّ صفّ
 * الشهر المصدر إلا بوسم «رُحّل إلى» للتتبّع، ولا تُحذف ولا تُصفّر أي بيانات.
 * وهي **قابلة للتكرار بلا أثر**: الجهة المُرحَّلة مسبقاً تُتجاوز فلا يتضاعف مبلغ.
 */
financeRouter.post(
  "/finance/settlements/monthly/carry-forward",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleLevel("settlements", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const branchId = await resolveBranchId(req, body.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const period = parseMonthKey(body.month);
    if (!period) {
      res.status(400).json({ ok: false, error: "حدّد الشهر بصيغة YYYY-MM" });
      return;
    }

    const sourceKey = monthKeyOf(period.year, period.month);
    const target = nextMonth(period.year, period.month);
    const targetKey = monthKeyOf(target.year, target.month);
    const targetBounds = monthBounds(target.year, target.month);
    if (await blockedByMonthLock(branchId, targetBounds.from, res)) return;

    const requestedType = asEnum(body.providerType, PROVIDER_TYPES);
    const types = requestedType ? [requestedType] : [...PROVIDER_TYPES];

    const moved = [];
    const skipped = [];
    const now = new Date();

    for (const providerType of types) {
      const source = await monthlyProviderRows(
        branchId,
        providerType,
        period.year,
        period.month,
      );
      const carrying = source.rows.filter((row) => row.carriedOutAmount > 0);
      if (carrying.length === 0) continue;

      const targetSales = await monthlyProviderSales(
        branchId,
        targetBounds.from,
        targetBounds.to,
        providerType,
      );

      for (const row of carrying) {
        const [existing] = await db
          .select()
          .from(providerSettlements)
          .where(
            and(
              eq(providerSettlements.branchId, branchId),
              eq(providerSettlements.providerType, providerType),
              eq(providerSettlements.providerName, row.providerName),
              eq(providerSettlements.periodFrom, targetBounds.from),
              eq(providerSettlements.periodTo, targetBounds.to),
            ),
          )
          .limit(1);

        if (existing && existing.carriedFromMonth === sourceKey) {
          skipped.push({
            providerType,
            providerName: row.providerName,
            amount: row.carriedOutAmount,
            reason: "مُرحَّل مسبقاً إلى " + targetKey,
          });
          continue;
        }
        if (existing && existing.status === "confirmed") {
          skipped.push({
            providerType,
            providerName: row.providerName,
            amount: row.carriedOutAmount,
            reason: "تسوية " + targetKey + " مؤكَّدة ولا تُعدَّل",
          });
          continue;
        }

        let settlementId = 0;
        if (existing) {
          // الصفوف القديمة بلا «مخصوم فعلي»: نثبّت خصمها الضمني كما كان
          // بالضبط قبل الترحيل، فلا يتحوّل المرحّل الداخل إلى عمولة بالغلط
          const explicit = storedActualDeducted(existing);
          const impliedActual =
            explicit === null
              ? Math.max(
                  0,
                  round2(
                    (Number(existing.salesAmount) || 0) -
                      (Number(existing.receivedAmount) || 0),
                  ),
                )
              : explicit;
          await db
            .update(providerSettlements)
            .set({
              carriedInAmount: row.carriedOutAmount,
              carriedFromMonth: sourceKey,
              actualDeducted: impliedActual,
              carriedOutAmount: row.carriedOutAmount,
              contractRate:
                (Number(existing.contractRate) || 0) > 0
                  ? existing.contractRate
                  : row.contractRate,
              updatedAt: now,
            })
            .where(eq(providerSettlements.id, existing.id));
          settlementId = existing.id;
        } else {
          const monthlySales = round2(targetSales.get(row.providerName) ?? 0);
          const [inserted] = await db
            .insert(providerSettlements)
            .values({
              branchId,
              providerType,
              providerName: row.providerName,
              periodFrom: targetBounds.from,
              periodTo: targetBounds.to,
              salesAmount: monthlySales,
              receivedAmount: 0,
              commissionAmount: 0,
              commissionRate: 0,
              vatRate: row.vatRate,
              vatAmount: 0,
              vatIncluded: row.vatIncluded,
              commissionBeforeVat: 0,
              contractRate: row.contractRate,
              expectedAmount: 0,
              actualDeducted: 0,
              varianceAmount: 0,
              carriedInAmount: row.carriedOutAmount,
              // مبدئياً كل الأساس بانتظار التحويل حتى تُسجَّل دفعة أو خصم
              carriedOutAmount: round2(monthlySales + row.carriedOutAmount),
              carriedFromMonth: sourceKey,
              carriedToMonth: "",
              status: "pending",
              reference: "",
              notes: "مبلغ مُرحَّل تلقائياً من شهر " + sourceKey,
              createdByEmployeeId: actor.id,
              updatedAt: now,
            })
            .returning();
          settlementId = inserted?.id ?? 0;
        }

        if (settlementId === 0) continue;
        const result = await recomputeSettlement(settlementId);

        // وسم صفّ الشهر المصدر بأنه رُحّل — تتبّعاً لا حساباً
        if (row.settlementId) {
          await db
            .update(providerSettlements)
            .set({ carriedToMonth: targetKey, updatedAt: now })
            .where(eq(providerSettlements.id, row.settlementId));
        }

        moved.push({
          providerType,
          providerName: row.providerName,
          amount: row.carriedOutAmount,
          fromMonth: sourceKey,
          toMonth: targetKey,
          settlementId,
          newBase: result?.figures.settlementBase ?? 0,
          created: !existing,
        });
      }
    }

    const movedTotal = round2(
      moved.reduce((total, item) => total + item.amount, 0),
    );

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.month.carry_forward",
      entityType: "provider_settlements",
      entityId: null,
      before: { month: sourceKey, skipped },
      after: { month: targetKey, moved },
      reason:
        "ترحيل غير المحوّل من " +
        sourceKey +
        " إلى " +
        targetKey +
        ": " +
        String(moved.length) +
        " جهة بمجموع " +
        String(movedTotal),
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      fromMonth: sourceKey,
      toMonth: targetKey,
      moved,
      skipped,
      totals: { providers: moved.length, amount: movedTotal },
      message:
        moved.length === 0
          ? skipped.length > 0
            ? "لا جديد للترحيل — كل المبالغ مُرحَّلة مسبقاً إلى " + targetKey
            : "لا مبالغ غير محوّلة في شهر " + sourceKey
          : "رُحّل " +
            String(movedTotal) +
            " لـ" +
            String(moved.length) +
            " جهة من " +
            sourceKey +
            " إلى " +
            targetKey,
    });
  },
);

/**
 * تقرير نهاية الشهر: الشبكات وتطبيقات التوصيل في مستندٍ واحد.
 *
 * يُخرج لكل جهة: مبيعات الشهر، المرحّل الداخل، الأساس المستحق، نسبة العقد،
 * المتوقع خصمه، المخصوم الفعلي، الفرق بينهما، المحوّل فعلاً (بعدد دفعاته)،
 * وما سيُرحَّل إلى الشهر الجديد — ثم مجاميع كل قسم والمجموع العام.
 */
financeRouter.get(
  "/finance/settlements/monthly/report",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsRead),
  requireModuleLevel("settlements", 1),
  async (req: AuthedRequest, res: Response) => {
    const branchId = await resolveBranchId(req, req.query.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const today = isoDateInZone(new Date(), timezone);
    const period = parseMonthKey(req.query.month) ?? {
      year: Number.parseInt(today.slice(0, 4), 10),
      month: Number.parseInt(today.slice(5, 7), 10),
    };
    if (!isValidPeriod(period.year, period.month)) {
      res.status(400).json({ ok: false, error: "الشهر المطلوب غير صالح" });
      return;
    }

    const monthKey = monthKeyOf(period.year, period.month);
    const { from, to } = monthBounds(period.year, period.month);
    const next = nextMonth(period.year, period.month);
    const nextKey = monthKeyOf(next.year, next.month);

    const sections = [];
    let allRows: MonthlyProviderRow[] = [];

    for (const providerType of PROVIDER_TYPES) {
      const data = await monthlyProviderRows(
        branchId,
        providerType,
        period.year,
        period.month,
      );
      allRows = allRows.concat(data.rows);
      sections.push({
        providerType,
        label: PROVIDER_TYPE_LABEL[providerType],
        providers: data.rows,
        totals: providerTotals(data.rows),
        carryForward: data.rows
          .filter((row) => row.carriedOutAmount > 0)
          .map((row) => ({
            providerName: row.providerName,
            amount: row.carriedOutAmount,
            alreadyCarried: row.carriedToMonth === nextKey,
          })),
      });
    }

    const totals = providerTotals(allRows);
    const pendingCarry = round2(
      allRows
        .filter((row) => row.carriedToMonth !== nextKey)
        .reduce((total, row) => total + row.carriedOutAmount, 0),
    );

    const branch = await getDb()
      .select({ name: branches.name })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);

    res.json({
      ok: true,
      branchId,
      branchName: branch[0]?.name ?? "",
      month: monthKey,
      from,
      to,
      nextMonth: nextKey,
      today,
      /** التسوية النهائية عند آخر يوم في الشهر */
      isMonthEnded: today > to,
      sections,
      totals,
      /** ما لم يُرحَّل بعد إلى الشهر الجديد — زر الترحيل يعالجه */
      pendingCarry,
      canCarryForward: await hasAnyPermission(req, [
        PERMISSIONS.settlementsManage,
      ]),
      generatedAt: new Date().toISOString(),
    });
  },
);

/** قائمة التسويات المسجّلة مع مرشّحاتها. */
financeRouter.get(
  "/finance/settlements",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const branchId = await resolveBranchId(req, req.query.branchId);

    const month = parseMonthKey(req.query.month);
    const bounds = month ? monthBounds(month.year, month.month) : null;
    const from = asDateOnly(req.query.from) ?? bounds?.from ?? null;
    const to = asDateOnly(req.query.to) ?? bounds?.to ?? null;
    const providerType = asEnum(req.query.providerType, PROVIDER_TYPES);
    const status = asEnum(req.query.status, SETTLEMENT_FILTER_STATUSES);

    const conditions = [
      branchId === null ? undefined : eq(providerSettlements.branchId, branchId),
      from === null ? undefined : gte(providerSettlements.periodFrom, from),
      to === null ? undefined : lte(providerSettlements.periodTo, to),
      providerType === null
        ? undefined
        : eq(providerSettlements.providerType, providerType),
      status === null ? undefined : eq(providerSettlements.status, status),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        settlement: providerSettlements,
        branchName: branches.name,
      })
      .from(providerSettlements)
      .leftJoin(branches, eq(providerSettlements.branchId, branches.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(providerSettlements.periodFrom), desc(providerSettlements.id))
      .limit(500);

    const settlements = rows.map((row) => ({
      ...row.settlement,
      branchName: row.branchName,
    }));

    const confirmed = settlements.filter((item) => item.status === "confirmed");

    res.json({
      ok: true,
      settlements,
      summary: {
        count: settlements.length,
        pending: settlements.length - confirmed.length,
        salesAmount: sumBy(settlements, (item) => item.salesAmount),
        carriedInAmount: sumBy(settlements, (item) => item.carriedInAmount),
        carriedOutAmount: sumBy(settlements, (item) => item.carriedOutAmount),
        expectedAmount: sumBy(settlements, (item) => item.expectedAmount),
        actualDeducted: sumBy(settlements, (item) => item.actualDeducted),
        varianceAmount: sumBy(settlements, (item) => item.varianceAmount),
        receivedAmount: sumBy(confirmed, (item) => item.receivedAmount),
        commissionAmount: sumBy(confirmed, (item) => item.commissionAmount),
        vatAmount: sumBy(confirmed, (item) => item.vatAmount),
      },
    });
  },
);

/** يقرأ حقول التسوية المشتركة بين الإنشاء والتعديل. */
function readSettlementBody(body: Record<string, unknown>) {
  const providerName = asString(body.providerName, 120);
  const providerType = asEnum(body.providerType, PROVIDER_TYPES);
  const periodFrom = asDateOnly(body.periodFrom);
  const periodTo = asDateOnly(body.periodTo);
  const salesAmount = moneyOrError(body.salesAmount);
  const receivedAmount = moneyOrError(body.receivedAmount);
  const vatRateRaw = asNumber(body.vatRate);
  const vatRate =
    vatRateRaw === null || vatRateRaw < 0 || vatRateRaw > 100 ? 0 : vatRateRaw;

  return {
    providerName,
    providerType,
    periodFrom,
    periodTo,
    salesAmount,
    receivedAmount,
    vatRate,
    vatIncluded: body.vatIncluded === undefined ? true : body.vatIncluded !== false,
    reference: asString(body.reference, 120) ?? "",
    notes: asString(body.notes, 500) ?? "",
  };
}

/**
 * تسجيل تسوية جهة: تُفتح بحالة «بانتظار السداد» ويكفي فيها المبيعات والمدة.
 * العمولة لا تُدخل يدوياً — تُحسب عند التأكيد من المبيعات والمستلم.
 */
financeRouter.post(
  "/finance/settlements",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleLevel("settlements", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const branchId = await resolveBranchId(req, body.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const input = readSettlementBody(body);
    if (!input.providerName) {
      res.status(400).json({ ok: false, error: "اسم الجهة مطلوب (فوديكس، جاهز ...)" });
      return;
    }
    if (input.periodFrom === null || input.periodTo === null) {
      res.status(400).json({ ok: false, error: "حدّد مدة التسوية (من — إلى)" });
      return;
    }
    if (input.periodTo < input.periodFrom) {
      res.status(400).json({ ok: false, error: "تاريخ النهاية قبل تاريخ البداية" });
      return;
    }
    if (typeof input.salesAmount === "string") {
      res.status(400).json({ ok: false, error: input.salesAmount });
      return;
    }
    if (typeof input.receivedAmount === "string") {
      res.status(400).json({ ok: false, error: input.receivedAmount });
      return;
    }

    if (await blockedByMonthLock(branchId, input.periodFrom, res)) return;

    const figures = settlementFigures({
      salesAmount: input.salesAmount,
      receivedAmount: input.receivedAmount,
      vatRate: input.vatRate,
      vatIncluded: input.vatIncluded,
    });

    const [saved] = await db
      .insert(providerSettlements)
      .values({
        branchId,
        providerType: input.providerType ?? "network",
        providerName: input.providerName,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        salesAmount: figures.salesAmount,
        receivedAmount: figures.receivedAmount,
        commissionAmount: figures.commissionAmount,
        commissionRate: figures.commissionRate,
        vatRate: figures.vatRate,
        vatAmount: figures.vatAmount,
        vatIncluded: figures.vatIncluded,
        commissionBeforeVat: figures.commissionBeforeVat,
        status: "pending",
        reference: input.reference,
        notes: input.notes,
        createdByEmployeeId: actor.id,
      })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.create",
      entityType: "provider_settlements",
      entityId: saved?.id ?? null,
      after: saved,
      reason: input.providerName,
      ipAddress: clientIp(req),
    });

    res.status(201).json({
      ok: true,
      settlement: saved,
      message: "تم تسجيل التسوية بانتظار تأكيد السداد",
    });
  },
);

/**
 * تعديل تسوية لم تُؤكَّد بعد: يقبل نسبة العقد والمخصوم الفعلي فيُعاد حساب
 * المتوقع والفرق والمرحّل. والمؤكَّدة لا تُعدَّل — تُحذف وتُعاد إن لزم.
 */
financeRouter.patch(
  "/finance/settlements/:id",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleLevel("settlements", 3),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التسوية غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(providerSettlements)
      .where(eq(providerSettlements.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التسوية غير موجودة" });
      return;
    }
    if (before.status === "confirmed") {
      res.status(409).json({
        ok: false,
        error: "التسوية مؤكَّدة ولا تُعدَّل — سجّل تسوية تصحيحية أو احذفها بصلاحية الحذف.",
      });
      return;
    }
    if (
      await blockedBySettlementLock(
        before.branchId,
        before.periodFrom,
        before.periodTo,
        res,
      )
    )
      return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = readSettlementBody(body);

    const salesAmount =
      typeof input.salesAmount === "string" ? before.salesAmount : input.salesAmount;

    // المستلم من الدفعات إن سُجِّلت: مجموعها أصدق من رقم يُكتب فوقها
    const paymentRows = await settlementPaymentRows(id);
    const receivedAmount =
      paymentRows.length > 0
        ? paymentsTotal(paymentRows)
        : body.receivedAmount === undefined ||
            typeof input.receivedAmount === "string"
          ? before.receivedAmount
          : input.receivedAmount;

    const contractRate =
      body.contractRate === undefined
        ? Number(before.contractRate) || 0
        : normalizeRate(body.contractRate);

    // غياب «المخصوم الفعلي» يُبقي الصف على سلوكه السابق حرفياً
    let actualDeducted: number | null = storedActualDeducted(before);
    if (
      body.actualDeducted !== undefined &&
      body.actualDeducted !== null &&
      body.actualDeducted !== ""
    ) {
      const value = moneyOrError(body.actualDeducted);
      if (typeof value === "string") {
        res.status(400).json({ ok: false, error: value });
        return;
      }
      actualDeducted = value;
    }

    const figures = monthlySettlementFigures({
      monthlySales: salesAmount,
      carriedInAmount: Number(before.carriedInAmount) || 0,
      receivedAmount,
      actualDeducted,
      contractRate,
      vatRate: body.vatRate === undefined ? before.vatRate : input.vatRate,
      vatIncluded:
        body.vatIncluded === undefined ? before.vatIncluded : input.vatIncluded,
    });

    const [updated] = await db
      .update(providerSettlements)
      .set({
        providerType: input.providerType ?? before.providerType,
        providerName: input.providerName ?? before.providerName,
        periodFrom: input.periodFrom ?? before.periodFrom,
        periodTo: input.periodTo ?? before.periodTo,
        salesAmount: figures.monthlySales,
        receivedAmount: figures.receivedAmount,
        commissionAmount: figures.commissionAmount,
        commissionRate: figures.commissionRate,
        vatRate: figures.vatRate,
        vatAmount: figures.vatAmount,
        vatIncluded: figures.vatIncluded,
        commissionBeforeVat: figures.commissionBeforeVat,
        contractRate: figures.contractRate,
        expectedAmount: figures.expectedAmount,
        actualDeducted: figures.actualDeducted,
        varianceAmount: figures.varianceAmount,
        carriedOutAmount: figures.carriedOutAmount,
        reference: body.reference === undefined ? before.reference : input.reference,
        notes: body.notes === undefined ? before.notes : input.notes,
        updatedAt: new Date(),
      })
      .where(eq(providerSettlements.id, id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.update",
      entityType: "provider_settlements",
      entityId: id,
      before,
      after: updated,
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      settlement: updated,
      figures,
      payments: paymentRows,
      message:
        "تم تعديل التسوية — المرحّل للشهر الجديد " +
        String(figures.carriedOutAmount),
    });
  },
);

/**
 * تأكيد وصول المبلغ إلى البنك: يُدخل المحاسب المبلغ المستلم فيحسب النظام
 * تلقائياً العمولة (المبيعات − المستلم) ونسبتها المئوية وضريبتها الاختيارية،
 * ويثبّت تاريخ التأكيد واسم المحاسب في الصف نفسه.
 *
 * التأكيد إجراء موافقة، فهو الدرجة الرابعة في بند التسويات.
 */
financeRouter.post(
  "/finance/settlements/:id/confirm",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsConfirm),
  requireModuleLevel("settlements", 4),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التسوية غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(providerSettlements)
      .where(eq(providerSettlements.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التسوية غير موجودة" });
      return;
    }
    if (before.status === "confirmed") {
      res.status(409).json({ ok: false, error: "التسوية مؤكَّدة مسبقاً" });
      return;
    }
    if (
      await blockedBySettlementLock(
        before.branchId,
        before.periodFrom,
        before.periodTo,
        res,
      )
    )
      return;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // المستلم = مجموع الدفعات إن سُجِّلت، وإلا الرقم المُدخل عند التأكيد
    const paymentRows = await settlementPaymentRows(id);
    let received = 0;
    if (paymentRows.length > 0) {
      received = paymentsTotal(paymentRows);
    } else {
      const value = moneyOrError(body.receivedAmount);
      if (typeof value === "string") {
        res.status(400).json({ ok: false, error: value });
        return;
      }
      received = value;
    }

    const vatRateRaw = asNumber(body.vatRate);
    const vatRate =
      vatRateRaw === null || vatRateRaw < 0 || vatRateRaw > 100
        ? before.vatRate
        : vatRateRaw;

    const contractRate =
      body.contractRate === undefined
        ? Number(before.contractRate) || 0
        : normalizeRate(body.contractRate);

    // غياب «المخصوم الفعلي» يُبقي الحساب على سلوكه السابق حرفياً
    let actualDeducted: number | null = storedActualDeducted(before);
    if (
      body.actualDeducted !== undefined &&
      body.actualDeducted !== null &&
      body.actualDeducted !== ""
    ) {
      const value = moneyOrError(body.actualDeducted);
      if (typeof value === "string") {
        res.status(400).json({ ok: false, error: value });
        return;
      }
      actualDeducted = value;
    }

    const figures = monthlySettlementFigures({
      monthlySales: before.salesAmount,
      carriedInAmount: Number(before.carriedInAmount) || 0,
      receivedAmount: received,
      actualDeducted,
      contractRate,
      vatRate,
      vatIncluded:
        body.vatIncluded === undefined ? before.vatIncluded : body.vatIncluded !== false,
    });

    const [updated] = await db
      .update(providerSettlements)
      .set({
        receivedAmount: figures.receivedAmount,
        commissionAmount: figures.commissionAmount,
        commissionRate: figures.commissionRate,
        vatRate: figures.vatRate,
        vatAmount: figures.vatAmount,
        vatIncluded: figures.vatIncluded,
        commissionBeforeVat: figures.commissionBeforeVat,
        contractRate: figures.contractRate,
        expectedAmount: figures.expectedAmount,
        actualDeducted: figures.actualDeducted,
        varianceAmount: figures.varianceAmount,
        carriedOutAmount: figures.carriedOutAmount,
        status: "confirmed",
        reference: asString(body.reference, 120) ?? before.reference,
        notes: asString(body.notes, 500) ?? before.notes,
        confirmedByEmployeeId: actor.id,
        confirmedByName: actor.fullName ?? "",
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(providerSettlements.id, id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.confirm",
      entityType: "provider_settlements",
      entityId: id,
      before,
      after: updated,
      reason:
        "عمولة " +
        String(figures.commissionAmount) +
        " بنسبة " +
        String(figures.commissionRate) +
        "%",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      settlement: updated,
      figures,
      payments: paymentRows,
      message:
        "تم تأكيد السداد — مخصوم فعلي " +
        String(figures.actualDeducted) +
        " مقابل متوقع " +
        String(figures.expectedAmount) +
        "، والمرحّل للشهر الجديد " +
        String(figures.carriedOutAmount),
    });
  },
);

/**
 * فترة التسوية: شهر التسوية يبقى مفتوحاً بعد نهايته مهلةً قصيرة تصل فيها
 * الحوالات المتأخّرة، فتُسجَّل الدفعة على شهرها الصحيح لا على الشهر التالي.
 */
const SETTLEMENT_GRACE_DAYS = 10;

/** آخر يوم تقبل فيه تسويةُ شهرٍ فتحاً من جديد (نهاية الشهر + المهلة). */
function settlementWindowEnd(periodTo: string): string {
  const end = new Date(String(periodTo).slice(0, 10) + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + SETTLEMENT_GRACE_DAYS);
  return end.toISOString().slice(0, 10);
}

/**
 * إلغاء تأكيد تسوية مؤكَّدة — بندها المستقل بخانة صح وحده يفتحه.
 *
 * تعود التسوية إلى «بانتظار السداد» فتُفتح لإضافة المبالغ وتعديل التسوية
 * واعتمادها من جديد، وتبقى كل دفعاتها المسجّلة كما هي بلا حذف: الإلغاء
 * يفتح الصف ولا يمسح بياناته، ثم يُعاد حساب المحوّل والفرق والمرحّل من
 * الدفعات نفسها فلا يبقى رقم قديم.
 *
 * ويُسمح بذلك ما دام شهر التسوية داخل فترتها (نهاية الشهر + عشرة أيام)،
 * فدفعات الشهر تُسجَّل على شهرها لا على الشهر التالي. وبعد انقضائها يبقى
 * السلوك السابق كما هو: المتأخّر يُسجَّل على تسوية الشهر التالي.
 */
financeRouter.post(
  "/finance/settlements/:id/unconfirm",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsUnconfirm),
  requireModuleLevel("settlement_unconfirm", 1),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التسوية غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(providerSettlements)
      .where(eq(providerSettlements.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التسوية غير موجودة" });
      return;
    }
    if (before.status !== "confirmed") {
      res.status(409).json({ ok: false, error: "التسوية ليست مؤكَّدة أصلاً" });
      return;
    }
    if (
      await blockedBySettlementLock(
        before.branchId,
        before.periodFrom,
        before.periodTo,
        res,
      )
    )
      return;

    const timezone = await branchTimezone(before.branchId);
    const today = isoDateInZone(new Date(), timezone);
    const windowEnd = settlementWindowEnd(before.periodTo);
    if (today > windowEnd) {
      res.status(409).json({
        ok: false,
        error:
          "انتهت فترة تسوية هذا الشهر في " +
          windowEnd +
          " — سجّل المبالغ المتأخّرة على تسوية الشهر التالي.",
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = asString(body.reason, 500) ?? "";
    const keptPayments = await settlementPaymentRows(id);

    const [reopened] = await db
      .update(providerSettlements)
      .set({
        status: "pending",
        confirmedByEmployeeId: null,
        confirmedByName: "",
        confirmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(providerSettlements.id, id))
      .returning();

    // الدفعات المسجّلة تبقى كما هي، والأرقام تُعاد من مجموعها لا من رقم قديم
    const result = await recomputeSettlement(id);
    const after = result?.settlement ?? reopened;

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.unconfirm",
      entityType: "provider_settlements",
      entityId: id,
      before,
      after,
      reason:
        "إلغاء تأكيد تسوية " +
        before.providerName +
        " لشهر " +
        String(before.periodFrom).slice(0, 7) +
        ": الحالة قبل «مؤكَّدة» وبعد «بانتظار السداد»" +
        (note ? " — " + note : "") +
        " — بقيت " +
        String(keptPayments.length) +
        " دفعة مسجّلة بلا حذف، وفترة التسوية حتى " +
        windowEnd,
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      settlement: after,
      figures: result?.figures ?? null,
      payments: result?.payments ?? keptPayments,
      windowEnd,
      message:
        "أُلغي تأكيد تسوية " +
        before.providerName +
        " — عادت إلى «بانتظار السداد» وفُتحت للإضافة والتعديل حتى " +
        windowEnd +
        "، والدفعات المسجّلة سابقاً باقية كما هي.",
    });
  },
);

/** حذف تسوية لم تُؤكَّد — خانة الحذف المستقلة. */
financeRouter.delete(
  "/finance/settlements/:id",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsManage),
  requireModuleDelete("settlements"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التسوية غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(providerSettlements)
      .where(eq(providerSettlements.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التسوية غير موجودة" });
      return;
    }
    if (await blockedByMonthLock(before.branchId, before.periodFrom, res)) return;

    await db.delete(providerSettlements).where(eq(providerSettlements.id, id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settlement.delete",
      entityType: "provider_settlements",
      entityId: id,
      before,
      reason: asString(req.body?.reason, 300) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف التسوية" });
  },
);

/* ══ خامساً: إقفال الشهر والترحيل ═══════════════════════════════════ */

/**
 * مستلمو إشعار ملخّص الإقفال: الأونر (من يملك الترحيل أو التصفير) ومن مُنح
 * «عرض ملخص الإقفال». تُحسب المحصّلة الفعلية لكل موظف بقراءة جماعية واحدة.
 */
async function summaryRecipients(): Promise<number[]> {
  const rulesByEmployee = await accessRulesByEmployee();
  const recipients: number[] = [];

  for (const [employeeId, rules] of rulesByEmployee) {
    const owned = new Set(buildAccessProfile(rules).codes);
    if (
      owned.has(PERMISSIONS.monthlyCarryForward) ||
      owned.has(PERMISSIONS.monthlyReset) ||
      owned.has(PERMISSIONS.monthlySummaryView)
    ) {
      recipients.push(employeeId);
    }
  }

  return recipients;
}

/** يكتب إشعاراً لكل مستلم — فشل الإشعار لا يُفشل العملية المحاسبية. */
async function notifySummary(options: {
  kind: string;
  title: string;
  body: string;
  refId: number;
}): Promise<number> {
  try {
    const recipients = await summaryRecipients();
    if (recipients.length === 0) return 0;
    const db = getDb();
    await db.insert(cashNotifications).values(
      recipients.map((employeeId) => ({
        employeeId,
        kind: options.kind,
        title: options.title,
        body: options.body,
        refType: "monthly_cash_closings",
        refId: options.refId,
      })),
    );
    return recipients.length;
  } catch (error) {
    console.error("[restaurant-hr] تعذّر إرسال إشعار الإقفال:", error);
    return 0;
  }
}

/**
 * يجهّز ملخّص إقفال شهر إن لم يكن مجهّزاً.
 *
 * الشهر بلا أي حركة (لا تقفيلة ولا مصروف ولا مرحّل) لا يُقفل أصلاً — ولهذا
 * لا تتحوّل الشهور القديمة الفارغة إلى «بانتظار الاعتماد».
 * وبمجرد التجهيز يُقفل الشهر (`lockedAt`) فلا يُعدَّل عليه حتى يُتخذ القرار.
 */
async function ensureMonthPrepared(options: {
  branchId: number;
  year: number;
  month: number;
  actorEmployeeId: number | null;
  ipAddress?: string;
}) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(monthlyCashClosings)
    .where(
      and(
        eq(monthlyCashClosings.branchId, options.branchId),
        eq(monthlyCashClosings.periodYear, options.year),
        eq(monthlyCashClosings.periodMonth, options.month),
      ),
    )
    .limit(1);

  if (existing) return { row: existing, created: false };

  const summary = await monthlySummaryFor(
    options.branchId,
    options.year,
    options.month,
  );

  if (
    summary.closingsCount === 0 &&
    summary.expensesCount === 0 &&
    summary.openingBalance === 0
  ) {
    return { row: null, created: false };
  }

  const [saved] = await db
    .insert(monthlyCashClosings)
    .values({
      branchId: options.branchId,
      periodYear: options.year,
      periodMonth: options.month,
      openingBalance: summary.openingBalance,
      cashSalesTotal: summary.cashSalesTotal,
      expensesTotal: summary.expensesTotal,
      settlementsReceived: summary.settlementsReceived,
      commissionTotal: summary.commissionTotal,
      vatTotal: summary.vatTotal,
      netAmount: summary.netAmount,
      carriedAmount: 0,
      status: "pending_approval",
      preparedByEmployeeId: options.actorEmployeeId,
      preparedAt: new Date(),
      lockedAt: new Date(),
      summaryJson: JSON.stringify(summary),
    })
    .returning();

  await recordAudit({
    actorEmployeeId: options.actorEmployeeId,
    action: "month.prepare",
    entityType: "monthly_cash_closings",
    entityId: saved?.id ?? null,
    after: saved,
    reason: "تجهيز ملخّص إقفال " + summary.monthKey,
    ipAddress: options.ipAddress ?? "",
  });

  if (saved) {
    await notifySummary({
      kind: "month_close_ready",
      title: "ملخّص إقفال شهر " + summary.monthKey + " جاهز للاعتماد",
      body:
        "الإجمالي النقدي " +
        String(summary.cashSalesTotal) +
        " — المصاريف " +
        String(summary.expensesTotal) +
        " — الصافي " +
        String(summary.netAmount) +
        ". الشهر بانتظار قرارك: اعتماد الترحيل أو تصفير.",
      refId: saved.id,
    });
  }

  return { row: saved ?? null, created: true };
}

/**
 * قائمة إقفالات سنة كاملة لفرع. تجهّز تلقائياً ملخّص كل شهر انتهى ولم
 * يُجهَّز بعد — وهو المقصود بـ«في نهاية الشهر يجهّز النظام الملخّص تلقائياً».
 */
financeRouter.get(
  "/finance/monthly-closings",
  requireAuth,
  requirePermission(PERMISSIONS.monthlySummaryView),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const branchId = await resolveBranchId(req, req.query.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const today = isoDateInZone(new Date(), timezone);
    const currentYear = Number.parseInt(today.slice(0, 4), 10);
    const currentMonth = Number.parseInt(today.slice(5, 7), 10);

    const yearRaw = asNumber(req.query.year);
    const year =
      yearRaw === null || !isValidPeriod(Math.round(yearRaw), 1)
        ? currentYear
        : Math.round(yearRaw);

    let prepared = 0;
    for (let month = 1; month <= 12; month += 1) {
      const ended = year < currentYear || (year === currentYear && month < currentMonth);
      if (!ended) continue;
      const result = await ensureMonthPrepared({
        branchId,
        year,
        month,
        actorEmployeeId: actor.id,
        ipAddress: clientIp(req),
      });
      if (result.created) prepared += 1;
    }

    const rows = await db
      .select()
      .from(monthlyCashClosings)
      .where(
        and(
          eq(monthlyCashClosings.branchId, branchId),
          eq(monthlyCashClosings.periodYear, year),
        ),
      )
      .orderBy(desc(monthlyCashClosings.periodMonth));

    const canCarry = await hasAnyPermission(req, [PERMISSIONS.monthlyCarryForward]);
    const canReset = await hasAnyPermission(req, [PERMISSIONS.monthlyReset]);

    res.json({
      ok: true,
      branchId,
      year,
      prepared,
      closings: rows.map((row) => ({
        ...row,
        monthKey: monthKeyOf(row.periodYear, row.periodMonth),
        statusLabel: MONTH_STATUS_LABELS[row.status] ?? row.status,
      })),
      /** الواجهة تخفي الأزرار بناءً عليهما — والخادم يرفض بلا صلاحية أيضاً */
      canCarryForward: canCarry,
      canReset,
      today,
    });
  },
);

/** تجهيز ملخّص شهر بعينه يدوياً (لمن يعرض الملخّص). */
financeRouter.post(
  "/finance/monthly-closings/prepare",
  requireAuth,
  requirePermission(PERMISSIONS.monthlySummaryView),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = await resolveBranchId(req, body.branchId);
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "حدّد الفرع أولاً" });
      return;
    }

    const period = parseMonthKey(body.month);
    if (!period) {
      res.status(400).json({ ok: false, error: "حدّد الشهر بصيغة YYYY-MM" });
      return;
    }

    const result = await ensureMonthPrepared({
      branchId,
      year: period.year,
      month: period.month,
      actorEmployeeId: actor.id,
      ipAddress: clientIp(req),
    });

    if (!result.row) {
      res.status(400).json({
        ok: false,
        error: "لا توجد أي حركة نقدية في هذا الشهر فلا يوجد ما يُقفل.",
      });
      return;
    }

    res.json({
      ok: true,
      closing: result.row,
      created: result.created,
      message: result.created
        ? "تم تجهيز ملخّص الإقفال وإرساله إشعاراً لأصحاب الصلاحية"
        : "ملخّص هذا الشهر مجهّز مسبقاً",
    });
  },
);

/**
 * القرار بضغطة واحدة: «اعتماد الترحيل» أو «تصفير».
 *
 * الصلاحية تُفحص حسب القرار نفسه لا حسب الشاشة: من يملك الترحيل وحده لا
 * يستطيع التصفير، والعكس. ومن لا يملك أياً منهما لا يرى الزر أصلاً ولا
 * يستطيع تنفيذه لو استدعى المسار مباشرة.
 */
financeRouter.post(
  "/finance/monthly-closings/:id/decision",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الإقفال غير صالح" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = asEnum(body.decision, MONTH_DECISIONS) as MonthDecision | null;
    if (decision === null) {
      res.status(400).json({
        ok: false,
        error: "القرار يجب أن يكون carry_forward (ترحيل) أو reset (تصفير)",
      });
      return;
    }

    const requiredCode =
      decision === "carry_forward"
        ? PERMISSIONS.monthlyCarryForward
        : PERMISSIONS.monthlyReset;

    if (!(await hasAnyPermission(req, [requiredCode]))) {
      res.status(403).json({
        ok: false,
        error:
          decision === "carry_forward"
            ? "لا تملك صلاحية «اعتماد الترحيل الشهري»"
            : "لا تملك صلاحية «تصفير الرصيد الشهري»",
      });
      return;
    }

    const [before] = await db
      .select()
      .from(monthlyCashClosings)
      .where(eq(monthlyCashClosings.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "ملخّص الإقفال غير موجود" });
      return;
    }

    if (before.status !== "pending_approval") {
      res.status(409).json({
        ok: false,
        error:
          "شهر " +
          monthKeyOf(before.periodYear, before.periodMonth) +
          " اتُّخذ فيه قرار مسبق (" +
          (MONTH_STATUS_LABELS[before.status] ?? before.status) +
          ") ولا يُعاد فتحه.",
      });
      return;
    }

    const outcome = decisionOutcome(before.netAmount, decision);
    const decidedAt = new Date();

    const [updated] = await db
      .update(monthlyCashClosings)
      .set({
        status: outcome.status,
        decision,
        carriedAmount: outcome.carriedAmount,
        decisionNote: asString(body.note, 500) ?? "",
        decidedByEmployeeId: actor.id,
        decidedByName: actor.fullName,
        decidedAt,
        lockedAt: before.lockedAt ?? decidedAt,
        updatedAt: decidedAt,
      })
      .where(eq(monthlyCashClosings.id, id))
      .returning();

    const following = nextMonth(before.periodYear, before.periodMonth);

    // سجل المراجعة: من، متى، ماذا اختار — بالقيم قبل وبعد
    await recordAudit({
      actorEmployeeId: actor.id,
      action:
        decision === "carry_forward" ? "month.carry_forward" : "month.reset",
      entityType: "monthly_cash_closings",
      entityId: id,
      before,
      after: updated,
      reason:
        (decision === "carry_forward" ? "اعتماد الترحيل" : "تصفير") +
        " لشهر " +
        monthKeyOf(before.periodYear, before.periodMonth) +
        " — المرحّل إلى " +
        monthKeyOf(following.year, following.month) +
        " = " +
        String(outcome.nextOpening),
      ipAddress: clientIp(req),
    });

    await notifySummary({
      kind: "month_closed",
      title:
        "أُقفل شهر " + monthKeyOf(before.periodYear, before.periodMonth),
      body:
        (decision === "carry_forward"
          ? "اعتُمد ترحيل الصافي "
          : "صُفِّر الرصيد وكان الصافي ") +
        String(before.netAmount) +
        " بواسطة " +
        actor.fullName +
        ". بداية " +
        monthKeyOf(following.year, following.month) +
        " = " +
        String(outcome.nextOpening) +
        ".",
      refId: id,
    });

    res.json({
      ok: true,
      closing: updated,
      outcome,
      nextMonth: monthKeyOf(following.year, following.month),
      message:
        decision === "carry_forward"
          ? "تم اعتماد الترحيل — بداية الشهر الجديد " + String(outcome.nextOpening)
          : "تم التصفير — الشهر الجديد يبدأ من صفر",
    });
  },
);

/* ══ الإشعارات وبيانات الشاشة ═══════════════════════════════════════ */

/** إشعارات المستخدم نفسه فقط. */
financeRouter.get(
  "/finance/notifications",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const rows = await db
      .select()
      .from(cashNotifications)
      .where(eq(cashNotifications.employeeId, actor.id))
      .orderBy(desc(cashNotifications.id))
      .limit(50);

    res.json({
      ok: true,
      notifications: rows,
      unread: rows.filter((row) => !row.isRead).length,
    });
  },
);

/** تعليم إشعار كمقروء — لا يمس إشعارات غيره. */
financeRouter.post(
  "/finance/notifications/:id/read",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الإشعار غير صالح" });
      return;
    }

    await db
      .update(cashNotifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(cashNotifications.id, id),
          eq(cashNotifications.employeeId, actor.id),
        ),
      );

    res.json({ ok: true });
  },
);

/**
 * بيانات شاشة النقدية: الفروع المتاحة، تاريخ العمل، والقدرات الفعلية
 * للمستخدم — تخفي بها الواجهة ما سيرفضه الخادم أصلاً.
 */
financeRouter.get(
  "/finance/meta",
  requireAuth,
  requireAnyPermission(
    PERMISSIONS.cashExpensesRead,
    PERMISSIONS.settlementsRead,
    PERMISSIONS.monthlySummaryView,
    PERMISSIONS.cashMonthlyBalanceView,
    PERMISSIONS.cashRemainingView,
  ),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;

    const wide = await hasAnyPermission(req, [
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.reportsView,
      PERMISSIONS.branchesRead,
    ]);

    const branchRows = wide
      ? await db
          .select({ id: branches.id, name: branches.name })
          .from(branches)
          .orderBy(asc(branches.id))
      : actor.branchId === null
        ? []
        : await db
            .select({ id: branches.id, name: branches.name })
            .from(branches)
            .where(inArray(branches.id, [actor.branchId]));

    const branchId = actor.branchId ?? branchRows[0]?.id ?? null;
    const timezone = await branchTimezone(branchId);

    /*
     * القدرات الفعلية للمستخدم في هذه الشاشة، مفصّلة كما يفصلها الخادم بالضبط
     * حتى لا يظهر للمستخدم زرٌّ سيُرفَض عند الضغط: الاطلاع درجة 1، والإضافة 2،
     * والتعديل 3، والاعتماد 4، والحذف خانة مستقلة عن السلّم كله. ودفعات
     * التحويل بندها المستقل، فقد يملكها من لا يملك أرقام التسوية نفسها.
     */
    const capabilities = {
      /** خانة «المتبقي النقدي في درج الكاشير» — بند مستقل في الصلاحيات */
      viewRemaining: await hasAnyPermission(req, [PERMISSIONS.cashRemainingView]),
      /** «الرصيد النقدي الشهري» داخل صفحة التقفيل — بند مستقل */
      viewMonthlyBalance: await hasAnyPermission(req, [
        PERMISSIONS.cashMonthlyBalanceView,
      ]),
      readExpenses: await hasAnyPermission(req, [PERMISSIONS.cashExpensesRead]),
      writeExpenses: await hasAnyPermission(req, [PERMISSIONS.cashExpensesWrite]),
      addExpenses: await hasModuleLevel(req, "cash_expenses", 2),
      editExpenses: await hasModuleLevel(req, "cash_expenses", 3),
      deleteExpenses: await hasModuleDelete(req, "cash_expenses"),
      readSettlements: await hasAnyPermission(req, [PERMISSIONS.settlementsRead]),
      manageSettlements: await hasAnyPermission(req, [
        PERMISSIONS.settlementsManage,
      ]),
      confirmSettlements: await hasAnyPermission(req, [
        PERMISSIONS.settlementsConfirm,
      ]),
      addSettlements: await hasModuleLevel(req, "settlements", 2),
      editSettlements: await hasModuleLevel(req, "settlements", 3),
      approveSettlements: await hasModuleLevel(req, "settlements", 4),
      deleteSettlements: await hasModuleDelete(req, "settlements"),
      /** «إلغاء التأكيد»: بند مستقل بخانة صح لا يمنحه بند التسويات */
      unconfirmSettlements: await hasModuleLevel(req, "settlement_unconfirm", 1),
      viewPayments: await hasModuleLevel(req, "settlement_payments", 1),
      addPayments: await hasModuleLevel(req, "settlement_payments", 2),
      editPayments: await hasModuleLevel(req, "settlement_payments", 3),
      deletePayments: await hasModuleDelete(req, "settlement_payments"),
      viewMonthlySummary: await hasAnyPermission(req, [
        PERMISSIONS.monthlySummaryView,
      ]),
      carryForward: await hasAnyPermission(req, [PERMISSIONS.monthlyCarryForward]),
      resetBalance: await hasAnyPermission(req, [PERMISSIONS.monthlyReset]),
    };

    /*
     * الدخول نفسه يُسجَّل في سجل التدقيق: من فتح شاشة «النقدية والإقفال» ومتى
     * ومن أي عنوان، ومعه صورة قدراته وقت الدخول — فيُعرف من رأى الأرقام لا من
     * غيّرها فقط. والتسجيل بعد نجاح فحص الصلاحية، فالمحاولة المرفوضة تُردّ 403
     * قبل الوصول إلى هنا.
     */
    await recordAudit({
      actorEmployeeId: actor.id,
      action: "finance.cashbox.enter",
      entityType: "cash_screen",
      entityId: branchId,
      before: null,
      after: { branchId, capabilities },
      reason: "دخول شاشة النقدية والإقفال",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      branches: branchRows,
      defaultBranchId: branchId,
      timezone,
      today: isoDateInZone(new Date(), timezone),
      shifts: SHIFTS,
      expenseKinds: EXPENSE_KINDS,
      providerTypes: PROVIDER_TYPES,
      providerDefaults: {
        network: DEFAULT_NETWORK_LINES,
        delivery_app: DEFAULT_DELIVERY_APPS,
      },
      monthStatusLabels: MONTH_STATUS_LABELS,
      can: capabilities,
    });
  },
);
