import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  cashierClosingLines,
  cashExpenses,
  cashierClosings,
  employees,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  PERMISSIONS,
  hasAnyPermission,
  requireModuleDelete,
  requireModuleLevel,
  requirePermission,
} from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { monthLockFor, monthLockMessage } from "../monthLock.js";
import { remainingCash } from "../finance.js";
import { asDateOnly, asEnum, asId, asNumber, asString, round2 } from "../validate.js";

export const cashierRouter = Router();

const SHIFTS = ["morning", "evening", "full"] as const;

/**
 * مصاريف التقفيلة، والمتبقي النقدي = المبيعات النقدية − تلك المصاريف.
 *
 * بعد نقل المصاريف إلى صفحة التقفيل صار مصدرها الأول أسطر المصروف داخل
 * التقفيلة نفسها (`cashier_closing_lines` بتصنيف `expense`)، ويُضاف إليها
 * ما بقي في السجل المنفصل القديم (`cash_expenses`) لنفس اليوم حتى لا تضيع
 * فواتير سُجّلت قبل النقل.
 *
 * الحساب **قراءةً وقت العرض** لا تخزيناً: مهما تكرّر فتح الشاشة لا يُخصم
 * المصروف مرتين. والتوزيع على الورديات: التقفيلة الوحيدة في يومها تأخذ
 * مصاريف اليوم القديمة كلها، وإن تعدّدت التقفيلات أخذت كل واحدة مصاريف
 * ورديتها وحدها.
 */
async function attachRemainingCash(
  closings: Array<Record<string, unknown>>,
): Promise<{ expenses: number; remainingCash: number }> {
  if (closings.length === 0) return { expenses: 0, remainingCash: 0 };

  const db = getDb();
  const branchIds = [...new Set(closings.map((item) => Number(item.branchId)))];
  const dates = [...new Set(closings.map((item) => String(item.businessDate)))];

  const legacyRows = await db
    .select({
      branchId: cashExpenses.branchId,
      businessDate: cashExpenses.businessDate,
      shift: cashExpenses.shift,
      amount: cashExpenses.amount,
    })
    .from(cashExpenses)
    .where(
      and(
        inArray(cashExpenses.branchId, branchIds),
        inArray(cashExpenses.businessDate, dates),
      ),
    );

  let totalExpenses = 0;
  let totalCash = 0;

  for (const closing of closings) {
    const branchId = Number(closing.branchId);
    const businessDate = String(closing.businessDate);
    const shift = String(closing.shift);

    const sameDayClosings = closings.filter(
      (item) =>
        Number(item.branchId) === branchId &&
        String(item.businessDate) === businessDate,
    ).length;

    const legacy = legacyRows.filter(
      (row) =>
        row.branchId === branchId &&
        row.businessDate === businessDate &&
        (sameDayClosings === 1 || row.shift === shift),
    );

    // أسطر المصروف المكتوبة في صفحة التقفيل نفسها — هي الأصل بعد النقل
    const ownLines = ((closing.lines as ParsedLine[] | undefined) ?? []).filter(
      (line) => line.category === "expense",
    );

    const expenses = round2(
      ownLines.reduce((total, line) => total + (Number(line.amount) || 0), 0) +
        legacy.reduce((total, row) => total + (Number(row.amount) || 0), 0),
    );
    const cashSales = Number(closing.cashSales) || 0;

    closing.registerExpenses = expenses;
    closing.remainingCash = remainingCash(cashSales, expenses);
    closing.registerExpenseCount = ownLines.length + legacy.length;

    totalExpenses = round2(totalExpenses + expenses);
    totalCash = round2(totalCash + cashSales);
  }

  return {
    expenses: totalExpenses,
    remainingCash: remainingCash(totalCash, totalExpenses),
  };
}

const STATUSES = ["submitted", "reviewed", "disputed"] as const;

