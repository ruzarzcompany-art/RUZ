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
  providerSettlements,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  PERMISSIONS,
  accessRulesByEmployee,
  buildAccessProfile,
  hasAnyPermission,
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
  nextMonth,
  parseMonthKey,
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

/** الرصيد النقدي الشهري — يُعرض طوال الشهر لا في نهايته فقط. */
financeRouter.get(
  "/finance/monthly-balance",
  requireAuth,
  requireAnyPermission(
    PERMISSIONS.cashMonthlyBalanceView,
    PERMISSIONS.monthlySummaryView,
    PERMISSIONS.cashExpensesRead,
  ),
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
 * كل جهة مجمّعة على الشهر كله من التقفيلات اليومية، مع تسوية الشهر إن وُجدت.
 */
financeRouter.get(
  "/finance/settlements/monthly",
  requireAuth,
  requirePermission(PERMISSIONS.settlementsRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
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

    const { from, to } = monthBounds(period.year, period.month);
    const monthKey = monthKeyOf(period.year, period.month);
    const sales = await monthlyProviderSales(branchId, from, to, providerType);

    // تسوية واحدة لكل جهة في الشهر — مفتاحها (الفرع + النوع + الاسم + المدة)
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

    const names = new Set<string>([
      ...sales.keys(),
      ...settlementRows.map((row) => row.providerName),
    ]);

    const providers = [...names].map((providerName) => {
      const monthlySales = round2(sales.get(providerName) ?? 0);
      const own = settlementRows.filter(
        (row) => row.providerName === providerName,
      );
      const current = own[0] ?? null;
      const confirmed = current?.status === "confirmed";

      return {
        providerName,
        providerType,
        /** مبيعات الشهر كاملة كما تجمّعت من التقفيلات اليومية */
        monthlySales,
        settledSales: sumBy(own, (row) => row.salesAmount),
        unsettledSales: unsettledSales(
          monthlySales,
          sumBy(own, (row) => row.salesAmount),
        ),
        settlementId: current?.id ?? null,
        status: current?.status ?? "open",
        receivedAmount: current ? round2(Number(current.receivedAmount) || 0) : 0,
        commissionAmount: confirmed
          ? round2(Number(current.commissionAmount) || 0)
          : 0,
        commissionRate: confirmed ? Number(current.commissionRate) || 0 : 0,
        vatRate: current ? Number(current.vatRate) || 0 : 0,
        vatAmount: confirmed ? round2(Number(current.vatAmount) || 0) : 0,
        reference: current?.reference ?? "",
        confirmedByName: current?.confirmedByName ?? "",
        confirmedAt: current?.confirmedAt ?? null,
      };
    });

    providers.sort((a, b) => b.monthlySales - a.monthlySales);

    const confirmedRows = providers.filter((item) => item.status === "confirmed");
    const confirmedSales = sumBy(confirmedRows, (item) => item.monthlySales);
    const confirmedCommission = sumBy(
      confirmedRows,
      (item) => item.commissionAmount,
    );

    res.json({
      ok: true,
      branchId,
      providerType,
      month: monthKey,
      from,
      to,
      providers,
      totals: {
        monthlySales: sumBy(providers, (item) => item.monthlySales),
        receivedAmount: sumBy(confirmedRows, (item) => item.receivedAmount),
        commissionAmount: confirmedCommission,
        /** النسبة على المجمَّع المؤكَّد: العمولة ÷ المبيعات × 100 */
        commissionRate: commissionRateOf(confirmedCommission, confirmedSales),
        vatAmount: sumBy(confirmedRows, (item) => item.vatAmount),
        pending: providers.filter((item) => item.status === "pending").length,
        confirmed: confirmedRows.length,
      },
      defaults:
        providerType === "network" ? DEFAULT_NETWORK_LINES : DEFAULT_DELIVERY_APPS,
      today,
    });
  },
);

/**
 * تسجيل أو تحديث تسوية **شهرية** لجهة واحدة.
 *
 * المبيعات لا تأتي من المتصفح إطلاقاً: الخادم يجمعها من تقفيلات الشهر نفسه،
 * فيستحيل أن تختلف عن واقع التقفيلات أو أن تُدخل يدوياً. وعند وصول الحوالة
 * إلى البنك يُدخل المحاسب المستلم مع `confirm` فيحسب الخادم:
 * العمولة = المبيعات المجمّعة − المستلم، والنسبة = العمولة ÷ المبيعات × 100.
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
    if (salesAmount <= 0) {
      res.status(400).json({
        ok: false,
        error:
          "لا توجد مبيعات مجمّعة لـ" +
          providerName +
          " في شهر " +
          monthKey +
          " — التسوية تقع على المجمَّع الشهري من التقفيلات.",
      });
      return;
    }

    const received = moneyOrError(body.receivedAmount);
    if (typeof received === "string") {
      res.status(400).json({ ok: false, error: received });
      return;
    }

    const vatRateRaw = asNumber(body.vatRate);
    const vatRate =
      vatRateRaw === null || vatRateRaw < 0 || vatRateRaw > 100 ? 0 : vatRateRaw;
    const vatIncluded =
      body.vatIncluded === undefined ? true : body.vatIncluded !== false;

    // التأكيد إجراء موافقة ببنده المستقل، فلا يكفي «تسجيل تسوية»
    const confirm = body.confirm === true;
    if (
      confirm &&
      !(await hasAnyPermission(req, [PERMISSIONS.settlementsConfirm]))
    ) {
      res
        .status(403)
        .json({ ok: false, error: "لا تملك صلاحية «تأكيد سداد التسوية»" });
      return;
    }

    const figures = settlementFigures({
      salesAmount,
      receivedAmount: received,
      vatRate,
      vatIncluded,
    });

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

    const now = new Date();
    const payload = {
      branchId,
      providerType,
      providerName,
      periodFrom: from,
      periodTo: to,
      salesAmount: figures.salesAmount,
      receivedAmount: figures.receivedAmount,
      commissionAmount: figures.commissionAmount,
      commissionRate: figures.commissionRate,
      vatRate: figures.vatRate,
      vatAmount: figures.vatAmount,
      vatIncluded: figures.vatIncluded,
      commissionBeforeVat: figures.commissionBeforeVat,
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
        String(figures.salesAmount) +
        "، مستلم " +
        String(figures.receivedAmount) +
        "، عمولة " +
        String(figures.commissionAmount) +
        " بنسبة " +
        String(figures.commissionRate) +
        "%",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      settlement: saved,
      figures,
      month: monthKey,
      message: confirm
        ? "تم تأكيد التسوية الشهرية — العمولة " +
          String(figures.commissionAmount) +
          " بنسبة " +
          String(figures.commissionRate) +
          "%"
        : "حُفظت التسوية الشهرية بانتظار وصول الحوالة",
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

/** تعديل تسوية لم تُؤكَّد بعد. المؤكَّدة لا تُعدَّل — تُحذف وتُعاد إن لزم. */
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
    if (await blockedByMonthLock(before.branchId, before.periodFrom, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = readSettlementBody(body);

    const salesAmount =
      typeof input.salesAmount === "string" ? before.salesAmount : input.salesAmount;
    const receivedAmount =
      body.receivedAmount === undefined || typeof input.receivedAmount === "string"
        ? before.receivedAmount
        : input.receivedAmount;

    const figures = settlementFigures({
      salesAmount,
      receivedAmount,
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
        salesAmount: figures.salesAmount,
        receivedAmount: figures.receivedAmount,
        commissionAmount: figures.commissionAmount,
        commissionRate: figures.commissionRate,
        vatRate: figures.vatRate,
        vatAmount: figures.vatAmount,
        vatIncluded: figures.vatIncluded,
        commissionBeforeVat: figures.commissionBeforeVat,
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

    res.json({ ok: true, settlement: updated, message: "تم تعديل التسوية" });
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
    if (await blockedByMonthLock(before.branchId, before.periodFrom, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const received = moneyOrError(body.receivedAmount);
    if (typeof received === "string") {
      res.status(400).json({ ok: false, error: received });
      return;
    }

    const vatRateRaw = asNumber(body.vatRate);
    const vatRate =
      vatRateRaw === null || vatRateRaw < 0 || vatRateRaw > 100
        ? before.vatRate
        : vatRateRaw;

    const figures = settlementFigures({
      salesAmount: before.salesAmount,
      receivedAmount: received,
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
      message: "تم تأكيد السداد واحتساب العمولة والضريبة",
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
      can: {
        /** خانة «المتبقي النقدي في درج الكاشير» — بند مستقل في الصلاحيات */
        viewRemaining: await hasAnyPermission(req, [
          PERMISSIONS.cashRemainingView,
        ]),
        /** «الرصيد النقدي الشهري» داخل صفحة التقفيل — بند مستقل */
        viewMonthlyBalance: await hasAnyPermission(req, [
          PERMISSIONS.cashMonthlyBalanceView,
        ]),
        readExpenses: await hasAnyPermission(req, [PERMISSIONS.cashExpensesRead]),
        writeExpenses: await hasAnyPermission(req, [PERMISSIONS.cashExpensesWrite]),
        readSettlements: await hasAnyPermission(req, [PERMISSIONS.settlementsRead]),
        manageSettlements: await hasAnyPermission(req, [
          PERMISSIONS.settlementsManage,
        ]),
        confirmSettlements: await hasAnyPermission(req, [
          PERMISSIONS.settlementsConfirm,
        ]),
        viewMonthlySummary: await hasAnyPermission(req, [
          PERMISSIONS.monthlySummaryView,
        ]),
        carryForward: await hasAnyPermission(req, [PERMISSIONS.monthlyCarryForward]),
        resetBalance: await hasAnyPermission(req, [PERMISSIONS.monthlyReset]),
      },
    });
  },
);
