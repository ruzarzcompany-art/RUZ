/**
 * التحليل المباشر: استقبال أحداث «جهاز التحليل» داخل المطعم.
 *
 * الجهاز (tools/edge-agent) يقرأ بث الكاميرات محلياً ويكشف الأشخاص باستمرار،
 * ويعدّ لكل طاولة مرسومة: متى جلس العملاء، هل وصلهم موظف، ومتى غادروا.
 * لا يرسل إلى الخادم إلا عند وقوع حدث — مع لقطة واحدة دليلاً:
 *
 *   table_unattended  عملاء جالسون تجاوزوا المهلة بلا وصول موظف
 *   table_uncleared   طاولة فضيت وانتهت مهلة تنظيفها (تُتحقَّق باللقطة قبل التنبيه)
 *   queue_long        طابور الكاشير فوق الحد لمدة متصلة
 *   intrusion         شخص في منطقة ممنوعة خارج ساعات العمل
 *   table_session     ملخص جلسة طاولة انتهت (للإحصاء)
 *   footfall          عدد الداخلين والخارجين في الساعة
 *
 * الذكاء الاصطناعي لا يُستدعى هنا إلا للتحقق من لقطة الطاولة الفارغة، فتبقى
 * تكلفته بعدد الطاولات التي فضيت لا بعدد الدقائق.
 */

import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  branches,
  controlFootfall,
  controlSettings,
  controlTableSessions,
  controlZones,
  surveillanceCameras,
  surveillanceFrames,
} from "../db/schema.js";
import { controlSettingsFor, footfallStats, patchControlSettings, tableStats } from "./control.js";
import { createAlert, dayRange, settingsFor, type BranchRow } from "./routes/surveillance.js";
import { safeTimeZone } from "./time.js";
import { VISION_MODEL, isOffHours, latestImageKey, saveImage } from "./vision.js";

