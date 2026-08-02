/**
 * ملف الموظف الكامل، جدول دوامه، تخصيص صلاحياته الفردية، ومدير الفرع.
 *
 * - ملف الموظف: كل بيانات التعريف (الاسم، الجنسية، الهوية، الجوال، البريد،
 *   تاريخ الانضمام، القسم، المسمى، الفرع، الدور) + اسم مدير الفرع التابع له.
 * - جدول الدوام: يُستخدم في حساب التأخير والدوام الإضافي (انظر `server/schedule.ts`).
 * - الصلاحيات الفردية: تخصيص فوق صلاحيات الدور (`allow` / `deny`).
 * - مدير الفرع: يُختار من الموظفين بدور «مدير فرع» ويظهر في ملف كل موظف بالفرع.
 */

import { Router, type Response } from "express";
import { and, asc, eq, gte, lte, ne } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  employees,
  faceTemplates,
  permissions as permissionsTable,
  rolePermissions,
  roles,
  salaryDefinitions,
  scheduleOffDates,
  workSchedules,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { getSeedPassword } from "../config.js";
import { hashPassword } from "../passwords.js";
import {
    hasAnyPermission,
    PERMISSIONS,
    requireAnyPermission,
    requireModuleDelete,
      requirePermission,
} from "../rbac.js";
import {
  ALLOWED_DAYS_OFF,
  getOffDates,
  getOffDatesFor,
  isIsoDate,
  isTimeOfDay,
  MAX_DAYS_OFF_PER_MONTH,
  monthBounds,
  OFF_MODES,
  offScheduleLabel,
  parseOffDays,
  WEEKDAY_NAMES,
} from "../schedule.js";
import {
  asBool,
  asDateTime,
  asEnum,
  asId,
  asNumber,
  asString,
} from "../validate.js";

export const peopleRouter = Router();

/** أدوار يُسمح بتعيينها مسؤولة عن فرع. */
const BRANCH_MANAGER_ROLES = ["branch_manager", "super_admin"];

/* ── قراءة ملف الموظف ─────────────────────────────────────────── */

/** يجمع ملف الموظف الكامل: بياناته + فرعه ومديره + دوره + جدول دوامه. */
async function loadEmployeeFile(employeeId: number) {
  const db = getDb();

  const [row] = await db
    .select({
      employee: employees,
      branchId: branches.id,
      branchCode: branches.code,
      branchName: branches.name,
      branchTimezone: branches.timezone,
      branchManagerId: branches.managerEmployeeId,
      roleName: roles.name,
      roleNameAr: roles.nameAr,
    })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .leftJoin(roles, eq(employees.roleId, roles.id))
    .where(eq(employees.id, employeeId))
    .limit(1);

  if (!row) return null;

  // اسم مدير الفرع الذي يتبعه الموظف — يظهر داخل ملفه
  let manager: { id: number; fullName: string; employeeCode: string; phone: string | null } | null =
    null;
  if (row.branchManagerId) {
    const [managerRow] = await db
      .select({
        id: employees.id,
        fullName: employees.fullName,
        employeeCode: employees.employeeCode,
        phone: employees.phone,
      })
      .from(employees)
      .where(eq(employees.id, row.branchManagerId))
      .limit(1);
    manager = managerRow ?? null;
  }

  const [schedule] = await db
    .select()
    .from(workSchedules)
    .where(eq(workSchedules.employeeId, employeeId))
    .limit(1);

  // تواريخ إجازة الشهر الحالي فقط — تكفي للعرض في الملف بلا قوائم طويلة
  const today = new Date();
  const scheduleOffDatesList =
    schedule && schedule.offMode === "dates"
      ? await getOffDates(
          employeeId,
          monthBounds(today.getUTCFullYear(), today.getUTCMonth() + 1),
        )
      : [];

  const [face] = await db
    .select({ enrolledAt: faceTemplates.enrolledAt })
    .from(faceTemplates)
    .where(eq(faceTemplates.employeeId, employeeId))
    .limit(1);

  const { passwordHash: _hidden, ...profile } = row.employee;

  return {
    employee: {
      ...profile,
      /** تاريخ الانضمام بصيغة قابلة للعرض في حقل `date` */
      joinDate: profile.hiredAt ? profile.hiredAt.toISOString().slice(0, 10) : null,
      branchName: row.branchName,
      branchCode: row.branchCode,
      branchTimezone: row.branchTimezone,
      roleName: row.roleName,
      roleNameAr: row.roleNameAr,
      branchManagerName: manager?.fullName ?? null,
      branchManagerCode: manager?.employeeCode ?? null,
    },
    branchManager: manager,
    schedule: schedule
      ? {
          ...schedule,
          offDates: scheduleOffDatesList,
          offDaysLabel: offScheduleLabel({ ...schedule, offDates: scheduleOffDatesList }),
        }
      : null,
    faceEnrolledAt: face?.enrolledAt ?? null,
  };
}

