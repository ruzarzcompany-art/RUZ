/**
 * وحدة الرقابة والكاميرات.
 *
 * فريق رقابي من ثلاثة أدوار يسجّل ملاحظاته هنا: المدير العام (الصالة
 * والمطبخ والكاشير والعملاء)، مدير المستودعات (الدخول والخروج والهدر
 * والمطابقة)، ومراقب الكاميرات (حالة الكاميرات والمقاطع والتعرّف).
 *
 * المصادر: إدخال يدوي من الفريق، أو نقطة استقبال آمنة (`/surveillance/webhook`)
 * يرسل إليها نظام التسجيل (NVR) أو نقطة البيع أحداثها بمفتاح سرّي.
 *
 * قواعد إلزامية مفروضة في الخادم:
 *   • كل حالة اشتباه تُحفظ بحالة «تحتاج مراجعة» ولا تُحسم إلا بمراجعة بشرية
 *     من صاحب درجة الموافقة في البند — ولا يُتّخذ إجراء آلي ضد أي موظف.
 *   • الثقة المنخفضة تُحوَّل دائماً إلى مراجعة بشرية بدل الحكم.
 *   • لا تُسجَّل كاميرا ولا ملاحظة في دورات المياه أو غرف التبديل أو أماكن
 *     الصلاة أو الاستراحة الخاصة.
 *
 * الوحدة تقرأ فقط من جداول النظام القائمة (الفروع، الموظفون، الحضور، تقفيل
 * الكاشير، المخزون) ولا تكتب فيها شيئاً.
 */

import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  attendanceLogs,
  branches,
  cashierClosings,
  employees,
  inventoryItems,
  inventoryMovements,
  surveillanceAlerts,
  surveillanceCameraChecks,
  surveillanceCameras,
  surveillanceDailyReports,
  surveillanceFrames,
  surveillanceOrders,
  surveillancePosEvents,
  surveillancePrepTargets,
  surveillanceSettings,
  surveillanceWaste,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { encryptString } from "../crypto.js";
import { agentJobs, fetchSnapshot, latestImageKey, loadImage, processFrame, cameraPassword, VISION_MODEL } from "../vision.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  PERMISSIONS,
  hasModuleDelete,
  hasModuleLevel,
  requireModuleDelete,
  requireModuleLevel,
  requirePermission,
} from "../rbac.js";
import { isoDateInZone, safeTimeZone, wallPartsInZone, zonedWallTimeToUtc } from "../time.js";
import {
  asBool,
  asDateOnly,
  asDateTime,
  asEnum,
  asId,
  asNumber,
  asString,
  round2,
} from "../validate.js";

export const surveillanceRouter = Router();

const MODULE = "surveillance";

/* ── القواميس ─────────────────────────────────────────────────── */

type Role = "gm" | "warehouse" | "camera";

interface AlertTypeSpec {
  label: string;
  role: Role;
  urgent: boolean;
  suspicion: boolean;
  severity: 1 | 2 | 3;
  action: string;
}

/** أنواع الحالات: التنبيهات الفورية أولاً ثم الملاحظات اليومية. */
export const ALERT_TYPES: Record<string, AlertTypeSpec> = {
  drawer_no_sale: {
    label: "فتح الدرج النقدي بدون عملية بيع مسجلة",
    role: "gm",
    urgent: true,
    suspicion: true,
    severity: 1,
    action: "مراجعة المقطع مع سجل فودكس لنفس الدقيقة، وسؤال الكاشير عن السبب.",
  },
  order_no_invoice: {
    label: "طلب خرج من المطبخ بدون فاتورة في فودكس",
    role: "gm",
    urgent: true,
    suspicion: true,
    severity: 1,
    action: "مطابقة الطلب بشاشة المطبخ وفواتير فودكس، وتحديد من استلم الطلب.",
  },
  repeated_pos: {
    label: "إلغاء أو خصم أو استرجاع متكرر من نفس الكاشير",
    role: "gm",
    urgent: true,
    suspicion: true,
    severity: 1,
    action: "مراجعة العمليات ومقاطعها، واشتراط موافقة المشرف على الإلغاء والخصم مؤقتاً.",
  },
  warehouse_exit: {
    label: "إخراج مواد من المستودع أو الباب الخلفي خارج الإجراء",
    role: "warehouse",
    urgent: true,
    suspicion: true,
    severity: 1,
    action: "مطابقة الكمية مع سند الصرف، وجرد الصنف فوراً، ومراجعة المقطع.",
  },
  warehouse_off_hours: {
    label: "دخول المستودع أو الثلاجة في وقت غير معتاد",
    role: "warehouse",
    urgent: true,
    suspicion: true,
    severity: 1,
    action: "تحديد الداخل ومدة بقائه وما أخرجه، وجرد الأصناف المتأثرة.",
  },
  prep_overdue: {
    label: "تجاوز وقت تجهيز الطلب الحد المعتمد",
    role: "gm",
    urgent: true,
    suspicion: false,
    severity: 2,
    action: "متابعة المحطة فوراً، والتأكد من توفر التحضير المسبق للصنف.",
  },
  customer_wait: {
    label: "عميل ينتظر أكثر من الحد المعتمد بدون خدمة",
    role: "gm",
    urgent: true,
    suspicion: false,
    severity: 2,
    action: "توجيه أقرب موظف صالة لخدمة العميل فوراً.",
  },
  camera_down: {
    label: "توقف أو حجب كاميرا",
    role: "camera",
    urgent: true,
    suspicion: false,
    severity: 1,
    action: "فحص الكاميرا والكابل والتسجيل فوراً، ومراجعة آخر مقطع قبل التوقف.",
  },
  camera_moved: {
    label: "كاميرا تم تحريكها عن زاويتها",
    role: "camera",
    urgent: true,
    suspicion: false,
    severity: 2,
    action: "إعادة الكاميرا لزاويتها المعتمدة، ومراجعة المقطع لمعرفة من حرّكها.",
  },
  stock_mismatch: {
    label: "فرق بين المصروف من المستودع والمبيعات",
    role: "warehouse",
    urgent: false,
    suspicion: true,
    severity: 2,
    action: "مراجعة الوصفة المعتمدة وجرد الصنف ومطابقة المبيعات.",
  },
  waste_observed: {
    label: "هدر مرصود",
    role: "warehouse",
    urgent: false,
    suspicion: false,
    severity: 3,
    action: "تسجيل الهدر في المخزون ومراجعة كمية التحضير.",
  },
  staff_phone: {
    label: "انشغال موظف بالجوال أثناء العمل",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 3,
    action: "تنبيه الموظف وتذكيره بسياسة الجوال.",
  },
  station_left: {
    label: "ترك المحطة أو عدم الالتزام بالموقع",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 3,
    action: "تنبيه الموظف ومراجعة توزيع المحطات.",
  },
  staff_gathering: {
    label: "تجمع موظفين أثناء العمل",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 3,
    action: "تفريق التجمع وإعادة كل موظف لمحطته.",
  },
  hygiene: {
    label: "مخالفة نظافة أو مظهر (زي، قفازات، غطاء رأس، نظافة محطة)",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 2,
    action: "تصحيح المخالفة فوراً وتوثيقها.",
  },
  customer_complaint: {
    label: "نقاش أو ارتفاع صوت مع عميل",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 2,
    action: "تدخل المشرف لاحتواء الموقف ومراجعة المقطع.",
  },
  order_returned: {
    label: "عميل يرجّع طلب",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 2,
    action: "معرفة سبب الإرجاع ومراجعة جودة الصنف.",
  },
  customer_left: {
    label: "عميل غادر قبل استلام طلبه",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 2,
    action: "مراجعة وقت انتظاره وسبب التأخير.",
  },
  fridge_door_open: {
    label: "باب الثلاجة أو غرفة التبريد مفتوح",
    role: "warehouse",
    urgent: true,
    suspicion: false,
    severity: 1,
    action: "إغلاق الباب فوراً، وفحص حرارة الأصناف، وتحديد من تركه مفتوحاً.",
  },
  sales_gap: {
    label: "فرق بين تقفيل الكاشير ومبيعات فوديكس",
    role: "gm",
    urgent: true,
    suspicion: true,
    severity: 1,
    action: "مطابقة التقفيل بتقرير فوديكس لنفس اليوم بنداً بنداً، وعدّ الدرج، وسؤال الكاشير.",
  },
  waste_gap: {
    label: "هدر أو فرق جرد غير مبرَّر بين فوديكس والجرد والكاميرات",
    role: "warehouse",
    urgent: false,
    suspicion: true,
    severity: 2,
    action: "مراجعة الصنف: هدر فوديكس مقابل فرق الجرد اليدوي ومشاهدات الكاميرا، وتوثيق السبب.",
  },
  other: {
    label: "ملاحظة أخرى",
    role: "gm",
    urgent: false,
    suspicion: false,
    severity: 3,
    action: "",
  },
};

const ALERT_TYPE_KEYS = Object.keys(ALERT_TYPES);
const CUSTOMER_TYPES = ["customer_wait", "customer_complaint", "order_returned", "customer_left"];
const ROLES = ["gm", "warehouse", "camera"] as const;
const CONFIDENCE = ["high", "medium", "low"] as const;
const ALERT_STATUSES = ["open", "needs_review", "confirmed", "dismissed"] as const;
const REVIEW_DECISIONS = ["confirmed", "dismissed", "needs_review"] as const;
const ZONES = [
  "dining",
  "kitchen",
  "cashier",
  "warehouse",
  "fridge",
  "back_door",
  "entrance",
  "delivery",
  "outdoor",
] as const;
const CAMERA_STATUSES = ["online", "offline", "covered", "moved", "unknown"] as const;
const POS_EVENT_TYPES = ["drawer_no_sale", "void", "discount", "refund"] as const;
const CHANNELS = ["dine_in", "takeaway", "delivery"] as const;
const WASTE_REASONS = [
  "spoiled",
  "over_prep",
  "dropped",
  "returned",
  "over_recipe",
  "expired",
  "other",
] as const;

