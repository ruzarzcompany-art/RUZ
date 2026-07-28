import { randomInt } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { employees, passwordResetRequests } from "../db/schema.js";
import { getResetCodeTtlSeconds, getMailConfig } from "./config.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { sendMail } from "./mailer.js";

/** أقصى عدد محاولات إدخال خاطئة قبل إلغاء الطلب. */
const MAX_ATTEMPTS = 5;

/** أقصى عدد طلبات لنفس الحساب خلال ساعة (تحديد معدّل). */
const MAX_REQUESTS_PER_HOUR = 5;

/** طول رمز الاستعادة. */
const CODE_LENGTH = 6;

/**
 * رمز رقمي من ٦ خانات. `randomInt` من node:crypto (عشوائية تشفيرية)،
 * ولا يُخزَّن الرمز نفسه بل تجزئته.
 */
function generateCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}

/** يخفي البريد في الرسائل والسجلات: a***@example.com */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) return "";
  const head = name.slice(0, 1);
  return `${head}${"*".repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

export interface CreateResetResult {
  /** هل أُنشئ طلب فعلاً؟ (false = لا حساب مطابق أو تجاوز حد الطلبات) */
  created: boolean;
  /** هل أُرسل الرمز إلى البريد؟ */
  emailed: boolean;
  /** البريد المُقنَّع للعرض (عند الإرسال فقط) */
  maskedEmail: string;
  /** معرّف الطلب — للسجلات الإدارية فقط */
  requestId: number | null;
  /** سبب داخلي (لا يُعرض لطالب الاستعادة) */
  detail: string;
}

/**
 * ينشئ طلب استعادة كلمة مرور لحساب موجود، ويحاول إرسال الرمز إلى بريد
 * الموظف. عند غياب البريد أو مزوّد البريد يبقى الطلب `pending` في قائمة
 * مسؤول البرنامج ليصدر الرمز بنفسه.
 *
 * المستدعي يجب أن يُرجع دائماً نفس الرسالة للمستخدم أياً كانت النتيجة
 * حتى لا يتحوّل المسار إلى وسيلة لكشف الحسابات الموجودة.
 */
export async function createResetRequest(options: {
  identifier: string;
  ipAddress: string;
}): Promise<CreateResetResult> {
  const db = getDb();
  const identifier = options.identifier.trim();
  const isEmail = identifier.includes("@");

  const [employee] = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      fullName: employees.fullName,
      email: employees.email,
      isActive: employees.isActive,
    })
    .from(employees)
    .where(
      isEmail
        ? sql`lower(${employees.email}) = ${identifier.toLowerCase()}`
        : eq(employees.employeeCode, identifier),
    )
    .limit(1);

  if (!employee || !employee.isActive) {
    return {
      created: false,
      emailed: false,
      maskedEmail: "",
      requestId: null,
      detail: "لا يوجد حساب نشط مطابق",
    };
  }

  // تحديد معدّل: لا نسمح بإغراق الحساب (ولا بريد الموظف) بالطلبات
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [recent] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(passwordResetRequests)
    .where(
      and(
        eq(passwordResetRequests.employeeId, employee.id),
        gt(passwordResetRequests.createdAt, since),
      ),
    );

  if ((recent?.total ?? 0) >= MAX_REQUESTS_PER_HOUR) {
    return {
      created: false,
      emailed: false,
      maskedEmail: "",
      requestId: null,
      detail: "تجاوز الحد المسموح من الطلبات",
    };
  }

  // إلغاء الطلبات المعلّقة السابقة حتى يبقى رمز واحد صالحاً فقط
  await db
    .update(passwordResetRequests)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(passwordResetRequests.employeeId, employee.id),
        sql`${passwordResetRequests.status} in ('pending', 'sent')`,
      ),
    );

  const code = generateCode();
  const expiresAt = new Date(Date.now() + getResetCodeTtlSeconds() * 1000);

  const [request] = await db
    .insert(passwordResetRequests)
    .values({
      employeeId: employee.id,
      requestedIdentifier: identifier.slice(0, 200),
      codeHash: hashPassword(code),
      status: "pending",
      ipAddress: options.ipAddress.slice(0, 100),
      expiresAt,
    })
    .returning({ id: passwordResetRequests.id });

  const requestId = request?.id ?? null;
  const email = (employee.email ?? "").trim();
  const mail = getMailConfig();

  if (!email || !mail.configured) {
    return {
      created: true,
      emailed: false,
      maskedEmail: "",
      requestId,
      detail: email
        ? "مزوّد البريد غير مضبوط — الطلب في انتظار مسؤول البرنامج"
        : "لا يوجد بريد مسجَّل للحساب — الطلب في انتظار مسؤول البرنامج",
    };
  }

  const minutes = Math.round(getResetCodeTtlSeconds() / 60);
  const result = await sendMail({
    to: email,
    subject: "رمز استعادة كلمة المرور — نظام موظفي المطعم",
    text: [
      `مرحباً ${employee.fullName},`,
      "",
      `رمز استعادة كلمة المرور الخاص بحسابك (${employee.employeeCode}) هو:`,
      "",
      code,
      "",
      `الرمز صالح لمدة ${minutes} دقيقة ويُستخدم مرة واحدة.`,
      "إن لم تطلب الاستعادة فتجاهل هذه الرسالة ولن يتغيّر شيء في حسابك.",
    ].join("\n"),
  });

  if (requestId !== null) {
    await db
      .update(passwordResetRequests)
      .set({
        status: result.delivered ? "sent" : "pending",
        deliveryChannel: result.delivered ? "email" : "",
        deliveredTo: result.delivered ? email : "",
        updatedAt: new Date(),
      })
      .where(eq(passwordResetRequests.id, requestId));
  }

  return {
    created: true,
    emailed: result.delivered,
    maskedEmail: result.delivered ? maskEmail(email) : "",
    requestId,
    detail: result.delivered ? "" : result.reason,
  };
}

export interface ConsumeResult {
  ok: boolean;
  error?: string;
}

/**
 * يتحقق من الرمز ويضبط كلمة المرور الجديدة. الرمز يُستهلك مرة واحدة،
 * والمحاولات الخاطئة محدودة، والرسائل موحّدة حتى لا تكشف حالة الطلب.
 */
export async function consumeResetCode(options: {
  identifier: string;
  code: string;
  newPassword: string;
}): Promise<ConsumeResult> {
  const db = getDb();
  const identifier = options.identifier.trim();
  const isEmail = identifier.includes("@");
  const generic = "الرمز غير صحيح أو انتهت صلاحيته، اطلب رمزاً جديداً";

  const [employee] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(
      isEmail
        ? sql`lower(${employees.email}) = ${identifier.toLowerCase()}`
        : eq(employees.employeeCode, identifier),
    )
    .limit(1);

  if (!employee) return { ok: false, error: generic };

  const [request] = await db
    .select()
    .from(passwordResetRequests)
    .where(
      and(
        eq(passwordResetRequests.employeeId, employee.id),
        sql`${passwordResetRequests.status} in ('pending', 'sent')`,
      ),
    )
    .orderBy(desc(passwordResetRequests.createdAt))
    .limit(1);

  if (!request) return { ok: false, error: generic };

  if (request.expiresAt.getTime() <= Date.now()) {
    await db
      .update(passwordResetRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(passwordResetRequests.id, request.id));
    return { ok: false, error: generic };
  }

  if (!verifyPassword(options.code.trim(), request.codeHash)) {
    const attempts = request.attempts + 1;
    await db
      .update(passwordResetRequests)
      .set({
        attempts,
        status: attempts >= MAX_ATTEMPTS ? "cancelled" : request.status,
        updatedAt: new Date(),
      })
      .where(eq(passwordResetRequests.id, request.id));
    return { ok: false, error: generic };
  }

  await db
    .update(employees)
    .set({
      passwordHash: hashPassword(options.newPassword),
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(employees.id, employee.id));

  await db
    .update(passwordResetRequests)
    .set({ status: "used", usedAt: new Date(), updatedAt: new Date() })
    .where(eq(passwordResetRequests.id, request.id));

  return { ok: true };
}

/**
 * يصدر مسؤول البرنامج رمزاً مؤقتاً بنفسه (البديل المعتمد عند غياب البريد).
 * الرمز يُعاد للمسؤول مرة واحدة فقط ليسلّمه للموظف، ولا يُخزَّن نصاً.
 */
export async function issueResetCodeByAdmin(options: {
  employeeId: number;
  actorEmployeeId: number;
  requestId?: number | null;
}): Promise<{ code: string; expiresAt: Date }> {
  const db = getDb();
  const code = generateCode();
  const expiresAt = new Date(Date.now() + getResetCodeTtlSeconds() * 1000);

  await db
    .update(passwordResetRequests)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(passwordResetRequests.employeeId, options.employeeId),
        sql`${passwordResetRequests.status} in ('pending', 'sent')`,
      ),
    );

  await db.insert(passwordResetRequests).values({
    employeeId: options.employeeId,
    requestedIdentifier: "",
    codeHash: hashPassword(code),
    status: "sent",
    deliveryChannel: "admin",
    issuedByEmployeeId: options.actorEmployeeId,
    expiresAt,
  });

  return { code, expiresAt };
}
