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
import { and, asc, eq, ne } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  employeePermissionOverrides,
  employees,
  faceTemplates,
  roles,
  salaryDefinitions,
  workSchedules,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { getSeedPassword } from "../config.js";
import { hashPassword } from "../passwords.js";
import {
  effectivePermissionCodes,
  hasAnyPermission,
  PERMISSION_CATALOG,
  PERMISSIONS,
  permissionCodesForRole,
  requireAnyPermission,
  requirePermission,
  SECTION_CATALOG,
} from "../rbac.js";
import {
  ALLOWED_DAYS_OFF,
  isTimeOfDay,
  offDaysLabel,
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
      ? { ...schedule, offDaysLabel: offDaysLabel(schedule.offDays) }
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

/* ── جدول الدوام ──────────────────────────────────────────────── */

/** بيانات مساعدة للواجهة: أيام الأسبوع وعدد أيام الإجازة المسموحة. */
peopleRouter.get("/schedules/meta", requireAuth, (_req: AuthedRequest, res: Response) => {
  res.json({
    ok: true,
    weekdays: WEEKDAY_NAMES.map((label, value) => ({ value, label })),
    allowedDaysOff: [...ALLOWED_DAYS_OFF],
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

    res.json({
      ok: true,
      schedule: schedule
        ? { ...schedule, offDaysLabel: offDaysLabel(schedule.offDays) }
        : null,
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

    res.json({
      ok: true,
      items: rows.map((row) => ({
        ...row.schedule,
        offDaysLabel: offDaysLabel(row.schedule.offDays),
        employeeCode: row.employeeCode,
        fullName: row.fullName,
      })),
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
    if (daysOffPerMonth === null || !ALLOWED_DAYS_OFF.includes(daysOffPerMonth as 2 | 4)) {
      res.status(400).json({
        ok: false,
        error: "عدد أيام الإجازة الشهرية يجب أن يكون 2 أو 4.",
      });
      return;
    }

    const requestedOffDays = Array.isArray(req.body?.offDays)
      ? parseOffDays((req.body.offDays as unknown[]).join(","))
      : parseOffDays(asString(req.body?.offDays, 40));

    // أيام الإجازة المحدَّدة أسبوعياً = العدد الشهري ÷ 4 أسابيع تقريباً
    const expectedWeeklyOff = daysOffPerMonth === 2 ? 1 : 2;
    if (requestedOffDays.length > 0 && requestedOffDays.length !== expectedWeeklyOff) {
      res.status(400).json({
        ok: false,
        error: `اختيار ${daysOffPerMonth} أيام إجازة شهرياً يعني تحديد ${expectedWeeklyOff} يوم أسبوعياً بالضبط.`,
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

    res.json({
      ok: true,
      message: `تم حفظ جدول دوام ${employee.fullName}`,
      schedule: { ...saved, offDaysLabel: offDaysLabel(saved.offDays) },
    });
  },
);

/* ── الصلاحيات الفردية ────────────────────────────────────────── */

peopleRouter.get(
  "/employees/:id/permissions",
  requireAuth,
  requireAnyPermission(PERMISSIONS.permissionsManage, PERMISSIONS.employeesRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const [employee] = await db
      .select({ id: employees.id, roleId: employees.roleId, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const [roleCodes, overrides, effective] = await Promise.all([
      permissionCodesForRole(employee.roleId),
      db
        .select()
        .from(employeePermissionOverrides)
        .where(eq(employeePermissionOverrides.employeeId, employeeId)),
      effectivePermissionCodes({ employeeId, roleId: employee.roleId }),
    ]);

    res.json({
      ok: true,
      employeeId,
      fullName: employee.fullName,
      roleCodes,
      overrides,
      effective,
      sections: SECTION_CATALOG,
      catalog: PERMISSION_CATALOG,
    });
  },
);

/**
 * استبدال تخصيصات موظف بالكامل. كل عنصر: `{ permissionCode, effect }`
 * حيث `effect` إما `allow` (يمنح فوق الدور) أو `deny` (يسحب من الدور).
 */
peopleRouter.put(
  "/employees/:id/permissions",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.id);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const [employee] = await db
      .select({ id: employees.id, roleId: employees.roleId, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const knownCodes = new Set(PERMISSION_CATALOG.map((item) => item.code));
    const incoming = Array.isArray(req.body?.overrides) ? req.body.overrides : [];
    const rows: Array<{
      employeeId: number;
      permissionCode: string;
      effect: string;
      note: string;
      grantedByEmployeeId: number;
    }> = [];
    const seen = new Set<string>();

    for (const item of incoming as Array<Record<string, unknown>>) {
      const permissionCode = asString(item?.permissionCode, 100);
      const effect = asEnum(item?.effect, ["allow", "deny"] as const);

      if (!permissionCode || effect === null) continue;
      if (!knownCodes.has(permissionCode)) {
        res.status(400).json({ ok: false, error: `صلاحية غير معروفة: ${permissionCode}` });
        return;
      }
      if (seen.has(permissionCode)) continue;
      seen.add(permissionCode);

      rows.push({
        employeeId,
        permissionCode,
        effect,
        note: asString(item?.note, 300) ?? "",
        grantedByEmployeeId: actor.id,
      });
    }

    const before = await db
      .select()
      .from(employeePermissionOverrides)
      .where(eq(employeePermissionOverrides.employeeId, employeeId));

    await db
      .delete(employeePermissionOverrides)
      .where(eq(employeePermissionOverrides.employeeId, employeeId));

    if (rows.length > 0) {
      await db.insert(employeePermissionOverrides).values(rows);
    }

    const effective = await effectivePermissionCodes({
      employeeId,
      roleId: employee.roleId,
    });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "permissions.override",
      entityType: "employee_permission_overrides",
      entityId: employeeId,
      before: { overrides: before },
      after: { overrides: rows, effective },
      reason: asString(req.body?.reason, 500) ?? "تخصيص صلاحيات موظف",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: `تم حفظ ${rows.length} تخصيصاً لـ${employee.fullName}`,
      overrides: rows,
      effective,
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
