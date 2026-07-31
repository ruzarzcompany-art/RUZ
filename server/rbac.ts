import type { NextFunction, Response } from "express";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  accessRules,
  employeePermissionOverrides,
  employees,
  permissions as permissionsTable,
  rolePermissions,
} from "../db/schema.js";
import type { AuthedRequest } from "./auth.js";
import {
  ACCESS_SCOPE_TYPES,
  codesForModuleLevel,
  derivedModuleLevel,
  MODULE_CATALOG,
  type AccessLevel,
  type AccessScopeType,
} from "./permissions.js";

/**
 * قاموس الصلاحيات نفسه يعيش في `permissions.ts` (بيانات ثابتة بلا قاعدة
 * بيانات)، ويُعاد تصديره من هنا حتى تبقى `rbac.js` نقطة الاستيراد الوحيدة
 * لبقية الخادم.
 */
export {
  ACCESS_LEVELS,
  ACCESS_SCOPE_TYPES,
  ACCESS_SCOPES,
  availableLevels,
  accessCatalogPayload,
  codesForModuleLevel,
  derivedModuleLevel,
  isLevelAvailable,
  maxAvailableLevel,
  MODULE_CATALOG,
  MODULE_INDEX,
  PERMISSION_CATALOG,
  PERMISSIONS,
  SECTION_CATALOG,
} from "./permissions.js";
export type {
  AccessLevel,
  AccessModule,
  AccessScopeType,
  ModuleLevelSpec,
} from "./permissions.js";

/** صلاحيات الدور — تُقرأ من قاعدة البيانات لكل طلب. */
export async function permissionCodesForRole(
  roleId: number | null,
): Promise<string[]> {
  if (roleId === null) return [];
  const db = getDb();
  const rows = await db
    .select({ code: permissionsTable.code })
    .from(rolePermissions)
    .innerJoin(
      permissionsTable,
      eq(rolePermissions.permissionId, permissionsTable.id),
    )
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.code);
}

export interface PermissionOverride {
  permissionCode: string;
  effect: string;
  note: string;
}

/** التخصيصات الفردية لموظف بعينه (allow/deny) فوق صلاحيات دوره. */
export async function permissionOverridesForEmployee(
  employeeId: number | null,
): Promise<PermissionOverride[]> {
  if (employeeId === null) return [];
  const db = getDb();
  return db
    .select({
      permissionCode: employeePermissionOverrides.permissionCode,
      effect: employeePermissionOverrides.effect,
      note: employeePermissionOverrides.note,
    })
    .from(employeePermissionOverrides)
    .where(eq(employeePermissionOverrides.employeeId, employeeId));
}

export interface MatchedAccessRule {
  scopeType: string;
  scopeKey: string;
  moduleKey: string;
  level: number;
}

/**
 * قواعد الصلاحيات المنطبقة على موظف: قاعدته الشخصية، وقواعد قسمه، وقواعد
 * مسماه الوظيفي — بضمّ (join) واحد على صف الموظف نفسه حتى لا نحتاج جلب
 * القسم والمسمى في استعلام منفصل.
 */
export async function accessRulesForEmployee(
  employeeId: number | null,
): Promise<MatchedAccessRule[]> {
  if (employeeId === null) return [];
  const db = getDb();
  return db
    .select({
      scopeType: accessRules.scopeType,
      scopeKey: accessRules.scopeKey,
      moduleKey: accessRules.moduleKey,
      level: accessRules.level,
    })
    .from(accessRules)
    .innerJoin(employees, eq(employees.id, employeeId))
    .where(
      and(
        ne(accessRules.scopeKey, ""),
        or(
          and(
            eq(accessRules.scopeType, "employee"),
            eq(accessRules.employeeId, employeeId),
          ),
          and(
            eq(accessRules.scopeType, "department"),
            eq(accessRules.scopeKey, employees.department),
          ),
          and(
            eq(accessRules.scopeType, "job_title"),
            eq(accessRules.scopeKey, employees.jobTitle),
          ),
        ),
      ),
    );
}

/** الأخصّ يفوز: قاعدة الموظف ثم قاعدة قسمه ثم قاعدة مسماه الوظيفي. */
const SCOPE_PRECEDENCE: Record<string, number> = {
  employee: 3,
  department: 2,
  job_title: 1,
};

/**
 * درجة كل بند بعد حسم التعارض بين النطاقات: تُختار القاعدة الأخصّ لا الأعلى
 * درجة، حتى يستطيع المسؤول تخفيض موظف بعينه دون تفكيك قاعدة قسمه.
 */
export function resolveRuleLevels(
  rules: MatchedAccessRule[],
): Record<string, number> {
  const winners = new Map<string, { rank: number; level: number }>();
  for (const rule of rules) {
    const rank = SCOPE_PRECEDENCE[rule.scopeType] ?? 0;
    const current = winners.get(rule.moduleKey);
    if (current && current.rank >= rank) continue;
    winners.set(rule.moduleKey, { rank, level: rule.level });
  }
  const levels: Record<string, number> = {};
  for (const [moduleKey, entry] of winners) levels[moduleKey] = entry.level;
  return levels;
}

