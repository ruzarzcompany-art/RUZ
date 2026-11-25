/**
 * مسارات الربط مع فوديكس والرقابة الثلاثية.
 *
 *   GET  /api/foodics/status?branchId=        حالة الربط وآخر مزامنة
 *   PUT  /api/foodics/token                   حفظ مفتاح API (مشفّر) — الدرجة 3
 *   POST /api/foodics/test                    اختبار الاتصال وجلب فروع فوديكس
 *   PUT  /api/foodics/branch                  ربط فرع «سِجل» بفرع فوديكس وحدود المطابقة
 *   POST /api/foodics/sync                    مزامنة فورية للفرع
 *   GET  /api/foodics/triple?branchId=&date=  تقرير الرقابة الثلاثية ليوم
 *   GET  /api/foodics/cashier-prefill?date=   أرقام فوديكس لتعبئة تقفيل الكاشير آلياً
 *   POST /api/foodics/backfill                سحب كل الفواتير السابقة صفحةً صفحة (أرشيف)
 *   GET  /api/foodics/orders?branchId=&from=&to=&state=&channel=&q=&page=   أرشيف الفواتير
 *   GET  /api/foodics/orders/summary?branchId=&from=&to=                    ملخّص الفترة
 *   GET  /api/foodics/orders/breakdown?part=channel|payments|items&…        مربعات التحليل بتصفية مستقلة
 */

import { Router, type Response } from "express";
import { getDb } from "../../db/index.js";
import { surveillanceSettings } from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, requireModuleLevel, requirePermission } from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { asDateOnly, asId, asNumber, asString } from "../validate.js";
import {
  DEFAULT_FOODICS_BASE,
  FoodicsError,
  backfillOrders,
  foodicsDaySales,
  foodicsOrdersSummary,
  listFoodicsOrders,
  ordersByChannel,
  ordersByPayment,
  ordersTopItems,
  foodicsStatus,
  saveFoodicsToken,
  syncBranch,
  testFoodics,
  tripleReport,
} from "../foodics.js";
import { loadBranch, settingsFor } from "./surveillance.js";

export const foodicsRouter = Router();

const MODULE = "surveillance";
const canRead = [requireAuth, requirePermission(PERMISSIONS.surveillanceRead), requireModuleLevel(MODULE, 1)];
const canManage = [requireAuth, requirePermission(PERMISSIONS.surveillanceManage), requireModuleLevel(MODULE, 3)];

function fail(res: Response, error: unknown) {
  if (error instanceof FoodicsError) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  throw error;
}

function branchIdOf(req: AuthedRequest, value: unknown): number | null {
  return asId(value) ?? req.employee?.branchId ?? null;
}

foodicsRouter.get("/foodics/status", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  res.json({ ok: true, status: await foodicsStatus(branch.id) });
});

foodicsRouter.put("/foodics/token", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = (asString(body.token, 4000) ?? "").trim();
  const apiBase = (asString(body.apiBase, 200) ?? "").trim();
  if (apiBase && !/^https:\/\/[a-z0-9.-]+\.foodics\.com(\/[\w/.-]*)?$/i.test(apiBase)) {
    res.status(400).json({ ok: false, error: `رابط API غير صحيح (الافتراضي ${DEFAULT_FOODICS_BASE})` });
    return;
  }
  await saveFoodicsToken(token, apiBase, req.employee!.id);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: token ? "foodics.token_set" : "foodics.token_clear",
    entityType: "foodics_connection",
    entityId: 1,
    after: { apiBase: apiBase || DEFAULT_FOODICS_BASE, tokenSet: Boolean(token) },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, message: token ? "حُفظ مفتاح فوديكس مشفّراً." : "حُذف مفتاح فوديكس." });
});

foodicsRouter.post("/foodics/test", ...canManage, async (_req: AuthedRequest, res: Response) => {
  try {
    res.json({ ok: true, ...(await testFoodics()) });
  } catch (error) {
    fail(res, error);
  }
});

foodicsRouter.put("/foodics/branch", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const foodicsBranchId = (asString(body.foodicsBranchId, 100) ?? "").trim();
  const matchMinutes = asNumber(body.matchMinutes) ?? 3;
  const tolerance = asNumber(body.salesGapTolerance) ?? 5;
  if (matchMinutes < 1 || matchMinutes > 30 || tolerance < 0) {
    res.status(400).json({ ok: false, error: "نافذة المطابقة بين 1 و30 دقيقة، والفرق المسموح صفر أو أكثر" });
    return;
  }
  const current = await settingsFor(branch.id);
  const db = getDb();
  const set = {
    foodicsBranchId,
    foodicsMatchMinutes: Math.round(matchMinutes),
    salesGapTolerance: tolerance,
    updatedAt: new Date(),
  };
  await db
    .insert(surveillanceSettings)
    .values({
      branchId: branch.id,
      defaultPrepMinutes: current.defaultPrepMinutes,
      customerWaitMinutes: current.customerWaitMinutes,
      repeatPosThreshold: current.repeatPosThreshold,
      openTime: current.openTime,
      closeTime: current.closeTime,
      ...set,
    })
    .onConflictDoUpdate({ target: surveillanceSettings.branchId, set });
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "foodics.branch_link",
    entityType: "branch",
    entityId: branch.id,
    after: set,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, message: foodicsBranchId ? "رُبط الفرع بفوديكس." : "أُلغي ربط الفرع." });
});

