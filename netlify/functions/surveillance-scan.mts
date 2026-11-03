import type { Config } from "@netlify/functions";
import { runScheduledScan } from "../../server/vision.js";

/**
 * الكشف الآلي الدوري للكاميرات: يحلّل لقطات الكاميرات ذات الرابط العام
 * المستحقة، ويُنبّه عن الكاميرات التي انقطعت لقطاتها من جهاز الربط.
 * كاميرات جهاز الربط نفسها تُحلَّل لحظة وصول لقطتها، لا هنا.
 */
export default async (): Promise<void> => {
  try {
    const { analysed, stale } = await runScheduledScan();
    if (analysed || stale) {
      console.log(`[surveillance] حُلّلت ${analysed} لقطة، و${stale} كاميرا بلا لقطات حديثة`);
    }
  } catch (error) {
    console.error("[surveillance] فشل الفحص الدوري:", error);
  }
};

export const config: Config = {
  schedule: "*/2 * * * *",
};
