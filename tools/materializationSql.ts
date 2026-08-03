import {
  MODULE_CATALOG,
  MODULE_DELETE_GRADE,
} from "../server/permissions.js";

/**
 * بناء استعلام «تثبيت صلاحيات الأدوار كقواعد صريحة» من قاموس البنود نفسه.
 *
 * يستخدمه مولّد ملف الترحيل (بصيغة INSERT) وأداة التحقق (بصيغة SELECT) —
 * فالمنطق واحد في الحالتين، وما تُتحقّق منه الأداة هو بعينه ما سيُنفّذ.
 */

/** الجداول المؤقتة: قاموس الدرجات، ورموز الحذف، وقائمة البنود. */
function catalogCte(): string {
  const catalogRows: string[] = [];
  for (const module of MODULE_CATALOG) {
    for (const spec of module.levels) {
      for (const code of spec.codes) {
        catalogRows.push(`    ('${module.key}', ${spec.level}, '${code}')`);
      }
    }
  }

  const deleteRows: string[] = [];
  for (const [moduleKey, grade] of Object.entries(MODULE_DELETE_GRADE)) {
    for (const code of grade.codes) {
      deleteRows.push(`    ('${moduleKey}', '${code}')`);
    }
  }

  const moduleRows = MODULE_CATALOG.map((module) => `    ('${module.key}')`);

  return `WITH catalog (module_key, level, code) AS (
  VALUES
${catalogRows.join(",\n")}
),
delete_grade (module_key, code) AS (
  VALUES
${deleteRows.join(",\n")}
),
all_modules (module_key) AS (
  VALUES
${moduleRows.join(",\n")}
),
employee_codes AS (
  SELECT e.id AS employee_id, p.code
  FROM employees e
  JOIN role_permissions rp ON rp.role_id = e.role_id
  JOIN permissions p ON p.id = rp.permission_id
),
derived AS (
  SELECT
    e.id AS employee_id,
    m.module_key,
    COALESCE((
      SELECT MAX(c.level)
      FROM catalog c
      WHERE c.module_key = m.module_key
        AND EXISTS (
          SELECT 1 FROM employee_codes ec
          WHERE ec.employee_id = e.id AND ec.code = c.code
        )
    ), 0) AS level,
    EXISTS (
      SELECT 1
      FROM delete_grade d
      JOIN employee_codes ec ON ec.code = d.code AND ec.employee_id = e.id
      WHERE d.module_key = m.module_key
    ) AS can_delete
  FROM employees e
  CROSS JOIN all_modules m
)`;
}

/** عدد صفوف القاموس المُدمجة في الاستعلام — لطبعها في تقرير التوليد. */
export function catalogSize(): { levels: number; deletes: number; modules: number } {
  let levels = 0;
  for (const module of MODULE_CATALOG) {
    for (const spec of module.levels) levels += spec.codes.length;
  }
  let deletes = 0;
  for (const grade of Object.values(MODULE_DELETE_GRADE)) deletes += grade.codes.length;
  return { levels, deletes, modules: MODULE_CATALOG.length };
}

/** صيغة الترحيل: كتابة القواعد الصريحة فعلياً. */
export function materializationInsertSql(): string {
  return `${catalogCte()}
INSERT INTO access_rules (
  scope_type, scope_key, employee_id, module_key, level, can_delete, note, created_at, updated_at
)
SELECT
  'employee',
  derived.employee_id::text,
  derived.employee_id,
  derived.module_key,
  derived.level,
  derived.can_delete,
  'ترحيل تلقائي: تثبيت صلاحيات الدور القديم كقاعدة صريحة',
  now(),
  now()
FROM derived
WHERE derived.level > 0 OR derived.can_delete
ON CONFLICT (scope_type, scope_key, module_key) DO NOTHING;`;
}

/** نفس المنطق قراءةً فقط: ما الصفوف التي سيكتبها الترحيل؟ */
export function materializationSelectSql(): string {
  return `${catalogCte()}
SELECT
  derived.employee_id,
  derived.module_key,
  derived.level,
  derived.can_delete
FROM derived
WHERE derived.level > 0 OR derived.can_delete
ORDER BY derived.employee_id, derived.module_key`;
}

/**
 * بوابة أمان تُوضع في صدر ترحيل الحذف: تقارن ما يمنحه الدور القديم لكل موظف
 * بما تغطّيه قواعده الصريحة، وتُفشل الترحيل كاملاً إن بقيت درجة واحدة غير
 * مغطّاة — فلا يُحذف نظام الأدوار إلا وقد صار كل شيء صريحاً فعلاً في قاعدة
 * البيانات، لا بناءً على تحقّق سابق في بيئة أخرى.
 *
 * مكتوبة بـ SQL خالص (بلا PL/pgSQL) ليطبّقها أي مُشغّل ترحيلات. والإفشال
 * يحدث بتحويل نصّ الرسالة إلى عدد صحيح، فتظهر الرسالة في خطأ الترحيل.
 */
export function coverageGuardSql(): string {
  return `${catalogCte()},
uncovered AS (
  SELECT d.employee_id, d.module_key
  FROM derived d
  LEFT JOIN access_rules ar
    ON ar.scope_type = 'employee'
   AND ar.employee_id = d.employee_id
   AND ar.module_key = d.module_key
  WHERE (d.level > 0 OR d.can_delete)
    AND (
      COALESCE(ar.level, 0) < d.level
      OR (d.can_delete AND NOT COALESCE(ar.can_delete, false))
    )
)
SELECT CASE
  WHEN count(*) = 0 THEN 0
  ELSE CAST(
    'REFUSING TO DROP ROLES: ' || count(*) ||
    ' grade(s) are still not covered by explicit access_rules — تعذّر حذف نظام الأدوار: توجد درجات لم تُغطَّ بقواعد صريحة'
    AS integer)
END AS legacy_role_removal_guard
FROM uncovered`;
}
