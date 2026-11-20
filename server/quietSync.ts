/**
 * النوم الليلي — الجزء الذي يلمس قاعدة البيانات (انظر quiet.ts للشرح).
 *
 *   refreshQuietConfig  ينسخ ما يحتاجه وقت النوم (الساعات، إعدادات الجهاز،
 *                       أرقام الكاميرات) إلى المخزن أثناء عمل النظام.
 *   syncIfDirty         ينقل ما سُجّل وقت النوم (آخر نبضة، حالة واتساب، وقت
 *                       آخر لقطة لكل كاميرا) إلى القاعدة عند الاستيقاظ.
 *   holdAwakeIfPending  يُبقي النظام مستيقظاً ما دام هناك تنبيه ينتظر تصعيداً
 *                       أو رسالة لم تُرسل.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  branches,
  controlDispatches,
  controlOutbox,
  controlSettings,
  surveillanceCameras,
  surveillanceSettings,
} from "../db/schema.js";
import { controlSettingsFor } from "./control.js";
import { edgeConfig } from "./edge.js";
import {
  bumpAwake,
  loadQuietConfig,
  nightSleepEnabled,
  readBeat,
  readFrameAt,
  readWaBeat,
  saveQuietConfig,
  takeDirty,
  type QuietBranch,
  type QuietConfig,
} from "./quiet.js";
import { safeTimeZone } from "./time.js";
import { latestImageKey } from "./vision.js";

const REFRESH_EVERY_MS = 3 * 60_000;

export async function buildQuietConfig(): Promise<QuietConfig> {
  const db = getDb();
  // الفروع التي ضُبطت لها ساعات عمل فقط؛ فرع بلا إعدادات لا يقيّد وقت النوم.
  const rows = await db
    .select({ branch: branches, hours: surveillanceSettings })
    .from(surveillanceSettings)
    .innerJoin(branches, eq(branches.id, surveillanceSettings.branchId))
    .where(eq(branches.isActive, true));
  const list: QuietBranch[] = [];
  for (const { branch, hours } of rows) {
    const [control, cameras, config] = await Promise.all([
      controlSettingsFor(branch.id),
      db
        .select({ id: surveillanceCameras.id, cameraNumber: surveillanceCameras.cameraNumber })
        .from(surveillanceCameras)
        .where(eq(surveillanceCameras.branchId, branch.id)),
      edgeConfig(branch),
    ]);
    list.push({
      id: branch.id,
      code: branch.code,
      timezone: safeTimeZone(branch.timezone),
      openTime: hours.openTime,
      closeTime: hours.closeTime,
      briefTime: control.briefTime,
      edgeConfig: config,
      cameras: Object.fromEntries(
        cameras.map((camera) => [camera.cameraNumber, { id: camera.id, latestKey: latestImageKey(camera.id) }]),
      ),
    });
  }
  return { version: 1, savedAt: Date.now(), branches: list };
}

/** يحدّث نسخة المخزن كل بضع دقائق. يُستدعى من النبض الدوري وهو مستيقظ. */
export async function refreshQuietConfig(force = false): Promise<void> {
  if (!nightSleepEnabled()) return;
  try {
    const current = await loadQuietConfig();
    if (!force && current && Date.now() - current.savedAt < REFRESH_EVERY_MS) return;
    await saveQuietConfig(await buildQuietConfig());
  } catch (error) {
    console.error("[night-sleep] تعذّر تحديث نسخة الإعدادات:", error instanceof Error ? error.message : error);
  }
}

/** ينقل ما سُجّل في المخزن وقت النوم إلى قاعدة البيانات (الأحدث فقط). */
export async function syncIfDirty(): Promise<void> {
  if (!nightSleepEnabled()) return;
  try {
    if (!(await takeDirty())) return;
    const config = await loadQuietConfig();
    if (!config) return;
    const db = getDb();
    for (const branch of config.branches) {
      const [beat, wa] = await Promise.all([readBeat(branch.code), readWaBeat(branch.code)]);
      if (beat?.seenAt) {
        const at = new Date(beat.seenAt);
        await db
          .update(controlSettings)
          .set({
            edgeLastSeenAt: at,
            edgeOfflineNotified: false,
            ...(beat.status !== undefined ? { edgeStatusJson: JSON.stringify(beat.status).slice(0, 30000) } : {}),
          })
          .where(
            and(
              eq(controlSettings.branchId, branch.id),
              or(isNull(controlSettings.edgeLastSeenAt), lt(controlSettings.edgeLastSeenAt, at)),
            ),
          );
      }
      if (wa?.seenAt) {
        const at = new Date(wa.seenAt);
        await db
          .update(controlSettings)
          .set({ waEdgeSeenAt: at, waEdgeState: String(wa.state ?? "").slice(0, 40) })
          .where(
            and(
              eq(controlSettings.branchId, branch.id),
              or(isNull(controlSettings.waEdgeSeenAt), lt(controlSettings.waEdgeSeenAt, at)),
            ),
          );
      }
      await Promise.all(
        Object.values(branch.cameras).map(async (camera) => {
          const frameAt = await readFrameAt(branch.code, camera.id);
          if (!frameAt) return;
          const at = new Date(frameAt);
          await db
            .update(surveillanceCameras)
            .set({ lastFrameAt: at })
            .where(
              and(
                eq(surveillanceCameras.id, camera.id),
                or(isNull(surveillanceCameras.lastFrameAt), lt(surveillanceCameras.lastFrameAt, at)),
              ),
            );
        }),
      );
    }
  } catch (error) {
    console.error("[night-sleep] تعذّر نقل بيانات وقت النوم:", error instanceof Error ? error.message : error);
  }
}

/** تنبيه ينتظر تصعيداً أو رسالة لم تُرسل بعد؟ يبقى النظام مستيقظاً حتى ينتهي. */
export async function holdAwakeIfPending(): Promise<boolean> {
  if (!nightSleepEnabled()) return false;
  try {
    const db = getDb();
    const [[dispatch], [message]] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(controlDispatches)
        .where(and(eq(controlDispatches.status, "open"), isNotNull(controlDispatches.nextEscalateAt))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(controlOutbox)
        // الرسائل الحديثة فقط: رسالة عالقة منذ مدة لا تُبقي القاعدة مستيقظة للأبد
        .where(
          and(
            inArray(controlOutbox.status, ["queued", "sending"]),
            gte(controlOutbox.createdAt, new Date(Date.now() - 15 * 60_000)),
          ),
        ),
    ]);
    const pending = (dispatch?.n ?? 0) + (message?.n ?? 0) > 0;
    if (pending) await bumpAwake(true);
    return pending;
  } catch (error) {
    console.error("[night-sleep] تعذّر فحص التنبيهات المعلّقة:", error instanceof Error ? error.message : error);
    await bumpAwake(true).catch(() => undefined);
    return true;
  }
}
