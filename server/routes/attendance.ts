import { Router, type Response } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { attendanceLogs, branches, faceTemplates } from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  getFaceMatchMode,
  getFaceMatchThreshold,
  getPunchCooldownSeconds,
} from "../config.js";
import {
  evaluateFace,
  FACE_ALGORITHM,
  FACE_DIMENSIONS,
  FACE_SLOTS,
  parseDescriptor,
  readTemplates,
  saveTemplate,
} from "../face.js";
import { haversineDistanceMeters, isValidCoordinates } from "../geo.js";
import { PERMISSIONS, requirePermission } from "../rbac.js";
import {
  CHECK_IN,
  CHECK_OUT,
  checkInNotice,
  closeStaleShifts,
  EFFECTIVE_STATUSES,
  evaluateMinShift,
  lastEffectiveLog,
} from "../shifts.js";
import { safeTimeZone, startOfTodayInZone } from "../time.js";
import { asDateTime } from "../validate.js";

/** أقل فاصل زمني مسموح بين تسجيلين من نفس النوع. */
const DUPLICATE_WINDOW_MS = 60_000;

export const attendanceRouter = Router();

/* ── تسجيل قالب الوجه ──────────────────────────────────────────
 * القالب يُستخرج على جهاز الموظف داخل المتصفح، ولا تُرسل أي صورة إلى الخادم.
 */

attendanceRouter.get(
  "/face/status",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const employee = req.employee!;
    const stored = await readTemplates(employee.id);
    const readable = stored.filter((template) => template.vector !== null);
    const first = stored[0] ?? null;

    res.json({
      ok: true,
      // تعطيل البصمة لموظف بعينه يعلو على الإعداد العام، فالوضع الفعلي `off`
      mode: employee.faceEnabled ? getFaceMatchMode() : "off",
      systemMode: getFaceMatchMode(),
      faceEnabled: employee.faceEnabled,
      threshold: getFaceMatchThreshold(),
      algorithm: FACE_ALGORITHM,
      dimensions: FACE_DIMENSIONS,
      enrolled: stored.length > 0,
      /** الخانات المطلوبة والمسجَّلة — لكل خانة زر التقاط في التطبيق */
      slots: FACE_SLOTS,
      enrolledSlots: stored.map((template) => template.slot),
      readableCount: readable.length,
      readable: first ? first.vector !== null : null,
      enrolledAt: first?.enrolledAt.toISOString() ?? null,
    });
  },
);

/**
 * تسجيل بصمات الوجه: تُقبل ثلاث بصمات (خانات 1..3) في طلب واحد أو خانة
 * واحدة في كل طلب. إعادة تسجيل خانة مسجَّلة تحتاج تصفير القالب من الموارد
 * البشرية، فتُتجاهل الخانات المسجَّلة سابقاً ولا تُستبدل بصمت.
 */
