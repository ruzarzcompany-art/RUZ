/**
 * محرّك الكشف الآلي للكاميرات.
 *
 * المسار الكامل لكل لقطة:
 *   1. الحصول على لقطة (Snapshot) من الكاميرا — إما بجهاز الربط داخل المطعم
 *      (agent) أو بالخادم مباشرة من رابط عام (pull).
 *   2. تحليلها بنموذج رؤية عبر Netlify AI Gateway حسب منطقة الكاميرا.
 *   3. تحويل النتائج إلى تنبيهات بالصيغة المعتمدة، مع منع التكرار، وحساب مدة
 *      انتظار العميل عبر اللقطات المتتالية، وكشف دخول المستودع خارج ساعات
 *      العمل، وكشف الكاميرا المغطاة أو المحرّكة أو المتوقفة.
 *
 * القواعد الإلزامية تبقى سارية: كل اشتباه «يحتاج مراجعة بشرية»، والثقة
 * المنخفضة تُحال للمراجعة، والنموذج لا يتعرّف على الوجوه ولا يحكم على أحد،
 * وأي لقطة تُظهر مكاناً خاصاً تُرفض ويُوقف الكشف على الكاميرا فوراً.
 */

import { createHash, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  attendanceLogs,
  branches,
  employees,
  surveillanceCameraChecks,
  surveillanceCameras,
  surveillanceFrames,
  surveillancePosEvents,
  surveillanceSettings,
  surveillanceWaste,
} from "../db/schema.js";
import { decryptString } from "./crypto.js";
import { sendMail } from "./mailer.js";
import {
  ALERT_TYPES,
  LABELS,
  createAlert,
  dayRange,
  defaultClipRef,
  settingsFor,
} from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone, wallPartsInZone } from "./time.js";

export const VISION_MODEL = "claude-haiku-5-5";
const MAX_IMAGE_BYTES = 4_500_000;
/** نافذة منع تكرار نفس التنبيه من نفس الكاميرا */
const DEDUP_WINDOW_MINUTES = 20;
/** عدد مرات الفشل المتتالية قبل اعتبار الكاميرا متوقفة */
const OFFLINE_AFTER_FAILURES = 2;

type CameraRow = typeof surveillanceCameras.$inferSelect;
type BranchRow = typeof branches.$inferSelect;

/* ── جلب اللقطة (Basic و Digest كما في Hikvision و Dahua) ──────────── */

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function parseDigest(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = header.replace(/^Digest\s+/i, "");
  for (const match of body.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return params;
}

function digestHeader(
  method: string,
  url: URL,
  username: string,
  password: string,
  challenge: Record<string, string>,
): string {
  const uri = url.pathname + url.search;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  const qop = (challenge.qop ?? "").split(",").map((q) => q.trim()).includes("auth") ? "auth" : "";
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    'algorithm="MD5"',
  ];
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(", ")}`;
}

export async function fetchSnapshot(
  rawUrl: string,
  username: string,
  password: string,
  timeoutMs = 10_000,
): Promise<{ data: Buffer; contentType: string }> {
  const url = new URL(rawUrl);
  const get = (headers: Record<string, string>) =>
    fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });

  const basic = username
    ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
    : {};
  let response = await get(basic);
  if (response.status === 401 && username) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (/^Digest/i.test(challenge)) {
      response = await get({
        Authorization: digestHeader("GET", url, username, password, parseDigest(challenge)),
      });
    }
  }
  if (!response.ok) throw new Error(`الكاميرا ردّت بالرمز ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  const data = Buffer.from(await response.arrayBuffer());
  if (!contentType.startsWith("image/")) throw new Error("الرابط لا يُرجع صورة");
  return { data, contentType };
}

/* ── التحليل بنموذج الرؤية ──────────────────────────────────────── */

/** الملاحظات التي يبحث عنها النموذج في كل منطقة. */
const ZONE_FINDINGS: Record<string, string[]> = {
  dining: ["customer_waiting_unserved", "staff_phone", "staff_gathering", "customer_dispute", "hygiene_violation"],
  entrance: ["customer_waiting_unserved", "customer_dispute", "staff_gathering"],
  kitchen: ["hygiene_violation", "staff_phone", "staff_gathering", "station_unattended", "food_waste"],
  cashier: ["drawer_open_unattended", "staff_phone", "station_unattended", "customer_waiting_unserved", "customer_dispute"],
  warehouse: ["person_in_storage", "goods_carried_out", "food_waste"],
  fridge: ["person_in_storage", "goods_carried_out", "food_waste"],
  back_door: ["person_in_storage", "goods_carried_out"],
  delivery: ["customer_waiting_unserved", "staff_gathering", "staff_phone"],
  outdoor: ["goods_carried_out", "customer_waiting_unserved"],
};

