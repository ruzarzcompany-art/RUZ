import { Router, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  attendanceLogs,
  auditLogs,
  branches,
  employees,
  faceTemplates,
  passwordResetRequests,
  roles,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import { getMailConfig } from "../config.js";
import { demoDataStatus, purgeDemoData } from "../demo.js";
import { DEMO_PURGED_FLAG, isFlagOn, setFlag } from "../flags.js";
import { issueResetCodeByAdmin, maskEmail } from "../reset.js";
import {
  PERMISSIONS,
  requireAnyPermission,
  requireModuleDelete,
  requirePermission,
} from "../rbac.js";
import { reseedNow } from "../seed.js";
import { CHECK_IN, CHECK_OUT, closeStaleShifts } from "../shifts.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import {
  asDateTime,
  asEnum,
  asId,
  asNumber,
  asString,
  roundHours,
} from "../validate.js";

export const adminRouter = Router();

const ATTENDANCE_STATUSES = ["approved", "rejected", "flagged"] as const;
const ATTENDANCE_TYPES = [CHECK_IN, CHECK_OUT] as const;

/* ── دليل الموظفين ─────────────────────────────────────────────── */

adminRouter.get(
  "/employees",
  requireAuth,
  requirePermission(PERMISSIONS.employeesRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const branchFilter = asId(req.query.branchId);

    const rows = await db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        email: employees.email,
        phone: employees.phone,
        nationality: employees.nationality,
        nationalId: employees.nationalId,
        department: employees.department,
        jobTitle: employees.jobTitle,
        isActive: employees.isActive,
        faceEnabled: employees.faceEnabled,
        branchId: employees.branchId,
        branchName: branches.name,
        branchManagerId: branches.managerEmployeeId,
        roleId: employees.roleId,
        roleName: roles.name,
        roleNameAr: roles.nameAr,
        hiredAt: employees.hiredAt,
      })
      .from(employees)
      .leftJoin(branches, eq(employees.branchId, branches.id))
      .leftJoin(roles, eq(employees.roleId, roles.id))
      .where(branchFilter === null ? undefined : eq(employees.branchId, branchFilter))
      .orderBy(asc(employees.employeeCode));

    // اسم مدير الفرع لكل موظف — استعلام واحد لكل المديرين المذكورين
    const managerIds = [
      ...new Set(rows.flatMap((row) => (row.branchManagerId ? [row.branchManagerId] : []))),
    ];
    const managerRows =
      managerIds.length === 0
        ? []
        : await db
            .select({ id: employees.id, fullName: employees.fullName })
            .from(employees)
            .where(inArray(employees.id, managerIds));
    const nameById = new Map(managerRows.map((row) => [row.id, row.fullName]));

    res.json({
      ok: true,
      employees: rows.map((row) => ({
        ...row,
        joinDate: row.hiredAt ? row.hiredAt.toISOString().slice(0, 10) : null,
        branchManagerName: row.branchManagerId
          ? nameById.get(row.branchManagerId) ?? null
          : null,
      })),
    });
  },
);

/* ── سجلات الحضور الإدارية ────────────────────────────────────── */

adminRouter.get(
  "/admin/attendance",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceReadAll),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const employeeId = asId(req.query.employeeId);
    const branchId = asId(req.query.branchId);
    const from = asDateTime(String(req.query.from ?? ""));
    const to = asDateTime(String(req.query.to ?? ""));
    const limitRaw = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

    const filters = [
      employeeId === null ? undefined : eq(attendanceLogs.employeeId, employeeId),
      branchId === null ? undefined : eq(attendanceLogs.branchId, branchId),
      from === null ? undefined : gte(attendanceLogs.serverTime, from),
      to === null ? undefined : lte(attendanceLogs.serverTime, to),
    ].filter((item) => item !== undefined);

    const rows = await db
      .select({
        log: attendanceLogs,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        branchName: branches.name,
        timezone: branches.timezone,
      })
      .from(attendanceLogs)
      .innerJoin(employees, eq(attendanceLogs.employeeId, employees.id))
      .leftJoin(branches, eq(attendanceLogs.branchId, branches.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(attendanceLogs.serverTime))
      .limit(limit);

    res.json({
      ok: true,
      logs: rows.map((row) => ({
        ...row.log,
        employeeCode: row.employeeCode,
        fullName: row.fullName,
        branchName: row.branchName,
        localTime: row.log.serverTime.toLocaleString("ar", {
          timeZone: safeTimeZone(row.timezone),
        }),
        // تاريخ الحركة بتوقيت الفرع — الواجهة تجمّع السجلات بحسبه يوماً بيوم
        localDate: isoDateInZone(row.log.serverTime, safeTimeZone(row.timezone)),
      })),
    });
  },
);

