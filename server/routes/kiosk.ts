/**
 * التحضير / الانصراف السريع (كشك بلا تسجيل دخول).
 *
 * نقطتان عامتان (بلا requireAuth) تُحدّدان هوية الموظف بمطابقة الوجه (1:N)
 * أو برقمه الوظيفي + PIN احتياطي، ثم تُسجّلان الحركة في نفس جدول
 * attendance_logs الذي يستخدمه الحضور بتسجيل الدخول - فأول حركة في اليوم
 * حضور والثانية انصراف مهما كانت الطريقة، بلا أي تكرار أو تعارض. لا تُنشئ
 * هذه الوحدة أي منطق جغرافي أو منطق ورديات جديد: تُعيد استخدام geo.ts
 * و shifts.ts و face.ts كما هي تماماً، ولا تُعدّل أي جدول أو مسار قائم.
 */

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { attendanceLogs, branches, employees } from "../../db/schema.js";
import { clientIp, recordAudit } from "../audit.js";
import { getPunchCooldownSeconds } from "../config.js";
import { identifyFace } from "../face.js";
import { haversineDistanceMeters, isValidCoordinates } from "../geo.js";
import { verifyPassword } from "../passwords.js";
import {
  CHECK_IN,
  CHECK_OUT,
  closeStaleShifts,
  evaluateMinShift,
  lastEffectiveLog,
} from "../shifts.js";
import { safeTimeZone } from "../time.js";

export const kioskRouter = Router();

const DUPLICATE_WINDOW_MS = 60_000;
const REQUIRED_LOCATION_MESSAGE = "يجب التحضير من موقع العمل";

interface KioskEmployee {
    id: number;
    fullName: string;
    isActive: boolean;
    branchId: number | null;
}

async function loadKioskEmployee(id: number): Promise<KioskEmployee | null> {
    const db = getDb();
    const [row] = await db
      .select({
              id: employees.id,
              fullName: employees.fullName,
              isActive: employees.isActive,
              branchId: employees.branchId,
      })
      .from(employees)
      .where(eq(employees.id, id))
      .limit(1);
    return row ?? null;
}

interface AttemptInfo {
    id: number;
    serverTime: Date;
}

async function lastAttempt(employeeId: number): Promise<AttemptInfo | null> {
    const db = getDb();
    const rows = await db
      .select({ id: attendanceLogs.id, serverTime: attendanceLogs.serverTime })
      .from(attendanceLogs)
      .where(eq(attendanceLogs.employeeId, employeeId))
      .orderBy(attendanceLogs.serverTime);
    if (rows.length === 0) return null;
    return rows[rows.length - 1];
}

