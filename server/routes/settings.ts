import { Router, type Response } from "express";
import { asc, count, eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../../db/index.js";
import {
  branches,
  companySettings,
  departments,
  employees,
  inventoryItems,
  jobTitles,
  salaryComponents,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { PERMISSIONS, hasAnyPermission, requireAnyPermission, requirePermission } from "../rbac.js";
import { safeTimeZone } from "../time.js";
import { asBool, asEnum, asId, asNumber, asString } from "../validate.js";

export const settingsRouter = Router();

/* ── هوية المؤسسة وتصميم المطبوعات ────────────────────────────── */

const PAPER_SIZES = ["A4", "A5", "letter"] as const;
const ORIENTATIONS = ["portrait", "landscape"] as const;
const FONT_FAMILIES = ["system", "naskh", "kufi", "serif", "mono"] as const;

/** أقصى حجم للشعار بعد ترميز base64 (نصف ميجابايت تقريباً). */
const MAX_LOGO_CHARS = 700_000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * إعدادات المؤسسة صف واحد بالمفتاح `default`. تُنشأ عند البذر، ويُعاد
 * إنشاؤها هنا احتياطاً لو حُذفت يدوياً حتى لا تفشل صفحة الطباعة.
 */
export async function loadCompanySettings() {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(companySettings)
    .where(eq(companySettings.settingsKey, "default"))
    .limit(1);

  if (existing) return existing;

  await db
    .insert(companySettings)
    .values({ settingsKey: "default" })
    .onConflictDoNothing();

  const [created] = await db
    .select()
    .from(companySettings)
    .where(eq(companySettings.settingsKey, "default"))
    .limit(1);
  return created!;
}

/** الحقول النصية القابلة للتعديل مع أقصى طول لكل حقل. */
const TEXT_FIELDS: Array<[keyof typeof companySettings.$inferInsert, number]> = [
  ["companyName", 200],
  ["companyNameEn", 200],
  ["legalForm", 120],
  ["commercialRegister", 60],
  ["taxNumber", 60],
  ["address", 400],
  ["city", 120],
  ["country", 120],
  ["phone", 60],
  ["email", 200],
  ["website", 200],
  ["footerText", 600],
  ["footerNote", 300],
  ["headerNote", 300],
  ["watermarkText", 100],
  ["currency", 10],
];

/**
 * إعدادات المطبوعات يقرأها كل موظف مسجَّل (صفحة الطباعة تحتاجها)،
 * أما التعديل فيحتاج صلاحية `settings.manage`.
 */
settingsRouter.get(
  "/settings/company",
  requireAuth,
  async (_req: AuthedRequest, res: Response) => {
    const settings = await loadCompanySettings();
    res.json({
      ok: true,
      settings,
      meta: {
        paperSizes: PAPER_SIZES,
        orientations: ORIENTATIONS,
        fontFamilies: FONT_FAMILIES,
        maxLogoChars: MAX_LOGO_CHARS,
      },
    });
  },
);

settingsRouter.put(
  "/settings/company",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const before = await loadCompanySettings();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    for (const [field, max] of TEXT_FIELDS) {
      if (!(field in body)) continue;
      const value = asString(body[field], max);
      if (value === null) {
        res.status(400).json({ ok: false, error: `قيمة غير صالحة للحقل ${field}` });
        return;
      }
      patch[field] = value;
    }

    if ("paperSize" in body) {
      const paperSize = asEnum(body.paperSize, PAPER_SIZES);
      if (!paperSize) {
        res.status(400).json({ ok: false, error: "مقاس الورق غير مدعوم" });
        return;
      }
      patch.paperSize = paperSize;
    }

    if ("paperOrientation" in body) {
      const orientation = asEnum(body.paperOrientation, ORIENTATIONS);
      if (!orientation) {
        res.status(400).json({ ok: false, error: "اتجاه الورق غير مدعوم" });
        return;
      }
      patch.paperOrientation = orientation;
    }

    if ("fontFamily" in body) {
      const fontFamily = asEnum(body.fontFamily, FONT_FAMILIES);
      if (!fontFamily) {
        res.status(400).json({ ok: false, error: "الخط غير مدعوم" });
        return;
      }
      patch.fontFamily = fontFamily;
    }

    if ("marginMm" in body) {
      const margin = asNumber(body.marginMm);
      if (margin === null || margin < 0 || margin > 40) {
        res.status(400).json({ ok: false, error: "هامش الورقة يجب أن يكون بين 0 و40 مم" });
        return;
      }
      patch.marginMm = Math.round(margin);
    }

    if ("baseFontPt" in body) {
      const font = asNumber(body.baseFontPt);
      if (font === null || font < 7 || font > 18) {
        res.status(400).json({ ok: false, error: "حجم الخط يجب أن يكون بين 7 و18 نقطة" });
        return;
      }
      patch.baseFontPt = font;
    }

    for (const field of ["accentColor", "textColor"] as const) {
      if (!(field in body)) continue;
      const color = asString(body[field], 20) ?? "";
      if (!HEX_COLOR.test(color)) {
        res.status(400).json({ ok: false, error: "اللون يجب أن يكون بصيغة #RRGGBB" });
        return;
      }
      patch[field] = color;
    }

    for (const field of [
      "showLogo",
      "showFooter",
      "showSignatures",
      "showWatermark",
    ] as const) {
      if (!(field in body)) continue;
      const flag = asBool(body[field]);
      if (flag === null) {
        res.status(400).json({ ok: false, error: `قيمة غير صالحة للحقل ${field}` });
        return;
      }
      patch[field] = flag;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ ok: false, error: "لا توجد حقول صالحة للتحديث" });
      return;
    }

    const [updated] = await db
      .update(companySettings)
      .set({ ...patch, updatedByEmployeeId: actor.id, updatedAt: new Date() })
      .where(eq(companySettings.id, before.id))
      .returning();

    // الشعار قد يكون كبيراً — نستثنيه من سجل التدقيق
    const auditable = (row: Record<string, unknown>) => {
      const { logoDataUrl: _logo, ...rest } = row;
      return rest;
    };

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settings.company.update",
      entityType: "company_settings",
      entityId: before.id,
      before: auditable(before as unknown as Record<string, unknown>),
      after: auditable(updated as unknown as Record<string, unknown>),
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, settings: updated });
  },
);

