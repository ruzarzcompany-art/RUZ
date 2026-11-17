/**
 * مسارات مركز الضبط (التوجيه والتصعيد وواتساب وتقييمات قوقل وشكاوى الطاولات).
 *
 *   GET    /api/control/overview?branchId=&date=   الإعدادات والمستلمون وسجل اليوم
 *   PUT    /api/control/settings                   مهل التصعيد والحدود وربط قوقل
 *   POST   /api/control/recipients                 إضافة مستلم
 *   PUT    /api/control/recipients/:id             تعديل مستلم
 *   DELETE /api/control/recipients/:id             حذف مستلم
 *   POST   /api/control/recipients/:id/test        رسالة واتساب تجريبية
 *   POST   /api/control/dispatches/:id/ack         تأكيد استلام من داخل النظام
 *   POST   /api/control/reviews/sync               سحب تقييمات قوقل الآن
 *   POST   /api/control/brief                      بناء التقرير الليلي (وإرساله اختيارياً)
 *
 *   GET    /api/control/zones?branchId=            المناطق المرسومة والكاميرات
 *   POST   /api/control/zones                      رسم منطقة (طاولة/طابور/باب/ممنوعة)
 *   DELETE /api/control/zones/:id                  حذف منطقة
 *
 * جهاز التحليل داخل المطعم (بالرأس X-Surveillance-Key):
 *   GET  /api/control/edge/config?branchCode=      المناطق والحدود وساعات العمل
 *   POST /api/control/edge/events                  أحداث الرصد المباشر ونبض الجهاز
 *   POST /api/control/edge/preview                 لقطة معاينة لرسم المناطق
 *
 * مسارات عامة بلا دخول (محمية برمز موقّع أو بحدود معدّل):
 *   GET  /api/control/ack-info?t=       بيانات التنبيه لصفحة تأكيد الاستلام
 *   POST /api/control/ack               تأكيد الاستلام من رابط واتساب
 *   GET  /api/public/feedback-info?b=   اسم الفرع لصفحة شكوى الطاولة
 *   POST /api/public/feedback           شكوى أو طلب من الطاولة (QR)
 */

import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  branches,
  controlDispatches,
  controlMessages,
  controlRecipients,
  controlZones,
  employees,
  surveillanceAlerts,
  surveillanceCameras,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  FEEDBACK_CATEGORIES,
  GOOGLE_BUSINESS_PATH,
  GOOGLE_PLACE_ID,
  TIERS,
  TIER_LABELS,
  acknowledge,
  controlOverview,
  controlSettingsFor,
  generateBrief,
  normalizePhone,
  parseAckToken,
  patchControlSettings,
  exchangeOutbox,
  waEdgeStatus,
  sendWhatsapp,
  submitFeedback,
  syncGoogleReviews,
  whatsappConfig,
  type Tier,
} from "../control.js";
import {
  ZONE_KINDS,
  edgeConfig,
  ingestEdgeEvent,
  liveRequested,
  liveView,
  parsePoints,
  savePreview,
  touchEdge,
  zonesForBranch,
} from "../edge.js";
import { PERMISSIONS, requireModuleLevel, requirePermission } from "../rbac.js";
import { isoDateInZone, safeTimeZone } from "../time.js";
import { asBool, asDateOnly, asEnum, asId, asNumber, asString } from "../validate.js";
import { ALERT_TYPES, LABELS, alertFramePayload, loadBranch, webhookAuthorized } from "./surveillance.js";

export const controlRouter = Router();

const MODULE = "surveillance";
const canRead = [requireAuth, requirePermission(PERMISSIONS.surveillanceRead), requireModuleLevel(MODULE, 1)];
const canManage = [requireAuth, requirePermission(PERMISSIONS.surveillanceManage), requireModuleLevel(MODULE, 3)];

const ZONE_KEYS = Object.keys(LABELS.zones);

function branchIdOf(req: AuthedRequest, value: unknown): number | null {
  return asId(value) ?? req.employee?.branchId ?? null;
}

function bad(res: Response, message: string, status = 400) {
  res.status(status).json({ ok: false, error: message });
}

/* ── النظرة العامة والإعدادات ─────────────────────────────────── */

