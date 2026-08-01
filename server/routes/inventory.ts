import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  employees,
  inventoryItems,
  inventoryMovements,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  PERMISSIONS,
  hasAnyPermission,
  hasModuleDelete,
  hasModuleLevel,
  requireModuleDelete,
  requireModuleLevel,
  requirePermission,
} from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { asDateOnly, asEnum, asId, asNumber, asString, round2 } from "../validate.js";

export const inventoryRouter = Router();

const MOVEMENT_TYPES = ["in", "out", "count", "manufacture"] as const;
const REASONS = [
  "purchase",
  "consumption",
  "waste",
  "transfer",
  "stocktake",
  "manufacture",
  "other",
] as const;

/** تقريب بأربع منازل — وزن الوحدة قد يكون كسراً دقيقاً (جرامات من كيلو). */
function round4(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 10_000) / 10_000;
}

/**
 * التصنيع يربط ثلاثة أرقام: الكمية الخام ÷ عدد الوحدات = وزن الوحدة.
 * إدخال أي رقمين يُكمل الثالث، وإدخال الخام وحده يمرّ كما هو (عدد الوحدات
 * يُسجَّل لاحقاً) — لا يتوقف النظام في أي من الحالتين.
 */
export function resolveManufacturing(input: {
  rawQuantity: number | null;
  producedUnits: number | null;
  unitWeight: number | null;
}): { rawQuantity: number; producedUnits: number; unitWeight: number } {
  let raw = input.rawQuantity !== null && input.rawQuantity > 0 ? input.rawQuantity : 0;
  let units = input.producedUnits !== null && input.producedUnits > 0 ? input.producedUnits : 0;
  let weight = input.unitWeight !== null && input.unitWeight > 0 ? input.unitWeight : 0;

  if (raw > 0 && units > 0) weight = round4(raw / units);
  else if (raw > 0 && weight > 0) units = round2(raw / weight);
  else if (units > 0 && weight > 0) raw = round2(units * weight);

  return { rawQuantity: round2(raw), producedUnits: round2(units), unitWeight: round4(weight) };
}

/** أقصى عدد حركات تُقرأ لحساب الأرصدة (حماية من استعلام ضخم). */
const BALANCE_SCAN_LIMIT = 20_000;

/**
 * الرصيد الحالي لكل صنف في فرع: نمرّ على الحركات مرتّبة زمنياً،
 * فحركة الجرد (`count`) تُثبّت الرصيد على الكمية المعدودة، والإدخال
 * يزيد والإخراج يُنقص. هذا يجعل الجرد مصدر الحقيقة عند أي فرق.
 */
export async function computeBalances(branchId: number): Promise<
  Map<number, { balance: number; lastMovementDate: string | null; lastCountDate: string | null }>
> {
  const db = getDb();
  const rows = await db
    .select({
      itemId: inventoryMovements.itemId,
      movementType: inventoryMovements.movementType,
      quantity: inventoryMovements.quantity,
      businessDate: inventoryMovements.businessDate,
    })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.branchId, branchId))
    .orderBy(asc(inventoryMovements.businessDate), asc(inventoryMovements.id))
    .limit(BALANCE_SCAN_LIMIT);

  const balances = new Map<
    number,
    { balance: number; lastMovementDate: string | null; lastCountDate: string | null }
  >();

  for (const row of rows) {
    const current =
      balances.get(row.itemId) ??
      { balance: 0, lastMovementDate: null, lastCountDate: null };

    if (row.movementType === "count") {
      current.balance = row.quantity;
      current.lastCountDate = row.businessDate;
    } else if (row.movementType === "in") {
      current.balance += row.quantity;
    } else {
      // الإخراج والتصنيع كلاهما يستهلك من رصيد الصنف
      current.balance -= row.quantity;
    }

    current.lastMovementDate = row.businessDate;
    current.balance = round2(current.balance);
    balances.set(row.itemId, current);
  }

  return balances;
}

/**
 * إنشاء حركة إضافة المنتج النهائي المقابلة لحركة تصنيع.
 *
 * تكلفة الوحدة المنتجة = تكلفة الخام المستهلك ÷ عدد الوحدات، وهي التكلفة
 * الحقيقية للوحدة الواحدة. والمنتج ذو السعر المتغيّر يأخذ هذه التكلفة سعراً
 * لوحدته (كما يفعل الشراء بفاتورته)، أما ثابت السعر فيبقى على سعره المعرّف.
 */
