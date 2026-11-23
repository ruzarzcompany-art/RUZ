/**
 * استلام من مورد بتصوير الفاتورة.
 *
 *   1. المستلِم يصوّر الفاتورة ← `analyzeInvoice` يقرؤها بنموذج رؤية ويطابق كل
 *      سطر بصنف من مخزون «سِجل»، فتُحفظ «مسوّدة» بالأصناف جاهزة.
 *   2. المستلِم يعدّ البضاعة ويؤكّد كل بند (ويصحّح الواصل فعلاً إن اختلف)
 *      ← `submitReceipt` فتصير «بانتظار المشرف» ويصله تنبيه.
 *   3. المشرف يعتمد أو يرفض ← `reviewReceipt`.
 *   4. المعتمد يبقى «بانتظار رفع المحاسب» حتى تصل فاتورة الشراء من فوديكس
 *      بالرقم نفسه ← `linkReceipts` يربطهما ويؤكّد استلام فوديكس بالكميات التي
 *      عدّها المستلِم، فلا يُطلب منه التأكيد مرة ثانية.
 *
 * لا يُنشئ هذا الملف حركة مخزون: رصيد «سِجل» يأتي من مستندات فوديكس وحدها،
 * وإدخال الفاتورة المصوَّرة هنا أيضاً كان سيحسبها مرتين عند رفع المحاسب.
 */

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { branches, employees, foodicsStockDocs, inventoryItems, supplierReceipts } from "../db/schema.js";
import { businessDateNow } from "./dayClose.js";
import { confirmStockDoc } from "./foodicsInventory.js";
import { createAlert } from "./routes/surveillance.js";
import { savePhoto } from "./routes/purchases.js";
import { round2 } from "./validate.js";
import { VISION_MODEL } from "./vision.js";

type BranchRow = typeof branches.$inferSelect;
type ReceiptRow = typeof supplierReceipts.$inferSelect;

/** نموذج قراءة الفواتير — يمكن رفعه لنموذج أدق من متغيّر البيئة دون تعديل الكود. */
const INVOICE_MODEL = process.env.INVOICE_VISION_MODEL?.trim() || VISION_MODEL;
/** أقصى عدد بنود في فاتورة واحدة. */
export const MAX_LINES = 60;
/** أقصى عدد فواتير يصوّرها الموظف الواحد في اليوم — يحمي رصيد التحليل. */
export const DAILY_ANALYZE_LIMIT = 25;

const round3 = (value: number) => Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000;

export const STATUS_LABELS: Record<string, string> = {
  draft: "صُوّرت ولم تُؤكَّد",
  pending: "بانتظار اعتماد المشرف",
  approved: "معتمد",
  rejected: "مرفوض",
};

export interface ReceiptLine {
  /** اسم الصنف كما هو مكتوب في الفاتورة */
  name: string;
  /** صنف «سِجل» المطابق — null إن لم يُعرف */
  itemId: number | null;
  itemName: string;
  unit: string;
  /** الكمية المكتوبة في الفاتورة */
  invoiceQty: number;
  /** الواصل فعلاً بعد العدّ */
  actualQty: number;
  unitPrice: number;
  lineTotal: number;
  /** أكّد المستلِم هذا البند بعد عدّه */
  confirmed: boolean;
  /** ثقة القراءة: high | medium | low */
  confidence: string;
}

export function parseLines(raw: string): ReceiptLine[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? (parsed as ReceiptLine[]) : [];
  } catch {
    return [];
  }
}

/** رقم الفاتورة موحَّداً للمقارنة: بلا مسافات ولا رموز ولا أصفار بادئة (INV-00123 = inv 123). */
export function normalizeInvoiceNumber(value: string): string {
  const latin = value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  return latin
    .replace(/[^0-9a-z\u0600-\u06ff]/gi, "")
    .toLowerCase()
    .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
}

/**
 * هل الرقمان لفاتورة واحدة؟ التطابق التام بعد التوحيد، أو تطابق الأرقام حين
 * يكتب أحد الطرفين الرقم بلا بادئته الحرفية (الفاتورة INV-123 والمحاسب كتب 123).
 */