export const LABELS = {
  roles: { gm: "المدير العام", warehouse: "مدير المستودعات", camera: "مراقب الكاميرات" },
  confidence: { high: "عالية", medium: "متوسطة", low: "منخفضة" },
  statuses: {
    open: "مفتوح",
    needs_review: "يحتاج مراجعة بشرية",
    confirmed: "مؤكَّد بعد المراجعة",
    dismissed: "مستبعد بعد المراجعة",
  },
  severity: { 1: "عالية", 2: "متوسطة", 3: "منخفضة" },
  zones: {
    dining: "الصالة",
    kitchen: "المطبخ",
    cashier: "الكاشير",
    warehouse: "المستودع",
    fridge: "الثلاجات",
    back_door: "الباب الخلفي",
    entrance: "المدخل",
    delivery: "منطقة المناديب",
    outdoor: "خارجي",
  },
  cameraStatuses: {
    online: "تعمل وتسجّل",
    offline: "متوقفة",
    covered: "مغطاة/محجوبة",
    moved: "تم تحريكها",
    unknown: "لم تُفحص",
  },
  posEvents: {
    drawer_no_sale: "فتح درج بلا بيع",
    void: "إلغاء",
    discount: "خصم",
    refund: "استرجاع",
  },
  channels: { dine_in: "محلي", takeaway: "سفري", delivery: "توصيل" },
  wasteReasons: {
    spoiled: "تلف",
    over_prep: "تحضير زائد",
    dropped: "سقوط/رمي",
    returned: "مرتجع من عميل",
    over_recipe: "كمية أكبر من الوصفة",
    expired: "انتهاء صلاحية",
    other: "أخرى",
  },
};

/* ── الخصوصية ─────────────────────────────────────────────────── */

const FORBIDDEN_AR = [
  "حمام",
  "دورة مياه",
  "دورة المياه",
  "دورات مياه",
  "دورات المياه",
  "مغاسل",
  "مرحاض",
  "تبديل",
  "غرفة الملابس",
  "غرفة ملابس",
  "مصلى",
  "مصلي",
  "صلاة",
  "مسجد",
  "استراحة",
];
const FORBIDDEN_EN = /\b(toilet|toilets|restroom|restrooms|bathroom|bathrooms|wc|washroom|locker|lockers|changing|prayer|mosque|break ?room)\b/i;

/** هل يشير النص إلى مكان خاص يُمنع رصده؟ */
export function isPrivateArea(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    return FORBIDDEN_AR.some((word) => text.includes(word)) || FORBIDDEN_EN.test(text);
  });
}

export const PRIVACY_ERROR =
  "لا يُسمح برصد دورات المياه أو غرف تبديل الملابس أو أماكن الصلاة أو الاستراحة الخاصة.";

/* ── أدوات مساعدة ─────────────────────────────────────────────── */

export type BranchRow = typeof branches.$inferSelect;

export async function loadBranch(branchId: number | null): Promise<BranchRow | null> {
  if (branchId === null) return null;
  const db = getDb();
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  return branch ?? null;
}

function branchIdFrom(req: AuthedRequest, value: unknown): number | null {
  return asId(value) ?? req.employee?.branchId ?? null;
}

/** حدود يوم العمل `[start, end)` بتوقيت الفرع. */
export function dayRange(date: string, timeZone: string): { start: Date; end: Date } {
  const [year, month, day] = date.split("-").map(Number);
  const zone = safeTimeZone(timeZone);
  const start = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, zone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const end = zonedWallTimeToUtc(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    zone,
  );
  return { start, end };
}

function dateOrToday(value: unknown, timeZone: string): string {
  return asDateOnly(value) ?? isoDateInZone(new Date(), safeTimeZone(timeZone));
}

function asIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => asId(item)).filter((id): id is number => id !== null);
  return [...new Set(ids)].slice(0, 30);
}

export async function settingsFor(branchId: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(surveillanceSettings)
    .where(eq(surveillanceSettings.branchId, branchId));
  return {
    branchId,
    defaultPrepMinutes: row?.defaultPrepMinutes ?? 15,
    customerWaitMinutes: row?.customerWaitMinutes ?? 10,
    repeatPosThreshold: row?.repeatPosThreshold ?? 3,
    openTime: row?.openTime ?? "06:00",
    closeTime: row?.closeTime ?? "02:00",
    alertEmails: row?.alertEmails ?? "",
    analyzeOpenHoursOnly: row?.analyzeOpenHoursOnly ?? false,
    dailyAnalysisCap: row?.dailyAnalysisCap ?? 0,
    capNotifiedDate: row?.capNotifiedDate ?? "",
    foodicsMatchMinutes: row?.foodicsMatchMinutes ?? 3,
  };
}

async function prepTargetMinutes(itemName: string, fallback: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(surveillancePrepTargets)
    .where(eq(surveillancePrepTargets.itemName, itemName));
  return row?.maxMinutes ?? fallback;
}

async function cameraInBranch(cameraId: number | null, branchId: number) {
  if (cameraId === null) return null;
  const db = getDb();
  const [camera] = await db
    .select()
    .from(surveillanceCameras)
    .where(and(eq(surveillanceCameras.id, cameraId), eq(surveillanceCameras.branchId, branchId)));
  return camera ?? null;
}

export async function cameraByNumber(branchId: number, cameraNumber: string | null) {
  if (!cameraNumber) return null;
  const db = getDb();
  const [camera] = await db
    .select()
    .from(surveillanceCameras)
    .where(
      and(
        eq(surveillanceCameras.branchId, branchId),
        eq(surveillanceCameras.cameraNumber, cameraNumber),
      ),
    );
  return camera ?? null;
}

async function employeeByCode(code: string | null): Promise<number | null> {
  if (!code) return null;
  const db = getDb();
  const [row] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.employeeCode, code));
  return row?.id ?? null;
}

export class InputError extends Error {}

/* ── إنشاء التنبيه (مشترك بين الإدخال اليدوي والآلي والـWebhook) ─── */

interface AlertInput {
  branchId: number;
  alertType: string;
  cameraId?: number | null;
  occurredAt?: Date | null;
  location?: string;
  employeeIds?: number[];
  peopleNote?: string;
  confidence?: string;
  clipRef?: string;
  details?: string;
  suggestedAction?: string;
  role?: string | null;
  severity?: number | null;
  source: "manual" | "webhook" | "auto";
  sourceRef?: string;
  createdBy?: number | null;
}

const LOW_CONFIDENCE_NOTE = "الثقة منخفضة: مطلوب مراجعة بشرية للمقطع قبل أي حكم.";
const SUSPICION_NOTE =
  "اشتباه يحتاج مراجعة — ليس حكماً نهائياً، ولا يُتّخذ إجراء ضد موظف قبل مراجعة المالك أو المدير للمقطع.";

export async function createAlert(input: AlertInput) {
  const spec = ALERT_TYPES[input.alertType];
  if (!spec) throw new InputError("نوع الحالة غير معروف");
  if (isPrivateArea(input.location, input.details)) throw new InputError(PRIVACY_ERROR);

  const db = getDb();
  if (input.sourceRef) {
    const [existing] = await db
      .select({ id: surveillanceAlerts.id })
      .from(surveillanceAlerts)
      .where(
        and(
          eq(surveillanceAlerts.branchId, input.branchId),
          eq(surveillanceAlerts.sourceRef, input.sourceRef),
        ),
      );
    if (existing) return { id: existing.id, duplicate: true };
  }

  const camera = await cameraInBranch(input.cameraId ?? null, input.branchId);
  const confidence = asEnum(input.confidence, CONFIDENCE) ?? "medium";
  const role = asEnum(input.role, ROLES) ?? spec.role;
  const severity =
    input.severity && [1, 2, 3].includes(input.severity) ? input.severity : spec.severity;

  const actionParts = [input.suggestedAction?.trim() || spec.action];
  if (confidence === "low") actionParts.push(LOW_CONFIDENCE_NOTE);
  if (spec.suspicion) actionParts.push(SUSPICION_NOTE);

  const location =
    input.location?.trim() ||
    (camera ? [LABELS.zones[camera.zone as keyof typeof LABELS.zones], camera.location].filter(Boolean).join(" — ") : "");

  const [created] = await db
    .insert(surveillanceAlerts)
    .values({
      branchId: input.branchId,
      cameraId: camera?.id ?? null,
      alertType: input.alertType,
      role,
      isUrgent: spec.urgent,
      isSuspicion: spec.suspicion,
      severity,
      occurredAt: input.occurredAt ?? new Date(),
      location: location.slice(0, 300),
      employeeIds: input.employeeIds ?? [],
      peopleNote: (input.peopleNote ?? "").slice(0, 500),
      confidence,
      clipRef: (input.clipRef ?? "").slice(0, 500),
      details: (input.details ?? "").slice(0, 2000),
      suggestedAction: actionParts.filter(Boolean).join(" ").slice(0, 1500),
      status: spec.suspicion || confidence === "low" ? "needs_review" : "open",
      source: input.source,
      sourceRef: (input.sourceRef ?? "").slice(0, 200),
      createdByEmployeeId: input.createdBy ?? null,
    })
    .returning({ id: surveillanceAlerts.id });

  return { id: created.id, duplicate: false };
}

