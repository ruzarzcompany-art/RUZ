/**
 * النوم الليلي: إبقاء قاعدة البيانات نائمة خارج ساعات عمل المطعم.
 *
 * قاعدة البيانات تُحاسَب على كل ساعة تبقى فيها مستيقظة، وتنام بعد 5 دقائق بلا
 * اتصال. جهاز التحليل في المطعم يتصل كل بضع ثوانٍ (نبضة، إعدادات، واتساب،
 * لقطات معاينة) والمهام المجدولة تعمل كل دقيقة، فلا تنام القاعدة أبداً.
 *
 * خارج ساعات العمل (بين وقت الإغلاق ووقت الفتح في «الحدود المعتمدة») يُجاب عن
 * هذه الاتصالات الروتينية من مخزن Netlify Blobs دون لمس القاعدة، وتتوقف المهام
 * المجدولة. تستيقظ القاعدة فقط عند:
 *   • حدث فعلي من الجهاز (دخول منطقة ممنوعة، طاولة…) أو أي عملية من مستخدم
 *   • موعد الإقفال الآلي (4 فجراً) وموعد التقرير الليلي
 *   • انقطاع نبض جهاز التحليل أكثر من 5 دقائق (فُصل عن الكهرباء أو الشبكة)
 *   • وجود تنبيه لم يُؤكَّد استلامه بعد (يستمر التصعيد حتى ينتهي)
 *
 * هذا الملف لا يستورد قاعدة البيانات عمداً. أي خطأ في المخزن يعيد النظام إلى
 * سلوكه العادي (القاعدة مستيقظة) — لا يُسكَت تنبيه بسبب عطل هنا.
 * للإيقاف الكامل: NIGHT_SLEEP=off في إعدادات Netlify.
 */

import { timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import type { NextFunction, Request, Response } from "express";
import { env, getAutoCloseHour } from "./config.js";
import { safeTimeZone, wallPartsInZone } from "./time.js";

/* ── الثوابت ─────────────────────────────────────────────────── */

/** مدة البقاء مستيقظاً بعد أي حدث فعلي. */
export const AWAKE_HOLD_MS = 10 * 60_000;
/** نافذة الاستيقاظ عند موعد مجدول (الإقفال الآلي، التقرير الليلي). */
export const WAKE_SLOT_MINUTES = 20;
/** يطابق مهلة انقطاع جهاز التحليل في edge.ts. */
export const EDGE_SILENT_MS = 5 * 60_000;
/** ساعة تقفيل اليوم في dayClose.ts. */
const DAY_CLOSE_HOUR = 4;
const MAX_IMAGE_BYTES = 1_500_000;
const CONFIG_TTL_MS = 5 * 60_000;
const AWAKE_TTL_MS = 10_000;
const STORE = "night-sleep";

/* ── الأنواع ─────────────────────────────────────────────────── */

export interface QuietBranch {
  id: number;
  code: string;
  timezone: string;
  openTime: string;
  closeTime: string;
  briefTime: string;
  /** ردّ ‎/control/edge/config‎ كما هو، ليُعاد للجهاز دون قاعدة البيانات. */
  edgeConfig: unknown;
  /** رقم الكاميرا ← معرّفها ومفتاح آخر لقطة لها في مخزن اللقطات. */
  cameras: Record<string, { id: number; latestKey: string }>;
}

export interface QuietConfig {
  version: 1;
  savedAt: number;
  branches: QuietBranch[];
}

export interface EdgeBeat {
  seenAt: number;
  status?: unknown;
}

export interface WaBeat {
  seenAt: number;
  state: string;
}

/* ── منطق الوقت (بلا أي اتصال — قابل للاختبار) ───────────────── */

export function minutesOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total < 24 * 60 ? total : null;
}

/** خارج ساعات العمل؟ يدعم الإغلاق بعد منتصف الليل (مثل 09:00 ← 01:30). */
export function offHours(nowMinutes: number, openTime: string, closeTime: string): boolean {
  const open = minutesOfDay(openTime);
  const close = minutesOfDay(closeTime);
  if (open === null || close === null || open === close) return false;
  if (open < close) return nowMinutes < open || nowMinutes >= close;
  return nowMinutes >= close && nowMinutes < open;
}

function inSlot(nowMinutes: number, start: number): boolean {
  const diff = (nowMinutes - start + 24 * 60) % (24 * 60);
  return diff < WAKE_SLOT_MINUTES;
}

