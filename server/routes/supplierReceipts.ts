/**
 * مسارات «استلام من مورد» بتصوير الفاتورة.
 *
 *   POST /api/kiosk/receive/start            من شاشة الدخول: التعرّف على الوجه (أو الرقم + PIN)
 *                                            ← تذكرة قصيرة العمر للاستلام فقط
 *   GET  /api/supplier-receipts/access       ما يملكه المستخدم: استلام / اعتماد
 *   POST /api/supplier-receipts/analyze      صورة الفاتورة ← مسوّدة بالأصناف جاهزة
 *   POST /api/supplier-receipts/:id/submit   تأكيد كل بند ← بانتظار المشرف
 *   GET  /api/supplier-receipts/mine         استلاماتي في آخر 3 أيام
 *   GET  /api/supplier-receipts?branchId=&from=&to=&status=   للإدارة
 *   GET  /api/supplier-receipts/:id/photo    صورة الفاتورة
 *   POST /api/supplier-receipts/:id/review   اعتماد المشرف أو رفضه
 *
 * من يستلم: بند «استلام المشتريات (المستلِم)» بدرجة 2، أو من يملك حركة المخزون.
 * من يعتمد: الدرجة 4 من البند نفسه، أو من يملك إدارة أصناف المخزون.
 * التذكرة لا تفتح أي مسار آخر في النظام: تُقبل في مسارات الاستلام الثلاثة فقط.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { branches, employees, supplierReceipts } from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { getJwtSecret } from "../config.js";
import { businessDateNow } from "../dayClose.js";
import { identifyFace } from "../face.js";
import { haversineDistanceMeters, isValidCoordinates } from "../geo.js";
import { verifyPassword } from "../passwords.js";
import { PERMISSIONS, accessProfile, hasAnyPermission, requireAnyPermission } from "../rbac.js";
import {
  DAILY_ANALYZE_LIMIT,
  MAX_LINES,
  analyzedToday,
  createDraft,
  myReceipts,
  receiptItems,
  receiptsReport,
  reviewReceipt,
  submitReceipt,
  viewOf,
  type ReceiptLine,
} from "../supplierReceipts.js";
import { asDateOnly, asEnum, asId, asNumber, asString, round2 } from "../validate.js";
import { decodePhoto, loadPhoto } from "./purchases.js";
import { loadBranch } from "./surveillance.js";

export const supplierReceiptsRouter = Router();

const RECEIVE_CODES = [PERMISSIONS.supplierReceive, PERMISSIONS.inventoryWrite];
const APPROVE_CODES = [PERMISSIONS.supplierReceiptApprove, PERMISSIONS.inventoryItemsManage];
const READ_CODES = [...APPROVE_CODES, PERMISSIONS.inventoryRead, PERMISSIONS.sectionInventory];

/** عمر تذكرة الاستلام من شاشة الدخول: تكفي للتصوير والعدّ ثم تنتهي. */
const TICKET_TTL_SECONDS = 30 * 60;
const TICKET_PURPOSE = "supplier-receive";
const NOT_ALLOWED = "لست من المخوَّلين بالاستلام من المورد. راجع مديرك ليضيفك من «إدارة الصلاحيات».";

interface TicketPayload {
  sub: string;
  purpose: string;
  method: "face" | "pin";
}

