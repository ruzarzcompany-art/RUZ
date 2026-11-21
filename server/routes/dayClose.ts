/**
 * مسارات «تقفيل اليوم» من فوديكس.
 *
 *   GET  /api/dayclose/mine                    للكاشير: الأيام المعلّقة بانتظار تأكيده + أرقام اليوم الجاري
 *   POST /api/dayclose/:id/confirm             تأكيد الكاشير للنقد المعدود ومصاريف الدرج
 *   GET  /api/dayclose?branchId=&from=&to=     للمالية: تقفيلات الأيام مع الفروقات والحالة
 *   POST /api/dayclose/refresh                 تحديث يوم من فوديكس الآن
 *   POST /api/dayclose/float                   عهدة الصندوق النقدية من تاريخ محدد
 *   POST /api/dayclose/rebuild                 إعادة بناء تقفيلات فترة من فواتير فوديكس المحفوظة
 */

import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { cashExpenses, cashierClosingLines, cashierClosings, employees } from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, hasAnyPermission, requireAnyPermission, requirePermission } from "../rbac.js";
import { asDateOnly, asId, asNumber, asString } from "../validate.js";
import {
  DAY_CLOSE_HOUR,
  OPEN_STATUSES,
  STATUS_LABELS,
  businessDateNow,
  confirmDayClose,
  currentFloat,
  rebuildDayCloses,
  setOpeningFloat,
  upsertDayClose,
} from "../dayClose.js";
import { foodicsDaySales } from "../foodics.js";
import { isoDateInZone } from "../time.js";
import { loadBranch } from "./surveillance.js";
import { clampFrom, financeStartDate, setFinanceStartDate } from "../financeStart.js";

export const dayCloseRouter = Router();

const canRead = [requireAuth, requireAnyPermission(PERMISSIONS.cashierReadAll, PERMISSIONS.cashierReview)];
const canManage = [requireAuth, requirePermission(PERMISSIONS.cashierReview)];

async function withLines(rows: Array<typeof cashierClosings.$inferSelect>) {
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const lines = ids.length
    ? await db.select().from(cashierClosingLines).where(inArray(cashierClosingLines.closingId, ids)).orderBy(asc(cashierClosingLines.sortOrder))
    : [];
  const empIds = [...new Set(rows.flatMap((r) => [r.employeeId, r.reviewedByEmployeeId]).filter((x): x is number => Boolean(x)))];
  const names = empIds.length
    ? await db.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, empIds))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((r) => {
    const own = lines.filter((l) => l.closingId === r.id);
    const network = own.filter((l) => l.category === "network");
    const delivery = own.filter((l) => l.category === "delivery_app");
    return {
      id: r.id,
      branchId: r.branchId,
      businessDate: r.businessDate,
      employeeId: r.employeeId,
      employeeName: nameOf.get(r.employeeId) ?? "",
      status: r.status,
      statusLabel: STATUS_LABELS[r.status] ?? r.status,
      awaitingCash: OPEN_STATUSES.includes(r.status),
      invoiceCount: r.invoiceCount,
      totalSales: r.totalSales,
      cashSales: r.cashSales,
      networkSales: r.cardSales,
      deliverySales: r.deliverySales,
      otherSales: r.otherSales,
      discounts: r.discounts,
      refunds: r.refunds,
      openingFloat: r.openingFloat,
      expenses: r.expenses,
      expectedCash: r.expectedCash,
      countedCash: OPEN_STATUSES.includes(r.status) ? null : r.countedCash,
      difference: OPEN_STATUSES.includes(r.status) ? null : r.difference,
      receivables: Math.round((r.cardSales + r.deliverySales) * 100) / 100,
      notes: r.notes,
      reviewNote: r.reviewNote,
      reviewedBy: r.reviewedByEmployeeId ? nameOf.get(r.reviewedByEmployeeId) ?? "" : "",
      updatedAt: r.updatedAt,
      network: network.map((l) => ({ label: l.label, amount: l.amount })),
      delivery: delivery.map((l) => ({ label: l.label, amount: l.amount })),
      expenseLines: own.filter((l) => l.category === "expense").map((l) => ({ label: l.label, amount: l.amount })),
    };
  });
}

