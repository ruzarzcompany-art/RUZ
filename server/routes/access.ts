import { Router, type Response } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  accessRules,
  departments,
  employees,
  jobTitles,
} from "../../db/schema.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { computeAccessAudit } from "../accessAudit.js";
import { clientIp, recordAudit } from "../audit.js";
import {
  accessCatalogPayload,
  accessProfile,
  accessRuleScopeSummary,
  accessRulesForEmployee,
  ACCESS_LEVELS,
  buildAccessProfile,
  deleteScopeModules,
  isAccessScopeType,
  isDeleteAvailable,
  isLevelAvailable,
  MODULE_CATALOG,
  MODULE_INDEX,
  PERMISSIONS,
  requireModuleDelete,
  requireModuleLevel,
  requirePermission,
  resolveRuleDecisions,
  rulesForScope,
  type AccessScopeType,
  type RuleDecision,
} from "../rbac.js";
import { asId, asString, badRequest } from "../validate.js";

export const accessRouter = Router();

/* ── شاشة «إدارة الصلاحيات» ──────────────────────────────────────
 * تمنح الصلاحيات على ثلاثة نطاقات (موظف محدّد، قسم كامل، مسمى وظيفي)
 * بأربع درجات متدرّجة لكل بند، ودرجة حذف مستقلة عنها. القواعد تُخزَّن في
 * `access_rules` ويُترجمها `rbac.ts` إلى رموز صلاحيات ودرجات تُفحص في
 * الخادم عند كل طلب — فالإخفاء في الواجهة مكمّل للفحص لا بديل عنه.
 *
 * هذه الشاشة **المصدر الوحيد**: البند الذي له قاعدة تحسم درجته القاعدة،
 * والدرجة 0 تعني سحبه كاملاً، والبند بلا قاعدة درجته صفر — لا استنتاج من
 * دور ولا من غيره. ويبقى فوق الجميع ضمان واحد مكتوب في الكود لا في قاعدة
 * البيانات: أرضية تطبيق الجوال الثلاثية.
 */

const MODULE_KEYS = new Set(MODULE_CATALOG.map((module) => module.key));

/** الحد الأعلى لعدد البنود في طلب واحد (كل البنود مرة واحدة أقصى حالة). */
const MAX_MODULES_PER_REQUEST = MODULE_CATALOG.length;

interface ScopeTarget {
  scopeType: AccessScopeType;
  scopeKey: string;
  employeeId: number | null;
  label: string;
}

/**
 * يتحقق من النطاق المطلوب ويعيد شكله المعياري. مطابقة القسم والمسمى تجري
 * بالنص، فأي خطأ إملائي يعني قاعدة لا تنطبق على أحد — لذلك يُرفض أي مفتاح
 * لا يقابل قسماً/مسمى معرّفاً أو مستخدماً فعلاً في ملفات الموظفين.
 */
