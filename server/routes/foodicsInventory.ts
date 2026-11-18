/**
 * مسارات مخزون فوديكس والاستلام اليومي.
 *
 *   GET  /api/stock/mine                         للمستلِم: استلامات فرعه بانتظار التأكيد
 *   POST /api/stock/docs/:id/confirm             تأكيد الاستلام (مطابق أو بفروق)
 *   GET  /api/stock/items?branchId=              أرصدة الأصناف من فوديكس
 *   GET  /api/stock/docs?branchId=&from=&to=&confirm=   مستندات الشراء والتحويل
 *   POST /api/stock/sync                         مزامنة فورية (أصناف + مستندات)
 *   POST /api/stock/test                         الحقول الفعلية من حساب فوديكس
 */

import { Router, type Response } from "express";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { employees, foodicsStockDocs } from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, hasAnyPermission, requireAnyPermission, requirePermission } from "../rbac.js";
import { asDateOnly, asId, asNumber, asString } from "../validate.js";
import { FoodicsError } from "../foodics.js";
import { businessDateNow } from "../dayClose.js";
import {
  confirmStockDoc,
  docView,
  itemsWithStock,
  probeFoodics,
  syncInventoryItems,
  syncStockDocs,
  testInventory,
} from "../foodicsInventory.js";
import { loadBranch } from "./surveillance.js";
import { isoDateInZone } from "../time.js";

export const stockRouter = Router();

const canRead = [requireAuth, requireAnyPermission(PERMISSIONS.inventoryRead, PERMISSIONS.sectionInventory)];
const canManage = [requireAuth, requirePermission(PERMISSIONS.inventoryItemsManage)];

function fail(res: Response, error: unknown) {
  if (error instanceof FoodicsError) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  throw error;
}

async function namesOf(ids: Array<number | null>) {
  const list = [...new Set(ids.filter((x): x is number => Boolean(x)))];
  if (!list.length) return new Map<number, string>();
  const db = getDb();
  const rows = await db.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ── المستلِم ─────────────────────────────────────────────────── */

stockRouter.get("/stock/mine", requireAuth, requirePermission(PERMISSIONS.inventoryWrite), async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(req.employee?.branchId ?? null);
  if (!branch) {
    res.json({ ok: true, available: false, docs: [] });
    return;
  }
  const db = getDb();
  const today = businessDateNow(branch.timezone);
  const since = isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 2 * 86_400_000), "UTC");
  const rows = await db
    .select()
    .from(foodicsStockDocs)
    .where(
      and(
        eq(foodicsStockDocs.branchId, branch.id),
        eq(foodicsStockDocs.confirmStatus, "awaiting"),
        inArray(foodicsStockDocs.state, ["received", "open"]),
        gte(foodicsStockDocs.businessDate, since),
      ),
    )
    .orderBy(desc(foodicsStockDocs.state), foodicsStockDocs.businessDate)
    .limit(30);
  const names = await namesOf([]);
  res.json({ ok: true, available: true, today, docs: rows.map((d) => docView(d, names)) });
});

stockRouter.post("/stock/docs/:id/confirm", requireAuth, requirePermission(PERMISSIONS.inventoryWrite), async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const id = asId(req.params.id);
  if (id === null) {
    res.status(400).json({ ok: false, error: "معرّف غير صالح" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body.diffs) ? body.diffs : [];
  const diffs: Array<{ sku: string; name: string; actual: number }> = [];
  for (const d of raw) {
    const item = (d ?? {}) as Record<string, unknown>;
    const actual = asNumber(item.actual);
    if (actual === null || actual < 0 || actual > 1_000_000) {
      res.status(400).json({ ok: false, error: "اكتب الكمية الفعلية الواصلة لكل صنف مختلف" });
      return;
    }
    diffs.push({ sku: asString(item.sku, 120) ?? "", name: asString(item.name, 200) ?? "", actual });
  }
  const canManage = await hasAnyPermission(req, [PERMISSIONS.inventoryItemsManage]);
  const result = await confirmStockDoc({
    docId: id,
    employeeId: actor.id,
    branchId: actor.branchId ?? null,
    canManage,
    diffs,
    note: asString(body.note, 500) ?? "",
  });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ ok: false, error: result.error });
    return;
  }
  await recordAudit({
    actorEmployeeId: actor.id,
    action: "stock.receipt_confirm",
    entityType: "foodics_stock_docs",
    entityId: id,
    after: { status: result.doc?.confirmStatus, diffs: result.diffs },
    ipAddress: clientIp(req),
  });
  res.json({
    ok: true,
    status: result.doc?.confirmStatus,
    message: result.diffs.length ? `سُجّل الاستلام مع ${result.diffs.length} فرق، وأُبلغ المالك.` : "تم تأكيد الاستلام — مطابق لفوديكس.",
  });
});