const FINDING_GUIDE: Record<string, string> = {
  customer_waiting_unserved:
    "customers visibly waiting (queue at counter, or seated table with no food/menu) with no staff member attending them",
  staff_phone: "an employee (in uniform / behind the counter / in the kitchen) using a mobile phone while on duty",
  staff_gathering: "three or more employees standing together chatting instead of working",
  customer_dispute: "a visible argument or heated confrontation involving a customer",
  hygiene_violation:
    "food handler without gloves while touching food, without hair cover/hairnet, not in uniform, or a visibly dirty station",
  station_unattended: "a work station (cash counter, grill, prep line) left with nobody at it during service",
  food_waste: "food being thrown into a bin, or large amounts of prepared food discarded / spoiled",
  drawer_open_unattended:
    "the cash drawer is open while no customer is being served at the counter, or open with nobody at the register",
  person_in_storage: "any person present inside the storage room / fridge / at the back door",
  goods_carried_out:
    "a person carrying boxes, bags, crates or stock items out of the storage area, back door or into a vehicle",
};

/** تحويل ملاحظة النموذج إلى نوع تنبيه في النظام. */
const FINDING_TO_ALERT: Record<string, string> = {
  staff_phone: "staff_phone",
  staff_gathering: "staff_gathering",
  customer_dispute: "customer_complaint",
  hygiene_violation: "hygiene",
  station_unattended: "station_left",
  food_waste: "waste_observed",
  drawer_open_unattended: "drawer_no_sale",
  goods_carried_out: "warehouse_exit",
};

export interface VisionFinding {
  type: string;
  confidence: "high" | "medium" | "low";
  description: string;
  people: string;
}

export interface VisionResult {
  cameraState: "ok" | "covered" | "dark" | "blurry" | "moved" | "private_area";
  cameraStateConfidence: "high" | "medium" | "low";
  cameraNote: string;
  peopleCount: number;
  summary: string;
  findings: VisionFinding[];
}

let anthropic: Anthropic | undefined;

export async function analyzeFrame(input: {
  image: Buffer;
  contentType: string;
  reference: { data: Buffer; contentType: string } | null;
  zone: string;
  location: string;
}): Promise<VisionResult> {
  anthropic ??= new Anthropic();
  const allowed = ZONE_FINDINGS[input.zone] ?? ZONE_FINDINGS.dining;
  const zoneLabel = LABELS.zones[input.zone as keyof typeof LABELS.zones] ?? input.zone;

  const content: Anthropic.Messages.ContentBlockParam[] = [];
  if (input.reference) {
    content.push(
      { type: "text", text: "REFERENCE image (the approved camera angle):" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: input.reference.contentType as "image/jpeg",
          data: input.reference.data.toString("base64"),
        },
      },
    );
  }
  content.push(
    { type: "text", text: "CURRENT frame to analyse:" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: input.contentType as "image/jpeg",
        data: input.image.toString("base64"),
      },
    },
    {
      type: "text",
      text: [
        `You are a restaurant CCTV monitoring assistant. This camera covers: ${zoneLabel}${input.location ? ` (${input.location})` : ""}.`,
        "",
        "1) Camera health: decide cameraState:",
        "   ok | covered (lens blocked/taped/obstructed) | dark (black or no picture) | blurry (unusable image)",
        input.reference
          ? "   | moved (the current view clearly shows a different angle/area than the REFERENCE image)"
          : "",
        "   | private_area (the frame shows a toilet/restroom, changing/locker room, prayer area or private rest area — if so, report NOTHING else).",
        "",
        "2) Report ONLY these findings when clearly visible in the CURRENT frame:",
        ...allowed.map((key) => `   - ${key}: ${FINDING_GUIDE[key]}`),
        "",
        "Rules:",
        "- Do not guess. If you are unsure, either omit the finding or set confidence to low.",
        "- Never identify people by face or name. Describe people only by appearance (uniform colour, position, apron, cap).",
        "- Do not report anything that is normal restaurant activity.",
        "- Write description, people, cameraNote and summary in short Arabic.",
        "Call the report_frame tool with your result.",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  );

  const message = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 900,
    tools: [
      {
        name: "report_frame",
        description: "Report the analysis of one CCTV frame.",
        input_schema: {
          type: "object",
          properties: {
            cameraState: {
              type: "string",
              enum: ["ok", "covered", "dark", "blurry", "moved", "private_area"],
            },
            cameraStateConfidence: { type: "string", enum: ["high", "medium", "low"] },
            cameraNote: { type: "string" },
            peopleCount: { type: "integer" },
            summary: { type: "string" },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: allowed },
                  confidence: { type: "string", enum: ["high", "medium", "low"] },
                  description: { type: "string" },
                  people: { type: "string" },
                },
                required: ["type", "confidence", "description"],
              },
            },
          },
          required: ["cameraState", "cameraStateConfidence", "peopleCount", "findings"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "report_frame" },
    messages: [{ role: "user", content }],
  });

  const block = message.content.find((item) => item.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("لم يُرجع نموذج التحليل نتيجة");
  const raw = block.input as Partial<VisionResult>;
  const states = ["ok", "covered", "dark", "blurry", "moved", "private_area"];
  const levels = ["high", "medium", "low"];
  return {
    cameraState: (states.includes(String(raw.cameraState)) ? raw.cameraState : "ok") as VisionResult["cameraState"],
    cameraStateConfidence: (levels.includes(String(raw.cameraStateConfidence))
      ? raw.cameraStateConfidence
      : "medium") as VisionFinding["confidence"],
    cameraNote: String(raw.cameraNote ?? "").slice(0, 300),
    peopleCount: Math.max(0, Math.round(Number(raw.peopleCount) || 0)),
    summary: String(raw.summary ?? "").slice(0, 500),
    findings: (Array.isArray(raw.findings) ? raw.findings : [])
      .filter((f) => allowed.includes(String(f?.type)))
      .slice(0, 8)
      .map((f) => ({
        type: String(f.type),
        confidence: (levels.includes(String(f.confidence)) ? f.confidence : "low") as VisionFinding["confidence"],
        description: String(f.description ?? "").slice(0, 500),
        people: String(f.people ?? "").slice(0, 300),
      })),
  };
}

