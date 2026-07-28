import express, { type NextFunction, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db/index.js";
import { branches, employees } from "../db/schema.js";
import {
  requireAuth,
  issueSession,
  revokeAllSessionsForEmployee,
  revokeSession,
  type AuthedRequest,
} from "./auth.js";
import { clientIp } from "./audit.js";
import { isValidCoordinates } from "./geo.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { consumeResetCode, createResetRequest } from "./reset.js";
import {
  effectivePermissionCodes,
  PERMISSIONS,
  requirePermission,
} from "./rbac.js";
import { adminRouter } from "./routes/admin.js";
import { attendanceRouter } from "./routes/attendance.js";
import { cashierRouter } from "./routes/cashier.js";
import { documentsRouter } from "./routes/documents.js";
import { formsRouter } from "./routes/forms.js";
import { inventoryRouter } from "./routes/inventory.js";
import { payrollRouter } from "./routes/payroll.js";
import { peopleRouter } from "./routes/people.js";
import { reportsRouter } from "./routes/reports.js";
import { settingsRouter } from "./routes/settings.js";
import { ensureSeeded } from "./seed.js";
import {
  getAutoCloseHour,
  getFaceMatchMode,
  getFaceMatchThreshold,
  getMailConfig,
  getPunchCooldownSeconds,
  getResetCodeTtlSeconds,
  getSessionIdleSeconds,
} from "./config.js";

/** أقل طول مقبول لكلمة المرور الجديدة. */
const MIN_PASSWORD_LENGTH = 8;

/** يتحقق من كلمة المرور الجديدة ويُرجع رسالة الخطأ أو `null`. */
function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `كلمة المرور الجديدة يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف أو أكثر`;
  }
  if (password.length > 200) return "كلمة المرور الجديدة طويلة جداً";
  return null;
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // الحد مرفوع إلى 1MB لأن شعار الشركة يُرسل كـData URL داخل JSON.
  app.use(express.json({ limit: "1mb" }));

  /** فحص جاهزية لا يعتمد على قاعدة البيانات. */
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "restaurant-hr", serverTime: new Date().toISOString() });
  });

  /**
   * يضمن جاهزية البيانات الأساسية (الأدوار والصلاحيات والفرع الافتراضي)
   * قبل تنفيذ أي مسار يعتمد على قاعدة البيانات.
   */
  app.use("/api", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await ensureSeeded();
      next();
    } catch (error) {
      console.error("[restaurant-hr] فشل تهيئة قاعدة البيانات:", error);
      res.status(503).json({
        ok: false,
        error:
          "قاعدة البيانات غير جاهزة. تأكد من تنفيذ الترحيلات ومن صحة رابط الاتصال (DATABASE_URL).",
      });
    }
  });

  /** إعدادات التشغيل التي تحتاجها الواجهة (بلا أي أسرار). */
  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      faceMatch: {
        mode: getFaceMatchMode(),
        threshold: getFaceMatchThreshold(),
      },
      shifts: {
        autoCloseHour: getAutoCloseHour(),
        punchCooldownSeconds: getPunchCooldownSeconds(),
      },
      session: {
        /** مدة الخمول قبل الخروج التلقائي — تعتمدها الواجهة لمؤقّتها */
        idleSeconds: getSessionIdleSeconds(),
      },
      passwordReset: {
        /** هل يستطيع الموقع إرسال الرمز بالبريد؟ وإلا فمن مسؤول البرنامج */
        emailEnabled: getMailConfig().configured,
        codeTtlSeconds: getResetCodeTtlSeconds(),
      },
    });
  });

  // ---------------------------------------------------------------- المصادقة

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const identifier = String(req.body?.identifier ?? req.body?.employeeCode ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!identifier || !password) {
      res.status(400).json({ ok: false, error: "رقم الموظف وكلمة المرور مطلوبان" });
      return;
    }

    const db = getDb();
    const isEmail = identifier.includes("@");
    const [employee] = await db
      .select()
      .from(employees)
      .where(
        isEmail
          ? eq(employees.email, identifier.toLowerCase())
          : eq(employees.employeeCode, identifier),
      )
      .limit(1);

    // نفس الرسالة في كل حالات الفشل حتى لا نكشف وجود الحساب
    const invalid = () =>
      res.status(401).json({ ok: false, error: "بيانات الدخول غير صحيحة" });

    if (!employee || !verifyPassword(password, employee.passwordHash)) {
      invalid();
      return;
    }

    if (!employee.isActive) {
      res.status(403).json({ ok: false, error: "الحساب غير مُفعّل، راجع الموارد البشرية" });
      return;
    }

    const { token, expiresAt } = await issueSession(employee.id, employee.employeeCode, {
      userAgent: String(req.headers["user-agent"] ?? ""),
      ipAddress: clientIp(req),
    });

    await db
      .update(employees)
      .set({ lastLoginAt: new Date() })
      .where(eq(employees.id, employee.id));

    res.json({
      ok: true,
      token,
      expiresAt: expiresAt.toISOString(),
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        jobTitle: employee.jobTitle,
        branchId: employee.branchId,
      },
      permissions: await effectivePermissionCodes({
        employeeId: employee.id,
        roleId: employee.roleId,
      }),
    });
  });

  app.get("/api/auth/me", requireAuth, async (req: AuthedRequest, res: Response) => {
    const employee = req.employee!;
    const db = getDb();

    const branch = employee.branchId
      ? (
          await db
            .select({
              id: branches.id,
              code: branches.code,
              name: branches.name,
              latitude: branches.latitude,
              longitude: branches.longitude,
              radiusMeters: branches.radiusMeters,
              timezone: branches.timezone,
              managerEmployeeId: branches.managerEmployeeId,
            })
            .from(branches)
            .where(eq(branches.id, employee.branchId))
            .limit(1)
        )[0] ?? null
      : null;

    // اسم المدير المسؤول عن فرع الموظف — يظهر في ملفه
    let branchManagerName: string | null = null;
    if (branch?.managerEmployeeId) {
      const [manager] = await db
        .select({ fullName: employees.fullName })
        .from(employees)
        .where(eq(employees.id, branch.managerEmployeeId))
        .limit(1);
      branchManagerName = manager?.fullName ?? null;
    }

    res.json({
      ok: true,
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        jobTitle: employee.jobTitle,
        role: employee.roleName,
      },
      branch: branch ? { ...branch, managerName: branchManagerName } : null,
      permissions: await effectivePermissionCodes({
        employeeId: employee.id,
        roleId: employee.roleId,
      }),
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/api/auth/logout", requireAuth, async (req: AuthedRequest, res: Response) => {
    await revokeSession(req.employee!.tokenId);
    res.json({ ok: true, message: "تم تسجيل الخروج" });
  });

  /**
   * «نسيت الرقم السري» — يُنشئ رمز استعادة ويرسله إلى بريد الموظف إن كان
   * مزوّد البريد مضبوطاً؛ وإن لم يكن، يبقى الطلب معلّقاً في لوحة مسؤول
   * البرنامج ليصدر الرمز بنفسه.
   *
   * الاستجابة موحّدة دائماً (وبنفس الرمز 200) حتى لا يُستخدم المسار لمعرفة
   * أي أرقام موظفين أو بُرد مسجّلة في النظام.
   */
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const identifier = String(req.body?.identifier ?? "").trim();

    if (!identifier || identifier.length > 200) {
      res.status(400).json({ ok: false, error: "أدخل رقم الموظف أو البريد الإلكتروني" });
      return;
    }

    const result = await createResetRequest({ identifier, ipAddress: clientIp(req) });

    res.json({
      ok: true,
      emailed: result.emailed,
      maskedEmail: result.maskedEmail,
      message: result.emailed
        ? `أُرسل رمز الاستعادة إلى ${result.maskedEmail}. أدخله مع كلمة المرور الجديدة، وصلاحيته ${Math.round(
            getResetCodeTtlSeconds() / 60,
          )} دقيقة.`
        : "إن كان الحساب موجوداً فقد وصل الطلب إلى مسؤول البرنامج ليسلّمك رمز الاستعادة. راجعه ثم أدخل الرمز مع كلمة المرور الجديدة.",
    });
  });

  /** ضبط كلمة مرور جديدة برمز الاستعادة (من البريد أو من مسؤول البرنامج). */
  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    const identifier = String(req.body?.identifier ?? "").trim();
    const code = String(req.body?.code ?? "").trim();
    const newPassword = String(req.body?.newPassword ?? req.body?.password ?? "");

    if (!identifier || !code) {
      res.status(400).json({ ok: false, error: "رقم الموظف ورمز الاستعادة مطلوبان" });
      return;
    }

    const passwordError = validateNewPassword(newPassword);
    if (passwordError) {
      res.status(400).json({ ok: false, error: passwordError });
      return;
    }

    const result = await consumeResetCode({ identifier, code, newPassword });

    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }

    res.json({ ok: true, message: "تم تعيين كلمة المرور الجديدة، يمكنك الدخول الآن." });
  });

  /** تغيير كلمة المرور من داخل النظام (يُبطل باقي الجلسات). */
  app.post(
    "/api/auth/change-password",
    requireAuth,
    async (req: AuthedRequest, res: Response) => {
      const actor = req.employee!;
      const currentPassword = String(req.body?.currentPassword ?? "");
      const newPassword = String(req.body?.newPassword ?? "");

      const passwordError = validateNewPassword(newPassword);
      if (passwordError) {
        res.status(400).json({ ok: false, error: passwordError });
        return;
      }

      const db = getDb();
      const [row] = await db
        .select({ passwordHash: employees.passwordHash })
        .from(employees)
        .where(eq(employees.id, actor.id))
        .limit(1);

      if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
        res.status(400).json({ ok: false, error: "كلمة المرور الحالية غير صحيحة" });
        return;
      }

      await db
        .update(employees)
        .set({
          passwordHash: hashPassword(newPassword),
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(employees.id, actor.id));

      // إبطال كل الجلسات ثم إصدار جلسة جديدة لهذا الجهاز
      await revokeAllSessionsForEmployee(actor.id);
      const { token, expiresAt } = await issueSession(actor.id, actor.employeeCode, {
        userAgent: String(req.headers["user-agent"] ?? ""),
        ipAddress: clientIp(req),
      });

      res.json({
        ok: true,
        message: "تم تغيير كلمة المرور وإنهاء الجلسات الأخرى.",
        token,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // ----------------------------------------------------------------- الفروع

  /** قائمة الفروع مع اسم المدير المسؤول عن كل فرع. */
  app.get(
    "/api/branches",
    requireAuth,
    requirePermission(PERMISSIONS.branchesRead),
    async (_req: AuthedRequest, res: Response) => {
      const db = getDb();
      const manager = alias(employees, "branch_manager");
      const rows = await db
        .select({
          branch: branches,
          managerName: manager.fullName,
          managerCode: manager.employeeCode,
        })
        .from(branches)
        .leftJoin(manager, eq(branches.managerEmployeeId, manager.id))
        .orderBy(branches.id);

      res.json({
        ok: true,
        branches: rows.map((row) => ({
          ...row.branch,
          managerName: row.managerName,
          managerCode: row.managerCode,
        })),
      });
    },
  );

  /**
   * تحديث موقع الفرع — يُستخدم لضبط إحداثيات الفرع الفعلية عند التركيب
   * أو الانتقال، ويحتاج صلاحية `branches.write`.
   */
  app.patch(
    "/api/branches/:id/location",
    requireAuth,
    requirePermission(PERMISSIONS.branchesWrite),
    async (req: AuthedRequest, res: Response) => {
      const branchId = Number.parseInt(String(req.params.id ?? ""), 10);
      if (!Number.isInteger(branchId)) {
        res.status(400).json({ ok: false, error: "معرّف الفرع غير صالح" });
        return;
      }

      const coordinates = {
        latitude: Number(req.body?.latitude),
        longitude: Number(req.body?.longitude),
      };
      if (!isValidCoordinates(coordinates)) {
        res.status(400).json({ ok: false, error: "إحداثيات غير صالحة" });
        return;
      }

      const radiusRaw = Number(req.body?.radiusMeters);
      const radiusMeters =
        Number.isFinite(radiusRaw) && radiusRaw >= 20 && radiusRaw <= 5000
          ? Math.round(radiusRaw)
          : undefined;

      const db = getDb();
      const [updated] = await db
        .update(branches)
        .set({
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          ...(radiusMeters === undefined ? {} : { radiusMeters }),
          updatedAt: new Date(),
        })
        .where(eq(branches.id, branchId))
        .returning();

      if (!updated) {
        res.status(404).json({ ok: false, error: "الفرع غير موجود" });
        return;
      }

      res.json({ ok: true, branch: updated });
    },
  );

  // ------------------------------------------------------- الحضور والنماذج
  // الحضور (مع الموقع الجغرافي ومطابقة الوجه)، الشاشات الإدارية،
  // نماذج الموارد البشرية، مسير الرواتب، ملفات الموظفين والجداول، والتقارير،
  // ثم الإعدادات الشاملة وتقفيل الكاشير والمخزون وحزمة النماذج المطبوعة.
  app.use("/api", attendanceRouter);
  app.use("/api", adminRouter);
  app.use("/api", formsRouter);
  app.use("/api", payrollRouter);
  app.use("/api", peopleRouter);
  app.use("/api", reportsRouter);
  app.use("/api", settingsRouter);
  app.use("/api", cashierRouter);
  app.use("/api", inventoryRouter);
  app.use("/api", documentsRouter);

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "المسار غير موجود" });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[restaurant-hr] خطأ غير متوقع:", error);
    res.status(500).json({ ok: false, error: "حدث خطأ غير متوقع في الخادم" });
  });

  return app;
}