/**
 * إدخال سجل حضور يدوياً — صلاحية **مدير الموارد البشرية** تحديداً
 * (`attendance.manual_write`)، وهي منفصلة عن صلاحيات مدير الفرع.
 * كل حقل قابل للتحديد: الموظف، الفرع، نوع الحركة، الوقت، الحالة، السبب،
 * وساعات الخصم.
 */
adminRouter.post(
  "/admin/attendance",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceManualWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;

    const employeeId = asId(req.body?.employeeId);
    const type = asEnum(req.body?.type, ATTENDANCE_TYPES);
    const time = asDateTime(req.body?.time ?? req.body?.serverTime);
    const reason = asString(req.body?.reason ?? req.body?.note, 1000) ?? "";

    if (employeeId === null || type === null || time === null) {
      res.status(400).json({
        ok: false,
        error: "الموظف ونوع الحركة والوقت مطلوبة (الوقت بصيغة ISO).",
      });
      return;
    }

    if (reason.trim() === "") {
      res.status(400).json({ ok: false, error: "سبب الإدخال اليدوي مطلوب للتوثيق." });
      return;
    }

    const [employee] = await db
      .select({ id: employees.id, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const branchId = asId(req.body?.branchId) ?? employee.branchId;
    if (branchId === null) {
      res.status(400).json({ ok: false, error: "الفرع مطلوب (الموظف غير مرتبط بفرع)." });
      return;
    }

    const [branch] = await db
      .select({ id: branches.id, name: branches.name, timezone: branches.timezone })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);

    if (!branch) {
      res.status(404).json({ ok: false, error: "الفرع غير موجود" });
      return;
    }

    const status = asEnum(req.body?.status, ATTENDANCE_STATUSES) ?? "approved";
    const deductedHours = Math.max(0, asNumber(req.body?.deductedHours) ?? 0);

    const [log] = await db
      .insert(attendanceLogs)
      .values({
        employeeId,
        branchId: branch.id,
        type,
        serverTime: time,
        status,
        reason,
        source: "manual",
        withinGeofence: false,
        deductedHours: roundHours(deductedHours),
        createdByEmployeeId: actor.id,
        deviceInfo: "manual-entry",
        ipAddress: clientIp(req),
      })
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "attendance.manual_create",
      entityType: "attendance_logs",
      entityId: log.id,
      after: log,
      reason,
      ipAddress: clientIp(req),
    });

    res.status(201).json({ ok: true, message: "تم إضافة السجل يدوياً", log });
  },
);