async function createProducedMovement(input: {
  rawMovementId: number;
  branchId: number;
  producedItem: { id: number; unitCost: number; priceMode: string };
  businessDate: string;
  producedUnits: number;
  unitWeight: number;
  rawTotalCost: number;
  reference: string;
  notes: string;
  actorId: number;
  ipAddress: string;
}) {
  const db = getDb();
  const isVariable = input.producedItem.priceMode === "variable";
  const derivedCost =
    input.producedUnits > 0 ? round2(input.rawTotalCost / input.producedUnits) : 0;
  const unitCost = isVariable && derivedCost > 0 ? derivedCost : input.producedItem.unitCost;

  const [movement] = await db
    .insert(inventoryMovements)
    .values({
      branchId: input.branchId,
      itemId: input.producedItem.id,
      movementType: "in",
      businessDate: input.businessDate,
      quantity: input.producedUnits,
      unitCost,
      totalCost: round2(input.producedUnits * unitCost),
      reason: "manufacture",
      reference: input.reference,
      variance: 0,
      producedUnits: 0,
      unitWeight: input.unitWeight,
      linkedMovementId: input.rawMovementId,
      notes: input.notes,
      createdByEmployeeId: input.actorId,
    })
    .returning();

  await recordAudit({
    actorEmployeeId: input.actorId,
    action: "inventory.movement.manufacture_output",
    entityType: "inventory_movements",
    entityId: movement?.id ?? null,
    after: movement,
    ipAddress: input.ipAddress,
  });

  let itemCostUpdated = false;
  if (isVariable && derivedCost > 0 && derivedCost !== input.producedItem.unitCost) {
    await db
      .update(inventoryItems)
      .set({ unitCost: derivedCost, updatedAt: new Date() })
      .where(eq(inventoryItems.id, input.producedItem.id));

    itemCostUpdated = true;
    await recordAudit({
      actorEmployeeId: input.actorId,
      action: "inventory.item.cost_from_manufacturing",
      entityType: "inventory_items",
      entityId: input.producedItem.id,
      before: { unitCost: input.producedItem.unitCost },
      after: { unitCost: derivedCost, movementId: movement?.id ?? null },
      ipAddress: input.ipAddress,
    });
  }

  return { movement, unitCost, itemCostUpdated };
}

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

/* ── الأصناف والأرصدة ──────────────────────────────────────────── */

inventoryRouter.get(
  "/inventory/items",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const branchId = asId(req.query.branchId) ?? actor.branchId ?? null;

    const items = await db
      .select()
      .from(inventoryItems)
      .orderBy(asc(inventoryItems.code));

    const balances = branchId === null ? new Map() : await computeBalances(branchId);

    res.json({
      ok: true,
      branchId,
      items: items.map((item) => {
        const state = balances.get(item.id);
        const balance = state?.balance ?? 0;
        return {
          ...item,
          balance,
          lastMovementDate: state?.lastMovementDate ?? null,
          lastCountDate: state?.lastCountDate ?? null,
          belowMinimum: balance < item.minQuantity,
          stockValue: round2(balance * item.unitCost),
        };
      }),
      meta: { movementTypes: MOVEMENT_TYPES, reasons: REASONS },
    });
  },
);

/* ── حركة المخزون اليومية ──────────────────────────────────────── */