/** ملف الموظف الحالي — متاح لأي مستخدم مسجّل دخوله. */
peopleRouter.get(
  "/employees/me/file",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const file = await loadEmployeeFile(req.employee!.id);
    if (!file) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }
    res.json({ ok: true, ...file, scope: "own" });
  },
);

/** ملف موظف محدّد — لصاحب الملف أو لمن يملك صلاحية عرض الموظفين. */
peopleRouter.get(
  "/employees/:id/file",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const employeeId = asId(req.params.id);
    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const isSelf = employeeId === req.employee!.id;
    if (!isSelf && !(await hasAnyPermission(req, [PERMISSIONS.employeesRead]))) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض ملف هذا الموظف" });
      return;
    }

    const file = await loadEmployeeFile(employeeId);
    if (!file) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    res.json({ ok: true, ...file, scope: isSelf ? "own" : "all" });
  },
);

/* ── إضافة وتعديل الموظف ──────────────────────────────────────── */

interface ProfileInput {
  fullName?: string;
  nationality?: string;
  nationalId?: string | null;
  phone?: string | null;
  email?: string | null;
  department?: string;
  jobTitle?: string;
  branchId?: number | null;
  roleId?: number | null;
  hiredAt?: Date | null;
  isActive?: boolean;
  faceEnabled?: boolean;
}

/** يقرأ حقول الملف من الجسم — يتجاهل ما لم يُرسَل حتى يصلح للتعديل الجزئي. */
function readProfile(body: unknown): ProfileInput {
  const source = (body ?? {}) as Record<string, unknown>;
  const profile: ProfileInput = {};

  const fullName = asString(source.fullName, 200);
  if (fullName !== null) profile.fullName = fullName;

  const nationality = asString(source.nationality, 100);
  if (nationality !== null) profile.nationality = nationality;

  if ("nationalId" in source) {
    const nationalId = asString(source.nationalId, 40);
    profile.nationalId = nationalId ? nationalId : null;
  }

  if ("phone" in source) {
    const phone = asString(source.phone, 40);
    profile.phone = phone ? phone : null;
  }

  if ("email" in source) {
    const email = asString(source.email, 200);
    profile.email = email ? email.toLowerCase() : null;
  }

  const department = asString(source.department, 120);
  if (department !== null) profile.department = department;

  const jobTitle = asString(source.jobTitle, 120);
  if (jobTitle !== null) profile.jobTitle = jobTitle;

  if ("branchId" in source) profile.branchId = asId(source.branchId);
  if ("roleId" in source) profile.roleId = asId(source.roleId);

  if ("joinDate" in source || "hiredAt" in source) {
    const raw = source.joinDate ?? source.hiredAt;
    const asDate = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
      ? asDateTime(`${raw.trim()}T00:00:00Z`)
      : asDateTime(raw);
    profile.hiredAt = asDate;
  }

  const isActive = asBool(source.isActive);
  if (isActive !== null) profile.isActive = isActive;

  // علامة تفعيل بصمة الوجه لهذا الموظف (checkbox في شاشة الموظفين)
  const faceEnabled = asBool(source.faceEnabled);
  if (faceEnabled !== null) profile.faceEnabled = faceEnabled;

  return profile;
}

