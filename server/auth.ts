import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { employees, roles, sessions } from "../db/schema.js";
import { getJwtSecret, getSessionIdleSeconds, getTokenTtlSeconds } from "./config.js";

export interface AuthenticatedEmployee {
  id: number;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  branchId: number | null;
  roleId: number | null;
  roleName: string | null;
  tokenId: string;
  /** هل بصمة الوجه مُفعّلة لهذا الموظف؟ */
  faceEnabled: boolean;
}

/** يمرّر الموظف المُوثّق مع الطلب. */
export interface AuthedRequest extends Request {
  employee?: AuthenticatedEmployee;
}

interface TokenPayload {
  sub: string;
  jti: string;
  code: string;
}

/**
 * يُصدر توكن JWT ويسجّل الجلسة في جدول `sessions` حتى يمكن إبطالها لاحقاً.
 */
export async function issueSession(
  employeeId: number,
  employeeCode: string,
  meta: { userAgent: string; ipAddress: string },
): Promise<{ token: string; expiresAt: Date; tokenId: string }> {
  const db = getDb();
  const tokenId = randomUUID();
  const ttl = getTokenTtlSeconds();
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const payload: TokenPayload = {
    sub: String(employeeId),
    jti: tokenId,
    code: employeeCode,
  };

  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: ttl });

  await db.insert(sessions).values({
    tokenId,
    employeeId,
    userAgent: meta.userAgent.slice(0, 500),
    ipAddress: meta.ipAddress.slice(0, 100),
    expiresAt,
  });

  return { token, expiresAt, tokenId };
}

/** يبطل الجلسة الحالية (تسجيل خروج). */
export async function revokeSession(tokenId: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenId, tokenId));
}

/** يبطل كل جلسات موظف (يُستخدم بعد تغيير كلمة المرور أو تعطيل الحساب). */
export async function revokeAllSessionsForEmployee(employeeId: number): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.employeeId, employeeId), isNull(sessions.revokedAt)));
}

/**
 * أقصر فاصل بين تحديثين لعمود `last_seen_at`. الطلبات المتقاربة لا تستحق
 * كتابة في قاعدة البيانات، فيُحدَّث الطابع مرة كل دقيقة على الأكثر.
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

/**
 * وسيط التحقق: يتأكد من صحة التوكن، ومن أن الجلسة غير مُبطلة،
 * ومن أن الموظف ما زال نشطاً.
 */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "مطلوب تسجيل الدخول" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, getJwtSecret()) as TokenPayload;
  } catch {
    res
      .status(401)
      .json({ ok: false, error: "الجلسة غير صالحة أو منتهية، يرجى تسجيل الدخول مرة أخرى" });
    return;
  }

  const db = getDb();

  const [session] = await db
    .select({
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenId, payload.jti), isNull(sessions.revokedAt)))
    .limit(1);

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    res.status(401).json({ ok: false, error: "انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى" });
    return;
  }

  /**
   * خروج تلقائي بالخمول: إذا مضت مدة أطول من المسموح دون أي طلب من هذا
   * التوكن (المستخدم ترك الصفحة أو أغلق التطبيق) تُبطل الجلسة في الخادم —
   * فلا تكفي إعادة فتح الصفحة بالتوكن القديم للعودة إلى النظام.
   */
  const idleMs = getSessionIdleSeconds() * 1000;
  const idleFor = Date.now() - session.lastSeenAt.getTime();

  if (idleFor > idleMs) {
    await revokeSession(payload.jti);
    res.status(401).json({
      ok: false,
      error: "تم إنهاء الجلسة تلقائياً بعد فترة خمول، يرجى تسجيل الدخول مرة أخرى",
      reason: "idle_timeout",
    });
    return;
  }

  const [row] = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      fullName: employees.fullName,
      jobTitle: employees.jobTitle,
      branchId: employees.branchId,
      roleId: employees.roleId,
      isActive: employees.isActive,
      faceEnabled: employees.faceEnabled,
      roleName: roles.name,
    })
    .from(employees)
    .leftJoin(roles, eq(employees.roleId, roles.id))
    .where(eq(employees.id, Number(payload.sub)))
    .limit(1);

  if (!row || !row.isActive) {
    res.status(403).json({ ok: false, error: "الحساب غير مُفعّل" });
    return;
  }

  if (idleFor >= LAST_SEEN_WRITE_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, session.id));
  }

  req.employee = {
    id: row.id,
    employeeCode: row.employeeCode,
    fullName: row.fullName,
    jobTitle: row.jobTitle,
    branchId: row.branchId,
    roleId: row.roleId,
    roleName: row.roleName ?? null,
    tokenId: payload.jti,
    faceEnabled: row.faceEnabled,
  };

  next();
}