export function sameInvoiceNumber(a: string, b: string): "exact" | "digits" | null {
  const na = normalizeInvoiceNumber(a);
  const nb = normalizeInvoiceNumber(b);
  if (!na || !nb) return null;
  if (na === nb) return "exact";
  const digits = (text: string) => text.replace(/\D/g, "");
  const letters = (text: string) => text.replace(/\d/g, "");
  const da = digits(na);
  if (da.length >= 3 && da === digits(nb) && (letters(na) === "" || letters(nb) === "")) return "digits";
  return null;
}

/* ── قراءة الفاتورة بالنموذج ───────────────────────────────────── */

export interface InvoiceReading {
  readable: boolean;
  note: string;
  supplier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  total: number;
  lines: ReceiptLine[];
}

let anthropic: Anthropic | undefined;

async function activeItems() {
  const db = getDb();
  return db
    .select({ id: inventoryItems.id, name: inventoryItems.name, unit: inventoryItems.unit, unitCost: inventoryItems.unitCost })
    .from(inventoryItems)
    .where(eq(inventoryItems.isActive, true))
    .orderBy(inventoryItems.name);
}

/** أصناف المخزون لقائمة الاختيار في الشاشة (لتصحيح مطابقة سطر أو إضافة بند). */
export async function receiptItems() {
  return (await activeItems()).map((item) => ({ id: item.id, name: item.name, unit: item.unit }));
}

export async function analyzeInvoice(image: Buffer, contentType: string): Promise<InvoiceReading> {
  anthropic ??= new Anthropic();
  const items = await activeItems();
  const byId = new Map(items.map((item) => [item.id, item]));
  const catalog = items.map((item) => `${item.id}\t${item.name}\t${item.unit}`).join("\n");

  const message = await anthropic.messages.create({
    model: INVOICE_MODEL,
    max_tokens: 4000,
    tools: [
      {
        name: "report_invoice",
        description: "Report the contents of one supplier invoice photo.",
        input_schema: {
          type: "object",
          properties: {
            readable: { type: "boolean", description: "false if the photo is not a readable invoice / delivery note" },
            note: { type: "string", description: "short Arabic note about anything unclear" },
            supplier: { type: "string" },
            invoiceNumber: { type: "string" },
            invoiceDate: { type: "string", description: "YYYY-MM-DD (Gregorian) or empty" },
            total: { type: "number", description: "grand total payable including VAT, 0 if not visible" },
            lines: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "item name exactly as written on the invoice" },
                  itemId: { type: ["integer", "null"], description: "id of the matching inventory item, or null" },
                  quantity: { type: "number" },
                  unit: { type: "string" },
                  unitPrice: { type: "number" },
                  lineTotal: { type: "number" },
                  confidence: { type: "string", enum: ["high", "medium", "low"] },
                },
                required: ["name", "quantity", "confidence"],
              },
            },
          },
          required: ["readable", "lines"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "report_invoice" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: contentType as "image/jpeg", data: image.toString("base64") },
          },
          {
            type: "text",
            text: [
              "This is a photo of a supplier invoice or delivery note received by a restaurant in Saudi Arabia (Arabic and/or English, printed or handwritten).",
              "Read it and call report_invoice.",
              "",
              "Rules:",
              "- One entry per item line, in the order written. Do not include totals, VAT, discount or delivery rows as lines.",
              "- quantity is the delivered quantity written on the invoice, in the unit written on it. Convert Arabic-Indic digits to Western digits.",
              "- Never invent a line or a number. If a value is unreadable use 0 and set confidence to low.",
              "- invoiceDate must be Gregorian YYYY-MM-DD; convert a Hijri date only if you are sure, otherwise leave it empty.",
              "- itemId: choose the id of the inventory item below that is clearly the same product (same thing, even if the wording or language differs). If no item clearly matches, use null. Do not force a match.",
              "",
              "Inventory items (id<TAB>name<TAB>unit):",
              catalog || "(none)",
            ].join("\n"),
          },
        ],
      },
    ],
  });

  const block = message.content.find((item) => item.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("لم يُرجع نموذج القراءة نتيجة");
  const raw = block.input as Record<string, unknown>;
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const amount = (value: unknown) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 && num < 10_000_000 ? num : 0;
  };
  const date = text(raw.invoiceDate, 10);
  const levels = ["high", "medium", "low"];

  const lines: ReceiptLine[] = (Array.isArray(raw.lines) ? raw.lines : []).slice(0, MAX_LINES).map((entry) => {
    const line = (entry ?? {}) as Record<string, unknown>;
    const item = byId.get(Number(line.itemId));
    const quantity = round3(amount(line.quantity));
    const unitPrice = round2(amount(line.unitPrice));
    return {
      name: text(line.name, 200) || item?.name || "صنف غير مقروء",
      itemId: item?.id ?? null,
      itemName: item?.name ?? "",
      unit: text(line.unit, 40) || item?.unit || "",
      invoiceQty: quantity,
      actualQty: quantity,
      unitPrice,
      lineTotal: round2(amount(line.lineTotal) || quantity * unitPrice),
      confirmed: false,
      confidence: levels.includes(String(line.confidence)) ? String(line.confidence) : "low",
    };
  });

  return {
    readable: raw.readable !== false && lines.length > 0,
    note: text(raw.note, 300),
    supplier: text(raw.supplier, 160),
    invoiceNumber: text(raw.invoiceNumber, 80),
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    total: round2(amount(raw.total)),
    lines,
  };
}