attendanceRouter.post(
  "/face/enroll",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const employee = req.employee!;

    // إمّا `descriptors: [...]` (حتى ثلاثة) أو `descriptor` واحد مع `slot`
    const rawList = Array.isArray(req.body?.descriptors)
      ? req.body.descriptors
      : [req.body?.descriptor ?? req.body?.template];
    const requestedSlot = Number(req.body?.slot);

    if (rawList.length === 0 || rawList.length > FACE_SLOTS) {
      res.status(400).json({
        ok: false,
        error: `عدد البصمات المُرسلة غير صالح — المطلوب من بصمة واحدة إلى ${FACE_SLOTS}.`,
      });
      return;
    }

    const descriptors: number[][] = [];
    for (const raw of rawList) {
      const descriptor = parseDescriptor(raw);
      if (!descriptor) {
        res.status(400).json({
          ok: false,
          error: `قالب الوجه غير صالح. المطلوب متجّه من ${FACE_DIMENSIONS} قيمة يُستخرج في المتصفح.`,
        });
        return;
      }
      descriptors.push(descriptor);
    }

    const existing = await readTemplates(employee.id);
    const takenSlots = new Set(existing.map((template) => template.slot));

    if (takenSlots.size >= FACE_SLOTS) {
      res.status(409).json({
        ok: false,
        error:
          "بصماتك الثلاث مسجَّلة بالفعل. إعادة التسجيل تحتاج تصفير القالب من الموارد البشرية.",
      });
      return;
    }

    // خانة صريحة لطلب ببصمة واحدة، وإلّا تُملأ أول الخانات الفارغة بالترتيب
    const freeSlots: number[] = [];
    for (let slot = 1; slot <= FACE_SLOTS; slot += 1) {
      if (!takenSlots.has(slot)) freeSlots.push(slot);
    }

    if (
      descriptors.length === 1 &&
      Number.isInteger(requestedSlot) &&
      requestedSlot >= 1 &&
      requestedSlot <= FACE_SLOTS
    ) {
      if (takenSlots.has(requestedSlot)) {
        res.status(409).json({
          ok: false,
          error: `البصمة رقم ${requestedSlot} مسجَّلة بالفعل — تصفيرها من الموارد البشرية.`,
        });
        return;
      }
      freeSlots.unshift(requestedSlot);
    }

    if (descriptors.length > freeSlots.length) {
      res.status(409).json({
        ok: false,
        error: `المتاح ${freeSlots.length} خانة فقط لبصمات وجهك.`,
      });
      return;
    }

    const savedSlots: number[] = [];
    for (let index = 0; index < descriptors.length; index += 1) {
      const slot = freeSlots[index];
      await saveTemplate(employee.id, descriptors[index], {
        enrolledByEmployeeId: employee.id,
        slot,
      });
      savedSlots.push(slot);
    }

    await recordAudit({
      actorEmployeeId: employee.id,
      action: existing.length > 0 ? "face.enroll_slot" : "face.enroll",
      entityType: "face_templates",
      entityId: employee.id,
      after: {
        slots: savedSlots,
        dimensions: FACE_DIMENSIONS,
        algorithm: FACE_ALGORITHM,
      },
      reason: "تسجيل بصمات الوجه من جهاز الموظف",
      ipAddress: clientIp(req),
    });

    const total = takenSlots.size + savedSlots.length;
    res.status(201).json({
      ok: true,
      enrolledSlots: [...takenSlots, ...savedSlots].sort((a, b) => a - b),
      message:
        total >= FACE_SLOTS
          ? `تم تسجيل بصمات وجهك الثلاث بنجاح`
          : `تم تسجيل البصمة ${savedSlots.join(" و")} — المتبقي ${FACE_SLOTS - total} من ${FACE_SLOTS}`,
    });
  },
);

/* ── تسجيل الحضور والانصراف ──────────────────────────────────── */

interface AttemptInfo {
  id: number;
  type: string;
  serverTime: Date;
}

async function lastAttempt(employeeId: number): Promise<AttemptInfo | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: attendanceLogs.id,
      type: attendanceLogs.type,
      serverTime: attendanceLogs.serverTime,
    })
    .from(attendanceLogs)
    .where(eq(attendanceLogs.employeeId, employeeId))
    .orderBy(desc(attendanceLogs.serverTime))
    .limit(1);
  return row ?? null;
}

/**
 * تسجيل حضور أو انصراف.
 *
 * - الموقع الجغرافي إلزامي، والمسافة تُحسب بمعادلة Haversine من إحداثيات الفرع.
 * - قالب الوجه (اختياري/إلزامي حسب `FACE_MATCH_MODE`) يُقارن بالقالب المسجَّل.
 * - وقت التسجيل الرسمي هو `NOW()` من قاعدة البيانات دائماً.
 * - المحاولات خارج النطاق أو غير المطابقة للوجه **تُحفظ** بحالة `rejected`.
 */