export interface AccessProfile {
  /** الرموز الذرّية الفعلية: الدور + التخصيصات + قواعد الصلاحيات − المحظور */
  codes: string[];
  /** درجة كل بند (1..4) — البنود غير الممنوحة لا تظهر */
  moduleLevels: Record<string, number>;
}

/**
 * الصورة الكاملة لصلاحيات موظف:
 *   • رموز دوره + ما مُنح له فردياً (النظام القديم)
 *   • ما تمنحه قواعد `access_rules` بشكل تراكمي (الدرجة الأعلى تُفعّل ما دونها)
 *   • ثم تُحسم عنه الرموز المحظورة صراحةً (deny) كفيتو نهائي
 *
 * درجة البند = الأعلى بين الدرجة المستنتجة من رموز دوره والدرجة الممنوحة له
 * بقاعدة. تُحتسب الدرجة المستنتجة من **رموز الدور والتخصيصات فقط** ولا تُحتسب
 * من الرموز التي منحتها القواعد، وإلا لَورث صاحب الدرجة 3 صلاحية الموافقات
 * في البنود التي يتشارك فيها رمز التعديل مع رمز الاعتماد.
 */
export async function accessProfile(options: {
  employeeId: number | null;
  roleId: number | null;
}): Promise<AccessProfile> {
  const [roleCodes, overrides, rules] = await Promise.all([
    permissionCodesForRole(options.roleId),
    permissionOverridesForEmployee(options.employeeId),
    accessRulesForEmployee(options.employeeId),
  ]);

  const denied = new Set<string>();
  const baseCodes = new Set(roleCodes);
  for (const override of overrides) {
    if (override.effect === "deny") {
      denied.add(override.permissionCode);
      baseCodes.delete(override.permissionCode);
    } else {
      baseCodes.add(override.permissionCode);
    }
  }

  const ruleLevels = resolveRuleLevels(rules);
  const codes = new Set(baseCodes);
  for (const [moduleKey, level] of Object.entries(ruleLevels)) {
    for (const code of codesForModuleLevel(moduleKey, level)) codes.add(code);
  }
  for (const code of denied) codes.delete(code);

  const moduleLevels: Record<string, number> = {};
  for (const module of MODULE_CATALOG) {
    const level = Math.max(
      derivedModuleLevel(module.key, baseCodes),
      ruleLevels[module.key] ?? 0,
    );
    if (level > 0) moduleLevels[module.key] = level;
  }

  return { codes: [...codes], moduleLevels };
}

/**
 * الصلاحية الفعلية للموظف = صلاحيات دوره + ما مُنح له فردياً أو بقاعدة
 * صلاحيات − ما سُحب منه. تُستخدم في كل فحوص الصلاحيات وفي الرد على
 * `/auth/me` حتى تتوافق الواجهة مع ما يفرضه الخادم فعلياً.
 */
export async function effectivePermissionCodes(options: {
  employeeId: number | null;
  roleId: number | null;
}): Promise<string[]> {
  return (await accessProfile(options)).codes;
}

/**
 * ذاكرة مؤقتة لكل طلب: الصورة تُحسب مرة واحدة مهما تعدّد عدد الفحوص في
 * المسار الواحد (بعض المسارات تفحص أكثر من صلاحية).
 */
const requestProfiles = new WeakMap<object, Promise<AccessProfile>>();

function profileForRequest(req: AuthedRequest): Promise<AccessProfile> {
  const cached = requestProfiles.get(req);
  if (cached) return cached;
  const pending = accessProfile({
    employeeId: req.employee?.id ?? null,
    roleId: req.employee?.roleId ?? null,
  });
  requestProfiles.set(req, pending);
  return pending;
}

/** يُبطل الذاكرة المؤقتة بعد تعديل صلاحيات المستخدم الحالي داخل نفس الطلب. */
export function invalidateAccessProfile(req: AuthedRequest): void {
  requestProfiles.delete(req);
}

/** هل يملك الموظف صلاحية واحدة على الأقل من القائمة؟ */
export async function hasAnyPermission(
  req: AuthedRequest,
  codes: string[],
): Promise<boolean> {
  const profile = await profileForRequest(req);
  const owned = new Set(profile.codes);
  return codes.some((code) => owned.has(code));
}

/** درجة الموظف الحالي في بند معيّن (0 = لا يملك البند). */
export async function moduleLevelForRequest(
  req: AuthedRequest,
  moduleKey: string,
): Promise<number> {
  const profile = await profileForRequest(req);
  return profile.moduleLevels[moduleKey] ?? 0;
}

/** هل يبلغ الموظف الدرجة المطلوبة في هذا البند؟ */
export async function hasModuleLevel(
  req: AuthedRequest,
  moduleKey: string,
  level: AccessLevel,
): Promise<boolean> {
  return (await moduleLevelForRequest(req, moduleKey)) >= level;
}