/** يتحقق من وجود الفرع والدور المُشار إليهما. */
async function validateReferences(profile: ProfileInput): Promise<string | null> {
  const db = getDb();

  if (profile.branchId) {
    const [branch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, profile.branchId))
      .limit(1);
    if (!branch) return "الفرع المُحدّد غير موجود";
  }

  if (profile.roleId) {
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, profile.roleId))
      .limit(1);
    if (!role) return "الدور المُحدّد غير موجود";
  }

  return null;
}

/** إضافة موظف جديد بملفه الكامل. */
peopleRouter.post(
  "/employees",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;

    const employeeCode = asString(req.body?.employeeCode, 40);
    const profile = readProfile(req.body);

    if (!employeeCode || !profile.fullName) {
      res.status(400).json({ ok: false, error: "الرقم الوظيفي والاسم الكامل مطلوبان." });
      return;
    }

    const referenceError = await validateReferences(profile);
    if (referenceError) {
      res.status(400).json({ ok: false, error: referenceError });
      return;
    }

    const [existing] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.employeeCode, employeeCode))
      .limit(1);

    if (existing) {
      res.status(409).json({ ok: false, error: "الرقم الوظيفي مستخدم مسبقاً." });
      return;
    }

    const password = asString(req.body?.password, 200);
    const [created] = await db
      .insert(employees)
      .values({
        employeeCode,
        fullName: profile.fullName,
        nationality: profile.nationality ?? "",
        nationalId: profile.nationalId ?? null,
        phone: profile.phone ?? null,
        email: profile.email ?? null,
        department: profile.department ?? "",
        jobTitle: profile.jobTitle ?? "",
        branchId: profile.branchId ?? null,
        roleId: profile.roleId ?? null,
        hiredAt: profile.hiredAt ?? new Date(),
        isActive: profile.isActive ?? true,
        faceEnabled: profile.faceEnabled ?? true,
        passwordHash: hashPassword(password || getSeedPassword()),
        mustChangePassword: !password,
      })
      .returning();

    const { passwordHash: _hidden, ...safe } = created;

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "employee.create",
      entityType: "employees",
      entityId: created.id,
      after: safe,
      reason: asString(req.body?.reason, 500) ?? "إضافة موظف جديد",
      ipAddress: clientIp(req),
    });

    res.status(201).json({
      ok: true,
      message: password
        ? `تم إضافة ${created.fullName}`
        : `تم إضافة ${created.fullName} بكلمة المرور الافتراضية — يجب تغييرها عند أول دخول.`,
      employee: safe,
    });
  },
);

/** تعديل ملف موظف قائم. */
peopleRouter.patch(
  "/employees/:id",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const profile = readProfile(req.body);
    const referenceError = await validateReferences(profile);
    if (referenceError) {
      res.status(400).json({ ok: false, error: referenceError });
      return;
    }

    const employeeCode = asString(req.body?.employeeCode, 40);
    if (employeeCode && employeeCode !== before.employeeCode) {
      const [clash] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.employeeCode, employeeCode), ne(employees.id, employeeId)))
        .limit(1);
      if (clash) {
        res.status(409).json({ ok: false, error: "الرقم الوظيفي مستخدم مسبقاً." });
        return;
      }
    }

    const password = asString(req.body?.password, 200);
    const changes: Record<string, unknown> = {
      ...profile,
      ...(employeeCode ? { employeeCode } : {}),
      ...(password ? { passwordHash: hashPassword(password), mustChangePassword: false } : {}),
      updatedAt: new Date(),
    };

    const [after] = await db
      .update(employees)
      .set(changes)
      .where(eq(employees.id, employeeId))
      .returning();

    const { passwordHash: _hiddenBefore, ...safeBefore } = before;
    const { passwordHash: _hiddenAfter, ...safeAfter } = after;

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "employee.update",
      entityType: "employees",
      entityId: employeeId,
      before: safeBefore,
      after: safeAfter,
      reason: asString(req.body?.reason, 500) ?? "تعديل ملف الموظف",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم تحديث ملف الموظف", employee: safeAfter });
  },
);

/* ── حذف الموظف ───────────────────────────────────────────────── */