/** تعديل أي حقل في سجل حضور — صلاحية الموارد البشرية فقط. */
adminRouter.patch(
  "/admin/attendance/:id",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceManualWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const logId = asId(req.params.id);

    if (logId === null) {
      res.status(400).json({ ok: false, error: "معرّف السجل غير صالح" });
      return;
    }

    const [before] = await db
      .select()
      .from(attendanceLogs)
      .where(eq(attendanceLogs.id, logId))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "السجل غير موجود" });
      return;
    }

    const reason = asString(req.body?.reason, 1000);
    if (reason === null || reason.trim() === "") {
      res.status(400).json({ ok: false, error: "سبب التعديل مطلوب للتوثيق." });
      return;
    }

    const changes: Record<string, unknown> = { reason };

    const employeeId = asId(req.body?.employeeId);
    if (employeeId !== null) changes.employeeId = employeeId;

    const branchId = asId(req.body?.branchId);
    if (branchId !== null) changes.branchId = branchId;

    const type = asEnum(req.body?.type, ATTENDANCE_TYPES);
    if (type !== null) changes.type = type;

    const time = asDateTime(req.body?.time ?? req.body?.serverTime);
    if (time !== null) {
      changes.serverTime = time;
      changes.originalServerTime = before.originalServerTime ?? before.serverTime;
    }

    const status = asEnum(req.body?.status, ATTENDANCE_STATUSES);
    if (status !== null) changes.status = status;

    const deductedHours = asNumber(req.body?.deductedHours);
    if (deductedHours !== null) changes.deductedHours = roundHours(Math.max(0, deductedHours));

    changes.correctedByEmployeeId = actor.id;
    changes.correctedAt = new Date();

    const [after] = await db
      .update(attendanceLogs)
      .set(changes)
      .where(eq(attendanceLogs.id, logId))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "attendance.manual_update",
      entityType: "attendance_logs",
      entityId: logId,
      before,
      after,
      reason,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم تعديل السجل", log: after });
  },
);

adminRouter.delete(
  "/admin/attendance/:id",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceManualWrite),
  requireModuleDelete("attendance_records"),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const logId = asId(req.params.id);
    const reason = asString(req.body?.reason, 1000) ?? asString(req.query.reason, 1000) ?? "";

    if (logId === null) {
      res.status(400).json({ ok: false, error: "معرّف السجل غير صالح" });
      return;
    }
    if (reason.trim() === "") {
      res.status(400).json({ ok: false, error: "سبب الحذف مطلوب للتوثيق." });
      return;
    }

    const [before] = await db
      .select()
      .from(attendanceLogs)
      .where(eq(attendanceLogs.id, logId))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "السجل غير موجود" });
      return;
    }

    await db.delete(attendanceLogs).where(eq(attendanceLogs.id, logId));

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "attendance.manual_delete",
      entityType: "attendance_logs",
      entityId: logId,
      before,
      reason,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم حذف السجل" });
  },
);

/**
 * تصحيح وقت الانصراف بعد الإقفال التلقائي — متاح لمدير الفرع أو الموارد
 * البشرية. يسمح بخصم عدد ساعات بتقدير المسؤول، ويُسجَّل التعديل والسبب في
 * `audit_logs` مع الاحتفاظ بالوقت الأصلي في `original_server_time`.
 */