/** مرجع المقطع الافتراضي: رقم الكاميرا + التاريخ + الوقت بالثانية. */
export function defaultClipRef(cameraNumber: string | null | undefined, at: Date, timeZone: string) {
  if (!cameraNumber) return "";
  const p = wallPartsInZone(at, safeTimeZone(timeZone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${cameraNumber} | ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/* ── استقبال الطلبات وأحداث الكاشير وفحص الكاميرات ─────────────── */

export async function ingestOrder(
  branch: BranchRow,
  body: Record<string, unknown>,
  source: "manual" | "webhook" | "foodics",
  createdBy: number | null,
) {
  const db = getDb();
  const orderRef = asString(body.orderRef, 100);
  if (!orderRef) throw new InputError("رقم الطلب مطلوب");
  const itemName = asString(body.itemName, 150) ?? "";
  const registeredAt = asDateTime(body.registeredAt);
  if (!registeredAt) throw new InputError("وقت تسجيل الطلب مطلوب");
  const deliveredAt = asDateTime(body.deliveredAt);
  if (deliveredAt && deliveredAt < registeredAt) {
    throw new InputError("وقت التسليم قبل وقت التسجيل");
  }
  const hasInvoice = asBool(body.hasInvoice) ?? true;
  const channel = asEnum(body.channel, CHANNELS) ?? "dine_in";
  const camera =
    (await cameraInBranch(asId(body.cameraId), branch.id)) ??
    (await cameraByNumber(branch.id, asString(body.cameraNumber, 50)));
  const preparedBy =
    asId(body.preparedByEmployeeId) ?? (await employeeByCode(asString(body.preparedByCode, 50)));
  const prepSeconds = deliveredAt
    ? Math.round((deliveredAt.getTime() - registeredAt.getTime()) / 1000)
    : null;

  const values = {
    branchId: branch.id,
    orderRef,
    itemName,
    channel,
    registeredAt,
    deliveredAt,
    prepSeconds,
    hasInvoice,
    preparedByEmployeeId: preparedBy,
    cameraId: camera?.id ?? null,
    source,
    notes: asString(body.notes, 500) ?? "",
    createdByEmployeeId: createdBy,
  };

  const [order] = await db
    .insert(surveillanceOrders)
    .values(values)
    .onConflictDoUpdate({
      target: [surveillanceOrders.branchId, surveillanceOrders.orderRef, surveillanceOrders.itemName],
      set: {
        deliveredAt: sql`COALESCE(excluded.delivered_at, ${surveillanceOrders.deliveredAt})`,
        prepSeconds: sql`COALESCE(excluded.prep_seconds, ${surveillanceOrders.prepSeconds})`,
        hasInvoice,
        channel,
        preparedByEmployeeId: sql`COALESCE(excluded.prepared_by_employee_id, ${surveillanceOrders.preparedByEmployeeId})`,
        cameraId: sql`COALESCE(excluded.camera_id, ${surveillanceOrders.cameraId})`,
      },
    })
    .returning();

  const alerts: number[] = [];
  const employeeIds = order.preparedByEmployeeId ? [order.preparedByEmployeeId] : [];
  const clipAt = order.deliveredAt ?? order.registeredAt;

  if (!order.hasInvoice) {
    const result = await createAlert({
      branchId: branch.id,
      alertType: "order_no_invoice",
      cameraId: order.cameraId,
      occurredAt: clipAt,
      employeeIds,
      confidence: source === "manual" ? "medium" : "high",
      clipRef: asString(body.clipRef, 500) || defaultClipRef(camera?.cameraNumber, clipAt, branch.timezone),
      details: `الطلب ${order.orderRef}${order.itemName ? ` (${order.itemName})` : ""} بلا فاتورة مقابلة.`,
      source: "auto",
      sourceRef: `order:${order.id}:no_invoice`,
      createdBy,
    });
    alerts.push(result.id);
  }

  if (order.prepSeconds !== null) {
    const settings = await settingsFor(branch.id);
    const target = await prepTargetMinutes(order.itemName, settings.defaultPrepMinutes);
    const minutes = order.prepSeconds / 60;
    if (minutes > target) {
      const result = await createAlert({
        branchId: branch.id,
        alertType: "prep_overdue",
        cameraId: order.cameraId,
        occurredAt: clipAt,
        employeeIds,
        confidence: "high",
        clipRef: asString(body.clipRef, 500) || defaultClipRef(camera?.cameraNumber, clipAt, branch.timezone),
        details: `الطلب ${order.orderRef}${order.itemName ? ` — ${order.itemName}` : ""}: ${round2(minutes)} دقيقة مقابل حد ${target} دقيقة.`,
        source: "auto",
        sourceRef: `order:${order.id}:overdue`,
        createdBy,
      });
      alerts.push(result.id);
    }
  }

  return { order, alerts };
}

export async function ingestPosEvent(
  branch: BranchRow,
  body: Record<string, unknown>,
  source: "manual" | "webhook" | "foodics",
  createdBy: number | null,
) {
  const db = getDb();
  const eventType = asEnum(body.eventType, POS_EVENT_TYPES);
  if (!eventType) throw new InputError("نوع حدث الكاشير غير معروف");
  const occurredAt = asDateTime(body.occurredAt) ?? new Date();
  const cashierId =
    asId(body.cashierEmployeeId) ?? (await employeeByCode(asString(body.cashierCode, 50)));
  const camera =
    (await cameraInBranch(asId(body.cameraId), branch.id)) ??
    (await cameraByNumber(branch.id, asString(body.cameraNumber, 50)));

  const [event] = await db
    .insert(surveillancePosEvents)
    .values({
      branchId: branch.id,
      eventType,
      occurredAt,
      cashierEmployeeId: cashierId,
      cashierName: asString(body.cashierName, 150) ?? "",
      amount: round2(asNumber(body.amount) ?? 0),
      orderRef: asString(body.orderRef, 100) ?? "",
      cameraId: camera?.id ?? null,
      source,
      notes: asString(body.notes, 500) ?? "",
      createdByEmployeeId: createdBy,
    })
    .returning();

  const alerts: number[] = [];
  const employeeIds = cashierId ? [cashierId] : [];
  const clipRef =
    asString(body.clipRef, 500) || defaultClipRef(camera?.cameraNumber, occurredAt, branch.timezone);

  if (eventType === "drawer_no_sale") {
    const result = await createAlert({
      branchId: branch.id,
      alertType: "drawer_no_sale",
      cameraId: event.cameraId,
      occurredAt,
      employeeIds,
      peopleNote: event.cashierName,
      confidence: source === "manual" ? "medium" : "high",
      clipRef,
      details: event.notes,
      source: "auto",
      sourceRef: `pos:${event.id}:drawer`,
      createdBy,
    });
    alerts.push(result.id);
  } else if (cashierId || event.cashierName) {
    const settings = await settingsFor(branch.id);
    const date = isoDateInZone(occurredAt, safeTimeZone(branch.timezone));
    const { start, end } = dayRange(date, branch.timezone);
    const cashierFilter = cashierId
      ? eq(surveillancePosEvents.cashierEmployeeId, cashierId)
      : eq(surveillancePosEvents.cashierName, event.cashierName);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(surveillancePosEvents)
      .where(
        and(
          eq(surveillancePosEvents.branchId, branch.id),
          inArray(surveillancePosEvents.eventType, ["void", "discount", "refund"]),
          cashierFilter,
          gte(surveillancePosEvents.occurredAt, start),
          lt(surveillancePosEvents.occurredAt, end),
        ),
      );
    if (Number(count) >= settings.repeatPosThreshold) {
      const result = await createAlert({
        branchId: branch.id,
        alertType: "repeated_pos",
        cameraId: event.cameraId,
        occurredAt,
        employeeIds,
        peopleNote: event.cashierName,
        confidence: "high",
        clipRef,
        details: `${count} عمليات إلغاء/خصم/استرجاع من نفس الكاشير في ${date} (الحد ${settings.repeatPosThreshold}).`,
        source: "auto",
        sourceRef: `pos-repeat:${date}:${cashierId ?? event.cashierName}`,
        createdBy,
      });
      alerts.push(result.id);
    }
  }

  return { event, alerts };
}

async function ingestCameraCheck(
  branch: BranchRow,
  cameraId: number,
  body: Record<string, unknown>,
  source: "manual" | "webhook",
  createdBy: number | null,
) {
  const db = getDb();
  const camera = await cameraInBranch(cameraId, branch.id);
  if (!camera) throw new InputError("الكاميرا غير موجودة في هذا الفرع");
  const status = asEnum(body.status, CAMERA_STATUSES);
  if (!status || status === "unknown") throw new InputError("حدّد حالة الكاميرا");
  const isRecording = asBool(body.isRecording) ?? status === "online";
  const note = asString(body.note, 500) ?? "";
  const at = asDateTime(body.checkedAt) ?? new Date();

  await db.insert(surveillanceCameraChecks).values({
    cameraId: camera.id,
    status,
    isRecording,
    note,
    source,
    checkedByEmployeeId: createdBy,
    checkedAt: at,
  });
  await db
    .update(surveillanceCameras)
    .set({ status, isRecording, lastCheckedAt: at, updatedAt: new Date() })
    .where(eq(surveillanceCameras.id, camera.id));

  let alertId: number | null = null;
  if (status !== "online" || !isRecording) {
    const day = isoDateInZone(at, safeTimeZone(branch.timezone));
    const result = await createAlert({
      branchId: branch.id,
      alertType: status === "moved" ? "camera_moved" : "camera_down",
      cameraId: camera.id,
      occurredAt: at,
      confidence: "high",
      clipRef: asString(body.clipRef, 500) || defaultClipRef(camera.cameraNumber, at, branch.timezone),
      details: [
        `الكاميرا ${camera.cameraNumber}${camera.name ? ` (${camera.name})` : ""}: ${LABELS.cameraStatuses[status]}`,
        isRecording ? "" : "التسجيل متوقف",
        note,
      ]
        .filter(Boolean)
        .join(" — "),
      source: "auto",
      sourceRef: `camera:${camera.id}:${status}:${isRecording ? "rec" : "norec"}:${day}`,
      createdBy,
    });
    alertId = result.id;
  }
  return { alertId };
}

/* ── التقرير اليومي ───────────────────────────────────────────── */

const PERIODS = [
  { key: "night", label: "الليل (12 ص – 6 ص)", from: 0, to: 6 },
  { key: "morning", label: "الصباح (6 ص – 12 م)", from: 6, to: 12 },
  { key: "afternoon", label: "الظهر (12 م – 5 م)", from: 12, to: 17 },
  { key: "evening", label: "المساء (5 م – 12 ص)", from: 17, to: 24 },
];

function minutes(seconds: number): number {
  return round2(seconds / 60);
}

function timeOfDay(at: Date | null, timeZone: string): string {
  if (!at) return "—";
  const p = wallPartsInZone(at, safeTimeZone(timeZone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export async function buildDailyReport(branch: BranchRow, date: string) {
  const db = getDb();
  const tz = safeTimeZone(branch.timezone);
  const { start, end } = dayRange(date, tz);
  const settings = await settingsFor(branch.id);

  const [closings, orders, posEvents, waste, alerts, cameras, checks, invWaste, invOut, attendance, targets] =
    await Promise.all([
      db
        .select({ totalSales: cashierClosings.totalSales })
        .from(cashierClosings)
        .where(and(eq(cashierClosings.branchId, branch.id), eq(cashierClosings.businessDate, date))),
      db
        .select()
        .from(surveillanceOrders)
        .where(
          and(
            eq(surveillanceOrders.branchId, branch.id),
            gte(surveillanceOrders.registeredAt, start),
            lt(surveillanceOrders.registeredAt, end),
          ),
        ),
      db
        .select()
        .from(surveillancePosEvents)
        .where(
          and(
            eq(surveillancePosEvents.branchId, branch.id),
            gte(surveillancePosEvents.occurredAt, start),
            lt(surveillancePosEvents.occurredAt, end),
          ),
        ),
      db
        .select()
        .from(surveillanceWaste)
        .where(
          and(
            eq(surveillanceWaste.branchId, branch.id),
            gte(surveillanceWaste.occurredAt, start),
            lt(surveillanceWaste.occurredAt, end),
          ),
        ),
      db
        .select()
        .from(surveillanceAlerts)
        .where(
          and(
            eq(surveillanceAlerts.branchId, branch.id),
            gte(surveillanceAlerts.occurredAt, start),
            lt(surveillanceAlerts.occurredAt, end),
          ),
        )
        .orderBy(asc(surveillanceAlerts.severity), asc(surveillanceAlerts.occurredAt)),
      db
        .select()
        .from(surveillanceCameras)
        .where(and(eq(surveillanceCameras.branchId, branch.id), eq(surveillanceCameras.isActive, true)))
        .orderBy(asc(surveillanceCameras.cameraNumber)),
      db
        .select({
          cameraId: surveillanceCameraChecks.cameraId,
          status: surveillanceCameraChecks.status,
          isRecording: surveillanceCameraChecks.isRecording,
        })
        .from(surveillanceCameraChecks)
        .innerJoin(surveillanceCameras, eq(surveillanceCameras.id, surveillanceCameraChecks.cameraId))
        .where(
          and(
            eq(surveillanceCameras.branchId, branch.id),
            gte(surveillanceCameraChecks.checkedAt, start),
            lt(surveillanceCameraChecks.checkedAt, end),
          ),
        ),
      db
        .select({
          name: inventoryItems.name,
          unit: inventoryItems.unit,
          quantity: inventoryMovements.quantity,
          notes: inventoryMovements.notes,
        })
        .from(inventoryMovements)
        .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryMovements.itemId))
        .where(
          and(
            eq(inventoryMovements.branchId, branch.id),
            eq(inventoryMovements.businessDate, date),
            eq(inventoryMovements.reason, "waste"),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.branchId, branch.id),
            eq(inventoryMovements.businessDate, date),
            eq(inventoryMovements.movementType, "out"),
          ),
        ),
      db
        .select({
          employeeId: attendanceLogs.employeeId,
          type: attendanceLogs.type,
          serverTime: attendanceLogs.serverTime,
        })
        .from(attendanceLogs)
        .where(
          and(
            eq(attendanceLogs.branchId, branch.id),
            gte(attendanceLogs.serverTime, start),
            lt(attendanceLogs.serverTime, end),
            inArray(attendanceLogs.status, ["approved", "flagged"]),
          ),
        )
        .orderBy(asc(attendanceLogs.serverTime)),
      db.select().from(surveillancePrepTargets),
    ]);

  const targetOf = new Map(targets.map((t) => [t.itemName, t.maxMinutes]));
  const target = (item: string) => targetOf.get(item) ?? settings.defaultPrepMinutes;

  /* ١) المبيعات مقابل الطلبات المرصودة */
  const posSales = round2(closings.reduce((sum, row) => sum + (row.totalSales ?? 0), 0));
  const orderRefs = new Set(orders.map((o) => o.orderRef));
  const noInvoiceRefs = new Set(orders.filter((o) => !o.hasInvoice).map((o) => o.orderRef));
  const discrepancies: string[] = [];
  if (noInvoiceRefs.size > 0) {
    discrepancies.push(`${noInvoiceRefs.size} طلب مرصود بدون فاتورة: ${[...noInvoiceRefs].slice(0, 10).join("، ")}`);
  }
  if (closings.length === 0) discrepancies.push("لم يُرفع تقفيل كاشير لهذا اليوم بعد.");
  const drawerNoSale = posEvents.filter((e) => e.eventType === "drawer_no_sale").length;
  if (drawerNoSale > 0) discrepancies.push(`${drawerNoSale} فتح درج نقدي بدون بيع.`);
  const voids = posEvents.filter((e) => e.eventType !== "drawer_no_sale");
  if (voids.length > 0) {
    discrepancies.push(
      `${voids.length} عملية إلغاء/خصم/استرجاع بقيمة ${round2(voids.reduce((s, e) => s + e.amount, 0))} ريال.`,
    );
  }

  /* ٢) أوقات التجهيز */
  const timed = orders.filter((o) => o.prepSeconds !== null) as Array<
    (typeof orders)[number] & { prepSeconds: number }
  >;
  const stat = (rows: typeof timed) => ({
    count: rows.length,
    avgMinutes: rows.length ? minutes(rows.reduce((s, o) => s + o.prepSeconds, 0) / rows.length) : 0,
    maxMinutes: rows.length ? minutes(Math.max(...rows.map((o) => o.prepSeconds))) : 0,
  });
  const byPeriod = PERIODS.map((period) => {
    const rows = timed.filter((o) => {
      const hour = wallPartsInZone(o.registeredAt, tz).hour;
      return hour >= period.from && hour < period.to;
    });
    return { label: period.label, ...stat(rows) };
  }).filter((row) => row.count > 0);
  const itemNames = [...new Set(timed.map((o) => o.itemName || "بدون صنف"))];
  const byItem = itemNames
    .map((name) => {
      const rows = timed.filter((o) => (o.itemName || "بدون صنف") === name);
      const limit = target(name);
      return {
        item: name,
        targetMinutes: limit,
        overCount: rows.filter((o) => o.prepSeconds / 60 > limit).length,
        ...stat(rows),
      };
    })
    .sort((a, b) => b.avgMinutes - a.avgMinutes);
  const slowest = timed.reduce<(typeof timed)[number] | null>(
    (best, o) => (!best || o.prepSeconds > best.prepSeconds ? o : best),
    null,
  );

  /* ٣) الهدر */
  const wasteRows = [
    ...waste.map((w) => ({
      item: w.itemName,
      quantity: w.quantity,
      unit: w.unit,
      reason: LABELS.wasteReasons[w.reason as keyof typeof LABELS.wasteReasons] ?? w.reason,
      station: w.station || "—",
      source: "مرصود بالكاميرا",
    })),
    ...invWaste.map((w) => ({
      item: w.name,
      quantity: w.quantity,
      unit: w.unit,
      reason: w.notes || "هدر مسجّل في المخزون",
      station: "—",
      source: "حركة مخزون",
    })),
  ];

  /* ٤) و٥) الاشتباه ومشاكل العملاء */
  const employeeIds = new Set<number>();
  for (const a of alerts) for (const id of a.employeeIds ?? []) employeeIds.add(id);
  for (const o of orders) if (o.preparedByEmployeeId) employeeIds.add(o.preparedByEmployeeId);
  for (const e of posEvents) if (e.cashierEmployeeId) employeeIds.add(e.cashierEmployeeId);
  for (const w of waste) if (w.employeeId) employeeIds.add(w.employeeId);
  for (const a of attendance) employeeIds.add(a.employeeId);

  const people = employeeIds.size
    ? await db
        .select({
          id: employees.id,
          code: employees.employeeCode,
          name: employees.fullName,
          jobTitle: employees.jobTitle,
        })
        .from(employees)
        .where(inArray(employees.id, [...employeeIds]))
    : [];
  const personName = new Map(people.map((p) => [p.id, `${p.name} (${p.code})`]));
  const cameraNumber = new Map(cameras.map((c) => [c.id, c.cameraNumber]));

  const alertView = (a: (typeof alerts)[number]) => ({
    id: a.id,
    type: ALERT_TYPES[a.alertType]?.label ?? a.alertType,
    severity: LABELS.severity[a.severity as 1 | 2 | 3] ?? "متوسطة",
    time: timeOfDay(a.occurredAt, tz),
    camera: a.cameraId ? (cameraNumber.get(a.cameraId) ?? "—") : "—",
    location: a.location || "—",
    employees: [
      ...(a.employeeIds ?? []).map((id) => personName.get(id) ?? `#${id}`),
      a.peopleNote,
    ]
      .filter(Boolean)
      .join("، ") || "غير محدد",
    confidence: LABELS.confidence[a.confidence as keyof typeof LABELS.confidence] ?? a.confidence,
    status: LABELS.statuses[a.status as keyof typeof LABELS.statuses] ?? a.status,
    clipRef: a.clipRef || "—",
    details: a.details,
  });

  const suspicions = alerts.filter((a) => a.isSuspicion).map(alertView);
  const customerIssues = alerts.filter((a) => CUSTOMER_TYPES.includes(a.alertType)).map(alertView);

  /* ٦) أداء الموظفين */
  const violationTypes = new Set([
    "staff_phone",
    "station_left",
    "staff_gathering",
    "hygiene",
    "customer_complaint",
  ]);
  const staff = people
    .map((p) => {
      const logs = attendance.filter((a) => a.employeeId === p.id);
      const checkIn = logs.find((l) => l.type === "check_in")?.serverTime ?? null;
      const checkOut = [...logs].reverse().find((l) => l.type === "check_out")?.serverTime ?? null;
      const prepared = timed.filter((o) => o.preparedByEmployeeId === p.id);
      const own = alerts.filter((a) => (a.employeeIds ?? []).includes(p.id));
      const violations = own.filter((a) => violationTypes.has(a.alertType));
      const pos = posEvents.filter((e) => e.cashierEmployeeId === p.id);
      const notes = [...new Set(own.map((a) => ALERT_TYPES[a.alertType]?.label ?? a.alertType))];
      return {
        name: `${p.name} (${p.code})`,
        jobTitle: p.jobTitle || "—",
        checkIn: timeOfDay(checkIn, tz),
        checkOut: timeOfDay(checkOut, tz),
        commitment:
          violations.length === 0
            ? "ملتزم"
            : violations.length <= 2
              ? `ملاحظات (${violations.length})`
              : `يحتاج متابعة (${violations.length})`,
        productivity: prepared.length
          ? `${prepared.length} صنف، متوسط ${stat(prepared).avgMinutes} د`
          : pos.length
            ? `${pos.length} عملية كاشير حساسة`
            : "—",
        notes: notes.join("، ") || "لا توجد",
        suspicionCount: own.filter((a) => a.isSuspicion).length,
      };
    })
    .sort((a, b) => b.suspicionCount - a.suspicionCount || a.name.localeCompare(b.name, "ar"));

  /* ٧) حالة الكاميرات */
  const cameraRows = cameras.map((c) => {
    const todays = checks.filter((k) => k.cameraId === c.id);
    const issues = todays.filter((k) => k.status !== "online" || !k.isRecording).length;
    const checkedToday = c.lastCheckedAt !== null && c.lastCheckedAt >= start;
    return {
      number: c.cameraNumber,
      name: c.name || "—",
      zone: LABELS.zones[c.zone as keyof typeof LABELS.zones] ?? c.zone,
      status: LABELS.cameraStatuses[c.status as keyof typeof LABELS.cameraStatuses] ?? c.status,
      recording: c.isRecording ? "نعم" : "لا",
      checkedToday: checkedToday ? "نعم" : "لا",
      issuesToday: issues,
      blindSpots: c.blindSpots || "—",
      broken: c.status !== "unknown" && (c.status !== "online" || !c.isRecording),
    };
  });
  const brokenCameras = cameraRows.filter((c) => c.broken);
  const uncheckedCameras = cameraRows.filter((c) => c.checkedToday === "لا");

  /* ٨) التوصيات */
  const candidates: string[] = [];
  if (brokenCameras.length) {
    candidates.push(
      `إصلاح الكاميرات (${brokenCameras.map((c) => c.number).join("، ")}) والتأكد من التسجيل قبل بدء الدوام.`,
    );
  }
  const pendingSuspicions = alerts.filter((a) => a.isSuspicion && a.status === "needs_review").length;
  if (pendingSuspicions) {
    candidates.push(
      `مراجعة ${pendingSuspicions} حالة اشتباه بمقاطعها من قبل المالك أو المدير قبل أي إجراء.`,
    );
  }
  if (noInvoiceRefs.size) {
    candidates.push("تطبيق قاعدة: لا يخرج طلب من المطبخ دون فاتورة مطبوعة من فودكس.");
  }
  if (voids.length >= settings.repeatPosThreshold) {
    candidates.push("اشتراط موافقة المشرف على كل إلغاء أو خصم أو استرجاع.");
  }
  const worstItem = byItem.find((i) => i.avgMinutes > i.targetMinutes);
  if (worstItem) {
    const busiest = [...byPeriod].sort((a, b) => b.avgMinutes - a.avgMinutes)[0];
    candidates.push(
      `تسريع تجهيز «${worstItem.item}» (متوسط ${worstItem.avgMinutes} د مقابل حد ${worstItem.targetMinutes} د) بتحضير مسبق${busiest ? ` وتعزيز المحطة في ${busiest.label}` : ""}.`,
    );
  }
  if (wasteRows.length) {
    const reasons = new Map<string, number>();
    for (const w of wasteRows) reasons.set(w.reason, (reasons.get(w.reason) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0][0];
    candidates.push(`خفض الهدر: السبب الأكثر «${top}» — ضبط كميات التحضير حسب مبيعات الأمس.`);
  }
  if (customerIssues.length) {
    candidates.push("تعزيز الصالة في وقت الذروة وتعيين موظف لمتابعة الطابور والطاولات المنتظرة.");
  }
  if (alerts.some((a) => a.alertType === "hygiene")) {
    candidates.push("تفتيش الزي والقفازات وغطاء الرأس ونظافة المحطات في بداية كل وردية.");
  }
  if (alerts.some((a) => a.alertType === "staff_phone")) {
    candidates.push("حفظ الجوالات في الخزانة أثناء الوردية.");
  }
  if (uncheckedCameras.length) {
    candidates.push(`تسجيل الفحص اليومي لكل الكاميرات (${uncheckedCameras.length} لم تُفحص اليوم).`);
  }
  candidates.push(
    "مطابقة المصروف من المستودع مع مبيعات فودكس في نهاية كل وردية.",
    "مراجعة أوقات تجهيز الأصناف الأعلى طلباً وتحديث الحدود المعتمدة.",
    "فحص الكاميرات وتسجيل حالتها في بداية اليوم.",
  );
  const recommendations = [...new Set(candidates)].slice(0, 3);

  return {
    branch: { id: branch.id, name: branch.name },
    date,
    generatedAt: new Date().toISOString(),
    sales: {
      posSales,
      closings: closings.length,
      observedOrders: orderRefs.size,
      observedItems: orders.length,
      ordersWithoutInvoice: noInvoiceRefs.size,
      warehouseOutMovements: invOut[0]?.count ?? 0,
      discrepancies,
    },
    prep: {
      overall: stat(timed),
      slowest: slowest
        ? {
            orderRef: slowest.orderRef,
            item: slowest.itemName || "—",
            minutes: minutes(slowest.prepSeconds),
            time: timeOfDay(slowest.registeredAt, tz),
          }
        : null,
      byPeriod,
      byItem,
    },
    waste: wasteRows,
    suspicions,
    customerIssues,
    staff: staff.map(({ suspicionCount: _ignored, ...row }) => row),
    cameras: cameraRows.map(({ broken: _broken, ...row }) => row),
    counts: {
      alerts: alerts.length,
      urgent: alerts.filter((a) => a.isUrgent).length,
      needsReview: alerts.filter((a) => a.status === "needs_review").length,
    },
    recommendations,
    disclaimer:
      "كل حالة اشتباه في هذا التقرير «اشتباه يحتاج مراجعة» وليست حكماً نهائياً، ولا يُتّخذ أي إجراء ضد موظف قبل مراجعة المالك أو المدير البشري للمقطع.",
  };
}

/* ── المسارات: البيانات المرجعية ──────────────────────────────── */

const canRead = [requireAuth, requirePermission(PERMISSIONS.surveillanceRead), requireModuleLevel(MODULE, 1)];
const canWrite = [requireAuth, requirePermission(PERMISSIONS.surveillanceWrite), requireModuleLevel(MODULE, 2)];
const canManage = [requireAuth, requirePermission(PERMISSIONS.surveillanceManage), requireModuleLevel(MODULE, 3)];
const canReview = [requireAuth, requirePermission(PERMISSIONS.surveillanceReview), requireModuleLevel(MODULE, 4)];
const canDelete = [requireAuth, requirePermission(PERMISSIONS.surveillanceDelete), requireModuleDelete(MODULE)];

function handleInputError(res: Response, error: unknown): boolean {
  if (error instanceof InputError) {
    res.status(400).json({ ok: false, error: error.message });
    return true;
  }
  return false;
}

surveillanceRouter.get("/surveillance/meta", ...canRead, async (req: AuthedRequest, res: Response) => {
  const db = getDb();
  const [branchRows, people, targets] = await Promise.all([
    db
      .select({ id: branches.id, name: branches.name, code: branches.code, timezone: branches.timezone })
      .from(branches)
      .orderBy(asc(branches.name)),
    db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        jobTitle: employees.jobTitle,
        department: employees.department,
        branchId: employees.branchId,
      })
      .from(employees)
      .where(eq(employees.isActive, true))
      .orderBy(asc(employees.fullName)),
    db.select().from(surveillancePrepTargets).orderBy(asc(surveillancePrepTargets.itemName)),
  ]);
  const branchId = branchIdFrom(req, req.query.branchId) ?? branchRows[0]?.id ?? null;

  res.json({
    ok: true,
    branchId,
    branches: branchRows,
    employees: people,
    prepTargets: targets,
    settings: branchId ? await settingsFor(branchId) : null,
    alertTypes: ALERT_TYPE_KEYS.map((key) => ({ key, ...ALERT_TYPES[key] })),
    labels: LABELS,
    webhookEnabled: Boolean(process.env.SURVEILLANCE_WEBHOOK_SECRET),
    visionModel: VISION_MODEL,
    siteUrl: process.env.URL ?? "",
    access: {
      canWrite: await hasModuleLevel(req, MODULE, 2),
      canManage: await hasModuleLevel(req, MODULE, 3),
      canReview: await hasModuleLevel(req, MODULE, 4),
      canDelete: await hasModuleDelete(req, MODULE),
    },
  });
});

/* ── الكاميرات ────────────────────────────────────────────────── */

surveillanceRouter.get("/surveillance/cameras", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branchId = branchIdFrom(req, req.query.branchId);
  if (branchId === null) {
    res.json({ ok: true, cameras: [] });
    return;
  }
  const db = getDb();
  const cameras = await db
    .select()
    .from(surveillanceCameras)
    .where(eq(surveillanceCameras.branchId, branchId))
    .orderBy(asc(surveillanceCameras.cameraNumber));
  res.json({ ok: true, cameras: cameras.map(publicCamera) });
});

type CameraRecord = typeof surveillanceCameras.$inferSelect;

/** الكاميرا كما تُعرض — بلا كلمة المرور المشفّرة. */
function publicCamera(camera: CameraRecord) {
  const { snapshotPasswordEnc, ...rest } = camera;
  return { ...rest, hasPassword: snapshotPasswordEnc !== "" };
}

const CONNECTION_MODES = ["agent", "pull"] as const;

function cameraFields(body: Record<string, unknown>, before?: CameraRecord) {
  const interval = asNumber(body.intervalMinutes);
  const password = typeof body.snapshotPassword === "string" ? body.snapshotPassword : "";
  const snapshotUrl = asString(body.snapshotUrl, 500) ?? before?.snapshotUrl ?? "";
  return {
    name: asString(body.name, 150) ?? "",
    zone: asEnum(body.zone, ZONES),
    location: asString(body.location, 300) ?? "",
    blindSpots: asString(body.blindSpots, 1000) ?? "",
    notes: asString(body.notes, 1000) ?? "",
    isActive: asBool(body.isActive) ?? true,
    autoDetect: asBool(body.autoDetect) ?? before?.autoDetect ?? false,
    connectionMode: asEnum(body.connectionMode, CONNECTION_MODES) ?? before?.connectionMode ?? "agent",
    snapshotUrl,
    snapshotUsername: asString(body.snapshotUsername, 100) ?? before?.snapshotUsername ?? "",
    snapshotPasswordEnc:
      body.clearPassword === true
        ? ""
        : password
          ? encryptString(password.slice(0, 200))
          : (before?.snapshotPasswordEnc ?? ""),
    intervalMinutes:
      interval !== null && interval >= 1 && interval <= 120
        ? Math.round(interval)
        : (before?.intervalMinutes ?? 5),
  };
}

function cameraFieldsError(fields: ReturnType<typeof cameraFields>): string | null {
  if (fields.snapshotUrl && !/^https?:\/\//i.test(fields.snapshotUrl)) {
    return "رابط اللقطة يجب أن يبدأ بـ http:// أو https://";
  }
  if (fields.autoDetect && !fields.snapshotUrl) {
    return "أدخل رابط لقطة الكاميرا لتشغيل الكشف الآلي";
  }
  return null;
}

surveillanceRouter.post("/surveillance/cameras", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const cameraNumber = asString(body.cameraNumber, 50);
  if (!cameraNumber) {
    res.status(400).json({ ok: false, error: "رقم الكاميرا مطلوب" });
    return;
  }
  const fields = cameraFields(body);
  if (!fields.zone) {
    res.status(400).json({ ok: false, error: "اختر منطقة الكاميرا" });
    return;
  }
  if (isPrivateArea(cameraNumber, fields.name, fields.location)) {
    res.status(400).json({ ok: false, error: PRIVACY_ERROR });
    return;
  }
  const fieldsError = cameraFieldsError(fields);
  if (fieldsError) {
    res.status(400).json({ ok: false, error: fieldsError });
    return;
  }
  const db = getDb();
  const [existing] = await db
    .select({ id: surveillanceCameras.id })
    .from(surveillanceCameras)
    .where(
      and(eq(surveillanceCameras.branchId, branch.id), eq(surveillanceCameras.cameraNumber, cameraNumber)),
    );
  if (existing) {
    res.status(409).json({ ok: false, error: "رقم الكاميرا مسجّل في هذا الفرع" });
    return;
  }
  const [camera] = await db
    .insert(surveillanceCameras)
    .values({ branchId: branch.id, cameraNumber, ...fields, zone: fields.zone })
    .returning();
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "surveillance.camera_create",
    entityType: "surveillance_camera",
    entityId: camera.id,
    after: publicCamera(camera),
    ipAddress: clientIp(req),
  });
  res.status(201).json({ ok: true, camera: publicCamera(camera) });
});

