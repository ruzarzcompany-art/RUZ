/**
 * مركز الضبط: توجيه كل تنبيه رقابي إلى صاحبه عبر واتساب، وتصعيده إن لم يُستلم.
 *
 *   • السرقات والخلل الكبير  → المالك مباشرة.
 *   • الخدمة (طاولة متسخة، شكوى طاولة، انتظار عميل، تأخر طلب، طابور) → الموظف
 *     أولاً، ثم المدير إن لم يؤكد الاستلام خلال المهلة، ثم المالك.
 *   • تقييمات قوقل السيئة والنظافة والانضباط → مدير المطعم.
 *
 * وفيه أيضاً: سحب تقييمات قوقل، شكاوى الطاولات (QR)، والتقرير الليلي للمالك
 * بتحليل الذكاء الاصطناعي.
 *
 * قاعدة ثابتة: حالات الاشتباه تبقى «اشتباهاً يحتاج مراجعة» في كل رسالة، ولا
 * تُرسل إلى مستوى الموظفين أبداً — تذهب للمالك فقط ليراجع المقطع.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  branches,
  controlBriefs,
  controlDispatches,
  controlMessages,
  controlOutbox,
  controlRecipients,
  controlFootfall,
  controlSettings,
  controlTableSessions,
  customerFeedback,
  employees,
  googleReviews,
  surveillanceAlerts,
  surveillanceCameras,
} from "../db/schema.js";
import { env, getJwtSecret } from "./config.js";
import { checkEdgeOffline, edgeOverview } from "./edge.js";
import { foodicsDaySales, foodicsStatus } from "./foodics.js";
import {
  ALERT_TYPES,
  LABELS,
  MAX_EVIDENCE_FRAMES,
  alertFramePayload,
  alertFramesPayload,
  buildDailyReport,
  createAlert,
  dayRange,
  type BranchRow,
} from "./routes/surveillance.js";
import { isoDateInZone, safeTimeZone, wallPartsInZone } from "./time.js";
import { VISION_MODEL, onShiftEmployees } from "./vision.js";

/* ── القواميس ─────────────────────────────────────────────────── */

export type Tier = "staff" | "manager" | "owner";
export const TIERS: Tier[] = ["staff", "manager", "owner"];
export const TIER_LABELS: Record<Tier, string> = {
  staff: "الموظف",
  manager: "مدير المطعم",
  owner: "المالك",
};

interface Route {
  first: Tier;
  /** يُصعَّد للمستوى الأعلى عند عدم تأكيد الاستلام */
  escalate: boolean;
  /** ملاحظة بسيطة: لا تُرسل فوراً إلا إذا فُعّل «إرسال الملاحظات البسيطة» */
  minor?: boolean;
  /** تنبيه تأخر طلب: له مهلة استلام خاصة للموظف */
  order?: boolean;
  /** المنطقة الافتراضية إن لم يكن للتنبيه كاميرا */
  zone?: string;
  /** يُبلَّغ حتى لو كان الحدث قديماً (مطابقات اليوم المنتهي) */
  anyAge?: boolean;
}

/** من يستلم كل نوع تنبيه أولاً. الأنواع غير المذكورة تذهب للمدير بلا تصعيد. */
export const ROUTES: Record<string, Route> = {
  // سرقات واشتباهات وخلل كبير → المالك
  drawer_no_sale: { first: "owner", escalate: false },
  order_no_invoice: { first: "owner", escalate: false },
  table_no_invoice: { first: "owner", escalate: false, anyAge: true },
  repeated_pos: { first: "owner", escalate: false },
  warehouse_exit: { first: "owner", escalate: false },
  warehouse_off_hours: { first: "owner", escalate: false },
  sales_gap: { first: "owner", escalate: false, anyAge: true },
  waste_gap: { first: "owner", escalate: false, anyAge: true },
  cash_difference: { first: "owner", escalate: false, anyAge: true },
  receipt_mismatch: { first: "owner", escalate: false, anyAge: true },
  price_change: { first: "owner", escalate: false, anyAge: true },
  waste_over_limit: { first: "owner", escalate: false, anyAge: true },
  waste_not_reviewed: { first: "manager", escalate: true, anyAge: true, zone: "kitchen" },
  receipt_not_confirmed: { first: "manager", escalate: true, anyAge: true, zone: "warehouse" },
  // تقفيل اليوم → مدير الفرع ثم المالك إن لم يؤكّد الاستلام
  cashier_not_closed: { first: "manager", escalate: true, anyAge: true, zone: "cashier" },
  stock_mismatch: { first: "owner", escalate: false, anyAge: true },
  camera_down: { first: "owner", escalate: false },
  // تحريك الزاوية كثير الإنذارات الكاذبة (تغيّر الإضاءة نهاراً/ليلاً): ملاحظة بسيطة لا تنبيه فوري
  camera_moved: { first: "owner", escalate: false, minor: true },
  // الخدمة → الموظف ثم المدير ثم المالك
  prep_overdue: { first: "staff", escalate: true, order: true, zone: "kitchen" },
  customer_wait: { first: "staff", escalate: true, order: true },
  dirty_table: { first: "staff", escalate: true, zone: "dining" },
  table_complaint: { first: "staff", escalate: true, zone: "dining" },
  cashier_queue: { first: "staff", escalate: true, zone: "cashier" },
  fridge_door_open: { first: "staff", escalate: false, zone: "kitchen", minor: true },
  // المدير
  customer_complaint: { first: "manager", escalate: true },
  google_review: { first: "manager", escalate: false, anyAge: true },
  customer_left: { first: "manager", escalate: false },
  order_returned: { first: "manager", escalate: false },
  hygiene: { first: "manager", escalate: false, minor: true },
  // ملاحظات بسيطة
  staff_phone: { first: "manager", escalate: false, minor: true },
  station_left: { first: "manager", escalate: false, minor: true },
  staff_gathering: { first: "manager", escalate: false, minor: true },
  waste_observed: { first: "manager", escalate: false, minor: true },
  other: { first: "manager", escalate: false, minor: true },
};

const MAX_EVENT_AGE_MS = 6 * 3600_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_PER_RECIPIENT = 6;

export const FEEDBACK_CATEGORIES: Record<string, string> = {
  call_staff: "أحتاج موظفاً",
  late: "تأخر الطلب",
  cleanliness: "النظافة",
  food: "جودة الأكل",
  service: "الخدمة",
  other: "أخرى",
};

/* ── الإعدادات ───────────────────────────────────────────────── */

export type ControlSettings = Awaited<ReturnType<typeof controlSettingsFor>>;

export async function controlSettingsFor(branchId: number) {
  const db = getDb();
  const [row] = await db.select().from(controlSettings).where(eq(controlSettings.branchId, branchId));
  return {
    branchId,
    enabled: row?.enabled ?? true,
    staffAckMinutes: row?.staffAckMinutes ?? 1,
    orderStaffAckMinutes: row?.orderStaffAckMinutes ?? 2,
    managerAckMinutes: row?.managerAckMinutes ?? 3,
    queueMax: row?.queueMax ?? 4,
    tableWaitMinutes: row?.tableWaitMinutes ?? 5,
    tableClearMinutes: row?.tableClearMinutes ?? 1,
    queueSeconds: row?.queueSeconds ?? 60,
    edgeLastSeenAt: row?.edgeLastSeenAt ?? null,
    edgeStatusJson: row?.edgeStatusJson ?? "",
    edgeOfflineNotified: row?.edgeOfflineNotified ?? false,
    waEdgeSeenAt: row?.waEdgeSeenAt ?? null,
    waEdgeState: row?.waEdgeState ?? "",
    liveUntil: row?.liveUntil ?? null,
    notifyMinor: row?.notifyMinor ?? false,
    googleLocation: row?.googleLocation ?? "",
    reviewMaxStars: row?.reviewMaxStars ?? 3,
    reviewsLastSyncAt: row?.reviewsLastSyncAt ?? null,
    reviewsLastError: row?.reviewsLastError ?? "",
    feedbackEnabled: row?.feedbackEnabled ?? true,
    tableCount: row?.tableCount ?? 20,
    briefTime: row?.briefTime ?? "23:45",
    briefLastDate: row?.briefLastDate ?? "",
  };
}

export async function patchControlSettings(
  branchId: number,
  set: Partial<typeof controlSettings.$inferInsert>,
) {
  const db = getDb();
  await db
    .insert(controlSettings)
    .values({ branchId, ...set })
    .onConflictDoUpdate({ target: controlSettings.branchId, set: { ...set, updatedAt: new Date() } });
}

export function publicBaseUrl(): string {
  const raw = (env("PUBLIC_BASE_URL") ?? env("URL") ?? "https://ruzarzcompany.com").trim();
  return raw.replace(/\/+$/, "");
}

/* ── واتساب ───────────────────────────────────────────────────── */