adminRouter.patch(
  "/admin/attendance/:id/checkout-correction",
  requireAuth,
  requireAnyPermission(
    PERMISSIONS.attendanceCorrectCheckout,
    PERMISSIONS.attendanceManualWrite,
  ),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const logId = asId(req.params.id);
    const actualCheckOut = asDateTime(req.body?.actualCheckOut ?? req.body?.time);
    const deductHours = Math.max(0, asNumber(req.body?.deductHours) ?? 0);
    const reason = asString(req.body?.reason, 1000) ?? "";

    if (logId === null || actualCheckOut === null) {
      res.status(400).json({
        ok: false,
        error: "معرّف السجل ووقت الانصراف الفعلي مطلوبان (بصيغة ISO).",
      });
      return;
    }
    if (reason.trim() === "") {
      res.status(400).json({ ok: false, error: "سبب التصحيح مطلوب للتوثيق." });
      return;
    }

    const [before] = await db
      .select()
      .from(attendanceLogs)
      .where(eq(attendanceLogs.id, logId))
      .limit(1);

    if (!before) {
      res.status(404).json({ ok: false, error: "السجل غير موجود" });
      return;
    }
    if (before.type !== CHECK_OUT) {
      res.status(409).json({ ok: false, error: "التصحيح ينطبق على سجلات الانصراف فقط." });
      return;
    }
    if (actualCheckOut.getTime() > Date.now() + 60_000) {
      res.status(400).json({ ok: false, error: "لا يمكن تسجيل انصراف في المستقبل." });
      return;
    }

    // يجب أن يكون الانصراف بعد الحضور الذي يقابله
    const [precedingCheckIn] = await db
      .select({ id: attendanceLogs.id, serverTime: attendanceLogs.serverTime })
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.employeeId, before.employeeId),
          eq(attendanceLogs.type, CHECK_IN),
          lt(attendanceLogs.serverTime, before.serverTime),
        ),
      )
      .orderBy(desc(attendanceLogs.serverTime))
      .limit(1);

    if (precedingCheckIn && actualCheckOut.getTime() <= precedingCheckIn.serverTime.getTime()) {
      res.status(400).json({
        ok: false,
        error: "وقت الانصراف يجب أن يكون بعد وقت الحضور المقابل.",
      });
      return;
    }

    const [after] = await db
      .update(attendanceLogs)
      .set({
        serverTime: actualCheckOut,
        originalServerTime: before.originalServerTime ?? before.serverTime,
        deductedHours: roundHours(deductHours),
        correctedByEmployeeId: actor.id,
        correctedAt: new Date(),
        status: "approved",
        reason: `${before.reason ? `${before.reason} | ` : ""}تصحيح يدوي: ${reason}${
          deductHours > 0 ? ` (خصم ${roundHours(deductHours)} ساعة)` : ""
        }`.slice(0, 1000),
      })
      .where(eq(attendanceLogs.id, logId))
      .returning();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "attendance.correct_checkout",
      entityType: "attendance_logs",
      entityId: logId,
      before,
      after,
      reason,
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم تصحيح وقت الانصراف", log: after });
  },
);

/** تشغيل الإقفال التلقائي يدوياً (يفيد للاختبار والمراجعة). */
adminRouter.post(
  "/admin/shifts/close-stale",
  requireAuth,
  requireAnyPermission(
    PERMISSIONS.attendanceManualWrite,
    PERMISSIONS.attendanceApprove,
  ),
  async (_req: AuthedRequest, res: Response) => {
    const closed = await closeStaleShifts();
    res.json({ ok: true, closedCount: closed.length, closed });
  },
);

/** تصفير قالب وجه موظف ليُسجَّل من جديد (الموارد البشرية). */
adminRouter.delete(
  "/admin/face/:employeeId",
  requireAuth,
  requireAnyPermission(
    PERMISSIONS.attendanceManualWrite,
    PERMISSIONS.employeesWrite,
  ),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.params.employeeId);
    const reason = asString(req.body?.reason, 1000) ?? "";

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const deleted = await db
      .delete(faceTemplates)
      .where(eq(faceTemplates.employeeId, employeeId))
      .returning({ id: faceTemplates.id });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "face.reset",
      entityType: "face_templates",
      entityId: employeeId,
      before: { existed: deleted.length > 0 },
      reason: reason || "تصفير قالب الوجه",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message:
        deleted.length > 0
          ? "تم تصفير قالب الوجه — سيُسجَّل قالب جديد في أول تسجيل حضور"
          : "لا يوجد قالب مسجَّل لهذا الموظف",
    });
  },
);

/* ── استعادة كلمة المرور (مسؤول البرنامج) ─────────────────────── */

/**
 * طلبات «نسيت الرقم السري» المعلّقة.
 *
 * تظهر هنا الطلبات التي لم يصل رمزها بالبريد (لا بريد للحساب أو مزوّد البريد
 * غير مضبوط) ليصدر مسؤول البرنامج الرمز بنفسه ويسلّمه للموظف.
 */