const handleAttendance = (forcedType?: string) =>
  async (req: AuthedRequest, res: Response): Promise<void> => {
    const employee = req.employee!;
    const db = getDb();

    const coordinates = {
      latitude: Number(req.body?.latitude),
      longitude: Number(req.body?.longitude),
    };

    if (!isValidCoordinates(coordinates)) {
      res.status(400).json({
        ok: false,
        error: "الموقع الجغرافي مطلوب. يرجى السماح بالوصول إلى الموقع ثم إعادة المحاولة.",
      });
      return;
    }

    if (employee.branchId === null) {
      res.status(409).json({
        ok: false,
        error: "لم يتم ربط حسابك بأي فرع. راجع الموارد البشرية.",
      });
      return;
    }

    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, employee.branchId))
      .limit(1);

    if (!branch || !branch.isActive) {
      res.status(409).json({ ok: false, error: "فرعك غير مُفعّل حالياً" });
      return;
    }

    // إقفال أي وردية تجاوزت 4 فجراً قبل تحديد الحالة الحالية
    await closeStaleShifts({ employeeId: employee.id });

    // منع الضغط المتكرر السريع: أي محاولة (حتى المرفوضة) تُفعّل فترة تهدئة
    const cooldownSeconds = getPunchCooldownSeconds();
    const attempt = await lastAttempt(employee.id);
    if (
      cooldownSeconds > 0 &&
      attempt &&
      Date.now() - attempt.serverTime.getTime() < cooldownSeconds * 1000
    ) {
      const remaining = Math.max(
        1,
        Math.ceil(
          (cooldownSeconds * 1000 - (Date.now() - attempt.serverTime.getTime())) / 1000,
        ),
      );
      res.status(429).json({
        ok: false,
        error: `تمهّل قليلاً — أعد المحاولة بعد ${remaining} ثانية.`,
        retryAfterSeconds: remaining,
      });
      return;
    }

    const lastLog = await lastEffectiveLog(employee.id);

    const type =
      forcedType ??
      (typeof req.body?.type === "string" && [CHECK_IN, CHECK_OUT].includes(req.body.type)
        ? req.body.type
        : lastLog?.type === CHECK_IN
          ? CHECK_OUT
          : CHECK_IN);

    if (
      lastLog &&
      lastLog.type === type &&
      Date.now() - lastLog.serverTime.getTime() < DUPLICATE_WINDOW_MS
    ) {
      res.status(429).json({
        ok: false,
        error: type === CHECK_IN ? "تم تسجيل حضورك قبل لحظات" : "تم تسجيل انصرافك قبل لحظات",
      });
      return;
    }

    if (type === CHECK_IN && lastLog?.type === CHECK_IN) {
      res.status(409).json({
        ok: false,
        error: `${checkInNotice(lastLog.serverTime, branch.timezone)} — لديك وردية مفتوحة، سجّل الانصراف أولاً.`,
      });
      return;
    }

    if (type === CHECK_OUT && lastLog?.type !== CHECK_IN) {
      res.status(409).json({
        ok: false,
        error: "لا توجد وردية مفتوحة لتسجيل الانصراف منها.",
      });
      return;
    }

    // سياسة أقل مدة قبل الانصراف — تمنع تكرار الدخول والخروج المتقارب
    if (type === CHECK_OUT && lastLog?.type === CHECK_IN) {
      const minShift = evaluateMinShift({
        checkInAt: lastLog.serverTime,
        minShiftHours: branch.minShiftHours,
        timezone: branch.timezone,
      });

      if (minShift.blocked) {
        res.status(409).json({
          ok: false,
          error: minShift.message,
          minShiftHours: minShift.minHours,
          retryAfterSeconds: minShift.remainingMinutes * 60,
        });
        return;
      }
    }

    // مطابقة الوجه — القالب فقط يصل الخادم، ولا صورة إطلاقاً
    const descriptorProvided =
      req.body?.faceDescriptor !== undefined || req.body?.descriptor !== undefined;
    const face = await evaluateFace({
      employeeId: employee.id,
      rawDescriptor: req.body?.faceDescriptor ?? req.body?.descriptor,
      descriptorProvided,
    });

    // قالب مُشوَّه أو مفقود في الوضع الإلزامي: طلب غير مكتمل، لا يُسجَّل
    if (face.state === "invalid" || face.state === "required") {
      res.status(400).json({ ok: false, error: face.message, face: { state: face.state } });
      return;
    }

    const distanceMeters = haversineDistanceMeters(coordinates, {
      latitude: branch.latitude,
      longitude: branch.longitude,
    });
    const withinGeofence = distanceMeters <= branch.radiusMeters;
    const accuracyRaw = Number(req.body?.accuracyMeters ?? req.body?.accuracy);
    const clientTime = asDateTime(req.body?.clientTime);

    const reasons: string[] = [];
    if (!withinGeofence) {
      reasons.push(
        `المسافة ${Math.round(distanceMeters)} متر تتجاوز النطاق المسموح ${branch.radiusMeters} متر`,
      );
    }
    if (face.message && face.state !== "enrolled") reasons.push(face.message);

    const status =
      !withinGeofence || face.state === "mismatch"
        ? "rejected"
        : face.state === "missing" || face.state === "unreadable"
          ? "flagged"
          : "approved";

    // `serverTime` غير مُمرّر عن قصد — القيمة الافتراضية NOW() من قاعدة
    // البيانات هي المصدر الوحيد لوقت التسجيل الرسمي.
    const [log] = await db
      .insert(attendanceLogs)
      .values({
        employeeId: employee.id,
        branchId: branch.id,
        type,
        clientReportedTime: clientTime,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        accuracyMeters: Number.isFinite(accuracyRaw) ? accuracyRaw : null,
        distanceMeters: Math.round(distanceMeters * 100) / 100,
        withinGeofence,
        status,
        reason: reasons.join(" — "),
        source: "device",
        faceVerified: face.verified,
        faceDistance: face.distance,
        deviceInfo: String(req.body?.deviceInfo ?? req.headers["user-agent"] ?? "").slice(0, 500),
        ipAddress: clientIp(req),
      })
      .returning();

    const payload = {
      id: log.id,
      type: log.type,
      status: log.status,
      serverTime: log.serverTime.toISOString(),
      localTime: log.serverTime.toLocaleString("ar", { timeZone: safeTimeZone(branch.timezone) }),
      distanceMeters: log.distanceMeters,
      allowedRadiusMeters: branch.radiusMeters,
      withinGeofence: log.withinGeofence,
      face: {
        state: face.state,
        verified: face.verified,
        distance: face.distance,
        threshold: face.threshold,
      },
      branch: { id: branch.id, name: branch.name, code: branch.code },
    };

    if (status === "rejected") {
      res.status(403).json({
        ok: false,
        error: withinGeofence
          ? face.message
          : `أنت بعيد عن ${branch.name} بمسافة ${Math.round(distanceMeters)} متر. النطاق المسموح ${branch.radiusMeters} متر.`,
        note: "تم حفظ المحاولة بحالة «مرفوض» ليراجعها المسؤول.",
        attendance: payload,
      });
      return;
    }

    const baseMessage =
      type === CHECK_IN
        ? `تم تسجيل حضورك في ${branch.name}`
        : `تم تسجيل انصرافك من ${branch.name}`;

    res.status(201).json({
      ok: true,
      message: face.state === "enrolled" ? `${baseMessage} — ${face.message}` : baseMessage,
      warning: status === "flagged" ? face.message : undefined,
      attendance: payload,
    });
  };

