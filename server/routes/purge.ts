/**
 * تصفية الأرقام السابقة — للبدء من جديد من تاريخ محدّد.
 *
 * تحذف **نهائياً** ما قبل تاريخ الفصل في النطاقات المختارة فقط (تقفيلات
 * الكاشير، النقدية والإقفال، حركات المخزون، سجلات الرقابة). لا تمسّ بيانات
 * الموظفين ولا الحضور ولا الرواتب ولا الأصناف ولا الإعدادات ولا سجل التدقيق.
 *
 * الحذف لا يُقبل إلا بعد تنزيل نسخة احتياطية مطابقة:
 *   1. GET  /api/purge/preview  — أعداد ما سيُحذف في كل جدول.
 *   2. GET  /api/purge/backup   — ملف Excel بكل الصفوف والأعمدة، ويُسجَّل تنزيله.
 *   3. POST /api/purge/run      — يحذف، بشرط نسخة احتياطية حديثة للنطاق والتاريخ
 *      نفسيهما بالأعداد نفسها، وكتابة كلمة التأكيد.
 */

import { Router, type Response } from "express";
import { getStore } from "@netlify/blobs";
import { and, desc, eq, gte, inArray, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../../db/index.js";
import {
  auditLogs,
  cashExpenses,
  cashNotifications,
  cashierClosingLines,
  cashierClosings,
  foodicsInventoryEvents,
  foodicsOrders,
  inventoryMovements,
  monthlyCashClosings,
  providerSettlementPayments,
  providerSettlements,
  purchaseReceiptLines,
  purchaseReceipts,
  surveillanceAlerts,
  surveillanceCameraChecks,
  surveillanceDailyReports,
  surveillanceFrames,
  surveillanceOrders,
  surveillancePosEvents,
  surveillanceWaste,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, requireModuleDelete, requirePermission } from "../rbac.js";
import { asDateOnly } from "../validate.js";

export const purgeRouter = Router();

export const PURGE_SCOPES = ["cashier", "cash", "inventory", "surveillance"] as const;
export type PurgeScope = (typeof PURGE_SCOPES)[number];

export const SCOPE_LABELS: Record<PurgeScope, string> = {
  cashier: "تقفيلات الكاشير",
  cash: "النقدية والإقفال",
  inventory: "حركات المخزون",
  surveillance: "سجلات الرقابة",
};

/** كلمة التأكيد التي يكتبها المستخدم قبل الحذف. */
export const CONFIRM_WORD = "تصفية";
/** صلاحية النسخة الاحتياطية قبل أن يُطلب تنزيل جديد. */
const BACKUP_TTL_MS = 2 * 60 * 60 * 1000;
/** أقصى عدد صفوف في ملف النسخة الواحد (حد حجم ردّ الدالة). */
const MAX_BACKUP_ROWS = 60_000;
/** عدد المعرّفات في كل دفعة حذف للجداول التابعة. */
const ID_CHUNK = 500;

const guards = [
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  requireModuleDelete("settings"),
];

interface TableSpec {
  /** اسم ورقة العمل في النسخة الاحتياطية وعنوان الجدول في المعاينة */
  label: string;
  table: PgTable;
  /** شرط «قبل تاريخ الفصل» لهذا الجدول */
  where: (cutoff: Cutoff) => SQL | undefined;
}

interface Cutoff {
  /** YYYY-MM-DD — يُحذف ما قبله (هو نفسه يبقى) */
  date: string;
  /** منتصف ليل تاريخ الفصل بتوقيت الرياض، للأعمدة الزمنية */
  instant: Date;
  year: number;
  month: number;
}

export function cutoffOf(date: string): Cutoff {
  const [year, month] = date.split("-").map((part) => Number.parseInt(part, 10));
  return { date, instant: new Date(`${date}T00:00:00+03:00`), year, month };
}

/**
 * الجداول التابعة تُسبق أصولها في القائمة: تُحذف أولاً (وإن كان الحذف
 * المتتالي يتكفّل بها) وتُصدَّر كاملةً في النسخة الاحتياطية.
 */
function specsFor(scope: PurgeScope): TableSpec[] {
  switch (scope) {
    case "cashier":
      return [
        {
          label: "بنود تقفيلات الكاشير",
          table: cashierClosingLines,
          where: (cutoff) =>
            inArray(
              cashierClosingLines.closingId,
              getDb()
                .select({ id: cashierClosings.id })
                .from(cashierClosings)
                .where(lt(cashierClosings.businessDate, cutoff.date)),
            ),
        },
        {
          label: "تقفيلات الكاشير",
          table: cashierClosings,
          where: (cutoff) => lt(cashierClosings.businessDate, cutoff.date),
        },
      ];
    case "cash":
      return [
        {
          label: "المصاريف والمشتريات النقدية",
          table: cashExpenses,
          where: (cutoff) => lt(cashExpenses.businessDate, cutoff.date),
        },
        {
          label: "دفعات التسويات",
          table: providerSettlementPayments,
          where: (cutoff) =>
            inArray(
              providerSettlementPayments.settlementId,
              getDb()
                .select({ id: providerSettlements.id })
                .from(providerSettlements)
                .where(lt(providerSettlements.periodTo, cutoff.date)),
            ),
        },
        {
          label: "تسويات الشبكات والتوصيل",
          table: providerSettlements,
          where: (cutoff) => lt(providerSettlements.periodTo, cutoff.date),
        },
        {
          label: "إقفالات الشهر",
          table: monthlyCashClosings,
          // الأشهر المنتهية كلها قبل تاريخ الفصل
          where: (cutoff) =>
            or(
              lt(monthlyCashClosings.periodYear, cutoff.year),
              and(
                eq(monthlyCashClosings.periodYear, cutoff.year),
                lt(monthlyCashClosings.periodMonth, cutoff.month),
              ),
            ),
        },
        {
          label: "إشعارات الإقفال",
          table: cashNotifications,
          where: (cutoff) => lt(cashNotifications.createdAt, cutoff.instant),
        },
      ];
    case "inventory":
      return [
        {
          label: "أصناف استلام المشتريات",
          table: purchaseReceiptLines,
          where: (cutoff) =>
            inArray(
              purchaseReceiptLines.receiptId,
              getDb()
                .select({ id: purchaseReceipts.id })
                .from(purchaseReceipts)
                .where(lt(purchaseReceipts.businessDate, cutoff.date)),
            ),
        },
        {
          label: "استلام المشتريات",
          table: purchaseReceipts,
          where: (cutoff) => lt(purchaseReceipts.businessDate, cutoff.date),
        },
        {
          label: "حركات المخزون",
          table: inventoryMovements,
          where: (cutoff) => lt(inventoryMovements.businessDate, cutoff.date),
        },
      ];
    case "surveillance":
      return [
        {
          label: "تنبيهات الرقابة",
          table: surveillanceAlerts,
          where: (cutoff) => lt(surveillanceAlerts.occurredAt, cutoff.instant),
        },
        {
          label: "طلبات الرقابة",
          table: surveillanceOrders,
          where: (cutoff) => lt(surveillanceOrders.registeredAt, cutoff.instant),
        },
        {
          label: "أحداث الكاشير",
          table: surveillancePosEvents,
          where: (cutoff) => lt(surveillancePosEvents.occurredAt, cutoff.instant),
        },
        {
          label: "هدر الرقابة",
          table: surveillanceWaste,
          where: (cutoff) => lt(surveillanceWaste.occurredAt, cutoff.instant),
        },
        {
          label: "تقارير الرقابة اليومية",
          table: surveillanceDailyReports,
          where: (cutoff) => lt(surveillanceDailyReports.businessDate, cutoff.date),
        },
        {
          label: "لقطات الكاميرات",
          table: surveillanceFrames,
          where: (cutoff) => lt(surveillanceFrames.capturedAt, cutoff.instant),
        },
        {
          label: "فحوص الكاميرات",
          table: surveillanceCameraChecks,
          where: (cutoff) => lt(surveillanceCameraChecks.checkedAt, cutoff.instant),
        },
        {
          label: "فواتير فوديكس المسحوبة",
          table: foodicsOrders,
          where: (cutoff) =>
            or(
              lt(foodicsOrders.businessDate, cutoff.date),
              lt(foodicsOrders.openedAt, cutoff.instant),
            ),
        },
        {
          label: "هدر فوديكس المسحوب",
          table: foodicsInventoryEvents,
          where: (cutoff) => lt(foodicsInventoryEvents.occurredAt, cutoff.instant),
        },
      ];
  }
}

export function parseScopes(value: unknown): PurgeScope[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const wanted = new Set(raw.map((entry) => String(entry).trim()));
  return PURGE_SCOPES.filter((scope) => wanted.has(scope));
}

interface Request {
  cutoff: Cutoff;
  scopes: PurgeScope[];
}

/** يقرأ تاريخ الفصل والنطاقات ويتحقق منهما؛ يردّ بالخطأ ويُرجع null إن لم يصحّا. */
function readRequest(source: Record<string, unknown>, res: Response): Request | null {
  const before = asDateOnly(source.before);
  if (!before) {
    res.status(400).json({ ok: false, error: "حدّد تاريخ البداية الجديدة" });
    return null;
  }
  // تاريخ في المستقبل يعني حذف أرقام لم تُسجَّل بعد حين الطلب — لا معنى له
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (before > today) {
    res.status(400).json({ ok: false, error: "تاريخ البداية الجديدة لا يكون في المستقبل" });
    return null;
  }
  const scopes = parseScopes(source.scopes);
  if (scopes.length === 0) {
    res.status(400).json({ ok: false, error: "اختر نطاقاً واحداً على الأقل" });
    return null;
  }
  return { cutoff: cutoffOf(before), scopes };
}

async function loadRows(spec: TableSpec, cutoff: Cutoff): Promise<Record<string, unknown>[]> {
  const db = getDb();
  return (await db.select().from(spec.table).where(spec.where(cutoff))) as Record<string, unknown>[];
}

async function countAll(request: Request) {
  const tables: Array<{ scope: PurgeScope; label: string; count: number }> = [];
  for (const scope of request.scopes) {
    for (const spec of specsFor(scope)) {
      const rows = await loadRows(spec, request.cutoff);
      tables.push({ scope, label: spec.label, count: rows.length });
    }
  }
  return tables;
}

/** بصمة الأعداد — تُقارن بين النسخة الاحتياطية ولحظة الحذف. */
export function fingerprint(
  before: string,
  scopes: readonly string[],
  tables: ReadonlyArray<{ label: string; count: number }>,
): string {
  return [before, [...scopes].sort().join("+"), ...tables.map((t) => `${t.label}=${t.count}`)].join("|");
}

/* ── ملف Excel (SpreadsheetML 2003) بلا مكتبات ─────────────────── */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // محارف التحكم غير مسموحة في XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\r?\n/g, "&#10;");
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '<Cell><Data ss:Type="String"></Data></Cell>';
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `<Cell><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`;
}