controlRouter.get("/control/overview", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  const date = asDateOnly(req.query.date) ?? isoDateInZone(new Date(), safeTimeZone(branch.timezone));
  res.json({ ok: true, ...(await controlOverview(branch, date)) });
});

/** شاشة المراقبة المباشرة: يُستدعى كل بضع ثوانٍ ما دامت الشاشة مفتوحة. */
controlRouter.get("/control/live", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  const db = getDb();
  const since = new Date(Date.now() - 6 * 3600_000);
  const [view, open] = await Promise.all([
    liveView(branch),
    db
      .select()
      .from(surveillanceAlerts)
      .where(and(eq(surveillanceAlerts.branchId, branch.id), eq(surveillanceAlerts.status, "open"), gte(surveillanceAlerts.occurredAt, since)))
      .orderBy(desc(surveillanceAlerts.occurredAt))
      .limit(12),
  ]);
  res.json({
    ok: true,
    ...view,
    alerts: open
      // تنبيه «توقف كاميرا» لكاميرا وصلت لقطتها قبل دقائق لم يعد صحيحاً — لا يُعرض في المباشر.
      .filter((alert) => {
        if (alert.alertType !== "camera_down") return true;
        const camera = view.cameras.find((item) => item.id === alert.cameraId);
        return !(camera?.lastFrameAt && Date.now() - new Date(camera.lastFrameAt).getTime() < 15 * 60_000);
      })
      .map((alert) => ({
      id: alert.id,
      type: alert.alertType,
      label: ALERT_TYPES[alert.alertType]?.label ?? alert.alertType,
      location: alert.location,
      details: alert.details.slice(0, 200),
      occurredAt: alert.occurredAt,
      urgent: alert.isUrgent,
      cameraId: alert.cameraId,
    })),
  });
});

controlRouter.put("/control/settings", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  const current = await controlSettingsFor(branch.id);

  const minutes = (value: unknown, fallback: number) => asNumber(value) ?? fallback;
  const staffAckMinutes = minutes(body.staffAckMinutes, current.staffAckMinutes);
  const orderStaffAckMinutes = minutes(body.orderStaffAckMinutes, current.orderStaffAckMinutes);
  const managerAckMinutes = minutes(body.managerAckMinutes, current.managerAckMinutes);
  if ([staffAckMinutes, orderStaffAckMinutes, managerAckMinutes].some((m) => m < 1 || m > 120)) {
    return bad(res, "مهل الاستلام بين دقيقة و120 دقيقة (الفحص الدوري كل دقيقة)");
  }
  const tableWaitMinutes = minutes(body.tableWaitMinutes, current.tableWaitMinutes);
  const tableClearMinutes = minutes(body.tableClearMinutes, current.tableClearMinutes);
  if (tableWaitMinutes < 1 || tableWaitMinutes > 60 || tableClearMinutes < 1 || tableClearMinutes > 60) {
    return bad(res, "مهلة خدمة الطاولة ومهلة تنظيفها بين دقيقة و60 دقيقة");
  }
  const queueSeconds = Math.round(asNumber(body.queueSeconds) ?? current.queueSeconds);
  if (queueSeconds < 15 || queueSeconds > 900) return bad(res, "مدة الطابور بين 15 و900 ثانية");
  const queueMax = Math.round(asNumber(body.queueMax) ?? current.queueMax);
  const reviewMaxStars = Math.round(asNumber(body.reviewMaxStars) ?? current.reviewMaxStars);
  const tableCount = Math.round(asNumber(body.tableCount) ?? current.tableCount);
  if (queueMax < 1 || queueMax > 30) return bad(res, "حد الطابور بين 1 و30 شخصاً");
  if (reviewMaxStars < 1 || reviewMaxStars > 4) return bad(res, "حد التقييم بين 1 و4 نجوم");
  if (tableCount < 0 || tableCount > 300) return bad(res, "عدد الطاولات بين 0 و300");

  const googleLocation = (asString(body.googleLocation, 200) ?? current.googleLocation).trim();
  if (googleLocation && !GOOGLE_BUSINESS_PATH.test(googleLocation) && !GOOGLE_PLACE_ID.test(googleLocation)) {
    return bad(res, "ضع معرّف المكان في قوقل (يبدأ بـ ChIJ) أو المسار accounts/123/locations/456");
  }
  const briefTime = (asString(body.briefTime, 5) ?? current.briefTime).trim();
  if (briefTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(briefTime)) return bad(res, "وقت التقرير بصيغة HH:MM أو فارغ لإيقافه");

  const set = {
    enabled: asBool(body.enabled) ?? current.enabled,
    staffAckMinutes,
    orderStaffAckMinutes,
    managerAckMinutes,
    queueMax,
    queueSeconds,
    tableWaitMinutes,
    tableClearMinutes,
    notifyMinor: asBool(body.notifyMinor) ?? current.notifyMinor,
    googleLocation,
    reviewMaxStars,
    feedbackEnabled: asBool(body.feedbackEnabled) ?? current.feedbackEnabled,
    tableCount,
    briefTime,
  };
  await patchControlSettings(branch.id, set);
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "control.settings_update",
    entityType: "branch",
    entityId: branch.id,
    after: set,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, message: "حُفظت إعدادات التنبيه والتصعيد." });
});

