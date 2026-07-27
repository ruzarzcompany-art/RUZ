import type { Response } from "express";

/** تقريب المبالغ المالية إلى منزلتين عشريتين. */
export function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/** تقريب الساعات إلى منزلتين عشريتين. */
export const roundHours = round2;

export function asString(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? "" : trimmed.slice(0, max);
}

export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/** معرّف صحيح موجب. */
export function asId(value: unknown): number | null {
  const num = asNumber(value);
  if (num === null || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

/** تاريخ بصيغة `YYYY-MM-DD` (لأعمدة `date`). */
export function asDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const parsed = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : value.trim();
}

/** شهر بصيغة `YYYY-MM`. */
export function asMonthKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value.trim()) ? value.trim() : null;
}

/** لحظة زمنية كاملة (ISO 8601). */
export function asDateTime(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  const found = allowed.find((item) => item === value.trim());
  return found ?? null;
}

export function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

/** خطأ مع رمز HTTP — يُلتقط في وسيط الأخطاء. */
export class HttpError extends Error {
  /** خصائص المُنشئ المختصرة غير مدعومة في تجريد الأنواع بـNode، فنُصرّح بها. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export function badRequest(res: Response, message: string): void {
  res.status(400).json({ ok: false, error: message });
}

/** عدد الأيام بين تاريخين (شامل الطرفين) — لطلبات الإجازة. */
export function inclusiveDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}