/**
 * بنود مصاريف الدرج السابقة لهذا الفرع (الأكثر تكراراً أولاً) — تُعرض قائمةَ
 * اقتراحات عند إضافة مصروف حتى يُكتب البيان بنفس الاسم كل مرة ويسهل تجميعه
 * ومطابقته بالفواتير.
 */
async function expenseLabels(branchId: number): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ label: cashierClosingLines.label, uses: sql<number>`count(*)::int` })
    .from(cashierClosingLines)
    .innerJoin(cashierClosings, eq(cashierClosings.id, cashierClosingLines.closingId))
    .where(and(eq(cashierClosings.branchId, branchId), eq(cashierClosingLines.category, "expense")))
    .groupBy(cashierClosingLines.label)
    .orderBy(desc(sql`count(*)`), asc(cashierClosingLines.label))
    .limit(60);
  return rows.map((r) => r.label.trim()).filter(Boolean);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** وجهات الصرف الثابتة المقترحة دائماً في «صرف من النقد». */
const SPEND_PRESETS = ["إيجار المحل", "سكن العمال"];

/**
 * «النقد الموجود»: كل النقد الذي خرج من الدرج منذ بداية الحسابات، مطروحاً منه
 * ما صُرف من النقد (إيجار المحل، سكن العمال ...).
 *
 *   صافي النقد بدون الرجيع = مبيعات النقد − المرتجعات النقدية
 *   نقد اليوم الخارج من الدرج = المعدود − العهدة   (اليوم المؤكَّد)
 *                              = المتوقّع − العهدة  (اليوم المعلّق، تقديراً)
 *   النقد الموجود = مجموع نقد الأيام − المصروف من النقد
 *
 * المصروف من النقد يُحفظ في سجل المصاريف النقدية (cash_expenses) نفسه.
 */