surveillanceRouter.patch(
  "/surveillance/cameras/:id",
  ...canManage,
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    const db = getDb();
    const [before] = id
      ? await db.select().from(surveillanceCameras).where(eq(surveillanceCameras.id, id))
      : [];
    if (!before) {
      res.status(404).json({ ok: false, error: "الكاميرا غير موجودة" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = cameraFields(body, before);
    const cameraNumber = asString(body.cameraNumber, 50) || before.cameraNumber;
    if (isPrivateArea(cameraNumber, fields.name, fields.location)) {
      res.status(400).json({ ok: false, error: PRIVACY_ERROR });
      return;
    }
    const fieldsError = cameraFieldsError(fields);
    if (fieldsError) {
      res.status(400).json({ ok: false, error: fieldsError });
      return;
    }
    if (cameraNumber !== before.cameraNumber) {
      const [clash] = await db
        .select({ id: surveillanceCameras.id })
        .from(surveillanceCameras)
        .where(
          and(
            eq(surveillanceCameras.branchId, before.branchId),
            eq(surveillanceCameras.cameraNumber, cameraNumber),
          ),
        );
      if (clash) {
        res.status(409).json({ ok: false, error: "رقم الكاميرا مسجّل في هذا الفرع" });
        return;
      }
    }
    const [camera] = await db
      .update(surveillanceCameras)
      .set({ ...fields, cameraNumber, zone: fields.zone ?? before.zone, updatedAt: new Date() })
      .where(eq(surveillanceCameras.id, before.id))
      .returning();
    await recordAudit({
      actorEmployeeId: req.employee!.id,
      action: "surveillance.camera_update",
      entityType: "surveillance_camera",
      entityId: camera.id,
      before: publicCamera(before),
      after: publicCamera(camera),
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, camera: publicCamera(camera) });
  },
);

surveillanceRouter.delete(
  "/surveillance/cameras/:id",
  ...canDelete,
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    const db = getDb();
    const [deleted] = id
      ? await db.delete(surveillanceCameras).where(eq(surveillanceCameras.id, id)).returning()
      : [];
    if (!deleted) {
      res.status(404).json({ ok: false, error: "الكاميرا غير موجودة" });
      return;
    }
    await recordAudit({
      actorEmployeeId: req.employee!.id,
      action: "surveillance.camera_delete",
      entityType: "surveillance_camera",
      entityId: deleted.id,
      before: publicCamera(deleted),
      ipAddress: clientIp(req),
    });
    res.json({ ok: true });
  },
);

surveillanceRouter.post(
  "/surveillance/cameras/:id/checks",
  ...canWrite,
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    const db = getDb();
    const [camera] = id
      ? await db.select().from(surveillanceCameras).where(eq(surveillanceCameras.id, id))
      : [];
    if (!camera) {
      res.status(404).json({ ok: false, error: "الكاميرا غير موجودة" });
      return;
    }
    const branch = (await loadBranch(camera.branchId))!;
    try {
      const result = await ingestCameraCheck(branch, camera.id, req.body ?? {}, "manual", req.employee!.id);
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      if (!handleInputError(res, error)) throw error;
    }
  },
);