/* ── المسوّدة: الصورة + القراءة ─────────────────────────────────── */

export async function analyzedToday(employeeId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(supplierReceipts)
    .where(and(eq(supplierReceipts.receivedByEmployeeId, employeeId), gte(supplierReceipts.createdAt, new Date(Date.now() - 86_400_000))));
  return row?.count ?? 0;
}

export async function createDraft(input: {
  branch: BranchRow;
  employeeId: number;
  source: string;
  verifyMethod: string;
  photo: { data: Buffer; contentType: string };
}) {
  const db = getDb();
  const today = businessDateNow(input.branch.timezone);

  let reading: InvoiceReading | null = null;
  let aiNote = "";
  try {
    reading = await analyzeInvoice(input.photo.data, input.photo.contentType);
    aiNote = reading.note;
  } catch (error) {
    console.error("[supplier-receipt] قراءة الفاتورة:", (error as Error).message);
    aiNote = "تعذّرت القراءة الآلية للفاتورة — أضف الأصناف يدوياً.";
  }

  // تاريخ مستقبلي أو قديم جداً = خطأ قراءة فيُهمل
  const invoiceDate = reading?.invoiceDate && reading.invoiceDate <= today && reading.invoiceDate >= `${Number(today.slice(0, 4)) - 1}${today.slice(4)}` ? reading.invoiceDate : null;

  const [draft] = await db
    .insert(supplierReceipts)
    .values({
      branchId: input.branch.id,
      businessDate: today,
      source: input.source,
      verifyMethod: input.verifyMethod,
      status: "draft",
      supplier: reading?.supplier ?? "",
      invoiceNumber: reading?.invoiceNumber ?? "",
      invoiceDate,
      invoiceTotal: reading?.total ?? 0,
      linesJson: JSON.stringify(reading?.lines ?? []),
      aiNote,
      receivedByEmployeeId: input.employeeId,
    })
    .returning();
  if (!draft) return null;

  let photoKey = "";
  try {
    photoKey = `supplier-receipt-${draft.id}-${Date.now()}`;
    await savePhoto(photoKey, input.photo.data, input.photo.contentType);
    await db.update(supplierReceipts).set({ photoKey }).where(eq(supplierReceipts.id, draft.id));
  } catch (error) {
    console.error("[supplier-receipt] حفظ الصورة:", (error as Error).message);
    photoKey = "";
  }

  return { draft: { ...draft, photoKey }, readable: reading?.readable ?? false, aiNote };
}

/* ── تأكيد المستلِم ─────────────────────────────────────────────── */

export interface SubmitInput {
  id: number;
  employeeId: number;
  supplier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  invoiceTotal: number;
  notes: string;
  lines: ReceiptLine[];
}