/* ── الإدارة ──────────────────────────────────────────────────── */

stockRouter.get("/stock/items", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.query.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const items = await itemsWithStock(branch.id);
  const withStock = items.filter((i) => i.quantity !== null);
  res.json({
    ok: true,
    items,
    totals: {
      items: items.length,
      withStock: withStock.length,
      value: Math.round(withStock.reduce((s, i) => s + (i.value ?? 0), 0) * 100) / 100,
      low: items.filter((i) => i.low).length,
      lastSync: withStock.reduce<Date | null>((m, i) => (i.syncedAt && (!m || i.syncedAt > m) ? i.syncedAt : m), null),
    },
  });
});

stockRouter.get("/stock/docs", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.query.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const from = asDateOnly(req.query.from) ?? isoDateInZone(new Date(new Date(`${today}T12:00:00Z`).getTime() - 6 * 86_400_000), "UTC");
  const to = asDateOnly(req.query.to) ?? today;
  const confirm = asString(req.query.confirm, 20) ?? "";
  const db = getDb();
  // الفترة والترتيب بتاريخ الفاتورة (وإن لم يُكتب فبتاريخ الإدخال في فوديكس)
  const docDate = sql<string>`coalesce(${foodicsStockDocs.invoiceDate}, ${foodicsStockDocs.businessDate})`;
  const conds = [eq(foodicsStockDocs.branchId, branch.id), gte(docDate, from), lte(docDate, to)];
  if (["awaiting", "confirmed", "disputed", "skipped"].includes(confirm)) conds.push(eq(foodicsStockDocs.confirmStatus, confirm));
  const rows = await db.select().from(foodicsStockDocs).where(and(...conds)).orderBy(desc(docDate), desc(foodicsStockDocs.id));
  const names = await namesOf(rows.map((r) => r.confirmedByEmployeeId));
  const docs = rows.map((d) => docView(d, names));
  res.json({
    ok: true,
    from,
    to,
    branchName: branch.name,
    docs,
    totals: {
      docs: docs.length,
      value: Math.round(docs.filter((d) => d.state !== "cancelled").reduce((s, d) => s + d.total, 0) * 100) / 100,
      awaiting: docs.filter((d) => d.confirmStatus === "awaiting" && d.state === "received").length,
      disputed: docs.filter((d) => d.confirmStatus === "disputed").length,
    },
  });
});

stockRouter.post("/stock/sync", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  try {
    const items = await syncInventoryItems(branch);
    const docs = await syncStockDocs(branch, { days: body.full === true ? 90 : undefined });
    res.json({ ok: true, items, docs });
  } catch (error) {
    fail(res, error);
  }
});

stockRouter.post("/stock/test", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  try {
    res.json({ ok: true, ...(await testInventory(branch)) });
  } catch (error) {
    fail(res, error);
  }
});

/** فحص قراءة فقط لمسار مخزون في فوديكس — لمعرفة الحقول الفعلية (مثل مسار الأرصدة). */
stockRouter.post("/stock/probe", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const path = (asString(body.path, 120) ?? "").trim().replace(/^\/+/, "");
  const params: Record<string, string> = {};
  if (body.params && typeof body.params === "object") {
    for (const [k, v] of Object.entries(body.params as Record<string, unknown>).slice(0, 8)) {
      if (/^[a-z_[\]]{1,40}$/.test(k) && typeof v === "string") params[k] = v.slice(0, 100);
    }
  }
  try {
    res.json({ ok: true, ...(await probeFoodics(path, params)) });
  } catch (error) {
    fail(res, error);
  }
});