inventoryRouter.post(
  "/inventory/movements",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryWrite),
  requireModuleLevel("inventory_movements", 2),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const itemId = asId(body.itemId);
    if (itemId === null) {
      res.status(400).json({ ok: false, error: "اختر الصنف" });
      return;
    }

    const [item] = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId))
      .limit(1);

    if (!item) {
      res.status(404).json({ ok: false, error: "الصنف غير موجود" });
      return;
    }

    const branchId = asId(body.branchId) ?? actor.branchId ?? null;
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "اختر الفرع" });
      return;
    }

    const movementType = asEnum(body.movementType, MOVEMENT_TYPES) ?? "in";
    const timezone = await branchTimezone(branchId);
    const businessDate = asDateOnly(body.businessDate) ?? isoDateInZone(new Date(), timezone);

    if (businessDate > isoDateInZone(new Date(), timezone)) {
      res.status(400).json({ ok: false, error: "لا يمكن تسجيل حركة بتاريخ مستقبلي" });
      return;
    }

    /**
     * التصنيع: يُستهلك الخام من هذا الصنف ويُضاف المنتج النهائي إلى صنف آخر،
     * والحركتان تُنشآن معاً ومرتبطتين. عدد الوحدات قد يبقى بلا تسجيل الآن
     * فيُكمَّل لاحقاً عبر `PATCH /inventory/movements/:id/production`.
     */
    const isManufacture = movementType === "manufacture";
    const producedItemId = isManufacture ? asId(body.producedItemId) : null;

    let producedItem: typeof item | null = null;
    if (isManufacture) {
      if (producedItemId === null) {
        res.status(400).json({ ok: false, error: "اختر المنتج النهائي الناتج عن التصنيع" });
        return;
      }
      if (producedItemId === itemId) {
        res.status(400).json({
          ok: false,
          error: "المنتج النهائي لا يمكن أن يكون المادة الخام نفسها",
        });
        return;
      }

      const [found] = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, producedItemId))
        .limit(1);

      if (!found) {
        res.status(404).json({ ok: false, error: "المنتج النهائي غير موجود" });
        return;
      }
      producedItem = found;
    }

    const manufacturing = isManufacture
      ? resolveManufacturing({
          rawQuantity: asNumber(body.quantity),
          producedUnits: asNumber(body.producedUnits),
          unitWeight: asNumber(body.unitWeight),
        })
      : null;

    const quantityRaw = manufacturing ? manufacturing.rawQuantity : asNumber(body.quantity);
    if (quantityRaw === null || quantityRaw < 0) {
      res.status(400).json({ ok: false, error: "الكمية يجب أن تكون رقماً غير سالب" });
      return;
    }
    if (manufacturing && quantityRaw <= 0) {
      res.status(400).json({
        ok: false,
        error: "أدخل الكمية الخام، أو عدد الوحدات المنتجة مع وزن الوحدة",
      });
      return;
    }
    const quantity = round2(quantityRaw);

    const reason =
      asEnum(body.reason, REASONS) ??
      (movementType === "count"
        ? "stocktake"
        : movementType === "in"
          ? "purchase"
          : isManufacture
            ? "manufacture"
            : "consumption");

    const unitCostRaw = asNumber(body.unitCost);
    const invoiceCost = unitCostRaw === null || unitCostRaw < 0 ? null : round2(unitCostRaw);

    /**
     * الصنف ذو السعر المتغيّر يأخذ سعره من فاتورة الشراء: كل حركة إدخال شراء
     * يجب أن تحمل سعر وحدة الفاتورة، وآخر سعر شراء يصبح سعر الوحدة المحتسب
     * للصنف. الصنف ذو السعر الثابت يبقى على سعره المُعرَّف إن لم يُرسل سعر.
     */
    const isVariable = item.priceMode === "variable";
    const isPurchaseIn = movementType === "in" && reason === "purchase";

    if (isVariable && isPurchaseIn && invoiceCost === null) {
      res.status(400).json({
        ok: false,
        error: "سعر هذا الصنف متغيّر: أدخل سعر الوحدة من فاتورة الشراء",
      });
      return;
    }

    const unitCost = invoiceCost ?? item.unitCost;

    // فرق الجرد عن الرصيد الدفتري — يُحسب في الخادم لا في المتصفح
    const balances = await computeBalances(branchId);
    const bookBalance = balances.get(itemId)?.balance ?? 0;
    const variance = movementType === "count" ? round2(quantity - bookBalance) : 0;

    const reference = asString(body.reference, 120) ?? "";
    const notes = asString(body.notes, 1000) ?? "";
    const totalCost = round2(quantity * unitCost);

    const [saved] = await db
      .insert(inventoryMovements)
      .values({
        branchId,
        itemId,
        movementType,
        businessDate,
        quantity,
        unitCost,
        totalCost,
        reason,
        reference,
        variance,
        producedItemId,
        producedUnits: manufacturing?.producedUnits ?? 0,
        unitWeight: manufacturing?.unitWeight ?? 0,
        notes,
        createdByEmployeeId: actor.id,
      })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: `inventory.movement.${movementType}`,
      entityType: "inventory_movements",
      entityId: saved?.id ?? null,
      after: saved,
      ipAddress: clientIp(req),
    });

    /**
     * التصنيع يُنشئ حركتين مرتبطتين: خصم الخام (أعلاه) وإضافة المنتج. وإن لم
     * يُسجَّل عدد الوحدات بعد، يُكتفى بخصم الخام ويُكمل العدد لاحقاً.
     */
    let producedMovement: Awaited<ReturnType<typeof createProducedMovement>>["movement"] | null =
      null;
    let producedUnitCost: number | null = null;
    let producedCostUpdated = false;

    if (saved && manufacturing && producedItem && manufacturing.producedUnits > 0) {
      const created = await createProducedMovement({
        rawMovementId: saved.id,
        branchId,
        producedItem,
        businessDate,
        producedUnits: manufacturing.producedUnits,
        unitWeight: manufacturing.unitWeight,
        rawTotalCost: totalCost,
        reference,
        notes,
        actorId: actor.id,
        ipAddress: clientIp(req),
      });

      producedMovement = created.movement;
      producedUnitCost = created.unitCost;
      producedCostUpdated = created.itemCostUpdated;

      if (created.movement) {
        await db
          .update(inventoryMovements)
          .set({ linkedMovementId: created.movement.id, updatedAt: new Date() })
          .where(eq(inventoryMovements.id, saved.id));
        saved.linkedMovementId = created.movement.id;
      }
    }

    // السعر المتغيّر: آخر فاتورة شراء تُحدّث سعر وحدة الصنف لتقييم المخزون
    let itemCostUpdated = false;
    if (isVariable && isPurchaseIn && invoiceCost !== null && invoiceCost !== item.unitCost) {
      await db
        .update(inventoryItems)
        .set({ unitCost: invoiceCost, updatedAt: new Date() })
        .where(eq(inventoryItems.id, itemId));

      itemCostUpdated = true;
      await recordAudit({
        actorEmployeeId: actor.id,
        action: "inventory.item.cost_from_invoice",
        entityType: "inventory_items",
        entityId: itemId,
        before: { unitCost: item.unitCost },
        after: { unitCost: invoiceCost, movementId: saved?.id ?? null },
        ipAddress: clientIp(req),
      });
    }

    let message = "تم تسجيل الحركة";
    if (movementType === "count") {
      message = `تم تسجيل الجرد. الفرق عن الرصيد الدفتري: ${variance}`;
    } else if (isManufacture && manufacturing) {
      const consumed = `خُصم ${manufacturing.rawQuantity} ${item.unit} من «${item.name}»`;
      message =
        manufacturing.producedUnits > 0
          ? `تم تسجيل التصنيع: ${consumed} وأُضيف ${manufacturing.producedUnits} ${
              producedItem?.unit ?? "وحدة"
            } إلى «${producedItem?.name ?? ""}»` +
            (producedCostUpdated ? ` بتكلفة ${producedUnitCost} للوحدة` : "")
          : `${consumed}. لم يُسجَّل عدد الوحدات المنتجة بعد — يمكن تسجيله لاحقاً على الحركة نفسها`;
    } else if (itemCostUpdated) {
      message = `تم تسجيل الحركة وتحديث سعر وحدة الصنف إلى ${invoiceCost} حسب الفاتورة`;
    }

    res.status(201).json({
      ok: true,
      movement: saved,
      producedMovement,
      manufacturing,
      bookBalance,
      itemCostUpdated,
      producedCostUpdated,
      newBalance:
        movementType === "count"
          ? quantity
          : round2(movementType === "in" ? bookBalance + quantity : bookBalance - quantity),
      message,
    });
  },
);