/* ── التخزين ─────────────────────────────────────────────────────── */

function frameStore() {
  return getStore("surveillance-frames");
}

async function saveImage(key: string, data: Buffer, contentType: string): Promise<void> {
  const store = frameStore();
  await store.set(key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  await store.set(`${key}.type`, contentType);
}

export async function loadImage(key: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!key) return null;
  const store = frameStore();
  const buffer = await store.get(key, { type: "arrayBuffer" });
  if (!buffer) return null;
  const contentType = ((await store.get(`${key}.type`, { type: "text" })) as string | null) ?? "image/jpeg";
  return { data: Buffer.from(buffer as ArrayBuffer), contentType };
}

/* ── أدوات الوقت والسياق ─────────────────────────────────────────── */

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** هل اللحظة خارج ساعات عمل الفرع؟ (يدعم الإغلاق بعد منتصف الليل) */
export function isOffHours(at: Date, timeZone: string, openTime: string, closeTime: string): boolean {
  const p = wallPartsInZone(at, safeTimeZone(timeZone));
  const now = p.hour * 60 + p.minute;
  const open = minutesOf(openTime);
  const close = minutesOf(closeTime);
  if (open === close) return false;
  if (open < close) return now < open || now >= close;
  return now >= close && now < open;
}

/** الموظفون على رأس العمل في الفرع لحظة اللقطة (من سجل الحضور). */
async function onShiftEmployees(branchId: number, at: Date) {
  const db = getDb();
  const since = new Date(at.getTime() - 20 * 3600_000);
  const logs = await db
    .select({
      employeeId: attendanceLogs.employeeId,
      type: attendanceLogs.type,
      name: employees.fullName,
      jobTitle: employees.jobTitle,
      department: employees.department,
    })
    .from(attendanceLogs)
    .innerJoin(employees, eq(employees.id, attendanceLogs.employeeId))
    .where(
      and(
        eq(attendanceLogs.branchId, branchId),
        gte(attendanceLogs.serverTime, since),
        lt(attendanceLogs.serverTime, at),
        sql`${attendanceLogs.status} in ('approved','flagged')`,
      ),
    )
    .orderBy(asc(attendanceLogs.serverTime));
  const state = new Map<number, { in: boolean; name: string; jobTitle: string; department: string }>();
  for (const log of logs) {
    state.set(log.employeeId, {
      in: log.type === "check_in",
      name: log.name,
      jobTitle: log.jobTitle,
      department: log.department,
    });
  }
  return [...state.entries()].filter(([, s]) => s.in).map(([id, s]) => ({ id, ...s }));
}

/** مرشّحو التعرف: من هم على رأس العمل ويطابق قسمهم أو مسماهم منطقة الكاميرا. */
function zoneCandidates(
  zone: string,
  staff: Awaited<ReturnType<typeof onShiftEmployees>>,
): typeof staff {
  const keys: Record<string, string[]> = {
    kitchen: ["مطبخ", "طباخ", "شيف", "تحضير", "kitchen", "chef", "cook"],
    cashier: ["كاشير", "صندوق", "cashier"],
    dining: ["صالة", "ويتر", "خدمة", "مضيف", "waiter", "service"],
    warehouse: ["مستودع", "مخزن", "مخزون", "store", "warehouse"],
    fridge: ["مستودع", "مخزن", "مطبخ", "store", "kitchen"],
    back_door: ["مستودع", "مخزن", "store"],
  };
  const words = keys[zone];
  if (!words) return [];
  return staff.filter((s) => {
    const text = `${s.jobTitle} ${s.department}`.toLowerCase();
    return words.some((w) => text.includes(w));
  });
}

async function notifyUrgent(emails: string, subject: string, text: string) {
  const recipients = emails
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
  for (const to of recipients) {
    await sendMail({ to, subject, text }).catch(() => undefined);
  }
}