/**
 * حذف موظف نهائياً من ملف الموظفين.
 *
 * كل المراجع إلى `employees.id` معرّفة بـ`cascade` أو `set null`، فحذف الصف
 * يُزيل معه الحضور والنماذج والرواتب وجدول الدوام وقوالب الوجه والصلاحيات.
 * يُمنع حذف الحساب المنفّذ نفسه، ويُمنع حذف آخر حساب يملك صلاحية إدارة
 * الموظفين حتى لا يُقفل النظام على نفسه. تُلتقط صورة الصف في سجل التدقيق قبل
 * الحذف ليبقى أثر للعملية.
 */
peopleRouter.delete(
  "/employees/:id",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  requireModuleDelete("employees"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    if (employeeId === actor.id) {
      res.status(400).json({ ok: false, error: "لا يمكنك حذف حسابك الخاص." });
      return;
    }

    const [before] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    // لا نسمح بحذف آخر حساب يملك صلاحية إدارة الموظفين حتى لا يُقفل النظام
    const managers = await db
      .select({ id: employees.id })
      .from(employees)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, employees.roleId))
      .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissions.permissionId))
      .where(
        and(
          eq(permissionsTable.code, PERMISSIONS.employeesWrite),
          eq(employees.isActive, true),
          ne(employees.id, employeeId),
        ),
      );

    if (managers.length === 0) {
      res.status(409).json({
        ok: false,
        error:
          "لا يمكن حذف آخر حساب يملك صلاحية إدارة الموظفين. عيّن حساباً آخر بهذه الصلاحية أولاً.",
      });
      return;
    }

    const reason = asString(req.body?.reason, 500) ?? "حذف ملف الموظف";
    const { passwordHash: _hidden, ...safeBefore } = before;

    // سجل التدقيق أولاً: `audit_logs.actor_employee_id` هو set null، فلا يضيع الأثر
    await recordAudit({
      actorEmployeeId: actor.id,
      action: "employee.delete",
      entityType: "employees",
      entityId: employeeId,
      before: safeBefore,
      reason,
      ipAddress: clientIp(req),
    });

    await db.delete(employees).where(eq(employees.id, employeeId));

    res.json({
      ok: true,
      message: `تم حذف ${before.fullName} وكل سجلاته المرتبطة.`,
      employeeId,
    });
  },
);

/* ── تفعيل بصمة الوجه ─────────────────────────────────────────── */

/**
 * تفعيل/تعطيل بصمة الوجه لموظف واحد — يقابل علامة الصح في جدول الموظفين.
 * تعطيلها يعني أن الموظف يسجّل حضوره دون تحقق بالوجه مهما كان الإعداد العام.
 */
peopleRouter.patch(
  "/employees/:id/face-enabled",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.id);
    const enabled = asBool(req.body?.enabled ?? req.body?.faceEnabled);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    if (enabled === null) {
      res.status(400).json({ ok: false, error: "قيمة التفعيل مطلوبة (صح/خطأ)" });
      return;
    }

    const [before] = await db
      .select({
        id: employees.id,
        fullName: employees.fullName,
        faceEnabled: employees.faceEnabled,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    await db
      .update(employees)
      .set({ faceEnabled: enabled, updatedAt: new Date() })
      .where(eq(employees.id, employeeId));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: enabled ? "face.enable" : "face.disable",
      entityType: "employees",
      entityId: employeeId,
      before: { faceEnabled: before.faceEnabled },
      after: { faceEnabled: enabled },
      reason: asString(req.body?.reason, 500) ?? "تغيير تفعيل بصمة الوجه",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: enabled
        ? `تم تفعيل بصمة الوجه لـ${before.fullName}`
        : `تم تعطيل بصمة الوجه لـ${before.fullName}`,
      employeeId,
      faceEnabled: enabled,
    });
  },
);