async function cashBox(branchId: number, startDate: string | null, today: string) {
  const db = getDb();
  const from = startDate ?? "2000-01-01";
  const days = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branchId), gte(cashierClosings.businessDate, from), lte(cashierClosings.businessDate, today)));
  let cashSales = 0;
  let cashRefunds = 0;
  let drawerExpenses = 0;
  let difference = 0;
  let collected = 0;
  let pendingDays = 0;
  for (const d of days) {
    const open = OPEN_STATUSES.includes(d.status);
    cashSales += d.cashSales;
    drawerExpenses += d.expenses;
    // المتوقّع = العهدة + النقد − مصاريف الدرج − المرتجعات النقدية
    cashRefunds += Math.max(0, d.openingFloat + d.cashSales - d.expenses - d.expectedCash);
    if (open) {
      pendingDays += 1;
      collected += d.expectedCash - d.openingFloat;
    } else {
      difference += d.difference;
      collected += d.countedCash - d.openingFloat;
    }
  }
  const rows = await db
    .select({ e: cashExpenses, by: employees.fullName })
    .from(cashExpenses)
    .leftJoin(employees, eq(cashExpenses.createdByEmployeeId, employees.id))
    .where(and(eq(cashExpenses.branchId, branchId), gte(cashExpenses.businessDate, from), lte(cashExpenses.businessDate, today)))
    .orderBy(desc(cashExpenses.businessDate), desc(cashExpenses.id))
    .limit(500);
  const spent = rows.reduce((s, r) => s + (Number(r.e.amount) || 0), 0);
  const byLabel = new Map<string, number>();
  for (const r of rows) byLabel.set(r.e.description, (byLabel.get(r.e.description) ?? 0) + (Number(r.e.amount) || 0));
  return {
    from: startDate,
    to: today,
    days: days.length,
    pendingDays,
    cashSales: r2(cashSales),
    cashRefunds: r2(cashRefunds),
    netCash: r2(cashSales - cashRefunds),
    drawerExpenses: r2(drawerExpenses),
    difference: r2(difference),
    collected: r2(collected),
    spent: r2(spent),
    onHand: r2(collected - spent),
    byLabel: [...byLabel.entries()].map(([label, amount]) => ({ label, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
    labels: [...new Set([...SPEND_PRESETS, ...rows.map((r) => r.e.description.trim()).filter(Boolean)])],
    spending: rows.map((r) => ({
      id: r.e.id,
      businessDate: r.e.businessDate,
      description: r.e.description,
      amount: Number(r.e.amount) || 0,
      notes: r.e.notes,
      createdBy: r.by ?? "",
    })),
  };
}

/* ── الكاشير ──────────────────────────────────────────────────── */

dayCloseRouter.get("/dayclose/mine", requireAuth, requirePermission(PERMISSIONS.cashierSubmit), async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const branch = await loadBranch(actor.branchId ?? null);
  if (!branch) {
    res.json({ ok: true, available: false, reason: "لا يوجد فرع مرتبط بحسابك" });
    return;
  }
  const db = getDb();
  const today = businessDateNow(branch.timezone);
  const start = await financeStartDate(branch.id);
  const pending = await db
    .select()
    .from(cashierClosings)
    .where(
      and(
        eq(cashierClosings.branchId, branch.id),
        inArray(cashierClosings.status, OPEN_STATUSES),
        start ? gte(cashierClosings.businessDate, start) : undefined,
        // الكاشير يؤكّد آخر 3 أيام فقط؛ الأقدم يؤكّده المدير بالنيابة من «المالية»
        gte(cashierClosings.businessDate, isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 2 * 86_400_000), "UTC")),
      ),
    )
    .orderBy(asc(cashierClosings.businessDate))
    .limit(5);
  const [todayRow] = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branch.id), eq(cashierClosings.businessDate, today)))
    .limit(1);
  const live = await foodicsDaySales(branch.id, today);
  res.json({
    ok: true,
    available: true,
    today,
    closeHour: DAY_CLOSE_HOUR,
    pending: await withLines(pending),
    todayClosing: todayRow ? (await withLines([todayRow]))[0] : null,
    expenseLabels: await expenseLabels(branch.id),
    live: { total: live.total, cash: live.cash, card: live.card + live.foodicsPay, delivery: live.deliveryApps, invoices: live.invoices },
  });
});

dayCloseRouter.post("/dayclose/:id/confirm", requireAuth, requirePermission(PERMISSIONS.cashierSubmit), async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const id = asId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const counted = asNumber(body.countedCash);
  if (id === null || counted === null || counted < 0 || counted > 10_000_000) {
    res.status(400).json({ ok: false, error: "اكتب النقد المعدود في الدرج (رقم صحيح)" });
    return;
  }
  const raw = Array.isArray(body.expenses) ? body.expenses : [];
  const expenses: Array<{ label: string; amount: number }> = [];
  for (const e of raw) {
    const item = (e ?? {}) as Record<string, unknown>;
    const label = (asString(item.label, 120) ?? "").trim();
    const amount = asNumber(item.amount) ?? 0;
    if (!label && !amount) continue;
    if (!label) {
      res.status(400).json({ ok: false, error: "لكل مصروف بيانٌ مطلوب (غاز، دجاج، لبن ...)" });
      return;
    }
    if (amount <= 0 || amount > 1_000_000) {
      res.status(400).json({ ok: false, error: `مبلغ المصروف «${label}» غير صحيح` });
      return;
    }
    expenses.push({ label, amount });
  }
  const canReview = await hasAnyPermission(req, [PERMISSIONS.cashierReview]);
  const result = await confirmDayClose({
    closingId: id,
    employeeId: actor.id,
    branchId: actor.branchId ?? null,
    canReview,
    countedCash: counted,
    openingFloat: asNumber(body.openingFloat),
    expenses,
    notes: asString(body.notes, 1000) ?? "",
  });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ ok: false, error: result.error });
    return;
  }
  await recordAudit({
    actorEmployeeId: actor.id,
    action: "dayclose.confirm",
    entityType: "cashier_closings",
    entityId: id,
    after: result.closing,
    ipAddress: clientIp(req),
  });
  const [view] = await withLines(result.closing ? [result.closing] : []);
  res.json({ ok: true, closing: view, message: "تم تأكيد تقفيل اليوم" });
});