/* ── التنبيهات ────────────────────────────────────────────────── */

surveillanceRouter.get("/surveillance/alerts", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdFrom(req, req.query.branchId));
  if (!branch) {
    res.json({ ok: true, alerts: [] });
    return;
  }
  const from = asDateOnly(req.query.from) ?? dateOrToday(undefined, branch.timezone);
  const to = asDateOnly(req.query.to) ?? from;
  if (to < from) {
    res.status(400).json({ ok: false, error: "تاريخ النهاية قبل تاريخ البداية" });
    return;
  }
  const start = dayRange(from, branch.timezone).start;
  const end = dayRange(to, branch.timezone).end;

  const filters = [
    eq(surveillanceAlerts.branchId, branch.id),
    gte(surveillanceAlerts.occurredAt, start),
    lt(surveillanceAlerts.occurredAt, end),
  ];
  const status = asEnum(req.query.status, ALERT_STATUSES);
  if (status) filters.push(eq(surveillanceAlerts.status, status));
  const type = asEnum(req.query.type, ALERT_TYPE_KEYS);
  if (type) filters.push(eq(surveillanceAlerts.alertType, type));
  const role = asEnum(req.query.role, ROLES);
  if (role) filters.push(eq(surveillanceAlerts.role, role));
  if (req.query.urgent === "1") filters.push(eq(surveillanceAlerts.isUrgent, true));
  const employeeFilter = asId(req.query.employeeId);
  if (employeeFilter) filters.push(sql`${employeeFilter} = any(${surveillanceAlerts.employeeIds})`);
  const cameraFilter = asId(req.query.cameraId);
  if (cameraFilter) filters.push(eq(surveillanceAlerts.cameraId, cameraFilter));

  const db = getDb();
  const reviewer = employees;
  const alerts = await db
    .select({
      alert: surveillanceAlerts,
      cameraNumber: surveillanceCameras.cameraNumber,
      reviewerName: reviewer.fullName,
    })
    .from(surveillanceAlerts)
    .leftJoin(surveillanceCameras, eq(surveillanceCameras.id, surveillanceAlerts.cameraId))
    .leftJoin(reviewer, eq(reviewer.id, surveillanceAlerts.reviewedByEmployeeId))
    .where(and(...filters))
    .orderBy(desc(surveillanceAlerts.occurredAt))
    .limit(500);

  res.json({
    ok: true,
    from,
    to,
    alerts: alerts.map((row) => ({
      ...row.alert,
      cameraNumber: row.cameraNumber,
      reviewerName: row.reviewerName,
    })),
  });
});

