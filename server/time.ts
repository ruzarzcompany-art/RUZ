/**
 * حسابات الوقت حسب المنطقة الزمنية للفرع — لا حسب UTC ولا حسب جهاز الموظف.
 * يوم العمل في فرع بالرياض يبدأ منتصف الليل بتوقيت الرياض، والوردية المفتوحة
 * تُقفل الساعة 4 فجراً بتوقيت الفرع نفسه.
 */

export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** يتحقق من صلاحية المنطقة الزمنية ويرجع UTC عند عدم معرفتها. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** أجزاء الوقت المحلي (الساعة على الحائط) في منطقة زمنية معيّنة. */
export function wallPartsInZone(instant: Date, timeZone: string): WallParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimeZone(timeZone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const value = (type: string) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second"),
  };
}

/** فرق المنطقة الزمنية عن UTC بالمللي ثانية في لحظة معيّنة (يراعي التوقيت الصيفي). */
export function zoneOffsetMs(timeZone: string, instant: Date): number {
  const parts = wallPartsInZone(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * تحويل وقت محلي (على الحائط) في منطقة زمنية إلى لحظة UTC.
 * تُطبَّق دورتان لضبط الفرق حول تغيّرات التوقيت الصيفي.
 */
export function zonedWallTimeToUtc(parts: WallParts, timeZone: string): Date {
  const zone = safeTimeZone(timeZone);
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  const firstOffset = zoneOffsetMs(zone, new Date(guess));
  let timestamp = guess - firstOffset;

  const secondOffset = zoneOffsetMs(zone, new Date(timestamp));
  if (secondOffset !== firstOffset) timestamp = guess - secondOffset;

  return new Date(timestamp);
}

/** بداية يوم اللحظة المُعطاة حسب المنطقة الزمنية للفرع. */
export function startOfDayInZone(instant: Date, timeZone: string): Date {
  const parts = wallPartsInZone(instant, timeZone);
  return zonedWallTimeToUtc(
    { ...parts, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}

/** بداية اليوم الحالي حسب المنطقة الزمنية للفرع. */
export function startOfTodayInZone(timeZone: string): Date {
  return startOfDayInZone(new Date(), timeZone);
}

/**
 * أول لحظة تُوافق الساعة `hour` بتوقيت الفرع **بعد** اللحظة المُعطاة.
 * تُستخدم لحساب موعد الإقفال التلقائي لوردية بدأت مساءً (4 فجراً غالباً).
 */
export function nextZonedHourAfter(
  instant: Date,
  timeZone: string,
  hour: number,
): Date {
  const parts = wallPartsInZone(instant, timeZone);
  const sameDay = zonedWallTimeToUtc(
    { ...parts, hour, minute: 0, second: 0 },
    timeZone,
  );

  if (sameDay.getTime() > instant.getTime()) return sameDay;

  // اليوم التالي بتوقيت الفرع
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return zonedWallTimeToUtc(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

/** مدى شهر ميلادي كامل (start شامل، end غير شامل) حسب منطقة زمنية. */
export function monthRangeInZone(
  year: number,
  month: number,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedWallTimeToUtc(
    { year, month, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = zonedWallTimeToUtc(
    { year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return { start, end };
}

/** صيغة الشهر `YYYY-MM` من سنة وشهر. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** تاريخ بصيغة `YYYY-MM-DD` حسب منطقة زمنية (لأعمدة `date`). */
export function isoDateInZone(instant: Date, timeZone: string): string {
  const { year, month, day } = wallPartsInZone(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