/**
 * تعديل إدخال الصندوق من المالك (أو من مُنح «تعديل إدخال الصندوق»): النقد
 * المعدود والعهدة ومصاريف الدرج والملاحظة، حتى بعد تأكيد الكاشير أو مراجعة
 * اليوم. تبقى حالة اليوم كما هي، ويُسجَّل ما قبل التعديل وما بعده في سجل التدقيق.
 */
dayCloseRouter.patch("/dayclose/:id/edit", requireAuth, requirePermission(PERMISSIONS.cashierEditClosing), async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const id = asId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const counted = asNumber(body.countedCash);
  const float = body.openingFloat === undefined || body.openingFloat === "" ? null : asNumber(body.openingFloat);
  if (id === null || counted === null || counted < 0 || counted > 10_000_000) {
    res.status(400).json({ ok: false, error: "اكتب النقد المعدود (رقم صحيح)" });
    return;
  }
  if (float !== null && (float < 0 || float > 1_000_000)) {
    res.status(400).json({ ok: false, error: "مبلغ العهدة غير صحيح" });
    return;
  }
  const expenses: Array<{ label: string; amount: number }> = [];
  for (const e of Array.isArray(body.expenses) ? body.expenses : []) {
    const item = (e ?? {}) as Record<string, unknown>;
    const label = (asString(item.label, 120) ?? "").trim();
    const amount = asNumber(item.amount) ?? 0;
    if (!label && !amount) continue;
    if (!label || amount <= 0 || amount > 1_000_000) {
      res.status(400).json({ ok: false, error: `بيان أو مبلغ المصروف «${label || "بلا بيان"}» غير صحيح` });
      return;
    }
    expenses.push({ label, amount });
  }
  const reason = (asString(body.reason, 300) ?? "").trim();
  if (!reason) {
    res.status(400).json({ ok: false, error: "اكتب سبب التعديل" });
    return;
  }
  const db = getDb();
  const [before] = await db.select().from(cashierClosings).where(eq(cashierClosings.id, id));
  if (!before) {
    res.status(404).json({ ok: false, error: "التقفيل غير موجود" });
    return;
  }
  const result = await confirmDayClose({
    closingId: id,
    employeeId: actor.id,
    branchId: actor.branchId ?? null,
    canReview: true,
    canEdit: true,
    countedCash: counted,
    openingFloat: float,
    expenses,
    notes: asString(body.notes, 1000) ?? before.notes,
  });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ ok: false, error: result.error });
    return;
  }
  await recordAudit({
    actorEmployeeId: actor.id,
    action: "dayclose.owner_edit",
    entityType: "cashier_closings",
    entityId: id,
    before: { countedCash: before.countedCash, openingFloat: before.openingFloat, expenses: before.expenses, difference: before.difference, status: before.status },
    after: { ...result.closing, reason },
    ipAddress: clientIp(req),
  });
  const [view] = await withLines(result.closing ? [result.closing] : []);
  res.json({ ok: true, closing: view, message: "حُفظ تعديل إدخال الصندوق وسُجّل في سجل التدقيق." });
});

/* ── المالية ──────────────────────────────────────────────────── */