export const ZONE_KINDS = ["table", "queue", "door", "restricted"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZONE_KIND_LABELS: Record<ZoneKind, string> = {
  table: "طاولة",
  queue: "طابور الكاشير",
  door: "خط الباب (عدّ الداخلين)",
  restricted: "منطقة ممنوعة خارج الدوام",
};

const EDGE_OFFLINE_AFTER_MS = 5 * 60_000;
const MAX_IMAGE_BYTES = 1_500_000;

type ZoneRow = typeof controlZones.$inferSelect;
type CameraRow = typeof surveillanceCameras.$inferSelect;

/** يتحقق من نقاط المضلّع: نسب 0–1، نقطتان للباب، و3–12 لغيره. */
export function parsePoints(value: unknown, kind: ZoneKind): number[][] | null {
  if (!Array.isArray(value)) return null;
  const points: number[][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    points.push([Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
  }
  if (kind === "door") return points.length === 2 ? points : null;
  return points.length >= 3 && points.length <= 12 ? points : null;
}

function zoneView(zone: ZoneRow) {
  let points: number[][] = [];
  try {
    points = JSON.parse(zone.pointsJson) as number[][];
  } catch {
    points = [];
  }
  return { id: zone.id, cameraId: zone.cameraId, kind: zone.kind, label: zone.label, points, isActive: zone.isActive };
}

export async function zonesForBranch(branchId: number) {
  const db = getDb();
  const [zones, cameras] = await Promise.all([
    db.select().from(controlZones).where(eq(controlZones.branchId, branchId)).orderBy(asc(controlZones.cameraId), asc(controlZones.id)),
    db
      .select({
        id: surveillanceCameras.id,
        cameraNumber: surveillanceCameras.cameraNumber,
        name: surveillanceCameras.name,
        zone: surveillanceCameras.zone,
      })
      .from(surveillanceCameras)
      .where(and(eq(surveillanceCameras.branchId, branchId), eq(surveillanceCameras.isActive, true)))
      .orderBy(asc(surveillanceCameras.cameraNumber)),
  ]);
  return { zones: zones.map(zoneView), cameras };
}

/** ما يحتاجه جهاز التحليل: المناطق لكل كاميرا والحدود وساعات العمل. */
export async function edgeConfig(branch: BranchRow) {
  const [control, limits, { zones, cameras }] = await Promise.all([
    controlSettingsFor(branch.id),
    settingsFor(branch.id),
    zonesForBranch(branch.id),
  ]);
  return {
    branch: { code: branch.code, name: branch.name, timezone: safeTimeZone(branch.timezone) },
    thresholds: {
      tableWaitSeconds: Math.round(control.tableWaitMinutes * 60),
      tableClearSeconds: Math.round(control.tableClearMinutes * 60),
      queueMax: control.queueMax,
      queueSeconds: control.queueSeconds,
    },
    hours: { open: limits.openTime, close: limits.closeTime },
    cameras: cameras
      .map((camera) => ({
        cameraNumber: camera.cameraNumber,
        zones: zones.filter((z) => z.cameraId === camera.id && z.isActive).map(({ id, kind, label, points }) => ({ id, kind, label, points })),
      }))
      .filter((camera) => camera.zones.length > 0),
  };
}

/** يسجّل أن الجهاز حيّ (مع حالته إن أرسلها). */
export async function touchEdge(branchId: number, status?: unknown) {
  await patchControlSettings(branchId, {
    edgeLastSeenAt: new Date(),
    edgeOfflineNotified: false,
    ...(status !== undefined ? { edgeStatusJson: JSON.stringify(status).slice(0, 4000) } : {}),
  });
}

/** ينبّه المالك مرة واحدة إذا انقطع جهاز التحليل (فُصل عن الكهرباء أو الشبكة). */
export async function checkEdgeOffline(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ settings: controlSettings, branch: branches })
    .from(controlSettings)
    .innerJoin(branches, eq(branches.id, controlSettings.branchId))
    .where(and(isNotNull(controlSettings.edgeLastSeenAt), eq(controlSettings.edgeOfflineNotified, false)));
  let raised = 0;
  for (const { settings, branch } of rows) {
    const last = settings.edgeLastSeenAt!;
    const silentMs = Date.now() - last.getTime();
    if (silentMs < EDGE_OFFLINE_AFTER_MS) continue;
    await patchControlSettings(branch.id, { edgeOfflineNotified: true });
    await createAlert({
      branchId: branch.id,
      alertType: "camera_down",
      occurredAt: new Date(),
      location: "جهاز التحليل المباشر",
      confidence: "high",
      details: `جهاز التحليل المباشر لم يتصل منذ ${Math.round(silentMs / 60_000)} دقيقة — قد يكون مفصولاً عن الكهرباء أو الشبكة. التحليل المباشر للطاولات والطابور والمستودع متوقف حتى يعود.`,
      suggestedAction: "التأكد فوراً من أن الجهاز موصول بالكهرباء والشبكة، ومراجعة مقطع مكان الجهاز لمعرفة من فصله.",
      source: "auto",
      sourceRef: `edge-offline:${last.getTime()}`,
    });
    raised += 1;
  }
  return raised;
}

/* ── التحقق من لقطة الطاولة ───────────────────────────────────── */

let anthropic: Anthropic | undefined;

type TableVerdict = "dirty" | "clean" | "occupied" | "unclear";

async function verifyTable(image: Buffer): Promise<{ verdict: TableVerdict; note: string }> {
  anthropic ??= new Anthropic();
  const message = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 300,
    tools: [
      {
        name: "table_state",
        description: "Report the state of one restaurant dining table.",
        input_schema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["dirty", "clean", "occupied", "unclear"] },
            note: { type: "string", description: "Short Arabic description of what is on the table." },
          },
          required: ["state"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "table_state" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } },
          {
            type: "text",
            text: [
              "This is a crop of ONE dining table from a restaurant CCTV camera. The customers who sat here have left.",
              "Decide the table state:",
              "- dirty: used plates, cups, food leftovers, trays, bags or rubbish are still on the table.",
              "- clean: the table is cleared. A standard setup (napkin holder, menu, condiments, table number) is still clean.",
              "- occupied: people are sitting at this table.",
              "- unclear: the image is too dark, blurry or blocked to decide.",
              "Do not guess. Write the note in short Arabic. Call the table_state tool.",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const block = message.content.find((item) => item.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("لم يُرجع النموذج نتيجة");
  const raw = block.input as { state?: unknown; note?: unknown };
  const verdict = (["dirty", "clean", "occupied", "unclear"] as const).find((v) => v === raw.state) ?? "unclear";
  return { verdict, note: String(raw.note ?? "").slice(0, 300) };
}

/* ── استقبال الأحداث ─────────────────────────────────────────── */

function decodeImage(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value) return null;
  const data = Buffer.from(value.replace(/^data:[^,]+,/, ""), "base64");
  // JPEG فقط: يبدأ بـ FF D8
  if (data.byteLength < 100 || data.byteLength > MAX_IMAGE_BYTES || data[0] !== 0xff || data[1] !== 0xd8) return null;
  return data;
}

async function saveEvidence(input: {
  branch: BranchRow;
  camera: CameraRow;
  image: Buffer;
  at: Date;
  alertId: number;
  people: number;
  note: string;
}) {
  const db = getDb();
  const [frame] = await db
    .insert(surveillanceFrames)
    .values({
      branchId: input.branch.id,
      cameraId: input.camera.id,
      capturedAt: input.at,
      source: "edge",
      cameraState: "ok",
      peopleCount: input.people,
      findingsCount: 1,
      analysisJson: JSON.stringify({ summary: input.note, findings: [] }),
      alertIds: [input.alertId],
    })
    .returning({ id: surveillanceFrames.id });
  const imageKey = `frames/${input.branch.id}/${input.camera.id}/${frame.id}`;
  await saveImage(imageKey, input.image, "image/jpeg");
  await db.update(surveillanceFrames).set({ imageKey }).where(eq(surveillanceFrames.id, frame.id));
}

function when(value: unknown, fallback = new Date()): Date {
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : fallback;
  // لا يُقبل وقت في المستقبل أو أقدم من يوم (ساعة الجهاز غير مضبوطة)
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 120_000 || Date.now() - date.getTime() > 24 * 3600_000) {
    return fallback;
  }
  return date;
}

const int = (value: unknown, max: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0;
};

const minutesText = (seconds: number) =>
  seconds >= 150 ? `${Math.round(seconds / 60)} دقائق` : seconds >= 90 ? "دقيقتين" : seconds >= 60 ? "دقيقة" : `${seconds} ثانية`;

export interface EdgeEventResult {
  ok: boolean;
  type: string;
  raised?: boolean;
  alertId?: number;
  verdict?: string;
  error?: string;
}

export async function ingestEdgeEvent(branch: BranchRow, raw: Record<string, unknown>): Promise<EdgeEventResult> {
  const db = getDb();
  const type = String(raw.type ?? "");

  if (type === "footfall") {
    const hour = when(raw.hourStart);
    hour.setUTCMinutes(0, 0, 0);
    const entries = int(raw.entries, 5000);
    const exits = int(raw.exits, 5000);
    await db
      .insert(controlFootfall)
      .values({ branchId: branch.id, hourStart: hour, entries, exits })
      .onConflictDoUpdate({
        target: [controlFootfall.branchId, controlFootfall.hourStart],
        // الجهاز يرسل مجموع الساعة حتى اللحظة، فيُحفظ الأكبر (آمن عند إعادة الإرسال)
        set: {
          entries: sql`greatest(${controlFootfall.entries}, ${entries})`,
          exits: sql`greatest(${controlFootfall.exits}, ${exits})`,
          updatedAt: new Date(),
        },
      });
    return { ok: true, type };
  }

  const zoneId = int(raw.zoneId, 2_000_000_000);
  const [row] = zoneId
    ? await db
        .select({ zone: controlZones, camera: surveillanceCameras })
        .from(controlZones)
        .innerJoin(surveillanceCameras, eq(surveillanceCameras.id, controlZones.cameraId))
        .where(and(eq(controlZones.id, zoneId), eq(controlZones.branchId, branch.id)))
    : [];
  if (!row) return { ok: false, type, error: "المنطقة غير معروفة" };
  const { zone, camera } = row;
  const at = when(raw.at);
  const seconds = int(raw.seconds, 24 * 3600);
  const people = int(raw.people, 200);
  const image = decodeImage(raw.image);
  const tableName = zone.label ? `طاولة ${zone.label}` : "طاولة";

  if (type === "table_session") {
    const seatedAt = when(raw.seatedAt, at);
    const values = {
      branchId: branch.id,
      zoneId: zone.id,
      tableLabel: zone.label,
      seatedAt,
      leftAt: raw.leftAt ? when(raw.leftAt, at) : null,
      firstVisitSeconds: raw.firstVisitSeconds === null || raw.firstVisitSeconds === undefined ? null : int(raw.firstVisitSeconds, 24 * 3600),
      clearedSeconds: raw.clearedSeconds === null || raw.clearedSeconds === undefined ? null : int(raw.clearedSeconds, 24 * 3600),
      maxPeople: people,
    };
    await db
      .insert(controlTableSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [controlTableSessions.zoneId, controlTableSessions.seatedAt],
        set: { leftAt: values.leftAt, firstVisitSeconds: values.firstVisitSeconds, clearedSeconds: values.clearedSeconds, maxPeople: values.maxPeople },
      });
    return { ok: true, type };
  }

  if (seconds < 1) return { ok: false, type, error: "مدة الحدث مفقودة" };

  let alertType: string;
  let details: string;
  let confidence = "high";
  let location = `الصالة — ${tableName}`;
  let verdict: string | undefined;
  const ref = `edge:${zone.id}:${type}:${Math.floor(when(raw.since, at).getTime() / 1000)}`;

  if (type === "table_unattended") {
    if (zone.kind !== "table") return { ok: false, type, error: "المنطقة ليست طاولة" };
    alertType = "customer_wait";
    const who = people === 1 ? "عميل جالس" : people > 1 ? `${people} عملاء جالسون` : "عملاء جالسون";
    details = `${tableName}: ${who} منذ ${minutesText(seconds)} ولم يصلهم موظف (رصد مباشر من الكاميرا ${camera.cameraNumber}).`;
    // وصول الموظف يُستنتج من حركة الأشخاص حول الطاولة، لا من تعرّف مؤكد
    confidence = "medium";
  } else if (type === "table_uncleared") {
    if (zone.kind !== "table") return { ok: false, type, error: "المنطقة ليست طاولة" };
    alertType = "dirty_table";
    let note = "";
    if (image) {
      try {
        const result = await verifyTable(image);
        verdict = result.verdict;
        note = result.note;
      } catch (error) {
        console.error("[edge] تعذّر التحقق من لقطة الطاولة:", error instanceof Error ? error.message : error);
        verdict = "unverified";
      }
    } else {
      verdict = "unverified";
    }
    // نظيفة أو عاد إليها عملاء: لا تنبيه — والجهاز يُسجّل وقت التنظيف
    if (verdict === "clean" || verdict === "occupied") return { ok: true, type, raised: false, verdict };
    confidence = verdict === "dirty" ? "high" : "medium";
    details =
      verdict === "dirty"
        ? `${tableName} فضيت منذ ${minutesText(seconds)} ولم تُنظَّف${note ? `: ${note}` : ""}.`
        : `${tableName} فضيت منذ ${minutesText(seconds)} ولم يُرصد تنظيفها (لم يُتحقَّق من اللقطة آلياً — راجع الصورة).`;
  } else if (type === "queue_long") {
    if (zone.kind !== "queue") return { ok: false, type, error: "المنطقة ليست طابوراً" };
    alertType = "cashier_queue";
    location = `الكاشير${zone.label ? ` — ${zone.label}` : ""}`;
    details = `${people} أشخاص في طابور الكاشير منذ ${minutesText(seconds)} (رصد مباشر من الكاميرا ${camera.cameraNumber}).`;
  } else if (type === "intrusion") {
    if (zone.kind !== "restricted") return { ok: false, type, error: "المنطقة ليست منطقة ممنوعة" };
    const limits = await settingsFor(branch.id);
    // الخادم يعيد التحقق من ساعات العمل ولا يعتمد على ساعة الجهاز وحدها
    if (!isOffHours(at, safeTimeZone(branch.timezone), limits.openTime, limits.closeTime)) {
      return { ok: true, type, raised: false, verdict: "open_hours" };
    }
    alertType = "warehouse_off_hours";
    location = zone.label || "منطقة ممنوعة";
    details = `شخص داخل «${zone.label || "المنطقة الممنوعة"}» خارج ساعات العمل (${limits.openTime}–${limits.closeTime}) لمدة ${minutesText(seconds)} — رصد مباشر من الكاميرا ${camera.cameraNumber}.`;
  } else {
    return { ok: false, type, error: "نوع حدث غير معروف" };
  }

  const result = await createAlert({
    branchId: branch.id,
    alertType,
    cameraId: camera.id,
    occurredAt: at,
    location,
    confidence,
    details,
    source: "auto",
    sourceRef: ref,
  });
  if (!result.duplicate && image) {
    await saveEvidence({ branch, camera, image, at, alertId: result.id, people, note: details }).catch((error) =>
      console.error("[edge] تعذّر حفظ لقطة الدليل:", error instanceof Error ? error.message : error),
    );
  }
  return { ok: true, type, raised: !result.duplicate, alertId: result.id, verdict };
}

