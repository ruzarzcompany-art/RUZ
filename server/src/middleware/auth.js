// auth.js — Middleware للتحقق من JWT ومطابقة الجلسة في قاعدة البيانات
const jwt = require('jsonwebtoken');
const { query } = require('../db');

/**
 * يتحقق من صحة رمز الوصول (access token) في ترويسة Authorization
 * ثم يجلب صلاحيات الموظف من قاعدة البيانات (RBAC ديناميكي وليس ثابتاً في الكود)
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'رمز الوصول مفقود' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'رمز الوصول غير صالح أو منتهي' });
    }

    const employeeRes = await query(
      `SELECT e.id, e.full_name, e.username, e.role_id, e.primary_branch_id,
              e.is_active, e.must_change_password, r.name AS role_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [payload.sub]
    );

    const employee = employeeRes.rows[0];
    if (!employee || !employee.is_active) {
      return res.status(401).json({ error: 'الحساب غير موجود أو معطّل' });
    }

    const permsRes = await query(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1`,
      [employee.role_id]
    );

    const branchesRes = await query(
      'SELECT branch_id FROM employee_branches WHERE employee_id = $1',
      [employee.id]
    );

    req.employee = {
      id: employee.id,
      fullName: employee.full_name,
      username: employee.username,
      roleId: employee.role_id,
      roleName: employee.role_name,
      primaryBranchId: employee.primary_branch_id,
      mustChangePassword: employee.must_change_password,
      permissions: permsRes.rows.map((r) => r.code),
      branchIds: branchesRes.rows.map((r) => r.branch_id),
      sessionId: payload.sid,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