dayCloseRouter.get("/dayclose", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.query.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const startDate = await financeStartDate(branch.id);
  const from = clampFrom(asDateOnly(req.query.from) ?? `${today.slice(0, 8)}01`, startDate);
  const to = asDateOnly(req.query.to) ?? today;
  const db = getDb();
  const rows = await db
    .select()
    .from(cashierClosings)
    .where(and(eq(cashierClosings.branchId, branch.id), gte(cashierClosings.businessDate, from), lte(cashierClosings.businessDate, to)))
    .orderBy(desc(cashierClosings.businessDate));
  const list = await withLines(rows);
  const sum = (key: "totalSales" | "cashSales" | "networkSales" | "deliverySales" | "expenses" | "receivables") =>
    Math.round(list.reduce((s, r) => s + Number(r[key] ?? 0), 0) * 100) / 100;
  const diffs = list.filter((r) => r.difference !== null);
  res.json({
    ok: true,
    branchId: branch.id,
    today,
    startDate,
    from,
    to,
    closeHour: DAY_CLOSE_HOUR,
    openingFloat: await currentFloat(branch.id),
    expenseLabels: await expenseLabels(branch.id),
    cashBox: await cashBox(branch.id, startDate, to > today ? today : to),
    totals: {
      days: list.length,
      totalSales: sum("totalSales"),
      cashSales: sum("cashSales"),
      networkSales: sum("networkSales"),
      deliverySales: sum("deliverySales"),
      receivables: sum("receivables"),
      expenses: sum("expenses"),
      shortage: Math.round(diffs.filter((r) => r.difference! < 0).reduce((s, r) => s + r.difference!, 0) * 100) / 100,
      surplus: Math.round(diffs.filter((r) => r.difference! > 0).reduce((s, r) => s + r.difference!, 0) * 100) / 100,
      awaiting: list.filter((r) => r.awaitingCash).length,
    },
    closings: list,
  });
});

dayCloseRouter.post("/dayclose/refresh", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const date = asDateOnly(body.date) ?? businessDateNow(branch.timezone);
  const closing = await upsertDayClose(branch, date);
  res.json({ ok: true, found: Boolean(closing), message: closing ? `حُدّث تقفيل ${date} من فوديكس` : `لا فواتير فوديكس محفوظة ليوم ${date}` });
});

dayCloseRouter.post("/dayclose/rebuild", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const from = asDateOnly(body.from) ?? `${today.slice(0, 8)}01`;
  const to = asDateOnly(body.to) ?? today;
  const result = await rebuildDayCloses(branch, from, to);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "dayclose.rebuild",
    entityType: "branch",
    entityId: branch.id,
    after: { from, to, ...result },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, ...result });
});

dayCloseRouter.post("/dayclose/float", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const amount = asNumber(body.amount);
  if (amount === null || amount < 0 || amount > 1_000_000) {
    res.status(400).json({ ok: false, error: "اكتب مبلغ العهدة (رقم صحيح)" });
    return;
  }
  const from = asDateOnly(body.from) ?? businessDateNow(branch.timezone);
  const result = await setOpeningFloat(branch.id, from, amount);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "dayclose.float",
    entityType: "branch",
    entityId: branch.id,
    after: { from, ...result },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, ...result, message: `حُفظت عهدة الصندوق ${result.amount} ريال من ${from} (${result.updated} يوم أُعيد حسابه).` });
});

dayCloseRouter.put("/dayclose/start-date", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const startDate = asDateOnly(body.startDate);
  await setFinanceStartDate(branch.id, startDate);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "finance.start_date",
    entityType: "branch",
    entityId: branch.id,
    after: { startDate },
    ipAddress: clientIp(req),
  });
  res.json({
    ok: true,
    startDate,
    message: startDate ? `بداية الحسابات من ${startDate}: ما قبله لا يدخل التقفيل ولا مطابقة البنك (ويبقى محفوظاً).` : "أُلغيت بداية الحسابات.",
  });
});