interface ReceiverRequest extends AuthedRequest {
  receiveVia?: { source: "kiosk" | "app"; method: "face" | "pin" | "session" };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/* ── شاشة الدخول: التعرّف ثم التذكرة ────────────────────────────── */

supplierReceiptsRouter.post("/kiosk/receive/start", async (req: Request, res: Response) => {
  const db = getDb();
  const body = (req.body ?? {}) as Record<string, unknown>;
  let employeeId: number | null = null;
  let method: "face" | "pin" = "face";

  const employeeCode = String(body.employeeCode ?? "").trim();
  const pin = String(body.pin ?? "").trim();
  if (employeeCode || pin) {
    method = "pin";
    if (!employeeCode || !pin) {
      res.status(400).json({ ok: false, error: "الرقم الوظيفي ورمز PIN مطلوبان" });
      return;
    }
    const [row] = await db
      .select({ id: employees.id, kioskPinHash: employees.kioskPinHash })
      .from(employees)
      .where(eq(employees.employeeCode, employeeCode))
      .limit(1);
    if (!row || !row.kioskPinHash || !verifyPassword(pin, row.kioskPinHash)) {
      res.status(401).json({ ok: false, error: "الرقم الوظيفي أو رمز PIN غير صحيح" });
      return;
    }
    employeeId = row.id;
  } else {
    const identify = await identifyFace(body.descriptor ?? body.faceDescriptor, { ambiguityMargin: 0.05 });
    if (!identify.matched || identify.employeeId === null) {
      res.status(401).json({
        ok: false,
        matched: false,
        error: identify.ambiguous
          ? "تعذّر تحديد الهوية بدقّة. أعد المحاولة في إضاءة أفضل أو استخدم الرقم الوظيفي وPIN."
          : "لم يُتعرَّف على وجهك. أعد المحاولة أو استخدم الرقم الوظيفي وPIN.",
      });
      return;
    }
    employeeId = identify.employeeId;
  }

  const [employee] = await db
    .select({ id: employees.id, fullName: employees.fullName, isActive: employees.isActive, branchId: employees.branchId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  if (!employee || !employee.isActive) {
    res.status(403).json({ ok: false, error: "الحساب غير مُفعّل، راجع الموارد البشرية" });
    return;
  }

  const profile = await accessProfile({ employeeId: employee.id });
  if (!RECEIVE_CODES.some((code) => profile.codes.includes(code))) {
    res.status(403).json({ ok: false, error: `${employee.fullName}: ${NOT_ALLOWED}` });
    return;
  }

  const branch = await loadBranch(employee.branchId);
  if (!branch || !branch.isActive) {
    res.status(409).json({ ok: false, error: "لم يتم ربط الموظف بفرع مُفعّل. راجع الموارد البشرية." });
    return;
  }

  // الاستلام يتم داخل المطعم: نفس نطاق التحضير
  const coordinates = { latitude: Number(body.latitude), longitude: Number(body.longitude) };
  if (!isValidCoordinates(coordinates)) {
    res.status(400).json({ ok: false, error: "الموقع الجغرافي مطلوب. اسمح بالوصول إلى الموقع ثم أعد المحاولة." });
    return;
  }
  const distance = haversineDistanceMeters(coordinates, { latitude: branch.latitude, longitude: branch.longitude });
  if (distance > branch.radiusMeters) {
    res.status(403).json({ ok: false, error: "الاستلام من المورد يتم من موقع العمل فقط" });
    return;
  }

  const payload: TicketPayload = { sub: String(employee.id), purpose: TICKET_PURPOSE, method };
  const ticket = jwt.sign(payload, getJwtSecret(), { expiresIn: TICKET_TTL_SECONDS });

  await recordAudit({
    actorEmployeeId: employee.id,
    action: "kiosk.receive_start",
    entityType: "supplier_receipts",
    entityId: null,
    after: { method },
    reason: "بدء استلام من مورد من شاشة الدخول",
    ipAddress: clientIp(req),
  });

  res.json({
    ok: true,
    ticket,
    expiresInSeconds: TICKET_TTL_SECONDS,
    employee: { id: employee.id, fullName: employee.fullName },
    branchName: branch.name,
  });
});

/**
 * وسيط المستلِم: جلسة عادية بصلاحية الاستلام، أو تذكرة شاشة الدخول. الصلاحية
 * تُفحص في كل طلب، فسحبها من «إدارة الصلاحيات» يوقف التذكرة القائمة فوراً.
 */
async function receiverAuth(req: ReceiverRequest, res: Response, next: NextFunction): Promise<void> {
  const ticket = req.headers["x-receive-ticket"];
  const allow = async () => {
    if (await hasAnyPermission(req, RECEIVE_CODES)) return next();
    res.status(403).json({ ok: false, error: NOT_ALLOWED });
  };

  if (typeof ticket !== "string" || !ticket) {
    let authed = false;
    await requireAuth(req, res, () => {
      authed = true;
    });
    if (!authed) return;
    req.receiveVia = { source: "app", method: "session" };
    await allow();
    return;
  }

  let payload: TicketPayload;
  try {
    payload = jwt.verify(ticket, getJwtSecret()) as TicketPayload;
  } catch {
    res.status(401).json({ ok: false, expired: true, error: "انتهت مهلة الاستلام. ابدأ من جديد بالتعرّف على وجهك." });
    return;
  }
  if (payload.purpose !== TICKET_PURPOSE) {
    res.status(401).json({ ok: false, error: "تذكرة غير صالحة" });
    return;
  }

  const db = getDb();
  const [row] = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      fullName: employees.fullName,
      jobTitle: employees.jobTitle,
      branchId: employees.branchId,
      isActive: employees.isActive,
      faceEnabled: employees.faceEnabled,
    })
    .from(employees)
    .where(eq(employees.id, Number(payload.sub)))
    .limit(1);
  if (!row || !row.isActive) {
    res.status(403).json({ ok: false, error: "الحساب غير مُفعّل" });
    return;
  }

  req.employee = {
    id: row.id,
    employeeCode: row.employeeCode,
    fullName: row.fullName,
    jobTitle: row.jobTitle,
    branchId: row.branchId,
    tokenId: "kiosk-receive",
    faceEnabled: row.faceEnabled,
  };
  req.receiveVia = { source: "kiosk", method: payload.method === "pin" ? "pin" : "face" };
  await allow();
}

/* ── المستلِم ─────────────────────────────────────────────────── */

supplierReceiptsRouter.get("/supplier-receipts/access", requireAuth, async (req: AuthedRequest, res: Response) => {
  res.json({
    ok: true,
    canReceive: await hasAnyPermission(req, RECEIVE_CODES),
    canApprove: await hasAnyPermission(req, APPROVE_CODES),
    canRead: await hasAnyPermission(req, READ_CODES),
  });
});

supplierReceiptsRouter.post("/supplier-receipts/analyze", receiverAuth, async (req: ReceiverRequest, res: Response) => {
  const actor = req.employee!;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // المستلِم يستلم لفرعه؛ من يملك الاعتماد وحده يختار فرعاً آخر (من لوحة الإدارة)
  const mayPickBranch = req.receiveVia?.source === "app" && (await hasAnyPermission(req, APPROVE_CODES));
  const branch = await loadBranch((mayPickBranch ? asId(body.branchId) : null) ?? actor.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "حسابك غير مرتبط بفرع" });
    return;
  }

