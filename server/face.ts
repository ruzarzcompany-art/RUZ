import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { employees, faceTemplates } from "../db/schema.js";
import { getFaceMatchMode, getFaceMatchThreshold } from "./config.js";
import { decryptString, encryptString, KEY_VERSION } from "./crypto.js";

/** عدد أبعاد قالب الوجه المتوقّع (نموذج faceRecognitionNet ينتج 128 قيمة). */
export const FACE_DIMENSIONS = 128;
export const FACE_ALGORITHM = "face-api:faceRecognitionNet@1.7";

/**
 * يتحقق من أن ما وصل هو قالب رقمي سليم (متجّه أرقام) — لا صورة ولا نص آخر.
 * الصور لا تُقبل ولا تُرسل من التطبيق إطلاقاً.
 */
export function parseDescriptor(value: unknown): number[] | null {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : null;

  if (!raw || raw.length !== FACE_DIMENSIONS) return null;

  const vector: number[] = [];
  let magnitude = 0;

  for (const item of raw) {
    const num = typeof item === "number" ? item : Number(item);
    // قيم النموذج تقع فعلياً في نطاق صغير حول الصفر؛ نرفض ما هو خارج المعقول
    if (!Number.isFinite(num) || Math.abs(num) > 10) return null;
    magnitude += num * num;
    vector.push(num);
  }

  // قالب صفري = لا وجه فعلي
  if (magnitude < 1e-6) return null;

  return vector;
}

/** المسافة الإقليدية بين قالبين — أصغر = أقرب للتطابق. */
export function euclideanDistance(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export interface StoredTemplate {
  id: number;
  slot: number;
  algorithm: string;
  vector: number[] | null;
  enrolledAt: Date;
}

/**
 * أقصى عدد قوالب لكل موظف. تسجيل ثلاث بصمات من زوايا/إضاءات مختلفة يرفع
 * دقة المطابقة، والمطابقة تأخذ أقرب قالب من الثلاثة.
 */
export const FACE_SLOTS = 3;

/** يحوّل صفاً من `face_templates` إلى قالب مفكوك التشفير. */
function decodeRow(
  row: {
    id: number;
    slot: number;
    algorithm: string;
    encryptedTemplate: string;
    enrolledAt: Date;
  },
  employeeId: number,
): StoredTemplate {
  let vector: number[] | null = null;
  try {
    const parsed = JSON.parse(decryptString(row.encryptedTemplate)) as unknown;
    vector = parseDescriptor(parsed);
  } catch (error) {
    console.error(
      `[restaurant-hr] تعذّر فك تشفير قالب الوجه للموظف ${employeeId} (خانة ${row.slot}):`,
      error instanceof Error ? error.message : error,
    );
  }

  return {
    id: row.id,
    slot: row.slot,
    algorithm: row.algorithm,
    vector,
    enrolledAt: row.enrolledAt,
  };
}

/** يقرأ كل قوالب الموظف (حتى ثلاثة) مرتّبة بالخانة ويفك تشفيرها. */
export async function readTemplates(employeeId: number): Promise<StoredTemplate[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(faceTemplates)
    .where(eq(faceTemplates.employeeId, employeeId))
    .orderBy(asc(faceTemplates.slot))
    .limit(FACE_SLOTS);

  return rows.map((row) => decodeRow(row, employeeId));
}

/**
 * يقرأ أول قالب للموظف (أقل خانة). `vector: null` = تعذّر فك التشفير.
 * للمطابقة استخدم `readTemplates` حتى تُقارن كل الخانات.
 */
export async function readTemplate(
  employeeId: number,
): Promise<StoredTemplate | null> {
  const [first] = await readTemplates(employeeId);
  return first ?? null;
}

/**
 * يُنشئ أو يُحدّث قالب الموظف في خانة محدّدة (1..3) مشفَّراً AES-256-GCM.
 * لا تُخزَّن أي صورة إطلاقاً — المتجّه الرقمي فقط.
 */
export async function saveTemplate(
  employeeId: number,
  vector: number[],
  options: {
    enrolledByEmployeeId?: number | null;
    algorithm?: string;
    /** خانة القالب: 1 هي الأولى، وحتى `FACE_SLOTS` */
    slot?: number;
  } = {},
): Promise<void> {
  const db = getDb();
  const encryptedTemplate = encryptString(JSON.stringify(vector));
  const algorithm = options.algorithm ?? FACE_ALGORITHM;
  const slot = Math.min(Math.max(Math.round(options.slot ?? 1), 1), FACE_SLOTS);

  await db
    .insert(faceTemplates)
    .values({
      employeeId,
      slot,
      algorithm,
      dimensions: vector.length,
      encryptedTemplate,
      keyVersion: KEY_VERSION,
      enrolledByEmployeeId: options.enrolledByEmployeeId ?? employeeId,
    })
    .onConflictDoUpdate({
      target: [faceTemplates.employeeId, faceTemplates.slot],
      set: {
        algorithm,
        dimensions: vector.length,
        encryptedTemplate,
        keyVersion: KEY_VERSION,
        updatedAt: new Date(),
      },
    });
}

/**
 * هل بصمة الوجه مُفعّلة لهذا الموظف؟ (علامة الصح في شاشة الموظفين).
 * الموظف غير المُفعّل يسجّل حضوره دون أي تحقق بالوجه مهما كان الإعداد العام.
 */
export async function isFaceEnabled(employeeId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ faceEnabled: employees.faceEnabled })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return row?.faceEnabled ?? true;
}