export function whatsappConfig() {
  const token = (env("WHATSAPP_TOKEN") ?? "").trim();
  const phoneId = (env("WHATSAPP_PHONE_ID") ?? "").trim();
  const instance = (env("WHATSAPP_INSTANCE") ?? "").trim();
  const explicit = (env("WHATSAPP_PROVIDER") ?? "").trim().toLowerCase();
  // بلا أي مزوّد مضبوط تُرسل الرسائل من رقم المطعم عبر جهاز المطعم (edge) — بلا اشتراك.
  const provider =
    explicit === "meta" || explicit === "ultramsg" || explicit === "edge"
      ? explicit
      : token && phoneId
        ? "meta"
        : token && instance
          ? "ultramsg"
          : "edge";
  const configured =
    provider === "edge" ||
    (Boolean(token) && ((provider === "meta" && Boolean(phoneId)) || (provider === "ultramsg" && Boolean(instance))));
  return {
    configured,
    provider,
    token,
    phoneId,
    instance,
    template: (env("WHATSAPP_TEMPLATE") ?? "").trim() || "sijil_alert",
    templateLang: (env("WHATSAPP_TEMPLATE_LANG") ?? "").trim() || "ar",
    apiVersion: (env("WHATSAPP_API_VERSION") ?? "").trim() || "v23.0",
    /** يُغيَّر فقط عند المرور بمزوّد وسيط متوافق مع واجهة Meta */
    apiBase: ((env("WHATSAPP_API_BASE") ?? "").trim() || "https://graph.facebook.com").replace(/\/+$/, ""),
  };
}

/** يحوّل الرقم إلى الصيغة الدولية أرقاماً فقط (05xxxxxxxx → 9665xxxxxxxx). */
export function normalizePhone(raw: string): string | null {
  let digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^05\d{8}$/.test(digits)) digits = `966${digits.slice(1)}`;
  else if (/^5\d{8}$/.test(digits)) digits = `966${digits}`;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

/** متغيّر قالب واتساب لا يقبل أسطراً جديدة ولا مسافات متتالية كثيرة. */
function flattenForTemplate(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" • ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 950);
}

export async function sendWhatsapp(phone: string, text: string): Promise<{ ok: boolean; error: string }> {
  const config = whatsappConfig();
  if (!config.configured) return { ok: false, error: "واتساب غير مضبوط (WHATSAPP_TOKEN)" };
  if (config.provider === "edge") {
    try {
      await getDb().insert(controlOutbox).values({ phone, body: text.slice(0, 3500) });
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: `تعذّر وضع الرسالة في قائمة الإرسال: ${error instanceof Error ? error.message : error}`.slice(0, 300) };
    }
  }
  try {
    let response: Response;
    if (config.provider === "meta") {
      response = await fetch(`${config.apiBase}/${config.apiVersion}/${config.phoneId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: config.template,
            language: { code: config.templateLang },
            components: [{ type: "body", parameters: [{ type: "text", text: flattenForTemplate(text) }] }],
          },
        }),
      });
    } else {
      response = await fetch(`https://api.ultramsg.com/${config.instance}/messages/chat`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(8_000),
        body: new URLSearchParams({ token: config.token, to: `+${phone}`, body: text.slice(0, 3500) }),
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let reason = "";
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } | string };
        reason = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "");
      } catch {
        /* الرد ليس JSON */
      }
      return { ok: false, error: `رمز ${response.status}${reason ? ` — ${reason}` : ""}`.slice(0, 300) };
    }
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: `تعذّر الوصول إلى مزوّد واتساب: ${error instanceof Error ? error.message : error}`.slice(0, 300) };
  }
}

/**
 * صورة مع تعليق عبر واتساب (UltraMsg يقبل الصورة base64 مباشرة). المزوّدات
 * الأخرى لا تدعم إرسال صورة حرّة هنا، فيُرسل التعليق نصاً مع رابط الصفحة.
 */
export async function sendWhatsappImage(phone: string, imageDataUrl: string, caption: string, fallbackLink = ""): Promise<{ ok: boolean; error: string }> {
  const config = whatsappConfig();
  if (!config.configured) return { ok: false, error: "واتساب غير مضبوط" };
  if (config.provider !== "ultramsg") {
    return sendWhatsapp(phone, `${caption}${fallbackLink ? `\n📷 الصورة: ${fallbackLink}` : ""}`);
  }
  try {
    const base64 = imageDataUrl.replace(/^data:[^,]+,/, "");
    const response = await fetch(`https://api.ultramsg.com/${config.instance}/messages/image`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ token: config.token, to: `+${phone}`, image: base64, caption: caption.slice(0, 1000) }),
    });
    if (!response.ok) return { ok: false, error: `رمز ${response.status}` };
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: `تعذّر إرسال الصورة: ${error instanceof Error ? error.message : error}`.slice(0, 300) };
  }
}

/* ── قائمة إرسال جهاز المطعم ─────────────────────────────────── */

const OUTBOX_MAX_AGE_MS = 20 * 60_000;
const OUTBOX_RETRY_MS = 2 * 60_000;
const WA_EDGE_ONLINE_MS = 3 * 60_000;

/** يسجّل نتائج الإرسال السابقة وحالة الربط، ثم يسلّم الرسائل المنتظرة لجهاز المطعم. */
export async function exchangeOutbox(
  branchId: number,
  state: string,
  results: Array<{ id: number; ok: boolean; error: string }>,
): Promise<Array<{ id: number; phone: string; text: string }>> {
  const db = getDb();
  const now = new Date();
  const link = { waEdgeSeenAt: now, waEdgeState: state.slice(0, 40) };
  await db
    .insert(controlSettings)
    .values({ branchId, ...link })
    .onConflictDoUpdate({ target: controlSettings.branchId, set: link });
  for (const result of results.slice(0, 50)) {
    await db
      .update(controlOutbox)
      .set({ status: result.ok ? "sent" : "failed", error: result.ok ? "" : result.error.slice(0, 300), updatedAt: now })
      .where(and(eq(controlOutbox.id, result.id), eq(controlOutbox.status, "sending")));
  }
  // التنبيه القديم لا قيمة له: ما تجاوز المهلة يُعلَّم فاشلاً بدل أن يصل متأخراً.
  await db
    .update(controlOutbox)
    .set({ status: "failed", error: "انتهت المهلة قبل اتصال جهاز المطعم", updatedAt: now })
    .where(
      and(inArray(controlOutbox.status, ["queued", "sending"]), lt(controlOutbox.createdAt, new Date(now.getTime() - OUTBOX_MAX_AGE_MS))),
    );
  if (state !== "connected") return [];
  // «sending» العالقة (انقطع الجهاز قبل تأكيدها) تُعاد بعد دقيقتين وحتى 3 محاولات.
  await db
    .update(controlOutbox)
    .set({ status: "queued", updatedAt: now })
    .where(
      and(
        eq(controlOutbox.status, "sending"),
        lt(controlOutbox.updatedAt, new Date(now.getTime() - OUTBOX_RETRY_MS)),
        lt(controlOutbox.attempts, 3),
      ),
    );
  const rows = await db.select().from(controlOutbox).where(eq(controlOutbox.status, "queued")).orderBy(asc(controlOutbox.id)).limit(10);
  if (rows.length === 0) return [];
  await db
    .update(controlOutbox)
    .set({ status: "sending", attempts: sql`${controlOutbox.attempts} + 1`, updatedAt: now })
    .where(inArray(controlOutbox.id, rows.map((row) => row.id)));
  return rows.map((row) => ({ id: row.id, phone: row.phone, text: row.body }));
}

/** حالة ربط واتساب جهاز المطعم كما تُعرض في شاشة «المستلمون والتصعيد». */
export function waEdgeStatus(settings: { waEdgeSeenAt: Date | null; waEdgeState: string }) {
  const online = Boolean(settings.waEdgeSeenAt && Date.now() - settings.waEdgeSeenAt.getTime() < WA_EDGE_ONLINE_MS);
  return { online, state: online ? settings.waEdgeState : "offline", seenAt: settings.waEdgeSeenAt };
}

/* ── رمز تأكيد الاستلام ──────────────────────────────────────── */

function sign(payload: string): string {
  return createHmac("sha256", getJwtSecret()).update(`control-ack:${payload}`).digest("base64url").slice(0, 22);
}

export function ackToken(dispatchId: number, recipientId: number): string {
  const payload = `${dispatchId}-${recipientId}`;
  return `${payload}-${sign(payload)}`;
}

export function parseAckToken(token: string): { dispatchId: number; recipientId: number } | null {
  const match = /^(\d{1,12})-(\d{1,12})-([\w-]{22})$/.exec(String(token ?? ""));
  if (!match) return null;
  const expected = Buffer.from(sign(`${match[1]}-${match[2]}`));
  const provided = Buffer.from(match[3]);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  return { dispatchId: Number(match[1]), recipientId: Number(match[2]) };
}

/* ── الحالات الكبيرة وملف مخالفات اليوم ─────────────────────── */

/**
 * الحالات الكبيرة: تصل المالك فوراً، ثم تتبعها صورة الحالة على واتساب ما إن
 * تُربط اللقطة بالتنبيه. كل ما عداها (مخالفات العمال الصغيرة والخدمة) يُجمع في
 * ملف مخالفات اليوم الذي يُرسل مع التقرير الليلي.
 */
