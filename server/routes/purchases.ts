/**
 * استلام المشتريات — الحلقة اليدوية من الرقابة الثلاثية على المشتريات.
 *
 * الموظف المستلِم يؤكد ما وصل فعلاً: المورد ورقم الفاتورة، الكمية وسعر الوحدة
 * لكل صنف، إجمالي الفاتورة، المدفوع وطريقته، وصورة الفاتورة. ومن الاستلام:
 *
 *   • تُنشأ حركة إدخال «شراء» لكل صنف في المخزون (مرجعها رقم الفاتورة).
 *   • يُسجَّل المدفوع نقداً في السجل الموحّد للخزينة فيُخصم من تقفيلة اليوم.
 *   • تُعلَّم آلياً الفروق التي تحتاج مراجعة — بلا حكم على أحد.
 *
 * عند ربط فوديكس تُطابَق هذه الاستلامات مع فواتير الشراء فيه (الحقل
 * `foodics_reference`)، فتكتمل الثلاثية: فاتورة فوديكس ↔ الاستلام ↔ المدفوع.
 *
 *   GET  /api/purchases/access
 *   GET  /api/purchases/receipts?branchId=&from=&to=&status=
 *   POST /api/purchases/receipts
 *   GET  /api/purchases/receipts/:id
 *   GET  /api/purchases/receipts/:id/photo
 *   POST /api/purchases/receipts/:id/review
 */

import { Router, type Response } from "express";
import { getStore } from "@netlify/blobs";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  cashExpenses,
  employees,
  inventoryItems,
  inventoryMovements,
  purchaseReceiptLines,
  purchaseReceipts,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { monthLockFor, monthLockMessage } from "../monthLock.js";
import {
  PERMISSIONS,
  hasAnyPermission,
  hasModuleLevel,
  requireModuleLevel,
  requirePermission,
} from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { asDateOnly, asEnum, asId, asNumber, asString, round2 } from "../validate.js";

export const purchasesRouter = Router();

const PAYMENT_METHODS = ["cash", "transfer", "credit"] as const;
const REVIEW_DECISIONS = ["approved", "disputed"] as const;
const STATUSES = ["ok", "needs_review", "approved", "disputed"] as const;

/** أقصى عدد أصناف في استلام واحد. */
const MAX_LINES = 40;
/** أقصى مبلغ معقول لفاتورة واحدة — يصدّ خطأ خانة زائدة. */
const MAX_AMOUNT = 1_000_000;
/** أقصى حجم لصورة الفاتورة بعد فك الترميز (المتصفح يضغطها قبل الإرسال). */
const MAX_PHOTO_BYTES = 2_000_000;
/** فرق مسموح بين إجمالي الفاتورة ومجموع الأصناف: الأكبر من ريال أو 1%. */
const TOTAL_TOLERANCE_ABS = 1;
const TOTAL_TOLERANCE_RATIO = 0.01;
/** ارتفاع سعر الوحدة عن السعر السابق الذي يستدعي المراجعة. */
const PRICE_JUMP_RATIO = 0.15;

export type ReceiptFlag =
  | "total_mismatch"
  | "price_jump"
  | "no_photo"
  | "no_invoice_number"
  | "overpaid"
  | "cash_unposted";

/** نص كل ملاحظة كما يراه المراجع. */
export const FLAG_LABELS: Record<ReceiptFlag, string> = {
  total_mismatch: "إجمالي الفاتورة لا يساوي مجموع الأصناف المستلمة",
  price_jump: "سعر صنف ارتفع عن آخر سعر شراء بأكثر من 15%",
  no_photo: "لم تُرفق صورة الفاتورة",
  no_invoice_number: "بلا رقم فاتورة",
  overpaid: "المدفوع أكبر من إجمالي الفاتورة",
  cash_unposted: "دُفع نقداً ولم يُسجَّل في الخزينة بعد — يُسجَّل عند المراجعة",
};

export interface ReceiptLineInput {
  quantity: number;
  unitCost: number;
  previousUnitCost: number;
}

/**
 * الملاحظات الآلية على الاستلام — دالة صافية ليسهل اختبارها. لا تحكم على
 * أحد: كل ملاحظة سبب للمراجعة فقط.
 */