  const photo = decodePhoto(body.photo);
  if (!photo) {
    res.status(400).json({ ok: false, error: "صوّر الفاتورة أولاً" });
    return;
  }
  if ("error" in photo) {
    res.status(400).json({ ok: false, error: photo.error });
    return;
  }

  if ((await analyzedToday(actor.id)) >= DAILY_ANALYZE_LIMIT) {
    res.status(429).json({ ok: false, error: `بلغت حد تصوير الفواتير اليومي (${DAILY_ANALYZE_LIMIT}). راجع مديرك.` });
    return;
  }

  const result = await createDraft({
    branch,
    employeeId: actor.id,
    source: req.receiveVia?.source === "kiosk" ? "kiosk" : body.fromAdmin === true ? "admin" : "app",
    verifyMethod: req.receiveVia?.method ?? "session",
    photo,
  });
  if (!result) {
    res.status(500).json({ ok: false, error: "تعذّر حفظ الفاتورة" });
    return;
  }

  await recordAudit({
    actorEmployeeId: actor.id,
    action: "supplier_receipt.analyze",
    entityType: "supplier_receipts",
    entityId: result.draft.id,
    after: { readable: result.readable, source: result.draft.source },
    ipAddress: clientIp(req),
  });

  res.status(201).json({
    ok: true,
    readable: result.readable,
    receipt: await viewOf(result.draft),
    items: await receiptItems(),
    today: businessDateNow(branch.timezone),
    message: result.readable
      ? "قُرئت الفاتورة. عُدّ كل صنف ثم أكّده."
      : result.aiNote || "لم تُقرأ الفاتورة بوضوح. أعد التصوير في إضاءة أفضل أو أضف الأصناف يدوياً.",
  });
});

