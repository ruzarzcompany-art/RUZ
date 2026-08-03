-- بوابة أمان: لا يُحذف نظام الأدوار إلا والتغطية كاملة فعلاً في قاعدة البيانات.
-- تُقارن ما يمنحه دور كل موظف بما تغطّيه قواعده الصريحة في access_rules،
-- وتُفشل الترحيل كاملاً (قبل تنفيذ أي DROP) إن بقيت درجة واحدة غير مغطّاة.
WITH catalog (module_key, level, code) AS (
  VALUES
    ('attendance_self', 1, 'attendance.read_own'),
    ('attendance_self', 2, 'attendance.check_in'),
    ('attendance_records', 1, 'attendance.read_all'),
    ('attendance_records', 2, 'attendance.correct_checkout'),
    ('attendance_records', 3, 'attendance.approve'),
    ('attendance_records', 4, 'attendance.manual_write'),
    ('schedules', 1, 'sections.employee_file'),
    ('schedules', 2, 'schedules.manage'),
    ('schedules', 3, 'schedules.manage'),
    ('leaves', 1, 'forms.read_own'),
    ('leaves', 2, 'forms.submit'),
    ('leaves', 3, 'forms.read_all'),
    ('leaves', 4, 'forms.approve'),
    ('advances', 1, 'forms.read_own'),
    ('advances', 2, 'forms.submit'),
    ('advances', 3, 'forms.read_all'),
    ('advances', 4, 'forms.approve'),
    ('overtime', 1, 'forms.read_own'),
    ('overtime', 2, 'forms.submit'),
    ('overtime', 3, 'forms.read_all'),
    ('overtime', 4, 'forms.approve'),
    ('bonuses', 1, 'forms.read_own'),
    ('bonuses', 2, 'forms.read_all'),
    ('bonuses', 3, 'bonuses.manage'),
    ('bonuses', 4, 'bonuses.manage'),
    ('custody', 1, 'forms.read_own'),
    ('custody', 2, 'forms.read_all'),
    ('custody', 3, 'custody.manage'),
    ('contracts', 1, 'forms.read_own'),
    ('contracts', 2, 'forms.read_all'),
    ('contracts', 3, 'contracts.manage'),
    ('disciplinary', 1, 'documents.read_all'),
    ('disciplinary', 1, 'sections.documents'),
    ('disciplinary', 2, 'disciplinary.manage'),
    ('disciplinary', 3, 'disciplinary.manage'),
    ('cashier_self', 1, 'cashier.submit'),
    ('cashier_closing', 1, 'cashier.read_all'),
    ('cashier_closing', 1, 'sections.cashier_closing'),
    ('cashier_closing', 3, 'cashier.review'),
    ('cashier_closing', 4, 'cashier.review'),
    ('vouchers', 1, 'sections.cashier_closing'),
    ('vouchers', 2, 'vouchers.manage'),
    ('vouchers', 3, 'vouchers.manage'),
    ('payroll', 1, 'sections.payroll'),
    ('payroll', 2, 'payroll.manage'),
    ('payroll', 3, 'payroll.manage'),
    ('payroll', 4, 'payroll.manage'),
    ('salary', 1, 'sections.payroll'),
    ('salary', 3, 'salary.manage'),
    ('inventory_movements', 1, 'inventory.read'),
    ('inventory_movements', 1, 'sections.inventory'),
    ('inventory_movements', 2, 'inventory.write'),
    ('inventory_movements', 3, 'inventory.items_manage'),
    ('inventory_items', 1, 'inventory.read'),
    ('inventory_items', 1, 'sections.inventory'),
    ('inventory_items', 3, 'inventory.items_manage'),
    ('employees', 1, 'sections.employee_file'),
    ('employees', 2, 'employees.read'),
    ('employees', 3, 'employees.write'),
    ('documents', 1, 'documents.read_all'),
    ('documents', 1, 'sections.documents'),
    ('documents', 2, 'documents.print'),
    ('documents', 3, 'documents.read_all'),
    ('reports', 1, 'reports.view'),
    ('reports', 1, 'sections.reports'),
    ('branches', 1, 'branches.read'),
    ('branches', 3, 'branches.write'),
    ('settings', 1, 'sections.settings'),
    ('settings', 3, 'settings.manage'),
    ('audit', 1, 'audit.read'),
    ('access_control', 1, 'permissions.manage'),
    ('access_control', 3, 'permissions.manage')
),
delete_grade (module_key, code) AS (
  VALUES
    ('attendance_records', 'attendance.manual_write'),
    ('leaves', 'forms.approve'),
    ('advances', 'forms.approve'),
    ('overtime', 'forms.approve'),
    ('bonuses', 'bonuses.manage'),
    ('custody', 'custody.manage'),
    ('contracts', 'contracts.manage'),
    ('disciplinary', 'disciplinary.manage'),
    ('cashier_closing', 'cashier.review'),
    ('vouchers', 'vouchers.manage'),
    ('payroll', 'payroll.manage'),
    ('inventory_movements', 'inventory.items_manage'),
    ('inventory_items', 'inventory.items_manage'),
    ('employees', 'employees.write'),
    ('documents', 'documents.read_all'),
    ('branches', 'branches.write'),
    ('settings', 'settings.manage'),
    ('access_control', 'permissions.manage')
),
all_modules (module_key) AS (
  VALUES
    ('attendance_self'),
    ('attendance_records'),
    ('schedules'),
    ('leaves'),
    ('advances'),
    ('overtime'),
    ('bonuses'),
    ('custody'),
    ('contracts'),
    ('disciplinary'),
    ('cashier_self'),
    ('cashier_closing'),
    ('vouchers'),
    ('payroll'),
    ('salary'),
    ('inventory_movements'),
    ('inventory_items'),
    ('employees'),
    ('documents'),
    ('reports'),
    ('branches'),
    ('settings'),
    ('audit'),
    ('access_control')
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
),
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
FROM uncovered;--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_role_id_roles_id_fkey";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_roles_id_fkey";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_id_permissions_id_fkey";--> statement-breakpoint
DROP TABLE "permissions";--> statement-breakpoint
DROP TABLE "role_permissions";--> statement-breakpoint
DROP TABLE "roles";--> statement-breakpoint
ALTER TABLE "employees" DROP COLUMN "role_id";