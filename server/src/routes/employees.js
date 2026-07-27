// routes/employees.js — إدارة الموظفين (CRUD) مع حذف منطقي وتسجيل تدقيق
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

router.use(requireAuth);

// GET /api/employees — قائمة الموظفين (غير المحذوفين)
router.get('/', requirePermission('employees.view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT e.id, e.full_name, e.username, e.phone, e.email, e.role_id, r.name AS role_name,
              e.primary_branch_id, b.name AS branch_name, e.is_active, e.hire_date, e.created_at
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN branches b ON b.id = e.primary_branch_id
       WHERE e.deleted_at IS NULL
       ORDER BY e.id`
    );
    res.json({ employees: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/employees/:id
router.get('/:id', requirePermission('employees.view'), async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الموظف غير موجود' });
    const { password_hash, face_template_enc, ...safeEmployee } = result.rows[0];
    res.json({ employee: safeEmployee });
  } catch (err) {
    next(err);
  }
});

// POST /api/employees — إنشاء موظف جديد
router.post('/', requirePermission('employees.create'), async (req, res, next) => {
  try {
    const { fullName, username, password, phone, email, nationalId, roleId, primaryBranchId, hireDate } = req.body;
    if (!fullName || !username || !password || !roleId) {
      return res.status(400).json({ error: 'الاسم واسم المستخدم وكلمة المرور والدور حقول مطلوبة' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await query(
      `INSERT INTO employees
        (full_name, username, password_hash, phone, email, national_id, role_id, primary_branch_id, hire_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, full_name, username`,
      [fullName, username, passwordHash, phone || null, email || null, nationalId || null, roleId, primaryBranchId || null, hireDate || null]
    );

    const created = result.rows[0];
    await req.audit({
      action: 'employee.create',
      entityType: 'employees',
      entityId: created.id,
      newValue: { fullName, username, roleId, primaryBranchId },
    });

    res.status(201).json({ employee: created });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
    }
    next(err);
  }
});

// PUT /api/employees/:id — تعديل بيانات موظف
router.put('/:id', requirePermission('employees.update'), async (req, res, next) => {
  try {
    const existingRes = await query('SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });

    const { fullName, phone, email, roleId, primaryBranchId, isActive } = req.body;
    const updated = await query(
      `UPDATE employees SET
         full_name = COALESCE($1, full_name),
         phone = COALESCE($2, phone),
         email = COALESCE($3, email),
         role_id = COALESCE($4, role_id),
         primary_branch_id = COALESCE($5, primary_branch_id),
         is_active = COALESCE($6, is_active),
         updated_at = now()
       WHERE id = $7 RETURNING id, full_name, username, role_id, primary_branch_id, is_active`,
      [fullName, phone, email, roleId, primaryBranchId, isActive, req.params.id]
    );

    await req.audit({
      action: 'employee.update',
      entityType: 'employees',
      entityId: req.params.id,
      oldValue: {
        fullName: existing.full_name,
        phone: existing.phone,
        email: existing.email,
        roleId: existing.role_id,
        primaryBranchId: existing.primary_branch_id,
        isActive: existing.is_active,
      },
      newValue: updated.rows[0],
    });

    res.json({ employee: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/employees/:id — حذف منطقي (Soft Delete)
router.delete('/:id', requirePermission('employees.delete'), async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE employees SET deleted_at = now(), is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الموظف غير موجود أو محذوف مسبقاً' });

    await req.audit({
      action: 'employee.soft_delete',
      entityType: 'employees',
      entityId: req.params.id,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