async function resolveScope(
  rawScopeType: unknown,
  rawScopeKey: unknown,
): Promise<{ ok: true; target: ScopeTarget } | { ok: false; error: string }> {
  if (!isAccessScopeType(rawScopeType)) {
    return { ok: false, error: "نطاق غير معروف (موظف/قسم/مسمى وظيفي)." };
  }

  const db = getDb();

  if (rawScopeType === "employee") {
    const employeeId = asId(rawScopeKey);
    if (employeeId === null) return { ok: false, error: "معرّف الموظف غير صالح." };

    const [employee] = await db
      .select({ id: employees.id, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) return { ok: false, error: "الموظف غير موجود." };

    return {
      ok: true,
      target: {
        scopeType: "employee",
        scopeKey: String(employee.id),
        employeeId: employee.id,
        label: employee.fullName,
      },
    };
  }

  const scopeKey = asString(rawScopeKey, 120);
  if (!scopeKey) {
    return {
      ok: false,
      error: rawScopeType === "department" ? "اسم القسم مطلوب." : "المسمى الوظيفي مطلوب.",
    };
  }

  if (rawScopeType === "department") {
    const [defined] = await db
      .select({ name: departments.name })
      .from(departments)
      .where(eq(departments.name, scopeKey))
      .limit(1);
    const [used] = defined
      ? [defined]
      : await db
          .select({ name: employees.department })
          .from(employees)
          .where(eq(employees.department, scopeKey))
          .limit(1);
    if (!used) return { ok: false, error: "قسم غير معروف — اختره من القائمة." };
  } else {
    const [defined] = await db
      .select({ name: jobTitles.name })
      .from(jobTitles)
      .where(eq(jobTitles.name, scopeKey))
      .limit(1);
    const [used] = defined
      ? [defined]
      : await db
          .select({ name: employees.jobTitle })
          .from(employees)
          .where(eq(employees.jobTitle, scopeKey))
          .limit(1);
    if (!used) return { ok: false, error: "مسمى وظيفي غير معروف — اختره من القائمة." };
  }

  return {
    ok: true,
    target: {
      scopeType: rawScopeType,
      scopeKey,
      employeeId: null,
      label: scopeKey,
    },
  };
}

/** الموظفون الذين تنطبق عليهم قاعدة النطاق (لعرض حجم الأثر قبل الحفظ). */
async function employeesInScope(
  target: ScopeTarget,
): Promise<Array<{ id: number; employeeCode: string; fullName: string }>> {
  const db = getDb();
  const columns = {
    id: employees.id,
    employeeCode: employees.employeeCode,
    fullName: employees.fullName,
  };

  if (target.scopeType === "employee") {
    return db
      .select(columns)
      .from(employees)
      .where(eq(employees.id, target.employeeId ?? 0));
  }

  const column =
    target.scopeType === "department" ? employees.department : employees.jobTitle;
  return db
    .select(columns)
    .from(employees)
    .where(eq(column, target.scopeKey))
    .orderBy(asc(employees.fullName))
    .limit(500);
}

/** هل تنطبق قاعدة هذا النطاق على الموظف المنفّذ نفسه؟ */
async function scopeCoversActor(
  target: ScopeTarget,
  actorId: number,
): Promise<boolean> {
  if (target.scopeType === "employee") return target.employeeId === actorId;
  const db = getDb();
  const [actor] = await db
    .select({
      department: employees.department,
      jobTitle: employees.jobTitle,
    })
    .from(employees)
    .where(eq(employees.id, actorId))
    .limit(1);
  if (!actor) return false;
  return target.scopeType === "department"
    ? actor.department === target.scopeKey
    : actor.jobTitle === target.scopeKey;
}

/**
 * هل يبقى للمنفّذ إدارة الصلاحيات بعد هذا الحفظ؟ محاكاة أثره عليه قبل
 * تنفيذه: القاعدة تسحب كما تمنح، فقد يقفل مسؤول الشاشة على نفسه بقاعدة قسم
 * أو مسمى. ونعيد بناء قواعده بعد استبدال قواعد هذا النطاق بالمطلوبة.
 *
 * و`access_rules` هي مصدر الصلاحيات الوحيد، فلا شيء يمنح «إدارة الصلاحيات»
 * خارج قاعدة محفوظة: من لا قاعدة تبلغه الدرجة 3 في هذا البند لا يملكه،
 * فيُرفض الحفظ الذي يُسقطه.
 */
async function actorKeepsAccessControl(
  target: ScopeTarget,
  actor: { id: number },
  pending: Map<string, RuleDecision>,
): Promise<boolean> {
  if (!(await scopeCoversActor(target, actor.id))) return true;

  const matched = await accessRulesForEmployee(actor.id);
  const simulated = matched.filter(
    (rule) =>
      !(rule.scopeType === target.scopeType && rule.scopeKey === target.scopeKey),
  );
  const wanted = pending.get("access_control");
  if (wanted) {
    simulated.push({
      scopeType: target.scopeType,
      scopeKey: target.scopeKey,
      moduleKey: "access_control",
      level: wanted.level,
      canDelete: wanted.canDelete,
    });
  }

  const decision = resolveRuleDecisions(simulated)["access_control"];
  return decision !== undefined && decision.level >= 3;
}

/**
 * الأرضية المضمونة في الكود: ما يبقى للموظف وإن لم تكن له قاعدة واحدة
 * (أرضية تطبيق الجوال). تُعرض خلفيةً للمقارنة في شاشة الصلاحيات حتى يرى
 * المسؤول الفرق بين ما تمنحه قاعدته وما هو مضمون بلا قاعدة أصلاً.
 */
function codeFloorBaseline(): {
  levels: Record<string, number>;
  deletes: Record<string, boolean>;
} {
  const floor = buildAccessProfile([]);
  return { levels: floor.moduleLevels, deletes: floor.moduleDelete };
}

/* ── القاموس وخيارات النطاقات ────────────────────────────────────── */

accessRouter.get(
  "/access/catalog",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  async (_req: AuthedRequest, res: Response) => {
    const db = getDb();
    const [departmentRows, jobTitleRows, employeeRows] = await Promise.all([
      db
        .select({ name: departments.name, isActive: departments.isActive })
        .from(departments)
        .orderBy(asc(departments.name)),
      db
        .select({ name: jobTitles.name, isActive: jobTitles.isActive })
        .from(jobTitles)
        .orderBy(asc(jobTitles.name)),
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
        .orderBy(asc(employees.fullName))
        .limit(1000),
    ]);

    // الأقسام والمسميات المستخدمة في ملفات الموظفين وإن لم تُعرَّف في الإعدادات
    const departmentNames = new Set(departmentRows.map((row) => row.name));
    const jobTitleNames = new Set(jobTitleRows.map((row) => row.name));
    for (const employee of employeeRows) {
      if (employee.department) departmentNames.add(employee.department);
      if (employee.jobTitle) jobTitleNames.add(employee.jobTitle);
    }

    res.json({
      ok: true,
      ...accessCatalogPayload(),
      departments: [...departmentNames].sort((a, b) => a.localeCompare(b, "ar")),
      jobTitles: [...jobTitleNames].sort((a, b) => a.localeCompare(b, "ar")),
      employees: employeeRows,
    });
  },
);

/* ── القواعد المحفوظة ────────────────────────────────────────────── */

accessRouter.get(
  "/access/rules",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  async (_req: AuthedRequest, res: Response) => {
    const summary = await accessRuleScopeSummary();
    const employeeIds = summary
      .map((entry) => entry.employeeId)
      .filter((id): id is number => id !== null);

    const db = getDb();
    const names =
      employeeIds.length === 0
        ? []
        : await db
            .select({
              id: employees.id,
              employeeCode: employees.employeeCode,
              fullName: employees.fullName,
            })
            .from(employees)
            .where(inArray(employees.id, employeeIds));
    const nameById = new Map(names.map((row) => [row.id, row]));

    res.json({
      ok: true,
      items: summary.map((entry) => {
        const employee =
          entry.employeeId === null ? undefined : nameById.get(entry.employeeId);
        return {
          ...entry,
          label: employee ? employee.fullName : entry.scopeKey,
          employeeCode: employee?.employeeCode ?? "",
        };
      }),
    });
  },
);

/** قواعد نطاق واحد + من تنطبق عليهم (لتحرير الجدول). */
accessRouter.get(
  "/access/rules/detail",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  async (req: AuthedRequest, res: Response) => {
    const scope = await resolveScope(req.query.scopeType, req.query.scopeKey);
    if (!scope.ok) {
      badRequest(res, scope.error);
      return;
    }

    const [rules, affected] = await Promise.all([
      rulesForScope(scope.target.scopeType, scope.target.scopeKey),
      employeesInScope(scope.target),
    ]);

    const levels: Record<string, number> = {};
    const deletes: Record<string, boolean> = {};
    const notes: Record<string, string> = {};
    for (const rule of rules) {
      levels[rule.moduleKey] = rule.level;
      deletes[rule.moduleKey] = rule.canDelete;
      if (rule.note) notes[rule.moduleKey] = rule.note;
    }

    /**
     * نطاق «موظف محدّد» يُعرض معه ما هو مضمون له بلا قاعدة (خلفية المقارنة)
     * والمحصّلة الفعلية الآن، حتى يرى المسؤول أثر ما يحفظه فوراً.
     */
    let baseline: ReturnType<typeof codeFloorBaseline> | null = null;
    let effective: { moduleLevels: Record<string, number>; moduleDelete: Record<string, boolean> } | null =
      null;
    if (scope.target.scopeType === "employee" && scope.target.employeeId !== null) {
      const db = getDb();
      const [employee] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.id, scope.target.employeeId))
        .limit(1);
      if (employee) {
        const profile = await accessProfile({ employeeId: employee.id });
        baseline = codeFloorBaseline();
        effective = {
          moduleLevels: profile.moduleLevels,
          moduleDelete: profile.moduleDelete,
        };
      }
    }

    res.json({
      ok: true,
      scope: {
        scopeType: scope.target.scopeType,
        scopeKey: scope.target.scopeKey,
        label: scope.target.label,
      },
      levels,
      deletes,
      notes,
      baseline,
      effective,
      affected: affected.length,
      affectedEmployees: affected.slice(0, 50),
    });
  },
);