export async function submitReceipt(input: SubmitInput) {
  const db = getDb();
  const [draft] = await db.select().from(supplierReceipts).where(eq(supplierReceipts.id, input.id));
  if (!draft) return { error: "الاستلام غير موجود", status: 404 };
  if (draft.receivedByEmployeeId !== input.employeeId) return { error: "هذا الاستلام صوّره موظف آخر", status: 403 };
  if (draft.status !== "draft") return { error: "أُرسل هذا الاستلام مسبقاً", status: 409 };

  // الفاتورة تُستلم مرة واحدة في الفرع
  const wanted = normalizeInvoiceNumber(input.invoiceNumber);
  if (wanted) {
    const others = await db
      .select({ id: supplierReceipts.id, invoiceNumber: supplierReceipts.invoiceNumber, businessDate: supplierReceipts.businessDate, supplier: supplierReceipts.supplier })
      .from(supplierReceipts)
      .where(and(eq(supplierReceipts.branchId, draft.branchId), inArray(supplierReceipts.status, ["pending", "approved"]), ne(supplierReceipts.id, draft.id)));
    const duplicate = others.find(
      (other) => normalizeInvoiceNumber(other.invoiceNumber) === wanted && (!other.supplier || !input.supplier || other.supplier === input.supplier),
    );
    if (duplicate) {
      return { error: `الفاتورة رقم ${input.invoiceNumber} مستلَمة مسبقاً بتاريخ ${duplicate.businessDate} — تُستلم مرة واحدة.`, status: 409 };
    }
  }

  const diffs = input.lines.filter((line) => line.actualQty !== line.invoiceQty);
  const [saved] = await db
    .update(supplierReceipts)
    .set({
      status: "pending",
      supplier: input.supplier,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      invoiceTotal: input.invoiceTotal,
      notes: input.notes,
      linesJson: JSON.stringify(input.lines),
      diffCount: diffs.length,
      submittedAt: new Date(),
    })
    .where(and(eq(supplierReceipts.id, draft.id), eq(supplierReceipts.status, "draft")))
    .returning();
  if (!saved) return { error: "أُرسل هذا الاستلام مسبقاً", status: 409 };

  const [receiver] = await db.select({ name: employees.fullName }).from(employees).where(eq(employees.id, input.employeeId));
  const diffText = diffs.length
    ? ` فروق عن الفاتورة: ${diffs.map((line) => `${line.itemName || line.name}: الفاتورة ${line.invoiceQty} — الواصل ${line.actualQty}`).join("، ")}.`
    : " الكميات مطابقة للفاتورة.";
  await createAlert({
    branchId: saved.branchId,
    alertType: "receipt_pending_approval",
    occurredAt: new Date(),
    location: "المستودع",
    employeeIds: [input.employeeId],
    confidence: "high",
    details:
      `استلام من مورد رقم ${saved.id}: ${saved.supplier || "مورد غير مسمّى"}${saved.invoiceNumber ? ` — فاتورة ${saved.invoiceNumber}` : ""}` +
      `${saved.invoiceTotal ? ` بقيمة ${saved.invoiceTotal} ريال` : ""}، ${input.lines.length} صنف، استلمه ${receiver?.name ?? "موظف"}.${diffText} بانتظار اعتمادك.`,
    source: "auto",
    sourceRef: `supplier-receipt:${saved.id}`,
    customerText: true,
  }).catch((error) => console.error("[supplier-receipt] تنبيه المشرف:", error));

  return { receipt: saved, diffs: diffs.length };
}

/* ── اعتماد المشرف ─────────────────────────────────────────────── */

export async function reviewReceipt(input: { id: number; reviewerId: number; decision: "approve" | "reject"; note: string }) {
  const db = getDb();
  const [before] = await db.select().from(supplierReceipts).where(eq(supplierReceipts.id, input.id));
  if (!before) return { error: "الاستلام غير موجود", status: 404 };
  if (before.status !== "pending") return { error: "هذا الاستلام ليس بانتظار الاعتماد", status: 409 };

  const [saved] = await db
    .update(supplierReceipts)
    .set({
      status: input.decision === "approve" ? "approved" : "rejected",
      reviewedByEmployeeId: input.reviewerId,
      reviewedAt: new Date(),
      reviewNote: input.note,
    })
    .where(and(eq(supplierReceipts.id, before.id), eq(supplierReceipts.status, "pending")))
    .returning();
  if (!saved) return { error: "هذا الاستلام ليس بانتظار الاعتماد", status: 409 };

  let linked = 0;
  if (saved.status === "approved") {
    linked = await linkReceipts(saved.branchId).catch((error) => {
      console.error("[supplier-receipt] ربط فوديكس:", error);
      return 0;
    });
  }
  const [fresh] = await db.select().from(supplierReceipts).where(eq(supplierReceipts.id, saved.id));
  return { receipt: fresh ?? saved, linked: linked > 0 && Boolean(fresh?.foodicsDocId) };
}