/** مواعيد يجب أن تعمل فيها المهام المجدولة حتى لو كان المطعم مغلقاً. */
export function inWakeSlot(nowMinutes: number, briefTime: string, autoCloseHours: number[]): boolean {
  const starts = autoCloseHours.map((hour) => hour * 60);
  const brief = minutesOfDay(briefTime);
  if (brief !== null) starts.push(brief);
  return starts.some((start) => inSlot(nowMinutes, start));
}

/** هل الفرع الآن في وقت النوم؟ (خارج الدوام وليس في موعد مجدول) */
export function branchQuietAt(
  now: Date,
  branch: Pick<QuietBranch, "timezone" | "openTime" | "closeTime" | "briefTime">,
  autoCloseHours: number[] = [DAY_CLOSE_HOUR, getAutoCloseHour()],
): boolean {
  const parts = wallPartsInZone(now, safeTimeZone(branch.timezone));
  const minutes = parts.hour * 60 + parts.minute;
  if (!offHours(minutes, branch.openTime, branch.closeTime)) return false;
  return !inWakeSlot(minutes, branch.briefTime, autoCloseHours);
}

/** النوم يُفعَّل فقط حين تكون كل الفروع النشطة في وقت نومها. */
export function allBranchesQuiet(now: Date, config: QuietConfig | null): boolean {
  if (!config || config.branches.length === 0) return false;
  return config.branches.every((branch) => branchQuietAt(now, branch));
}