/**
 * استبدال قواعد نطاق كامل. `rules` خريطة
 * `moduleKey → { level: 0..4, canDelete: boolean }`؛ وجود البند في الخريطة
 * يعني قاعدة تحسم درجته، والدرجة 0 تعني سحبه كاملاً. والبنود الغائبة عن
 * الخريطة تُحذف قاعدتها في هذا النطاق، فيرجع أصحابها فيها إلى ما يمنحه
 * نطاق أعمّ إن وُجد، وإلا إلى الصفر.
 */
accessRouter.put(
  "/access/rules",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  requireModuleLevel("access_control", 3),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const scope = await resolveScope(req.body?.scopeType, req.body?.scopeKey);
    if (!scope.ok) {
      badRequest(res, scope.error);
      return;
    }

    const rawRules = req.body?.rules;
    if (rawRules === null || typeof rawRules !== "object") {
      badRequest(res, "قائمة البنود مطلوبة (rules).");
      return;
    }

    const entries = Object.entries(rawRules as Record<string, unknown>);
    if (entries.length > MAX_MODULES_PER_REQUEST) {
      badRequest(res, "عدد البنود أكبر من المتاح.");
      return;
    }

    const wanted = new Map<string, RuleDecision>();
    for (const [moduleKey, rawRule] of entries) {
      if (!MODULE_KEYS.has(moduleKey)) {
        badRequest(res, `بند غير معروف: ${moduleKey}`);
        return;
      }
      if (rawRule === null || typeof rawRule !== "object") {
        badRequest(res, `قاعدة غير صالحة للبند ${moduleKey}`);
        return;
      }

      const entry = rawRule as Record<string, unknown>;
      const level = Number(entry.level ?? 0);
      if (!Number.isInteger(level) || level < 0 || level > 4) {
        badRequest(res, `درجة غير صالحة للبند ${moduleKey}`);
        return;
      }

      const label = MODULE_INDEX.get(moduleKey)?.label ?? moduleKey;
      if (level > 0 && !isLevelAvailable(moduleKey, level)) {
        const levelLabel =
          ACCESS_LEVELS.find((item) => item.level === level)?.label ?? level;
        badRequest(res, `الدرجة «${levelLabel}» غير متاحة لبند «${label}».`);
        return;
      }

      const canDelete = entry.canDelete === true;
      if (canDelete && !isDeleteAvailable(moduleKey)) {
        badRequest(res, `لا يوجد حذف في بند «${label}».`);
        return;
      }

      wanted.set(moduleKey, { level, canDelete });
    }

    // حماية من قفل النظام: لا يُسمح للمنفّذ بإسقاط إدارة الصلاحيات عن نفسه
    // إلا إذا كان دوره (أو تخصيصه الفردي) يمنحها له أصلاً بلا قاعدة.
    const currentRules = await rulesForScope(
      scope.target.scopeType,
      scope.target.scopeKey,
    );
    if (!(await actorKeepsAccessControl(scope.target, actor, wanted))) {
      res.status(400).json({
        ok: false,
        error:
          "لا يمكنك سحب «إدارة الصلاحيات» عن نفسك — اطلب من مدير آخر تعديل هذه القاعدة.",
      });
      return;
    }

    const note = asString(req.body?.note, 500) ?? "";
    const db = getDb();
    const now = new Date();

    const removed = currentRules
      .filter((rule) => !wanted.has(rule.moduleKey))
      .map((rule) => rule.moduleKey);

    if (removed.length > 0) {
      await deleteScopeModules(scope.target.scopeType, scope.target.scopeKey, removed);
    }

    for (const [moduleKey, decision] of wanted) {
      await db
        .insert(accessRules)
        .values({
          scopeType: scope.target.scopeType,
          scopeKey: scope.target.scopeKey,
          employeeId: scope.target.employeeId,
          moduleKey,
          level: decision.level,
          canDelete: decision.canDelete,
          note,
          grantedByEmployeeId: actor.id,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [accessRules.scopeType, accessRules.scopeKey, accessRules.moduleKey],
          set: {
            level: decision.level,
            canDelete: decision.canDelete,
            note,
            employeeId: scope.target.employeeId,
            grantedByEmployeeId: actor.id,
            updatedAt: now,
          },
        });
    }

    const before: Record<string, RuleDecision> = {};
    for (const rule of currentRules) {
      before[rule.moduleKey] = { level: rule.level, canDelete: rule.canDelete };
    }

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "access_rules.replace",
      entityType: "access_rules",
      entityId: null,
      before: {
        scopeType: scope.target.scopeType,
        scopeKey: scope.target.scopeKey,
        rules: before,
      },
      after: {
        scopeType: scope.target.scopeType,
        scopeKey: scope.target.scopeKey,
        rules: Object.fromEntries(wanted),
      },
      reason: note,
      ipAddress: clientIp(req),
    });

    const affected = await employeesInScope(scope.target);
    const withdrawn = [...wanted.values()].filter((rule) => rule.level === 0).length;

    res.json({
      ok: true,
      message: `تم حفظ صلاحيات «${scope.target.label}» (${wanted.size} بنداً${
        withdrawn > 0 ? `، منها ${withdrawn} مسحوب` : ""
      })`,
      rules: Object.fromEntries(wanted),
      affected: affected.length,
    });
  },
);