/**
 * تصنيفات بنود التقفيل القابلة للإضافة والتعديل والحذف:
 * `network` بنود الشبكات، `delivery_app` تطبيقات التوصيل، و`expense` سطر
 * مصروف أو شراء نقدي يُكتب **داخل صفحة التقفيل نفسها** بحقلين لا ثالث لهما:
 * البيان والمبلغ — لا رقم فاتورة ولا كمية ولا سعر وحدة.
 */
export const LINE_CATEGORIES = ["network", "delivery_app", "expense"] as const;
type LineCategory = (typeof LINE_CATEGORIES)[number];

/** أقصى عدد بنود لكل تصنيف في تقفيل واحد. */
const MAX_LINES_PER_CATEGORY = 40;

/** تطبيقات التواصل والتوصيل المُضافة مسبقاً في شاشة التقفيل. */
export const DEFAULT_DELIVERY_APPS = [
  "هنجرستيشن",
  "كيتا",
  "جاهز",
  "ذاشيف",
] as const;

/** بنود الشبكة المقترحة عند أول تقفيل. */
export const DEFAULT_NETWORK_LINES = ["شبكة مدى", "شبكة فيزا / ماستر"] as const;

/** الحقول المالية التي يرفعها الكاشير. */
const MONEY_FIELDS = [
  "openingFloat",
  "totalSales",
  "cashSales",
  "cardSales",
  "foodicsSales",
  "transferSales",
  "deliverySales",
  "otherSales",
  "discounts",
  "refunds",
  "expenses",
  "countedCash",
] as const;

type MoneyField = (typeof MONEY_FIELDS)[number];

/**
 * النقد المتوقّع في الدرج = عهدة البداية + المبيعات النقدية − المصروفات النقدية
 * − المرتجعات. والفارق = النقد المعدود − المتوقّع (سالب = عجز).
 */
function computeTotals(values: Record<MoneyField, number>): {
  expectedCash: number;
  difference: number;
} {
  const expectedCash = round2(
    values.openingFloat + values.cashSales - values.expenses - values.refunds,
  );
  return { expectedCash, difference: round2(values.countedCash - expectedCash) };
}

/** قراءة الحقول المالية من الجسم المُرسل مع التحقّق. */
function readMoney(
  body: Record<string, unknown>,
  fallback?: Record<string, number>,
): { values: Record<MoneyField, number> } | { error: string } {
  const values = {} as Record<MoneyField, number>;

  for (const field of MONEY_FIELDS) {
    const raw = body[field];
    if (raw === undefined && fallback) {
      values[field] = Number(fallback[field] ?? 0);
      continue;
    }
    const num = asNumber(raw);
    if (num === null) {
      values[field] = 0;
      continue;
    }
    if (num < 0) return { error: "لا تُقبل مبالغ سالبة في التقفيل" };
    if (num > 10_000_000) return { error: "المبلغ المُدخل كبير بشكل غير منطقي" };
    values[field] = round2(num);
  }

  return { values };
}

/** فرع الموظف ومنطقته الزمنية — لحساب تاريخ العمل الافتراضي. */
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

/* ── بنود الشبكة وتطبيقات التواصل ──────────────────────────────── */

interface ParsedLine {
  category: LineCategory;
  label: string;
  amount: number;
  reference: string;
  sortOrder: number;
}

export type { ParsedLine as CashierClosingLine };

/**
 * يقرأ بنود التقفيل المُرسلة من الشاشة. الإرجاع `null` يعني أن الطلب لم يذكر
 * البنود إطلاقاً (عميل قديم) فتُترك كما هي، بينما المصفوفة الفارغة تعني
 * «احذف كل البنود».
 */