/* ── المستلمون ────────────────────────────────────────────────── */

async function recipientFields(body: Record<string, unknown>): Promise<
  | { error: string }
  | { tier: Tier; name: string; phone: string; employeeId: number | null; zones: string[]; onShiftOnly: boolean; isActive: boolean }
> {
  const tier = asEnum(body.tier, TIERS);
  if (!tier) return { error: "اختر المستوى: موظف أو مدير أو مالك" };
  const phone = normalizePhone(asString(body.phone, 30) ?? "");
  if (!phone) return { error: "رقم الواتساب غير صحيح — مثال: 0501234567" };
  const employeeId = asId(body.employeeId);
  let name = (asString(body.name, 120) ?? "").trim();
  if (employeeId) {
    const db = getDb();
    const [employee] = await db
      .select({ fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId));
    if (!employee) return { error: "الموظف غير موجود" };
    name ||= employee.fullName;
  }
  if (!name) return { error: "اكتب اسم المستلم أو اختر موظفاً" };
  const zones = Array.isArray(body.zones)
    ? [...new Set(body.zones.map(String).filter((z) => ZONE_KEYS.includes(z)))]
    : [];
  return {
    tier,
    name,
    phone,
    employeeId,
    zones: tier === "staff" ? zones : [],
    onShiftOnly: tier === "staff" ? (asBool(body.onShiftOnly) ?? true) : false,
    isActive: asBool(body.isActive) ?? true,
  };
}

controlRouter.post("/control/recipients", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  const fields = await recipientFields(body);
  if ("error" in fields) return bad(res, fields.error);
  const db = getDb();
  const [created] = await db
    .insert(controlRecipients)
    .values({ branchId: branch.id, ...fields })
    .returning({ id: controlRecipients.id });
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "control.recipient_create",
    entityType: "control_recipient",
    entityId: created.id,
    after: { ...fields, branchId: branch.id },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, id: created.id, message: `أُضيف ${fields.name} (${TIER_LABELS[fields.tier]}).` });
});

controlRouter.put("/control/recipients/:id", ...canManage, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [before] = id ? await db.select().from(controlRecipients).where(eq(controlRecipients.id, id)) : [];
  if (!before) return bad(res, "المستلم غير موجود", 404);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields = await recipientFields({
    tier: before.tier,
    name: before.name,
    phone: before.phone,
    employeeId: before.employeeId,
    zones: before.zones,
    onShiftOnly: before.onShiftOnly,
    isActive: before.isActive,
    ...body,
  });
  if ("error" in fields) return bad(res, fields.error);
  await db.update(controlRecipients).set(fields).where(eq(controlRecipients.id, before.id));
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "control.recipient_update",
    entityType: "control_recipient",
    entityId: before.id,
    before,
    after: fields,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, message: "حُدّث المستلم." });
});

controlRouter.delete("/control/recipients/:id", ...canManage, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [before] = id ? await db.select().from(controlRecipients).where(eq(controlRecipients.id, id)) : [];
  if (!before) return bad(res, "المستلم غير موجود", 404);
  await db.delete(controlRecipients).where(eq(controlRecipients.id, before.id));
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "control.recipient_delete",
    entityType: "control_recipient",
    entityId: before.id,
    before,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, message: "حُذف المستلم." });
});