export const MAJOR_TYPES = new Set([
  "drawer_no_sale",
  "order_no_invoice",
  "warehouse_exit",
  "warehouse_off_hours",
  "waste_gap",
  "cash_difference",
  "sales_gap",
  "repeated_pos",
  "stock_mismatch",
  "receipt_mismatch",
]);

export function reportSignature(branchId: number, date: string): string {
  return sign(`report:${branchId}:${date}`);
}

export function verifyReportSignature(branchId: number, date: string, provided: string): boolean {
  const expected = Buffer.from(reportSignature(branchId, date));
  const given = Buffer.from(String(provided ?? ""));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function violationsReportUrl(branchId: number, date: string): string {
  return `${publicBaseUrl()}/api/control/report-file?b=${branchId}&d=${date}&s=${reportSignature(branchId, date)}`;
}

const MAX_REPORT_IMAGES = 60;

/** ملف مخالفات اليوم: صفحة واحدة للطباعة بكل الحالات مرتّبة، مع صور أهمها. */
export async function violationsReportHtml(branch: BranchRow, date: string): Promise<string> {
  const db = getDb();
  const tz = safeTimeZone(branch.timezone);
  const { start, end } = dayRange(date, tz);
  const alerts = await db
    .select()
    .from(surveillanceAlerts)
    .where(and(eq(surveillanceAlerts.branchId, branch.id), gte(surveillanceAlerts.occurredAt, start), lt(surveillanceAlerts.occurredAt, end)))
    .orderBy(asc(surveillanceAlerts.occurredAt));
  const shown = alerts.filter((a) => a.alertType !== "camera_moved" && a.alertType !== "camera_down");
  const ids = [...new Set(shown.flatMap((a) => a.employeeIds ?? []))];
  const people = ids.length ? await db.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, ids)) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const label = (t: string) => ALERT_TYPES[t]?.label ?? t;

  const major = shown.filter((a) => MAJOR_TYPES.has(a.alertType));
  const staffTypes = new Set(["staff_phone", "staff_gathering", "station_left", "hygiene", "waste_observed", "fridge_door_open", "other"]);
  const staff = shown.filter((a) => staffTypes.has(a.alertType));
  const service = shown.filter((a) => !MAJOR_TYPES.has(a.alertType) && !staffTypes.has(a.alertType));

  // صور: الكبيرة أولاً ثم مخالفات العمال، بحدّ أعلى حتى يبقى الملف خفيفاً
  // الكبيرة ومخالفات العمال بتسلسلها كاملاً (قبل ← لحظة الحدث)، والخدمة بصورة واحدة.
  const images = new Map<number, string[]>();
  let imageCount = 0;
  for (const [list, perAlert] of [[major, MAX_EVIDENCE_FRAMES], [staff, MAX_EVIDENCE_FRAMES], [service, 1]] as const) {
    for (const a of list) {
      if (imageCount >= MAX_REPORT_IMAGES) break;
      const frames = await alertFramesPayload(a.id, perAlert).catch(() => []);
      const kept = frames.slice(-Math.min(perAlert, MAX_REPORT_IMAGES - imageCount)).map((f) => f.image);
      if (kept.length) {
        images.set(a.id, kept);
        imageCount += kept.length;
      }
    }
  }

  // لكل موظف: عدد مخالفاته وأنواعها
  const perEmployee = new Map<string, Map<string, number>>();
  for (const a of [...major, ...staff]) {
    const names = (a.employeeIds ?? []).map((id) => nameOf.get(id)).filter(Boolean) as string[];
    for (const n of names.length ? names : ["غير محدد"]) {
      const m = perEmployee.get(n) ?? new Map<string, number>();
      m.set(label(a.alertType), (m.get(label(a.alertType)) ?? 0) + 1);
      perEmployee.set(n, m);
    }
  }
  const countBy = (list: typeof shown) => {
    const m = new Map<string, number>();
    for (const a of list) m.set(label(a.alertType), (m.get(label(a.alertType)) ?? 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1]);
  };

  const row = (a: (typeof shown)[number]) => {
    const names = (a.employeeIds ?? []).map((id) => nameOf.get(id)).filter(Boolean).join("، ");
    const imgs = images.get(a.id) ?? [];
    return `<tr><td>${esc(hhmm(a.occurredAt, branch.timezone))}</td><td><b>${esc(label(a.alertType))}</b>${a.isSuspicion ? '<br><small class="sus">اشتباه — يُراجع المقطع</small>' : ""}</td><td>${esc(a.location)}</td><td>${esc(names || a.peopleNote.split("|")[0] || "—")}</td><td>${esc(a.details)}</td><td class="shots">${imgs.map((src) => `<img src="${src}" alt="">`).join("")}</td></tr>`;
  };
  const table = (title: string, list: typeof shown, empty: string) =>
    `<h2>${esc(title)} <small>(${list.length})</small></h2>${
      list.length
        ? `<table><thead><tr><th>الوقت</th><th>الحالة</th><th>المكان</th><th>الموظف</th><th>التفاصيل</th><th>الصورة</th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`
        : `<p class="ok">${esc(empty)}</p>`
    }`;
  const chips = (list: Array<[string, number]>) => list.map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join(" ");

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>مخالفات يوم ${esc(date)} — ${esc(branch.name)}</title>
<style>body{font-family:Tahoma,Arial,sans-serif;margin:16px;color:#111;background:#fff}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px;border-bottom:2px solid #333;padding-bottom:4px}
small{color:#666;font-weight:normal}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #bbb;padding:6px;text-align:right;vertical-align:top}th{background:#eee}
td img{width:220px;max-width:40vw;border-radius:6px}.shots img{display:block;margin-bottom:4px}tr{break-inside:avoid}.chip{display:inline-block;background:#f2f2f2;border:1px solid #ccc;border-radius:12px;padding:2px 10px;margin:2px;font-size:13px}
.major h2{color:#b00020;border-color:#b00020}.ok{color:#2e7d32}.sus{color:#b00020}.emp td:first-child{font-weight:bold;white-space:nowrap}@media print{td img{width:160px}}</style></head><body>
<h1>ملف مخالفات يوم ${esc(date)} — ${esc(branch.name)}</h1>
<p>كبيرة: <b>${major.length}</b> · مخالفات العمال: <b>${staff.length}</b> · الخدمة والطاولات: <b>${service.length}</b></p>
<p>${chips(countBy(shown))}</p>
<div class="major">${table("الحالات الكبيرة (سرقة / هدر / فروقات)", major, "لا حالات كبيرة اليوم.")}</div>
<h2>المخالفات حسب الموظف</h2>${
    perEmployee.size
      ? `<table class="emp"><thead><tr><th>الموظف</th><th>المخالفات</th></tr></thead><tbody>${[...perEmployee.entries()]
          .map(([n, m]) => `<tr><td>${esc(n)}</td><td>${chips([...m.entries()])}</td></tr>`)
          .join("")}</tbody></table>`
      : '<p class="ok">لا مخالفات مسجّلة على الموظفين.</p>'
  }
${table("مخالفات العمال", staff, "لا مخالفات للعمال اليوم.")}
${table("الخدمة والطاولات", service, "لا ملاحظات خدمة اليوم.")}
<p><small>الأسماء = من كان على رأس العمل في المكان وقتها (للمراجعة، لا تعرّف على الوجه). لا يُتّخذ إجراء قبل مراجعة المقطع. صدر ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC.</small></p>
</body></html>`;
}

/** يرسل صورة الحالة الكبيرة للمالك حين تُربط اللقطة بالتنبيه (بعد إرسال النص بلحظات). */
export async function sendPendingImages(limit = 10): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - 15 * 60_000);
  const rows = await db
    .select({ dispatch: controlDispatches, alert: surveillanceAlerts })
    .from(controlDispatches)
    .innerJoin(surveillanceAlerts, eq(surveillanceAlerts.id, controlDispatches.alertId))
    .where(and(gte(controlDispatches.createdAt, since), inArray(surveillanceAlerts.alertType, [...MAJOR_TYPES])))
    .orderBy(desc(controlDispatches.createdAt))
    .limit(30);
  let sent = 0;
  for (const { dispatch, alert } of rows) {
    if (sent >= limit) break;
    const [done] = await db
      .select({ id: controlMessages.id })
      .from(controlMessages)
      .where(and(eq(controlMessages.dispatchId, dispatch.id), eq(controlMessages.kind, "image")))
      .limit(1);
    if (done) continue;
    const payload = await alertFramePayload(alert.id).catch(() => null);
    if (!payload?.image) continue;
    const [branch] = await db.select().from(branches).where(eq(branches.id, alert.branchId));
    if (!branch) continue;
    const owners = await eligibleRecipients(alert.branchId, "owner", "", new Date());
    const caption = [
      `📷 صورة الحالة — ${ALERT_TYPES[alert.alertType]?.label ?? alert.alertType}`,
      `📍 ${alert.location || branch.name} · 🕒 ${hhmm(alert.occurredAt, branch.timezone)}`,
      alert.details.slice(0, 300),
      alert.isSuspicion ? "اشتباه يحتاج مراجعة المقطع وليس حكماً نهائياً." : "",
    ]
      .filter(Boolean)
      .join("\n");
    for (const owner of owners) {
      const result = await sendWhatsappImage(owner.phone, payload.image, caption);
      await db.insert(controlMessages).values({
        dispatchId: dispatch.id,
        branchId: alert.branchId,
        recipientId: owner.id,
        tier: "owner",
        kind: "image",
        phone: owner.phone,
        status: result.ok ? "sent" : "failed",
        error: result.error,
      });
      if (result.ok) sent += 1;
    }
    if (!owners.length) {
      // لا مالك مسجّل: نعلّم الإرسال حتى لا يُعاد كل دقيقة
      await db.insert(controlMessages).values({ dispatchId: dispatch.id, branchId: alert.branchId, tier: "owner", kind: "image", phone: "", status: "skipped", error: "لا مالك" });
    }
  }
  return sent;
}

/* ── اختيار المستلمين وإرسال مستوى ───────────────────────────── */

type AlertRow = typeof surveillanceAlerts.$inferSelect;
type DispatchRow = typeof controlDispatches.$inferSelect;
type RecipientRow = typeof controlRecipients.$inferSelect;

function hhmm(at: Date, timeZone: string): string {
  const p = wallPartsInZone(at, safeTimeZone(timeZone));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

async function alertZone(alert: AlertRow, route: Route): Promise<string> {
  if (alert.cameraId) {
    const db = getDb();
    const [camera] = await db
      .select({ zone: surveillanceCameras.zone })
      .from(surveillanceCameras)
      .where(eq(surveillanceCameras.id, alert.cameraId));
    if (camera) return camera.zone;
  }
  return route.zone ?? "";
}

async function eligibleRecipients(branchId: number, tier: Tier, zone: string, at: Date): Promise<RecipientRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(controlRecipients)
    .where(
      and(
        eq(controlRecipients.branchId, branchId),
        eq(controlRecipients.tier, tier),
        eq(controlRecipients.isActive, true),
      ),
    )
    .orderBy(asc(controlRecipients.id));
  if (tier !== "staff") return rows;

  const inZone = rows.filter((r) => !zone || r.zones.length === 0 || r.zones.includes(zone));
  if (!inZone.some((r) => r.onShiftOnly && r.employeeId)) return inZone;
  const onShift = new Set((await onShiftEmployees(branchId, at)).map((e) => e.id));
  return inZone.filter((r) => !r.onShiftOnly || !r.employeeId || onShift.has(r.employeeId));
}

const CONFIDENCE_AR: Record<string, string> = { high: "مؤكد تقريباً", medium: "محتمل — راجع الصورة", low: "ضعيف — للمراجعة فقط" };

/**
 * رسالة واتساب مختصرة ومفيدة: ماذا حدث، أين ومتى، من كان على رأس العمل،
 * المطلوب بالضبط، ورابط واحد يفتح الصورة ويؤكد الاستلام.
 */
function alertMessage(input: {
  alert: AlertRow;
  branch: BranchRow;
  recipient: RecipientRow;
  dispatchId: number;
  escalatedFrom: Tier | null;
  waitedMinutes: number;
}): string {
  const { alert, branch, recipient } = input;
  const spec = ALERT_TYPES[alert.alertType];
  const action = (alert.suggestedAction || spec?.action || "").split(/(?<=[.。])\s/)[0].trim();
  // تفاصيل الاشتباه وأسماء الموظفين لا تظهر إلا للمالك والمدير
  const privileged = recipient.tier !== "staff";
  const details = alert.isSuspicion && recipient.tier !== "owner" ? "" : alert.details.replace(/\s+/g, " ").slice(0, 260);
  const people = privileged && alert.peopleNote ? alert.peopleNote.replace(/\s*\|\s*/g, " — ").slice(0, 160) : "";
  const head = input.escalatedFrom
    ? `⬆️ تصعيد: لم يستلمه ${TIER_LABELS[input.escalatedFrom]} خلال ${Math.max(1, Math.round(input.waitedMinutes))} د`
    : alert.isUrgent
      ? "🔴 عاجل"
      : alert.isSuspicion
        ? "🟠 اشتباه للمراجعة"
        : "🟡 تنبيه";
  return [
    `${head} — ${spec?.label ?? alert.alertType}`,
    `📍 ${alert.location || branch.name} · 🕒 ${hhmm(alert.occurredAt, branch.timezone)}`,
    details ? `\n${details}` : "",
    people ? `👤 ${people}` : "",
    alert.confidence && alert.confidence !== "high" ? `الدقة: ${CONFIDENCE_AR[alert.confidence] ?? alert.confidence}` : "",
    action ? `\n✅ المطلوب: ${action}` : "",
    `\n📷 الصورة والتأكيد: ${publicBaseUrl()}/app/ack/?t=${ackToken(input.dispatchId, recipient.id)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function overRateLimit(recipientId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(controlMessages)
    .where(
      and(
        eq(controlMessages.recipientId, recipientId),
        eq(controlMessages.status, "sent"),
        gte(controlMessages.createdAt, new Date(Date.now() - RATE_WINDOW_MS)),
      ),
    );
  return (row?.count ?? 0) >= RATE_MAX_PER_RECIPIENT;
}

/** يرسل التنبيه لكل مستلمي المستوى. يُرجع عدد من يصلحون للاستلام وعدد ما أُرسل فعلاً. */
async function sendTier(input: {
  dispatch: Pick<DispatchRow, "id">;
  alert: AlertRow;
  branch: BranchRow;
  tier: Tier;
  zone: string;
  escalatedFrom: Tier | null;
  waitedMinutes: number;
}): Promise<{ eligible: number; sent: number }> {
  const db = getDb();
  const recipients = await eligibleRecipients(input.branch.id, input.tier, input.zone, new Date());
  let sent = 0;
  for (const recipient of recipients) {
    let status = "sent";
    let error = "";
    if (await overRateLimit(recipient.id)) {
      status = "skipped";
      error = `تجاوز حد ${RATE_MAX_PER_RECIPIENT} رسالة في 10 دقائق`;
    } else {
      const result = await sendWhatsapp(
        recipient.phone,
        alertMessage({ ...input, recipient, dispatchId: input.dispatch.id }),
      );
      if (result.ok) sent += 1;
      else {
        status = "failed";
        error = result.error;
      }
    }
    await db.insert(controlMessages).values({
      dispatchId: input.dispatch.id,
      branchId: input.branch.id,
      recipientId: recipient.id,
      tier: input.tier,
      kind: input.escalatedFrom ? "escalation" : "alert",
      phone: recipient.phone,
      status,
      error,
    });
  }
  return { eligible: recipients.length, sent };
}

function ackWindowMinutes(tier: Tier, route: Route, settings: ControlSettings): number | null {
  if (!route.escalate) return null;
  if (tier === "staff") return route.order ? settings.orderStaffAckMinutes : settings.staffAckMinutes;
  // تنبيهات الخدمة (طاولة، انتظار، طابور…) تتوقف عند المدير ولا تُصعَّد للمالك:
  // المالك يصله الكبير فقط، والخدمة تظهر له في ملف نهاية اليوم.
  if (tier === "manager") return route.first === "staff" ? null : settings.managerAckMinutes;
  return null;
}

function nextTier(tier: Tier): Tier | null {
  return tier === "staff" ? "manager" : tier === "manager" ? "owner" : null;
}

/**
 * يبدأ مسار الإبلاغ لتنبيه أُنشئ للتو. يُستدعى من `createAlert`، ولا يرمي
 * أبداً: فشل الإبلاغ لا يُفشل تسجيل التنبيه نفسه.
 */
export async function startDispatch(alertId: number): Promise<void> {
  try {
    const db = getDb();
    const [alert] = await db.select().from(surveillanceAlerts).where(eq(surveillanceAlerts.id, alertId));
    if (!alert) return;
    const route = ROUTES[alert.alertType] ?? { first: "manager" as Tier, escalate: false };
    const settings = await controlSettingsFor(alert.branchId);
    if (!settings.enabled) return;
    if (route.minor && !settings.notifyMinor) return;
    if (!route.anyAge && Date.now() - alert.occurredAt.getTime() > MAX_EVENT_AGE_MS) return;

    const [anyRecipient] = await db
      .select({ id: controlRecipients.id })
      .from(controlRecipients)
      .where(and(eq(controlRecipients.branchId, alert.branchId), eq(controlRecipients.isActive, true)))
      .limit(1);
    if (!anyRecipient) return; // الفرع لم يضبط مستلمين بعد

    const [branch] = await db.select().from(branches).where(eq(branches.id, alert.branchId));
    if (!branch) return;

    const [dispatch] = await db
      .insert(controlDispatches)
      .values({ alertId, branchId: alert.branchId, currentTier: route.first, escalates: route.escalate })
      .onConflictDoNothing({ target: controlDispatches.alertId })
      .returning();
    if (!dispatch) return;

    const zone = await alertZone(alert, route);
    // إن خلا المستوى من مستلمين (لا أحد على رأس العمل مثلاً) يُنتقل فوراً للأعلى
    let tier: Tier | null = route.first;
    let delivered = false;
    while (tier) {
      const result = await sendTier({ dispatch, alert, branch, tier, zone, escalatedFrom: null, waitedMinutes: 0 });
      if (result.eligible > 0) {
        delivered = true;
        break;
      }
      tier = nextTier(tier);
    }
    const window = tier ? ackWindowMinutes(tier, route, settings) : null;
    await db
      .update(controlDispatches)
      .set({
        currentTier: tier ?? "owner",
        status: delivered ? "open" : "exhausted",
        nextEscalateAt: delivered && window !== null ? new Date(Date.now() + window * 60_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(controlDispatches.id, dispatch.id));
  } catch (error) {
    console.error("[control] فشل بدء الإبلاغ عن التنبيه", alertId, error);
  }
}

/** يصعّد ما حان موعده ولم يُستلم، ويُغلق ما حُسم بالمراجعة داخل النظام. */
export async function escalateDue(limit = 40): Promise<{ escalated: number; closed: number }> {
  const db = getDb();
  const now = new Date();
  let escalated = 0;
  let closed = 0;

  const due = await db
    .select({ dispatch: controlDispatches, alert: surveillanceAlerts, branch: branches })
    .from(controlDispatches)
    .innerJoin(surveillanceAlerts, eq(surveillanceAlerts.id, controlDispatches.alertId))
    .innerJoin(branches, eq(branches.id, controlDispatches.branchId))
    .where(
      and(
        eq(controlDispatches.status, "open"),
        isNotNull(controlDispatches.nextEscalateAt),
        lte(controlDispatches.nextEscalateAt, now),
      ),
    )
    .orderBy(asc(controlDispatches.nextEscalateAt))
    .limit(limit);

  for (const { dispatch, alert, branch } of due) {
    if (alert.status === "confirmed" || alert.status === "dismissed") {
      await db
        .update(controlDispatches)
        .set({ status: "closed", nextEscalateAt: null, updatedAt: now })
        .where(eq(controlDispatches.id, dispatch.id));
      closed += 1;
      continue;
    }
    const route = ROUTES[alert.alertType] ?? { first: "manager" as Tier, escalate: false };
    const settings = await controlSettingsFor(branch.id);
    const from = dispatch.currentTier as Tier;
    const zone = await alertZone(alert, route);
    const waited = (now.getTime() - dispatch.updatedAt.getTime()) / 60_000;

    // حجز التصعيد أولاً حتى لا يكرّره تشغيل متزامن
    const [claimed] = await db
      .update(controlDispatches)
      .set({ nextEscalateAt: null, updatedAt: now })
      .where(and(eq(controlDispatches.id, dispatch.id), eq(controlDispatches.status, "open"), isNotNull(controlDispatches.nextEscalateAt)))
      .returning({ id: controlDispatches.id });
    if (!claimed) continue;

    let tier = nextTier(from);
    let delivered = false;
    while (tier) {
      const result = await sendTier({ dispatch, alert, branch, tier, zone, escalatedFrom: from, waitedMinutes: waited });
      if (result.eligible > 0) {
        delivered = true;
        break;
      }
      tier = nextTier(tier);
    }
    const window = tier && delivered ? ackWindowMinutes(tier, route, settings) : null;
    await db
      .update(controlDispatches)
      .set({
        currentTier: tier ?? from,
        status: delivered ? "open" : "exhausted",
        nextEscalateAt: window !== null ? new Date(Date.now() + window * 60_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(controlDispatches.id, dispatch.id));
    if (delivered) escalated += 1;
  }
  return { escalated, closed };
}

/** تأكيد الاستلام — من رابط الرسالة أو من داخل النظام. */
export async function acknowledge(input: {
  dispatchId: number;
  recipientId?: number | null;
  name?: string;
  note?: string;
}): Promise<{ ok: boolean; already: boolean; error?: string }> {
  const db = getDb();
  const [dispatch] = await db.select().from(controlDispatches).where(eq(controlDispatches.id, input.dispatchId));
  if (!dispatch) return { ok: false, already: false, error: "التنبيه غير موجود" };
  if (dispatch.status === "acked") return { ok: true, already: true };

  let name = (input.name ?? "").slice(0, 120);
  let tier = "";
  if (input.recipientId) {
    const [recipient] = await db.select().from(controlRecipients).where(eq(controlRecipients.id, input.recipientId));
    if (!recipient || recipient.branchId !== dispatch.branchId) return { ok: false, already: false, error: "الرابط غير صالح" };
    name = recipient.name;
    tier = recipient.tier;
  }
  await db
    .update(controlDispatches)
    .set({
      status: "acked",
      ackAt: new Date(),
      ackByRecipientId: input.recipientId ?? null,
      ackByName: name,
      ackTier: tier,
      ackNote: (input.note ?? "").slice(0, 500),
      nextEscalateAt: null,
      updatedAt: new Date(),
    })
    .where(eq(controlDispatches.id, dispatch.id));
  return { ok: true, already: false };
}

/* ── تقييمات قوقل ─────────────────────────────────────────────── */

/**
 * طريقتان لسحب التقييمات:
 *   • «مكان قوقل» (الأسهل): مفتاح GOOGLE_PLACES_API_KEY + معرّف المكان (ChIJ…) —
 *     يعيد أحدث 5 تقييمات، ويكفي للتنبيه بالجديد السيئ كل 15 دقيقة.
 *   • «ملف النشاط التجاري» (الكامل): GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN +
 *     المسار accounts/…/locations/… — يحتاج موافقة قوقل على واجهة Business Profile.
 */
export function googleConfig() {
  const clientId = (env("GOOGLE_CLIENT_ID") ?? "").trim();
  const clientSecret = (env("GOOGLE_CLIENT_SECRET") ?? "").trim();
  const refreshToken = (env("GOOGLE_REFRESH_TOKEN") ?? "").trim();
  const placesKey = (env("GOOGLE_PLACES_API_KEY") ?? "").trim();
  const business = Boolean(clientId && clientSecret && refreshToken);
  return { configured: business || Boolean(placesKey), business, places: Boolean(placesKey), placesKey, clientId, clientSecret, refreshToken };
}

export const GOOGLE_BUSINESS_PATH = /^accounts\/[\w-]+\/locations\/[\w-]+$/;
export const GOOGLE_PLACE_ID = /^(places\/)?[A-Za-z0-9_-]{20,}$/;

/** التقييمات من واجهة «الأماكن» (Places API New) بصيغة موحّدة مع واجهة النشاط التجاري. */
async function placesReviews(placeRef: string, key: string): Promise<GoogleReview[]> {
  const id = placeRef.replace(/^places\//, "");
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=ar`, {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "rating,userRatingCount,reviews" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    reviews?: Array<{ name?: string; rating?: number; text?: { text?: string }; originalText?: { text?: string }; authorAttribution?: { displayName?: string }; publishTime?: string }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(`قوقل ردّ بالرمز ${response.status}${body.error?.message ? ` — ${body.error.message}` : ""}`);
  const names = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE"];
  return (body.reviews ?? []).map((r) => ({
    reviewId: r.name ?? `${r.authorAttribution?.displayName ?? ""}:${r.publishTime ?? ""}`,
    reviewer: { displayName: r.authorAttribution?.displayName },
    starRating: names[Math.round(r.rating ?? 0)] ?? "",
    comment: r.originalText?.text ?? r.text?.text ?? "",
    createTime: r.publishTime,
  }));
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function googleAccessToken(): Promise<string> {
  const config = googleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8_000),
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`تعذّر تجديد صلاحية قوقل: ${body.error_description ?? body.error ?? response.status}`);
  }
  return body.access_token;
}

interface GoogleReview {
  reviewId?: string;
  reviewer?: { displayName?: string };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: unknown;
}

/**
 * يسحب أحدث التقييمات ويُنبّه المدير عن الجديد السيئ منها. أول مزامنة تُسجّل
 * الموجود أساساً بلا تنبيه حتى لا تُرسل تقييمات قديمة.
 */
export async function syncGoogleReviews(branch: BranchRow): Promise<{ fetched: number; added: number; alerted: number }> {
  const db = getDb();
  const settings = await controlSettingsFor(branch.id);
  const config = googleConfig();
  const location = settings.googleLocation.trim();
  const usePlaces = GOOGLE_PLACE_ID.test(location) && !GOOGLE_BUSINESS_PATH.test(location);
  if (!location) throw new Error("أدخل معرّف المكان في قوقل (يبدأ غالباً بـ ChIJ) في «التقرير والتقييمات»");
  if (usePlaces && !config.places) throw new Error("أضف المفتاح GOOGLE_PLACES_API_KEY في إعدادات Netlify لتفعيل التقييمات");
  if (!usePlaces && !GOOGLE_BUSINESS_PATH.test(location)) {
    throw new Error("المعرّف غير صحيح — ضع معرّف المكان (ChIJ…) أو المسار accounts/123/locations/456");
  }
  if (!usePlaces && !config.business) throw new Error("ربط ملف النشاط غير مضبوط (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)");
  try {
    let fetched: GoogleReview[];
    if (usePlaces) {
      fetched = await placesReviews(location, config.placesKey);
    } else {
      const token = await googleAccessToken();
      const response = await fetch(
        `https://mybusiness.googleapis.com/v4/${location}/reviews?pageSize=50&orderBy=${encodeURIComponent("updateTime desc")}`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
      );
      const body = (await response.json().catch(() => ({}))) as { reviews?: GoogleReview[]; error?: { message?: string } };
      if (!response.ok) throw new Error(`قوقل ردّ بالرمز ${response.status}${body.error?.message ? ` — ${body.error.message}` : ""}`);
      fetched = body.reviews ?? [];
    }

    const reviews = fetched.filter((r) => r.reviewId);
    const [existingAny] = await db
      .select({ id: googleReviews.id })
      .from(googleReviews)
      .where(eq(googleReviews.branchId, branch.id))
      .limit(1);
    const baseline = !existingAny;
    const known = new Set(
      reviews.length
        ? (
            await db
              .select({ reviewId: googleReviews.reviewId })
              .from(googleReviews)
              .where(and(eq(googleReviews.branchId, branch.id), inArray(googleReviews.reviewId, reviews.map((r) => r.reviewId!))))
          ).map((r) => r.reviewId)
        : [],
    );

    let added = 0;
    let alerted = 0;
    for (const review of reviews.reverse()) {
      if (known.has(review.reviewId!)) continue;
      const rating = STARS[review.starRating ?? ""] ?? 0;
      const reviewedAt = new Date(review.createTime ?? review.updateTime ?? Date.now());
      const author = (review.reviewer?.displayName ?? "").slice(0, 150);
      const comment = (review.comment ?? "").slice(0, 2000);
      let alertId: number | null = null;
      if (!baseline && rating > 0 && rating <= settings.reviewMaxStars) {
        const result = await createAlert({
          branchId: branch.id,
          alertType: "google_review",
          occurredAt: Number.isNaN(reviewedAt.getTime()) ? new Date() : reviewedAt,
          location: "خرائط قوقل",
          confidence: "high",
          details: `${"★".repeat(rating)}${"☆".repeat(5 - rating)} من ${author || "عميل"}${comment ? `: ${comment.slice(0, 600)}` : " (بلا تعليق)"}`,
          source: "auto",
          sourceRef: `google:${review.reviewId}`,
          customerText: true,
        });
        alertId = result.id;
        alerted += 1;
      }
      await db
        .insert(googleReviews)
        .values({
          branchId: branch.id,
          reviewId: review.reviewId!,
          rating,
          author,
          comment,
          reviewedAt: Number.isNaN(reviewedAt.getTime()) ? new Date() : reviewedAt,
          hasReply: Boolean(review.reviewReply),
          alertId,
        })
        .onConflictDoNothing();
      added += 1;
    }
    await patchControlSettings(branch.id, { reviewsLastSyncAt: new Date(), reviewsLastError: "" });
    return { fetched: reviews.length, added, alerted };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await patchControlSettings(branch.id, { reviewsLastSyncAt: new Date(), reviewsLastError: message });
    throw new Error(message);
  }
}

/* ── شكاوى الطاولات (QR) ─────────────────────────────────────── */

export async function submitFeedback(input: {
  branch: BranchRow;
  tableNo: string;
  category: string;
  message: string;
  phone: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const settings = await controlSettingsFor(input.branch.id);
  if (!settings.feedbackEnabled) return { ok: false, error: "استقبال الملاحظات متوقف حالياً" };
  // رقم الطاولة يُقبل فقط ضمن طاولات الفرع، حتى لا يُتجاوز حد المعدّل بأرقام وهمية
  const tableNumber = Number(input.tableNo);
  if (!(Number.isInteger(tableNumber) && tableNumber >= 1 && tableNumber <= Math.max(settings.tableCount, 0))) {
    input = { ...input, tableNo: "" };
  } else {
    input = { ...input, tableNo: String(tableNumber) };
  }

  const now = Date.now();
  const [sameTable] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customerFeedback)
    .where(
      and(
        eq(customerFeedback.branchId, input.branch.id),
        eq(customerFeedback.tableNo, input.tableNo),
        gte(customerFeedback.createdAt, new Date(now - 60_000)),
      ),
    );
  const [recent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customerFeedback)
    .where(and(eq(customerFeedback.branchId, input.branch.id), gte(customerFeedback.createdAt, new Date(now - 10 * 60_000))));
  if ((sameTable?.count ?? 0) >= 1) return { ok: false, error: "وصلتنا ملاحظتك قبل قليل، والموظف في الطريق إليك." };
  if ((recent?.count ?? 0) >= 30) return { ok: false, error: "تعذّر الإرسال الآن، نرجو إبلاغ أقرب موظف." };

  const [row] = await db
    .insert(customerFeedback)
    .values({
      branchId: input.branch.id,
      tableNo: input.tableNo,
      category: input.category,
      message: input.message,
      phone: input.phone,
    })
    .returning({ id: customerFeedback.id });

  const label = FEEDBACK_CATEGORIES[input.category] ?? FEEDBACK_CATEGORIES.other;
  const result = await createAlert({
    branchId: input.branch.id,
    alertType: "table_complaint",
    occurredAt: new Date(),
    location: input.tableNo ? `الصالة — طاولة ${input.tableNo}` : "الصالة",
    confidence: "high",
    details: `${label}${input.message ? `: ${input.message}` : ""}${input.phone ? ` | جوال العميل: ${input.phone}` : ""}`,
    source: "auto",
    sourceRef: `feedback:${row.id}`,
    customerText: true,
  });
  await db.update(customerFeedback).set({ alertId: result.id }).where(eq(customerFeedback.id, row.id));
  return { ok: true };
}

/* ── التقرير الليلي للمالك ───────────────────────────────────── */

const PERIODS = [
  { label: "الصباح (6–12)", from: 6, to: 12 },
  { label: "الظهر (12–17)", from: 12, to: 17 },
  { label: "المساء (17–22)", from: 17, to: 22 },
  { label: "الليل (22–6)", from: 22, to: 30 },
];

/** يجمع أرقام اليوم التي يُبنى عليها التقرير الليلي. */
export async function briefFacts(branch: BranchRow, date: string) {
  const db = getDb();
  const tz = safeTimeZone(branch.timezone);
  const { start, end } = dayRange(date, tz);

  const [report, alerts, dispatches, reviews, feedback, foodics] = await Promise.all([
    buildDailyReport(branch, date),
    db
      .select({
        id: surveillanceAlerts.id,
        alertType: surveillanceAlerts.alertType,
        occurredAt: surveillanceAlerts.occurredAt,
        isSuspicion: surveillanceAlerts.isSuspicion,
        isUrgent: surveillanceAlerts.isUrgent,
        status: surveillanceAlerts.status,
      })
      .from(surveillanceAlerts)
      .where(and(eq(surveillanceAlerts.branchId, branch.id), gte(surveillanceAlerts.occurredAt, start), lt(surveillanceAlerts.occurredAt, end))),
    db
      .select()
      .from(controlDispatches)
      .where(and(eq(controlDispatches.branchId, branch.id), gte(controlDispatches.createdAt, start), lt(controlDispatches.createdAt, end))),
    db
      .select()
      .from(googleReviews)
      .where(and(eq(googleReviews.branchId, branch.id), gte(googleReviews.reviewedAt, start), lt(googleReviews.reviewedAt, end))),
    db
      .select()
      .from(customerFeedback)
      .where(and(eq(customerFeedback.branchId, branch.id), gte(customerFeedback.createdAt, start), lt(customerFeedback.createdAt, end))),
    foodicsStatus(branch.id)
      .then(async (status) => (status.connected && status.foodicsBranchId ? await foodicsDaySales(branch.id, date) : null))
      .catch(() => null),
  ]);
  const [sessions, footfall] = await Promise.all([
    db
      .select()
      .from(controlTableSessions)
      .where(and(eq(controlTableSessions.branchId, branch.id), gte(controlTableSessions.seatedAt, start), lt(controlTableSessions.seatedAt, end))),
    db
      .select()
      .from(controlFootfall)
      .where(and(eq(controlFootfall.branchId, branch.id), gte(controlFootfall.hourStart, start), lt(controlFootfall.hourStart, end))),
  ]);

  const byType = new Map<string, number>();
  for (const a of alerts) byType.set(a.alertType, (byType.get(a.alertType) ?? 0) + 1);
  const periods = PERIODS.map((period) => {
    const rows = alerts.filter((a) => {
      const hour = wallPartsInZone(a.occurredAt, tz).hour;
      const h = hour < 6 ? hour + 24 : hour;
      return h >= period.from && h < period.to;
    });
    return { period: period.label, alerts: rows.length, urgent: rows.filter((a) => a.isUrgent).length };
  });
  const worst = [...periods].sort((a, b) => b.alerts - a.alerts)[0];

  const acked = dispatches.filter((d) => d.ackAt);
  const ackSeconds = acked.map((d) => (d.ackAt!.getTime() - d.createdAt.getTime()) / 1000);
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((s, n) => s + n, 0) / list.length) : null);
  const byAckTier = (tier: string) => acked.filter((d) => d.ackTier === tier).length;

  const feedbackByCategory = new Map<string, number>();
  for (const f of feedback) {
    const label = FEEDBACK_CATEGORIES[f.category] ?? f.category;
    feedbackByCategory.set(label, (feedbackByCategory.get(label) ?? 0) + 1);
  }

  return {
    branch: branch.name,
    date,
    sales: {
      cashierClosings: report.sales.posSales,
      foodicsTotal: foodics?.total ?? null,
      foodicsInvoices: foodics?.invoices ?? null,
      foodicsDiscounts: foodics?.discounts ?? null,
      foodicsRefunds: foodics?.refunds ?? null,
      discrepancies: report.sales.discrepancies,
    },
    prep: { overall: report.prep.overall, slowest: report.prep.slowest, byPeriod: report.prep.byPeriod },
    alerts: {
      total: alerts.length,
      urgent: alerts.filter((a) => a.isUrgent).length,
      suspicions: alerts.filter((a) => a.isSuspicion).length,
      needsReview: alerts.filter((a) => a.status === "needs_review").length,
      byType: [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type: ALERT_TYPES[type]?.label ?? type, count })),
      byPeriod: periods,
      worstPeriod: worst && worst.alerts > 0 ? worst.period : null,
    },
    response: {
      notified: dispatches.length,
      acknowledged: acked.length,
      neverAcknowledged: dispatches.filter((d) => !d.ackAt && d.status !== "closed").length,
      avgAckSeconds: avg(ackSeconds),
      ackedByStaff: byAckTier("staff"),
      ackedByManager: byAckTier("manager"),
      ackedByOwner: byAckTier("owner"),
      reachedOwnerByEscalation: dispatches.filter((d) => d.escalates && d.currentTier === "owner").length,
    },
    googleReviews: {
      count: reviews.length,
      average: reviews.length ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 : null,
      bad: reviews.filter((r) => r.rating > 0 && r.rating <= 3).map((r) => ({ rating: r.rating, comment: r.comment.slice(0, 200) })),
    },
    tableFeedback: { count: feedback.length, byCategory: Object.fromEntries(feedbackByCategory) },
    tables: tableStats(sessions),
    footfall: footfallStats(footfall, foodics?.invoices ?? null),
    waste: report.waste.slice(0, 8),
    cameras: report.cameras,
    recommendations: report.recommendations,
  };
}

/** إحصاءات جلسات الطاولات من التحليل المباشر. */
export function tableStats(sessions: Array<typeof controlTableSessions.$inferSelect>) {
  const mean = (list: number[]) => (list.length ? Math.round(list.reduce((s, n) => s + n, 0) / list.length) : null);
  const visits = sessions.filter((s) => s.firstVisitSeconds !== null).map((s) => s.firstVisitSeconds!);
  const cleared = sessions.filter((s) => s.clearedSeconds !== null).map((s) => s.clearedSeconds!);
  return {
    sessions: sessions.length,
    avgFirstVisitSeconds: mean(visits),
    maxFirstVisitSeconds: visits.length ? Math.max(...visits) : null,
    leftWithoutVisit: sessions.filter((s) => s.leftAt && s.firstVisitSeconds === null).length,
    avgClearSeconds: mean(cleared),
  };
}

/** الداخلون من الباب مقابل فواتير فوديكس (نسبة الشراء). */
export function footfallStats(rows: Array<typeof controlFootfall.$inferSelect>, invoices: number | null) {
  const entries = rows.reduce((s, r) => s + r.entries, 0);
  return {
    entries: rows.length ? entries : null,
    invoices,
    // فاتورة واحدة قد تخدم مجموعة، فالنسبة مؤشر اتجاه لا رقم دقيق
    invoicesPer100Entries: rows.length && entries > 0 && invoices !== null ? Math.round((invoices / entries) * 100) : null,
  };
}

type BriefFacts = Awaited<ReturnType<typeof briefFacts>>;

function fallbackBrief(facts: BriefFacts): string {
  const lines = [
    `تقرير ${facts.branch} — ${facts.date}`,
    facts.sales.foodicsTotal !== null
      ? `المبيعات (فوديكس): ${facts.sales.foodicsTotal} ريال في ${facts.sales.foodicsInvoices} فاتورة`
      : `المبيعات (تقفيل الكاشير): ${facts.sales.cashierClosings} ريال`,
    facts.prep.overall.count
      ? `وقت الطلب: متوسط ${facts.prep.overall.avgMinutes} د، أقصى ${facts.prep.overall.maxMinutes} د`
      : "وقت الطلب: لا بيانات توقيت اليوم",
    `التنبيهات: ${facts.alerts.total} (فورية ${facts.alerts.urgent}، اشتباهات تحتاج مراجعة ${facts.alerts.suspicions})`,
    facts.alerts.worstPeriod ? `أكثر فترة تنبيهات: ${facts.alerts.worstPeriod}` : "",
    `الاستجابة: استُلم ${facts.response.acknowledged} من ${facts.response.notified}، وصل للمالك بالتصعيد ${facts.response.reachedOwnerByEscalation}`,
    facts.googleReviews.count ? `تقييمات قوقل: ${facts.googleReviews.count} بمتوسط ${facts.googleReviews.average}` : "",
    facts.tableFeedback.count ? `شكاوى الطاولات: ${facts.tableFeedback.count}` : "",
    facts.tables.sessions
      ? `الطاولات: ${facts.tables.sessions} جلسة، متوسط وصول الموظف ${facts.tables.avgFirstVisitSeconds ?? "—"} ث، غادر بلا خدمة ${facts.tables.leftWithoutVisit}`
      : "",
    facts.footfall.entries !== null
      ? `الداخلون: ${facts.footfall.entries}${facts.footfall.invoices !== null ? ` مقابل ${facts.footfall.invoices} فاتورة` : ""}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

let anthropic: Anthropic | undefined;

async function aiBrief(facts: BriefFacts): Promise<{ score: number | null; text: string }> {
  anthropic ??= new Anthropic();
  const message = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 1200,
    tools: [
      {
        name: "owner_brief",
        description: "Nightly brief for the restaurant owner.",
        input_schema: {
          type: "object",
          properties: {
            score: { type: "number", description: "Overall day score 0-10 based only on the data." },
            text: { type: "string", description: "Arabic brief, plain text lines, max 900 characters." },
          },
          required: ["score", "text"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "owner_brief" },
    messages: [
      {
        role: "user",
        content: [
          "أنت مدير تشغيل مطعم تكتب للمالك تقرير نهاية اليوم على واتساب. اعتمد على الأرقام التالية فقط ولا تخترع أي رقم أو حدث.",
          "اكتب بالعربية أسطراً قصيرة بلا تنسيق Markdown، بحد أقصى 900 حرف، بهذا الترتيب:",
          "1) تقييم اليوم من 10 وسببه في جملة. 2) المبيعات ووقت الطلب. 3) أهم ثلاث مشاكل مرتبة بالخطورة. 4) أسوأ فترة في اليوم ولماذا. 5) سرعة استجابة الموظفين والمدير للتنبيهات. 6) ثلاثة إجراءات محددة للغد.",
          "قواعد: أي اشتباه سرقة أو مخالفة يُكتب «اشتباه يحتاج مراجعة المقطع» ولا يُتهم أي موظف بالاسم. إن غابت بيانات قسم فقل إنها غير متوفرة بدل التخمين.",
          "",
          JSON.stringify(facts),
        ].join("\n"),
      },
    ],
  });
  const block = message.content.find((item) => item.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("لم يُرجع النموذج تقريراً");
  const raw = block.input as { score?: unknown; text?: unknown };
  const score = Number(raw.score);
  const text = String(raw.text ?? "").trim();
  if (!text) throw new Error("تقرير فارغ");
  return { score: Number.isFinite(score) ? Math.min(10, Math.max(0, Math.round(score * 10) / 10)) : null, text: text.slice(0, 1500) };
}

/** يبني التقرير الليلي ويحفظه، ويرسله لمستلمي مستوى المالك إن طُلب. */
export async function generateBrief(branch: BranchRow, date: string, options: { send: boolean }) {
  const db = getDb();
  const facts = await briefFacts(branch, date);
  let score: number | null = null;
  let text: string;
  let ai = true;
  try {
    ({ score, text } = await aiBrief(facts));
  } catch (error) {
    console.error("[control] تعذّر تحليل التقرير بالذكاء الاصطناعي:", error instanceof Error ? error.message : error);
    text = fallbackBrief(facts);
    ai = false;
  }
  const values = { branchId: branch.id, businessDate: date, score, briefText: text, factsJson: JSON.stringify(facts) };
  await db
    .insert(controlBriefs)
    .values(values)
    .onConflictDoUpdate({
      target: [controlBriefs.branchId, controlBriefs.businessDate],
      set: { score, briefText: text, factsJson: values.factsJson, createdAt: new Date() },
    });

  let sent = 0;
  if (options.send) {
    const owners = await eligibleRecipients(branch.id, "owner", "", new Date());
    const body = `📊 تقرير اليوم — ${branch.name} — ${date}${score !== null ? ` — التقييم ${score}/10` : ""}\n${text}\n\n📁 ملف مخالفات اليوم بالصور: ${violationsReportUrl(branch.id, date)}`;
    for (const owner of owners) {
      const result = await sendWhatsapp(owner.phone, body);
      if (result.ok) sent += 1;
      await db.insert(controlMessages).values({
        branchId: branch.id,
        recipientId: owner.id,
        tier: "owner",
        kind: "brief",
        phone: owner.phone,
        status: result.ok ? "sent" : "failed",
        error: result.error,
      });
    }
  }
  return { date, score, text, ai, sent };
}

/* ── التشغيل الدوري (كل دقيقة) ───────────────────────────────── */

function minutesOf(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total < 24 * 60 ? total : null;
}

export async function runControlTick(budgetMs = 22_000) {
  const started = Date.now();
  const db = getDb();
  const result = { escalated: 0, closed: 0, reviewBranches: 0, briefs: 0 };

  const escalation = await escalateDue();
  result.escalated = escalation.escalated;
  result.closed = escalation.closed;
  await sendPendingImages().catch((error) =>
    console.error("[control] فشل إرسال صور الحالات الكبيرة:", error instanceof Error ? error.message : error),
  );
  await checkEdgeOffline().catch((error) =>
    console.error("[control] فشل فحص جهاز التحليل:", error instanceof Error ? error.message : error),
  );

  const rows = await db
    .select({ settings: controlSettings, branch: branches })
    .from(controlSettings)
    .innerJoin(branches, eq(branches.id, controlSettings.branchId))
    .where(eq(branches.isActive, true));

  for (const { settings, branch } of rows) {
    if (Date.now() - started > budgetMs) break;
    const now = new Date();
    const tz = safeTimeZone(branch.timezone);

    // تقييمات قوقل كل 15 دقيقة
    const lastSync = settings.reviewsLastSyncAt?.getTime() ?? 0;
    if (settings.googleLocation && googleConfig().configured && now.getTime() - lastSync >= 15 * 60_000) {
      await syncGoogleReviews(branch).catch((error) =>
        console.error("[control] فشل سحب تقييمات قوقل:", error instanceof Error ? error.message : error),
      );
      result.reviewBranches += 1;
    }

    // التقرير الليلي: مرة واحدة بعد حلول وقته
    const at = minutesOf(settings.briefTime);
    if (at !== null && settings.enabled) {
      const p = wallPartsInZone(now, tz);
      const nowMinutes = p.hour * 60 + p.minute;
      const today = isoDateInZone(now, tz);
      // وقت بعد منتصف الليل (قبل 06:00) يعني تقرير اليوم المنتهي أمس
      const afterMidnight = at < 6 * 60;
      const date = afterMidnight ? isoDateInZone(new Date(now.getTime() - 24 * 3600_000), tz) : today;
      const due = afterMidnight ? nowMinutes >= at && nowMinutes < 6 * 60 : nowMinutes >= at;
      if (due && settings.briefLastDate !== date) {
        // يُحجز التاريخ أولاً حتى لا يتكرر الإرسال لو تأخر التحليل
        await patchControlSettings(branch.id, { briefLastDate: date });
        await generateBrief(branch, date, { send: true }).catch((error) =>
          console.error("[control] فشل التقرير الليلي:", error instanceof Error ? error.message : error),
        );
        result.briefs += 1;
      }
    }
  }
  return result;
}

/* ── نظرة عامة للشاشة ────────────────────────────────────────── */

export async function controlOverview(branch: BranchRow, date: string, reviewRange?: { from: string; to: string }) {
  const db = getDb();
  // التقييمات: آخر 25 افتراضياً، أو كل ما نُشر بين تاريخين يختارهما المالك
  const reviewWhere = reviewRange
    ? and(
        eq(googleReviews.branchId, branch.id),
        gte(googleReviews.reviewedAt, dayRange(reviewRange.from, safeTimeZone(branch.timezone)).start),
        lt(googleReviews.reviewedAt, dayRange(reviewRange.to, safeTimeZone(branch.timezone)).end),
      )
    : eq(googleReviews.branchId, branch.id);
  const tz = safeTimeZone(branch.timezone);
  const { start, end } = dayRange(date, tz);
  const [settings, recipients, dispatches, reviews, feedback, brief] = await Promise.all([
    controlSettingsFor(branch.id),
    db.select().from(controlRecipients).where(eq(controlRecipients.branchId, branch.id)).orderBy(asc(controlRecipients.id)),
    db
      .select({ dispatch: controlDispatches, alert: surveillanceAlerts })
      .from(controlDispatches)
      .innerJoin(surveillanceAlerts, eq(surveillanceAlerts.id, controlDispatches.alertId))
      .where(and(eq(controlDispatches.branchId, branch.id), gte(controlDispatches.createdAt, start), lt(controlDispatches.createdAt, end)))
      .orderBy(desc(controlDispatches.createdAt))
      .limit(200),
    db.select().from(googleReviews).where(reviewWhere).orderBy(desc(googleReviews.reviewedAt)).limit(reviewRange ? 500 : 25),
    db
      .select()
      .from(customerFeedback)
      .where(and(eq(customerFeedback.branchId, branch.id), gte(customerFeedback.createdAt, start), lt(customerFeedback.createdAt, end)))
      .orderBy(desc(customerFeedback.createdAt)),
    db.select().from(controlBriefs).where(and(eq(controlBriefs.branchId, branch.id), eq(controlBriefs.businessDate, date))),
  ]);

  const ids = dispatches.map((d) => d.dispatch.id);
  const messages = ids.length
    ? await db
        .select({
          dispatchId: controlMessages.dispatchId,
          status: controlMessages.status,
          count: sql<number>`count(*)::int`,
          lastError: sql<string>`max(${controlMessages.error})`,
        })
        .from(controlMessages)
        .where(inArray(controlMessages.dispatchId, ids))
        .groupBy(controlMessages.dispatchId, controlMessages.status)
    : [];
  const messageStats = new Map<number, { sent: number; failed: number; skipped: number; error: string }>();
  for (const m of messages) {
    if (m.dispatchId === null) continue;
    const entry = messageStats.get(m.dispatchId) ?? { sent: 0, failed: 0, skipped: 0, error: "" };
    if (m.status === "sent") entry.sent += m.count;
    else if (m.status === "failed") {
      entry.failed += m.count;
      entry.error = m.lastError ?? "";
    } else entry.skipped += m.count;
    messageStats.set(m.dispatchId, entry);
  }

  const wa = whatsappConfig();
  return {
    edge: await edgeOverview(branch, date),
    settings,
    whatsapp: {
      configured: wa.configured,
      provider: wa.provider,
      template: wa.provider === "meta" ? wa.template : "",
      edge: wa.provider === "edge" ? waEdgeStatus(settings) : null,
    },
    google: { configured: googleConfig().configured },
    labels: { tiers: TIER_LABELS, zones: LABELS.zones, feedback: FEEDBACK_CATEGORIES },
    routes: Object.entries(ROUTES).map(([type, route]) => ({
      type,
      label: ALERT_TYPES[type]?.label ?? type,
      first: route.first,
      escalate: route.escalate,
      minor: Boolean(route.minor),
    })),
    recipients,
    dispatches: dispatches.map(({ dispatch, alert }) => ({
      id: dispatch.id,
      alertId: alert.id,
      label: ALERT_TYPES[alert.alertType]?.label ?? alert.alertType,
      location: alert.location,
      occurredAt: alert.occurredAt,
      currentTier: dispatch.currentTier,
      status: dispatch.status,
      escalates: dispatch.escalates,
      nextEscalateAt: dispatch.nextEscalateAt,
      ackAt: dispatch.ackAt,
      ackByName: dispatch.ackByName,
      ackNote: dispatch.ackNote,
      ackSeconds: dispatch.ackAt ? Math.round((dispatch.ackAt.getTime() - dispatch.createdAt.getTime()) / 1000) : null,
      messages: messageStats.get(dispatch.id) ?? { sent: 0, failed: 0, skipped: 0, error: "" },
    })),
    reviews,
    feedback,
    brief: brief[0] ? { score: brief[0].score, text: brief[0].briefText, createdAt: brief[0].createdAt } : null,
    feedbackUrl: `${publicBaseUrl()}/app/feedback/?b=${encodeURIComponent(branch.code)}`,
  };
}