function readLines(
  body: Record<string, unknown>,
): { lines: ParsedLine[] } | { error: string } | null {
  const raw = body.lines;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return { error: "بنود التقفيل يجب أن تكون قائمة" };

  const lines: ParsedLine[] = [];
  const counts: Record<LineCategory, number> = {
    network: 0,
    delivery_app: 0,
    expense: 0,
  };

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;

    const category = asEnum(item.category, LINE_CATEGORIES);
    if (category === null) return { error: "تصنيف البند غير معروف" };

    const label = asString(item.label, 120);
    if (!label) {
      return {
        error:
          category === "expense"
            ? "لكل سطر مصروف بيانٌ مطلوب (غاز، دجاج، لبن ...)"
            : "لكل بند اسم مطلوب (اسم الشبكة أو التطبيق)",
      };
    }

    const amountRaw = asNumber(item.amount);
    const amount = amountRaw === null ? 0 : amountRaw;
    if (amount < 0) return { error: "لا تُقبل مبالغ سالبة في بنود التقفيل" };
    if (amount > 10_000_000) return { error: "المبلغ المُدخل كبير بشكل غير منطقي" };

    counts[category] += 1;
    if (counts[category] > MAX_LINES_PER_CATEGORY) {
      return { error: `لا يمكن إضافة أكثر من ${MAX_LINES_PER_CATEGORY} بنداً في التصنيف نفسه` };
    }

    lines.push({
      category,
      label,
      amount: round2(amount),
      // سطر المصروف بحقلين فقط، فلا مرجع له أصلاً
      reference:
        category === "expense" ? "" : (asString(item.reference, 120) ?? ""),
      sortOrder: lines.length,
    });
  }

  return { lines };
}

/** مجموع بنود تصنيف معيّن. */
function sumLines(lines: ParsedLine[], category: LineCategory): number {
  return round2(
    lines
      .filter((line) => line.category === category)
      .reduce((total, line) => total + line.amount, 0),
  );
}

/** يستبدل بنود تقفيل بالبنود المُرسلة (إضافة/تعديل/حذف في عملية واحدة). */
async function replaceLines(closingId: number, lines: ParsedLine[]): Promise<void> {
  const db = getDb();
  await db.delete(cashierClosingLines).where(eq(cashierClosingLines.closingId, closingId));
  if (lines.length === 0) return;
  await db
    .insert(cashierClosingLines)
    .values(lines.map((line) => ({ closingId, ...line })));
}

/** بنود مجموعة تقفيلات مرتّبة، مفتاحها معرّف التقفيل. */
export async function loadLines(closingIds: number[]): Promise<Map<number, ParsedLine[]>> {
  const map = new Map<number, ParsedLine[]>();
  if (closingIds.length === 0) return map;

  const db = getDb();
  const rows = await db
    .select()
    .from(cashierClosingLines)
    .where(inArray(cashierClosingLines.closingId, closingIds))
    .orderBy(asc(cashierClosingLines.sortOrder), asc(cashierClosingLines.id));

  for (const row of rows) {
    const list = map.get(row.closingId) ?? [];
    list.push({
      category: row.category as LineCategory,
      label: row.label,
      amount: row.amount,
      reference: row.reference,
      sortOrder: row.sortOrder,
    });
    map.set(row.closingId, list);
  }

  return map;
}

/**
 * الإجماليات المشتقّة من البنود عند إرسالها:
 * `cardSales` = مجموع بنود الشبكة + شبكة foodics،
 * `deliverySales` = مجموع بنود تطبيقات التوصيل،
 * و`expenses` = مجموع أسطر المصاريف والمشتريات النقدية المكتوبة في صفحة
 * التقفيل نفسها — فكل مصروف يُخصم تلقائياً من نقدي التقفيلة، ولا يُدخل
 * إجمالي المصروفات يدوياً ولا يأتي من صفحة منفصلة.
 */
function applyLineTotals(
  values: Record<MoneyField, number>,
  lines: ParsedLine[],
): void {
  values.cardSales = round2(sumLines(lines, "network") + values.foodicsSales);
  values.deliverySales = sumLines(lines, "delivery_app");
  values.expenses = sumLines(lines, "expense");
}

/* ── رفع التقفيل اليومي (الكاشير بنفسه) ────────────────────────── */

