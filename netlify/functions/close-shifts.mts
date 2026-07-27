import type { Config } from "@netlify/functions";
import { closeStaleShifts } from "../../server/shifts.js";

/**
 * إقفال الورديات المفتوحة التي تجاوزت الساعة 4:00 فجراً بتوقيت الفرع.
 *
 * تعمل كل 15 دقيقة لأن الفروع قد تكون في مناطق زمنية مختلفة، والدالة نفسها
 * تتحقق من حدود التوقيت لكل فرع على حدة، فلا تُقفل وردية قبل موعدها.
 * الإقفال يُنفَّذ أيضاً بشكل تلقائي عند أي عملية حضور — احتياطاً لبيئات
 * المعاينة التي لا تُشغّل الدوال المجدولة.
 */
export default async (): Promise<void> => {
  try {
    const closed = await closeStaleShifts();
    if (closed.length > 0) {
      console.log(
        `[restaurant-hr] أُقفلت ${closed.length} وردية تلقائياً:`,
        closed.map((shift) => `${shift.employeeId}@${shift.closedAt}`).join(", "),
      );
    }
  } catch (error) {
    console.error("[restaurant-hr] فشل الإقفال التلقائي للورديات:", error);
  }
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