/* ── الربط مع فاتورة فوديكس بعد رفع المحاسب ─────────────────────── */

interface DocLine {
  name: string;
  sku: string;
  unit: string;
  ordered: number;
  received: number;
}

/**
 * يربط كل استلام معتمد لم يُربط بعد بمستند الشراء في فوديكس الذي يحمل رقم
 * الفاتورة نفسه، ثم يؤكّد استلام ذلك المستند بالكميات التي عدّها المستلِم
 * (إن كان ما زال بانتظار التأكيد). يُستدعى عند الاعتماد وبعد كل مزامنة.
 */
export async function linkReceipts(branchId: number): Promise<number> {
  const db = getDb();
  const open = await db
    .select()
    .from(supplierReceipts)
    .where(and(eq(supplierReceipts.branchId, branchId), eq(supplierReceipts.status, "approved"), isNull(supplierReceipts.foodicsDocId), ne(supplierReceipts.invoiceNumber, "")))
    .orderBy(desc(supplierReceipts.id))
    .limit(60);
  if (!open.length) return 0;

  const oldest = open.reduce((min, r) => (r.businessDate < min ? r.businessDate : min), open[0].businessDate);
  const since = new Date(new Date(`${oldest}T12:00:00Z`).getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
  const docs = await db
    .select()
    .from(foodicsStockDocs)
    .where(and(eq(foodicsStockDocs.branchId, branchId), eq(foodicsStockDocs.kind, "purchase"), ne(foodicsStockDocs.invoiceNumber, ""), ne(foodicsStockDocs.state, "cancelled"), gte(foodicsStockDocs.businessDate, since)));
  if (!docs.length) return 0;

  const taken = new Set(
    (
      await db
        .select({ docId: supplierReceipts.foodicsDocId })
        .from(supplierReceipts)
        .where(and(eq(supplierReceipts.branchId, branchId), sql`${supplierReceipts.foodicsDocId} is not null`))
    ).map((row) => row.docId),
  );
  const itemIds = [...new Set(open.flatMap((r) => parseLines(r.linesJson).map((l) => l.itemId)).filter((id): id is number => Boolean(id)))];
  const codes = itemIds.length
    ? new Map((await db.select({ id: inventoryItems.id, code: inventoryItems.code }).from(inventoryItems).where(inArray(inventoryItems.id, itemIds))).map((i) => [i.id, i.code]))
    : new Map<number, string>();

  let linked = 0;
  for (const receipt of open) {
    // الأقرب إجمالاً بين المستندات التي تحمل الرقم نفسه. التطابق بالأرقام وحدها
    // (المحاسب كتب الرقم بلا بادئته الحرفية) يُقبل إن تقارب التاريخان أو الإجماليان
    const receiptDate = receipt.invoiceDate ?? receipt.businessDate;
    const nearDate = (date: string | null) => date !== null && Math.abs(new Date(`${date}T12:00:00Z`).getTime() - new Date(`${receiptDate}T12:00:00Z`).getTime()) <= 3 * 86_400_000;
    const closeTotals = (total: number) =>
      receipt.invoiceTotal > 0 && total > 0 && [1, 1.15, 1 / 1.15].some((target) => Math.abs(total / receipt.invoiceTotal - target) <= 0.03);
    const doc = docs
      .filter((d) => {
        if (taken.has(d.id)) return false;
        const match = sameInvoiceNumber(d.invoiceNumber, receipt.invoiceNumber);
        return match === "exact" || (match === "digits" && (nearDate(d.invoiceDate ?? d.businessDate) || closeTotals(d.total)));
      })
      .sort((x, y) => Math.abs(x.total - receipt.invoiceTotal) - Math.abs(y.total - receipt.invoiceTotal))[0];
    if (!doc) continue;
    taken.add(doc.id);
    await db.update(supplierReceipts).set({ foodicsDocId: doc.id, foodicsLinkedAt: new Date() }).where(eq(supplierReceipts.id, receipt.id));
    linked++;

    // المطابقة الكاملة: كل صنف في الاستلام مقابل سطره في فاتورة فوديكس، والعكس، والإجمالي
    const docLines = JSON.parse(doc.itemsJson || "[]") as DocLine[];
    const awaiting = doc.confirmStatus === "awaiting" && Boolean(receipt.receivedByEmployeeId);
    const used = new Set<DocLine>();
    const diffs: Array<{ sku: string; name: string; actual: number }> = [];
    const issues: string[] = [];
    for (const line of parseLines(receipt.linesJson)) {
      const label = line.itemName || line.name;
      const code = line.itemId ? codes.get(line.itemId) ?? "" : "";
      const match = docLines.find((d) => !used.has(d) && ((code && d.sku === code) || d.name === line.itemName || d.name === line.name));
      if (!match) {
        if (line.actualQty > 0) issues.push(`${label}: استُلم ${line.actualQty} ${line.unit} وليس في فاتورة فوديكس`);
        continue;
      }
      used.add(match);
      const expected = match.received || match.ordered;
      if (round3(line.actualQty) === round3(expected)) continue;
      diffs.push({ sku: match.sku, name: match.name, actual: line.actualQty });
      // فرق الكمية يبلّغه تأكيد استلام فوديكس نفسه؛ هنا فقط إن كان المستند مؤكَّداً من قبل
      if (!awaiting) issues.push(`${match.name}: فوديكس ${expected} ${match.unit} — الواصل فعلاً ${line.actualQty}`);
    }
    for (const d of docLines) {
      const quantity = d.received || d.ordered;
      if (!used.has(d) && quantity > 0) issues.push(`${d.name}: في فوديكس ${quantity} ${d.unit} ولم يُسجَّل في الاستلام`);
    }
    // فرق الإجمالي — ما لم يفسّره احتساب ضريبة القيمة المضافة (15٪) في أحد الطرفين
    if (receipt.invoiceTotal > 0 && doc.total > 0) {
      const ratio = doc.total / receipt.invoiceTotal;
      const near = (target: number) => Math.abs(ratio - target) <= 0.03;
      if (Math.abs(doc.total - receipt.invoiceTotal) > 2 && !near(1) && !near(1.15) && !near(1 / 1.15)) {
        issues.push(`الإجمالي: الفاتورة المصوَّرة ${receipt.invoiceTotal} ريال — فوديكس ${doc.total} ريال`);
      }
    }

    // استلام فوديكس ما زال ينتظر التأكيد: يُؤكَّد بما عدّه المستلِم فعلاً (وفرق الكمية يصل المالك منه)
    if (awaiting) {
      await confirmStockDoc({
        docId: doc.id,
        employeeId: receipt.receivedByEmployeeId!,
        branchId,
        canManage: false,
        diffs,
        note: `من استلام المورد المصوَّر رقم ${receipt.id}`,
      }).catch((error) => console.error("[supplier-receipt] تأكيد استلام فوديكس:", error));
    }

    if (issues.length) {
      await createAlert({
        branchId,
        alertType: "receipt_mismatch",
        occurredAt: new Date(),
        location: "المستودع",
        employeeIds: receipt.receivedByEmployeeId ? [receipt.receivedByEmployeeId] : [],
        confidence: "high",
        details:
          `مطابقة فاتورة فوديكس رقم ${doc.reference}${doc.party ? ` (${doc.party})` : ""}${doc.enteredBy ? ` — أدخلها ${doc.enteredBy}` : ""} ` +
          `مع استلام المورد المصوَّر رقم ${receipt.id} (فاتورة ${receipt.invoiceNumber}): ${issues.join("، ")}.`.slice(0, 1500),
        source: "auto",
        sourceRef: `supplier-receipt-match:${receipt.id}`,
      }).catch((error) => console.error("[supplier-receipt] تنبيه المطابقة:", error));
    }
  }
  return linked;
}

/* ── القراءة للشاشات ───────────────────────────────────────────── */

export function receiptView(r: ReceiptRow, names: Map<number, string>, docs: Map<number, { reference: string }>) {
  const doc = r.foodicsDocId ? docs.get(r.foodicsDocId) : undefined;
  const upload =
    r.status !== "approved" ? "" : r.foodicsDocId ? `مرفوعة في فوديكس${doc ? ` (${doc.reference})` : ""}` : "بانتظار رفع المحاسب في فوديكس";
  return {
    id: r.id,
    branchId: r.branchId,
    businessDate: r.businessDate,
    source: r.source,
    verifyMethod: r.verifyMethod,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] ?? r.status,
    supplier: r.supplier,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    invoiceTotal: r.invoiceTotal,
    lines: parseLines(r.linesJson),
    diffCount: r.diffCount,
    hasPhoto: r.photoKey !== "",
    aiNote: r.aiNote,
    notes: r.notes,
    receivedBy: r.receivedByEmployeeId ? names.get(r.receivedByEmployeeId) ?? "" : "",
    submittedAt: r.submittedAt,
    reviewedBy: r.reviewedByEmployeeId ? names.get(r.reviewedByEmployeeId) ?? "" : "",
    reviewedAt: r.reviewedAt,
    reviewNote: r.reviewNote,
    uploaded: Boolean(r.foodicsDocId),
    uploadLabel: upload,
    createdAt: r.createdAt,
  };
}

