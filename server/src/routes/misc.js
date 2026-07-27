// routes/misc.js — الأدوار/الصلاحيات/الإعدادات العامة وإدارة الجلسات
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// GET /api/misc/roles
router.get('/roles', requirePermission('roles.view'), async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM roles ORDER BY id');
    res.json({ roles: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/misc/permissions
router.get('/permissions', requirePermission('roles.view'), async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM permissions ORDER BY code');
    res.json({ permissions: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/misc/roles/:id/permissions — تحديث صلاحيات دور معيّن
router.put('/roles/:id/permissions', requirePermission('roles.manage'), async (req, res, next) => {
  try {
    const { permissionIds } = req.body;
    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ error: 'permissionIds يجب أن تكون مصفوفة' });
    }

    const oldRes = await query('SELECT permission_id FROM role_permissions WHERE role_id = $1', [req.params.id]);

    await query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.id]);
    for (const permissionId of permissionIds) {
      await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)', [req.params.id, permissionId]);
    }

    await req.audit({
      action: 'role.update_permissions',
      entityType: 'roles',
      entityId: req.params.id,
      oldValue: { permissionIds: oldRes.rows.map((r) => r.permission_id) },
      newValue: { permissionIds },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/misc/settings
router.get('/settings', requirePermission('settings.view'), async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM system_settings ORDER BY key');
    res.json({ settings: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/misc/settings/:key
router.put('/settings/:key', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const { value } = req.body;
    const oldRes = await query('SELECT value FROM system_settings WHERE key = $1', [req.params.key]);

    const result = await query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()
       RETURNING *`,
      [req.params.key, JSON.stringify(value), req.employee.id]
    );

    await req.audit({
      action: 'settings.update',
      entityType: 'system_settings',
      entityId: req.params.key,
      oldValue: oldRes.rows[0] || null,
      newValue: result.rows[0],
    });

    res.json({ setting: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/misc/sessions?employeeId= — عرض الجلسات النشطة (للإدارة)
router.get('/sessions', requirePermission('sessions.manage'), async (req, res, next) => {
  try {
    const { employeeId } = req.query;
    const params = [];
    let where = "WHERE revoked_at IS NULL AND expires_at > now()";
    if (employeeId) {
      params.push(employeeId);
      where += ` AND employee_id = $${params.length}`;
    }
    const result = await query(`SELECT id, employee_id, ip_address, user_agent, created_at, expires_at FROM sessions ${where} ORDER BY created_at DESC`, params);
    res.json({ sessions: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/misc/sessions/:id/revoke — إنهاء جلسة موظف من الإدارة
router.post('/sessions/:id/revoke', requirePermission('sessions.manage'), async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, employee_id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الجلسة غير موجودة أو منتهية مسبقاً' });

    await req.audit({
      action: 'session.revoke',
      entityType: 'sessions',
      entityId: req.params.id,
      newValue: { revokedEmployeeId: result.rows[0].employee_id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