export function receiptFlags(input: {
  invoiceTotal: number;
  paidAmount: number;
  invoiceNumber: string;
  hasPhoto: boolean;
  paymentMethod: string;
  cashPosted: boolean;
  lines: readonly ReceiptLineInput[];
}): { flags: ReceiptFlag[]; linesTotal: number; difference: number } {
  const linesTotal = round2(
    input.lines.reduce((sum, line) => sum + round2(line.quantity * line.unitCost), 0),
  );
  const difference = round2(input.invoiceTotal - linesTotal);
  const tolerance = Math.max(TOTAL_TOLERANCE_ABS, input.invoiceTotal * TOTAL_TOLERANCE_RATIO);

  const flags: ReceiptFlag[] = [];
  if (Math.abs(difference) > tolerance) flags.push("total_mismatch");
  if (
    input.lines.some(
      (line) =>
        line.previousUnitCost > 0 &&
        line.unitCost > line.previousUnitCost * (1 + PRICE_JUMP_RATIO),
    )
  ) {
    flags.push("price_jump");
  }
  if (!input.hasPhoto) flags.push("no_photo");
  if (!input.invoiceNumber) flags.push("no_invoice_number");
  if (input.paidAmount > input.invoiceTotal + TOTAL_TOLERANCE_ABS) flags.push("overpaid");
  if (input.paymentMethod === "cash" && input.paidAmount > 0 && !input.cashPosted) {
    flags.push("cash_unposted");
  }

  return { flags, linesTotal, difference };
}

function parseFlags(raw: string): ReceiptFlag[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((flag): flag is ReceiptFlag => typeof flag === "string" && flag in FLAG_LABELS)
      : [];
  } catch {
    return [];
  }
}

function amountOrError(value: unknown, label: string): number | string {
  if (value === undefined || value === null || value === "") return 0;
  const num = asNumber(value);
  if (num === null || num < 0) return `${label}: أدخل رقماً غير سالب`;
  if (num > MAX_AMOUNT) return `${label}: المبلغ كبير بشكل غير منطقي`;
  return round2(num);
}

async function branchTimezone(branchId: number): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ timezone: branches.timezone })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  return row ? safeTimeZone(row.timezone ?? "Asia/Riyadh") : null;
}

/* ── صورة الفاتورة ─────────────────────────────────────────────── */

function photoStore() {
  return getStore("purchase-invoices");
}

/** يفكّ `data:image/...;base64,...` ويتحقق من النوع والحجم. */
export function decodePhoto(
  value: unknown,
): { data: Buffer; contentType: string } | { error: string } | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: "صورة الفاتورة غير صالحة" };

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return { error: "صورة الفاتورة يجب أن تكون JPEG أو PNG أو WebP" };

  const data = Buffer.from(match[2], "base64");
  if (data.byteLength === 0) return { error: "صورة الفاتورة فارغة" };
  if (data.byteLength > MAX_PHOTO_BYTES) {
    return { error: "صورة الفاتورة كبيرة جداً — صوّرها من جديد بدقة أقل" };
  }
  return { data, contentType: match[1] };
}

async function savePhoto(key: string, data: Buffer, contentType: string): Promise<void> {
  const store = photoStore();
  await store.set(
    key,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  await store.set(`${key}.type`, contentType);
}

async function loadPhoto(key: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!key) return null;
  const store = photoStore();
  const buffer = await store.get(key, { type: "arrayBuffer" });
  if (!buffer) return null;
  const contentType =
    ((await store.get(`${key}.type`, { type: "text" })) as string | null) ?? "image/jpeg";
  return { data: Buffer.from(buffer as ArrayBuffer), contentType };
}

/* ── الخزينة ───────────────────────────────────────────────────── */

async function canPostCash(req: AuthedRequest): Promise<boolean> {
  return (
    (await hasAnyPermission(req, [PERMISSIONS.cashExpensesWrite])) &&
    (await hasModuleLevel(req, "cash_expenses", 2))
  );
}

/**
 * يسجّل المدفوع نقداً في السجل الموحّد للخزينة. إن كانت الفاتورة مسجّلة هناك
 * مسبقاً برقمها فيُربط الاستلام بها ولا تُسجَّل مرة ثانية.
 */
