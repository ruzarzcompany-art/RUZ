import type { Config } from "@netlify/functions";
import { runFoodicsSync } from "../../server/foodics.js";
import { runDayCloseTick } from "../../server/dayClose.js";
import { runInventoryTick } from "../../server/foodicsInventory.js";
import { shouldRunScheduled } from "../../server/quiet.js";

/**
 * مزامنة فوديكس الدورية: تسحب الفواتير والهدر لكل فرع مربوط، وتطابقها مع
 * الكاميرات وتقفيل الكاشير والجرد. لا تعمل ما لم يُضبط مفتاح فوديكس.
 */
export default async (): Promise<void> => {
  // النوم الليلي: خارج ساعات العمل لا تُلمس قاعدة البيانات (انظر server/quiet.ts)
  if (!(await shouldRunScheduled("foodics-sync"))) return;
  try {
    const { branches } = await runFoodicsSync();
    if (branches) console.log(`[foodics] زُومنت ${branches} فرع`);
  } catch (error) {
    console.error("[foodics] فشلت المزامنة الدورية:", error);
  }
  // تقفيل اليوم: تحديث أرقام اليوم من فوديكس، والإقفال الآلي الساعة 4 فجراً
  try {
    const { autoClosed } = await runDayCloseTick();
    if (autoClosed) console.log(`[dayclose] أُقفل آلياً ${autoClosed} يوم لم يؤكّده الكاشير`);
  } catch (error) {
    console.error("[dayclose] فشل نبض تقفيل اليوم:", error);
  }
  // المخزون: أوامر الشراء والتحويلات وأرصدة الأصناف + تنبيه الاستلام غير المؤكَّد
  try {
    const { reminded } = await runInventoryTick();
    if (reminded) console.log(`[inventory] ${reminded} استلام بلا تأكيد`);
  } catch (error) {
    console.error("[inventory] فشل نبض المخزون:", error);
  }
};

export const config: Config = {
  schedule: "*/10 * * * *",
};