controlRouter.post("/control/recipients/:id/test", ...canManage, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [recipient] = id ? await db.select().from(controlRecipients).where(eq(controlRecipients.id, id)) : [];
  if (!recipient) return bad(res, "المستلم غير موجود", 404);
  if (!whatsappConfig().configured) return bad(res, "واتساب غير مضبوط بعد — أضف WHATSAPP_TOKEN ومعرّف الرقم في إعدادات Netlify.");
  if (whatsappConfig().provider === "edge" && waEdgeStatus(await controlSettingsFor(recipient.branchId)).state !== "connected") {
    return bad(res, "واتساب جوال المطعم غير مربوط بعد — شغّل مرسل واتساب على جهاز المطعم وامسح رمز QR.");
  }
  const result = await sendWhatsapp(
    recipient.phone,
    `✅ رسالة تجريبية من «سِجل»\n${recipient.name} — أنت مسجَّل لاستلام تنبيهات المطعم بمستوى ${TIER_LABELS[recipient.tier as Tier] ?? recipient.tier}.`,
  );
  await db.insert(controlMessages).values({
    branchId: recipient.branchId,
    recipientId: recipient.id,
    tier: recipient.tier,
    kind: "test",
    phone: recipient.phone,
    status: result.ok ? "sent" : "failed",
    error: result.error,
  });
  if (!result.ok) return bad(res, `لم تُرسل الرسالة: ${result.error}`, 502);
  res.json({ ok: true, message: `أُرسلت رسالة تجريبية إلى ${recipient.name}.` });
});

/* ── الاستلام من داخل النظام، التقييمات، التقرير ─────────────── */

controlRouter.post("/control/dispatches/:id/ack", ...canRead, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  if (!id) return bad(res, "رقم غير صحيح");
  const db = getDb();
  const [me] = await db.select({ fullName: employees.fullName }).from(employees).where(eq(employees.id, req.employee!.id));
  const result = await acknowledge({
    dispatchId: id,
    name: me?.fullName ?? "",
    note: asString((req.body ?? {}).note, 500) ?? "",
  });
  if (!result.ok) return bad(res, result.error ?? "تعذّر التأكيد", 404);
  res.json({ ok: true, message: result.already ? "سبق تأكيد استلامه." : "أُكّد الاستلام وتوقف التصعيد." });
});

controlRouter.post("/control/reviews/sync", ...canManage, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, (req.body ?? {}).branchId));
  if (!branch) return bad(res, "اختر الفرع");
  try {
    const stats = await syncGoogleReviews(branch);
    res.json({
      ok: true,
      stats,
      message: `سُحب ${stats.fetched} تقييماً: ${stats.added} جديد، و${stats.alerted} تنبيه للمدير.`,
    });
  } catch (error) {
    bad(res, error instanceof Error ? error.message : "تعذّر سحب التقييمات", 502);
  }
});