adminRouter.get(
  "/admin/password-resets",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const includeAll = String(req.query.all ?? "") === "1";

    const rows = await db
      .select({
        request: passwordResetRequests,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        email: employees.email,
      })
      .from(passwordResetRequests)
      .leftJoin(employees, eq(passwordResetRequests.employeeId, employees.id))
      .where(
        includeAll
          ? undefined
          : inArray(passwordResetRequests.status, ["pending", "sent"]),
      )
      .orderBy(desc(passwordResetRequests.createdAt))
      .limit(100);

    res.json({
      ok: true,
      mailConfigured: getMailConfig().configured,
      requests: rows.map((row) => ({
        id: row.request.id,
        employeeId: row.request.employeeId,
        employeeCode: row.employeeCode,
        fullName: row.fullName,
        // لا نكشف البريد كاملاً في القوائم الإدارية
        maskedEmail: row.email ? maskEmail(row.email) : "",
        hasEmail: Boolean(row.email),
        status: row.request.status,
        deliveryChannel: row.request.deliveryChannel,
        attempts: row.request.attempts,
        requestedIdentifier: row.request.requestedIdentifier,
        expiresAt: row.request.expiresAt,
        usedAt: row.request.usedAt,
        createdAt: row.request.createdAt,
      })),
    });
  },
);

/**
 * إصدار رمز استعادة يدوياً لموظف. الرمز يُعاد مرة واحدة في هذه الاستجابة
 * فقط (لا يُخزَّن نصاً) ليسلّمه المسؤول للموظف، ثم يضبط الموظف كلمته الجديدة
 * من شاشة الدخول.
 */
adminRouter.post(
  "/admin/password-resets/issue",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const employeeId = asId(req.body?.employeeId);

    if (employeeId === null) {
      res.status(400).json({ ok: false, error: "معرّف الموظف غير صالح" });
      return;
    }

    const [employee] = await db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        isActive: employees.isActive,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    if (!employee.isActive) {
      res.status(400).json({ ok: false, error: "الحساب غير مُفعّل — فعّله أولاً" });
      return;
    }

    const { code, expiresAt } = await issueResetCodeByAdmin({
      employeeId,
      actorEmployeeId: actor.id,
    });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "password_reset.issue",
      entityType: "password_reset_requests",
      entityId: employeeId,
      // لا يُسجَّل الرمز نفسه في التدقيق — فقط أنه صدر ولمن
      after: { employeeCode: employee.employeeCode, channel: "admin", expiresAt },
      reason: asString(req.body?.reason, 500) ?? "إصدار رمز استعادة من مسؤول البرنامج",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: `سلّم هذا الرمز لـ${employee.fullName} — يُستخدم مرة واحدة وينتهي بعد انتهاء المدة.`,
      employeeCode: employee.employeeCode,
      code,
      expiresAt,
    });
  },
);

/** إلغاء طلب استعادة معلّق. */
adminRouter.post(
  "/admin/password-resets/:id/cancel",
  requireAuth,
  requirePermission(PERMISSIONS.employeesWrite),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const actor = req.employee!;
    const requestId = asId(req.params.id);

    if (requestId === null) {
      res.status(400).json({ ok: false, error: "معرّف الطلب غير صالح" });
      return;
    }

    const [updated] = await db
      .update(passwordResetRequests)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(passwordResetRequests.id, requestId),
          inArray(passwordResetRequests.status, ["pending", "sent"]),
        ),
      )
      .returning({ id: passwordResetRequests.id, employeeId: passwordResetRequests.employeeId });

    if (!updated) {
      res.status(404).json({ ok: false, error: "الطلب غير موجود أو مُغلق مسبقاً" });
      return;
    }

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "password_reset.cancel",
      entityType: "password_reset_requests",
      entityId: updated.employeeId,
      reason: asString(req.body?.reason, 500) ?? "إلغاء طلب استعادة",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم إلغاء الطلب" });
  },
);

/* ── البيانات التجريبية ───────────────────────────────────────── */

/** حالة البيانات التجريبية المتبقية (لعرضها قبل الحذف). */
adminRouter.get(
  "/admin/demo-data",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (_req: AuthedRequest, res: Response) => {
    const [status, purged] = await Promise.all([
      demoDataStatus(),
      isFlagOn(DEMO_PURGED_FLAG),
    ]);
    res.json({ ok: true, ...status, purged });
  },
);

