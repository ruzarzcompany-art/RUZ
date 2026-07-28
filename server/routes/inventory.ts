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
import { PERMISSIONS, hasAnyPermission, requirePermission } from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { asDateOnly, asEnum, asId, asNumber, asString, round2 } from "../validate.js";

export const inventoryRouter = Router();

const MOVEMENT_TYPES = ["in", "out", "count"] as const;
const REASONS = [
  "purchase",
  "consumption",
  "waste",
  "transfer",
  "stocktake",
  "other",
] as const;

/** أقصى عدد حركات تُقرأ لحساب الأرصدة (حماية من استعلام ضخم). */
const BALANCE_SCAN_LIMIT = 20_000;

/**
 * الرصيد الحالي لكل صنف في فرع: نمرّ على الحركات مرتّبة زمنياً،
 * فحركة الجرد (`count`) تُثبّت الرصيد على الكمية المعدودة، والإدخال
 * يزيد والإخراج يُنقص. هذا يجعل الجرد مصدر الحقيقة عند أي فرق.
 */
async function computeBalances(branchId: number): Promise<
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
      current.balance -= row.quantity;
    }

    current.lastMovementDate = row.businessDate;
    current.balance = round2(current.balance);
    balances.set(row.itemId, current);
  }

  return balances;
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

    const quantityRaw = asNumber(body.quantity);
    if (quantityRaw === null || quantityRaw < 0) {
      res.status(400).json({ ok: false, error: "الكمية يجب أن تكون رقماً غير سالب" });
      return;
    }
    const quantity = round2(quantityRaw);

    const unitCostRaw = asNumber(body.unitCost);
    const unitCost = unitCostRaw === null || unitCostRaw < 0 ? item.unitCost : round2(unitCostRaw);

    const reason =
      asEnum(body.reason, REASONS) ??
      (movementType === "count" ? "stocktake" : movementType === "in" ? "purchase" : "consumption");

    // فرق الجرد عن الرصيد الدفتري — يُحسب في الخادم لا في المتصفح
    const balances = await computeBalances(branchId);
    const bookBalance = balances.get(itemId)?.balance ?? 0;
    const variance = movementType === "count" ? round2(quantity - bookBalance) : 0;

    const [saved] = await db
      .insert(inventoryMovements)
      .values({
        branchId,
        itemId,
        movementType,
        businessDate,
        quantity,
        unitCost,
        totalCost: round2(quantity * unitCost),
        reason,
        reference: asString(body.reference, 120) ?? "",
        variance,
        notes: asString(body.notes, 1000) ?? "",
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

    res.status(201).json({
      ok: true,
      movement: saved,
      bookBalance,
      newBalance:
        movementType === "count"
          ? quantity
          : round2(movementType === "in" ? bookBalance + quantity : bookBalance - quantity),
      message:
        movementType === "count"
          ? `تم تسجيل الجرد. الفرق عن الرصيد الدفتري: ${variance}`
          : "تم تسجيل الحركة",
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

    await db.delete(inventoryMovements).where(eq(inventoryMovements.id, id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "inventory.movement.delete",
      entityType: "inventory_movements",
      entityId: id,
      before,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف الحركة" });
  },
);

/**
 * ورقة الجرد اليومي: أصناف الفرع مع رصيدها الدفتري وحركات اليوم —
 * يفتحها المسؤول ليُدخل الكميات المعدودة.
 */
inventoryRouter.get(
  "/inventory/daily",
  requireAuth,
  requirePermission(PERMISSIONS.inventoryRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const branchId = asId(req.query.branchId) ?? actor.branchId ?? null;

    if (branchId === null) {
      res.status(400).json({ ok: false, error: "اختر الفرع" });
      return;
    }

    const timezone = await branchTimezone(branchId);
    const businessDate = asDateOnly(req.query.date) ?? isoDateInZone(new Date(), timezone);

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
      else if (row.movementType === "out") entry.out = round2(entry.out + row.quantity);
      else entry.count = row.quantity;
      byItem.set(row.itemId, entry);
    }

    res.json({
      ok: true,
      branchId,
      businessDate,
      timezone,
      rows: items.map((item) => {
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
      }),
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
    });
  },
);