cashierRouter.post(
  "/cashier/closings",
  requireAuth,
  requirePermission(PERMISSIONS.cashierSubmit),
  requireModuleLevel("cashier_self", 1),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // الكاشير يرفع تقفيله لنفسه؛ ولمن يملك المراجعة أن يرفع بالنيابة
    const canReview = await hasAnyPermission(req, [PERMISSIONS.cashierReview]);
    const requestedEmployeeId = asId(body.employeeId);
    const employeeId =
      canReview && requestedEmployeeId !== null ? requestedEmployeeId : actor.id;

    const [target] = await db
      .select({ id: employees.id, branchId: employees.branchId, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!target) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const requestedBranchId = asId(body.branchId);
    const branchId =
      canReview && requestedBranchId !== null ? requestedBranchId : target.branchId;

    if (branchId === null) {
      res.status(400).json({ ok: false, error: "لا يوجد فرع مرتبط بالحساب. راجع الموارد البشرية." });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const businessDate =
      asDateOnly(body.businessDate) ?? isoDateInZone(new Date(), timezone);
    const shift = asEnum(body.shift, SHIFTS) ?? "full";
    const invoiceCountRaw = asNumber(body.invoiceCount);
    const invoiceCount =
      invoiceCountRaw === null || invoiceCountRaw < 0 ? 0 : Math.round(invoiceCountRaw);

    // لا يُسمح برفع تقفيل لتاريخ مستقبلي بتوقيت الفرع
    if (businessDate > isoDateInZone(new Date(), timezone)) {
      res.status(400).json({ ok: false, error: "لا يمكن رفع تقفيل لتاريخ لم يأتِ بعد" });
      return;
    }

    // شهر أُقفل ملخّصه لا يُعدَّل عليه إطلاقاً — والشهور بلا صفّ إقفال مفتوحة
    const monthLock = await monthLockFor(branchId, businessDate);
    if (monthLock) {
      res.status(409).json({ ok: false, error: monthLockMessage(monthLock) });
      return;
    }

    const money = readMoney(body);
    if ("error" in money) {
      res.status(400).json({ ok: false, error: money.error });
      return;
    }

    const parsedLines = readLines(body);
    if (parsedLines && "error" in parsedLines) {
      res.status(400).json({ ok: false, error: parsedLines.error });
      return;
    }
    if (parsedLines) applyLineTotals(money.values, parsedLines.lines);

    const totals = computeTotals(money.values);
    const notes = asString(body.notes, 1000) ?? "";

    const [existing] = await db
      .select({ id: cashierClosings.id, status: cashierClosings.status })
      .from(cashierClosings)
      .where(
        and(
          eq(cashierClosings.branchId, branchId),
          eq(cashierClosings.employeeId, employeeId),
          eq(cashierClosings.businessDate, businessDate),
          eq(cashierClosings.shift, shift),
        ),
      )
      .limit(1);

    // تقفيل مُراجَع لا يُعدّله الكاشير — يحتاج صلاحية المراجعة
    if (existing && existing.status === "reviewed" && !canReview) {
      res.status(409).json({
        ok: false,
        error: "تقفيل هذا اليوم تمّت مراجعته. راجع مدير الفرع لأي تعديل.",
      });
      return;
    }

    const payload = {
      branchId,
      employeeId,
      businessDate,
      shift,
      ...money.values,
      ...totals,
      invoiceCount,
      notes,
      status: existing ? existing.status : "submitted",
      updatedAt: new Date(),
    };

    const [saved] = existing
      ? await db
          .update(cashierClosings)
          .set(payload)
          .where(eq(cashierClosings.id, existing.id))
          .returning()
      : await db.insert(cashierClosings).values(payload).returning();

    if (parsedLines && saved) await replaceLines(saved.id, parsedLines.lines);

    await recordAudit({
      actorEmployeeId: actor.id,
      action: existing ? "cashier.closing.update" : "cashier.closing.create",
      entityType: "cashier_closings",
      entityId: saved?.id ?? null,
      after: parsedLines ? { ...saved, lines: parsedLines.lines } : saved,
      reason: notes,
      ipAddress: clientIp(req),
    });

    res.status(existing ? 200 : 201).json({
      ok: true,
      closing: saved ? { ...saved, lines: parsedLines?.lines ?? [] } : saved,
      message: existing ? "تم تحديث تقفيل اليوم" : "تم رفع التقفيل بنجاح",
    });
  },
);

/* ── عرض التقفيلات ─────────────────────────────────────────────── */

cashierRouter.get(
  "/cashier/closings",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;

    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.cashierReadAll,
      PERMISSIONS.cashierReview,
      PERMISSIONS.reportsView,
    ]);
    const canSubmit = await hasAnyPermission(req, [PERMISSIONS.cashierSubmit]);

    if (!canReadAll && !canSubmit) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض تقفيلات الكاشير" });
      return;
    }

    const from = asDateOnly(req.query.from);
    const to = asDateOnly(req.query.to);
    const branchId = asId(req.query.branchId);
    const employeeFilter = asId(req.query.employeeId);
    const status = asEnum(req.query.status, STATUSES);

    const conditions = [
      canReadAll
        ? employeeFilter === null
          ? undefined
          : eq(cashierClosings.employeeId, employeeFilter)
        : eq(cashierClosings.employeeId, actor.id),
      branchId === null ? undefined : eq(cashierClosings.branchId, branchId),
      from === null ? undefined : gte(cashierClosings.businessDate, from),
      to === null ? undefined : lte(cashierClosings.businessDate, to),
      status === null ? undefined : eq(cashierClosings.status, status),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        closing: cashierClosings,
        employeeName: employees.fullName,
        employeeCode: employees.employeeCode,
        branchName: branches.name,
      })
      .from(cashierClosings)
      .leftJoin(employees, eq(cashierClosings.employeeId, employees.id))
      .leftJoin(branches, eq(cashierClosings.branchId, branches.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(cashierClosings.businessDate), asc(cashierClosings.employeeId))
      .limit(500);

    const closings = rows.map((row) => ({
      ...row.closing,
      employeeName: row.employeeName,
      employeeCode: row.employeeCode,
      branchName: row.branchName,
    }));

    const linesByClosing = await loadLines(closings.map((item) => item.id));
    for (const closing of closings) {
      (closing as Record<string, unknown>).lines = linesByClosing.get(closing.id) ?? [];
    }

    // المتبقي النقدي لكل تقفيلة: المبيعات النقدية − مصاريف التقفيلة
    const cashPosition = await attachRemainingCash(
      closings as unknown as Array<Record<string, unknown>>,
    );

    // «المتبقي النقدي في درج الكاشير» بندٌ مستقل في إدارة الصلاحيات:
    // من لا يملكه لا يصله الرقم من الخادم أصلاً، لا أن يُخفى في المتصفح فقط.
    const canSeeRemaining = await hasAnyPermission(req, [
      PERMISSIONS.cashRemainingView,
    ]);
    if (!canSeeRemaining) {
      for (const closing of closings) {
        delete (closing as Record<string, unknown>).remainingCash;
      }
    }

    const summary = closings.reduce(
      (acc, item) => ({
        count: acc.count + 1,
        totalSales: round2(acc.totalSales + item.totalSales),
        cashSales: round2(acc.cashSales + item.cashSales),
        cardSales: round2(acc.cardSales + item.cardSales),
        difference: round2(acc.difference + item.difference),
      }),
      { count: 0, totalSales: 0, cashSales: 0, cardSales: 0, difference: 0 },
    );

    res.json({
      ok: true,
      closings,
      summary: {
        ...summary,
        /** مجموع مصاريف التقفيلات: أسطر المصروف + ما بقي من السجل القديم */
        registerExpenses: cashPosition.expenses,
        /** المتبقي النقدي — لا يُرسل إلا لمن يملك بنده المستقل */
        remainingCash: canSeeRemaining ? cashPosition.remainingCash : null,
      },
      canViewRemaining: canSeeRemaining,
      scope: canReadAll ? "all" : "own",
    });
  },
);