/**
 * حذف البيانات التجريبية. يتطلّب تأكيداً صريحاً في الجسم، ولا يحذف حساب
 * المنفّذ نفسه، ويضبط علماً دائماً يمنع إعادة بذر الحسابات التجريبية.
 */
adminRouter.post(
  "/admin/demo-data/purge",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const scope = asEnum(req.body?.scope, ["demo", "records", "all"] as const) ?? "demo";
    const confirm = asString(req.body?.confirm, 40) ?? "";

    if (confirm !== "حذف" && confirm.toUpperCase() !== "DELETE") {
      res.status(400).json({
        ok: false,
        error: "اكتب كلمة «حذف» للتأكيد — العملية لا يمكن الرجوع عنها.",
      });
      return;
    }

    const summary = await purgeDemoData({ scope, actorEmployeeId: actor.id });

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "demo_data.purge",
      entityType: "system_flags",
      after: summary,
      reason: asString(req.body?.reason, 500) ?? "حذف البيانات التجريبية",
      ipAddress: clientIp(req),
    });

    const totalDeleted = Object.values(summary.deleted).reduce((sum, value) => sum + value, 0);

    res.json({
      ok: true,
      message:
        summary.skippedEmployees.length > 0
          ? `تم حذف ${totalDeleted} سجلاً. لم يُحذف حسابك التجريبي (${summary.skippedEmployees.join(", ")}) — أنشئ حسابك الخاص ثم احذفه من شاشة الموظفين.`
          : `تم حذف ${totalDeleted} سجلاً من البيانات التجريبية، ولن تُبذر مرة أخرى.`,
      ...summary,
      totalDeleted,
    });
  },
);

/** إعادة البيانات التجريبية (تراجع عن الحذف) — تُعيد البذر فوراً. */
adminRouter.post(
  "/admin/demo-data/restore",
  requireAuth,
  requirePermission(PERMISSIONS.settingsManage),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;

    await setFlag(DEMO_PURGED_FLAG, "0", {
      note: "أُعيد تمكين بذر البيانات التجريبية من لوحة الإعدادات.",
      setByEmployeeId: actor.id,
    });
    await reseedNow();

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "demo_data.restore",
      entityType: "system_flags",
      reason: "إعادة البيانات التجريبية",
      ipAddress: clientIp(req),
    });

    res.json({ ok: true, message: "تم إعادة البيانات التجريبية.", ...(await demoDataStatus()) });
  },
);

/* ── سجل التدقيق ──────────────────────────────────────────────── */

adminRouter.get(
  "/admin/audit",
  requireAuth,
  requirePermission(PERMISSIONS.auditRead),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const entityType = asString(req.query.entityType, 100);
    const entityId = asId(req.query.entityId);
    const from = asDateTime(String(req.query.from ?? ""));
    const to = asDateTime(String(req.query.to ?? ""));
    const limitRaw = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

    const filters = [
      entityType ? eq(auditLogs.entityType, entityType) : undefined,
      entityId === null ? undefined : eq(auditLogs.entityId, entityId),
      from === null ? undefined : gte(auditLogs.createdAt, from),
      to === null ? undefined : lte(auditLogs.createdAt, to),
    ].filter((item) => item !== undefined);

    // توقيت الفرع الأول مرجعٌ لتجميع القيود يوماً بيوم في الواجهة
    const [anchorBranch] = await db
      .select({ timezone: branches.timezone })
      .from(branches)
      .orderBy(asc(branches.id))
      .limit(1);
    const timezone = safeTimeZone(anchorBranch?.timezone ?? "Asia/Riyadh");

    const rows = await db
      .select({
        entry: auditLogs,
        actorName: employees.fullName,
        actorCode: employees.employeeCode,
      })
      .from(auditLogs)
      .leftJoin(employees, eq(auditLogs.actorEmployeeId, employees.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);

    res.json({
      ok: true,
      timezone,
      entries: rows.map((row) => ({
        ...row.entry,
        actorName: row.actorName,
        actorCode: row.actorCode,
        localDate: isoDateInZone(row.entry.createdAt, timezone),
      })),
    });
  },
);