foodicsRouter.post("/foodics/sync", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(branchIdOf(req, body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  try {
    const stats = await syncBranch(branch, { force: body.full === true });
    res.json({ ok: true, stats });
  } catch (error) {
    fail(res, error);
  }
});

foodicsRouter.get("/foodics/triple", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const date = asDateOnly(req.query.date) ?? isoDateInZone(new Date(), safeTimeZone(branch.timezone));
  res.json({ ok: true, report: await tripleReport(branch, date) });
});

/**
 * أرقام فوديكس لتقفيل الكاشير: فواتير هذا الكاشير إن أمكن ربط اسمه في
 * فوديكس باسمه في «سِجل»، وإلا فواتير الفرع كاملة لذلك اليوم.
 */
foodicsRouter.get(
  "/foodics/cashier-prefill",
  requireAuth,
  requirePermission(PERMISSIONS.cashierSubmit),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const branch = await loadBranch(actor.branchId ?? null);
    if (!branch) {
      res.json({ ok: true, available: false });
      return;
    }
    const status = await foodicsStatus(branch.id);
    if (!status.connected || !status.foodicsBranchId) {
      res.json({ ok: true, available: false });
      return;
    }
    const date = asDateOnly(req.query.date) ?? isoDateInZone(new Date(), safeTimeZone(branch.timezone));
    const mine = await foodicsDaySales(branch.id, date, actor.id);
    const scope = mine.orders > 0 ? "mine" : "branch";
    const sales = scope === "mine" ? mine : await foodicsDaySales(branch.id, date);
    res.json({ ok: true, available: sales.orders > 0, scope, date, lastSyncAt: status.lastSyncAt, sales });
  },
);

foodicsRouter.post("/foodics/backfill", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(branchIdOf(req, body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const from = asDateOnly(body.from) ?? "2015-01-01";
  const page = Math.max(1, Math.floor(asNumber(body.page) ?? 1));
  try {
    const result = await backfillOrders(branch, { from, page });
    if (page === 1) {
      await recordAudit({
        actorEmployeeId: req.employee!.id,
        action: "foodics.backfill_start",
        entityType: "branch",
        entityId: branch.id,
        after: { from },
        ipAddress: clientIp(req),
      });
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    fail(res, error);
  }
});

function ordersFilter(req: AuthedRequest, timeZone: string) {
  const today = isoDateInZone(new Date(), safeTimeZone(timeZone));
  const from = asDateOnly(req.query.from) ?? `${today.slice(0, 8)}01`;
  const to = asDateOnly(req.query.to) ?? today;
  const state = asString(req.query.state, 20) ?? "";
  const channel = asString(req.query.channel, 20) ?? "";
  const q = (asString(req.query.q, 100) ?? "").trim();
  const discount = asString(req.query.discount, 5) ?? "";
  const payKind = asString(req.query.payKind, 20) ?? "";
  return {
    from: from <= to ? from : to,
    to: from <= to ? to : from,
    state: ["closed", "void", "returned", "open", "other"].includes(state) ? state : undefined,
    channel: ["dine_in", "takeaway", "delivery", "drive_thru"].includes(channel) ? channel : undefined,
    q: q || undefined,
    discount: discount === "yes" || discount === "no" ? (discount as "yes" | "no") : undefined,
    payKind: ["cash", "card", "foodics", "delivery_app", "other"].includes(payKind) ? payKind : undefined,
  };
}

foodicsRouter.get("/foodics/orders/summary", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const filter = ordersFilter(req, branch.timezone);
  res.json({ ok: true, filter, summary: await foodicsOrdersSummary(branch.id, filter, req.query.lite === "1") });
});

/**
 * مربعات التحليل، لكل مربع تصفيته المستقلة:
 * part = channel | payments | items. الحالة الافتراضية «مدفوعة»، و state=all لكل الحالات.
 */
foodicsRouter.get("/foodics/orders/breakdown", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const base = ordersFilter(req, branch.timezone);
  const filter = { ...base, state: req.query.state === "all" ? undefined : (base.state ?? "closed") };
  const part = asString(req.query.part, 20) ?? "";
  try {
    if (part === "channel") {
      res.json({ ok: true, filter, rows: await ordersByChannel(branch.id, filter) });
    } else if (part === "payments") {
      res.json({ ok: true, filter, rows: await ordersByPayment(branch.id, filter) });
    } else if (part === "items") {
      const item = (asString(req.query.item, 100) ?? "").trim() || undefined;
      const rows = await ordersTopItems(branch.id, filter, {
        sort: req.query.sort === "amount" ? "amount" : "quantity",
        limit: asNumber(req.query.limit) ?? 20,
        item,
      });
      res.json({ ok: true, filter, rows });
    } else {
      res.status(400).json({ ok: false, error: "قسم غير معروف" });
    }
  } catch (error) {
    fail(res, error);
  }
});

foodicsRouter.get("/foodics/orders", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const filter = ordersFilter(req, branch.timezone);
  const page = Math.max(1, Math.floor(asNumber(req.query.page) ?? 1));
  const size = Math.floor(asNumber(req.query.pageSize) ?? 50);
  const pageSize = [20, 50, 100].includes(size) ? size : 50;
  const result = await listFoodicsOrders(branch.id, filter, page, pageSize);
  res.json({ ok: true, filter, page, pageSize, ...result });
});