/** تقفيل اليوم الحالي للموظف — تعبئة الشاشة تلقائياً. */
cashierRouter.get(
  "/cashier/closings/today",
  requireAuth,
  requirePermission(PERMISSIONS.cashierSubmit),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const timezone = await branchTimezone(actor.branchId ?? null);
    const businessDate = isoDateInZone(new Date(), timezone);

    const rows = await db
      .select()
      .from(cashierClosings)
      .where(
        and(
          eq(cashierClosings.employeeId, actor.id),
          eq(cashierClosings.businessDate, businessDate),
        ),
      );

    const linesByClosing = await loadLines(rows.map((row) => row.id));

    const todayClosings = rows.map((row) => ({
      ...row,
      lines: linesByClosing.get(row.id) ?? [],
    })) as unknown as Array<Record<string, unknown>>;
    const todayPosition = await attachRemainingCash(todayClosings);

    // بندان مستقلان في إدارة الصلاحيات: خانة المتبقي، والرصيد الشهري
    const canSeeRemaining = await hasAnyPermission(req, [
      PERMISSIONS.cashRemainingView,
    ]);
    const canSeeMonthlyBalance = await hasAnyPermission(req, [
      PERMISSIONS.cashMonthlyBalanceView,
    ]);
    if (!canSeeRemaining) {
      for (const closing of todayClosings) delete closing.remainingCash;
    }

    res.json({
      ok: true,
      businessDate,
      timezone,
      branchId: actor.branchId ?? null,
      closings: todayClosings,
      cashPosition: canSeeRemaining
        ? todayPosition
        : { expenses: todayPosition.expenses, remainingCash: null },
      can: {
        viewRemaining: canSeeRemaining,
        viewMonthlyBalance: canSeeMonthlyBalance,
      },
      shifts: SHIFTS,
      lineCategories: LINE_CATEGORIES,
      defaultNetworkLines: DEFAULT_NETWORK_LINES,
      defaultDeliveryApps: DEFAULT_DELIVERY_APPS,
    });
  },
);