surveillanceRouter.post("/surveillance/alerts", ...canWrite, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const alertType = asEnum(body.alertType, ALERT_TYPE_KEYS);
  if (!alertType) {
    res.status(400).json({ ok: false, error: "اختر نوع الحالة" });
    return;
  }
  const occurredAt = asDateTime(body.occurredAt);
  if (!occurredAt) {
    res.status(400).json({ ok: false, error: "التاريخ والوقت مطلوبان" });
    return;
  }
  const camera = await cameraInBranch(asId(body.cameraId), branch.id);
  try {
    const result = await createAlert({
      branchId: branch.id,
      alertType,
      cameraId: camera?.id ?? null,
      occurredAt,
      location: asString(body.location, 300) ?? "",
      employeeIds: asIdList(body.employeeIds),
      peopleNote: asString(body.peopleNote, 500) ?? "",
      confidence: asString(body.confidence, 10) ?? "medium",
      clipRef:
        asString(body.clipRef, 500) || defaultClipRef(camera?.cameraNumber, occurredAt, branch.timezone),
      details: asString(body.details, 2000) ?? "",
      suggestedAction: asString(body.suggestedAction, 1000) ?? "",
      role: asString(body.role, 20),
      severity: asNumber(body.severity),
      source: "manual",
      createdBy: req.employee!.id,
    });
    await recordAudit({
      actorEmployeeId: req.employee!.id,
      action: "surveillance.alert_create",
      entityType: "surveillance_alert",
      entityId: result.id,
      after: { alertType, branchId: branch.id },
      ipAddress: clientIp(req),
    });
    res.status(201).json({ ok: true, id: result.id });
  } catch (error) {
    if (!handleInputError(res, error)) throw error;
  }
});

/** المراجعة البشرية: القرار الوحيد الذي يحسم حالة الاشتباه. */
surveillanceRouter.post(
  "/surveillance/alerts/:id/review",
  ...canReview,
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = asEnum(body.decision, REVIEW_DECISIONS);
    const note = asString(body.note, 1000);
    if (!decision) {
      res.status(400).json({ ok: false, error: "اختر نتيجة المراجعة" });
      return;
    }
    if (!note) {
      res.status(400).json({ ok: false, error: "اكتب ملاحظة المراجعة (ما الذي شوهد في المقطع)" });
      return;
    }
    const db = getDb();
    const [before] = id
      ? await db.select().from(surveillanceAlerts).where(eq(surveillanceAlerts.id, id))
      : [];
    if (!before) {
      res.status(404).json({ ok: false, error: "التنبيه غير موجود" });
      return;
    }
    const [alert] = await db
      .update(surveillanceAlerts)
      .set({
        status: decision,
        reviewNote: note,
        reviewedByEmployeeId: req.employee!.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(surveillanceAlerts.id, before.id))
      .returning();
    await recordAudit({
      actorEmployeeId: req.employee!.id,
      action: "surveillance.alert_review",
      entityType: "surveillance_alert",
      entityId: alert.id,
      before: { status: before.status },
      after: { status: alert.status },
      reason: note,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, alert });
  },
);

/* ── سجلات اليوم: الطلبات، أحداث الكاشير، الهدر ───────────────── */

async function dayQuery(req: AuthedRequest) {
  const branch = await loadBranch(branchIdFrom(req, req.query.branchId));
  if (!branch) return null;
  const date = dateOrToday(req.query.date, branch.timezone);
  return { branch, date, ...dayRange(date, branch.timezone) };
}

surveillanceRouter.get("/surveillance/orders", ...canRead, async (req: AuthedRequest, res: Response) => {
  const day = await dayQuery(req);
  if (!day) {
    res.json({ ok: true, orders: [] });
    return;
  }
  const db = getDb();
  const orders = await db
    .select({ order: surveillanceOrders, preparedBy: employees.fullName })
    .from(surveillanceOrders)
    .leftJoin(employees, eq(employees.id, surveillanceOrders.preparedByEmployeeId))
    .where(
      and(
        eq(surveillanceOrders.branchId, day.branch.id),
        gte(surveillanceOrders.registeredAt, day.start),
        lt(surveillanceOrders.registeredAt, day.end),
      ),
    )
    .orderBy(desc(surveillanceOrders.registeredAt));
  res.json({
    ok: true,
    date: day.date,
    orders: orders.map((row) => ({ ...row.order, preparedBy: row.preparedBy })),
  });
});

surveillanceRouter.post("/surveillance/orders", ...canWrite, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.body?.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  try {
    const result = await ingestOrder(branch, req.body ?? {}, "manual", req.employee!.id);
    res.status(201).json({ ok: true, id: result.order.id, alerts: result.alerts });
  } catch (error) {
    if (!handleInputError(res, error)) throw error;
  }
});

surveillanceRouter.get("/surveillance/pos-events", ...canRead, async (req: AuthedRequest, res: Response) => {
  const day = await dayQuery(req);
  if (!day) {
    res.json({ ok: true, events: [] });
    return;
  }
  const db = getDb();
  const events = await db
    .select({ event: surveillancePosEvents, cashier: employees.fullName })
    .from(surveillancePosEvents)
    .leftJoin(employees, eq(employees.id, surveillancePosEvents.cashierEmployeeId))
    .where(
      and(
        eq(surveillancePosEvents.branchId, day.branch.id),
        gte(surveillancePosEvents.occurredAt, day.start),
        lt(surveillancePosEvents.occurredAt, day.end),
      ),
    )
    .orderBy(desc(surveillancePosEvents.occurredAt));
  res.json({
    ok: true,
    date: day.date,
    events: events.map((row) => ({ ...row.event, cashier: row.cashier || row.event.cashierName })),
  });
});