/** لقطة معاينة للكاميرا (لرسم المناطق عليها) — تُحفظ بلا أي تحليل. */
export async function savePreview(branch: BranchRow, cameraNumber: string, imageValue: unknown): Promise<boolean> {
  const image = decodeImage(imageValue);
  if (!image) return false;
  const db = getDb();
  const [camera] = await db
    .select()
    .from(surveillanceCameras)
    .where(and(eq(surveillanceCameras.branchId, branch.id), eq(surveillanceCameras.cameraNumber, cameraNumber)));
  if (!camera) return false;
  await saveImage(latestImageKey(camera.id), image, "image/jpeg");
  await db.update(surveillanceCameras).set({ lastFrameAt: new Date() }).where(eq(surveillanceCameras.id, camera.id));
  return true;
}

/** حالة الجهاز وإحصاءات اليوم لشاشة «التنبيه والتصعيد». */
export async function edgeOverview(branch: BranchRow, date: string) {
  const db = getDb();
  const { start, end } = dayRange(date, safeTimeZone(branch.timezone));
  const [settings, sessions, footfall, zoneCount] = await Promise.all([
    controlSettingsFor(branch.id),
    db
      .select()
      .from(controlTableSessions)
      .where(and(eq(controlTableSessions.branchId, branch.id), gte(controlTableSessions.seatedAt, start), lt(controlTableSessions.seatedAt, end))),
    db
      .select()
      .from(controlFootfall)
      .where(and(eq(controlFootfall.branchId, branch.id), gte(controlFootfall.hourStart, start), lt(controlFootfall.hourStart, end))),
    db.select({ count: sql<number>`count(*)::int` }).from(controlZones).where(eq(controlZones.branchId, branch.id)),
  ]);
  let status: unknown = null;
  try {
    status = settings.edgeStatusJson ? JSON.parse(settings.edgeStatusJson) : null;
  } catch {
    status = null;
  }
  const last = settings.edgeLastSeenAt;
  return {
    lastSeenAt: last,
    online: Boolean(last && Date.now() - last.getTime() < EDGE_OFFLINE_AFTER_MS),
    status,
    zones: zoneCount[0]?.count ?? 0,
    kinds: ZONE_KIND_LABELS,
    tables: tableStats(sessions),
    footfall: footfallStats(footfall, null),
  };
}
