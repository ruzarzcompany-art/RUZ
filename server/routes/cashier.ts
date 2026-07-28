import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { branches, cashierClosings, employees } from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, hasAnyPermission, requirePermission } from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { asDateOnly, asEnum, asId, asNumber, asString, round2 } from "../validate.js";

export const cashierRouter = Router();

const SHIFTS = ["morning", "evening", "full"] as const;
const STATUSES = ["submitted", "reviewed", "disputed"] as const;

/** الحقول المالية التي يرفعها الكاشير. */
const MONEY_FIELDS = [
  "openingFloat",
  "totalSales",
  "cashSales",
  "cardSales",
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

/* ── رفع التقفيل اليومي (الكاشير بنفسه) ────────────────────────── */

cashierRouter.post(
  "/cashier/closings",
  requireAuth,
  requirePermission(PERMISSIONS.cashierSubmit),
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

    const money = readMoney(body);
    if ("error" in money) {
      res.status(400).json({ ok: false, error: money.error });
      return;
    }

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

    await recordAudit({
      actorEmployeeId: actor.id,
      action: existing ? "cashier.closing.update" : "cashier.closing.create",
      entityType: "cashier_closings",
      entityId: saved?.id ?? null,
      after: saved,
      reason: notes,
      ipAddress: clientIp(req),
    });

    res.status(existing ? 200 : 201).json({
      ok: true,
      closing: saved,
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

    res.json({ ok: true, closings, summary, scope: canReadAll ? "all" : "own" });
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

    res.json({
      ok: true,
      businessDate,
      timezone,
      branchId: actor.branchId ?? null,
      closings: rows,
      shifts: SHIFTS,
    });
  },
);

/* ── مراجعة التقفيل ────────────────────────────────────────────── */

cashierRouter.patch(
  "/cashier/closings/:id/review",
  requireAuth,
  requirePermission(PERMISSIONS.cashierReview),
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
    const money = readMoney(body, before as unknown as Record<string, number>);
    if ("error" in money) {
      res.status(400).json({ ok: false, error: money.error });
      return;
    }

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

    res.json({ ok: true, closing: updated });
  },
);

cashierRouter.delete(
  "/cashier/closings/:id",
  requireAuth,
  requirePermission(PERMISSIONS.cashierReview),
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
