// routes/branches.js — إدارة الفروع (CRUD) مع حذف منطقي
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// GET /api/branches
router.get('/', requirePermission('branches.view'), async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM branches WHERE deleted_at IS NULL ORDER BY id'
    );
    res.json({ branches: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/branches/:id
router.get('/:id', requirePermission('branches.view'), async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM branches WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'الفرع غير موجود' });
    res.json({ branch: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/branches
router.post('/', requirePermission('branches.create'), async (req, res, next) => {
  try {
    const { name, address, latitude, longitude, geofenceRadiusMeters, timezone } = req.body;
    if (!name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'الاسم وخط العرض وخط الطول حقول مطلوبة' });
    }

    const result = await query(
      `INSERT INTO branches (name, address, latitude, longitude, geofence_radius_meters, timezone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, address || null, latitude, longitude, geofenceRadiusMeters || 150, timezone || 'Asia/Riyadh']
    );

    await req.audit({ action: 'branch.create', entityType: 'branches', entityId: result.rows[0].id, newValue: result.rows[0] });
    res.status(201).json({ branch: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/branches/:id
router.put('/:id', requirePermission('branches.update'), async (req, res, next) => {
  try {
    const existingRes = await query('SELECT * FROM branches WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'الفرع غير موجود' });

    const { name, address, latitude, longitude, geofenceRadiusMeters, timezone, isActive } = req.body;
    const updated = await query(
      `UPDATE branches SET
        name = COALESCE($1, name),
        address = COALESCE($2, address),
        latitude = COALESCE($3, latitude),
        longitude = COALESCE($4, longitude),
        geofence_radius_meters = COALESCE($5, geofence_radius_meters),
        timezone = COALESCE($6, timezone),
        is_active = COALESCE($7, is_active),
        updated_at = now()
       WHERE id = $8 RETURNING *`,
      [name, address, latitude, longitude, geofenceRadiusMeters, timezone, isActive, req.params.id]
    );

    await req.audit({
      action: 'branch.update',
      entityType: 'branches',
      entityId: req.params.id,
      oldValue: existing,
      newValue: updated.rows[0],
    });

    res.json({ branch: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/branches/:id — حذف منطقي
router.delete('/:id', requirePermission('branches.delete'), async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE branches SET deleted_at = now(), is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الفرع غير موجود أو محذوف مسبقاً' });

    await req.audit({ action: 'branch.soft_delete', entityType: 'branches', entityId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
