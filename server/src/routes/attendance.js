// routes/attendance.js — تسجيل الحضور والانصراف بالموقع الجغرافي ومطابقة الوجه
// وقت الحضور دائماً من توقيت الخادم (now()) ولا يعتمد على وقت جهاز الموظف إطلاقاً
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { isWithinGeofence } = require('../utils/geo');
const { matchFaceTemplate } = require('../utils/faceCrypto');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_RADIUS = parseInt(process.env.DEFAULT_GEOFENCE_RADIUS_METERS || '150', 10);
const DEFAULT_FACE_THRESHOLD = 0.6;

async function getFaceThreshold() {
  const res = await query("SELECT value FROM system_settings WHERE key = 'face_match_threshold'");
  if (res.rows[0]) return Number(res.rows[0].value);
  return DEFAULT_FACE_THRESHOLD;
}

// POST /api/attendance/check-in
router.post('/check-in', async (req, res, next) => {
  try {
    const { branchId, latitude, longitude, faceTemplate } = req.body;
    if (!branchId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'الفرع والموقع الجغرافي مطلوبة' });
    }

    const branchRes = await query('SELECT * FROM branches WHERE id = $1 AND deleted_at IS NULL', [branchId]);
    const branch = branchRes.rows[0];
    if (!branch) return res.status(404).json({ error: 'الفرع غير موجود' });

    const geoCheck = isWithinGeofence(branch, Number(latitude), Number(longitude), DEFAULT_RADIUS);
    if (!geoCheck.withinFence) {
      return res.status(403).json({ error: 'أنت خارج نطاق موقع الفرع المسموح به', ...geoCheck });
    }

    const empRes = await query('SELECT face_template_enc FROM employees WHERE id = $1', [req.employee.id]);
    const storedTemplate = empRes.rows[0] ? empRes.rows[0].face_template_enc : null;

    let faceResult = null;
    if (storedTemplate) {
      if (!Array.isArray(faceTemplate)) {
        return res.status(400).json({ error: 'قالب الوجه مطلوب لمطابقة الهوية' });
      }
      const threshold = await getFaceThreshold();
      faceResult = matchFaceTemplate(faceTemplate, storedTemplate, threshold);
      if (!faceResult.isMatch) {
        return res.status(403).json({ error: 'تعذّرت مطابقة الوجه', distance: faceResult.distance });
      }
    }

    const openRes = await query(
      "SELECT id FROM attendance WHERE employee_id = $1 AND status = 'open'",
      [req.employee.id]
    );
    if (openRes.rows[0]) {
      return res.status(409).json({ error: 'يوجد تسجيل حضور مفتوح بالفعل، الرجاء تسجيل الانصراف أولاً' });
    }

    const inserted = await query(
      `INSERT INTO attendance
        (employee_id, branch_id, check_in_at, check_in_lat, check_in_lon, check_in_distance_meters, check_in_method, status)
       VALUES ($1,$2, now(), $3,$4,$5,$6,'open')
       RETURNING *`,
      [req.employee.id, branchId, latitude, longitude, geoCheck.distanceMeters, storedTemplate ? 'face' : 'manual']
    );

    res.status(201).json({ attendance: inserted.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/check-out
router.post('/check-out', async (req, res, next) => {
  try {
    const { latitude, longitude, faceTemplate } = req.body;

    const openRes = await query(
      "SELECT a.*, b.* , a.id AS attendance_id FROM attendance a JOIN branches b ON b.id = a.branch_id WHERE a.employee_id = $1 AND a.status = 'open' ORDER BY a.id DESC LIMIT 1",
      [req.employee.id]
    );
    const open = openRes.rows[0];
    if (!open) return res.status(404).json({ error: 'لا يوجد تسجيل حضور مفتوح لتسجيل الانصراف' });

    const geoCheck = isWithinGeofence(open, Number(latitude), Number(longitude), DEFAULT_RADIUS);

    const empRes = await query('SELECT face_template_enc FROM employees WHERE id = $1', [req.employee.id]);
    const storedTemplate = empRes.rows[0] ? empRes.rows[0].face_template_enc : null;
    if (storedTemplate && Array.isArray(faceTemplate)) {
      const threshold = await getFaceThreshold();
      const faceResult = matchFaceTemplate(faceTemplate, storedTemplate, threshold);
      if (!faceResult.isMatch) {
        return res.status(403).json({ error: 'تعذّرت مطابقة الوجه عند الانصراف', distance: faceResult.distance });
      }
    }

    const updated = await query(
      `UPDATE attendance SET
         check_out_at = now(),
         check_out_lat = $1,
         check_out_lon = $2,
         check_out_distance_meters = $3,
         check_out_method = $4,
         status = 'closed'
       WHERE id = $5 RETURNING *`,
      [latitude, longitude, geoCheck.distanceMeters, storedTemplate ? 'face' : 'manual', open.attendance_id]
    );

    res.json({ attendance: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance — تقارير الحضور (بحسب صلاحية العرض)
router.get('/', requirePermission('attendance.view'), async (req, res, next) => {
  try {
    const { employeeId, branchId, fromDate, toDate } = req.query;
    const conditions = [];
    const params = [];

    if (employeeId) {
      params.push(employeeId);
      conditions.push(`employee_id = $${params.length}`);
    }
    if (branchId) {
      params.push(branchId);
      conditions.push(`branch_id = $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`check_in_at >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`check_in_at <= $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`SELECT * FROM attendance ${where} ORDER BY id DESC LIMIT 500`, params);
    res.json({ attendance: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/:id/correct — تصحيح يدوي من الإدارة (يُسجَّل في audit_logs)
router.post('/:id/correct', requirePermission('attendance.correct'), async (req, res, next) => {
  try {
    const existingRes = await query('SELECT * FROM attendance WHERE id = $1', [req.params.id]);
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'سجل الحضور غير موجود' });

    const { checkInAt, checkOutAt, notes } = req.body;
    const updated = await query(
      `UPDATE attendance SET
         check_in_at = COALESCE($1, check_in_at),
         check_out_at = COALESCE($2, check_out_at),
         notes = COALESCE($3, notes)
       WHERE id = $4 RETURNING *`,
      [checkInAt || null, checkOutAt || null, notes || null, req.params.id]
    );

    await req.audit({
      action: 'attendance.manual_correction',
      entityType: 'attendance',
      entityId: req.params.id,
      oldValue: existing,
      newValue: updated.rows[0],
    });

    res.json({ attendance: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
