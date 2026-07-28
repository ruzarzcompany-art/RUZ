import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../../db/index.js";
import {
  advances,
  bonuses,
  contracts,
  custodyItems,
  employees,
  leaveRequests,
  overtimeRequests,
  salaryDefinitions,
  vouchers,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { DEMO_EMPLOYEE_CODES } from "../demo.js";
import {
  hasAnyPermission,
  PERMISSIONS,
  requireAnyPermission,
  requirePermission,
} from "../rbac.js";
import {
  asBool,
  asDateOnly,
  asEnum,
  asId,
  asMonthKey,
  asNumber,
  asString,
  inclusiveDays,
  round2,
} from "../validate.js";

/* ── محرّك النماذج ───────────────────────────────────────────────
 * كل نماذج الموارد البشرية تشترك في نفس القواعد: مرتبطة بموظف، لها حقول
 * محدّدة، بعضها يقدّمه الموظف بنفسه، والاعتماد/الرفض/التعديل للموارد البشرية
 * أو المدير. لذلك تُولَّد مساراتها من وصف واحد لكل نموذج مع تدقيق كامل.
 */

type FieldKind = "string" | "money" | "number" | "date" | "enum" | "bool" | "month";

interface FieldSpec {
  name: string;
  kind: FieldKind;
  labelAr: string;
  required?: boolean;
  /** يستطيع الموظف تعبئته في طلبه الخاص */
  self?: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
}

interface ResourceSpec {
  key: string;
  labelAr: string;
  table: PgTable;
  entity: string;
  fields: FieldSpec[];
  /** يملك حالة pending/approved/rejected وقرار مسؤول */
  decidable: boolean;
  /** يستطيع الموظف تقديمه لنفسه */
  selfSubmit: boolean;
  managePermission: string;
  readAllPermission: string;
  approvePermission?: string;
  /** جدول قد يكون بلا موظف مرتبط (السندات) */
  ownerOptional?: boolean;
  dateColumn?: string;
  beforeCreate?: (values: Record<string, unknown>, employeeId: number | null) => Promise<void>;
}

const DECISION_STATUSES = ["pending", "approved", "rejected"] as const;

const RESOURCES: ResourceSpec[] = [
  {
    key: "advances",
    labelAr: "طلب سلفة",
    table: advances,
    entity: "advances",
    decidable: true,
    selfSubmit: true,
    managePermission: PERMISSIONS.formsApprove,
    readAllPermission: PERMISSIONS.formsReadAll,
    dateColumn: "requestDate",
    fields: [
      { name: "amount", kind: "money", labelAr: "المبلغ", required: true, self: true, min: 0 },
      { name: "requestDate", kind: "date", labelAr: "التاريخ", required: true, self: true },
      { name: "reason", kind: "string", labelAr: "السبب", self: true },
      { name: "deductFromPayroll", kind: "bool", labelAr: "خصم من الراتب" },
      { name: "deductionMonth", kind: "month", labelAr: "شهر الخصم" },
      { name: "status", kind: "enum", labelAr: "الحالة", values: DECISION_STATUSES },
      { name: "decisionNote", kind: "string", labelAr: "ملاحظة القرار" },
    ],
  },
  {
    key: "overtime",
    labelAr: "طلب أوفرتايم",
    table: overtimeRequests,
    entity: "overtime_requests",
    decidable: true,
    selfSubmit: true,
    managePermission: PERMISSIONS.formsApprove,
    readAllPermission: PERMISSIONS.formsReadAll,
    dateColumn: "workDate",
    fields: [
      { name: "hours", kind: "number", labelAr: "عدد الساعات", required: true, self: true, min: 0, max: 24 },
      { name: "workDate", kind: "date", labelAr: "التاريخ", required: true, self: true },
      { name: "reason", kind: "string", labelAr: "السبب", self: true },
      { name: "status", kind: "enum", labelAr: "الحالة", values: DECISION_STATUSES },
      { name: "decisionNote", kind: "string", labelAr: "ملاحظة القرار" },
    ],
  },
  {
    key: "leaves",
    labelAr: "طلب إجازة",
    table: leaveRequests,
    entity: "leave_requests",
    decidable: true,
    selfSubmit: true,
    managePermission: PERMISSIONS.formsApprove,
    readAllPermission: PERMISSIONS.formsReadAll,
    dateColumn: "startDate",
    fields: [
      {
        name: "leaveType",
        kind: "enum",
        labelAr: "نوع الإجازة",
        self: true,
        values: ["annual", "sick", "unpaid", "emergency", "other"],
      },
      { name: "startDate", kind: "date", labelAr: "من تاريخ", required: true, self: true },
      { name: "endDate", kind: "date", labelAr: "إلى تاريخ", required: true, self: true },
      { name: "reason", kind: "string", labelAr: "السبب", self: true },
      { name: "days", kind: "number", labelAr: "عدد الأيام", min: 0 },
      { name: "status", kind: "enum", labelAr: "الحالة", values: DECISION_STATUSES },
      { name: "decisionNote", kind: "string", labelAr: "ملاحظة القرار" },
    ],
  },
  {
    key: "bonuses",
    labelAr: "مكافأة",
    table: bonuses,
    entity: "bonuses",
    decidable: true,
    selfSubmit: false,
    managePermission: PERMISSIONS.bonusesManage,
    readAllPermission: PERMISSIONS.formsReadAll,
    dateColumn: "bonusDate",
    fields: [
      { name: "amount", kind: "money", labelAr: "المبلغ", required: true, min: 0 },
      { name: "bonusDate", kind: "date", labelAr: "التاريخ", required: true },
      { name: "reason", kind: "string", labelAr: "السبب" },
      { name: "status", kind: "enum", labelAr: "الحالة", values: DECISION_STATUSES },
    ],
  },
  {
    key: "custody",
    labelAr: "إخراج عهدة",
    table: custodyItems,
    entity: "custody_items",
    decidable: false,
    selfSubmit: false,
    managePermission: PERMISSIONS.custodyManage,
    readAllPermission: PERMISSIONS.formsReadAll,
    dateColumn: "issuedAt",
    fields: [
      { name: "itemName", kind: "string", labelAr: "البيان", required: true },
      {
        name: "itemType",
        kind: "enum",
        labelAr: "النوع",
        values: ["device", "uniform", "key", "other"],
      },
      { name: "serialNumber", kind: "string", labelAr: "الرقم التسلسلي" },
      { name: "quantity", kind: "number", labelAr: "الكمية", min: 1 },
      { name: "estimatedValue", kind: "money", labelAr: "القيمة التقديرية", min: 0 },
      { name: "issuedAt", kind: "date", labelAr: "تاريخ التسليم", required: true },
      { name: "dueReturnAt", kind: "date", labelAr: "تاريخ الإرجاع المتوقّع" },
      { name: "returnedAt", kind: "date", labelAr: "تاريخ الاستلام" },
      { name: "conditionNote", kind: "string", labelAr: "ملاحظة الحالة" },
      {
        name: "status",
        kind: "enum",
        labelAr: "الحالة",
        values: ["issued", "returned", "lost"],
      },
    ],
  },
  {
    key: "vouchers",
    labelAr: "سند",
    table: vouchers,
    entity: "vouchers",
    decidable: false,
    selfSubmit: false,
    ownerOptional: true,
    managePermission: PERMISSIONS.vouchersManage,
    readAllPermission: PERMISSIONS.vouchersManage,
    dateColumn: "voucherDate",
    fields: [
      {
        name: "type",
        kind: "enum",
        labelAr: "نوع السند",
        required: true,
        values: ["receipt", "payment"],
      },
      { name: "voucherNumber", kind: "string", labelAr: "رقم السند" },
      { name: "amount", kind: "money", labelAr: "المبلغ", required: true, min: 0 },
      { name: "voucherDate", kind: "date", labelAr: "التاريخ", required: true },
      { name: "description", kind: "string", labelAr: "البيان" },
      {
        name: "method",
        kind: "enum",
        labelAr: "طريقة الدفع",
        values: ["cash", "bank", "transfer"],
      },
      { name: "beneficiaryName", kind: "string", labelAr: "المستفيد" },
    ],
    beforeCreate: async (values) => {
      if (asString(values.voucherNumber, 60)) return;
      const db = getDb();
      const type = String(values.type ?? "payment");
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(vouchers)
        .where(eq(vouchers.type, type));
      const prefix = type === "receipt" ? "RV" : "PV";
      const year = String(values.voucherDate ?? "").slice(0, 4) || "0000";
      values.voucherNumber = `${prefix}-${year}-${String((row?.total ?? 0) + 1).padStart(4, "0")}`;
    },
  },
  {
    key: "contracts",
    labelAr: "عقد عمل",
    table: contracts,
    entity: "contracts",
    decidable: false,
    selfSubmit: false,
    managePermission: PERMISSIONS.contractsManage,
    readAllPermission: PERMISSIONS.formsReadAll,
    dateColumn: "startDate",
    fields: [
      { name: "contractNumber", kind: "string", labelAr: "رقم العقد" },
      { name: "jobTitle", kind: "string", labelAr: "المسمى الوظيفي" },
      { name: "startDate", kind: "date", labelAr: "تاريخ البداية", required: true },
      { name: "endDate", kind: "date", labelAr: "تاريخ النهاية" },
      { name: "basicSalary", kind: "money", labelAr: "الراتب الأساسي", min: 0 },
      { name: "allowancesTotal", kind: "money", labelAr: "إجمالي البدلات", min: 0 },
      { name: "probationMonths", kind: "number", labelAr: "فترة التجربة (شهور)", min: 0, max: 12 },
      { name: "workingHours", kind: "string", labelAr: "ساعات العمل" },
      { name: "terms", kind: "string", labelAr: "شروط إضافية", max: 8000 },
      {
        name: "status",
        kind: "enum",
        labelAr: "الحالة",
        values: ["draft", "active", "ended"],
      },
      { name: "signedAt", kind: "date", labelAr: "تاريخ التوقيع" },
    ],
    beforeCreate: async (values, employeeId) => {
      const db = getDb();

      if (!asString(values.contractNumber, 60)) {
        const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(contracts);
        const year = String(values.startDate ?? "").slice(0, 4) || "0000";
        values.contractNumber = `CN-${year}-${String((row?.total ?? 0) + 1).padStart(4, "0")}`;
      }

      if (employeeId === null) return;

      // تعبئة المسمى الوظيفي والراتب من ملف الموظف وتعريف راتبه إن لم تُحدَّد
      if (!asString(values.jobTitle, 200)) {
        const [employee] = await db
          .select({ jobTitle: employees.jobTitle })
          .from(employees)
          .where(eq(employees.id, employeeId))
          .limit(1);
        if (employee) values.jobTitle = employee.jobTitle;
      }

      if (values.basicSalary === undefined || values.basicSalary === 0) {
        const [salary] = await db
          .select()
          .from(salaryDefinitions)
          .where(eq(salaryDefinitions.employeeId, employeeId))
          .limit(1);
        if (salary) {
          values.basicSalary = salary.basicSalary;
          values.allowancesTotal = round2(
            salary.housingAllowance + salary.transportAllowance + salary.otherAllowances,
          );
        }
      }
    },
  },
];

export const RESOURCE_INDEX = new Map(RESOURCES.map((item) => [item.key, item]));

function coerceField(
  field: FieldSpec,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const fail = (message: string) => ({ ok: false as const, error: `${field.labelAr}: ${message}` });

  switch (field.kind) {
    case "string": {
      const value = asString(raw, field.max ?? 2000);
      return value === null ? fail("نص غير صالح") : { ok: true, value };
    }
    case "money":
    case "number": {
      const value = asNumber(raw);
      if (value === null) return fail("قيمة رقمية غير صالحة");
      if (field.min !== undefined && value < field.min) return fail(`لا يقل عن ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail(`لا يزيد عن ${field.max}`);
      return { ok: true, value: field.kind === "money" ? round2(value) : round2(value) };
    }
    case "date": {
      if (raw === null || raw === "") return { ok: true, value: null };
      const value = asDateOnly(raw);
      return value === null ? fail("التاريخ يجب أن يكون بصيغة YYYY-MM-DD") : { ok: true, value };
    }
    case "month": {
      if (raw === null || raw === "") return { ok: true, value: null };
      const value = asMonthKey(raw);
      return value === null ? fail("الشهر يجب أن يكون بصيغة YYYY-MM") : { ok: true, value };
    }
    case "enum": {
      const value = asEnum(raw, field.values ?? []);
      return value === null
        ? fail(`القيم المسموحة: ${(field.values ?? []).join("، ")}`)
        : { ok: true, value };
    }
    case "bool": {
      const value = asBool(raw);
      return value === null ? fail("قيمة منطقية غير صالحة") : { ok: true, value };
    }
    default:
      return fail("نوع غير مدعوم");
  }
}

/** يجمع الحقول المسموح بها من جسم الطلب مع التحقق من صحتها. */
function collectFields(
  resource: ResourceSpec,
  body: Record<string, unknown>,
  options: { onlySelfFields: boolean; requireRequired: boolean },
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const values: Record<string, unknown> = {};

  for (const field of resource.fields) {
    if (options.onlySelfFields && !field.self) continue;

    const raw = body[field.name];

    if (raw === undefined) {
      if (options.requireRequired && field.required) {
        return { ok: false, error: `${field.labelAr} مطلوب` };
      }
      continue;
    }

    const coerced = coerceField(field, raw);
    if (!coerced.ok) return coerced;
    values[field.name] = coerced.value;
  }

  // عدد أيام الإجازة يُحسب من التاريخين دائماً
  if (resource.key === "leaves") {
    const start = asString(values.startDate ?? body.startDate, 10);
    const end = asString(values.endDate ?? body.endDate, 10);
    if (start && end) {
      const days = inclusiveDays(start, end);
      if (days <= 0) return { ok: false, error: "تاريخ النهاية يجب أن يكون بعد تاريخ البداية" };
      values.days = days;
    }
  }

  return { ok: true, values };
}

const table = (resource: ResourceSpec) => resource.table as unknown as Record<string, any>;

/* ── الحذف الجماعي للنماذج السابقة أو التجريبية ────────────────────
 * الحذف صفاً صفاً لا يكفي عند تنظيف نظام كان تحت التجربة: المطلوب مسح
 * النماذج القديمة أو المرتبطة بالحسابات التجريبية بضغطة واحدة. لذلك نبني
 * شرط الحذف من نطاق واحد يُستخدم في المعاينة (عدّ الصفوف) وفي التنفيذ،
 * فما يراه المستخدم قبل التأكيد هو نفسه ما سيُحذف.
 */

const PURGE_SCOPES = ["before", "decided", "demo", "all"] as const;
type PurgeScope = (typeof PURGE_SCOPES)[number];

const PURGE_SCOPE_LABELS: Record<PurgeScope, string> = {
  before: "قبل تاريخ",
  decided: "المعتمدة والمرفوضة",
  demo: "سجلات الحسابات التجريبية",
  all: "كل السجلات",
};

/** أرقام الموظفين التجريبيين المتبقية في القاعدة (قد تكون فارغة بعد الحذف). */
async function demoEmployeeIds(): Promise<number[]> {
  const rows = await getDb()
    .select({ id: employees.id })
    .from(employees)
    .where(inArray(employees.employeeCode, [...DEMO_EMPLOYEE_CODES]));
  return rows.map((row) => row.id);
}

type PurgeFilter =
  | { ok: true; where: SQL | undefined; describe: string }
  | { ok: false; error: string };

/**
 * يحوّل نطاق الحذف إلى شرط SQL واحد.
 *
 * `all` يعيد `undefined` أي بلا شرط — وهذا مقصود، لكنه لا يُنفَّذ إلا بعد
 * كتابة كلمة التأكيد في الطلب.
 */
async function buildPurgeFilter(
  resource: ResourceSpec,
  columns: Record<string, any>,
  scope: PurgeScope,
  source: Record<string, unknown>,
): Promise<PurgeFilter> {
  if (scope === "all") {
    return { ok: true, where: undefined, describe: PURGE_SCOPE_LABELS.all };
  }

  if (scope === "before") {
    const before = asDateOnly(source.before);
    if (before === null) {
      return { ok: false, error: "حدّد التاريخ الذي يُحذف ما قبله." };
    }
    // الحقل التاريخي للنموذج إن وُجد، وإلا تاريخ الإدخال
    const useDateColumn = Boolean(resource.dateColumn);
    const column = useDateColumn ? columns[resource.dateColumn!] : columns.createdAt;
    const value = useDateColumn ? before : new Date(`${before}T00:00:00.000Z`);
    return {
      ok: true,
      where: lt(column, value),
      describe: `قبل ${before}`,
    };
  }

  if (scope === "decided") {
    if (!resource.decidable) {
      return { ok: false, error: "هذا النموذج بلا اعتماد أو رفض." };
    }
    return {
      ok: true,
      where: inArray(columns.status, ["approved", "rejected"]),
      describe: PURGE_SCOPE_LABELS.decided,
    };
  }

  const ids = await demoEmployeeIds();
  if (ids.length === 0) {
    return { ok: false, error: "لا توجد حسابات تجريبية في القاعدة — لا شيء لحذفه." };
  }
  return {
    ok: true,
    where: inArray(columns.employeeId, ids),
    describe: PURGE_SCOPE_LABELS.demo,
  };
}

export const formsRouter = Router();

/** وصف النماذج وحقولها — تستخدمه الواجهة لبناء الشاشات تلقائياً. */
formsRouter.get("/forms/schema", requireAuth, (_req: AuthedRequest, res: Response) => {
  res.json({
    ok: true,
    resources: RESOURCES.map((resource) => ({
      key: resource.key,
      labelAr: resource.labelAr,
      decidable: resource.decidable,
      selfSubmit: resource.selfSubmit,
      ownerOptional: resource.ownerOptional ?? false,
      managePermission: resource.managePermission,
      fields: resource.fields.map((field) => ({
        name: field.name,
        kind: field.kind,
        labelAr: field.labelAr,
        required: field.required ?? false,
        self: field.self ?? false,
        values: field.values ?? null,
      })),
    })),
  });
});

for (const resource of RESOURCES) {
  const columns = table(resource);

  /* ── قراءة ─────────────────────────────────────────────────── */
  formsRouter.get(
    `/forms/${resource.key}`,
    requireAuth,
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const actor = req.employee!;

      const canReadAll = await hasAnyPermission(req, [
        resource.readAllPermission,
        resource.managePermission,
      ]);

      const requestedEmployee = asId(req.query.employeeId);
      const ownerFilter = canReadAll ? requestedEmployee : actor.id;

      const from = asDateOnly(req.query.from);
      const to = asDateOnly(req.query.to);
      const dateColumn = resource.dateColumn ? columns[resource.dateColumn] : null;

      const filters = [
        ownerFilter === null ? undefined : eq(columns.employeeId, ownerFilter),
        dateColumn && from ? gte(dateColumn, from) : undefined,
        dateColumn && to ? lte(dateColumn, to) : undefined,
      ].filter((item) => item !== undefined);

      const rows = await db
        .select({
          row: resource.table,
          employeeCode: employees.employeeCode,
          fullName: employees.fullName,
        })
        .from(resource.table)
        .leftJoin(employees, eq(columns.employeeId, employees.id))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(columns.id))
        .limit(300);

      res.json({
        ok: true,
        scope: canReadAll ? "all" : "own",
        items: rows.map((entry) => ({
          ...(entry.row as Record<string, unknown>),
          employeeCode: entry.employeeCode,
          fullName: entry.fullName,
        })),
      });
    },
  );

  /* ── قراءة عنصر واحد (تستخدمها صفحة الطباعة) ───────────────── */
  formsRouter.get(
    `/forms/${resource.key}/:id`,
    requireAuth,
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const actor = req.employee!;

      const id = asId(req.params.id);
      if (id === null) {
        res.status(400).json({ ok: false, error: "معرّف غير صالح" });
        return;
      }

      const [entry] = await db
        .select({
          row: resource.table,
          employeeCode: employees.employeeCode,
          fullName: employees.fullName,
        })
        .from(resource.table)
        .leftJoin(employees, eq(columns.employeeId, employees.id))
        .where(eq(columns.id, id))
        .limit(1);

      if (!entry) {
        res.status(404).json({ ok: false, error: "المستند غير موجود" });
        return;
      }

      const record = entry.row as Record<string, unknown>;
      const canReadAll = await hasAnyPermission(req, [
        resource.readAllPermission,
        resource.managePermission,
      ]);

      if (!canReadAll && record.employeeId !== actor.id) {
        res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض هذا المستند" });
        return;
      }

      res.json({
        ok: true,
        item: { ...record, employeeCode: entry.employeeCode, fullName: entry.fullName },
      });
    },
  );

  /* ── إنشاء ─────────────────────────────────────────────────── */
  formsRouter.post(
    `/forms/${resource.key}`,
    requireAuth,
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const actor = req.employee!;
      const canManage = await hasAnyPermission(req, [resource.managePermission]);

      const requestedOwner = asId(req.body?.employeeId);
      const isSelf = requestedOwner === null || requestedOwner === actor.id;

      if (!canManage) {
        if (!resource.selfSubmit || !isSelf) {
          res.status(403).json({ ok: false, error: "لا تملك صلاحية إنشاء هذا النموذج" });
          return;
        }
        if (!(await hasAnyPermission(req, [PERMISSIONS.formsSubmit]))) {
          res.status(403).json({ ok: false, error: "لا تملك صلاحية تقديم الطلبات" });
          return;
        }
      }

      const collected = collectFields(resource, req.body ?? {}, {
        onlySelfFields: !canManage,
        requireRequired: true,
      });

      if (!collected.ok) {
        res.status(400).json({ ok: false, error: collected.error });
        return;
      }

      const ownerId = canManage ? (requestedOwner ?? actor.id) : actor.id;

      if (!resource.ownerOptional && ownerId === null) {
        res.status(400).json({ ok: false, error: "الموظف المرتبط بالنموذج مطلوب" });
        return;
      }

      const values: Record<string, unknown> = {
        ...collected.values,
        employeeId: resource.ownerOptional && canManage ? (requestedOwner ?? null) : ownerId,
        createdByEmployeeId: actor.id,
      };

      // الطلب المُقدَّم من الموظف يبدأ دائماً «معلّقاً»
      if (resource.decidable && !canManage) values.status = "pending";

      if (resource.beforeCreate) {
        await resource.beforeCreate(values, (values.employeeId as number | null) ?? null);
      }

      const [created] = await db.insert(resource.table).values(values as never).returning();

      await recordAudit({
        actorEmployeeId: actor.id,
        action: `${resource.key}.create`,
        entityType: resource.entity,
        entityId: (created as { id: number }).id,
        after: created,
        reason: asString(req.body?.reason, 500) ?? "",
        ipAddress: clientIp(req),
      });

      res.status(201).json({ ok: true, message: `تم حفظ ${resource.labelAr}`, item: created });
    },
  );

  /* ── تعديل ─────────────────────────────────────────────────── */
  formsRouter.patch(
    `/forms/${resource.key}/:id`,
    requireAuth,
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const actor = req.employee!;
      const id = asId(req.params.id);

      if (id === null) {
        res.status(400).json({ ok: false, error: "معرّف غير صالح" });
        return;
      }

      const [before] = await db
        .select()
        .from(resource.table)
        .where(eq(columns.id, id))
        .limit(1);

      if (!before) {
        res.status(404).json({ ok: false, error: "النموذج غير موجود" });
        return;
      }

      const record = before as Record<string, unknown>;
      const canManage = await hasAnyPermission(req, [resource.managePermission]);
      const isOwner = record.employeeId === actor.id;
      const isPending = !resource.decidable || record.status === "pending";

      if (!canManage && !(resource.selfSubmit && isOwner && isPending)) {
        res.status(403).json({
          ok: false,
          error: isOwner
            ? "لا يمكن تعديل الطلب بعد صدور القرار"
            : "لا تملك صلاحية تعديل هذا النموذج",
        });
        return;
      }

      const collected = collectFields(resource, req.body ?? {}, {
        onlySelfFields: !canManage,
        requireRequired: false,
      });

      if (!collected.ok) {
        res.status(400).json({ ok: false, error: collected.error });
        return;
      }

      if (Object.keys(collected.values).length === 0) {
        res.status(400).json({ ok: false, error: "لا توجد حقول قابلة للتعديل في الطلب" });
        return;
      }

      const values: Record<string, unknown> = { ...collected.values };
      if ("updatedAt" in columns) values.updatedAt = new Date();

      const [after] = await db
        .update(resource.table)
        .set(values as never)
        .where(eq(columns.id, id))
        .returning();

      await recordAudit({
        actorEmployeeId: actor.id,
        action: `${resource.key}.update`,
        entityType: resource.entity,
        entityId: id,
        before,
        after,
        reason: asString(req.body?.reason, 500) ?? "",
        ipAddress: clientIp(req),
      });

      res.json({ ok: true, message: "تم تعديل النموذج", item: after });
    },
  );

  /* ── قرار الاعتماد/الرفض ───────────────────────────────────── */
  if (resource.decidable) {
    formsRouter.post(
      `/forms/${resource.key}/:id/decision`,
      requireAuth,
      requireAnyPermission(resource.approvePermission ?? resource.managePermission),
      async (req: AuthedRequest, res: Response) => {
        const db = getDb();
        const actor = req.employee!;
        const id = asId(req.params.id);
        const status = asEnum(req.body?.status ?? req.body?.decision, [
          "approved",
          "rejected",
          "pending",
        ] as const);
        const note = asString(req.body?.decisionNote ?? req.body?.note, 1000) ?? "";

        if (id === null || status === null) {
          res.status(400).json({
            ok: false,
            error: "المعرّف والحالة مطلوبان (approved أو rejected).",
          });
          return;
        }

        const [before] = await db
          .select()
          .from(resource.table)
          .where(eq(columns.id, id))
          .limit(1);

        if (!before) {
          res.status(404).json({ ok: false, error: "النموذج غير موجود" });
          return;
        }

        const values: Record<string, unknown> = {
          status,
          decidedAt: new Date(),
          decidedByEmployeeId: actor.id,
        };
        if ("decisionNote" in columns) values.decisionNote = note;
        if ("updatedAt" in columns) values.updatedAt = new Date();

        const [after] = await db
          .update(resource.table)
          .set(values as never)
          .where(eq(columns.id, id))
          .returning();

        await recordAudit({
          actorEmployeeId: actor.id,
          action: `${resource.key}.decide`,
          entityType: resource.entity,
          entityId: id,
          before,
          after,
          reason: note,
          ipAddress: clientIp(req),
        });

        res.json({
          ok: true,
          message: status === "approved" ? "تم اعتماد الطلب" : status === "rejected" ? "تم رفض الطلب" : "أُعيد الطلب إلى «معلّق»",
          item: after,
        });
      },
    );
  }

  /* ── حذف ───────────────────────────────────────────────────── */
  formsRouter.delete(
    `/forms/${resource.key}/:id`,
    requireAuth,
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const actor = req.employee!;
      const id = asId(req.params.id);

      if (id === null) {
        res.status(400).json({ ok: false, error: "معرّف غير صالح" });
        return;
      }

      const [before] = await db
        .select()
        .from(resource.table)
        .where(eq(columns.id, id))
        .limit(1);

      if (!before) {
        res.status(404).json({ ok: false, error: "النموذج غير موجود" });
        return;
      }

      const record = before as Record<string, unknown>;
      const canManage = await hasAnyPermission(req, [resource.managePermission]);
      const isOwner = record.employeeId === actor.id;
      const isPending = resource.decidable && record.status === "pending";

      if (!canManage && !(resource.selfSubmit && isOwner && isPending)) {
        res.status(403).json({ ok: false, error: "لا تملك صلاحية حذف هذا النموذج" });
        return;
      }

      await db.delete(resource.table).where(eq(columns.id, id));

      await recordAudit({
        actorEmployeeId: actor.id,
        action: `${resource.key}.delete`,
        entityType: resource.entity,
        entityId: id,
        before,
        reason: asString(req.body?.reason, 500) ?? "",
        ipAddress: clientIp(req),
      });

      res.json({ ok: true, message: "تم الحذف" });
    },
  );

  /* ── معاينة الحذف الجماعي (عدّ ما سيُحذف) ───────────────────── */
  formsRouter.get(
    `/forms/${resource.key}/purge/preview`,
    requireAuth,
    requirePermission(resource.managePermission),
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const scope = asEnum(req.query.scope, PURGE_SCOPES) ?? "before";
      const filter = await buildPurgeFilter(resource, columns, scope, {
        before: req.query.before,
      });

      if (!filter.ok) {
        res.status(400).json({ ok: false, error: filter.error });
        return;
      }

      const [counted] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(resource.table)
        .where(filter.where);

      res.json({
        ok: true,
        scope,
        describe: filter.describe,
        count: counted?.count ?? 0,
      });
    },
  );

  /* ── تنفيذ الحذف الجماعي ────────────────────────────────────── */
  formsRouter.post(
    `/forms/${resource.key}/purge`,
    requireAuth,
    requirePermission(resource.managePermission),
    async (req: AuthedRequest, res: Response) => {
      const db = getDb();
      const actor = req.employee!;
      const scope = asEnum(req.body?.scope, PURGE_SCOPES) ?? "before";
      const confirm = asString(req.body?.confirm, 40) ?? "";

      if (confirm !== "حذف" && confirm.toUpperCase() !== "DELETE") {
        res.status(400).json({
          ok: false,
          error: "اكتب كلمة «حذف» للتأكيد — الحذف الجماعي لا يمكن الرجوع عنه.",
        });
        return;
      }

      const filter = await buildPurgeFilter(
        resource,
        columns,
        scope,
        (req.body ?? {}) as Record<string, unknown>,
      );

      if (!filter.ok) {
        res.status(400).json({ ok: false, error: filter.error });
        return;
      }

      const removed = await db
        .delete(resource.table)
        .where(filter.where)
        .returning({ id: columns.id });

      await recordAudit({
        actorEmployeeId: actor.id,
        action: `${resource.key}.purge`,
        entityType: resource.entity,
        before: { scope, describe: filter.describe, ids: removed.map((item) => item.id) },
        after: { deleted: removed.length },
        reason: asString(req.body?.reason, 500) ?? `حذف جماعي: ${filter.describe}`,
        ipAddress: clientIp(req),
      });

      res.json({
        ok: true,
        deleted: removed.length,
        scope,
        describe: filter.describe,
        message:
          removed.length === 0
            ? `لا توجد سجلات مطابقة (${filter.describe}).`
            : `تم حذف ${removed.length} من «${resource.labelAr}» (${filter.describe}).`,
      });
    },
  );
}

/* ── تعريف الراتب (صف واحد لكل موظف) ──────────────────────────── */

formsRouter.get(
  "/forms/salary",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const canReadAll = await hasAnyPermission(req, [
      PERMISSIONS.salaryManage,
      PERMISSIONS.payrollManage,
    ]);
    const employeeId = canReadAll ? asId(req.query.employeeId) : actor.id;

    const rows = await db
      .select({
        row: salaryDefinitions,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
      })
      .from(salaryDefinitions)
      .leftJoin(employees, eq(salaryDefinitions.employeeId, employees.id))
      .where(employeeId === null ? undefined : eq(salaryDefinitions.employeeId, employeeId))
      .orderBy(asc(salaryDefinitions.employeeId));

    res.json({
      ok: true,
      scope: canReadAll ? "all" : "own",
      items: rows.map((entry) => ({
        ...entry.row,
        employeeCode: entry.employeeCode,
        fullName: entry.fullName,
      })),
    });
  },
);

formsRouter.put(
  "/forms/salary/:employeeId",
  requireAuth,
  requirePermission(PERMISSIONS.salaryManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.employeeId);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const numbers = {
      basicSalary: asNumber(req.body?.basicSalary),
      housingAllowance: asNumber(req.body?.housingAllowance),
      transportAllowance: asNumber(req.body?.transportAllowance),
      otherAllowances: asNumber(req.body?.otherAllowances),
      hourlyRate: asNumber(req.body?.hourlyRate),
      contractHoursPerMonth: asNumber(req.body?.contractHoursPerMonth),
      overtimeMultiplier: asNumber(req.body?.overtimeMultiplier),
    };

    if (numbers.basicSalary === null || numbers.basicSalary < 0) {
      res.status(400).json({ ok: false, error: "الراتب الأساسي مطلوب ولا يكون سالباً." });
      return;
    }

    const values = {
      employeeId,
      basicSalary: round2(numbers.basicSalary),
      housingAllowance: round2(Math.max(0, numbers.housingAllowance ?? 0)),
      transportAllowance: round2(Math.max(0, numbers.transportAllowance ?? 0)),
      otherAllowances: round2(Math.max(0, numbers.otherAllowances ?? 0)),
      hourlyRate:
        numbers.hourlyRate === null || numbers.hourlyRate <= 0
          ? null
          : round2(numbers.hourlyRate),
      contractHoursPerMonth:
        numbers.contractHoursPerMonth && numbers.contractHoursPerMonth > 0
          ? round2(numbers.contractHoursPerMonth)
          : 240,
      overtimeMultiplier:
        numbers.overtimeMultiplier && numbers.overtimeMultiplier > 0
          ? numbers.overtimeMultiplier
          : 1.5,
      effectiveFrom: asDateOnly(req.body?.effectiveFrom),
      note: asString(req.body?.note, 1000) ?? "",
      updatedByEmployeeId: actor.id,
      updatedAt: new Date(),
    };

    const [before] = await db
      .select()
      .from(salaryDefinitions)
      .where(eq(salaryDefinitions.employeeId, employeeId))
      .limit(1);

    const [after] = await db
      .insert(salaryDefinitions)
      .values(values)
      .onConflictDoUpdate({ target: salaryDefinitions.employeeId, set: values })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: before ? "salary.update" : "salary.create",
      entityType: "salary_definitions",
      entityId: after.id,
      before,
      after,
      reason: asString(req.body?.reason, 500) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حفظ تعريف الراتب", item: after });
  },
);