surveillanceRouter.post("/surveillance/pos-events", ...canWrite, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.body?.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  try {
    const result = await ingestPosEvent(branch, req.body ?? {}, "manual", req.employee!.id);
    res.status(201).json({ ok: true, id: result.event.id, alerts: result.alerts });
  } catch (error) {
    if (!handleInputError(res, error)) throw error;
  }
});

surveillanceRouter.get("/surveillance/waste", ...canRead, async (req: AuthedRequest, res: Response) => {
  const day = await dayQuery(req);
  if (!day) {
    res.json({ ok: true, waste: [] });
    return;
  }
  const db = getDb();
  const waste = await db
    .select({ waste: surveillanceWaste, employee: employees.fullName })
    .from(surveillanceWaste)
    .leftJoin(employees, eq(employees.id, surveillanceWaste.employeeId))
    .where(
      and(
        eq(surveillanceWaste.branchId, day.branch.id),
        gte(surveillanceWaste.occurredAt, day.start),
        lt(surveillanceWaste.occurredAt, day.end),
      ),
    )
    .orderBy(desc(surveillanceWaste.occurredAt));
  res.json({
    ok: true,
    date: day.date,
    waste: waste.map((row) => ({ ...row.waste, employee: row.employee })),
  });
});

surveillanceRouter.post("/surveillance/waste", ...canWrite, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const itemName = asString(body.itemName, 150);
  const quantity = asNumber(body.quantity);
  if (!itemName || quantity === null || quantity <= 0) {
    res.status(400).json({ ok: false, error: "الصنف والكمية مطلوبان" });
    return;
  }
  const station = asString(body.station, 150) ?? "";
  if (isPrivateArea(station)) {
    res.status(400).json({ ok: false, error: PRIVACY_ERROR });
    return;
  }
  const db = getDb();
  const camera = await cameraInBranch(asId(body.cameraId), branch.id);
  const [row] = await db
    .insert(surveillanceWaste)
    .values({
      branchId: branch.id,
      occurredAt: asDateTime(body.occurredAt) ?? new Date(),
      itemName,
      quantity,
      unit: asString(body.unit, 30) ?? "",
      reason: asEnum(body.reason, WASTE_REASONS) ?? "other",
      station,
      cameraId: camera?.id ?? null,
      employeeId: asId(body.employeeId),
      notes: asString(body.notes, 500) ?? "",
      createdByEmployeeId: req.employee!.id,
    })
    .returning();
  res.status(201).json({ ok: true, id: row.id });
});

const DELETABLE = {
  alerts: surveillanceAlerts,
  orders: surveillanceOrders,
  "pos-events": surveillancePosEvents,
  waste: surveillanceWaste,
} as const;

for (const kind of Object.keys(DELETABLE) as Array<keyof typeof DELETABLE>) {
  surveillanceRouter.delete(
  `/surveillance/${kind}/:id`,
  ...canDelete,
  async (req: AuthedRequest, res: Response) => {
    const table = DELETABLE[kind];
    const id = asId(req.params.id);
    const db = getDb();
    const [deleted] = id ? await db.delete(table).where(eq(table.id, id)).returning() : [];
    if (!deleted) {
      res.status(404).json({ ok: false, error: "السجل غير موجود" });
      return;
    }
    await recordAudit({
      actorEmployeeId: req.employee!.id,
      action: `surveillance.${kind}_delete`,
      entityType: `surveillance_${kind}`,
      entityId: deleted.id,
      before: deleted,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true });
  },
  );
}

/* ── الحدود المعتمدة ──────────────────────────────────────────── */

surveillanceRouter.put("/surveillance/settings", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const defaultPrepMinutes = asNumber(body.defaultPrepMinutes);
  const customerWaitMinutes = asNumber(body.customerWaitMinutes);
  const repeatPosThreshold = asNumber(body.repeatPosThreshold);
  if (
    defaultPrepMinutes === null ||
    defaultPrepMinutes <= 0 ||
    customerWaitMinutes === null ||
    customerWaitMinutes <= 0 ||
    repeatPosThreshold === null ||
    repeatPosThreshold < 1
  ) {
    res.status(400).json({ ok: false, error: "أدخل قيماً موجبة لكل الحدود" });
    return;
  }
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const current = await settingsFor(branch.id);
  const openTime = asString(body.openTime, 5) || current.openTime;
  const closeTime = asString(body.closeTime, 5) || current.closeTime;
  if (!hhmm.test(openTime) || !hhmm.test(closeTime)) {
    res.status(400).json({ ok: false, error: "ساعات العمل بصيغة HH:MM" });
    return;
  }
  const alertEmails =
    body.alertEmails === undefined
      ? current.alertEmails
      : (asString(body.alertEmails, 500) ?? "")
          .split(/[,،\s]+/)
          .filter((item) => item.includes("@"))
          .join(", ");
  const analyzeOpenHoursOnly =
    body.analyzeOpenHoursOnly === undefined
      ? current.analyzeOpenHoursOnly
      : body.analyzeOpenHoursOnly === true || body.analyzeOpenHoursOnly === "true";
  const capInput = body.dailyAnalysisCap === undefined || body.dailyAnalysisCap === "" ? current.dailyAnalysisCap : asNumber(body.dailyAnalysisCap);
  if (capInput === null || capInput < 0) {
    res.status(400).json({ ok: false, error: "الحد اليومي للتحليل رقم صفر أو أكبر (صفر = بلا حد)" });
    return;
  }
  const values = {
    defaultPrepMinutes,
    customerWaitMinutes,
    repeatPosThreshold: Math.round(repeatPosThreshold),
    openTime,
    closeTime,
    alertEmails,
    analyzeOpenHoursOnly,
    dailyAnalysisCap: Math.round(capInput),
    updatedAt: new Date(),
  };
  const db = getDb();
  await db
    .insert(surveillanceSettings)
    .values({ branchId: branch.id, ...values })
    .onConflictDoUpdate({ target: surveillanceSettings.branchId, set: values });
  res.json({ ok: true, settings: await settingsFor(branch.id) });
});

surveillanceRouter.put("/surveillance/prep-targets", ...canManage, async (req: AuthedRequest, res: Response) => {
  const itemName = asString(req.body?.itemName, 150);
  const maxMinutes = asNumber(req.body?.maxMinutes);
  if (!itemName || maxMinutes === null || maxMinutes <= 0) {
    res.status(400).json({ ok: false, error: "اسم الصنف والحد بالدقائق مطلوبان" });
    return;
  }
  const db = getDb();
  const [target] = await db
    .insert(surveillancePrepTargets)
    .values({ itemName, maxMinutes })
    .onConflictDoUpdate({
      target: surveillancePrepTargets.itemName,
      set: { maxMinutes, updatedAt: new Date() },
    })
    .returning();
  res.json({ ok: true, target });
});

surveillanceRouter.delete(
  "/surveillance/prep-targets/:id",
  ...canManage,
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    const db = getDb();
    if (id) await db.delete(surveillancePrepTargets).where(eq(surveillancePrepTargets.id, id));
    res.json({ ok: true });
  },
);

/* ── التقرير اليومي ───────────────────────────────────────────── */

/** يعرض التقرير المحفوظ إن وُجد، وإلا معاينة حيّة غير محفوظة. */
surveillanceRouter.get("/surveillance/daily-report", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdFrom(req, req.query.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const date = dateOrToday(req.query.date, branch.timezone);
  const db = getDb();
  const [saved] = await db
    .select()
    .from(surveillanceDailyReports)
    .where(
      and(eq(surveillanceDailyReports.branchId, branch.id), eq(surveillanceDailyReports.businessDate, date)),
    );
  if (saved && req.query.live !== "1") {
    res.json({ ok: true, saved: true, savedAt: saved.generatedAt, report: JSON.parse(saved.reportJson) });
    return;
  }
  res.json({ ok: true, saved: false, hasSaved: Boolean(saved), report: await buildDailyReport(branch, date) });
});

/** يُصدر التقرير ويحفظ لقطته (إصدار جديد لنفس اليوم يستبدل السابق). */
surveillanceRouter.post("/surveillance/daily-report", ...canManage, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(asId(req.body?.branchId));
  if (!branch) {
    res.status(400).json({ ok: false, error: "اختر الفرع" });
    return;
  }
  const date = dateOrToday(req.body?.date, branch.timezone);
  const report = await buildDailyReport(branch, date);
  const db = getDb();
  const values = {
    reportJson: JSON.stringify(report),
    generatedByEmployeeId: req.employee!.id,
    generatedAt: new Date(),
  };
  await db
    .insert(surveillanceDailyReports)
    .values({ branchId: branch.id, businessDate: date, ...values })
    .onConflictDoUpdate({
      target: [surveillanceDailyReports.branchId, surveillanceDailyReports.businessDate],
      set: values,
    });
  res.json({ ok: true, saved: true, report });
});

/* ── نقطة الاستقبال الآلية (NVR / نقطة البيع) ─────────────────── */