/** اسم ورقة العمل: 31 حرفاً بلا المحارف الممنوعة في Excel. */
function sheetName(label: string): string {
  return xmlEscape(label.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
}

export function buildWorkbook(
  sheets: ReadonlyArray<{ label: string; rows: ReadonlyArray<Record<string, unknown>> }>,
): string {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
  ];
  for (const sheet of sheets) {
    const columns = sheet.rows.length > 0 ? Object.keys(sheet.rows[0]) : ["لا توجد صفوف"];
    parts.push(`<Worksheet ss:Name="${sheetName(sheet.label)}"><Table>`);
    parts.push(`<Row>${columns.map((column) => cell(column)).join("")}</Row>`);
    for (const row of sheet.rows) {
      parts.push(`<Row>${columns.map((column) => cell(row[column])).join("")}</Row>`);
    }
    parts.push("</Table></Worksheet>");
  }
  parts.push("</Workbook>");
  return parts.join("\n");
}

/* ── المسارات ──────────────────────────────────────────────────── */

purgeRouter.get("/purge/preview", ...guards, async (req: AuthedRequest, res: Response) => {
  const request = readRequest(req.query as Record<string, unknown>, res);
  if (!request) return;
  const tables = await countAll(request);
  res.json({
    ok: true,
    before: request.cutoff.date,
    scopes: request.scopes,
    tables,
    total: tables.reduce((sum, table) => sum + table.count, 0),
    meta: { scopes: PURGE_SCOPES, scopeLabels: SCOPE_LABELS, confirmWord: CONFIRM_WORD },
  });
});

