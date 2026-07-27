import type { Request } from "express";
import { getDb } from "../db/index.js";
import { auditLogs } from "../db/schema.js";

export interface AuditEntry {
  actorEmployeeId: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ipAddress?: string;
}

function snapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, (_key, item) =>
      item instanceof Date ? item.toISOString() : item,
    );
  } catch {
    return null;
  }
}

/**
 * يكتب صفاً في `audit_logs`. لا يرمي أخطاء إلى المستدعي: فشل التدقيق لا يجب
 * أن يُفشل عملية إدارية اكتملت أصلاً — لكنه يُسجَّل في سجلات الخادم.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLogs).values({
      actorEmployeeId: entry.actorEmployeeId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      beforeJson: snapshot(entry.before),
      afterJson: snapshot(entry.after),
      reason: (entry.reason ?? "").slice(0, 1000),
      ipAddress: (entry.ipAddress ?? "").slice(0, 100),
    });
  } catch (error) {
    console.error("[restaurant-hr] فشل كتابة سجل التدقيق:", error);
  }
}

/** عنوان IP الحقيقي للعميل خلف شبكة Netlify. */
export function clientIp(req: Request): string {
  const forwarded =
    req.headers["x-nf-client-connection-ip"] ?? req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value ?? req.ip ?? "").split(",")[0]?.trim() ?? "";
}