async function decorate(rows: ReceiptRow[]) {
  const db = getDb();
  const employeeIds = [...new Set(rows.flatMap((r) => [r.receivedByEmployeeId, r.reviewedByEmployeeId]).filter((id): id is number => Boolean(id)))];
  const docIds = [...new Set(rows.map((r) => r.foodicsDocId).filter((id): id is number => Boolean(id)))];
  const names = employeeIds.length
    ? new Map((await db.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, employeeIds))).map((e) => [e.id, e.name]))
    : new Map<number, string>();
  const docs = docIds.length
    ? new Map((await db.select({ id: foodicsStockDocs.id, reference: foodicsStockDocs.reference }).from(foodicsStockDocs).where(inArray(foodicsStockDocs.id, docIds))).map((d) => [d.id, { reference: d.reference }]))
    : new Map<number, { reference: string }>();
  return rows.map((r) => receiptView(r, names, docs));
}

export async function viewOf(row: ReceiptRow) {
  return (await decorate([row]))[0];
}

/** استلاماتي في آخر 3 أيام (بلا المسوّدات المتروكة). */
export async function myReceipts(employeeId: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(supplierReceipts)
    .where(and(eq(supplierReceipts.receivedByEmployeeId, employeeId), ne(supplierReceipts.status, "draft"), gte(supplierReceipts.createdAt, new Date(Date.now() - 3 * 86_400_000))))
    .orderBy(desc(supplierReceipts.id))
    .limit(20);
  return decorate(rows);
}