/**
 * رفع شعار الشركة كـData URL. يُخزَّن في قاعدة البيانات نفسها
 * فيعمل في المعاينة والإنتاج بلا خدمة تخزين خارجية، ويُطبَّق تلقائياً
 * على كل المطبوعات.
 */
settingsRouter.post(
  "/settings/company/logo",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    // الواجهة ترسل `logoDataUrl`؛ نقبل `dataUrl` أيضاً للتوافق مع أي نداء قديم
    const rawDataUrl = req.body?.logoDataUrl ?? req.body?.dataUrl;
    const dataUrl =
      typeof rawDataUrl === "string" ? rawDataUrl.replace(/\s+/g, "") : "";

    if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      res.status(400).json({
        ok: false,
        error: "الشعار يجب أن يكون صورة PNG أو JPEG أو WebP أو SVG بصيغة data URL.",
      });
      return;
    }

    if (dataUrl.length > MAX_LOGO_CHARS) {
      res.status(400).json({
        ok: false,
        error: "حجم الشعار كبير جداً. اختر صورة أصغر من 500 كيلوبايت.",
      });
      return;
    }

    const settings = await loadCompanySettings();
    const now = new Date();
    const [updated] = await db
      .update(companySettings)
      .set({
        logoDataUrl: dataUrl,
        logoUpdatedAt: now,
        updatedByEmployeeId: actor.id,
        updatedAt: now,
      })
      .where(eq(companySettings.id, settings.id))
      .returning({ id: companySettings.id, logoUpdatedAt: companySettings.logoUpdatedAt });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settings.company.logo_upload",
      entityType: "company_settings",
      entityId: settings.id,
      after: { bytes: dataUrl.length },
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, logoUpdatedAt: updated?.logoUpdatedAt ?? now });
  },
);