supplierReceiptsRouter.post("/supplier-receipts/:id/submit", receiverAuth, async (req: ReceiverRequest, res: Response) => {
  const actor = req.employee!;
  const id = asId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fail = (status: number, error: string) => void res.status(status).json({ ok: false, error });
  if (id === null) return fail(400, "معرّف غير صالح");

  const db = getDb();
  const [draft] = await db
    .select({ branchId: supplierReceipts.branchId, timezone: branches.timezone })
    .from(supplierReceipts)
    .innerJoin(branches, eq(branches.id, supplierReceipts.branchId))
    .where(eq(supplierReceipts.id, id));
  if (!draft) return fail(404, "الاستلام غير موجود");
  const today = businessDateNow(draft.timezone);

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0) return fail(400, "أضف صنفاً واحداً على الأقل");
  if (rawLines.length > MAX_LINES) return fail(400, `الفاتورة الواحدة لا تتجاوز ${MAX_LINES} صنفاً`);

  const catalog = new Map((await receiptItems()).map((item) => [item.id, item]));
  const lines: ReceiptLine[] = [];
  for (const [index, raw] of rawLines.entries()) {
    const line = (raw ?? {}) as Record<string, unknown>;
    const label = `البند رقم ${index + 1}`;
    const item = catalog.get(asId(line.itemId) ?? 0);
    const name = asString(line.name, 200) || item?.name || "";
    const invoiceQty = asNumber(line.invoiceQty) ?? 0;
    const actualQty = asNumber(line.actualQty);
    const unitPrice = asNumber(line.unitPrice) ?? 0;
    const packSize = Math.round(asNumber(line.packSize) ?? 0);
    if (!name) return fail(400, `${label}: اختر الصنف`);
    if (actualQty === null || actualQty < 0 || actualQty > 1_000_000) return fail(400, `«${name}»: اكتب الكمية الواصلة فعلاً`);
    if (invoiceQty < 0 || invoiceQty > 1_000_000 || unitPrice < 0 || unitPrice > 1_000_000) return fail(400, `«${name}»: رقم غير منطقي`);
    if (line.confirmed !== true) return fail(400, `«${name}»: عُدّ الصنف ثم اضغط «تأكيد» عليه قبل الإرسال`);
    lines.push({
      name,
      itemId: item?.id ?? null,
      itemName: item?.name ?? "",
      unit: asString(line.unit, 40) || item?.unit || "",
      invoiceQty: round3(invoiceQty),
      actualQty: round3(actualQty),
      unitPrice: round2(unitPrice),
      lineTotal: round2(actualQty * unitPrice),
      packSize: packSize > 1 && packSize <= 10_000 ? packSize : 0,
      confirmed: true,
      confidence: asEnum(line.confidence, ["high", "medium", "low"] as const) ?? "high",
    });
  }

  const invoiceDate = asDateOnly(body.invoiceDate);
  const invoiceTotal = asNumber(body.invoiceTotal) ?? 0;
  if (invoiceTotal < 0 || invoiceTotal > 10_000_000) return fail(400, "إجمالي الفاتورة غير منطقي");
  if (invoiceDate && invoiceDate > today) return fail(400, "تاريخ الفاتورة لا يكون مستقبلياً");

  const result = await submitReceipt({
    id,
    employeeId: actor.id,
    supplier: asString(body.supplier, 160) ?? "",
    invoiceNumber: asString(body.invoiceNumber, 80) ?? "",
    invoiceDate,
    invoiceTotal: round2(invoiceTotal),
    notes: asString(body.notes, 1000) ?? "",
    lines,
  });
  if ("error" in result) return fail(result.status ?? 400, result.error ?? "تعذّر الإرسال");

  await recordAudit({
    actorEmployeeId: actor.id,
    action: "supplier_receipt.submit",
    entityType: "supplier_receipts",
    entityId: id,
    after: result.receipt,
    reason: req.receiveVia?.source === "kiosk" ? `من شاشة الدخول (${req.receiveVia.method})` : "",
    ipAddress: clientIp(req),
  });

  res.json({
    ok: true,
    receipt: await viewOf(result.receipt),
    message:
      `تم استلام ${lines.length} صنف${result.diffs ? ` — منها ${result.diffs} بفرق عن الفاتورة` : ""}. ` +
      "الاستلام الآن معلّق بانتظار اعتماد المشرف.",
  });
});

supplierReceiptsRouter.get("/supplier-receipts/mine", receiverAuth, async (req: ReceiverRequest, res: Response) => {
  res.json({ ok: true, receipts: await myReceipts(req.employee!.id) });
});