export async function receiptsReport(branch: BranchRow, from: string, to: string, status: string) {
  const db = getDb();
  const conds = [eq(supplierReceipts.branchId, branch.id), gte(supplierReceipts.businessDate, from), lte(supplierReceipts.businessDate, to), ne(supplierReceipts.status, "draft")];
  if (["pending", "approved", "rejected"].includes(status)) conds.push(eq(supplierReceipts.status, status));
  const rows = await db.select().from(supplierReceipts).where(and(...conds)).orderBy(desc(supplierReceipts.id)).limit(300);
  const receipts = await decorate(rows);
  // «بانتظار الرفع» فلتر مشتقّ: معتمد ولم تصل فاتورته من فوديكس
  const list = status === "awaiting_upload" ? receipts.filter((r) => r.status === "approved" && !r.uploaded) : receipts;
  return {
    from,
    to,
    branchName: branch.name,
    receipts: list,
    totals: {
      count: list.length,
      pending: receipts.filter((r) => r.status === "pending").length,
      awaitingUpload: receipts.filter((r) => r.status === "approved" && !r.uploaded).length,
      uploaded: receipts.filter((r) => r.uploaded).length,
      withDiffs: receipts.filter((r) => r.status !== "rejected" && r.diffCount > 0).length,
      value: round2(list.filter((r) => r.status !== "rejected").reduce((sum, r) => sum + r.invoiceTotal, 0)),
    },
  };
}
