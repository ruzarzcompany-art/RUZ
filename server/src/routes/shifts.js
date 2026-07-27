// routes/shifts.js — إدارة الورديات وتعيين الموظفين لها
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// GET /api/shifts?branchId=
router.get('/', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const params = [];
    let where = '';
    if (branchId) {
      params.push(branchId);
      where = 'WHERE branch_id = $1';
    }
    const result = await query(`SELECT * FROM shifts ${where} ORDER BY id`, params);
    res.json({ shifts: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/shifts
router.post('/', requirePermission('shifts.create'), async (req, res, next) => {
  try {
    const { branchId, name, startTime, endTime, daysOfWeek } = req.body;
    if (!branchId || !name || !startTime || !endTime) {
      return res.status(400).json({ error: 'الفرع والاسم ووقت البداية والنهاية حقول مطلوبة' });
    }
    const result = await query(
      `INSERT INTO shifts (branch_id, name, start_time, end_time, days_of_week)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [branchId, name, startTime, endTime, daysOfWeek || [0, 1, 2, 3, 4, 5, 6]]
    );
    await req.audit({ action: 'shift.create', entityType: 'shifts', entityId: result.rows[0].id, newValue: result.rows[0] });
    res.status(201).json({ shift: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/shifts/:id/assign — تعيين موظف لوردية في تاريخ محدد
router.post('/:id/assign', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const { employeeId, branchId, workDate } = req.body;
    if (!employeeId || !branchId || !workDate) {
      return res.status(400).json({ error: 'الموظف والفرع والتاريخ حقول مطلوبة' });
    }
    const result = await query(
      `INSERT INTO shift_assignments (employee_id, shift_id, branch_id, work_date)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, shift_id, work_date) DO NOTHING
       RETURNING *`,
      [employeeId, req.params.id, branchId, workDate]
    );
    if (!result.rows[0]) {
      return res.status(409).json({ error: 'الموظف معيّن مسبقاً لهذه الوردية في هذا التاريخ' });
    }
    await req.audit({ action: 'shift.assign', entityType: 'shift_assignments', entityId: result.rows[0].id, newValue: result.rows[0] });
    res.status(201).json({ assignment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/shifts/assignments?employeeId=&fromDate=&toDate=
router.get('/assignments/list', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const { employeeId, fromDate, toDate } = req.query;
    const conditions = [];
    const params = [];
    if (employeeId) {
      params.push(employeeId);
      conditions.push(`employee_id = $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`work_date >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`work_date <= $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`SELECT * FROM shift_assignments ${where} ORDER BY work_date DESC`, params);
    res.json({ assignments: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