/** تفعيل/تعطيل بصمة الوجه لكل الموظفين دفعة واحدة. */
peopleRouter.post(
  "/employees/face-enabled/bulk",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const enabled = asBool(req.body?.enabled);

    if (enabled === null) {
      res.status(400).json({ ok: false, error: "قيمة التفعيل مطلوبة (صح/خطأ)" });
      return;
    }

    const updated = await db
      .update(employees)
      .set({ faceEnabled: enabled, updatedAt: new Date() })
      .where(ne(employees.faceEnabled, enabled))
      .returning({ id: employees.id });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: enabled ? "face.enable_all" : "face.disable_all",
      entityType: "employees",
      after: { faceEnabled: enabled, affected: updated.length },
      reason: asString(req.body?.reason, 500) ?? "تغيير جماعي لتفعيل بصمة الوجه",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: enabled
        ? `تم تفعيل بصمة الوجه لـ${updated.length} موظفاً`
        : `تم تعطيل بصمة الوجه لـ${updated.length} موظفاً`,
      affected: updated.length,
      faceEnabled: enabled,
    });
  },
);

/* ── جدول الدوام ──────────────────────────────────────────────── */

/** بيانات مساعدة للواجهة: أيام الأسبوع وعدد أيام الإجازة المسموحة. */
peopleRouter.get("/schedules/meta", requireAuth, (_req: AuthedRequest, res: Response) => {
  res.json({
    ok: true,
    weekdays: WEEKDAY_NAMES.map((label, value) => ({ value, label })),
    allowedDaysOff: [...ALLOWED_DAYS_OFF],
    maxDaysOffPerMonth: MAX_DAYS_OFF_PER_MONTH,
    offModes: [
      { value: "weekly", label: "أيام أسبوعية متكرّرة" },
      { value: "dates", label: "تواريخ محدّدة في الشهر" },
    ],
  });
});

peopleRouter.get(
  "/employees/:id/schedule",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const isSelf = employeeId === req.employee!.id;
    if (!isSelf && !(await hasAnyPermission(req, [PERMISSIONS.employeesRead]))) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض جدول هذا الموظف" });
      return;
    }

    const [schedule] = await db
      .select()
      .from(workSchedules)
      .where(eq(workSchedules.employeeId, employeeId))
      .limit(1);

    if (!schedule) {
      res.json({ ok: true, schedule: null });
      return;
    }

    const offDates = schedule.offMode === "dates" ? await getOffDates(employeeId) : [];

    res.json({
      ok: true,
      schedule: {
        ...schedule,
        offDates,
        offDaysLabel: offScheduleLabel({ ...schedule, offDates }),
      },
    });
  },
);

/** قائمة جداول الدوام كلها — لشاشة الموارد البشرية. */
peopleRouter.get(
  "/schedules",
  requireAuth,
  requirePermission(PERMISSIONS.employeesRead),
  async (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const rows = await db
      .select({
        schedule: workSchedules,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
      })
      .from(workSchedules)
      .leftJoin(employees, eq(workSchedules.employeeId, employees.id))
      .orderBy(asc(employees.employeeCode));

    const dateModeIds = rows
      .filter((row) => row.schedule.offMode === "dates")
      .map((row) => row.schedule.employeeId);
    const offDatesByEmployee = await getOffDatesFor(dateModeIds);

    res.json({
      ok: true,
      items: rows.map((row) => {
        const offDates = offDatesByEmployee.get(row.schedule.employeeId) ?? [];
        return {
          ...row.schedule,
          offDates,
          offDaysLabel: offScheduleLabel({ ...row.schedule, offDates }),
          employeeCode: row.employeeCode,
          fullName: row.fullName,
        };
      }),
    });
  },
);

