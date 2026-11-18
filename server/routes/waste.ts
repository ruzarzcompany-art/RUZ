/**
 * مسارات الهدر.
 *
 *   GET  /api/waste/items             أصناف المخزون لقائمة موظف الهدر
 *   GET  /api/waste/mine              تسجيلاتي في آخر 3 أيام
 *   POST /api/waste                   تسجيل هدر (بانتظار الاعتماد)
 *   GET  /api/waste?branchId=&from=&to=&status=   تقرير الهدر للإدارة
 *   POST /api/waste/:id/review        اعتماد (مع تصحيح الكمية) أو رفض
 *   PUT  /api/waste/settings          حد الهدر المقبول (٪ من مبيعات اليوم)
 *
 * من يسجّل: «تسجيل الهدر» أو صلاحية حركة المخزون. من يعتمد: «اعتماد الهدر»
 * أو إدارة أصناف المخزون. كلاهما يحدَّد للموظف من «إدارة الصلاحيات».
 */

import { Router, type Response } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, hasAnyPermission, requireAnyPermission } from "../rbac.js";
import { asDateOnly, asEnum, asId, asNumber, asString } from "../validate.js";
import { businessDateNow } from "../dayClose.js";
import { WASTE_REASONS, myWaste, recordWaste, reviewWaste, setWasteLimit, wasteItems, wasteReport } from "../waste.js";
import { loadBranch } from "./surveillance.js";

export const wasteRouter = Router();

const RECORD_CODES = [PERMISSIONS.wasteRecord, PERMISSIONS.wasteApprove, PERMISSIONS.inventoryWrite];
const APPROVE_CODES = [PERMISSIONS.wasteApprove, PERMISSIONS.inventoryItemsManage];
const canRecord = [requireAuth, requireAnyPermission(...RECORD_CODES)];
const canRead = [requireAuth, requireAnyPermission(...APPROVE_CODES, PERMISSIONS.inventoryRead, PERMISSIONS.sectionInventory)];
const canApprove = [requireAuth, requireAnyPermission(...APPROVE_CODES)];
const REASON_KEYS = Object.keys(WASTE_REASONS);

wasteRouter.get("/waste/items", ...canRecord, async (_req: AuthedRequest, res: Response) => {
  res.json({ ok: true, items: await wasteItems(), reasons: WASTE_REASONS });
});

wasteRouter.get("/waste/mine", ...canRecord, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(req.employee?.branchId ?? null);
  if (!branch) {
    res.json({ ok: true, available: false, entries: [] });
    return;
  }
  res.json({ ok: true, available: true, ...(await myWaste(branch, req.employee!.id)) });
});

wasteRouter.post("/waste", ...canRecord, async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // الموظف يسجّل على فرعه؛ المعتمِد وحده يسجّل على فرع آخر
  const mayPickBranch = await hasAnyPermission(req, APPROVE_CODES);
  const branch = await loadBranch((mayPickBranch ? asId(body.branchId) : null) ?? actor.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "حسابك غير مرتبط بفرع" });
    return;
  }
  const itemId = asId(body.itemId);
  const quantity = asNumber(body.quantity);
  const reason = asEnum(body.reason, REASON_KEYS);
  if (itemId === null) {
    res.status(400).json({ ok: false, error: "اختر الصنف" });
    return;
  }
  if (quantity === null || quantity <= 0 || quantity > 100_000) {
    res.status(400).json({ ok: false, error: "اكتب كمية الهدر" });
    return;
  }
  if (!reason) {
    res.status(400).json({ ok: false, error: "اختر سبب الهدر" });
    return;
  }
  const notes = asString(body.notes, 500) ?? "";
  if (reason === "other" && !notes.trim()) {
    res.status(400).json({ ok: false, error: "اكتب السبب في الملاحظات" });
    return;
  }
  const result = await recordWaste({ branch, employeeId: actor.id, itemId, quantity, reason, station: asString(body.station, 80) ?? "", notes });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ ok: false, error: result.error });
    return;
  }
  await recordAudit({
    actorEmployeeId: actor.id,
    action: "waste.record",
    entityType: "waste_entries",
    entityId: result.entry?.id ?? null,
    after: result.entry,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, entry: result.entry, message: `سُجّل هدر ${result.entry?.quantity} ${result.item.unit} من ${result.item.name} — بانتظار الاعتماد.` });
});

wasteRouter.get("/waste", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.query.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const from = asDateOnly(req.query.from) ?? `${today.slice(0, 8)}01`;
  const to = asDateOnly(req.query.to) ?? today;
  const report = await wasteReport(branch, from <= to ? from : to, from <= to ? to : from, asString(req.query.status, 20) ?? "");
  res.json({ ok: true, canApprove: await hasAnyPermission(req, APPROVE_CODES), ...report });
});

wasteRouter.post("/waste/:id/review", ...canApprove, async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const id = asId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const decision = asEnum(body.decision, ["approve", "reject"] as const);
  if (id === null || !decision) {
    res.status(400).json({ ok: false, error: "طلب غير صالح" });
    return;
  }
  const quantity = body.quantity === undefined || body.quantity === null || body.quantity === "" ? null : asNumber(body.quantity);
  if (decision === "approve" && quantity !== null && (quantity <= 0 || quantity > 100_000)) {
    res.status(400).json({ ok: false, error: "الكمية المعتمدة غير صالحة" });
    return;
  }
  const note = asString(body.note, 500) ?? "";
  if (decision === "reject" && !note.trim()) {
    res.status(400).json({ ok: false, error: "اكتب سبب الرفض" });
    return;
  }
  const result = await reviewWaste({ id, reviewerId: actor.id, decision, quantity, note });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ ok: false, error: result.error });
    return;
  }
  await recordAudit({
    actorEmployeeId: actor.id,
    action: decision === "approve" ? "waste.approve" : "waste.reject",
    entityType: "waste_entries",
    entityId: id,
    after: result.entry,
    reason: note,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, entry: result.entry, message: decision === "approve" ? "اعتُمد الهدر وخُصم من المخزون." : "رُفض التسجيل ولم يُخصم شيء." });
});

wasteRouter.put("/waste/settings", ...canApprove, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId) ?? req.employee?.branchId ?? null);
  const limit = asNumber(body.limitPercent);
  if (!branch || limit === null || limit <= 0 || limit > 100) {
    res.status(400).json({ ok: false, error: "اكتب نسبة بين 0.1 و100" });
    return;
  }
  await setWasteLimit(branch.id, Math.round(limit * 100) / 100);
  await recordAudit({ actorEmployeeId: req.employee!.id, action: "waste.limit", entityType: "branch", entityId: branch.id, after: { limitPercent: limit }, ipAddress: clientIp(req) });
  res.json({ ok: true, message: `حد الهدر المقبول صار ${limit}٪ من مبيعات اليوم.` });
});