inventoryRouter.get(
  "/inventory/movements",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;

    const branchId = asId(req.query.branchId) ?? actor.branchId ?? null;
    const itemId = asId(req.query.itemId);
    const movementType = asEnum(req.query.movementType, MOVEMENT_TYPES);
    const from = asDateOnly(req.query.from);
    const to = asDateOnly(req.query.to);

    const conditions = [
      branchId === null ? undefined : eq(inventoryMovements.branchId, branchId),
      itemId === null ? undefined : eq(inventoryMovements.itemId, itemId),
      movementType === null ? undefined : eq(inventoryMovements.movementType, movementType),
      from === null ? undefined : gte(inventoryMovements.businessDate, from),
      to === null ? undefined : lte(inventoryMovements.businessDate, to),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        movement: inventoryMovements,
        itemName: inventoryItems.name,
        itemCode: inventoryItems.code,
        unit: inventoryItems.unit,
        branchName: branches.name,
        createdByName: employees.fullName,
      })
      .from(inventoryMovements)
      .leftJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
      .leftJoin(branches, eq(inventoryMovements.branchId, branches.id))
      .leftJoin(employees, eq(inventoryMovements.createdByEmployeeId, employees.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(inventoryMovements.businessDate), desc(inventoryMovements.id))
      .limit(500);

    res.json({
      ok: true,
      movements: rows.map((row) => ({
        ...row.movement,
        itemName: row.itemName,
        itemCode: row.itemCode,
        unit: row.unit,
        branchName: row.branchName,
        createdByName: row.createdByName,
      })),
    });
  },
);

