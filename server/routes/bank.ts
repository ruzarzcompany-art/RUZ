/**
 * مسارات «البنك والمطابقة» في المالية.
 *
 *   POST   /api/bank/import        رفع حركات كشف البنك (تُقرأ في المتصفح)
 *   GET    /api/bank/reconcile     المطابقة: المبيعات، المشتريات، البنود، الجهات
 *   PUT    /api/bank/rules         تثبيت أسماء الجهات وبنودها
 *   DELETE /api/bank/transactions  حذف حركات فترة (لإعادة الرفع)
 */

import { Router, type Response } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../rbac.js";
import { asDateOnly, asId, asNumber, asString } from "../validate.js";
import { BANK_CATEGORIES, deleteTransactions, importBankRows, reconcile, saveRules, type BankRowInput } from "../bank.js";
import { businessDateNow } from "../dayClose.js";
import { loadBranch } from "./surveillance.js";

export const bankRouter = Router();

const canRead = [requireAuth, requirePermission(PERMISSIONS.settlementsRead)];
const canManage = [requireAuth, requirePermission(PERMISSIONS.settlementsManage)];

async function branchOf(req: AuthedRequest, raw: unknown) {
  return loadBranch(asId(raw) ?? req.employee?.branchId ?? null);
}

bankRouter.post("/bank/import", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await branchOf(req, body.branchId);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const raw = Array.isArray(body.rows) ? body.rows : [];
  const rows: BankRowInput[] = [];
  for (const r of raw.slice(0, 5000)) {
    const x = (r ?? {}) as Record<string, unknown>;
    const date = asDateOnly(x.date);
    const description = asString(x.description, 4000) ?? "";
    const credit = Math.abs(asNumber(x.credit) ?? 0);
    const debit = Math.abs(asNumber(x.debit) ?? 0);
    if (!date || (!credit && !debit)) continue;
    rows.push({ date, description, credit, debit, balance: asNumber(x.balance) });
  }
  if (!rows.length) {
    res.status(400).json({ ok: false, error: "لم أجد حركات في الملف. تأكد أنه كشف الحساب (التاريخ، الوصف، دائن، مدين، الرصيد)." });
    return;
  }
  const result = await importBankRows(branch.id, rows, req.employee!.id);
  const dates = rows.map((r) => r.date).sort();
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "bank.import",
    entityType: "branch",
    entityId: branch.id,
    after: { ...result, from: dates[0], to: dates[dates.length - 1], fileName: asString(body.fileName, 200) ?? "" },
    ipAddress: clientIp(req),
  });
  res.json({
    ok: true,
    ...result,
    from: dates[0],
    to: dates[dates.length - 1],
    message: `أُضيفت ${result.inserted} حركة${result.skipped ? ` (وتُجوهلت ${result.skipped} مكررة رُفعت سابقاً)` : ""} من ${dates[0]} إلى ${dates[dates.length - 1]}.`,
  });
});

bankRouter.get("/bank/reconcile", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await branchOf(req, req.query.branchId);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const from = asDateOnly(req.query.from) ?? `${today.slice(0, 8)}01`;
  const to = asDateOnly(req.query.to) ?? today;
  const result = await reconcile(branch.id, from <= to ? from : to, from <= to ? to : from);
  res.json({ ok: true, branchId: branch.id, categoryLabels: BANK_CATEGORIES, ...result });
});

bankRouter.put("/bank/rules", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await branchOf(req, body.branchId);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const raw = Array.isArray(body.rules) ? body.rules : [];
  const items = raw.slice(0, 300).map((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    return {
      counterparty: (asString(x.counterparty, 120) ?? "").trim(),
      category: asString(x.category, 40) ?? "other",
      mappedName: (asString(x.mappedName, 120) ?? "").trim(),
      lagDays: Math.max(0, Math.min(30, Math.round(asNumber(x.lagDays) ?? 0))),
    };
  });
  const saved = await saveRules(branch.id, items);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "bank.rules",
    entityType: "branch",
    entityId: branch.id,
    after: { items },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, saved, message: `ثُبّتت ${saved} جهة.` });
});

bankRouter.delete("/bank/transactions", ...canManage, async (req: AuthedRequest, res: Response) => {
  const branch = await branchOf(req, req.query.branchId);
  const from = asDateOnly(req.query.from);
  const to = asDateOnly(req.query.to);
  if (!branch || !from || !to) {
    res.status(400).json({ ok: false, error: "اختر الفرع والفترة" });
    return;
  }
  const removed = await deleteTransactions(branch.id, from, to);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "bank.delete",
    entityType: "branch",
    entityId: branch.id,
    after: { from, to, removed },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, removed, message: `حُذفت ${removed} حركة من ${from} إلى ${to}.` });
});