const LEVEL_DENIAL: Record<number, string> = {
  1: "لا تملك صلاحية عرض هذا البند",
  2: "لا تملك صلاحية تسجيل حركة في هذا البند",
  3: "لا تملك صلاحية الإضافة أو التعديل أو الحذف في هذا البند",
  4: "لا تملك صلاحية إعطاء الموافقات في هذا البند",
};

/** وسيط يتحقق من امتلاك الموظف صلاحية مُحدّدة عبر دوره. */
export function requirePermission(code: string) {
  return requireAnyPermission(code);
}

/** وسيط يقبل أي صلاحية من عدة صلاحيات (مثل: الموارد البشرية أو مدير الفرع). */
export function requireAnyPermission(...codes: string[]) {
  return async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (await hasAnyPermission(req, codes)) {
      next();
      return;
    }
    res.status(403).json({ ok: false, error: "لا تملك صلاحية تنفيذ هذا الإجراء" });
  };
}

/**
 * وسيط الدرجة: يفرض سقف الدرجة الممنوحة للبند لا مجرد امتلاك الرمز. يُركَّب
 * فوق `requirePermission` في المسارات التي يتشارك فيها أكثر من درجة رمزاً
 * واحداً (اعتماد الطلبات، مراجعة التقفيل، اعتماد المسير…).
 */
export function requireModuleLevel(moduleKey: string, level: AccessLevel) {
  return async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (await hasModuleLevel(req, moduleKey, level)) {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: LEVEL_DENIAL[level] ?? "لا تملك الدرجة المطلوبة لهذا الإجراء",
    });
  };
}

/* ── إدارة القواعد (تستخدمها شاشة «إدارة الصلاحيات») ──────────────── */

export interface AccessRuleRecord {
  id: number;
  scopeType: string;
  scopeKey: string;
  employeeId: number | null;
  moduleKey: string;
  level: number;
  note: string;
  updatedAt: Date;
}

export function isAccessScopeType(value: unknown): value is AccessScopeType {
  return ACCESS_SCOPE_TYPES.includes(value as AccessScopeType);
}

/** قواعد نطاق واحد (موظف/قسم/مسمى) كما تُعرض في شاشة التحرير. */
export async function rulesForScope(
  scopeType: AccessScopeType,
  scopeKey: string,
): Promise<AccessRuleRecord[]> {
  const db = getDb();
  return db
    .select({
      id: accessRules.id,
      scopeType: accessRules.scopeType,
      scopeKey: accessRules.scopeKey,
      employeeId: accessRules.employeeId,
      moduleKey: accessRules.moduleKey,
      level: accessRules.level,
      note: accessRules.note,
      updatedAt: accessRules.updatedAt,
    })
    .from(accessRules)
    .where(
      and(eq(accessRules.scopeType, scopeType), eq(accessRules.scopeKey, scopeKey)),
    );
}

export interface AccessScopeSummary {
  scopeType: string;
  scopeKey: string;
  employeeId: number | null;
  modules: number;
  maxLevel: number;
  updatedAt: Date | null;
}

/**
 * ملخّص القواعد المحفوظة: صف واحد لكل نطاق مع عدد بنوده وأعلى درجة فيه.
 * التجميع يجري في الذاكرة لأن عدد الصفوف محدود بعدد النطاقات × عدد البنود.
 */
export async function accessRuleScopeSummary(): Promise<AccessScopeSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      scopeType: accessRules.scopeType,
      scopeKey: accessRules.scopeKey,
      employeeId: accessRules.employeeId,
      level: accessRules.level,
      updatedAt: accessRules.updatedAt,
    })
    .from(accessRules);

  const summary = new Map<string, AccessScopeSummary>();
  for (const row of rows) {
    const key = `${row.scopeType}::${row.scopeKey}`;
    const current = summary.get(key);
    if (!current) {
      summary.set(key, {
        scopeType: row.scopeType,
        scopeKey: row.scopeKey,
        employeeId: row.employeeId,
        modules: 1,
        maxLevel: row.level,
        updatedAt: row.updatedAt,
      });
      continue;
    }
    current.modules += 1;
    current.maxLevel = Math.max(current.maxLevel, row.level);
    current.employeeId = current.employeeId ?? row.employeeId;
    if (
      row.updatedAt &&
      (!current.updatedAt || row.updatedAt > current.updatedAt)
    ) {
      current.updatedAt = row.updatedAt;
    }
  }

  return [...summary.values()].sort(
    (a, b) =>
      a.scopeType.localeCompare(b.scopeType) || a.scopeKey.localeCompare(b.scopeKey, "ar"),
  );
}

/** يحذف بنوداً بعينها من نطاق (يُستخدم عند إفراغ خانات في الشاشة). */
export async function deleteScopeModules(
  scopeType: AccessScopeType,
  scopeKey: string,
  moduleKeys: string[],
): Promise<void> {
  if (moduleKeys.length === 0) return;
  const db = getDb();
  await db
    .delete(accessRules)
    .where(
      and(
        eq(accessRules.scopeType, scopeType),
        eq(accessRules.scopeKey, scopeKey),
        inArray(accessRules.moduleKey, moduleKeys),
      ),
    );
}