settingsRouter.delete(
  "/settings/company/logo",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const settings = await loadCompanySettings();

    await db
      .update(companySettings)
      .set({
        logoDataUrl: "",
        logoUpdatedAt: null,
        updatedByEmployeeId: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(companySettings.id, settings.id));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "settings.company.logo_delete",
      entityType: "company_settings",
      entityId: settings.id,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف الشعار" });
  },
);

/* ── محرّك الكيانات الأساسية (إضافة/تعديل/حذف) ─────────────────── */

type FieldKind = "text" | "number" | "int" | "money" | "bool" | "enum" | "ref" | "timezone";

interface EntityField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  max?: number;
  values?: readonly string[];
  min?: number;
  maxValue?: number;
  /** الكيان المرجعي في الواجهة (لعرض قائمة اختيار) */
  refEntity?: string;
  hint?: string;
}

interface EntitySpec {
  key: string;
  label: string;
  /** اسم العنصر الواحد — يُستخدم في رسائل الخطأ */
  singular: string;
  table: PgTable;
  idColumn: PgColumn;
  fields: EntityField[];
  managePermission: string;
  readPermission: string;
  orderBy: unknown;
  /** فحص قبل الحذف: يمنع حذف كيان مستخدم في مكان آخر */
  guardDelete?: (id: number) => Promise<string | null>;
}

const ENTITY_SPECS: EntitySpec[] = [
  {
    key: "branches",
    label: "الفروع",
    singular: "الفرع",
    table: branches,
    idColumn: branches.id,
    managePermission: PERMISSIONS.branchesWrite,
    readPermission: PERMISSIONS.branchesRead,
    orderBy: asc(branches.code),
    fields: [
      { key: "code", label: "رمز الفرع", kind: "text", required: true, max: 40 },
      { key: "name", label: "اسم الفرع", kind: "text", required: true, max: 200 },
      { key: "address", label: "العنوان", kind: "text", max: 400 },
      {
        key: "latitude",
        label: "خط العرض",
        kind: "number",
        required: true,
        min: -90,
        maxValue: 90,
      },
      {
        key: "longitude",
        label: "خط الطول",
        kind: "number",
        required: true,
        min: -180,
        maxValue: 180,
      },
      {
        key: "radiusMeters",
        label: "نطاق الحضور (متر)",
        kind: "int",
        min: 20,
        maxValue: 5000,
      },
      { key: "timezone", label: "المنطقة الزمنية", kind: "timezone", max: 60 },
      {
        key: "managerEmployeeId",
        label: "المدير المسؤول",
        kind: "ref",
        refEntity: "employees",
      },
      { key: "isActive", label: "نشط", kind: "bool" },
    ],
    guardDelete: async (id) => {
      const db = getDb();
      const [row] = await db
        .select({ total: count() })
        .from(employees)
        .where(eq(employees.branchId, id));
      return (row?.total ?? 0) > 0
        ? "لا يمكن حذف فرع مرتبط بموظفين. انقل الموظفين أولاً أو أوقف الفرع."
        : null;
    },
  },
  {
    key: "departments",
    label: "الأقسام",
    singular: "القسم",
    table: departments,
    idColumn: departments.id,
    managePermission: PERMISSIONS.settingsManage,
    readPermission: PERMISSIONS.employeesRead,
    orderBy: asc(departments.name),
    fields: [
      { key: "name", label: "اسم القسم", kind: "text", required: true, max: 120 },
      { key: "nameEn", label: "الاسم بالإنجليزية", kind: "text", max: 120 },
      { key: "branchId", label: "الفرع", kind: "ref", refEntity: "branches" },
      {
        key: "managerEmployeeId",
        label: "مسؤول القسم",
        kind: "ref",
        refEntity: "employees",
      },
      { key: "note", label: "ملاحظة", kind: "text", max: 400 },
      { key: "isActive", label: "نشط", kind: "bool" },
    ],
  },
  {
    key: "jobTitles",
    label: "المسميات الوظيفية",
    singular: "المسمى الوظيفي",
    table: jobTitles,
    idColumn: jobTitles.id,
    managePermission: PERMISSIONS.settingsManage,
    readPermission: PERMISSIONS.employeesRead,
    orderBy: asc(jobTitles.name),
    fields: [
      { key: "name", label: "المسمى", kind: "text", required: true, max: 120 },
      { key: "nameEn", label: "المسمى بالإنجليزية", kind: "text", max: 120 },
      { key: "departmentId", label: "القسم", kind: "ref", refEntity: "departments" },
      { key: "defaultBasicSalary", label: "الراتب الأساسي المرجعي", kind: "money" },
      { key: "note", label: "ملاحظة", kind: "text", max: 400 },
      { key: "isActive", label: "نشط", kind: "bool" },
    ],
  },
  {
    key: "salaryComponents",
    label: "بنود الرواتب",
    singular: "بند الراتب",
    table: salaryComponents,
    idColumn: salaryComponents.id,
    managePermission: PERMISSIONS.settingsManage,
    readPermission: PERMISSIONS.salaryManage,
    orderBy: asc(salaryComponents.code),
    fields: [
      { key: "code", label: "الرمز", kind: "text", required: true, max: 40 },
      { key: "name", label: "اسم البند", kind: "text", required: true, max: 120 },
      {
        key: "kind",
        label: "النوع",
        kind: "enum",
        values: ["allowance", "deduction"] as const,
      },
      {
        key: "calculation",
        label: "طريقة الحساب",
        kind: "enum",
        values: ["fixed", "percent"] as const,
        hint: "النسبة تُحسب من الراتب الأساسي",
      },
      { key: "defaultValue", label: "القيمة الافتراضية", kind: "money" },
      { key: "taxable", label: "خاضع للاستقطاع", kind: "bool" },
      { key: "note", label: "ملاحظة", kind: "text", max: 400 },
      { key: "isActive", label: "نشط", kind: "bool" },
    ],
  },
  {
    key: "inventoryItems",
    label: "أصناف المخزون",
    singular: "الصنف",
    table: inventoryItems,
    idColumn: inventoryItems.id,
    managePermission: PERMISSIONS.inventoryItemsManage,
    readPermission: PERMISSIONS.inventoryRead,
    orderBy: asc(inventoryItems.code),
    fields: [
      { key: "code", label: "رمز الصنف", kind: "text", required: true, max: 40 },
      { key: "name", label: "اسم الصنف", kind: "text", required: true, max: 200 },
      { key: "category", label: "التصنيف", kind: "text", max: 120 },
      { key: "unit", label: "وحدة القياس", kind: "text", max: 40 },
      { key: "unitCost", label: "سعر الوحدة", kind: "money" },
      { key: "minQuantity", label: "الحد الأدنى للرصيد", kind: "number", min: 0 },
      { key: "note", label: "ملاحظة", kind: "text", max: 400 },
      { key: "isActive", label: "نشط", kind: "bool" },
    ],
  },
];