purgeRouter.get("/purge/backup", ...guards, async (req: AuthedRequest, res: Response) => {
  const request = readRequest(req.query as Record<string, unknown>, res);
  if (!request) return;
  const actor = req.employee!;

  const sheets: Array<{ label: string; rows: Record<string, unknown>[] }> = [];
  const tables: Array<{ label: string; count: number }> = [];
  let total = 0;

  for (const scope of request.scopes) {
    for (const spec of specsFor(scope)) {
      const rows = await loadRows(spec, request.cutoff);
      total += rows.length;
      if (total > MAX_BACKUP_ROWS) {
        res.status(413).json({
          ok: false,
          error:
            "النسخة الاحتياطية أكبر من أن تُنزَّل دفعة واحدة — نزّلها نطاقاً نطاقاً (اختر نطاقاً واحداً في كل مرة).",
        });
        return;
      }
      sheets.push({ label: spec.label, rows });
      tables.push({ label: spec.label, count: rows.length });
    }
  }

  await recordAudit({
    actorEmployeeId: actor.id,
    action: "data.purge.backup",
    entityType: "purge",
    after: {
      fingerprint: fingerprint(request.cutoff.date, request.scopes, tables),
      before: request.cutoff.date,
      scopes: request.scopes,
      tables,
    },
    reason: `نسخة احتياطية لما قبل ${request.cutoff.date}`,
    ipAddress: clientIp(req),
  });

  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="sijill-backup-before-${request.cutoff.date}.xls"`,
  );
  res.send(buildWorkbook(sheets));
});

purgeRouter.post("/purge/run", ...guards, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const request = readRequest(body, res);
  if (!request) return;
  const actor = req.employee!;
  const db = getDb();

  if (String(body.confirm ?? "").trim() !== CONFIRM_WORD) {
    res.status(400).json({ ok: false, error: `اكتب كلمة «${CONFIRM_WORD}» للتأكيد` });
    return;
  }

  /* لا حذف بلا نسخة احتياطية حديثة مطابقة للنطاق والتاريخ والأعداد */
  const tables = await countAll(request);
  const expected = fingerprint(request.cutoff.date, request.scopes, tables);
  const backups = await db
    .select({ afterJson: auditLogs.afterJson })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.actorEmployeeId, actor.id),
        eq(auditLogs.action, "data.purge.backup"),
        gte(auditLogs.createdAt, new Date(Date.now() - BACKUP_TTL_MS)),
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(10);

  const hasBackup = backups.some((row) => {
    try {
      return (JSON.parse(row.afterJson ?? "{}") as { fingerprint?: string }).fingerprint === expected;
    } catch {
      return false;
    }
  });

  if (!hasBackup) {
    res.status(409).json({
      ok: false,
      error:
        "نزّل النسخة الاحتياطية أولاً للنطاقات والتاريخ نفسيهما. إن كنت نزّلتها فقد تغيّرت البيانات بعدها أو مضى عليها أكثر من ساعتين — نزّلها من جديد.",
    });
    return;
  }

  /* مفاتيح صور اللقطات تُقرأ قبل حذف صفوفها لتُحذف من مخزن الملفات */
  let frameKeys: string[] = [];
  if (request.scopes.includes("surveillance")) {
    const frames = await db
      .select({ imageKey: surveillanceFrames.imageKey })
      .from(surveillanceFrames)
      .where(lt(surveillanceFrames.capturedAt, request.cutoff.instant));
    frameKeys = frames.map((frame) => frame.imageKey).filter(Boolean);
  }

  const deleted: Array<{ scope: PurgeScope; label: string; count: number }> = [];
  for (const scope of request.scopes) {
    for (const spec of specsFor(scope)) {
      // المعرّفات تُثبَّت أولاً ثم تُحذف على دفعات، فلا يتغيّر الشرط أثناء الحذف
      const idColumn = (spec.table as unknown as { id: PgColumn }).id;
      const rows = await db
        .select({ id: idColumn })
        .from(spec.table)
        .where(spec.where(request.cutoff));
      const ids = rows.map((row) => row.id as number);
      for (let index = 0; index < ids.length; index += ID_CHUNK) {
        await db.delete(spec.table).where(inArray(idColumn, ids.slice(index, index + ID_CHUNK)));
      }
      deleted.push({ scope, label: spec.label, count: ids.length });
    }
  }

  /* صور اللقطات: حذفها تنظيف مساحة فقط، وتعذّره لا يُفشل التصفية */
  let imagesRemoved = 0;
  if (frameKeys.length > 0) {
    try {
      const store = getStore("surveillance-frames");
      for (const key of frameKeys) {
        await store.delete(key);
        await store.delete(`${key}.type`);
        imagesRemoved += 1;
      }
    } catch {
      /* يبقى ما لم يُحذف في المخزن بلا أثر على البيانات */
    }
  }

  const total = deleted.reduce((sum, table) => sum + table.count, 0);
  await recordAudit({
    actorEmployeeId: actor.id,
    action: "data.purge.run",
    entityType: "purge",
    after: { before: request.cutoff.date, scopes: request.scopes, deleted, imagesRemoved },
    reason: `تصفية ما قبل ${request.cutoff.date}: ${request.scopes.map((scope) => SCOPE_LABELS[scope]).join("، ")}`,
    ipAddress: clientIp(req),
  });

  res.json({
    ok: true,
    before: request.cutoff.date,
    deleted,
    total,
    message: `تمت التصفية: حُذف ${total} سجل مما قبل ${request.cutoff.date}.`,
  });
});