/* ── مراجعة التقفيل ────────────────────────────────────────────── */

cashierRouter.patch(
  "/cashier/closings/:id/review",
  requireAuth,
  requirePermission(PERMISSIONS.cashierReview),
  requireModuleLevel("cashier_closing", 4),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التقفيل غير صالح" });
      return;
    }

    const status = asEnum(req.body?.status, ["reviewed", "disputed"] as const);
    if (status === null) {
      res.status(400).json({ ok: false, error: "حالة المراجعة يجب أن تكون reviewed أو disputed" });
      return;
    }

    const [before] = await db
      .select()
      .from(cashierClosings)
      .where(eq(cashierClosings.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التقفيل غير موجود" });
      return;
    }

    const reviewLock = await monthLockFor(before.branchId, before.businessDate);
    if (reviewLock) {
      res.status(409).json({ ok: false, error: monthLockMessage(reviewLock) });
      return;
    }

    const reviewNote = asString(req.body?.reviewNote, 1000) ?? "";
    const [updated] = await db
      .update(cashierClosings)
      .set({
        status,
        reviewNote,
        reviewedByEmployeeId: actor.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(cashierClosings.id, id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "cashier.closing.review",
      entityType: "cashier_closings",
      entityId: id,
      before,
      after: updated,
      reason: reviewNote,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, closing: updated });
  },
);