/** حذف كل قواعد نطاق (يعود أصحابه إلى صلاحيات دورهم فقط). */
accessRouter.delete(
  "/access/rules",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  requireModuleDelete("access_control"),
  async (req: AuthedRequest, res: Response) => {
    const actor = req.employee!;
    const scope = await resolveScope(
      req.query.scopeType ?? req.body?.scopeType,
      req.query.scopeKey ?? req.body?.scopeKey,
    );
    if (!scope.ok) {
      badRequest(res, scope.error);
      return;
    }

    const currentRules = await rulesForScope(
      scope.target.scopeType,
      scope.target.scopeKey,
    );

    if (currentRules.length === 0) {
      res.json({ ok: true, message: "لا توجد قواعد لهذا النطاق", removed: 0 });
      return;
    }

    if (!(await actorKeepsAccessControl(scope.target, actor, new Map()))) {
      res.status(400).json({
        ok: false,
        error: "لا يمكنك حذف القاعدة التي تمنحك إدارة الصلاحيات.",
      });
      return;
    }

    const db = getDb();
    await db
      .delete(accessRules)
      .where(
        and(
          eq(accessRules.scopeType, scope.target.scopeType),
          eq(accessRules.scopeKey, scope.target.scopeKey),
        ),
      );

    const before: Record<string, RuleDecision> = {};
    for (const rule of currentRules) {
      before[rule.moduleKey] = { level: rule.level, canDelete: rule.canDelete };
    }

    await recordAudit({
      actorEmployeeId: actor.id,
      action: "access_rules.delete",
      entityType: "access_rules",
      entityId: null,
      before: {
        scopeType: scope.target.scopeType,
        scopeKey: scope.target.scopeKey,
        rules: before,
      },
      after: null,
      reason: asString(req.query.reason ?? req.body?.reason, 500) ?? "",
      ipAddress: clientIp(req),
    });

    res.json({
      ok: true,
      message: `تم حذف قواعد «${scope.target.label}»`,
      removed: currentRules.length,
    });
  },
);