attendanceRouter.post(
  "/attendance/check-in",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceCheckIn),
  handleAttendance(CHECK_IN),
);
attendanceRouter.post(
  "/attendance/check-out",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceCheckIn),
  handleAttendance(CHECK_OUT),
);
/** يحدّد النوع تلقائياً بحسب آخر تسجيل (حضور ↔ انصراف). */
attendanceRouter.post(
  "/attendance/punch",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceCheckIn),
  handleAttendance(),
);

attendanceRouter.get(
  "/attendance/today",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const employee = req.employee!;
    const db = getDb();

    const [branch] = employee.branchId
      ? await db
          .select({ timezone: branches.timezone })
          .from(branches)
          .where(eq(branches.id, employee.branchId))
          .limit(1)
      : [];

    const timeZone = safeTimeZone(branch?.timezone);

    await closeStaleShifts({ employeeId: employee.id });

    const rows = await db
      .select()
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.employeeId, employee.id),
          gte(attendanceLogs.serverTime, startOfTodayInZone(timeZone)),
        ),
      )
      .orderBy(desc(attendanceLogs.serverTime));

    const last = await lastEffectiveLog(employee.id);

    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      timezone: timeZone,
      logs: rows,
      openShift: last?.type === CHECK_IN,
      openShiftSince: last?.type === CHECK_IN ? last.serverTime.toISOString() : null,
    });
  },
);