/** تعديل تقفيل مرفوع (لمن يملك المراجعة) — يُسجَّل في التدقيق. */
cashierRouter.patch(
  "/cashier/closings/:id",
  requireAuth,
  requirePermission(PERMISSIONS.cashierReview),
  requireModuleLevel("cashier_closing", 3),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التقفيل غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(cashierClosings)
      .where(eq(cashierClosings.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التقفيل غير موجود" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const correctionLock = await monthLockFor(before.branchId, before.businessDate);
    if (correctionLock) {
      res.status(409).json({ ok: false, error: monthLockMessage(correctionLock) });
      return;
    }

    const money = readMoney(body, before as unknown as Record<string, number>);
    if ("error" in money) {
      res.status(400).json({ ok: false, error: money.error });
      return;
    }

    const parsedLines = readLines(body);
    if (parsedLines && "error" in parsedLines) {
      res.status(400).json({ ok: false, error: parsedLines.error });
      return;
    }
    if (parsedLines) applyLineTotals(money.values, parsedLines.lines);

    const totals = computeTotals(money.values);
    const invoiceCountRaw = asNumber(body.invoiceCount);

    const [updated] = await db
      .update(cashierClosings)
      .set({
        ...money.values,
        ...totals,
        invoiceCount:
          invoiceCountRaw === null || invoiceCountRaw < 0
            ? before.invoiceCount
            : Math.round(invoiceCountRaw),
        notes: asString(body.notes, 1000) ?? before.notes,
        updatedAt: new Date(),
      })
      .where(eq(cashierClosings.id, id))
      .returning();

    if (parsedLines) await replaceLines(id, parsedLines.lines);

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "cashier.closing.correct",
      entityType: "cashier_closings",
      entityId: id,
      before,
      after: updated,
      reason: asString(body.reason, 500) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      closing: updated
        ? { ...updated, lines: parsedLines?.lines ?? (await loadLines([id])).get(id) ?? [] }
        : updated,
    });
  },
);

cashierRouter.delete(
  "/cashier/closings/:id",
  requireAuth,
  requirePermission(PERMISSIONS.cashierReview),
  requireModuleDelete("cashier_closing"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف التقفيل غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(cashierClosings)
      .where(eq(cashierClosings.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "التقفيل غير موجود" });
      return;
    }

    const deleteLock = await monthLockFor(before.branchId, before.businessDate);
    if (deleteLock) {
      res.status(409).json({ ok: false, error: monthLockMessage(deleteLock) });
      return;
    }

    await db.delete(cashierClosings).where(eq(cashierClosings.id, id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "cashier.closing.delete",
      entityType: "cashier_closings",
      entityId: id,
      before,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف التقفيل" });
  },
);

/** ملخّص يومي لكل فرع — يُستخدم في لوحة المدير. */
cashierRouter.get(
  "/cashier/summary",
  requireAuth,
  requirePermission(PERMISSIONS.cashierReadAll),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const from = asDateOnly(req.query.from);
    const to = asDateOnly(req.query.to);
    const branchId = asId(req.query.branchId);

    const conditions = [
      branchId === null ? undefined : eq(cashierClosings.branchId, branchId),
      from === null ? undefined : gte(cashierClosings.businessDate, from),
      to === null ? undefined : lte(cashierClosings.businessDate, to),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        businessDate: cashierClosings.businessDate,
        branchId: cashierClosings.branchId,
        branchName: branches.name,
        totalSales: sql<number>`sum(${cashierClosings.totalSales})`,
        cashSales: sql<number>`sum(${cashierClosings.cashSales})`,
        cardSales: sql<number>`sum(${cashierClosings.cardSales})`,
        difference: sql<number>`sum(${cashierClosings.difference})`,
        closings: sql<number>`count(*)`,
      })
      .from(cashierClosings)
      .leftJoin(branches, eq(cashierClosings.branchId, branches.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .groupBy(cashierClosings.businessDate, cashierClosings.branchId, branches.name)
      .orderBy(desc(cashierClosings.businessDate))
      .limit(200);

    res.json({
      ok: true,
      days: rows.map((row) => ({
        ...row,
        totalSales: round2(Number(row.totalSales ?? 0)),
        cashSales: round2(Number(row.cashSales ?? 0)),
        cardSales: round2(Number(row.cardSales ?? 0)),
        difference: round2(Number(row.difference ?? 0)),
        closings: Number(row.closings ?? 0),
      })),
    });
  },
);
