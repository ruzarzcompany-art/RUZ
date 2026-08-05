/**
 * حسابات النقدية: السجل الموحّد للمصاريف، المتبقي النقدي في الدرج، تسوية
 * الشبكات وتطبيقات التوصيل، والرصيد الشهري وإقفال الشهر والترحيل.
 *
 * كل ما في هذا الملف **حساب خالص**: لا يلمس قاعدة البيانات ولا الشبكة، فهو
 * المرجع الوحيد لهذه المعادلات ويُختبر وحده (tests/finance.test.mjs).
 * مسار الخادم (server/routes/finance.ts) يقرأ الصفوف ثم يستدعي هذه الدوال،
 * والواجهة تعرض معاينة فقط — والخادم هو المرجع كما في بقية النظام.
 */

import { round2 } from "./validate.js";

/** نوع الحركة في السجل الموحّد: مصروف تشغيلي أو شراء بضاعة. */
export const EXPENSE_KINDS = ["expense", "purchase"] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

/** الجهة التي تُسوّى: شبكة (فودكس، مدى...) أو تطبيق توصيل. */
export const PROVIDER_TYPES = ["network", "delivery_app"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** حالة التسوية: بانتظار وصول المبلغ، أو مؤكَّدة بعد وصوله. */
export const SETTLEMENT_STATUSES = ["pending", "confirmed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * حالة الشهر: يبقى بانتظار الاعتماد ولا يُعدّل عليه، ثم يُقفل إما بترحيل
 * الصافي إلى الشهر الجديد أو بتصفيره.
 */
export const MONTH_STATUSES = [
  "pending_approval",
  "carried_forward",
  "reset",
] as const;
export type MonthStatus = (typeof MONTH_STATUSES)[number];

/** القراران المتاحان لصاحب الصلاحية بضغطة واحدة. */
export const MONTH_DECISIONS = ["carry_forward", "reset"] as const;
export type MonthDecision = (typeof MONTH_DECISIONS)[number];

/** حارس ضد خطأ الإدخال — نفس سقف تقفيل الكاشير. */
export const MAX_AMOUNT = 10_000_000;

/** تسميات عربية للحالات — تستخدمها الواجهة والطباعة من مصدر واحد. */
export const MONTH_STATUS_LABELS: Record<string, string> = {
  pending_approval: "بانتظار الاعتماد",
  carried_forward: "مُرحّل للشهر الجديد",
  reset: "مُصفَّر",
};

export const MONTH_DECISION_LABELS: Record<string, string> = {
  carry_forward: "اعتماد الترحيل",
  reset: "تصفير",
};

/* ── السجل الموحّد للمصاريف والمشتريات النقدية ──────────────────── */

/**
 * المبلغ الإجمالي للفاتورة.
 *
 * الأصل: الكمية × سعر الوحدة. وإن أدخل المستخدم مبلغاً إجمالياً صريحاً
 * (فاتورة فيها ضريبة أو خصم أو تقريب) فهو المعتمد، لأن المدفوع نقداً هو ما
 * خرج من الدرج فعلاً لا ما تحسبه المعادلة.
 */
export function invoiceTotal(input: {
  quantity?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
}): number {
  const explicit = Number(input.amount ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return round2(explicit);

  const quantity = Number(input.quantity ?? 0);
  const unitPrice = Number(input.unitPrice ?? 0);
  const computed = quantity * unitPrice;
  return Number.isFinite(computed) && computed > 0 ? round2(computed) : 0;
}

/**
 * المتبقي النقدي في درج الكاشير = المبيعات النقدية − مصاريف اليوم/الوردية.
 *
 * المصاريف تُقرأ من السجل الموحّد وحده، فالفاتورة تُسجَّل مرة وتُخصم مرة:
 * التقفيل اليومي والتقرير الشهري يقرآن من المصدر نفسه بلا ازدواج.
 */
export function remainingCash(cashSales: number, expenses: number): number {
  return round2((Number(cashSales) || 0) - (Number(expenses) || 0));
}

/* ── التجميع الشهري للشبكات وتطبيقات التوصيل ────────────────────── */

/**
 * مبيعات جهة واحدة مجمّعة من بنود التقفيلات اليومية.
 *
 * التسوية **شهرية لا يومية**: التحويلات لا تصل يوماً بيوم، فتُجمَّع مبيعات
 * الجهة طوال الشهر ثم تُسوّى مرة واحدة على المجموع عند وصول الحوالة إلى
 * البنك — وبهذا وحده تخرج نسبة العمولة صحيحة، لأن مقام النسبة يصير مبيعات
 * الشهر كاملة لا مبيعات يوم واحد.
 */
export function aggregateMonthlySales(
  rows: Array<{ amount?: number | null }>,
): number {
  return round2(
    rows.reduce((total, row) => total + (Number(row.amount) || 0), 0),
  );
}

/** ما لم يدخل تسويةً بعد من مبيعات الشهر لجهة: المجمّع − ما سُوّي. */
export function unsettledSales(
  monthlySales: number,
  settledSales: number,
): number {
  return round2((Number(monthlySales) || 0) - (Number(settledSales) || 0));
}

/** مفتاح شهر تاريخٍ يومي: YYYY-MM-DD ← YYYY-MM. */
export function monthKeyOfDate(isoDate: string): string {
  return String(isoDate).slice(0, 7);
}

/* ── معادلتا العمولة ────────────────────────────────────────────── */

/** العمولة = المبيعات − المستلم. */
export function commissionOf(
  salesAmount: number,
  receivedAmount: number,
): number {
  return round2((Number(salesAmount) || 0) - (Number(receivedAmount) || 0));
}

/** النسبة = العمولة ÷ المبيعات × 100 (صفر إن لم تكن هناك مبيعات). */
export function commissionRateOf(
  commissionAmount: number,
  salesAmount: number,
): number {
  const sales = Number(salesAmount) || 0;
  if (sales <= 0) return 0;
  return round2(((Number(commissionAmount) || 0) / sales) * 100);
}

/* ── تسوية الشبكات وتطبيقات التوصيل ─────────────────────────────── */

export interface SettlementInput {
  /** مبيعات الجهة كما رُصدت في تقفيلات المدة */
  salesAmount: number;
  /** المبلغ الذي وصل البنك فعلاً */
  receivedAmount: number;
  /** نسبة ضريبة القيمة المضافة على العمولة — اختيارية (0 = بلا ضريبة) */
  vatRate?: number | null;
  /**
   * هل العمولة المقتطعة شاملة للضريبة؟ الافتراضي نعم: الجهة تقتطع العمولة
   * وضريبتها معاً من الحوالة، فتُستخرج الضريبة من داخل الفرق المحسوب.
   * وإن كانت الضريبة تُضاف فوق العمولة تُمرَّر false.
   */
  vatIncluded?: boolean | null;
}

export interface SettlementFigures {
  salesAmount: number;
  receivedAmount: number;
  /** العمولة = المبيعات − المستلم (سالبة تعني أن الوارد أكثر من المبيعات) */
  commissionAmount: number;
  /** نسبة العمولة المئوية من المبيعات */
  commissionRate: number;
  vatRate: number;
  vatIncluded: boolean;
  vatAmount: number;
  /** العمولة بلا ضريبة — يحتاجها الإقرار الضريبي */
  commissionBeforeVat: number;
}

/**
 * يحسب العمولة ونسبتها وضريبتها من رقمين لا ثالث لهما: المبيعات والمستلم.
 * لا يُدخل المحاسب العمولة يدوياً حتى لا تختلف عن واقع الحوالة.
 */
export function settlementFigures(input: SettlementInput): SettlementFigures {
  const salesAmount = round2(Number(input.salesAmount) || 0);
  const receivedAmount = round2(Number(input.receivedAmount) || 0);
  // العمولة = المبيعات − المستلم، والنسبة = العمولة ÷ المبيعات × 100
  const commissionAmount = commissionOf(salesAmount, receivedAmount);
  const commissionRate = commissionRateOf(commissionAmount, salesAmount);

  const vatRate = Math.max(0, Number(input.vatRate) || 0);
  const vatIncluded = input.vatIncluded !== false;

  let vatAmount = 0;
  let commissionBeforeVat = commissionAmount;

  if (vatRate > 0 && commissionAmount !== 0) {
    if (vatIncluded) {
      commissionBeforeVat = round2(commissionAmount / (1 + vatRate / 100));
      vatAmount = round2(commissionAmount - commissionBeforeVat);
    } else {
      vatAmount = round2(commissionAmount * (vatRate / 100));
      commissionBeforeVat = commissionAmount;
    }
  }

  return {
    salesAmount,
    receivedAmount,
    commissionAmount,
    commissionRate,
    vatRate,
    vatIncluded,
    vatAmount,
    commissionBeforeVat,
  };
}

/* ── العقد والمتوقع والمخصوم الفعلي وترحيل غير المحوّل ───────────── */

/**
 * مجموع دفعات التحويل الواصلة إلى البنك.
 *
 * الحوالة لا تصل مرة واحدة ولا في موعد ثابت، فتُسجَّل كل دفعة بتاريخها
 * ومرجعها ويكون «المستلم» مجموعها لا رقماً يكتبه أحد بيده — فلا تضيع دفعة
 * ولا تُحسب مرتين، وتبقى كل دفعة مرئية للمراجعة.
 */
export function paymentsTotal(
  rows: Array<{ amount?: number | null }>,
): number {
  return round2(
    rows.reduce((total, row) => total + (Number(row.amount) || 0), 0),
  );
}

/**
 * الأساس المستحق للتسوية = مبيعات الشهر المجمّعة + المرحّل من الشهر السابق.
 *
 * ما لم يُحوَّل في شهرٍ لا يُلغى ولا يُنسى: يُرحَّل إلى الشهر الجديد فيدخل
 * أساس تسويته، وبهذا يُسوّى المبلغ متى وصل ولو تأخّر شهراً أو أكثر.
 */
export function settlementBase(
  monthlySales: number,
  carriedInAmount: number,
): number {
  return round2((Number(monthlySales) || 0) + (Number(carriedInAmount) || 0));
}

/** المبلغ المتوقع خصمه بحسب العقد = الأساس × نسبة العقد ÷ 100. */
export function expectedDeduction(
  baseAmount: number,
  contractRate: number,
): number {
  const rate = Number(contractRate) || 0;
  if (rate <= 0) return 0;
  return round2(((Number(baseAmount) || 0) * rate) / 100);
}

/**
 * الفرق = المخصوم الفعلي − المتوقع.
 * موجب = الجهة خصمت أكثر من نسبة العقد (مطالبة)، وسالب = خصمت أقل.
 */
export function deductionVariance(
  actualDeducted: number,
  expectedAmount: number,
): number {
  return round2((Number(actualDeducted) || 0) - (Number(expectedAmount) || 0));
}

/**
 * المرحّل إلى الشهر التالي = الأساس − المحوّل − المخصوم الفعلي.
 *
 * أي أن نقص الحوالة يُفسَّر جزءين لا جزءاً واحداً: ما خُصم عمولةً (معروف من
 * كشف الجهة) وما لم يُحوَّل بعد. والثاني هو ما يُرحَّل — ولا يكون سالباً،
 * فوصول أكثر من المستحق لا يُنشئ ترحيلاً بالسالب.
 */
export function carryOverAmount(
  baseAmount: number,
  receivedAmount: number,
  actualDeducted: number,
): number {
  const remaining =
    (Number(baseAmount) || 0) -
    (Number(receivedAmount) || 0) -
    (Number(actualDeducted) || 0);
  return remaining <= 0 ? 0 : round2(remaining);
}

/** يقصّ نسبة العقد داخل المدى المعقول 0..100. */
export function normalizeRate(value: unknown): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate > 100 ? 100 : round2(rate);
}

export interface MonthlySettlementInput {
  /** مبيعات الجهة مجمّعة على الشهر كله من التقفيلات اليومية */
  monthlySales: number;
  /** المرحّل من الشهر السابق: ما لم يُحوَّل هناك */
  carriedInAmount?: number | null;
  /** مجموع دفعات التحويل الواصلة فعلاً */
  receivedAmount: number;
  /**
   * المخصوم الفعلي كما في كشف الجهة. إن لم يُدخل فكل نقص الحوالة يُعدّ
   * خصماً (وهو سلوك النظام قبل هذه الإضافة تماماً) ولا يُرحَّل شيء.
   */
  actualDeducted?: number | null;
  /** نسبة العقد (%) — منها يُحسب المتوقع ليُقارن بالفعلي */
  contractRate?: number | null;
  vatRate?: number | null;
  vatIncluded?: boolean | null;
}

export interface MonthlySettlementFigures extends SettlementFigures {
  monthlySales: number;
  carriedInAmount: number;
  /** الأساس المستحق = مبيعات الشهر + المرحّل من السابق */
  settlementBase: number;
  contractRate: number;
  expectedAmount: number;
  actualDeducted: number;
  varianceAmount: number;
  carriedOutAmount: number;
}

/**
 * أرقام التسوية الشهرية كاملة: الأساس، المحوّل، المتوقع بحسب العقد،
 * المخصوم الفعلي، الفرق بينهما، والمرحّل إلى الشهر الجديد.
 *
 * العمولة تبقى بمعناها نفسه (ما خُصم من المستحق) والنسبة = العمولة ÷ الأساس
 * × 100. ولذلك تُحسب هنا عبر `settlementFigures` بعد تحييد المرحّل: نمرّر
 * «المستلم» على أنه الأساس − المخصوم الفعلي، فتخرج العمولة = المخصوم الفعلي
 * بالضبط وتُحسب ضريبتها منها — ثم نُعيد المستلم الحقيقي في النتيجة.
 *
 * وإذا لم يُدخل المحاسب مخصوماً فعلياً فالنتيجة مطابقة للسلوك القديم حرفياً:
 * العمولة = الأساس − المستلم، والمرحّل صفر.
 */
export function monthlySettlementFigures(
  input: MonthlySettlementInput,
): MonthlySettlementFigures {
  const monthlySales = round2(Number(input.monthlySales) || 0);
  const carriedInAmount = round2(Number(input.carriedInAmount) || 0);
  const base = settlementBase(monthlySales, carriedInAmount);
  const receivedAmount = round2(Number(input.receivedAmount) || 0);

  const shortfall = round2(base - receivedAmount);
  const rawActual = Number(input.actualDeducted);
  const hasActual =
    input.actualDeducted !== undefined &&
    input.actualDeducted !== null &&
    Number.isFinite(rawActual);
  const actualDeducted = hasActual ? round2(Math.max(0, rawActual)) : shortfall;

  const contractRate = normalizeRate(input.contractRate);
  const expectedAmount = expectedDeduction(base, contractRate);
  const varianceAmount =
    contractRate > 0 ? deductionVariance(actualDeducted, expectedAmount) : 0;
  const carriedOutAmount = carryOverAmount(base, receivedAmount, actualDeducted);

  const core = settlementFigures({
    salesAmount: base,
    receivedAmount: round2(base - actualDeducted),
    vatRate: input.vatRate,
    vatIncluded: input.vatIncluded,
  });

  return {
    ...core,
    // المستلم الحقيقي لا المُحيَّد الذي استُخدم لاستخراج العمولة
    receivedAmount,
    monthlySales,
    carriedInAmount,
    settlementBase: base,
    contractRate,
    expectedAmount,
    actualDeducted,
    varianceAmount,
    carriedOutAmount,
  };
}
/* ── الرصيد الشهري وإقفال الشهر ─────────────────────────────────── */

export interface MonthlyTotals {
  /** المرحّل من الشهر السابق (صفر إن كان قراره تصفيراً أو لا شهر قبله) */
  openingBalance: number;
  /** مجموع النقدي المتراكم من تقفيلات الشهر */
  cashSalesTotal: number;
  /** مجموع المصاريف والمشتريات النقدية من السجل الموحّد */
  expensesTotal: number;
}

/**
 * الصافي الحالي = المرحّل + النقدي المتراكم من التقفيلات − المصاريف النقدية.
 * يُعرض طوال الشهر لا في نهايته فقط.
 */
export function monthlyNet(totals: MonthlyTotals): number {
  return round2(
    (Number(totals.openingBalance) || 0) +
      (Number(totals.cashSalesTotal) || 0) -
      (Number(totals.expensesTotal) || 0),
  );
}

export interface DecisionOutcome {
  status: MonthStatus;
  /** ما رُحّل فعلاً إلى الشهر التالي */
  carriedAmount: number;
  /** رصيد بداية الشهر التالي بعد هذا القرار */
  nextOpening: number;
}

/**
 * أثر القرار: «اعتماد الترحيل» ينقل الصافي كما هو إلى بداية الشهر الجديد،
 * و«تصفير» يبدأ الشهر الجديد من صفر. وفي الحالتين يُقفل الشهر فلا يُعدَّل.
 */
export function decisionOutcome(
  netAmount: number,
  decision: MonthDecision,
): DecisionOutcome {
  const net = round2(Number(netAmount) || 0);
  if (decision === "carry_forward") {
    return { status: "carried_forward", carriedAmount: net, nextOpening: net };
  }
  return { status: "reset", carriedAmount: 0, nextOpening: 0 };
}

/* ── مساعدات الشهر ──────────────────────────────────────────────── */

function pad2(value: number): string {
  return value < 10 ? "0" + String(value) : String(value);
}

/** هل السنة والشهر ضمن المدى المعقول؟ */
export function isValidPeriod(year: number, month: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    year >= 2000 &&
    year <= 2200 &&
    month >= 1 &&
    month <= 12
  );
}

/** مفتاح الشهر بصيغة YYYY-MM. */
export function monthKeyOf(year: number, month: number): string {
  return String(year) + "-" + pad2(month);
}

/** يقرأ YYYY-MM ويعيد السنة والشهر، أو null إن كان المفتاح غير صالح. */
export function parseMonthKey(
  value: unknown,
): { year: number; month: number } | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(text)) return null;
  const year = Number.parseInt(text.slice(0, 4), 10);
  const month = Number.parseInt(text.slice(5, 7), 10);
  return isValidPeriod(year, month) ? { year, month } : null;
}

/** أول وآخر يوم في الشهر بصيغة YYYY-MM-DD. */
export function monthBounds(
  year: number,
  month: number,
): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = String(year) + "-" + pad2(month) + "-";
  return { from: prefix + "01", to: prefix + pad2(lastDay) };
}

export function previousMonth(
  year: number,
  month: number,
): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function nextMonth(
  year: number,
  month: number,
): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** هل تاريخ (YYYY-MM-DD) يقع داخل هذا الشهر؟ */
export function isDateInMonth(
  isoDate: string,
  year: number,
  month: number,
): boolean {
  return String(isoDate).slice(0, 7) === monthKeyOf(year, month);
}