controlRouter.post("/control/brief", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(branchIdOf(req, body.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  const date = asDateOnly(body.date) ?? isoDateInZone(new Date(), safeTimeZone(branch.timezone));
  const brief = await generateBrief(branch, date, { send: body.send === true });
  res.json({
    ok: true,
    brief,
    message: brief.ai
      ? `صدر تقرير ${date}${body.send === true ? ` وأُرسل إلى ${brief.sent} مستلم` : ""}.`
      : `تعذّر تحليل الذكاء الاصطناعي، فصدر التقرير بالأرقام فقط${body.send === true ? ` وأُرسل إلى ${brief.sent} مستلم` : ""}.`,
  });
});

/* ── تأكيد الاستلام من رابط واتساب (عام، برمز موقّع) ──────────── */

async function ackContext(token: unknown) {
  const parsed = parseAckToken(String(token ?? ""));
  if (!parsed) return null;
  const db = getDb();
  const [row] = await db
    .select({ dispatch: controlDispatches, alert: surveillanceAlerts, branchName: branches.name })
    .from(controlDispatches)
    .innerJoin(surveillanceAlerts, eq(surveillanceAlerts.id, controlDispatches.alertId))
    .innerJoin(branches, eq(branches.id, controlDispatches.branchId))
    .where(eq(controlDispatches.id, parsed.dispatchId));
  if (!row) return null;
  const [recipient] = await db
    .select()
    .from(controlRecipients)
    .where(and(eq(controlRecipients.id, parsed.recipientId), eq(controlRecipients.branchId, row.dispatch.branchId)));
  if (!recipient) return null;
  return { ...parsed, ...row, recipient };
}

/** قراءة فقط — فتح الرابط (أو معاينته من واتساب) لا يؤكد الاستلام. */
controlRouter.get("/control/ack-info", async (req: Request, res: Response) => {
  const context = await ackContext(req.query.t);
  if (!context) return bad(res, "الرابط غير صالح", 404);
  const { alert, dispatch } = context;
  res.json({
    ok: true,
    branch: context.branchName,
    recipient: context.recipient.name,
    label: ALERT_TYPES[alert.alertType]?.label ?? alert.alertType,
    location: alert.location,
    occurredAt: alert.occurredAt,
    // تفاصيل الاشتباه لا تُعرض إلا لمستوى المالك
    details: alert.isSuspicion && context.recipient.tier !== "owner" ? "" : alert.details,
    action: ALERT_TYPES[alert.alertType]?.action ?? "",
    // صورة الدليل: للمالك والمدير دائماً، وللموظف إن لم يكن التنبيه اشتباهاً
    image:
      alert.isSuspicion && context.recipient.tier === "staff"
        ? null
        : ((await alertFramePayload(alert.id).catch(() => null))?.image ?? null),
    acked: dispatch.status === "acked",
    ackByName: dispatch.ackByName,
    ackAt: dispatch.ackAt,
  });
});

controlRouter.post("/control/ack", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const context = await ackContext(body.t);
  if (!context) return bad(res, "الرابط غير صالح", 404);
  const result = await acknowledge({
    dispatchId: context.dispatchId,
    recipientId: context.recipientId,
    note: asString(body.note, 500) ?? "",
  });
  if (!result.ok) return bad(res, result.error ?? "تعذّر التأكيد");
  res.json({ ok: true, already: result.already });
});

/* ── شكوى الطاولة (عام، بحدود معدّل) ─────────────────────────── */

async function branchByCode(code: unknown) {
  const value = (asString(code, 40) ?? "").trim();
  if (!value) return null;
  const db = getDb();
  const [branch] = await db
    .select()
    .from(branches)
    .where(and(eq(branches.code, value), eq(branches.isActive, true)));
  return branch ?? null;
}

controlRouter.get("/public/feedback-info", async (req: Request, res: Response) => {
  const branch = await branchByCode(req.query.b);
  if (!branch) return bad(res, "الرابط غير صالح", 404);
  const settings = await controlSettingsFor(branch.id);
  res.json({ ok: true, branch: branch.name, enabled: settings.feedbackEnabled, categories: FEEDBACK_CATEGORIES });
});

controlRouter.post("/public/feedback", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await branchByCode(body.b);
  if (!branch) return bad(res, "الرابط غير صالح", 404);
  const category = asEnum(body.category, Object.keys(FEEDBACK_CATEGORIES)) ?? "other";
  const tableNo = (asString(body.t, 10) ?? "").replace(/[^\w؀-ۿ-]/g, "").slice(0, 10);
  const message = (asString(body.message, 500) ?? "").trim();
  const phoneRaw = (asString(body.phone, 30) ?? "").trim();
  const phone = phoneRaw ? (normalizePhone(phoneRaw) ?? "") : "";
  if (phoneRaw && !phone) return bad(res, "رقم الجوال غير صحيح");
  if (category === "other" && !message) return bad(res, "اكتب ملاحظتك");
  const result = await submitFeedback({ branch, tableNo, category, message, phone });
  if (!result.ok) return bad(res, result.error ?? "تعذّر الإرسال", 429);
  res.json({ ok: true });
});

/* ── مناطق التحليل المباشر ───────────────────────────────────── */