async function postCashExpense(input: {
  branchId: number;
  businessDate: string;
  invoiceNumber: string;
  supplier: string;
  description: string;
  amount: number;
  receiptId: number;
  actorId: number;
  ipAddress: string | undefined;
}): Promise<{ id: number; existing: boolean } | null> {
  const db = getDb();

  if (input.invoiceNumber) {
    const [existing] = await db
      .select({ id: cashExpenses.id })
      .from(cashExpenses)
      .where(
        and(
          eq(cashExpenses.branchId, input.branchId),
          eq(cashExpenses.invoiceNumber, input.invoiceNumber),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, existing: true };
  }

  const [saved] = await db
    .insert(cashExpenses)
    .values({
      branchId: input.branchId,
      businessDate: input.businessDate,
      shift: "full",
      kind: "purchase",
      description: input.description,
      invoiceNumber: input.invoiceNumber,
      quantity: 1,
      unitPrice: input.amount,
      amount: input.amount,
      supplier: input.supplier,
      notes: `من استلام المشتريات رقم ${input.receiptId}`,
      createdByEmployeeId: input.actorId,
    })
    .returning();

  if (!saved) return null;

  await recordAudit({
    actorEmployeeId: input.actorId,
    action: "cash.expense.create",
    entityType: "cash_expenses",
    entityId: saved.id,
    after: saved,
    reason: `استلام مشتريات رقم ${input.receiptId}`,
    ipAddress: input.ipAddress,
  });

  return { id: saved.id, existing: false };
}

/* ── القراءة ───────────────────────────────────────────────────── */

async function loadReceipts(conditions: ReturnType<typeof eq>[], limit: number) {
  const db = getDb();
  const receipts = await db
    .select({
      receipt: purchaseReceipts,
      branchName: branches.name,
      receivedBy: employees.fullName,
    })
    .from(purchaseReceipts)
    .leftJoin(branches, eq(purchaseReceipts.branchId, branches.id))
    .leftJoin(employees, eq(purchaseReceipts.receivedByEmployeeId, employees.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(purchaseReceipts.businessDate), desc(purchaseReceipts.id))
    .limit(limit);

  const ids = receipts.map((row) => row.receipt.id);
  const lines =
    ids.length === 0
      ? []
      : await db
          .select({
            line: purchaseReceiptLines,
            itemName: inventoryItems.name,
            itemCode: inventoryItems.code,
            unit: inventoryItems.unit,
          })
          .from(purchaseReceiptLines)
          .leftJoin(inventoryItems, eq(purchaseReceiptLines.itemId, inventoryItems.id))
          .where(inArray(purchaseReceiptLines.receiptId, ids))
          .orderBy(asc(purchaseReceiptLines.id));

  return receipts.map(({ receipt, branchName, receivedBy }) => {
    const flags = parseFlags(receipt.flags);
    return {
      ...receipt,
      // مفتاح التخزين لا يخرج إلى المتصفح؛ يكفيه أن يعرف أن للفاتورة صورة
      photoKey: undefined,
      hasPhoto: receipt.photoKey !== "",
      flags,
      flagLabels: flags.map((flag) => FLAG_LABELS[flag]),
      branchName: branchName ?? "",
      receivedBy: receivedBy ?? "",
      lines: lines
        .filter((row) => row.line.receiptId === receipt.id)
        .map((row) => ({
          ...row.line,
          itemName: row.itemName ?? "",
          itemCode: row.itemCode ?? "",
          unit: row.unit ?? "",
        })),
    };
  });
}

/** نطاق الاطّلاع على الشاشة — تستخدمه الواجهة لإظهار النموذج وأزرار المراجعة. */
purchasesRouter.get(
  "/purchases/access",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    res.json({
      ok: true,
      canRead: await hasAnyPermission(req, [PERMISSIONS.inventoryRead]),
      canReceive:
        (await hasAnyPermission(req, [PERMISSIONS.inventoryWrite])) &&
        (await hasModuleLevel(req, "inventory_movements", 2)),
      canReview: await hasModuleLevel(req, "inventory_movements", 3),
      canPostCash: await canPostCash(req),
      branchId: req.employee?.branchId ?? null,
    });
  },
);

purchasesRouter.get(
  "/purchases/receipts",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const branchId = asId(req.query.branchId) ?? actor.branchId ?? null;
    const from = asDateOnly(req.query.from);
    const to = asDateOnly(req.query.to);
    const status = asEnum(req.query.status, STATUSES);

    const conditions: ReturnType<typeof eq>[] = [];
    if (branchId !== null) conditions.push(eq(purchaseReceipts.branchId, branchId));
    if (from) conditions.push(gte(purchaseReceipts.businessDate, from));
    if (to) conditions.push(lte(purchaseReceipts.businessDate, to));
    if (status) conditions.push(eq(purchaseReceipts.status, status));

    const receipts = await loadReceipts(conditions, 200);
    res.json({
      ok: true,
      branchId,
      receipts,
      summary: {
        count: receipts.length,
        invoiceTotal: round2(receipts.reduce((sum, row) => sum + row.invoiceTotal, 0)),
        paidTotal: round2(receipts.reduce((sum, row) => sum + row.paidAmount, 0)),
        needsReview: receipts.filter((row) => row.status === "needs_review").length,
      },
      meta: { paymentMethods: PAYMENT_METHODS, flagLabels: FLAG_LABELS },
    });
  },
);