attendanceRouter.get(
  "/attendance/history",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const limitRaw = Number.parseInt(String(req.query.limit ?? "30"), 10);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 30;

    const db = getDb();
    const rows = await db
      .select()
      .from(attendanceLogs)
      .where(eq(attendanceLogs.employeeId, req.employee!.id))
      .orderBy(desc(attendanceLogs.serverTime))
      .limit(limit);

    res.json({ ok: true, logs: rows });
  },
);

/** ملخص الورديات المفتوحة الآن في فرع المستخدم — لمشرف الوردية والمدير. */
attendanceRouter.get(
  "/attendance/open-shifts",
  requireAuth,
  requirePermission(PERMISSIONS.attendanceReadAll),
  async (req: AuthedRequest, res: Response) => {
    const db = getDb();
    await closeStaleShifts();

    const rows = await db
      .select({
        id: attendanceLogs.id,
        employeeId: attendanceLogs.employeeId,
        branchId: attendanceLogs.branchId,
        type: attendanceLogs.type,
        serverTime: attendanceLogs.serverTime,
      })
      .from(attendanceLogs)
      .where(inArray(attendanceLogs.status, [...EFFECTIVE_STATUSES]))
      .orderBy(desc(attendanceLogs.serverTime))
      .limit(500);

    // آخر حركة لكل موظف — إن كانت حضوراً فالوردية مفتوحة
    const seen = new Set<number>();
    const open = rows.filter((row) => {
      if (seen.has(row.employeeId)) return false;
      seen.add(row.employeeId);
      return row.type === CHECK_IN;
    });

    res.json({ ok: true, openShifts: open });
  },
);

/** حالة تسجيل بصمات الوجه لكل الموظفين (عدد الخانات لكل موظف) — للموارد البشرية. */
attendanceRouter.get(
  "/face/enrollments",
  requireAuth,
  requirePermission(PERMISSIONS.employeesRead),
  async (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const rows = await db
      .select({
        employeeId: faceTemplates.employeeId,
        slot: faceTemplates.slot,
        algorithm: faceTemplates.algorithm,
        enrolledAt: faceTemplates.enrolledAt,
        updatedAt: faceTemplates.updatedAt,
      })
      .from(faceTemplates);

    // صف واحد لكل موظف: عدد البصمات المسجَّلة وأقدم تاريخ تسجيل
    const byEmployee = new Map<
      number,
      {
        employeeId: number;
        slots: number;
        requiredSlots: number;
        algorithm: string;
        enrolledAt: Date;
        updatedAt: Date | null;
      }
    >();

    for (const row of rows) {
      const current = byEmployee.get(row.employeeId);
      if (!current) {
        byEmployee.set(row.employeeId, {
          employeeId: row.employeeId,
          slots: 1,
          requiredSlots: FACE_SLOTS,
          algorithm: row.algorithm,
          enrolledAt: row.enrolledAt,
          updatedAt: row.updatedAt,
        });
        continue;
      }
      current.slots += 1;
      if (row.enrolledAt < current.enrolledAt) current.enrolledAt = row.enrolledAt;
      if (row.updatedAt && (!current.updatedAt || row.updatedAt > current.updatedAt)) {
        current.updatedAt = row.updatedAt;
      }
    }

    res.json({ ok: true, requiredSlots: FACE_SLOTS, enrollments: [...byEmployee.values()] });
  },
);