/* ── معالجة لقطة واحدة ──────────────────────────────────────────── */

const CAMERA_STATUS_OF: Record<string, string> = {
  ok: "online",
  covered: "covered",
  dark: "covered",
  blurry: "covered",
  moved: "moved",
  unreachable: "offline",
};

export interface ProcessResult {
  frameId: number | null;
  cameraState: string;
  findings: number;
  alerts: number[];
  summary?: string;
  error?: string;
}

async function recordStatusChange(camera: CameraRow, status: string, isRecording: boolean, note: string, at: Date) {
  if (camera.status === status && camera.isRecording === isRecording) return;
  const db = getDb();
  await db.insert(surveillanceCameraChecks).values({
    cameraId: camera.id,
    status,
    isRecording,
    note: note.slice(0, 500),
    source: "auto",
    checkedAt: at,
  });
}

/**
 * يعالج لقطة وصلت (أو فشل الحصول عليها) لكاميرا واحدة، ويُنشئ التنبيهات.
 */
export async function processFrame(input: {
  camera: CameraRow;
  branch: BranchRow;
  image: { data: Buffer; contentType: string } | null;
  error?: string;
  source: "agent" | "pull" | "test";
  capturedAt?: Date;
}): Promise<ProcessResult> {
  const db = getDb();
  const { camera, branch } = input;
  const at = input.capturedAt ?? new Date();
  const settings = await settingsFor(branch.id);
  const tz = safeTimeZone(branch.timezone);
  const alerts: number[] = [];
  const clip = (frameId: number) =>
    `${defaultClipRef(camera.cameraNumber, at, tz)} | لقطة #${frameId}`;

  const raise = async (
    alertType: string,
    data: {
      confidence: string;
      details: string;
      peopleNote?: string;
      employeeIds?: number[];
      frameId: number;
      refSuffix?: string;
    },
  ) => {
    const bucket = Math.floor(at.getTime() / (DEDUP_WINDOW_MINUTES * 60_000));
    const result = await createAlert({
      branchId: branch.id,
      alertType,
      cameraId: camera.id,
      occurredAt: at,
      confidence: data.confidence,
      employeeIds: data.employeeIds ?? [],
      peopleNote: data.peopleNote ?? "",
      clipRef: clip(data.frameId),
      details: data.details,
      source: "auto",
      sourceRef: `vision:${camera.id}:${alertType}:${data.refSuffix ?? bucket}`,
    });
    if (!result.duplicate) {
      alerts.push(result.id);
      const spec = ALERT_TYPES[alertType];
      if (spec?.urgent && settings.alertEmails) {
        await notifyUrgent(
          settings.alertEmails,
          `تنبيه فوري — ${spec.label} — ${branch.name}`,
          [
            `نوع الحالة: ${spec.label}`,
            `الموقع والكاميرا: ${camera.cameraNumber}${camera.name ? ` — ${camera.name}` : ""}`,
            `الوقت: ${defaultClipRef(camera.cameraNumber, at, tz)}`,
            `الظاهرون: ${data.peopleNote || "غير محدد"}`,
            `درجة الثقة: ${LABELS.confidence[data.confidence as "high"] ?? data.confidence}`,
            `التفاصيل: ${data.details}`,
            `الإجراء المقترح: ${spec.action}`,
            spec.suspicion ? "تنبيه: هذا اشتباه يحتاج مراجعة المقطع وليس حكماً نهائياً." : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
  };

  /* ── تعذّر الحصول على لقطة ── */
  if (!input.image) {
    const failures = camera.consecutiveFailures + 1;
    const error = (input.error || "تعذّر الحصول على لقطة").slice(0, 300);
    const [frame] = await db
      .insert(surveillanceFrames)
      .values({ branchId: branch.id, cameraId: camera.id, capturedAt: at, source: input.source, cameraState: "unreachable", error })
      .returning({ id: surveillanceFrames.id });
    const offline = failures >= OFFLINE_AFTER_FAILURES;
    if (offline) {
      await recordStatusChange(camera, "offline", false, error, at);
      await raise("camera_down", {
        confidence: "high",
        details: `الكاميرا ${camera.cameraNumber} لا تستجيب (${failures} محاولات متتالية): ${error}`,
        frameId: frame.id,
        refSuffix: `offline:${camera.lastFrameAt?.getTime() ?? 0}`,
      });
    }
    await db
      .update(surveillanceCameras)
      .set({
        consecutiveFailures: failures,
        lastError: error,
        lastAnalysisAt: at,
        ...(offline ? { status: "offline", isRecording: false, lastCheckedAt: at } : {}),
        updatedAt: new Date(),
      })
      .where(eq(surveillanceCameras.id, camera.id));
    if (alerts.length) {
      await db.update(surveillanceFrames).set({ alertIds: alerts }).where(eq(surveillanceFrames.id, frame.id));
    }
    return { frameId: frame.id, cameraState: "unreachable", findings: 0, alerts, error };
  }

  if (input.image.data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("حجم اللقطة أكبر من المسموح (4.5MB) — استخدم البث الفرعي للكاميرا");
  }

  /* ── التحليل ── */
  const reference = camera.referenceKey ? await loadImage(camera.referenceKey).catch(() => null) : null;
  let result: VisionResult;
  try {
    result = await analyzeFrame({
      image: input.image.data,
      contentType: input.image.contentType,
      reference,
      zone: camera.zone,
      location: camera.location,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(surveillanceFrames).values({
      branchId: branch.id,
      cameraId: camera.id,
      capturedAt: at,
      source: input.source,
      cameraState: "error",
      error: `فشل التحليل: ${message}`.slice(0, 300),
    });
    await db
      .update(surveillanceCameras)
      .set({ lastFrameAt: at, lastError: `فشل التحليل: ${message}`.slice(0, 300), consecutiveFailures: 0, updatedAt: new Date() })
      .where(eq(surveillanceCameras.id, camera.id));
    return { frameId: null, cameraState: "error", findings: 0, alerts, error: message };
  }

  /* ── مكان خاص: لا حفظ ولا تحليل، ويُوقف الكشف فوراً ── */
  if (result.cameraState === "private_area") {
    await db
      .update(surveillanceCameras)
      .set({ autoDetect: false, lastFrameAt: at, lastAnalysisAt: at, lastError: "أُوقف الكشف: اللقطة تُظهر مكاناً خاصاً", updatedAt: new Date() })
      .where(eq(surveillanceCameras.id, camera.id));
    const [frame] = await db
      .insert(surveillanceFrames)
      .values({ branchId: branch.id, cameraId: camera.id, capturedAt: at, source: input.source, cameraState: "private_area", error: "مكان خاص — لم تُحفظ الصورة" })
      .returning({ id: surveillanceFrames.id });
    await raise("other", {
      confidence: "medium",
      details: `أُوقف الكشف الآلي على الكاميرا ${camera.cameraNumber} لأن اللقطة تبدو لمكان خاص يُمنع رصده. لم تُحفظ الصورة، ويجب تعديل زاوية الكاميرا أو إزالتها.`,
      frameId: frame.id,
      refSuffix: "private",
    });
    return { frameId: frame.id, cameraState: "private_area", findings: 0, alerts };
  }

  const waitingFinding = result.findings.find((f) => f.type === "customer_waiting_unserved");
  const cameraProblem = result.cameraState !== "ok";
  const keepImage = cameraProblem || result.findings.length > 0 || !camera.referenceKey;

  const [frame] = await db
    .insert(surveillanceFrames)
    .values({
      branchId: branch.id,
      cameraId: camera.id,
      capturedAt: at,
      source: input.source,
      cameraState: result.cameraState,
      peopleCount: result.peopleCount,
      waiting: Boolean(waitingFinding),
      findingsCount: result.findings.length,
      analysisJson: JSON.stringify(result),
    })
    .returning({ id: surveillanceFrames.id });

  // آخر لقطة لكل كاميرا تُحفظ دائماً (تُستبدل كل مرة) لتُعرض من أي مكان
  await saveImage(latestImageKey(camera.id), input.image.data, input.image.contentType).catch(() => undefined);

  let imageKey = "";
  if (keepImage) {
    imageKey = `frames/${branch.id}/${camera.id}/${frame.id}`;
    await saveImage(imageKey, input.image.data, input.image.contentType);
  }

  /* ── حالة الكاميرا ── */
  const status = CAMERA_STATUS_OF[result.cameraState] ?? "online";
  await recordStatusChange(camera, status, status === "online", result.cameraNote, at);
  // الخلل يُنبَّه عنه مرة واحدة عند بدايته، لا مع كل لقطة ما دام مستمراً
  if (cameraProblem && camera.status !== status) {
    await raise(result.cameraState === "moved" ? "camera_moved" : "camera_down", {
      confidence: result.cameraStateConfidence,
      details: `الكاميرا ${camera.cameraNumber}: ${
        { covered: "مغطاة أو محجوبة", dark: "الصورة سوداء", blurry: "الصورة غير واضحة", moved: "تم تحريكها عن زاويتها المعتمدة" }[
          result.cameraState as "covered"
        ] ?? result.cameraState
      }${result.cameraNote ? ` — ${result.cameraNote}` : ""}`,
      frameId: frame.id,
      refSuffix: `${result.cameraState}:${frame.id}`,
    });
  }

  /* ── الملاحظات ── */
  const staff = result.findings.length ? await onShiftEmployees(branch.id, at) : [];
  const candidates = zoneCandidates(camera.zone, staff);
  // من يُنسب إليهم التنبيه للمراجعة: المطابقون لمنطقة الكاميرا، وإلا كل من
  // على رأس العمل في الفرع. نسبة للمراجعة فقط — ليست تعرّفاً على الوجه.
  const attributed = candidates.length ? candidates : staff;
  const attributedIds = attributed.map((c) => c.id);
  const candidateNote = candidates.length
    ? ` | على رأس العمل في هذه المنطقة: ${candidates.map((c) => c.name).join("، ")} (للتحقق من المقطع)`
    : staff.length
      ? ` | على رأس العمل في الفرع وقتها: ${staff.map((c) => c.name).join("، ")} (للتحقق من المقطع)`
      : "";

  for (const finding of result.findings) {
    const peopleNote = `${finding.people}${candidateNote}`.slice(0, 500);
    if (finding.type === "customer_waiting_unserved") continue; // يُحسب عبر اللقطات أدناه

    if (finding.type === "person_in_storage") {
      if (isOffHours(at, tz, settings.openTime, settings.closeTime)) {
        await raise("warehouse_off_hours", {
          confidence: finding.confidence,
          details: `خارج ساعات العمل (${settings.openTime}–${settings.closeTime}): ${finding.description}`,
          peopleNote,
          employeeIds: attributedIds,
          frameId: frame.id,
        });
      }
      continue;
    }

    const alertType = FINDING_TO_ALERT[finding.type];
    if (!alertType) continue;
    const extra =
      alertType === "drawer_no_sale"
        ? " — يلزم مطابقة الوقت مع عمليات فودكس قبل أي حكم."
        : "";
    await raise(alertType, {
      // فتح الدرج من الصورة وحدها لا يثبت غياب البيع: لا تُرفع الثقة فوق «متوسطة»
      confidence: alertType === "drawer_no_sale" && finding.confidence === "high" ? "medium" : finding.confidence,
      details: `${finding.description}${extra}`,
      peopleNote,
      employeeIds: attributedIds,
      frameId: frame.id,
    });

    // الدرج المفتوح يُسجَّل أيضاً في «الطلبات والكاشير» لمطابقته مع فودكس
    if (alertType === "drawer_no_sale") {
      const cashier = candidates.length === 1 ? candidates[0] : null;
      await db.insert(surveillancePosEvents).values({
        branchId: branch.id,
        eventType: "drawer_no_sale",
        occurredAt: at,
        cashierEmployeeId: cashier?.id ?? null,
        cashierName: cashier?.name ?? candidates.map((c) => c.name).join("، ").slice(0, 150),
        cameraId: camera.id,
        source: "auto",
        notes: `كشف آلي — لقطة #${frame.id} — ${finding.description}`.slice(0, 500),
      });
    }

    if (alertType === "waste_observed") {
      await db.insert(surveillanceWaste).values({
        branchId: branch.id,
        occurredAt: at,
        itemName: finding.description.slice(0, 150) || "هدر مرصود",
        quantity: 1,
        unit: "مشاهدة",
        reason: "other",
        station: [LABELS.zones[camera.zone as "kitchen"] ?? camera.zone, camera.location].filter(Boolean).join(" — "),
        cameraId: camera.id,
        employeeId: candidates.length === 1 ? candidates[0].id : null,
        notes: `كشف آلي — لقطة #${frame.id}`,
      });
    }
  }

  /* ── انتظار العميل عبر اللقطات المتتالية ── */
  if (waitingFinding) {
    const windowStart = new Date(at.getTime() - (settings.customerWaitMinutes + 3 * camera.intervalMinutes) * 60_000);
    const recent = await db
      .select({ id: surveillanceFrames.id, capturedAt: surveillanceFrames.capturedAt, waiting: surveillanceFrames.waiting, state: surveillanceFrames.cameraState })
      .from(surveillanceFrames)
      .where(and(eq(surveillanceFrames.cameraId, camera.id), gte(surveillanceFrames.capturedAt, windowStart)))
      .orderBy(desc(surveillanceFrames.capturedAt));
    let streakStart = recent[0];
    for (const item of recent) {
      if (item.state === "unreachable" || item.state === "error") continue;
      if (!item.waiting) break;
      streakStart = item;
    }
    const waitedMinutes = (at.getTime() - streakStart.capturedAt.getTime()) / 60_000;
    if (waitedMinutes >= settings.customerWaitMinutes) {
      await raise("customer_wait", {
        confidence: waitingFinding.confidence,
        details: `${waitingFinding.description} — مستمر منذ ${Math.round(waitedMinutes)} دقيقة تقريباً (الحد ${settings.customerWaitMinutes}).`,
        peopleNote: `${waitingFinding.people}${candidateNote}`.slice(0, 500),
        employeeIds: attributedIds,
        frameId: frame.id,
        refSuffix: `streak:${streakStart.id}`,
      });
    }
  }

  await db
    .update(surveillanceFrames)
    .set({ imageKey, alertIds: alerts })
    .where(eq(surveillanceFrames.id, frame.id));

  await db
    .update(surveillanceCameras)
    .set({
      status,
      isRecording: status === "online",
      lastCheckedAt: at,
      lastFrameAt: at,
      lastAnalysisAt: at,
      consecutiveFailures: 0,
      lastError: "",
      // أول لقطة سليمة تصبح الزاوية المعتمدة تلقائياً
      ...(!camera.referenceKey && !cameraProblem && imageKey ? { referenceKey: imageKey } : {}),
      updatedAt: new Date(),
    })
    .where(eq(surveillanceCameras.id, camera.id));

  return {
    frameId: frame.id,
    cameraState: result.cameraState,
    findings: result.findings.length,
    alerts,
    summary: result.summary,
  };
}

/* ── الجدولة ─────────────────────────────────────────────────────── */

function isDue(camera: CameraRow, now: Date): boolean {
  if (!camera.lastAnalysisAt) return true;
  return now.getTime() - camera.lastAnalysisAt.getTime() >= camera.intervalMinutes * 60_000 - 20_000;
}

export function cameraPassword(camera: CameraRow): string {
  if (!camera.snapshotPasswordEnc) return "";
  try {
    return decryptString(camera.snapshotPasswordEnc);
  } catch {
    return "";
  }
}

async function activeAutoCameras(mode?: string) {
  const db = getDb();
  const filters = [eq(surveillanceCameras.isActive, true), eq(surveillanceCameras.autoDetect, true)];
  if (mode) filters.push(eq(surveillanceCameras.connectionMode, mode));
  return db
    .select({ camera: surveillanceCameras, branch: branches })
    .from(surveillanceCameras)
    .innerJoin(branches, eq(branches.id, surveillanceCameras.branchId))
    .where(and(...filters));
}

export function latestImageKey(cameraId: number): string {
  return `latest/${cameraId}`;
}

/** مناطق تبقى مراقبة خارج ساعات العمل: الدخول خارج الدوام هو ما تُراقب لأجله. */
const ALWAYS_WATCHED_ZONES = new Set(["warehouse", "back_door", "fridge"]);

type CameraWithBranch = Awaited<ReturnType<typeof activeAutoCameras>>[number];

/** عدد اللقطات المحلَّلة فعلاً اليوم للفرع (بتوقيت الفرع). */
async function analysedToday(branchId: number, timeZone: string, now: Date): Promise<number> {
  const db = getDb();
  const { start, end } = dayRange(isoDateInZone(now, safeTimeZone(timeZone)), timeZone);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(surveillanceFrames)
    .where(
      and(
        eq(surveillanceFrames.branchId, branchId),
        gte(surveillanceFrames.capturedAt, start),
        lt(surveillanceFrames.capturedAt, end),
        sql`${surveillanceFrames.cameraState} not in ('unreachable','error')`,
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * ضوابط التكلفة: يستبعد الكاميرات خارج ساعات التحليل (إن فُعّلت) وما يتجاوز
 * الحد اليومي للفرع، ويُشعر مرة واحدة في اليوم عند بلوغ الحد.
 * يُرجع المسموح تحليله الآن، ومعرّفات المستبعدة بالسياسة (لا تُعدّ متوقفة).
 */
async function applyCostControls(rows: CameraWithBranch[], now: Date) {
  const branchState = new Map<
    number,
    { settings: Awaited<ReturnType<typeof settingsFor>>; used: number; capped: boolean; branch: CameraWithBranch["branch"] }
  >();
  const allowed: CameraWithBranch[] = [];
  const skipped = new Set<number>();
  for (const row of rows) {
    let state = branchState.get(row.branch.id);
    if (!state) {
      const settings = await settingsFor(row.branch.id);
      const used = settings.dailyAnalysisCap > 0 ? await analysedToday(row.branch.id, row.branch.timezone, now) : 0;
      state = { settings, used, capped: false, branch: row.branch };
      branchState.set(row.branch.id, state);
    }
    const { settings } = state;
    if (
      settings.analyzeOpenHoursOnly &&
      !ALWAYS_WATCHED_ZONES.has(row.camera.zone) &&
      isOffHours(now, row.branch.timezone, settings.openTime, settings.closeTime)
    ) {
      skipped.add(row.camera.id);
      continue;
    }
    if (settings.dailyAnalysisCap > 0 && state.used >= settings.dailyAnalysisCap) {
      state.capped = true;
      skipped.add(row.camera.id);
      continue;
    }
    state.used += 1;
    allowed.push(row);
  }
  for (const state of branchState.values()) {
    if (state.capped) await notifyCapReached(state.branch, state.settings, now).catch(() => undefined);
  }
  return { allowed, skipped };
}

async function notifyCapReached(
  branch: CameraWithBranch["branch"],
  settings: Awaited<ReturnType<typeof settingsFor>>,
  now: Date,
) {
  const today = isoDateInZone(now, safeTimeZone(branch.timezone));
  if (settings.capNotifiedDate === today) return;
  const db = getDb();
  await db
    .update(surveillanceSettings)
    .set({ capNotifiedDate: today })
    .where(eq(surveillanceSettings.branchId, branch.id));
  const text = `بلغ الفرع ${branch.name} الحد اليومي للتحليل الآلي (${settings.dailyAnalysisCap} لقطة)، فأُوقف التحليل حتى بداية اليوم التالي للتحكم في التكلفة. التسجيل في جهاز التسجيل مستمر. يمكن رفع الحد من «الحدود المعتمدة».`;
  await createAlert({
    branchId: branch.id,
    alertType: "other",
    occurredAt: now,
    confidence: "high",
    details: text,
    source: "auto",
    sourceRef: `cap:${branch.id}:${today}`,
  }).catch(() => undefined);
  if (settings.alertEmails) await notifyUrgent(settings.alertEmails, `الحد اليومي للتحليل — ${branch.name}`, text);
}

/**
 * آخر لحظة عاد فيها التحليل بعد توقف مقصود (بداية ساعات التحليل أو بداية
 * اليوم بعد الحد اليومي)، حتى لا تُعدّ الكاميرا متوقفة قبل أن يلحقها جهاز الربط.
 */
async function resumedAt(camera: CameraWithBranch["camera"], branch: CameraWithBranch["branch"], now: Date): Promise<Date | null> {
  const settings = await settingsFor(branch.id);
  const tz = safeTimeZone(branch.timezone);
  const dayStart = dayRange(isoDateInZone(now, tz), branch.timezone).start;
  let resumed: Date | null = settings.dailyAnalysisCap > 0 ? dayStart : null;
  if (settings.analyzeOpenHoursOnly && !ALWAYS_WATCHED_ZONES.has(camera.zone)) {
    let open = new Date(dayStart.getTime() + minutesOf(settings.openTime) * 60_000);
    if (open > now) open = new Date(open.getTime() - 24 * 3600_000);
    if (!resumed || open > resumed) resumed = open;
  }
  return resumed;
}

/** الكاميرات المستحقة لجهاز الربط (مع بيانات الدخول المحلية). */
export async function agentJobs(branchCode: string | null) {
  const now = new Date();
  const rows = (await activeAutoCameras("agent")).filter(
    (row) => (!branchCode || row.branch.code === branchCode) && row.camera.snapshotUrl && isDue(row.camera, now),
  );
  const { allowed } = await applyCostControls(rows, now);
  return allowed
    .map((row) => ({
      cameraId: row.camera.id,
      cameraNumber: row.camera.cameraNumber,
      branchCode: row.branch.code,
      snapshotUrl: row.camera.snapshotUrl,
      username: row.camera.snapshotUsername,
      password: cameraPassword(row.camera),
    }));
}

/**
 * تشغيل دوري: يجلب لقطات الكاميرات العامة (pull) المستحقة ويحلّلها، ويكشف
 * الكاميرات التي انقطعت لقطاتها (جهاز ربط متوقف أو كاميرا مفصولة).
 */
export async function runScheduledScan(budgetMs = 24_000): Promise<{ analysed: number; stale: number }> {
  const started = Date.now();
  const now = new Date();
  const rows = await activeAutoCameras();
  let analysed = 0;
  let stale = 0;

  const pullCandidates = rows.filter((r) => r.camera.connectionMode === "pull" && r.camera.snapshotUrl && isDue(r.camera, now));
  const { allowed: pullDue } = await applyCostControls(pullCandidates, now);
  const policy = await applyCostControls(
    rows.filter((r) => r.camera.connectionMode === "agent"),
    now,
  );
  const queue = [...pullDue];
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const { camera, branch } = queue.shift()!;
      try {
        const image = await fetchSnapshot(camera.snapshotUrl, camera.snapshotUsername, cameraPassword(camera), 8_000);
        await processFrame({ camera, branch, image, source: "pull" });
      } catch (error) {
        await processFrame({
          camera,
          branch,
          image: null,
          error: error instanceof Error ? error.message : String(error),
          source: "pull",
        }).catch(() => undefined);
      }
      analysed += 1;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // كاميرات جهاز الربط التي لم تصل لقطاتها منذ مدة طويلة
  for (const { camera, branch } of rows.filter((r) => r.camera.connectionMode === "agent")) {
    // المستبعدة عمداً (خارج ساعات التحليل أو بعد الحد اليومي) ليست متوقفة
    if (policy.skipped.has(camera.id)) continue;
    const limit = Math.max(15, camera.intervalMinutes * 3) * 60_000;
    const resumed = await resumedAt(camera, branch, now);
    const lastSeen = camera.lastAnalysisAt ?? camera.updatedAt;
    const last = resumed && resumed > lastSeen ? resumed : lastSeen;
    if (now.getTime() - last.getTime() < limit) continue;
    stale += 1;
    await processFrame({
      camera,
      branch,
      image: null,
      error: "لم تصل لقطات من جهاز الربط — تأكد أن جهاز الربط يعمل وأن الكاميرا متصلة",
      source: "agent",
    }).catch(() => undefined);
  }
  return { analysed, stale };
}