/**
 * المحصّلة الفعلية لموظف: درجة كل بند بعد ضمّ دوره وتخصيصاته وقواعد قسمه
 * ومسماه — نفس الحساب الذي يفرضه الخادم على كل طلب، فتُعرض للمسؤول كما هي.
 */
accessRouter.get(
  "/access/effective/:employeeId",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  async (req: AuthedRequest, res: Response) => {
    const employeeId = asId(req.params.employeeId);
    if (employeeId === null) {
      badRequest(res, "معرّف الموظف غير صالح");
      return;
    }

    const db = getDb();
    const [employee] = await db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        fullName: employees.fullName,
        department: employees.department,
        jobTitle: employees.jobTitle,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      res.status(404).json({ ok: false, error: "الموظف غير موجود" });
      return;
    }

    const profile = await accessProfile({ employeeId: employee.id });

    res.json({
      ok: true,
      employee,
      moduleLevels: profile.moduleLevels,
      moduleDelete: profile.moduleDelete,
      baseline: codeFloorBaseline(),
      permissions: profile.codes,
    });
  },
);

/* ── أداة التدقيق: هل كل صلاحية نافذة مردودة إلى قاعدة محفوظة؟ ─────
 *
 * بعد حذف نظام الأدوار لم يبقَ للصلاحيات مصدر غير `access_rules` وأرضية
 * الجوال المكتوبة في الكود. تمرّ الأداة على كل موظف وتردّ كل درجة نافذة
 * وكل رمز ذرّي إلى مصدره، فتُبلّغ عن أي شيء لا يبرّره أحدهما — والنتيجة
 * السليمة تغطية 100% بلا فجوة واحدة، وأرضية جوال قائمة للجميع.
 *
 * `?simulate=explicit-only` يبقى مقبولاً للتوافق مع ما قبل الحذف، ولا يغيّر
 * شيئاً اليوم: «الوضع الحالي» و«القواعد الصريحة وحدها» صارا شيئاً واحداً.
 */
accessRouter.get(
  "/access/audit",
  requireAuth,
  requirePermission(PERMISSIONS.permissionsManage),
  requireModuleLevel("access_control", 1),
  async (req: AuthedRequest, res: Response) => {
    const explicitOnly = String(req.query.simulate ?? "") === "explicit-only";
    res.json(await computeAccessAudit({ explicitOnly }));
  },
);
