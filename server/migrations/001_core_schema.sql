-- 001_core_schema.sql
-- الجداول الجوهرية لنظام إدارة موظفي وتشغيل مطعم متعدد الفروع
-- آمنة لإعادة التنفيذ (IF NOT EXISTS) — هذه هي الدفعة الأولى من أصل 52 جدولاً مخطط لها (راجع docs/تقرير-المرحلة.md)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===================== الأدوار والصلاحيات (RBAC) =====================

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  code VARCHAR(150) NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ===================== الفروع =====================

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  address TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  geofence_radius_meters INTEGER NOT NULL DEFAULT 150,
  timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Riyadh',
  is_active BOOLEAN NOT NULL DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== الموظفون =====================
-- ملاحظة: employee_id (id) هو المفتاح الرقمي الثابت لربط جميع الجداول — وليس الاسم ولا رقم الهوية

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(200) NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  phone VARCHAR(30),
  email VARCHAR(200),
  national_id VARCHAR(50),
  role_id INTEGER NOT NULL REFERENCES roles(id),
  primary_branch_id INTEGER REFERENCES branches(id),
  hire_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  face_template_enc TEXT,
  face_enrolled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role_id);
CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees(primary_branch_id);

-- ربط الموظف بأكثر من فرع (مدير فرع محصور بفرعه عبر هذا الجدول أو primary_branch_id)
CREATE TABLE IF NOT EXISTS employee_branches (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (employee_id, branch_id)
);

-- ===================== الجلسات ومحاولات الدخول =====================

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(200) NOT NULL,
  ip_address VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee ON sessions(employee_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(100),
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  ip_address VARCHAR(64),
  success BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username);

-- ===================== الورديات والحضور =====================

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  days_of_week SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_assignments (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_id, work_date)
);

CREATE TABLE IF NOT EXISTS attendance (
  id BIGSERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  shift_assignment_id INTEGER REFERENCES shift_assignments(id),
  check_in_at TIMESTAMPTZ,
  check_in_lat DOUBLE PRECISION,
  check_in_lon DOUBLE PRECISION,
  check_in_distance_meters INTEGER,
  check_in_method VARCHAR(20) DEFAULT 'face',
  check_out_at TIMESTAMPTZ,
  check_out_lat DOUBLE PRECISION,
  check_out_lon DOUBLE PRECISION,
  check_out_distance_meters INTEGER,
  check_out_method VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_branch ON attendance(branch_id);

-- ===================== التدقيق والإعدادات =====================

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(50),
  old_value JSONB,
  new_value JSONB,
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by INTEGER REFERENCES employees(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
