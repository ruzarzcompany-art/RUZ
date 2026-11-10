import type { Config } from "@netlify/functions";
import { runFoodicsSync } from "../../server/foodics.js";

/**
 * مزامنة فوديكس الدورية: تسحب الفواتير والهدر لكل فرع مربوط، وتطابقها مع
 * الكاميرات وتقفيل الكاشير والجرد. لا تعمل ما لم يُضبط مفتاح فوديكس.
 */
export default async (): Promise<void> => {
  try {
    const { branches } = await runFoodicsSync();
    if (branches) console.log(`[foodics] زُومنت ${branches} فرع`);
  } catch (error) {
    console.error("[foodics] فشلت المزامنة الدورية:", error);
  }
};

export const config: Config = {
  schedule: "*/10 * * * *",
};
