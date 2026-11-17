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
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { cashierClosingLines, cashierClosings, employees } from "../../db/schema.js";
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
  const pending = await db
    .select()
    .from(cashierClosings)
    .where(
      and(
        eq(cashierClosings.branchId, branch.id),
        inArray(cashierClosings.status, OPEN_STATUSES),
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

/* ── المالية ──────────────────────────────────────────────────── */

dayCloseRouter.get("/dayclose", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.query.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const from = asDateOnly(req.query.from) ?? `${today.slice(0, 8)}01`;
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
    from,
    to,
    closeHour: DAY_CLOSE_HOUR,
    openingFloat: await currentFloat(branch.id),
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