/** تعريف/تحديث جدول دوام موظف (صف واحد لكل موظف). */
peopleRouter.put(
  "/employees/:id/schedule",
  requireAuth,
  requireAnyPermission(PERMISSIONS.schedulesManage, PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const shiftStart = asString(req.body?.shiftStart, 5) ?? "";
    const shiftEnd = asString(req.body?.shiftEnd, 5) ?? "";

    if (!isTimeOfDay(shiftStart) || !isTimeOfDay(shiftEnd)) {
      res.status(400).json({
        ok: false,
        error: "وقت بدء الدوام ووقت انتهائه مطلوبان بصيغة HH:MM (24 ساعة).",
      });
      return;
    }

    const dailyHours = asNumber(req.body?.dailyHours);
    if (dailyHours === null || dailyHours <= 0 || dailyHours > 24) {
      res.status(400).json({ ok: false, error: "عدد ساعات العمل اليومية يجب أن يكون بين 1 و24." });
      return;
    }

    const daysOffPerMonth = asNumber(req.body?.daysOffPerMonth);
    if (
      daysOffPerMonth === null ||
      !Number.isInteger(daysOffPerMonth) ||
      daysOffPerMonth < 0 ||
      daysOffPerMonth > MAX_DAYS_OFF_PER_MONTH
    ) {
      res.status(400).json({
        ok: false,
        error: `عدد أيام الإجازة الشهرية يجب أن يكون رقماً صحيحاً بين 0 و${MAX_DAYS_OFF_PER_MONTH}.`,
      });
      return;
    }

    const offMode = asEnum(req.body?.offMode, OFF_MODES) ?? "weekly";

    const requestedOffDays = Array.isArray(req.body?.offDays)
      ? parseOffDays((req.body.offDays as unknown[]).join(","))
      : parseOffDays(asString(req.body?.offDays, 40));

    // في نمط التواريخ لا تُفرض أيام أسبوعية: التواريخ تُدار من مسار مستقل
    if (offMode === "dates" && requestedOffDays.length > 0) {
      res.status(400).json({
        ok: false,
        error: "في نمط التواريخ المحدّدة تُختار أيام الإجازة بتاريخها لا بيوم الأسبوع.",
      });
      return;
    }

    // في النمط الأسبوعي: الأيام المحدّدة (إن وُجدت) يجب أن تُنتج عدداً شهرياً معقولاً
    if (offMode === "weekly" && requestedOffDays.length > 0) {
      const monthlyFromWeekly = requestedOffDays.length * 4;
      if (Math.abs(monthlyFromWeekly - daysOffPerMonth) > 3) {
        res.status(400).json({
          ok: false,
          error:
            `تحديد ${requestedOffDays.length} يوم أسبوعياً يعني نحو ${monthlyFromWeekly} أيام شهرياً،` +
            ` وهو بعيد عن ${daysOffPerMonth}. عدّل العدد الشهري أو الأيام، أو استخدم نمط التواريخ المحدّدة.`,
        });
        return;
      }
    }

    const [employee] = await db
      .select({ id: employees.id, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const [before] = await db
      .select()
      .from(workSchedules)
      .where(eq(workSchedules.employeeId, employeeId))
      .limit(1);

    const values = {
      employeeId,
      shiftStart,
      shiftEnd,
      dailyHours,
      breakMinutes: Math.max(0, Math.round(asNumber(req.body?.breakMinutes) ?? 0)),
      daysOffPerMonth: Math.round(daysOffPerMonth),
      offMode,
      offDays: requestedOffDays.join(","),
      graceMinutes: Math.max(0, Math.round(asNumber(req.body?.graceMinutes) ?? 10)),
      note: asString(req.body?.note, 500) ?? "",
      updatedByEmployeeId: actor.id,
      updatedAt: new Date(),
    };

    const [saved] = await db
      .insert(workSchedules)
      .values(values)
      .onConflictDoUpdate({ target: workSchedules.employeeId, set: values })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: before ? "schedule.update" : "schedule.create",
      entityType: "work_schedules",
      entityId: saved.id,
      before,
      after: saved,
      reason: asString(req.body?.reason, 500) ?? "تعريف جدول دوام",
      ipAddress: clientIp(req),
    });

    const offDates = offMode === "dates" ? await getOffDates(employeeId) : [];

    res.json({
      ok: true,
      message: `تم حفظ جدول دوام ${employee.fullName}`,
      schedule: {
        ...saved,
        offDates,
        offDaysLabel: offScheduleLabel({ ...saved, offDates }),
      },
    });
  },
);

/* ── أيام الإجازة بتواريخ محدّدة ───────────────────────────────── */

/**
 * تواريخ إجازة موظف. يمكن حصرها بشهر (`?year=&month=`) لعرض تقويم الشهر،
 * أو قراءتها كلها بلا معاملات.
 */