/* ── الإدارة والمشرف ───────────────────────────────────────────── */

supplierReceiptsRouter.get("/supplier-receipts", requireAuth, requireAnyPermission(...READ_CODES), async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.query.branchId) ?? req.employee?.branchId ?? null);
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const today = businessDateNow(branch.timezone);
  const from = asDateOnly(req.query.from) ?? `${today.slice(0, 8)}01`;
  const to = asDateOnly(req.query.to) ?? today;
  const report = await receiptsReport(branch, from <= to ? from : to, from <= to ? to : from, asString(req.query.status, 20) ?? "");
  res.json({
    ok: true,
    canApprove: await hasAnyPermission(req, APPROVE_CODES),
    canReceive: await hasAnyPermission(req, RECEIVE_CODES),
    ...report,
  });
});

supplierReceiptsRouter.get("/supplier-receipts/:id/photo", requireAuth, requireAnyPermission(...READ_CODES, ...RECEIVE_CODES), async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  if (id === null) {
    res.status(400).json({ ok: false, error: "معرّف غير صالح" });
    return;
  }
  const db = getDb();
  const [row] = await db
    .select({ photoKey: supplierReceipts.photoKey, receivedBy: supplierReceipts.receivedByEmployeeId })
    .from(supplierReceipts)
    .where(eq(supplierReceipts.id, id));
  // المستلِم يرى صور استلاماته فقط؛ غيره يحتاج صلاحية الاطّلاع
  if (row && row.receivedBy !== req.employee!.id && !(await hasAnyPermission(req, READ_CODES))) {
    res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض هذه الصورة" });
    return;
  }
  if (!row?.photoKey) {
    res.status(404).json({ ok: false, error: "لا توجد صورة لهذه الفاتورة" });
    return;
  }
  try {
    const photo = await loadPhoto(row.photoKey);
    if (!photo) {
      res.status(404).json({ ok: false, error: "تعذّر العثور على صورة الفاتورة" });
      return;
    }
    res.json({ ok: true, image: `data:${photo.contentType};base64,${photo.data.toString("base64")}` });
  } catch {
    res.status(503).json({ ok: false, error: "مخزن الصور غير متاح الآن — حاول لاحقاً" });
  }
});

supplierReceiptsRouter.post("/supplier-receipts/:id/review", requireAuth, requireAnyPermission(...APPROVE_CODES), async (req: AuthedRequest, res: Response) => {
  const actor = req.employee!;
  const id = asId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const decision = asEnum(body.decision, ["approve", "reject"] as const);
  if (id === null || !decision) {
    res.status(400).json({ ok: false, error: "طلب غير صالح" });
    return;
  }
  const note = asString(body.note, 500) ?? "";
  if (decision === "reject" && !note) {
    res.status(400).json({ ok: false, error: "اكتب سبب الرفض" });
    return;
  }

  // لا يعتمد المستلِم استلامه بنفسه — إلا من يملك إدارة المخزون كلها (المدير/المالك)
  const db = getDb();
  const [row] = await db.select({ receivedBy: supplierReceipts.receivedByEmployeeId }).from(supplierReceipts).where(eq(supplierReceipts.id, id));
  if (decision === "approve" && row?.receivedBy === actor.id && !(await hasAnyPermission(req, [PERMISSIONS.inventoryItemsManage]))) {
    res.status(403).json({ ok: false, error: "لا تعتمد استلاماً استلمته أنت — يعتمده مشرف آخر." });
    return;
  }

  const result = await reviewReceipt({ id, reviewerId: actor.id, decision, note });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ ok: false, error: result.error });
    return;
  }
  await recordAudit({
    actorEmployeeId: actor.id,
    action: decision === "approve" ? "supplier_receipt.approve" : "supplier_receipt.reject",
    entityType: "supplier_receipts",
    entityId: id,
    after: result.receipt,
    reason: note,
    ipAddress: clientIp(req),
  });
  res.json({
    ok: true,
    receipt: await viewOf(result.receipt),
    message:
      decision === "reject"
        ? "رُفض الاستلام."
        : result.linked
          ? "اعتُمد الاستلام ورُبط بفاتورته في فوديكس."
          : "اعتُمد الاستلام — بانتظار رفع المحاسب للفاتورة في فوديكس.",
  });
});