controlRouter.get("/control/zones", ...canRead, async (req: AuthedRequest, res: Response) => {
  const branch = await loadBranch(branchIdOf(req, req.query.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  res.json({ ok: true, ...(await zonesForBranch(branch.id)) });
});

controlRouter.post("/control/zones", ...canManage, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await loadBranch(asId(body.branchId));
  if (!branch) return bad(res, "اختر الفرع");
  const db = getDb();
  const cameraId = asId(body.cameraId);
  const [camera] = cameraId
    ? await db
        .select()
        .from(surveillanceCameras)
        .where(and(eq(surveillanceCameras.id, cameraId), eq(surveillanceCameras.branchId, branch.id)))
    : [];
  if (!camera) return bad(res, "اختر الكاميرا");
  const kind = asEnum(body.kind, ZONE_KINDS);
  if (!kind) return bad(res, "اختر نوع المنطقة");
  const points = parsePoints(body.points, kind);
  if (!points) {
    return bad(res, kind === "door" ? "خط الباب نقطتان فقط" : "ارسم المنطقة بثلاث نقاط على الأقل (12 كحد أقصى)");
  }
  const label = (asString(body.label, 40) ?? "").trim();
  if (kind === "table" && !label) return bad(res, "اكتب رقم الطاولة");
  const [created] = await db
    .insert(controlZones)
    .values({ branchId: branch.id, cameraId: camera.id, kind, label, pointsJson: JSON.stringify(points) })
    .returning({ id: controlZones.id });
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "control.zone_create",
    entityType: "control_zone",
    entityId: created.id,
    after: { cameraId: camera.id, kind, label, points },
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, id: created.id, message: "حُفظت المنطقة — يلتقطها جهاز التحليل خلال دقيقة." });
});

controlRouter.delete("/control/zones/:id", ...canManage, async (req: AuthedRequest, res: Response) => {
  const id = asId(req.params.id);
  const db = getDb();
  const [before] = id ? await db.select().from(controlZones).where(eq(controlZones.id, id)) : [];
  if (!before) return bad(res, "المنطقة غير موجودة", 404);
  await db.delete(controlZones).where(eq(controlZones.id, before.id));
  await recordAudit({
    actorEmployeeId: req.employee!.id,
    action: "control.zone_delete",
    entityType: "control_zone",
    entityId: before.id,
    before,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, message: "حُذفت المنطقة." });
});

/* ── جهاز التحليل داخل المطعم ────────────────────────────────── */

async function edgeBranch(req: Request, res: Response, code: unknown) {
  if (!process.env.SURVEILLANCE_WEBHOOK_SECRET) {
    bad(res, "الربط الآلي غير مفعّل — اضبط SURVEILLANCE_WEBHOOK_SECRET", 503);
    return null;
  }
  if (!webhookAuthorized(req)) {
    bad(res, "مفتاح غير صحيح", 401);
    return null;
  }
  const branch = await branchByCode(code);
  if (!branch) bad(res, "رمز الفرع غير معروف", 404);
  return branch;
}

controlRouter.get("/control/edge/config", async (req: Request, res: Response) => {
  const branch = await edgeBranch(req, res, req.query.branchCode);
  if (!branch) return;
  await touchEdge(branch.id);
  res.json({ ok: true, serverTime: new Date().toISOString(), ...(await edgeConfig(branch)) });
});

controlRouter.post("/control/edge/events", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await edgeBranch(req, res, body.branchCode);
  if (!branch) return;
  await touchEdge(branch.id, body.status);
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
  const results = [];
  for (const event of events) {
    try {
      results.push(await ingestEdgeEvent(branch, (event ?? {}) as Record<string, unknown>));
    } catch (error) {
      results.push({ ok: false, type: String((event as { type?: unknown })?.type ?? ""), error: error instanceof Error ? error.message : String(error) });
    }
  }
  res.json({ ok: true, results, live: await liveRequested(branch.id) });
});

controlRouter.post("/control/edge/outbox", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await edgeBranch(req, res, body.branchCode);
  if (!branch) return;
  const results = (Array.isArray(body.results) ? body.results : [])
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .filter((item) => Number.isInteger(item.id))
    .map((item) => ({ id: item.id as number, ok: item.ok === true, error: String(item.error ?? "") }));
  const messages = await exchangeOutbox(branch.id, asString(body.state, 40) ?? "", results);
  res.json({ ok: true, messages });
});

controlRouter.post("/control/edge/preview", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branch = await edgeBranch(req, res, body.branchCode);
  if (!branch) return;
  await touchEdge(branch.id);
  const saved = await savePreview(branch, (asString(body.cameraNumber, 40) ?? "").trim(), body.image);
  if (!saved) return bad(res, "الكاميرا غير معروفة أو الصورة غير صالحة (JPEG حتى 1.5MB)");
  res.json({ ok: true });
});