peopleRouter.get(
  "/employees/:id/off-dates",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const isSelf = employeeId === req.employee!.id;
    if (!isSelf && !(await hasAnyPermission(req, [PERMISSIONS.employeesRead]))) {
      res.status(403).json({ ok: false, error: "لا تملك صلاحية عرض إجازات هذا الموظف" });
      return;
    }

    const year = asNumber(req.query?.year);
    const month = asNumber(req.query?.month);
    const scoped =
      year !== null && month !== null && month >= 1 && month <= 12
        ? monthBounds(Math.round(year), Math.round(month))
        : undefined;

    const dates = await getOffDates(employeeId, scoped);
    res.json({ ok: true, employeeId, offDates: dates, month: scoped ?? null });
  },
);

/**
 * حفظ تواريخ إجازة موظف لشهر واحد. يستبدل تواريخ ذلك الشهر بالمُرسلة فقط،
 * فلا تُمسّ الأشهر الأخرى. عدد التواريخ لا يتجاوز عدد أيام الإجازة الشهرية
 * المُعرَّف في الجدول.
 */
peopleRouter.put(
  "/employees/:id/off-dates",
  requireAuth,
  requireAnyPermission(PERMISSIONS.schedulesManage, PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const year = asNumber(req.body?.year);
    const month = asNumber(req.body?.month);
    if (
      year === null ||
      month === null ||
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      year < 2000 ||
      year > 2100 ||
      month < 1 ||
      month > 12
    ) {
      res.status(400).json({ ok: false, error: "السنة والشهر مطلوبان بصيغة صحيحة." });
      return;
    }

    const bounds = monthBounds(year, month);
    const raw = Array.isArray(req.body?.offDates) ? req.body.offDates : [];
    const dates = [
      ...new Set(
        raw
          .map((value: unknown) => (typeof value === "string" ? value.trim().slice(0, 10) : ""))
          .filter((value: string) => isIsoDate(value)),
      ),
    ].sort() as string[];

    const outside = dates.filter((date) => date < bounds.from || date > bounds.to);
    if (outside.length > 0) {
      res.status(400).json({
        ok: false,
        error: `تواريخ خارج الشهر المُحدَّد: ${outside.join("، ")}`,
      });
      return;
    }

    const [employee] = await db
      .select({ id: employees.id, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const [schedule] = await db
      .select({
        daysOffPerMonth: workSchedules.daysOffPerMonth,
        offMode: workSchedules.offMode,
      })
      .from(workSchedules)
      .where(eq(workSchedules.employeeId, employeeId))
      .limit(1);

    if (!schedule) {
      res.status(400).json({
        ok: false,
        error: "عرّف جدول دوام الموظف أولاً ثم حدّد تواريخ إجازته.",
      });
      return;
    }

    if (dates.length > schedule.daysOffPerMonth) {
      res.status(400).json({
        ok: false,
        error: `عدد أيام الإجازة المسموح لهذا الموظف ${schedule.daysOffPerMonth} في الشهر، وقد اخترت ${dates.length}.`,
      });
      return;
    }

    const before = await getOffDates(employeeId, bounds);

    await db
      .delete(scheduleOffDates)
      .where(
        and(
          eq(scheduleOffDates.employeeId, employeeId),
          gte(scheduleOffDates.offDate, bounds.from),
          lte(scheduleOffDates.offDate, bounds.to),
        ),
      );

    if (dates.length > 0) {
      await db.insert(scheduleOffDates).values(
        dates.map((offDate) => ({
          employeeId,
          offDate,
          note: asString(req.body?.note, 200) ?? "",
          createdByEmployeeId: actor.id,
        })),
      );
    }

    // نمط التواريخ يُفعَّل تلقائياً بمجرّد تحديد تواريخ فعلية
    if (dates.length > 0 && schedule.offMode !== "dates") {
      await db
        .update(workSchedules)
        .set({ offMode: "dates", offDays: "", updatedByEmployeeId: actor.id, updatedAt: new Date() })
        .where(eq(workSchedules.employeeId, employeeId));
    }

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "schedule.off_dates.set",
      entityType: "schedule_off_dates",
      entityId: employeeId,
      before: { month: `${year}-${String(month).padStart(2, "0")}`, offDates: before },
      after: { month: `${year}-${String(month).padStart(2, "0")}`, offDates: dates },
      reason: asString(req.body?.reason, 500) ?? "تحديد أيام إجازة بتواريخها",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message:
        dates.length === 0
          ? `تم مسح تواريخ إجازة ${employee.fullName} لهذا الشهر.`
          : `تم حفظ ${dates.length} يوم إجازة لـ${employee.fullName}.`,
      employeeId,
      offDates: dates,
      allowed: schedule.daysOffPerMonth,
    });
  },
);

