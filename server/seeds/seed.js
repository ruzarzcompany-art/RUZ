// seeds/seed.js — الأدوار والصلاحيات وحساب المدير الأول
// آمن لإعادة التشغيل: يستخدم ON CONFLICT DO NOTHING في كل مكان

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('../src/db');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

const ROLES = [
  { name: 'مدير عام', description: 'صلاحيات كاملة على كل الفروع' },
  { name: 'موارد بشرية', description: 'إدارة الموظفين والرواتب والحضور' },
  { name: 'مدير فرع', description: 'صلاحيات محصورة بفرعه فقط' },
  { name: 'موظف', description: 'تسجيل الحضور والانصراف فقط' },
];

const PERMISSIONS = [
  'employees.view', 'employees.create', 'employees.update', 'employees.delete',
  'branches.view', 'branches.create', 'branches.update', 'branches.delete', 'branches.all',
  'attendance.view', 'attendance.correct',
  'shifts.view', 'shifts.create', 'shifts.assign',
  'roles.view', 'roles.manage',
  'settings.view', 'settings.manage',
  'sessions.manage',
];

// صلاحيات كل دور بحسب اسمه
const ROLE_PERMISSIONS = {
  'مدير عام': PERMISSIONS, // كل الصلاحيات
  'موارد بشرية': [
    'employees.view', 'employees.create', 'employees.update', 'employees.delete',
    'branches.view', 'branches.all',
    'attendance.view', 'attendance.correct',
    'shifts.view', 'shifts.create', 'shifts.assign',
    'roles.view',
  ],
  'مدير فرع': [
    'employees.view',
    'branches.view',
    'attendance.view', 'attendance.correct',
    'shifts.view', 'shifts.create', 'shifts.assign',
  ],
  'موظف': [],
};

async function seedRolesAndPermissions() {
  const roleIdByName = {};
  for (const role of ROLES) {
    const res = await query(
      `INSERT INTO roles (name, description, is_system)
       VALUES ($1, $2, true)
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
       RETURNING id, name`,
      [role.name, role.description]
    );
    roleIdByName[res.rows[0].name] = res.rows[0].id;
  }

  const permIdByCode = {};
  for (const code of PERMISSIONS) {
    const res = await query(
      `INSERT INTO permissions (code, description)
       VALUES ($1, $1)
       ON CONFLICT (code) DO NOTHING
       RETURNING id, code`,
      [code]
    );
    if (res.rows[0]) {
      permIdByCode[res.rows[0].code] = res.rows[0].id;
    }
  }
  // إعادة قراءة كل الصلاحيات (لضمان الحصول على id حتى لو كانت موجودة مسبقاً)
  const allPerms = await query('SELECT id, code FROM permissions');
  for (const p of allPerms.rows) {
    permIdByCode[p.code] = p.id;
  }

  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByName[roleName];
    for (const code of codes) {
      const permId = permIdByCode[code];
      if (!permId) continue;
      await query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [roleId, permId]
      );
    }
  }

  return roleIdByName;
}

async function seedAdminEmployee(roleIdByName) {
  const username = process.env.ADMIN_INITIAL_USERNAME || 'admin';
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!password) {
    console.warn('⚠ ADMIN_INITIAL_PASSWORD غير معرّف — تخطي إنشاء حساب المدير الأول');
    return;
  }

  const existing = await query('SELECT id FROM employees WHERE username = $1', [username]);
  if (existing.rows[0]) {
    console.log(`⏭  حساب المدير (${username}) موجود مسبقاً، تم التخطي`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await query(
    `INSERT INTO employees (full_name, username, password_hash, role_id, is_active, must_change_password)
     VALUES ($1,$2,$3,$4,true,true)`,
    ['مدير النظام', username, passwordHash, roleIdByName['مدير عام']]
  );
  console.log(`✔ تم إنشاء حساب المدير الأول: ${username} (يجب تغيير كلمة المرور عند أول دخول)`);
}

async function seedDefaultSettings() {
  await query(
    `INSERT INTO system_settings (key, value) VALUES
       ('face_match_threshold', '0.6'),
       ('max_login_attempts', $1),
       ('lockout_minutes', $2)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10)), JSON.stringify(parseInt(process.env.LOCKOUT_MINUTES || '15', 10))]
  );
}

async function runSeed() {
  const roleIdByName = await seedRolesAndPermissions();
  await seedAdminEmployee(roleIdByName);
  await seedDefaultSettings();
}

if (require.main === module) {
  runSeed()
    .then(() => {
      console.log('اكتمل البذر (seed) بنجاح.');
      return pool.end();
    })
    .catch((err) => {
      console.error('فشل البذر:', err);
      process.exit(1);
    });
}

module.exports = { runSeed };