export type FaceState =
  | "off" // مطابقة الوجه معطّلة
  | "enrolled" // أول قالب للموظف — تم تسجيله الآن
  | "matched" // طابق القالب المسجَّل
  | "mismatch" // لم يطابق
  | "missing" // الموظف مسجَّل لكن الجهاز لم يرسل قالباً
  | "required" // الوضع enforce والقالب مفقود
  | "invalid" // ما وصل ليس قالباً سليماً
  | "unreadable" // تعذّر فك تشفير القالب المسجَّل
  | "skipped"; // لا قالب مسجَّل ولا قالب مُرسل

export interface FaceOutcome {
  state: FaceState;
  distance: number | null;
  threshold: number;
  verified: boolean;
  /** هل يجب رفض العملية بسببه؟ */
  blocks: boolean;
  message: string;
}

/**
 * يقيّم قالب الوجه المُرسل مقابل القالب المسجَّل للموظف.
 *
 * الوضع `optional` (الافتراضي): أول قالب يصل يُسجَّل للموظف، وبعدها يصبح
 * التحقق إلزامياً؛ ومحاولة بدون قالب لموظف مسجَّل تُحفظ بحالة `flagged`
 * للمراجعة بدل رفضها (حتى لا تُمنع الوردية بسبب كاميرا معطّلة).
 */
export async function evaluateFace(options: {
  employeeId: number;
  rawDescriptor: unknown;
  descriptorProvided: boolean;
  actorEmployeeId?: number | null;
  /** حالة تفعيل البصمة للموظف إن كانت معروفة مسبقاً (توفيراً لاستعلام). */
  faceEnabled?: boolean;
}): Promise<FaceOutcome> {
  const mode = getFaceMatchMode();
  const threshold = getFaceMatchThreshold();
  const base = { distance: null, threshold, verified: false, blocks: false };

  if (mode === "off") {
    return { ...base, state: "off", message: "" };
  }

  // تعطيل البصمة لموظف بعينه يعلو على الإعداد العام
  const enabled = options.faceEnabled ?? (await isFaceEnabled(options.employeeId));
  if (!enabled) {
    return { ...base, state: "off", message: "" };
  }

  const descriptor = options.descriptorProvided
    ? parseDescriptor(options.rawDescriptor)
    : null;

  if (options.descriptorProvided && !descriptor) {
    return {
      ...base,
      state: "invalid",
      blocks: true,
      message: `قالب الوجه المُرسل غير صالح (المطلوب متجّه من ${FACE_DIMENSIONS} قيمة).`,
    };
  }

  const stored = await readTemplates(options.employeeId);
  const readable = stored.filter(
    (template): template is StoredTemplate & { vector: number[] } => template.vector !== null,
  );

  if (!descriptor) {
    if (stored.length === 0) {
      if (mode === "enforce") {
        return {
          ...base,
          state: "required",
          blocks: true,
          message: "التحقق بالوجه مطلوب. اسمح باستخدام الكاميرا ثم أعد المحاولة.",
        };
      }
      return { ...base, state: "skipped", message: "" };
    }

    if (mode === "enforce") {
      return {
        ...base,
        state: "required",
        blocks: true,
        message: "التحقق بالوجه مطلوب. اسمح باستخدام الكاميرا ثم أعد المحاولة.",
      };
    }

    return {
      ...base,
      state: "missing",
      message: "تم التسجيل دون تحقق من الوجه — بحاجة لمراجعة المسؤول.",
    };
  }

  if (stored.length === 0) {
    await saveTemplate(options.employeeId, descriptor, {
      enrolledByEmployeeId: options.actorEmployeeId ?? options.employeeId,
      slot: 1,
    });
    return {
      ...base,
      state: "enrolled",
      verified: true,
      message: "تم تسجيل قالب وجهك لأول مرة وسيُستخدم للتحقق في المرات القادمة.",
    };
  }

  if (readable.length === 0) {
    return {
      ...base,
      state: "unreadable",
      message:
        "تعذّر قراءة قالب الوجه المسجَّل (تغيّر مفتاح التشفير؟) — السجل بحاجة لمراجعة المسؤول.",
    };
  }

  // المطابقة تأخذ أقرب قالب من الخانات المسجَّلة (حتى ثلاث بصمات)
  const distance = Math.min(
    ...readable.map((template) => euclideanDistance(descriptor, template.vector)),
  );
  const rounded = Math.round(distance * 10_000) / 10_000;

  if (distance <= threshold) {
    return {
      ...base,
      state: "matched",
      distance: rounded,
      verified: true,
      message: "",
    };
  }

  return {
    ...base,
    state: "mismatch",
    distance: rounded,
    blocks: true,
    message:
      "لم يتطابق الوجه مع القالب المسجَّل لحسابك. أعد المحاولة في إضاءة أفضل، أو راجع الموارد البشرية لإعادة تسجيل القالب.",
  };
}