/* ── مدير الفرع ───────────────────────────────────────────────── */

/** الموظفون المؤهّلون لإدارة فرع (بدور مدير فرع). */
peopleRouter.get(
    "/branches/manager-candidates",
    requireAuth,
      requirePermission(PERMISSIONS.branchesRead),
    async (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const rows = await db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        roleName: roles.name,
        roleNameAr: roles.nameAr,
        branchId: employees.branchId,
      })
      .from(employees)
      .innerJoin(roles, eq(employees.roleId, roles.id))
      .where(eq(employees.isActive, true))
      .orderBy(asc(employees.employeeCode));

    res.json({
      ok: true,
      candidates: rows.filter((row) => BRANCH_MANAGER_ROLES.includes(row.roleName)),
    });
  },
);

/** تعيين (أو إزالة) المدير المسؤول عن فرع. */
peopleRouter.patch(
  "/branches/:id/manager",
  requireAuth,
  requirePermission(PERMISSIONS.branchesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const branchId = asId(req.params.id);

    if (branchId === null) {
      res.status(400).json({ ok: false, error: "معرّف الفرع غير صالح" });
      return;
    }

    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);

    if (!branch) {
      res.status(404).json({ ok: false, error: "الفرع غير موجود" });
      return;
    }

    const managerEmployeeId = asId(req.body?.managerEmployeeId);

    if (managerEmployeeId !== null) {
      const [candidate] = await db
        .select({
          id: employees.id,
          fullName: employees.fullName,
          roleName: roles.name,
          isActive: employees.isActive,
        })
        .from(employees)
        .leftJoin(roles, eq(employees.roleId, roles.id))
        .where(eq(employees.id, managerEmployeeId))
        .limit(1);

      if (!candidate) {
        res.status(404).json({ ok: false, error: "الموظف غير موجود" });
        return;
      }
      if (!candidate.isActive) {
        res.status(400).json({ ok: false, error: "لا يمكن تعيين موظف غير مُفعّل مديراً للفرع." });
        return;
      }
      if (!candidate.roleName || !BRANCH_MANAGER_ROLES.includes(candidate.roleName)) {
        res.status(400).json({
          ok: false,
          error: "المدير المسؤول يجب أن يكون موظفاً بدور «مدير فرع».",
        });
        return;
      }
    }

    const [updated] = await db
      .update(branches)
      .set({ managerEmployeeId, updatedAt: new Date() })
      .where(eq(branches.id, branchId))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "branch.set_manager",
      entityType: "branches",
      entityId: branchId,
      before: { managerEmployeeId: branch.managerEmployeeId },
      after: { managerEmployeeId },
      reason: asString(req.body?.reason, 500) ?? "تعيين مدير الفرع",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: managerEmployeeId
        ? "تم تعيين المدير المسؤول عن الفرع"
        : "تم إزالة المدير المسؤول عن الفرع",
      branch: updated,
    });
  },
);

/** الأدوار المتاحة — تحتاجها شاشة إضافة/تعديل الموظف. */
peopleRouter.get(
  "/roles",
  requireAuth,
  requirePermission(PERMISSIONS.employeesRead),
  async (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const rows = await db
      .select({
        id: roles.id,
        name: roles.name,
        nameAr: roles.nameAr,
        description: roles.description,
      })
      .from(roles)
      .orderBy(asc(roles.id));
    res.json({ ok: true, roles: rows });
  },
);

/** تعريف راتب موظف واحد — تستخدمه شاشة ملف الموظف. */
peopleRouter.get(
  "/employees/:id/salary",
  requireAuth,
  requireAnyPermission(PERMISSIONS.salaryManage, PERMISSIONS.payrollManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const [salary] = await db
      .select()
      .from(salaryDefinitions)
      .where(eq(salaryDefinitions.employeeId, employeeId))
      .limit(1);

    res.json({ ok: true, salary: salary ?? null });
  },
);
