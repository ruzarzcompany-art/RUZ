import { inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  advances,
  attendanceLogs,
  bonuses,
  cashierClosings,
  contracts,
  custodyItems,
  disciplinaryActions,
  documentIssues,
  employees,
  inventoryItems,
  inventoryMovements,
  leaveRequests,
  overtimeRequests,
  payrollSlips,
  salaryDefinitions,
  vouchers,
  workSchedules,
} from "../db/schema.js";
import { DEMO_PURGED_FLAG, setFlag } from "./flags.js";

/** أرقام الحسابات التجريبية المبذورة. */
export const DEMO_EMPLOYEE_CODES = ["EMP-1000", "EMP-1001", "EMP-1002"] as const;

/** أكواد أصناف المخزون التجريبية المبذورة. */
export const DEMO_ITEM_CODES = ["ITM-001", "ITM-002", "ITM-003", "ITM-004", "ITM-005"] as const;

/**
 * نطاق الحذف:
 * - `demo`    : الحسابات والأصناف التجريبية المبذورة فقط (مع كل ما يتبعها).
 * - `records` : الحركات التجريبية المُدخلة أثناء التجربة (حضور، طلبات،
 *               رواتب، سندات، عهد، تقفيلات، حركات مخزون، مستندات، إنذارات)
 *               مع الإبقاء على الموظفين والكيانات الأساسية.
 * - `all`     : الاثنان معاً.
 */
export type PurgeScope = "demo" | "records" | "all";

export interface PurgeSummary {
  scope: PurgeScope;
  /** عدد الصفوف المحذوفة لكل كيان */
  deleted: Record<string, number>;
  /** حسابات تجريبية لم تُحذف (حساب المنفّذ نفسه) */
  skippedEmployees: string[];
  demoSeedDisabled: boolean;
}


/**
 * يحذف البيانات التجريبية ويمنع إعادة بذرها.
 *
 * لا يُحذف حساب المنفّذ نفسه أبداً حتى لا يُقصى المسؤول من نظامه، ويُضبط علم
 * `demo_data_purged` بعد الحذف فلا تعود الحسابات التجريبية مع الإقلاع التالي.
 */
export async function purgeDemoData(options: {
  scope: PurgeScope;
  actorEmployeeId: number;
}): Promise<PurgeSummary> {
  const db = getDb();
  const deleted: Record<string, number> = {};
  const skippedEmployees: string[] = [];
  const includeDemo = options.scope === "demo" || options.scope === "all";
  const includeRecords = options.scope === "records" || options.scope === "all";

  /** يحذف كل صفوف جدول ويسجّل عددها في الملخّص. */
  const purge = async (label: string, run: () => Promise<Array<{ id: number }>>) => {
    deleted[label] = (await run()).length;
  };

  if (includeRecords) {
    // الترتيب لا يهم: كل المراجع بين هذه الجداول إما cascade أو set null
    await purge("attendanceLogs", () =>
      db.delete(attendanceLogs).returning({ id: attendanceLogs.id }),
    );
    await purge("advances", () => db.delete(advances).returning({ id: advances.id }));
    await purge("overtimeRequests", () =>
      db.delete(overtimeRequests).returning({ id: overtimeRequests.id }),
    );
    await purge("leaveRequests", () =>
      db.delete(leaveRequests).returning({ id: leaveRequests.id }),
    );
    await purge("bonuses", () => db.delete(bonuses).returning({ id: bonuses.id }));
    await purge("contracts", () => db.delete(contracts).returning({ id: contracts.id }));
    await purge("payrollSlips", () =>
      db.delete(payrollSlips).returning({ id: payrollSlips.id }),
    );
    await purge("vouchers", () => db.delete(vouchers).returning({ id: vouchers.id }));
    await purge("custodyItems", () =>
      db.delete(custodyItems).returning({ id: custodyItems.id }),
    );
    await purge("cashierClosings", () =>
      db.delete(cashierClosings).returning({ id: cashierClosings.id }),
    );
    await purge("inventoryMovements", () =>
      db.delete(inventoryMovements).returning({ id: inventoryMovements.id }),
    );
    await purge("documentIssues", () =>
      db.delete(documentIssues).returning({ id: documentIssues.id }),
    );
    await purge("disciplinaryActions", () =>
      db.delete(disciplinaryActions).returning({ id: disciplinaryActions.id }),
    );
  }

  if (includeDemo) {
    const demoAccounts = await db
      .select({ id: employees.id, code: employees.employeeCode })
      .from(employees)
      .where(inArray(employees.employeeCode, [...DEMO_EMPLOYEE_CODES]));

    const removable = demoAccounts.filter((account) => account.id !== options.actorEmployeeId);
    for (const account of demoAccounts) {
      if (account.id === options.actorEmployeeId) skippedEmployees.push(account.code);
    }

    if (removable.length > 0) {
      const ids = removable.map((account) => account.id);
      // الحذف يتسلسل تلقائياً على الحضور والنماذج والرواتب والجداول وقوالب الوجه
      const rows = await db
        .delete(employees)
        .where(inArray(employees.id, ids))
        .returning({ id: employees.id });
      deleted.employees = rows.length;
    } else {
      deleted.employees = 0;
    }

    // لو بقي حساب المنفّذ التجريبي: تُنظَّف بياناته التابعة التجريبية فقط
    if (skippedEmployees.length > 0) {
      const cleanedSalaries = await db
        .delete(salaryDefinitions)
        .where(sql`${salaryDefinitions.note} like 'تعريف راتب تجريبي%'`)
        .returning({ id: salaryDefinitions.id });
      deleted.salaryDefinitions = cleanedSalaries.length;

      const cleanedSchedules = await db
        .delete(workSchedules)
        .where(sql`${workSchedules.note} like 'جدول دوام تجريبي%'`)
        .returning({ id: workSchedules.id });
      deleted.workSchedules = cleanedSchedules.length;
    }

    const items = await db
      .delete(inventoryItems)
      .where(inArray(inventoryItems.code, [...DEMO_ITEM_CODES]))
      .returning({ id: inventoryItems.id });
    deleted.inventoryItems = items.length;

    await setFlag(DEMO_PURGED_FLAG, "1", {
      note: "حُذفت البيانات التجريبية من لوحة الإعدادات — لا تُبذر مرة أخرى.",
      setByEmployeeId: options.actorEmployeeId,
    });
  }

  return {
    scope: options.scope,
    deleted,
    skippedEmployees,
    demoSeedDisabled: includeDemo,
  };
}

/** عدّاد سريع للبيانات التجريبية المتبقية — يُستخدم لعرض حالة الزر. */
export async function demoDataStatus(): Promise<{
  demoEmployees: number;
  demoItems: number;
  attendanceLogs: number;
}> {
  const db = getDb();

  const [accounts, items, logs] = await Promise.all([
    db
      .select({ id: employees.id })
      .from(employees)
      .where(inArray(employees.employeeCode, [...DEMO_EMPLOYEE_CODES])),
    db
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(inArray(inventoryItems.code, [...DEMO_ITEM_CODES])),
    db.select({ total: sql<number>`count(*)::int` }).from(attendanceLogs),
  ]);

  return {
    demoEmployees: accounts.length,
    demoItems: items.length,
    attendanceLogs: logs[0]?.total ?? 0,
  };
}