const SPEC_BY_KEY = new Map(ENTITY_SPECS.map((spec) => [spec.key, spec]));

/** يبني قيم الإدراج/التحديث من الجسم المُرسل بعد التحقّق من كل حقل. */
function buildValues(
  spec: EntitySpec,
  body: Record<string, unknown>,
  mode: "create" | "update",
): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};

  for (const field of spec.fields) {
    const present = field.key in body;
    if (!present) {
      if (mode === "create" && field.required) {
        return { error: `${field.label} مطلوب` };
      }
      continue;
    }

    const raw = body[field.key];

    switch (field.kind) {
      case "text":
      case "timezone": {
        const text = asString(raw, field.max ?? 400);
        if (text === null) return { error: `${field.label} غير صالح` };
        if (field.required && text === "") return { error: `${field.label} مطلوب` };
        values[field.key] =
          field.kind === "timezone" && text !== "" ? safeTimeZone(text) : text;
        break;
      }
      case "number":
      case "money":
      case "int": {
        const num = asNumber(raw);
        if (num === null) {
          if (field.required) return { error: `${field.label} مطلوب` };
          values[field.key] = 0;
          break;
        }
        if (field.min !== undefined && num < field.min) {
          return { error: `${field.label} يجب ألا يقل عن ${field.min}` };
        }
        if (field.maxValue !== undefined && num > field.maxValue) {
          return { error: `${field.label} يجب ألا يزيد عن ${field.maxValue}` };
        }
        values[field.key] = field.kind === "int" ? Math.round(num) : num;
        break;
      }
      case "bool": {
        const flag = asBool(raw);
        if (flag === null) return { error: `${field.label} غير صالح` };
        values[field.key] = flag;
        break;
      }
      case "enum": {
        const picked = asEnum(raw, field.values ?? []);
        if (picked === null) return { error: `${field.label} غير صالح` };
        values[field.key] = picked;
        break;
      }
      case "ref": {
        if (raw === null || raw === "" || raw === undefined) {
          values[field.key] = null;
          break;
        }
        const id = asId(raw);
        if (id === null) return { error: `${field.label} غير صالح` };
        values[field.key] = id;
        break;
      }
    }
  }

  if (mode === "update" && Object.keys(values).length === 0) {
    return { error: "لا توجد حقول صالحة للتحديث" };
  }

  return { values };
}

