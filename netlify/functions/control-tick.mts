import type { Config } from "@netlify/functions";
import { runControlTick } from "../../server/control.js";

/**
 * نبض مركز الضبط كل دقيقة: يصعّد التنبيهات التي لم يُؤكَّد استلامها
 * (موظف ← مدير ← مالك)، ويسحب تقييمات قوقل كل 15 دقيقة، ويرسل التقرير
 * الليلي للمالك عند حلول وقته.
 */
export default async (): Promise<void> => {
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
};

export const config: Config = {
  schedule: "* * * * *",
};