export function webhookAuthorized(req: Request): boolean {
  const secret = process.env.SURVEILLANCE_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = req.headers["x-surveillance-key"];
  const provided = Buffer.from(String(Array.isArray(header) ? header[0] : (header ?? "")));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * يستقبل حدثاً واحداً أو قائمة `events`. كل حدث يحمل `kind`:
 *   • `alert`         — تنبيه جاهز (alertType، cameraNumber، occurredAt، confidence، clipRef…)
 *   • `camera_status` — حالة كاميرا (cameraNumber، status، isRecording)
 *   • `order`         — طلب (orderRef، itemName، registeredAt، deliveredAt، hasInvoice)
 *   • `pos_event`     — حدث كاشير (eventType، cashierCode، amount، orderRef)
 * والفرع يُحدَّد بـ`branchCode` أو `branchId` في الحدث أو في جسم الطلب.
 */
surveillanceRouter.post("/surveillance/webhook", async (req: Request, res: Response) => {
  if (!process.env.SURVEILLANCE_WEBHOOK_SECRET) {
    res.status(503).json({ ok: false, error: "نقطة الاستقبال غير مفعّلة" });
    return;
  }
  if (!webhookAuthorized(req)) {
    res.status(401).json({ ok: false, error: "مفتاح غير صحيح" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const events = (Array.isArray(body.events) ? body.events : [body]).slice(0, 200) as Array<
    Record<string, unknown>
  >;
  const db = getDb();
  const results: Array<{ index: number; ok: boolean; error?: string; alerts?: number[] }> = [];

  for (const [index, event] of events.entries()) {
    try {
      const branchCode = asString(event.branchCode ?? body.branchCode, 50);
      let branch = await loadBranch(asId(event.branchId ?? body.branchId));
      if (!branch && branchCode) {
        [branch] = await db.select().from(branches).where(eq(branches.code, branchCode));
      }
      if (!branch) throw new InputError("الفرع غير معروف");

      const kind = asString(event.kind, 30);
      if (kind === "order") {
        const result = await ingestOrder(branch, event, "webhook", null);
        results.push({ index, ok: true, alerts: result.alerts });
      } else if (kind === "pos_event") {
        const result = await ingestPosEvent(branch, event, "webhook", null);
        results.push({ index, ok: true, alerts: result.alerts });
      } else if (kind === "camera_status") {
        const camera = await cameraByNumber(branch.id, asString(event.cameraNumber, 50));
        if (!camera) throw new InputError("رقم الكاميرا غير مسجّل");
        const result = await ingestCameraCheck(branch, camera.id, event, "webhook", null);
        results.push({ index, ok: true, alerts: result.alertId ? [result.alertId] : [] });
      } else if (kind === "alert") {
        const alertType = asEnum(event.alertType, ALERT_TYPE_KEYS);
        if (!alertType) throw new InputError("نوع الحالة غير معروف");
        const camera = await cameraByNumber(branch.id, asString(event.cameraNumber, 50));
        const occurredAt = asDateTime(event.occurredAt) ?? new Date();
        const employeeCodes = Array.isArray(event.employeeCodes) ? event.employeeCodes : [];
        const employeeIds: number[] = [];
        for (const code of employeeCodes.slice(0, 30)) {
          const id = await employeeByCode(asString(code, 50));
          if (id) employeeIds.push(id);
        }
        const result = await createAlert({
          branchId: branch.id,
          alertType,
          cameraId: camera?.id ?? null,
          occurredAt,
          location: asString(event.location, 300) ?? "",
          employeeIds,
          peopleNote: asString(event.peopleNote, 500) ?? "",
          confidence: asString(event.confidence, 10) ?? "medium",
          clipRef:
            asString(event.clipRef, 500) ||
            defaultClipRef(camera?.cameraNumber, occurredAt, branch.timezone),
          details: asString(event.details, 2000) ?? "",
          suggestedAction: asString(event.suggestedAction, 1000) ?? "",
          source: "webhook",
          sourceRef: asString(event.eventId, 150) ? `webhook:${asString(event.eventId, 150)}` : "",
        });
        results.push({ index, ok: true, alerts: [result.id] });
      } else {
        throw new InputError("نوع الحدث غير معروف (alert | camera_status | order | pos_event)");
      }
    } catch (error) {
      if (error instanceof InputError) results.push({ index, ok: false, error: error.message });
      else throw error;
    }
  }

  res.json({ ok: results.every((r) => r.ok), results });
});

/* ══ الكشف الآلي: الفحص الفوري، الزاوية المرجعية، اللقطات، جهاز الربط ══ */

async function cameraWithBranch(id: number | null) {
  if (id === null) return null;
  const db = getDb();
  const [row] = await db
    .select({ camera: surveillanceCameras, branch: branches })
    .from(surveillanceCameras)
    .innerJoin(branches, eq(branches.id, surveillanceCameras.branchId))
    .where(eq(surveillanceCameras.id, id));
  return row ?? null;
}

/** فحص فوري: الخادم يجلب اللقطة (pull) أو يطلبها من جهاز الربط في دورته التالية. */
surveillanceRouter.post(
  "/surveillance/cameras/:id/test",
  ...canManage,
  async (req: AuthedRequest, res: Response) => {
    const row = await cameraWithBranch(asId(req.params.id));
    if (!row) {
      res.status(404).json({ ok: false, error: "الكاميرا غير موجودة" });
      return;
    }
    const { camera, branch } = row;
    if (!camera.snapshotUrl) {
      res.status(400).json({ ok: false, error: "أدخل رابط لقطة الكاميرا أولاً" });
      return;
    }
    const db = getDb();
    if (camera.connectionMode === "agent") {
      await db
        .update(surveillanceCameras)
        .set({ lastAnalysisAt: null })
        .where(eq(surveillanceCameras.id, camera.id));
      res.json({
        ok: true,
        queued: true,
        message: "طُلبت لقطة من جهاز الربط — تظهر النتيجة خلال دقيقة إن كان الجهاز يعمل.",
      });
      return;
    }
    let image: { data: Buffer; contentType: string } | null = null;
    let error = "";
    try {
      image = await fetchSnapshot(camera.snapshotUrl, camera.snapshotUsername, cameraPassword(camera));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const result = await processFrame({ camera, branch, image, error, source: "test" });
    res.json({ ok: true, result });
  },
);

/** اعتماد آخر لقطة سليمة زاويةً مرجعية لكشف تحريك الكاميرا. */
surveillanceRouter.post(
  "/surveillance/cameras/:id/reference",
  ...canManage,
  async (req: AuthedRequest, res: Response) => {
    const id = asId(req.params.id);
    const db = getDb();
    const [frame] = id
      ? await db
          .select()
          .from(surveillanceFrames)
          .where(
            and(
              eq(surveillanceFrames.cameraId, id),
              sql`${surveillanceFrames.imageKey} <> ''`,
            ),
          )
          .orderBy(desc(surveillanceFrames.capturedAt))
          .limit(1)
      : [];
    if (!frame) {
      res.status(400).json({ ok: false, error: "لا توجد لقطة محفوظة لهذه الكاميرا بعد — شغّل فحصاً أولاً" });
      return;
    }
    await db
      .update(surveillanceCameras)
      .set({ referenceKey: frame.imageKey, updatedAt: new Date() })
      .where(eq(surveillanceCameras.id, id!));
    await recordAudit({
      actorEmployeeId: req.employee!.id,
      action: "surveillance.camera_reference",
      entityType: "surveillance_camera",
      entityId: id,
      after: { frameId: frame.id },
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, frameId: frame.id });
  },
);

function frameView(frame: typeof surveillanceFrames.$inferSelect) {
  let analysis: unknown = null;
  try {
    analysis = frame.analysisJson ? JSON.parse(frame.analysisJson) : null;
  } catch {
    analysis = null;
  }
  const { analysisJson: _raw, ...rest } = frame;
  return { ...rest, hasImage: frame.imageKey !== "", analysis };
}

surveillanceRouter.get("/surveillance/frames", ...canRead, async (req: AuthedRequest, res: Response) => {
  const cameraId = asId(req.query.cameraId);
  if (cameraId === null) {
    res.status(400).json({ ok: false, error: "اختر الكاميرا" });
    return;
  }
  const db = getDb();
  const frames = await db
    .select()
    .from(surveillanceFrames)
    .where(eq(surveillanceFrames.cameraId, cameraId))
    .orderBy(desc(surveillanceFrames.capturedAt))
    .limit(Math.min(asNumber(req.query.limit) ?? 30, 200));
  res.json({ ok: true, frames: frames.map(frameView) });
});

async function frameImagePayload(frame: typeof surveillanceFrames.$inferSelect | undefined) {
  if (!frame) return null;
  const image = frame.imageKey ? await loadImage(frame.imageKey) : null;
  return {
    frame: frameView(frame),
    image: image ? `data:${image.contentType};base64,${image.data.toString("base64")}` : null,
  };
}

surveillanceRouter.get("/surveillance/frames/:id/image", ...canRead, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [frame] = id ? await db.select().from(surveillanceFrames).where(eq(surveillanceFrames.id, id)) : [];
  const payload = await frameImagePayload(frame);
  if (!payload) {
    res.status(404).json({ ok: false, error: "اللقطة غير موجودة" });
    return;
  }
  res.json({ ok: true, ...payload });
});

/** آخر لقطة وصلت من الكاميرا (تُستبدل مع كل تحليل) — للعرض من أي مكان. */
surveillanceRouter.get("/surveillance/cameras/:id/latest", ...canRead, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [camera] = id ? await db.select().from(surveillanceCameras).where(eq(surveillanceCameras.id, id)) : [];
  if (!camera) {
    res.status(404).json({ ok: false, error: "الكاميرا غير موجودة" });
    return;
  }
  const image = await loadImage(latestImageKey(camera.id)).catch(() => null);
  if (!image) {
    res.status(404).json({ ok: false, error: "لا توجد لقطة محفوظة لهذه الكاميرا بعد" });
    return;
  }
  res.json({
    ok: true,
    frame: { capturedAt: camera.lastFrameAt, cameraState: camera.status },
    image: `data:${image.contentType};base64,${image.data.toString("base64")}`,
  });
});

/** لقطة الدليل المرتبطة بتنبيه آلي. */
surveillanceRouter.get("/surveillance/alerts/:id/frame", ...canRead, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [frame] = id
    ? await db
        .select()
        .from(surveillanceFrames)
        .where(sql`${id} = ANY(${surveillanceFrames.alertIds})`)
        .orderBy(desc(surveillanceFrames.capturedAt))
        .limit(1)
    : [];
  const payload = await frameImagePayload(frame);
  if (!payload) {
    res.status(404).json({ ok: false, error: "لا توجد لقطة مرتبطة بهذا التنبيه" });
    return;
  }
  res.json({ ok: true, ...payload });
});

/* ── جهاز الربط داخل المطعم ── */

function requireAgent(req: Request, res: Response): boolean {
  if (!process.env.SURVEILLANCE_WEBHOOK_SECRET) {
    res.status(503).json({ ok: false, error: "الربط الآلي غير مفعّل — اضبط SURVEILLANCE_WEBHOOK_SECRET" });
    return false;
  }
  if (!webhookAuthorized(req)) {
    res.status(401).json({ ok: false, error: "مفتاح غير صحيح" });
    return false;
  }
  return true;
}

/** الكاميرات المستحقة للتصوير الآن، يسأل عنها جهاز الربط كل دقيقة تقريباً. */
surveillanceRouter.get("/surveillance/agent/jobs", async (req: Request, res: Response) => {
  if (!requireAgent(req, res)) return;
  const branchCode = typeof req.query.branchCode === "string" ? req.query.branchCode : null;
  res.json({ ok: true, serverTime: new Date().toISOString(), jobs: await agentJobs(branchCode) });
});

/** يستقبل لقطة (أو خطأ الوصول للكاميرا) من جهاز الربط ويحلّلها فوراً. */
surveillanceRouter.post("/surveillance/snapshots", async (req: Request, res: Response) => {
  if (!requireAgent(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const row = await cameraWithBranch(asId(body.cameraId));
  if (!row) {
    res.status(404).json({ ok: false, error: "الكاميرا غير معروفة" });
    return;
  }
  const base64 = typeof body.imageBase64 === "string" ? body.imageBase64.replace(/^data:[^,]+,/, "") : "";
  const contentType = asString(body.contentType, 50) || "image/jpeg";
  const image = base64 ? { data: Buffer.from(base64, "base64"), contentType } : null;
  try {
    const result = await processFrame({
      camera: row.camera,
      branch: row.branch,
      image,
      error: asString(body.error, 300) ?? "",
      source: "agent",
      capturedAt: asDateTime(body.capturedAt) ?? undefined,
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