purchasesRouter.get(
  "/purchases/receipts/:id",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الاستلام غير صالح" });
      return;
    }
    const [receipt] = await loadReceipts([eq(purchaseReceipts.id, id)], 1);
    if (!receipt) {
      res.status(404).json({ ok: false, error: "الاستلام غير موجود" });
      return;
    }
    res.json({ ok: true, receipt });
  },
);

purchasesRouter.get(
  "/purchases/receipts/:id/photo",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الاستلام غير صالح" });
      return;
    }
    const db = getDb();
    const [row] = await db
      .select({ photoKey: purchaseReceipts.photoKey })
      .from(purchaseReceipts)
      .where(eq(purchaseReceipts.id, id))
      .limit(1);

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
      res.json({
        ok: true,
        image: `data:${photo.contentType};base64,${photo.data.toString("base64")}`,
      });
    } catch {
      res.status(503).json({ ok: false, error: "مخزن الصور غير متاح الآن — حاول لاحقاً" });
    }
  },
);

/* ── تسجيل الاستلام ────────────────────────────────────────────── */

purchasesRouter.post(
  "/purchases/receipts",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryWrite),
  requireModuleLevel("inventory_movements", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (status: number, error: string) => res.status(status).json({ ok: false, error });

    const branchId = asId(body.branchId) ?? actor.branchId ?? null;
    if (branchId === null) return void fail(400, "اختر الفرع");

    const timezone = await branchTimezone(branchId);
    if (!timezone) return void fail(404, "الفرع غير موجود");

    const today = isoDateInZone(new Date(), timezone);
    const businessDate = asDateOnly(body.businessDate) ?? today;
    if (businessDate > today) return void fail(400, "لا يمكن تسجيل استلام بتاريخ مستقبلي");

    const supplier = asString(body.supplier, 160) ?? "";
    if (!supplier) return void fail(400, "اكتب اسم المورد");

    const invoiceNumber = asString(body.invoiceNumber, 80) ?? "";
    const paymentMethod = asEnum(body.paymentMethod, PAYMENT_METHODS) ?? "cash";

    const invoiceTotal = amountOrError(body.invoiceTotal, "إجمالي الفاتورة");
    if (typeof invoiceTotal === "string") return void fail(400, invoiceTotal);
    if (invoiceTotal <= 0) return void fail(400, "أدخل إجمالي الفاتورة كما هو مكتوب عليها");

    const paidRaw =
      body.paidAmount === undefined || body.paidAmount === null || body.paidAmount === ""
        ? paymentMethod === "credit"
          ? 0
          : invoiceTotal
        : amountOrError(body.paidAmount, "المدفوع");
    if (typeof paidRaw === "string") return void fail(400, paidRaw);
    const paidAmount = paidRaw;

    /* الأصناف */
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (rawLines.length === 0) return void fail(400, "أضف صنفاً واحداً على الأقل");
    if (rawLines.length > MAX_LINES) {
      return void fail(400, `الاستلام الواحد لا يتجاوز ${MAX_LINES} صنفاً — قسّمه على استلامين`);
    }

    const parsedLines: Array<{ itemId: number; quantity: number; unitCost: number | null }> = [];
    for (const [index, raw] of rawLines.entries()) {
      const line = (raw ?? {}) as Record<string, unknown>;
      const itemId = asId(line.itemId);
      const quantity = asNumber(line.quantity);
      const unitCost = asNumber(line.unitCost);
      const label = `الصنف رقم ${index + 1}`;

      if (itemId === null) return void fail(400, `${label}: اختر الصنف`);
      if (quantity === null || quantity <= 0) {
        return void fail(400, `${label}: أدخل الكمية المستلمة فعلاً`);
      }
      if (unitCost !== null && (unitCost < 0 || unitCost > MAX_AMOUNT)) {
        return void fail(400, `${label}: سعر الوحدة غير منطقي`);
      }
      if (parsedLines.some((existing) => existing.itemId === itemId)) {
        return void fail(400, `${label}: الصنف مكرّر في الاستلام — اجمع كميته في سطر واحد`);
      }
      parsedLines.push({
        itemId,
        quantity: round2(quantity),
        unitCost: unitCost === null ? null : round2(unitCost),
      });
    }

    const items = await db
      .select()
      .from(inventoryItems)
      .where(
        inArray(
          inventoryItems.id,
          parsedLines.map((line) => line.itemId),
        ),
      );
    const itemById = new Map(items.map((item) => [item.id, item]));

    const lines: Array<{
      item: (typeof items)[number];
      quantity: number;
      unitCost: number;
      totalCost: number;
      previousUnitCost: number;
    }> = [];
    for (const [index, line] of parsedLines.entries()) {
      const item = itemById.get(line.itemId);
      if (!item) return void fail(404, `الصنف رقم ${index + 1} غير موجود`);
      if (line.unitCost === null) {
        return void fail(400, `«${item.name}»: أدخل سعر الوحدة من الفاتورة`);
      }
      lines.push({
        item,
        quantity: line.quantity,
        unitCost: line.unitCost,
        totalCost: round2(line.quantity * line.unitCost),
        previousUnitCost: item.unitCost,
      });
    }

    /* الفاتورة تُسجَّل مرة واحدة في الفرع */
    if (invoiceNumber) {
      const [duplicate] = await db
        .select({
          id: purchaseReceipts.id,
          businessDate: purchaseReceipts.businessDate,
          supplier: purchaseReceipts.supplier,
        })
        .from(purchaseReceipts)
        .where(
          and(
            eq(purchaseReceipts.branchId, branchId),
            eq(purchaseReceipts.invoiceNumber, invoiceNumber),
          ),
        )
        .limit(1);

      if (duplicate) {
        res.status(409).json({
          ok: false,
          error:
            `الفاتورة رقم ${invoiceNumber} مستلَمة مسبقاً بتاريخ ${duplicate.businessDate}` +
            (duplicate.supplier ? ` من ${duplicate.supplier}` : "") +
            " — تُستلم مرة واحدة.",
          existingId: duplicate.id,
        });
        return;
      }
    }

    /* الدفع النقدي يُخصم من الخزينة، فلا يُقبل داخل شهر مقفل */
    const willPayCash = paymentMethod === "cash" && paidAmount > 0;
    const postCash = willPayCash && (await canPostCash(req));
    if (willPayCash) {
      const lock = await monthLockFor(branchId, businessDate);
      if (lock) return void fail(409, monthLockMessage(lock));
    }

    const photo = decodePhoto(body.photo);
    if (photo && "error" in photo) return void fail(400, photo.error);

    /* الحفظ: الاستلام أولاً ثم ما يتفرّع عنه */
    const [receipt] = await db
      .insert(purchaseReceipts)
      .values({
        branchId,
        businessDate,
        supplier,
        invoiceNumber,
        paymentMethod,
        invoiceTotal,
        paidAmount,
        notes: asString(body.notes, 1000) ?? "",
        receivedByEmployeeId: actor.id,
      })
      .returning();

    if (!receipt) return void fail(500, "تعذّر حفظ الاستلام");

    /* صورة الفاتورة — تعذّر حفظها لا يُسقط الاستلام، لكنه يُعلَّم */
    let photoKey = "";
    if (photo) {
      try {
        photoKey = `receipt-${receipt.id}-${Date.now()}`;
        await savePhoto(photoKey, photo.data, photo.contentType);
      } catch {
        photoKey = "";
      }
    }

    /* حركات الإدخال — مرجعها رقم الفاتورة فتظهر في كشف الحركات كما هي */
    const reference = invoiceNumber || `استلام ${receipt.id}`;
    const costUpdates: string[] = [];

    for (const line of lines) {
      const [movement] = await db
        .insert(inventoryMovements)
        .values({
          branchId,
          itemId: line.item.id,
          movementType: "in",
          businessDate,
          quantity: line.quantity,
          unitCost: line.unitCost,
          totalCost: line.totalCost,
          reason: "purchase",
          reference,
          notes: `استلام مشتريات رقم ${receipt.id} — ${supplier}`,
          createdByEmployeeId: actor.id,
        })
        .returning();

      await db.insert(purchaseReceiptLines).values({
        receiptId: receipt.id,
        itemId: line.item.id,
        quantity: line.quantity,
        unitCost: line.unitCost,
        totalCost: line.totalCost,
        previousUnitCost: line.previousUnitCost,
        movementId: movement?.id ?? null,
      });

      await recordAudit({
        actorEmployeeId: actor.id,
        action: "inventory.movement.in",
        entityType: "inventory_movements",
        entityId: movement?.id ?? null,
        after: movement,
        reason: `استلام مشتريات رقم ${receipt.id}`,
        ipAddress: clientIp(req),
      });

      // السعر المتغيّر: آخر فاتورة شراء تُحدّث سعر وحدة الصنف (كما في حركة الإدخال)
      if (line.item.priceMode === "variable" && line.unitCost !== line.item.unitCost) {
        await db
          .update(inventoryItems)
          .set({ unitCost: line.unitCost, updatedAt: new Date() })
          .where(eq(inventoryItems.id, line.item.id));
        costUpdates.push(line.item.name);

        await recordAudit({
          actorEmployeeId: actor.id,
          action: "inventory.item.cost_from_invoice",
          entityType: "inventory_items",
          entityId: line.item.id,
          before: { unitCost: line.item.unitCost },
          after: { unitCost: line.unitCost, movementId: movement?.id ?? null },
          ipAddress: clientIp(req),
        });
      }
    }

    /* الخزينة */
    let cashExpenseId: number | null = null;
    let cashLinkedExisting = false;
    if (postCash) {
      const names = lines.map((line) => line.item.name).join("، ");
      const posted = await postCashExpense({
        branchId,
        businessDate,
        invoiceNumber,
        supplier,
        description: `مشتريات: ${names}`.slice(0, 200),
        amount: paidAmount,
        receiptId: receipt.id,
        actorId: actor.id,
        ipAddress: clientIp(req),
      });
      cashExpenseId = posted?.id ?? null;
      cashLinkedExisting = posted?.existing ?? false;
    }

    const computed = receiptFlags({
      invoiceTotal,
      paidAmount,
      invoiceNumber,
      hasPhoto: photoKey !== "",
      paymentMethod,
      cashPosted: cashExpenseId !== null,
      lines,
    });

    const [saved] = await db
      .update(purchaseReceipts)
      .set({
        linesTotal: computed.linesTotal,
        difference: computed.difference,
        flags: JSON.stringify(computed.flags),
        status: computed.flags.length > 0 ? "needs_review" : "ok",
        photoKey,
        cashExpenseId,
        updatedAt: new Date(),
      })
      .where(eq(purchaseReceipts.id, receipt.id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "purchase.receipt.create",
      entityType: "purchase_receipts",
      entityId: receipt.id,
      after: saved,
      reason: `${supplier}${invoiceNumber ? ` — فاتورة ${invoiceNumber}` : ""}`,
      ipAddress: clientIp(req),
    });

    const notes: string[] = [`أُدخل ${lines.length} صنف إلى المخزون`];
    if (cashExpenseId !== null) {
      notes.push(
        cashLinkedExisting
          ? "الفاتورة مسجّلة في الخزينة مسبقاً فرُبطت بها ولم تُخصم مرة ثانية"
          : `سُجّل ${paidAmount} نقداً في الخزينة`,
      );
    }
    if (costUpdates.length > 0) notes.push(`حُدّث سعر: ${costUpdates.join("، ")}`);
    if (photo && !photoKey) notes.push("تعذّر حفظ صورة الفاتورة");

    const [full] = await loadReceipts([eq(purchaseReceipts.id, receipt.id)], 1);
    res.status(201).json({
      ok: true,
      receipt: full,
      message:
        `تم تسجيل الاستلام رقم ${receipt.id}. ${notes.join("، ")}.` +
        (computed.flags.length > 0
          ? ` ملاحظات للمراجعة: ${computed.flags.map((flag) => FLAG_LABELS[flag]).join("؛ ")}.`
          : ""),
    });
  },
);

