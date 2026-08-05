import type { NextFunction, Response } from "express";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { accessRules, employees } from "../db/schema.js";
import type { AuthedRequest } from "./auth.js";
import {
  ACCESS_SCOPE_TYPES,
  codesForModuleLevel,
  deleteCodesForModule,
  isDeleteAvailable,
  maxAvailableLevel,
  MODULE_CATALOG,
  MODULE_INDEX,
  MODULE_INHERITS,
  PERMISSIONS,
  type AccessLevel,
  type AccessScopeType,
} from "./permissions.js";

/**
 * قاموس الصلاحيات نفسه يعيش في `permissions.ts` (بيانات ثابتة بلا قاعدة
 * بيانات)، ويُعاد تصديره من هنا حتى تبقى `rbac.js` نقطة الاستيراد الوحيدة
 * لبقية الخادم.
 */
export {
  ACCESS_DELETE_GRADE,
  ACCESS_LEVELS,
  ACCESS_SCOPE_TYPES,
  ACCESS_SCOPES,
  availableLevels,
  accessCatalogPayload,
  codesAboveModuleLevel,
  codesForModuleLevel,
  deleteCodesForModule,
  derivedModuleDelete,
  derivedModuleLevel,
  isDeleteAvailable,
  isLevelAvailable,
  maxAvailableLevel,
  MODULE_CATALOG,
  MODULE_DELETE_GRADE,
  MODULE_INDEX,
  MODULE_INHERITS,
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

export interface MatchedAccessRule {
  scopeType: string;
  scopeKey: string;
  moduleKey: string;
  level: number;
  canDelete: boolean;
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
      canDelete: accessRules.canDelete,
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

/**
 * نفس الحساب السابق لكن لكل الموظفين بقراءة جماعية واحدة. تستخدمه أداة
 * التدقيق التي تمرّ على النظام كاملاً، فلا تُصدر استعلاماً لكل موظف.
 */
export async function accessRulesByEmployee(): Promise<
  Map<number, MatchedAccessRule[]>
> {
  const db = getDb();
  const rows = await db
    .select({
      employeeId: employees.id,
      scopeType: accessRules.scopeType,
      scopeKey: accessRules.scopeKey,
      moduleKey: accessRules.moduleKey,
      level: accessRules.level,
      canDelete: accessRules.canDelete,
    })
    .from(employees)
    .innerJoin(
      accessRules,
      and(
        ne(accessRules.scopeKey, ""),
        or(
          and(
            eq(accessRules.scopeType, "employee"),
            eq(accessRules.employeeId, employees.id),
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

  const byEmployee = new Map<number, MatchedAccessRule[]>();
  for (const row of rows) {
    const { employeeId, ...rule } = row;
    const bucket = byEmployee.get(employeeId);
    if (bucket) bucket.push(rule);
    else byEmployee.set(employeeId, [rule]);
  }
  return byEmployee;
}

/** الأخصّ يفوز: قاعدة الموظف ثم قاعدة قسمه ثم قاعدة مسماه الوظيفي. */
const SCOPE_PRECEDENCE: Record<string, number> = {
  employee: 3,
  department: 2,
  job_title: 1,
};

/** قرار قاعدة واحدة في بند واحد بعد حسم تعارض النطاقات. */
export interface RuleDecision {
  level: number;
  canDelete: boolean;
}

/**
 * قرار كل بند بعد حسم التعارض بين النطاقات: تُختار القاعدة الأخصّ لا الأعلى
 * درجة، حتى يستطيع المسؤول تخفيض موظف بعينه دون تفكيك قاعدة قسمه.
 */
export function resolveRuleDecisions(
  rules: MatchedAccessRule[],
): Record<string, RuleDecision> {
  const winners = new Map<string, { rank: number; decision: RuleDecision }>();
  for (const rule of rules) {
    const rank = SCOPE_PRECEDENCE[rule.scopeType] ?? 0;
    const current = winners.get(rule.moduleKey);
    if (current && current.rank >= rank) continue;
    winners.set(rule.moduleKey, {
      rank,
      decision: { level: rule.level, canDelete: rule.canDelete },
    });
  }
  const decisions: Record<string, RuleDecision> = {};
  for (const [moduleKey, entry] of winners) decisions[moduleKey] = entry.decision;
  return decisions;
}

export interface AccessProfile {
  /** الرموز الذرّية الفعلية بعد تطبيق القواعد سحباً ومنحاً ثم الحظر الصريح */
  codes: string[];
  /** درجة كل بند (1..4) — البنود غير الممنوحة لا تظهر */
  moduleLevels: Record<string, number>;
  /** بنود يملك فيها الموظف الحذف — درجة مستقلة عن السلّم */
  moduleDelete: Record<string, boolean>;
}

/* ── أرضية تطبيق الجوال ───────────────────────────────────────────
 * ثلاث صلاحيات مضمونة **في الكود** لكل موظف مهما قالت قواعده أو لم تقل،
 * وبلا أي اعتماد على قاعدة بيانات أو دور: بها يفتح تطبيق الجوال شاشاته
 * الثلاث التي لا تُحجب عن أحد (البصمة، الطلبات، تغيير الرقم السري).
 *
 * وجودها هنا — لا في `access_rules` — مقصود: قاعدة يمكن حذفها من شاشة
 * إدارة الصلاحيات، وهذه لا. فأسوأ خطأ في القواعد لا يمنع موظفاً من تسجيل
 * حضوره ولا من رفع طلب.
 */
export const MOBILE_APP_FLOOR_CODES: string[] = [
  PERMISSIONS.attendanceCheckIn,
  PERMISSIONS.attendanceReadOwn,
  PERMISSIONS.formsSubmit,
];

/**
 * بند «حضوري وانصرافي» يُرفع إلى درجة «تسجيل حركة» مع الأرضية، لأن رموز
 * درجتيه (1 و2) هي بعينها رمزا الحضور في الأرضية — فلا يفتح هذا الرفع أي
 * بيانات لموظف آخر. أما `forms.submit` فيُمنح رمزاً مفرداً بلا رفع درجة أي
 * بند نماذج، حتى لا يرى أحدٌ طلبات غيره (`forms.read_all`) بحجّة الأرضية.
 */
const MOBILE_APP_FLOOR_MODULE = "attendance_self";
const MOBILE_APP_FLOOR_LEVEL = 2;

/** يفرض أرضية الجوال على صورة صلاحيات محسوبة — آخر خطوة دائماً. */
function applyMobileAppFloor(profile: AccessProfile): AccessProfile {
  const codes = new Set(profile.codes);
  for (const code of MOBILE_APP_FLOOR_CODES) codes.add(code);
  const moduleLevels = { ...profile.moduleLevels };
  if ((moduleLevels[MOBILE_APP_FLOOR_MODULE] ?? 0) < MOBILE_APP_FLOOR_LEVEL) {
    moduleLevels[MOBILE_APP_FLOOR_MODULE] = MOBILE_APP_FLOOR_LEVEL;
  }
  return { codes: [...codes], moduleLevels, moduleDelete: profile.moduleDelete };
}

/**
 * هل تحقّقت أرضية الجوال في هذه الصورة؟ تُستخدمها أداة التدقيق للتأكيد أن
 * الضمان قائم فعلاً لا مجرد نيّة.
 */
export function satisfiesMobileAppFloor(profile: AccessProfile): boolean {
  const owned = new Set(profile.codes);
  return MOBILE_APP_FLOOR_CODES.every((code) => owned.has(code));
}

/**
 * الحساب الخالص لصورة الصلاحيات: يأخذ القواعد المنطبقة جاهزة فلا يلمس قاعدة
 * البيانات. تستدعيه `accessProfile` لطلب واحد، وتستدعيه أداة التدقيق لكل
 * الموظفين بعد قراءة جماعية واحدة.
 *
 *   • القاعدة في `access_rules` هي وحدها ما يمنح البند درجته؛ والبند بلا
 *     قاعدة درجته صفر — لا استنتاج من دور ولا من أي حقل آخر.
 *   • الحذف درجة مستقلة: القاعدة تمنحه أو تمنعه بمعزل عن درجة التعديل.
 *   • الدرجات تراكمية: درجة 3 تفتح رموز 1 و2 معها.
 *   • أرضية الجوال الثلاثية تُفرض في الختام بلا شرط.
 */
export function buildAccessProfile(rules: MatchedAccessRule[]): AccessProfile {
  const decisions = resolveRuleDecisions(rules);

  const levels: Record<string, number> = {};
  const deletes: Record<string, boolean> = {};
  for (const module of MODULE_CATALOG) {
    const rule = decisions[module.key];
    levels[module.key] = rule ? rule.level : 0;
    deletes[module.key] =
      isDeleteAvailable(module.key) && rule !== undefined && rule.canDelete;
  }

  /*
   * وراثة البنود المفصولة: البند الابن بلا قاعدة خاصة يأخذ درجة أبيه وخانة
   * حذفه. لا يوسّع هذا صلاحية أحد، إنما يمنع سحبها بأثر رجعي حين يُفصل بندٌ
   * كان مندرجاً في غيره — ووجود قاعدة صريحة للابن يُلغي الوراثة كلها سحباً
   * كان أو منحاً، فالقاعدة الصريحة هي القول الأخير دائماً.
   */
  for (const [child, parent] of Object.entries(MODULE_INHERITS)) {
    if (decisions[child] !== undefined) continue;
    if (!MODULE_INDEX.has(child)) continue;
    const inherited = levels[parent] ?? 0;
    if (inherited > 0) {
      levels[child] = Math.min(inherited, maxAvailableLevel(child));
    }
    if (isDeleteAvailable(child) && deletes[parent] === true) {
      deletes[child] = true;
    }
  }

  // الرموز الذرّية التي تبرّرها هذه الدرجات — وهي كل ما يملكه الموظف
  const codes = new Set<string>();
  for (const module of MODULE_CATALOG) {
    for (const code of codesForModuleLevel(module.key, levels[module.key])) {
      codes.add(code);
    }
    if (deletes[module.key]) {
      for (const code of deleteCodesForModule(module.key)) codes.add(code);
    }
  }

  const moduleLevels: Record<string, number> = {};
  const moduleDelete: Record<string, boolean> = {};
  for (const module of MODULE_CATALOG) {
    if (levels[module.key] > 0) moduleLevels[module.key] = levels[module.key];
    if (deletes[module.key]) moduleDelete[module.key] = true;
  }

  return applyMobileAppFloor({ codes: [...codes], moduleLevels, moduleDelete });
}

/**
 * الصورة الكاملة لصلاحيات موظف. `access_rules` هي المصدر **الوحيد**: لا
 * يُستنتج شيء من دور ولا من أي حقل آخر، وما لا قاعدة له درجته صفر.
 *
 * ويبقى فوق ذلك ضمان واحد لا تملكه قاعدة البيانات: أرضية تطبيق الجوال
 * الثلاثية تُفرض في الكود على كل صورة، فحتى الموظف الذي لا قاعدة له إطلاقاً
 * يسجّل حضوره ويرفع طلبه ويغيّر كلمة مروره.
 */
export async function accessProfile(options: {
  employeeId: number | null;
}): Promise<AccessProfile> {
  return buildAccessProfile(await accessRulesForEmployee(options.employeeId));
}

/**
 * الرموز الذرّية الفعلية للموظف كما تنتجها قواعده الصريحة وأرضية الجوال.
 * تُستخدم في الرد على `/auth/me` حتى تتوافق الواجهة مع ما يفرضه الخادم.
 */
export async function effectivePermissionCodes(options: {
  employeeId: number | null;
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
  const pending = accessProfile({ employeeId: req.employee?.id ?? null });
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

/** هل يملك الموظف درجة الحذف في هذا البند؟ (مستقلة عن درجة التعديل) */
export async function hasModuleDelete(
  req: AuthedRequest,
  moduleKey: string,
): Promise<boolean> {
  const profile = await profileForRequest(req);
  return profile.moduleDelete[moduleKey] === true;
}

const LEVEL_DENIAL: Record<number, string> = {
  1: "لا تملك صلاحية عرض هذا البند",
  2: "لا تملك صلاحية تسجيل حركة في هذا البند",
  3: "لا تملك صلاحية الإضافة أو التعديل في هذا البند",
  4: "لا تملك صلاحية إعطاء الموافقات في هذا البند",
};

/** وسيط يتحقق من امتلاك الموظف صلاحية مُحدّدة. */
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

/**
 * وسيط الحذف: درجة مستقلة، فامتلاك «إضافة/تعديل» لا يكفي لحذف سجل. يُركَّب
 * على كل مسار حذف (فردي أو جماعي) فوق فحص الرمز الذرّي.
 */
export function requireModuleDelete(moduleKey: string) {
  return async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (await hasModuleDelete(req, moduleKey)) {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: "لا تملك صلاحية الحذف في هذا البند",
    });
  };
}

export interface AccessRuleRecord {
  id: number;
  scopeType: string;
  scopeKey: string;
  employeeId: number | null;
  moduleKey: string;
  level: number;
  canDelete: boolean;
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
      canDelete: accessRules.canDelete,
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
  /** عدد البنود المسحوبة كاملاً (درجة 0) — يُظهر أن القاعدة تسحب لا تمنح فقط */
  withdrawn: number;
  /** عدد البنود الممنوح فيها الحذف */
  deletes: number;
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
      canDelete: accessRules.canDelete,
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
        withdrawn: row.level === 0 ? 1 : 0,
        deletes: row.canDelete ? 1 : 0,
        updatedAt: row.updatedAt,
      });
      continue;
    }
    current.modules += 1;
    current.maxLevel = Math.max(current.maxLevel, row.level);
    if (row.level === 0) current.withdrawn += 1;
    if (row.canDelete) current.deletes += 1;
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