async function finalizeKioskPunch(
    req: Request,
    res: Response,
    employee: KioskEmployee,
    verification: { method: "face" | "pin"; faceDistance: number | null },
  ): Promise<void> {
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

  if (!employee.isActive) {
        res.status(403).json({ ok: false, error: "الحساب غير مُفعّل، راجع الموارد البشرية" });
        return;
  }

  if (employee.branchId === null) {
        res.status(409).json({
                ok: false,
                error: "لم يتم ربط الموظف بأي فرع. راجع الموارد البشرية.",
        });
        return;
  }

    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, employee.branchId))
      .limit(1);

  if (!branch || !branch.isActive) {
        res.status(409).json({ ok: false, error: "فرع الموظف غير مُفعّل حالياً" });
        return;
  }

  await closeStaleShifts({ employeeId: employee.id });

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
                error: `تمهّل قليلاً - أعد المحاولة بعد ${remaining} ثانية.`,
                retryAfterSeconds: remaining,
        });
        return;
  }

    const lastLog = await lastEffectiveLog(employee.id);
    const type = lastLog?.type === CHECK_IN ? CHECK_OUT : CHECK_IN;

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

    // سياسة أقل مدة قبل الانصراف — نفس القاعدة المطبَّقة في تطبيق الموظف
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

  const distanceMeters = haversineDistanceMeters(coordinates, {
          latitude: branch.latitude,
          longitude: branch.longitude,
    });
    const withinGeofence = distanceMeters <= branch.radiusMeters;
    const deviceInfo = String(req.body?.deviceInfo ?? req.headers["user-agent"] ?? "").slice(0, 500);

    if (!withinGeofence) {
          await db.insert(attendanceLogs).values({
                  employeeId: employee.id,
                  branchId: branch.id,
                  type,
                  latitude: coordinates.latitude,
                  longitude: coordinates.longitude,
                  distanceMeters: Math.round(distanceMeters * 100) / 100,
                  withinGeofence: false,
                  status: "rejected",
                  reason: `الكشك: المسافة ${Math.round(distanceMeters)} متر تتجاوز النطاق المسموح ${branch.radiusMeters} متر`,
                  source: "kiosk",
                  faceVerified: verification.method === "face",
                  faceDistance: verification.faceDistance,
                  deviceInfo,
                  ipAddress: clientIp(req),
          });

          res.status(403).json({ ok: false, error: REQUIRED_LOCATION_MESSAGE });
          return;
    }

                                  const [log] = await db
      .insert(attendanceLogs)
      .values({
              employeeId: employee.id,
              branchId: branch.id,
              type,
              latitude: coordinates.latitude,
              longitude: coordinates.longitude,
              distanceMeters: Math.round(distanceMeters * 100) / 100,
              withinGeofence: true,
              status: "approved",
              reason: "",
              source: "kiosk",
              faceVerified: verification.method === "face",
              faceDistance: verification.faceDistance,
              deviceInfo,
              ipAddress: clientIp(req),
      })
      .returning();

    await recordAudit({
          actorEmployeeId: employee.id,
          action: type === CHECK_IN ? "kiosk.check_in" : "kiosk.check_out",
          entityType: "attendance_logs",
          entityId: log.id,
          after: { type, source: "kiosk", method: verification.method },
          reason: "تحضير/انصراف سريع من الكشك",
          ipAddress: clientIp(req),
    });

    res.status(201).json({
          ok: true,
          message: `تم تسجيل ${type === CHECK_IN ? "حضور" : "انصراف"} ${employee.fullName}`,
          attendance: {
                  id: log.id,
                  type,
                  serverTime: log.serverTime.toISOString(),
                  localTime: log.serverTime.toLocaleString("ar", { timeZone: safeTimeZone(branch.timezone) }),
          },
          employee: { id: employee.id, fullName: employee.fullName },
    });
}

kioskRouter.post("/kiosk/punch-face", async (req: Request, res: Response) => {
    const identify = await identifyFace(req.body?.descriptor ?? req.body?.faceDescriptor, {
          ambiguityMargin: 0.05,
    });

    if (!identify.matched || identify.employeeId === null) {
          res.status(401).json({
                  ok: false,
                  matched: false,
                  error: identify.ambiguous
                    ? "تعذّر تحديد الهوية بدقّة. أعد المحاولة في إضاءة أفضل أو استخدم الرقم الوظيفي وPIN."
                            : "لم يُتعرَّف على وجهك. أعد المحاولة أو استخدم الرقم الوظيفي وPIN.",
          });
          return;
    }

    const employee = await loadKioskEmployee(identify.employeeId);
    if (!employee) {
          res.status(404).json({ ok: false, error: "الموظف غير موجود" });
          return;
    }

    await finalizeKioskPunch(req, res, employee, {
          method: "face",
          faceDistance: identify.distance,
    });
});

kioskRouter.post("/kiosk/punch-pin", async (req: Request, res: Response) => {
    const employeeCode = String(req.body?.employeeCode ?? "").trim();
    const pin = String(req.body?.pin ?? "").trim();

    if (!employeeCode || !pin) {
          res.status(400).json({ ok: false, error: "الرقم الوظيفي ورمز PIN مطلوبان" });
          return;
    }

    const db = getDb();
    const [row] = await db
      .select({
              id: employees.id,
              fullName: employees.fullName,
              isActive: employees.isActive,
              branchId: employees.branchId,
              kioskPinHash: employees.kioskPinHash,
      })
      .from(employees)
      .where(eq(employees.employeeCode, employeeCode))
      .limit(1);

    if (!row || !row.kioskPinHash || !verifyPassword(pin, row.kioskPinHash)) {
          res.status(401).json({ ok: false, error: "الرقم الوظيفي أو رمز PIN غير صحيح" });
          return;
    }

    if (!row.isActive) {
          res.status(403).json({ ok: false, error: "الحساب غير مُفعّل، راجع الموارد البشرية" });
          return;
    }

    await finalizeKioskPunch(
          req,
          res,
      { id: row.id, fullName: row.fullName, isActive: row.isActive, branchId: row.branchId },
      { method: "pin", faceDistance: null },
        );
});