/* ── المراجعة ──────────────────────────────────────────────────── */

/**
 * مراجعة المدير: «معتمد» أو «عليه خلاف» مع ملاحظة. المراجعة لا تحذف حركة
 * ولا قيداً؛ التصحيح يتم من شاشتي المخزون والخزينة بصلاحياتهما. وإن كان
 * الدفع نقدياً ولم يُسجَّل في الخزينة بعد، فاعتماد من يملك صلاحيتها يسجّله.
 */
purchasesRouter.post(
  "/purchases/receipts/:id/review",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  requireModuleLevel("inventory_movements", 3),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الاستلام غير صالح" });
      return;
    }

    const decision = asEnum(req.body?.decision, REVIEW_DECISIONS);
    if (!decision) {
      res.status(400).json({ ok: false, error: "اختر: معتمد أو عليه خلاف" });
      return;
    }
    const note = asString(req.body?.note, 500) ?? "";
    if (decision === "disputed" && !note) {
      res.status(400).json({ ok: false, error: "اكتب سبب الخلاف" });
      return;
    }

    const [before] = await db
      .select()
      .from(purchaseReceipts)
      .where(eq(purchaseReceipts.id, id))
      .limit(1);
    if (!before) {
      res.status(404).json({ ok: false, error: "الاستلام غير موجود" });
      return;
    }

    let flags = parseFlags(before.flags);
    let cashExpenseId = before.cashExpenseId;
    let cashNote = "";

    if (decision === "approved" && flags.includes("cash_unposted") && cashExpenseId === null) {
      if (await canPostCash(req)) {
        const lock = await monthLockFor(before.branchId, before.businessDate);
        if (lock) {
          res.status(409).json({ ok: false, error: monthLockMessage(lock) });
          return;
        }
        const posted = await postCashExpense({
          branchId: before.branchId,
          businessDate: before.businessDate,
          invoiceNumber: before.invoiceNumber,
          supplier: before.supplier,
          description: `مشتريات: ${before.supplier}`.slice(0, 200),
          amount: before.paidAmount,
          receiptId: before.id,
          actorId: actor.id,
          ipAddress: clientIp(req),
        });
        if (posted) {
          cashExpenseId = posted.id;
          flags = flags.filter((flag) => flag !== "cash_unposted");
          cashNote = posted.existing
            ? " الفاتورة مسجّلة في الخزينة مسبقاً فرُبطت بها."
            : ` سُجّل ${before.paidAmount} نقداً في الخزينة.`;
        }
      } else {
        cashNote = " المدفوع نقداً لم يُسجَّل في الخزينة: يحتاج من يملك صلاحية المصاريف النقدية.";
      }
    }

    const [after] = await db
      .update(purchaseReceipts)
      .set({
        status: decision,
        flags: JSON.stringify(flags),
        cashExpenseId,
        reviewedByEmployeeId: actor.id,
        reviewedAt: new Date(),
        reviewNote: note,
        updatedAt: new Date(),
      })
      .where(eq(purchaseReceipts.id, id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: `purchase.receipt.${decision}`,
      entityType: "purchase_receipts",
      entityId: id,
      before,
      after,
      reason: note,
      ipAddress: clientIp(req),
    });

    const [full] = await loadReceipts([eq(purchaseReceipts.id, id)], 1);
    res.json({
      ok: true,
      receipt: full,
      message: (decision === "approved" ? "تم اعتماد الاستلام." : "سُجّل الخلاف على الاستلام.") + cashNote,
    });
  },
);