/** وصف الكيانات للواجهة — تبني الشاشة نفسها من هذا الوصف. */
settingsRouter.get(
  "/settings/entities",
  requireAuth,
  requireAnyPermission(PERMISSIONS.settingsManage, PERMISSIONS.employeesRead),
  (_req: AuthedRequest, res: Response) => {
    res.json({
      ok: true,
      entities: ENTITY_SPECS.map((spec) => ({
        key: spec.key,
        label: spec.label,
        singular: spec.singular,
        managePermission: spec.managePermission,
        readPermission: spec.readPermission,
        fields: spec.fields,
      })),
    });
  },
);

settingsRouter.get(
  "/settings/entities/:entity",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const spec = SPEC_BY_KEY.get(String(req.params.entity ?? ""));
    if (!spec) {
      res.status(404).json({ ok: false, error: "كيان غير معروف" });
      return;
    }

    const allowed = await requireEntityAccess(req, spec, "read");
    if (!allowed) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض هذا الكيان" });
      return;
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(spec.table)
      .orderBy(spec.orderBy as never);

    res.json({ ok: true, entity: spec.key, rows });
  },
);

settingsRouter.post(
  "/settings/entities/:entity",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const spec = SPEC_BY_KEY.get(String(req.params.entity ?? ""));
    if (!spec) {
      res.status(404).json({ ok: false, error: "كيان غير معروف" });
      return;
    }

    const allowed = await requireEntityAccess(req, spec, "manage");
    if (!allowed) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية تعديل هذا الكيان" });
      return;
    }

    const built = buildValues(spec, (req.body ?? {}) as Record<string, unknown>, "create");
    if ("error" in built) {
      res.status(400).json({ ok: false, error: built.error });
      return;
    }

    const db = getDb();
    const actor = req.employee!;

    try {
      const [created] = await db
        .insert(spec.table)
        .values(built.values as never)
        .returning();

      await recordAudit({
        actorEmployeeId: actor.id,
        action: `settings.${spec.key}.create`,
        entityType: spec.key,
        entityId: (created as { id?: number })?.id ?? null,
        after: created,
        ipAddress: clientIp(req),
      });

      res.status(201).json({ ok: true, row: created });
    } catch (error) {
      res.status(409).json({ ok: false, error: duplicateMessage(error, spec) });
    }
  },
);

