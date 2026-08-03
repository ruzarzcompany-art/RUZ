import { asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { employees } from "../db/schema.js";
import {
  accessRulesByEmployee,
  buildAccessProfile,
  codesForModuleLevel,
  deleteCodesForModule,
  MOBILE_APP_FLOOR_CODES,
  MODULE_CATALOG,
  MODULE_INDEX,
  resolveRuleDecisions,
  satisfiesMobileAppFloor,
} from "./rbac.js";

/* ── أداة تدقيق التغطية ───────────────────────────────────────────
 * `access_rules` هي مصدر الصلاحيات الوحيد بعد حذف نظام الأدوار، ولم يعد
 * هناك أساس ضمني يُستنتج منه شيء. فصار عمل هذه الأداة تثبيت ذلك عملياً لا
 * افتراضه: تقرأ ما يملكه كل موظف فعلاً، وتردّ كل درجة وكل رمز إلى مصدره،
 * وتُبلّغ عن أي شيء لا تبرّره قاعدة محفوظة ولا أرضية الجوال المكتوبة في
 * الكود. النتيجة السليمة هي تغطية 100% بلا فجوة واحدة.
 *
 * تُستدعى من `GET /access/audit` ومن أداة سطر الأوامر، فالحساب واحد في
 * الحالتين لا نسختان منه.
 */

export interface AuditGap {
  moduleKey: string;
  moduleLabel: string;
  effectiveLevel: number;
  explicitLevel: number;
  effectiveDelete: boolean;
  explicitDelete: boolean;
}

export interface AuditEmployeeRow {
  employeeId: number;
  employeeCode: string;
  fullName: string;
  department: string | null;
  jobTitle: string | null;
  isActive: boolean;
  /** قواعد نطاق «موظف محدّد» المكتوبة باسمه */
  explicitRuleCount: number;
  /** كل القواعد المنطبقة عليه: قاعدته وقواعد قسمه ومسماه الوظيفي */
  matchedRuleCount: number;
  /** الدرجات النافذة اليوم — وهي بعينها ما تحسمه القواعد */
  effective: { moduleLevels: Record<string, number>; moduleDelete: Record<string, boolean> };
  /** ما تحسمه القواعد المحفوظة وحدها، قبل فرض أرضية الجوال */
  explicitOnly: {
    moduleLevels: Record<string, number>;
    moduleDelete: Record<string, boolean>;
  };
  /** درجات نافذة لا تبرّرها قاعدة محفوظة ولا الأرضية — يجب أن تبقى فارغة */
  gaps: AuditGap[];
  /** رموز ذرّية نافذة بلا مصدر معروف — يجب أن تبقى فارغة */
  unexplainedCodes: string[];
  mobileFloorOk: boolean;
}

export interface AccessAuditResult {
  ok: true;
  simulate: "current" | "explicit-only";
  /**
   * لم يعد للنظام مصدر صلاحيات غير `access_rules`، فالوضع الحالي ومحاكاة
   * «القواعد الصريحة وحدها» صارا شيئاً واحداً؛ يبقى المُعامل مقبولاً حفاظاً
   * على توافق الأداة مع ما قبل حذف الأدوار.
   */
  source: "access_rules";
  mobileFloor: {
    codes: string[];
    guaranteedInCode: true;
    employeesFailing: number;
    ok: boolean;
  };
  totals: {
    employees: number;
    modules: number;
    grantedGrades: number;
    coveredGrades: number;
    coveragePercent: number;
    gapCount: number;
    employeesWithGaps: number;
    /** موظفون بلا أي قاعدة: لا يملكون غير أرضية الجوال الثلاثية */
    employeesWithoutRules: number;
  };
  /** التغطية كاملة وأرضية الجوال قائمة للجميع */
  healthy: boolean;
  employees: AuditEmployeeRow[];
}

export async function computeAccessAudit(options?: {
  explicitOnly?: boolean;
}): Promise<AccessAuditResult> {
  const explicitOnly = options?.explicitOnly === true;
  const db = getDb();

  const [employeeRows, rulesByEmployee] = await Promise.all([
    db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        department: employees.department,
        jobTitle: employees.jobTitle,
        isActive: employees.isActive,
      })
      .from(employees)
      .orderBy(asc(employees.employeeCode))
      .limit(2000),
    accessRulesByEmployee(),
  ]);

  const floorCodes = new Set(MOBILE_APP_FLOOR_CODES);
  /** صورة الموظف الذي لا قاعدة له إطلاقاً: أرضية الجوال وحدها. */
  const floorProfile = buildAccessProfile([]);

  let grantedGrades = 0;
  let coveredGrades = 0;
  let totalGaps = 0;
  let mobileFloorFailures = 0;
  let employeesWithoutRules = 0;

  const rows: AuditEmployeeRow[] = employeeRows.map((employee) => {
    const rules = rulesByEmployee.get(employee.id) ?? [];
    if (rules.length === 0) employeesWithoutRules += 1;

    const decisions = resolveRuleDecisions(rules);
    const effective = buildAccessProfile(rules);

    /**
     * الدرجات المحسومة بقواعد محفوظة، مأخوذة من القرارات مباشرة لا من
     * الصورة النهائية — فالفرق بين الاثنتين هو بالضبط ما أضافته أرضية
     * الجوال، وهو الشيء الوحيد المسموح أن يزيد.
     */
    const explicitLevels: Record<string, number> = {};
    const explicitDelete: Record<string, boolean> = {};
    for (const [moduleKey, decision] of Object.entries(decisions)) {
      if (decision.level > 0) explicitLevels[moduleKey] = decision.level;
      if (decision.canDelete) explicitDelete[moduleKey] = true;
    }

    /**
     * الفجوة: درجة نافذة لا تبلغها القواعد المحفوظة ولا تفسّرها الأرضية.
     * بعد حذف نظام الأدوار لا يُتوقّع أن تظهر واحدة؛ ظهورها يعني أن مصدراً
     * ضمنياً عاد يتسرّب إلى الحساب.
     */
    const gaps: AuditGap[] = [];

    for (const module of MODULE_CATALOG) {
      const effectiveLevel = effective.moduleLevels[module.key] ?? 0;
      const effectiveDelete = effective.moduleDelete[module.key] === true;
      if (effectiveLevel === 0 && !effectiveDelete) continue;
      grantedGrades += 1;

      const level = explicitLevels[module.key] ?? 0;
      const canDelete = explicitDelete[module.key] === true;
      const floorLevel = floorProfile.moduleLevels[module.key] ?? 0;

      const covered =
        Math.max(level, floorLevel) >= effectiveLevel && (!effectiveDelete || canDelete);
      if (covered) {
        coveredGrades += 1;
        continue;
      }
      gaps.push({
        moduleKey: module.key,
        moduleLabel: MODULE_INDEX.get(module.key)?.label ?? module.key,
        effectiveLevel,
        explicitLevel: level,
        effectiveDelete,
        explicitDelete: canDelete,
      });
    }

    /**
     * فحص إضافي على مستوى الرمز الذرّي: كل رمز نافذ يجب أن تبرّره درجة
     * قاعدة محفوظة أو أرضية الجوال. ما لا يفسّره أحدهما مصدره مجهول.
     */
    const justified = new Set(floorCodes);
    for (const [moduleKey, decision] of Object.entries(decisions)) {
      for (const code of codesForModuleLevel(moduleKey, decision.level)) justified.add(code);
      if (decision.canDelete) {
        for (const code of deleteCodesForModule(moduleKey)) justified.add(code);
      }
    }
    for (const code of floorProfile.codes) justified.add(code);
    const unexplainedCodes = effective.codes.filter((code) => !justified.has(code));

    const mobileFloorOk = satisfiesMobileAppFloor(effective);
    if (!mobileFloorOk) mobileFloorFailures += 1;
    totalGaps += gaps.length;

    const view = { moduleLevels: effective.moduleLevels, moduleDelete: effective.moduleDelete };

    return {
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      fullName: employee.fullName,
      department: employee.department,
      jobTitle: employee.jobTitle,
      isActive: employee.isActive,
      explicitRuleCount: rules.filter((rule) => rule.scopeType === "employee").length,
      matchedRuleCount: rules.length,
      effective: view,
      explicitOnly: { moduleLevels: explicitLevels, moduleDelete: explicitDelete },
      gaps,
      unexplainedCodes,
      mobileFloorOk,
    };
  });

  const employeesWithGaps = rows.filter(
    (row) => row.gaps.length > 0 || row.unexplainedCodes.length > 0,
  );
  const coveragePercent =
    grantedGrades === 0 ? 100 : Math.round((coveredGrades / grantedGrades) * 10000) / 100;

  /**
   * سلامة النظام: كل درجة نافذة مردودة إلى قاعدة محفوظة أو إلى الأرضية،
   * ولا موظف بلا الأرضية الثلاثية.
   */
  const healthy =
    coveragePercent === 100 && employeesWithGaps.length === 0 && mobileFloorFailures === 0;

  return {
    ok: true,
    simulate: explicitOnly ? "explicit-only" : "current",
    source: "access_rules",
    mobileFloor: {
      codes: MOBILE_APP_FLOOR_CODES,
      guaranteedInCode: true,
      employeesFailing: mobileFloorFailures,
      ok: mobileFloorFailures === 0,
    },
    totals: {
      employees: rows.length,
      modules: MODULE_CATALOG.length,
      grantedGrades,
      coveredGrades,
      coveragePercent,
      gapCount: totalGaps,
      employeesWithGaps: employeesWithGaps.length,
      employeesWithoutRules,
    },
    healthy,
    employees: rows,
  };
}
