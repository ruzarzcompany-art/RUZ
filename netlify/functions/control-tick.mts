import type { Config } from "@netlify/functions";
import { runControlTick } from "../../server/control.js";
import { shouldRunScheduled } from "../../server/quiet.js";
import { holdAwakeIfPending, refreshQuietConfig, syncIfDirty } from "../../server/quietSync.js";

/**
 * نبض مركز الضبط كل دقيقة: يصعّد التنبيهات التي لم يُؤكَّد استلامها
 * (موظف ← مدير ← مالك)، ويسحب تقييمات قوقل كل 15 دقيقة، ويرسل التقرير
 * الليلي للمالك عند حلول وقته.
 */
export default async (): Promise<void> => {
  // النوم الليلي: خارج ساعات العمل لا تُلمس قاعدة البيانات (انظر server/quiet.ts)
  if (!(await shouldRunScheduled("control-tick"))) return;
  await syncIfDirty();
  try {
    const result = await runControlTick();
    if (result.escalated || result.briefs || result.closed) {
      console.log(
        `[control] تصعيد ${result.escalated}، إغلاق ${result.closed}، تقارير ${result.briefs}، فروع تقييمات ${result.reviewBranches}`,
      );
    }
  } catch (error) {
    console.error("[control] فشل النبض الدوري:", error);
  }
  // بعد النبض: تحديث نسخة الإعدادات للنوم الليلي، والبقاء مستيقظاً إن بقي تصعيد
  await refreshQuietConfig();
  await holdAwakeIfPending();
};

export const config: Config = {
  schedule: "* * * * *",
};