export function nightSleepEnabled(): boolean {
  const value = (env("NIGHT_SLEEP") ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(value);
}

/* ── المخزن ──────────────────────────────────────────────────── */

type BlobStore = ReturnType<typeof getStore>;

/** قراءة قوية الاتساق إن توفّرت في بيئة التشغيل، وإلا العادية. */
async function withStore<T>(run: (store: BlobStore) => Promise<T>): Promise<T> {
  try {
    return await run(getStore({ name: STORE, consistency: "strong" }));
  } catch {
    return run(getStore(STORE));
  }
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    return ((await withStore((store) => store.get(key, { type: "json" }))) as T | null) ?? null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<boolean> {
  try {
    await withStore((store) => store.setJSON(key, value));
    return true;
  } catch {
    return false;
  }
}

const beatKey = (code: string) => `edge/${code}/beat`;
const waKey = (code: string) => `edge/${code}/wa`;
const frameKey = (code: string, cameraId: number) => `edge/${code}/frame/${cameraId}`;
const handledKey = (code: string) => `edge/${code}/offline-handled`;

let configCache: { at: number; value: QuietConfig | null } | undefined;
let awakeCache: { at: number; until: number } | undefined;

export async function loadQuietConfig(fresh = false): Promise<QuietConfig | null> {
  if (!fresh && configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const value = await readJson<QuietConfig>("config");
  configCache = { at: Date.now(), value: value?.version === 1 ? value : null };
  return configCache.value;
}

export async function saveQuietConfig(config: QuietConfig): Promise<void> {
  if (await writeJson("config", config)) configCache = { at: Date.now(), value: config };
}

async function awakeUntil(fresh = false): Promise<number> {
  if (!fresh && awakeCache && Date.now() - awakeCache.at < AWAKE_TTL_MS) return awakeCache.until;
  const value = await readJson<{ until: number }>("awake");
  awakeCache = { at: Date.now(), until: Number(value?.until) || 0 };
  return awakeCache.until;
}

let lastBump = 0;

/** يُبقي النظام مستيقظاً مدة بعد حدث فعلي. يُكتب مرة كل دقيقة على الأكثر. */
export async function bumpAwake(force = false): Promise<void> {
  if (!nightSleepEnabled()) return;
  const now = Date.now();
  if (!force && now - lastBump < 60_000) return;
  lastBump = now;
  const until = now + AWAKE_HOLD_MS;
  await writeJson("awake", { until });
  awakeCache = { at: now, until };
}

/** هل النظام نائم الآن؟ أي خطأ يعني «لا». */
export async function isQuietNow(options: { fresh?: boolean } = {}): Promise<boolean> {
  if (!nightSleepEnabled()) return false;
  try {
    const now = new Date();
    const config = await loadQuietConfig(options.fresh);
    if (!allBranchesQuiet(now, config)) return false;
    return (await awakeUntil(options.fresh)) <= now.getTime();
  } catch {
    return false;
  }
}

/* ── نبض الجهاز ──────────────────────────────────────────────── */

const lastWrite = new Map<string, number>();

function throttled(key: string, everyMs: number): boolean {
  const now = Date.now();
  if (now - (lastWrite.get(key) ?? 0) < everyMs) return true;
  lastWrite.set(key, now);
  return false;
}

async function markDirty(): Promise<void> {
  if (throttled("dirty", 60_000)) return;
  await writeJson("dirty", { at: Date.now() });
}

export async function recordBeat(code: string, status: unknown, everyMs = 0): Promise<void> {
  if (everyMs && throttled(beatKey(code), everyMs)) return;
  const beat: EdgeBeat = { seenAt: Date.now() };
  if (status !== undefined) {
    const text = JSON.stringify(status);
    if (text && text.length <= 30_000) beat.status = status;
  }
  await writeJson(beatKey(code), beat);
}

export const readBeat = (code: string) => readJson<EdgeBeat>(beatKey(code));
export const readWaBeat = (code: string) => readJson<WaBeat>(waKey(code));
export const readFrameAt = async (code: string, cameraId: number) =>
  Number((await readJson<{ at: number }>(frameKey(code, cameraId)))?.at) || 0;

/** هل سُجّل شيء أثناء النوم يحتاج نقله إلى قاعدة البيانات؟ يُمسح عند القراءة. */
export async function takeDirty(): Promise<boolean> {
  const dirty = await readJson<{ at: number }>("dirty");
  if (!dirty) return false;
  try {
    await withStore((store) => store.delete("dirty"));
  } catch {
    /* يُعاد النقل في المرة القادمة — لا ضرر */
  }
  return true;
}

/**
 * أثناء النوم: هل انقطع نبض جهاز التحليل؟ يُرجع true مرة واحدة لكل انقطاع،
 * فيستيقظ النظام ليُنبّه المالك ثم يعود للنوم.
 */
export async function edgeWentSilent(config: QuietConfig, now = Date.now()): Promise<boolean> {
  let silent = false;
  for (const branch of config.branches) {
    const beat = await readBeat(branch.code);
    if (!beat || now - beat.seenAt < EDGE_SILENT_MS) continue;
    const handled = await readJson<{ seenAt: number }>(handledKey(branch.code));
    if (handled?.seenAt === beat.seenAt) continue;
    await writeJson(handledKey(branch.code), { seenAt: beat.seenAt });
    silent = true;
  }
  return silent;
}

/* ── بوابة المهام المجدولة ───────────────────────────────────── */

export type ScheduledJob = "control-tick" | "surveillance-scan" | "foodics-sync" | "close-shifts";

/**
 * تُستدعى أول كل مهمة مجدولة. true = نفّذ كالعادة. false = النظام نائم، لا تلمس
 * قاعدة البيانات.
 */
export async function shouldRunScheduled(job: ScheduledJob): Promise<boolean> {
  try {
    if (!(await isQuietNow({ fresh: true }))) return true;
    if (job !== "control-tick") return false;
    const config = await loadQuietConfig();
    if (config && (await edgeWentSilent(config))) {
      console.log("[night-sleep] انقطع نبض جهاز التحليل وقت النوم — استيقاظ للتنبيه");
      await bumpAwake(true);
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/* ── طلبات جهاز المطعم ───────────────────────────────────────── */

function keyAuthorized(req: Request): boolean {
  const secret = process.env.SURVEILLANCE_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = req.headers["x-surveillance-key"];
  const provided = Buffer.from(String(Array.isArray(header) ? header[0] : (header ?? "")));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** حدث عدّ الداخلين بصفرين لا يحمل معلومة — لا يوقظ القاعدة. */
function isEmptyFootfall(event: unknown): boolean {
  const e = (event ?? {}) as Record<string, unknown>;
  return e.type === "footfall" && !Number(e.entries) && !Number(e.exits);
}

type Routine = "beat" | "config" | "outbox" | "preview" | "jobs";

/** يصنّف طلب الجهاز: روتيني يمكن الرد عليه دون قاعدة البيانات، أو لا. */
export function routineKind(method: string, path: string, body: Record<string, unknown>): Routine | null {
  if (method === "GET" && path === "/control/edge/config") return "config";
  if (method === "GET" && path === "/surveillance/agent/jobs") return "jobs";
  if (method !== "POST") return null;
  if (path === "/control/edge/events") {
    const events = Array.isArray(body.events) ? body.events : [];
    return events.every(isEmptyFootfall) ? "beat" : null;
  }
  if (path === "/control/edge/outbox") {
    return Array.isArray(body.results) && body.results.length > 0 ? null : "outbox";
  }
  if (path === "/control/edge/preview") return "preview";
  return null;
}

function decodeJpeg(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value) return null;
  const data = Buffer.from(value.replace(/^data:[^,]+,/, ""), "base64");
  if (data.byteLength < 100 || data.byteLength > MAX_IMAGE_BYTES || data[0] !== 0xff || data[1] !== 0xd8) return null;
  return data;
}

async function saveLatestFrame(key: string, image: Buffer): Promise<void> {
  // نفس مخزن ومفاتيح saveImage في vision.ts، فتظهر اللقطة في البرنامج كالعادة.
  const frames = getStore("surveillance-frames");
  await frames.set(key, image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer);
  await frames.set(`${key}.type`, "image/jpeg");
}

/** يرد على الطلب الروتيني من المخزن. false = لم يُعالَج، يكمل المسار العادي. */
async function answerRoutine(kind: Routine, req: Request, res: Response, config: QuietConfig): Promise<boolean> {
  if (kind === "jobs") {
    res.json({ ok: true, serverTime: new Date().toISOString(), jobs: [] });
    return true;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = String((kind === "config" ? req.query.branchCode : body.branchCode) ?? "").trim();
  const branch = config.branches.find((item) => item.code === code);
  if (!branch) return false;

  if (kind === "config") {
    if (!branch.edgeConfig) return false;
    res.json({ ok: true, serverTime: new Date().toISOString(), ...(branch.edgeConfig as object) });
    return true;
  }
  if (kind === "beat") {
    await recordBeat(branch.code, body.status);
    await markDirty();
    const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
    res.json({ ok: true, results: events.map(() => ({ ok: true, type: "footfall" })), live: false });
    return true;
  }
  if (kind === "outbox") {
    if (!throttled(waKey(branch.code), 60_000)) {
      const state = String(body.state ?? "").slice(0, 40);
      await writeJson(waKey(branch.code), { seenAt: Date.now(), state } satisfies WaBeat);
      await markDirty();
    }
    res.json({ ok: true, messages: [] });
    return true;
  }
  // preview: تُحفظ اللقطة ليراها المالك، بلا تحليل وبلا قاعدة بيانات
  const camera = branch.cameras[String(body.cameraNumber ?? "").trim()];
  const image = decodeJpeg(body.image);
  if (!camera || !image) return false;
  await saveLatestFrame(camera.latestKey, image);
  await writeJson(frameKey(branch.code, camera.id), { at: Date.now() });
  await markDirty();
  res.json({ ok: true });
  return true;
}

/** فتح شاشات الرقابة والكاميرات يوقظ النظام ليعرض حالة الجهاز الحية. */
function isMonitoringScreen(path: string): boolean {
  return path.startsWith("/control/") || path.startsWith("/surveillance/");
}

/**
 * يوضع قبل أي وسيط يلمس قاعدة البيانات. وقت النوم يرد على اتصالات الجهاز
 * الروتينية من المخزن؛ وأي طلب آخر يغيّر شيئاً يُبقي النظام مستيقظاً.
 */
export async function quietMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!nightSleepEnabled()) return next();
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = keyAuthorized(req) ? routineKind(req.method, req.path, body) : null;
    if (kind) {
      if (await isQuietNow()) {
        const config = await loadQuietConfig();
        if (config && (await answerRoutine(kind, req, res, config))) return;
      } else if (kind === "beat") {
        // في الدوام: نسخة من النبض في المخزن (كل دقيقة) ليُعرف انقطاعه وقت النوم
        const code = String(body.branchCode ?? "").trim();
        if (code) await recordBeat(code, undefined, 60_000);
      }
    } else if (!["GET", "HEAD", "OPTIONS"].includes(req.method) || isMonitoringScreen(req.path)) {
      await bumpAwake();
    }
  } catch (error) {
    if (!res.headersSent) console.error("[night-sleep] تعذّر الرد من المخزن — يكمل المسار العادي:", error);
  }
  if (!res.headersSent) next();
}
