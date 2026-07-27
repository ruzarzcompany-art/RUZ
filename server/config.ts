import { createHash, scryptSync } from "node:crypto";

/**
 * قراءة متغيّرات البيئة بشكل يعمل في دوال Netlify وفي Node العادي.
 */
export function env(name: string): string | undefined {
  const netlifyEnv = (globalThis as { Netlify?: { env?: { get(key: string): string | undefined } } })
    .Netlify?.env;
  return netlifyEnv?.get(name) ?? process.env[name];
}

let cachedSecret: string | undefined;

/**
 * مفتاح توقيع JWT. يُفضّل ضبط `JWT_SECRET` في متغيّرات البيئة.
 * في حال غيابه يُشتق مفتاح ثابت من بيانات النشر حتى تبقى الجلسات صالحة
 * بين النسخ المختلفة من الدالة، مع تنبيه في السجلات.
 */
export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;

  const configured = env("JWT_SECRET");
  if (configured && configured.length >= 16) {
    cachedSecret = configured;
    return cachedSecret;
  }

  const material =
    env("NETLIFY_DB_URL") ??
    env("DATABASE_URL") ??
    env("NETLIFY_DATABASE_URL") ??
    env("SITE_ID") ??
    "restaurant-hr-local-development";

  console.warn(
    "[restaurant-hr] JWT_SECRET غير مضبوط — يتم استخدام مفتاح مشتق مؤقتاً. اضبط JWT_SECRET قبل الإنتاج.",
  );

  cachedSecret = createHash("sha256")
    .update(`restaurant-hr:jwt:${material}`)
    .digest("hex");

  return cachedSecret;
}

/** مدة صلاحية التوكن بالثواني (افتراضياً 12 ساعة — طول وردية عمل). */
export function getTokenTtlSeconds(): number {
  const raw = env("JWT_TTL_SECONDS");
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12 * 60 * 60;
}

/** كلمة مرور الحساب التجريبي المُنشأ عند البذر. */
export function getSeedPassword(): string {
  return env("SEED_DEFAULT_PASSWORD") ?? "Restaurant@2026";
}

/**
 * وضع مطابقة الوجه:
 * - `off`      : تجاهل الوجه تماماً (سلوك النسخة الأولى).
 * - `optional` : (الافتراضي) مَن سُجِّل قالبه يجب أن يطابقه؛ ومَن لم يُسجَّل بعد
 *                يُسجَّل قالبه تلقائياً في أول تسجيل حضور يرسله. والتسجيل بدون
 *                قالب لموظف مسجَّل يُحفظ بحالة `flagged` للمراجعة.
 * - `enforce`  : القالب مطلوب في كل تسجيل، وبدونه يُرفض الطلب.
 */
export function getFaceMatchMode(): "off" | "optional" | "enforce" {
  const raw = (env("FACE_MATCH_MODE") ?? "optional").trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "optional";
}

/**
 * أقصى مسافة إقليدية مسموحة بين القالبين ليُعدّ الوجه مطابقاً.
 * القيمة المرجعية لنموذج face-api هي 0.6؛ نستخدم 0.55 لتشديد المطابقة.
 */
export function getFaceMatchThreshold(): number {
  const parsed = Number.parseFloat(env("FACE_MATCH_THRESHOLD") ?? "");
  return Number.isFinite(parsed) && parsed > 0 && parsed < 2 ? parsed : 0.55;
}

/** ساعة الإقفال التلقائي للورديات المفتوحة بتوقيت الفرع (افتراضياً 4 فجراً). */
export function getAutoCloseHour(): number {
  const parsed = Number.parseInt(env("SHIFT_AUTO_CLOSE_HOUR") ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 4;
}

/** أقل فاصل بالثواني بين أي محاولتي تسجيل (منع الضغط المتكرر السريع). */
export function getPunchCooldownSeconds(): number {
  const parsed = Number.parseInt(env("PUNCH_COOLDOWN_SECONDS") ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 300 ? parsed : 8;
}

let cachedFaceKey: Buffer | undefined;

/**
 * مفتاح تشفير قوالب الوجه (AES-256-GCM، 32 بايت).
 * يُقرأ من `FACE_TEMPLATE_KEY` (hex أو base64 أو أي نص يُشتق منه المفتاح).
 * عند غيابه يُشتق مفتاح من بيانات النشر مع تنبيه — وتغيير مادة الاشتقاق
 * لاحقاً يجعل القوالب المخزَّنة غير قابلة لفك التشفير (يُعاد تسجيلها).
 */
export function getFaceEncryptionKey(): Buffer {
  if (cachedFaceKey) return cachedFaceKey;

  const configured = env("FACE_TEMPLATE_KEY");

  if (configured && /^[0-9a-fA-F]{64}$/.test(configured.trim())) {
    cachedFaceKey = Buffer.from(configured.trim(), "hex");
    return cachedFaceKey;
  }

  if (configured && configured.trim().length >= 16) {
    // اشتقاق ثابت من النص المُعطى (يقبل base64 أو عبارة سرّية)
    cachedFaceKey = scryptSync(configured.trim(), "restaurant-hr:face:v1", 32);
    return cachedFaceKey;
  }

  console.warn(
    "[restaurant-hr] FACE_TEMPLATE_KEY غير مضبوط — يتم اشتقاق مفتاح مؤقت لتشفير قوالب الوجه. اضبطه قبل الإنتاج.",
  );

  cachedFaceKey = scryptSync(getJwtSecret(), "restaurant-hr:face:v1", 32);
  return cachedFaceKey;
}