inventoryRouter.delete(
  "/inventory/movements/:id",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryItemsManage),
  requireModuleDelete("inventory_movements"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الحركة غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الحركة غير موجودة" });
      return;
    }

    /**
     * حركتا التصنيع طرفان لعملية واحدة: حذف أحدهما دون الآخر يترك المخزون
     * غير متوازن، فيُحذف الطرفان معاً أياً كان الطرف المطلوب حذفه.
     */
    const linkedId = before.linkedMovementId;
    const [linked] =
      linkedId === null
        ? []
        : await db
            .select()
            .from(inventoryMovements)
            .where(eq(inventoryMovements.id, linkedId))
            .limit(1);

    await db.delete(inventoryMovements).where(eq(inventoryMovements.id, id));
    if (linked) {
      await db.delete(inventoryMovements).where(eq(inventoryMovements.id, linked.id));
    }

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "inventory.movement.delete",
      entityType: "inventory_movements",
      entityId: id,
      before: linked ? { movement: before, linked } : before,
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: linked ? "تم حذف طرفَي عملية التصنيع" : "تم حذف الحركة",
    });
  },
);

/**
 * إكمال عملية تصنيع سُجِّل خامها دون عدد وحداتها: يُدخل المسؤول عدد الوحدات
 * أو وزن الوحدة (والثالث يُحسب من الخام المسجَّل)، فتُنشأ حركة إضافة المنتج
 * النهائي وتُربط بحركة الخام. لا يُعاد فتح عملية اكتملت — تُحذف وتُسجَّل من
 * جديد كي لا يختلّ الرصيد بتعديل صامت.
 */
inventoryRouter.patch(
  "/inventory/movements/:id/production",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryWrite),
  requireModuleLevel("inventory_movements", 3),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = asId(req.params.id);

    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف الحركة غير صالح" });
      return;
    }

    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, id))
      .limit(1);

    if (!movement) {
      res.status(404).json({ ok: false, error: "الحركة غير موجودة" });
      return;
    }

    if (movement.movementType !== "manufacture") {
      res.status(400).json({ ok: false, error: "هذه الحركة ليست عملية تصنيع" });
      return;
    }

    if (movement.linkedMovementId !== null || movement.producedUnits > 0) {
      res.status(409).json({
        ok: false,
        error: "عدد الوحدات مسجَّل لهذه العملية — احذف الحركة وسجّلها من جديد لتصحيحه",
      });
      return;
    }

    const producedItemId = movement.producedItemId ?? asId(body.producedItemId);
    if (producedItemId === null) {
      res.status(400).json({ ok: false, error: "اختر المنتج النهائي الناتج عن التصنيع" });
      return;
    }

    const [producedItem] = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, producedItemId))
      .limit(1);

    if (!producedItem) {
      res.status(404).json({ ok: false, error: "المنتج النهائي غير موجود" });
      return;
    }

    // الخام مسجَّل سلفاً، فالمطلوب هنا عدد الوحدات أو وزن الوحدة ليُحسب الآخر
    const resolved = resolveManufacturing({
      rawQuantity: movement.quantity,
      producedUnits: asNumber(body.producedUnits),
      unitWeight: asNumber(body.unitWeight),
    });

    if (resolved.producedUnits <= 0) {
      res.status(400).json({ ok: false, error: "أدخل عدد الوحدات المنتجة أو وزن الوحدة" });
      return;
    }

    const created = await createProducedMovement({
      rawMovementId: movement.id,
      branchId: movement.branchId,
      producedItem,
      businessDate: movement.businessDate,
      producedUnits: resolved.producedUnits,
      unitWeight: resolved.unitWeight,
      rawTotalCost: movement.totalCost,
      reference: movement.reference,
      notes: movement.notes,
      actorId: actor.id,
      ipAddress: clientIp(req),
    });

    const [updated] = await db
      .update(inventoryMovements)
      .set({
        producedItemId,
        producedUnits: resolved.producedUnits,
        unitWeight: resolved.unitWeight,
        linkedMovementId: created.movement?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(inventoryMovements.id, movement.id))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "inventory.movement.manufacture_complete",
      entityType: "inventory_movements",
      entityId: movement.id,
      before: movement,
      after: updated,
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      movement: updated,
      producedMovement: created.movement,
      manufacturing: resolved,
      message: `تم تسجيل ${resolved.producedUnits} ${producedItem.unit} من «${producedItem.name}» وإضافتها للمخزون`,
    });
  },
);