settingsRouter.patch(
  "/settings/entities/:entity/:id",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const spec = SPEC_BY_KEY.get(String(req.params.entity ?? ""));
    if (!spec) {
      res.status(404).json({ ok: false, error: "كيان غير معروف" });
      return;
    }

    const allowed = await requireEntityAccess(req, spec, "manage");
    if (!allowed) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية تعديل هذا الكيان" });
      return;
    }

    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف غير صالح" });
      return;
    }

    const built = buildValues(spec, (req.body ?? {}) as Record<string, unknown>, "update");
    if ("error" in built) {
      res.status(400).json({ ok: false, error: built.error });
      return;
    }

    const db = getDb();
    const actor = req.employee!;
    const idColumn = spec.idColumn;

    const [before] = await db.select().from(spec.table).where(eq(idColumn, id)).limit(1);
    if (!before) {
      res.status(404).json({ ok: false, error: `${spec.singular} غير موجود` });
      return;
    }

    try {
      const [updated] = await db
        .update(spec.table)
        .set({ ...built.values, updatedAt: new Date() } as never)
        .where(eq(idColumn, id))
        .returning();

      await recordAudit({
        actorEmployeeId: actor.id,
        action: `settings.${spec.key}.update`,
        entityType: spec.key,
        entityId: id,
        before,
        after: updated,
        ipAddress: clientIp(req),
      });

      res.json({ ok: true, row: updated });
    } catch (error) {
      res.status(409).json({ ok: false, error: duplicateMessage(error, spec) });
    }
  },
);

settingsRouter.delete(
  "/settings/entities/:entity/:id",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const spec = SPEC_BY_KEY.get(String(req.params.entity ?? ""));
    if (!spec) {
      res.status(404).json({ ok: false, error: "كيان غير معروف" });
      return;
    }

    const allowed = await requireEntityAccess(req, spec, "manage");
    if (!allowed) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية تعديل هذا الكيان" });
      return;
    }

    const id = asId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, error: "معرّف غير صالح" });
      return;
    }

    if (spec.guardDelete) {
      const blocked = await spec.guardDelete(id);
      if (blocked) {
        res.status(409).json({ ok: false, error: blocked });
        return;
      }
    }

    const db = getDb();
    const actor = req.employee!;
    const idColumn = spec.idColumn;

    const [before] = await db.select().from(spec.table).where(eq(idColumn, id)).limit(1);
    if (!before) {
      res.status(404).json({ ok: false, error: `${spec.singular} غير موجود` });
      return;
    }

    try {
      await db.delete(spec.table).where(eq(idColumn, id));
    } catch {
      res.status(409).json({
        ok: false,
        error: `لا يمكن حذف ${spec.singular} لارتباطه بسجلات أخرى. يمكنك تعطيله بدلاً من حذفه.`,
      });
      return;
    }

    await recordAudit({
      actorEmployeeId: actor.id,
      action: `settings.${spec.key}.delete`,
      entityType: spec.key,
      entityId: id,
      before,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: `تم حذف ${spec.singular}` });
  },
);

/** رسالة مفهومة عند تعارض قيمة فريدة (رمز مكرّر مثلاً). */
function duplicateMessage(error: unknown, spec: EntitySpec): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/duplicate key|unique/i.test(message)) {
    return `توجد قيمة مكرّرة في ${spec.label}. الرمز أو الاسم مستخدم مسبقاً.`;
  }
  console.error("[restaurant-hr] فشل تعديل كيان الإعدادات:", error);
  return `تعذّر حفظ ${spec.singular}. تحقّق من القيم المُدخلة.`;
}

/** فحص صلاحية الوصول لكيان: القراءة تقبل صلاحية الإدارة أيضاً. */
async function requireEntityAccess(
  req: AuthedRequest,
  spec: EntitySpec,
  mode: "read" | "manage",
): Promise<boolean> {
  return mode === "manage"
    ? hasAnyPermission(req, [spec.managePermission, PERMISSIONS.settingsManage])
    : hasAnyPermission(req, [
        spec.readPermission,
        spec.managePermission,
        PERMISSIONS.settingsManage,
      ]);
}

/**
 * ملخّص لوحة الإعدادات: أعداد السجلات في كل كيان — يظهر أعلى الشاشة.
 */
settingsRouter.get(
  "/settings/summary",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const counts: Record<string, number> = {};

    for (const spec of ENTITY_SPECS) {
      const [row] = await db.select({ total: count() }).from(spec.table);
      counts[spec.key] = Number(row?.total ?? 0);
    }

    const [employeeRow] = await db
      .select({ total: count() })
      .from(employees)
      .where(sql`${employees.isActive} = true`);

    res.json({
      ok: true,
      counts: { ...counts, activeEmployees: Number(employeeRow?.total ?? 0) },
    });
  },
);