/**
 * صفوف ورقة الجرد اليومي لفرع في تاريخ محدّد: الرصيد الدفتري لكل صنف نشط
 * مع وارد اليوم وصادره والكمية المعدودة إن سُجّلت. تستخدمها شاشة المخزون
 * والنموذج المطبوع معاً حتى يبقى الرقم واحداً على الشاشة وعلى الورق.
 */
export async function loadDailySheet(
  branchId: number,
  businessDate: string,
): Promise<
  Array<{
    itemId: number;
    code: string;
    name: string;
    unit: string;
    category: string;
    minQuantity: number;
    balance: number;
    todayIn: number;
    todayOut: number;
    countedToday: number | null;
    belowMinimum: boolean;
  }>
> {
  const db = getDb();

  const [items, todayRows, balances] = await Promise.all([
    db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.isActive, true))
      .orderBy(asc(inventoryItems.code)),
    db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.branchId, branchId),
          eq(inventoryMovements.businessDate, businessDate),
        ),
      ),
    computeBalances(branchId),
  ]);

  const byItem = new Map<number, { in: number; out: number; count: number | null }>();
  for (const row of todayRows) {
    const entry = byItem.get(row.itemId) ?? { in: 0, out: 0, count: null };
    if (row.movementType === "in") entry.in = round2(entry.in + row.quantity);
    else if (row.movementType === "out" || row.movementType === "manufacture") {
      // التصنيع استهلاك للخام كالإخراج تماماً في ورقة الجرد
      entry.out = round2(entry.out + row.quantity);
    } else entry.count = row.quantity;
    byItem.set(row.itemId, entry);
  }

  return items.map((item) => {
    const today = byItem.get(item.id) ?? { in: 0, out: 0, count: null };
    const balance = balances.get(item.id)?.balance ?? 0;
    return {
      itemId: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      category: item.category,
      minQuantity: item.minQuantity,
      balance,
      todayIn: today.in,
      todayOut: today.out,
      countedToday: today.count,
      belowMinimum: balance < item.minQuantity,
    };
  });
}

/**
 * ورقة الجرد اليومي: أصناف الفرع مع رصيدها الدفتري وحركات اليوم —
 * يفتحها المسؤول ليُدخل الكميات المعدودة.
 */
inventoryRouter.get(
  "/inventory/daily",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const branchId = asId(req.query.branchId) ?? actor.branchId ?? null;

    if (branchId === null) {
      res.status(400).json({ ok: false, error: "اختر الفرع" });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const businessDate = asDateOnly(req.query.date) ?? isoDateInZone(new Date(), timezone);

    res.json({
      ok: true,
      branchId,
      businessDate,
      timezone,
      rows: await loadDailySheet(branchId, businessDate),
    });
  },
);

/** نطاق الاطّلاع على الشاشة — تستخدمه الواجهة لإخفاء الأزرار. */
inventoryRouter.get(
  "/inventory/access",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    res.json({
      ok: true,
      canRead: await hasAnyPermission(req, [PERMISSIONS.inventoryRead]),
      canWrite: await hasAnyPermission(req, [PERMISSIONS.inventoryWrite]),
      canManageItems: await hasAnyPermission(req, [PERMISSIONS.inventoryItemsManage]),
      // درجتا الحذف مستقلتان عن الإضافة والتعديل، ولكل بند درجته
      canDeleteMovements: await hasModuleDelete(req, "inventory_movements"),
      canDeleteItems: await hasModuleDelete(req, "inventory_items"),
      canEditItems: await hasModuleLevel(req, "inventory_items", 3),
    });
  },
);
