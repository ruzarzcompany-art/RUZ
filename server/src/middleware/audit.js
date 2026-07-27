// audit.js — تسجيل العمليات الحساسة في جدول audit_logs بالقيمة القديمة والجديدة
const { query } = require('../db');

/**
 * يسجل عملية حساسة واحدة في audit_logs
 * action مثل: 'employee.update' , 'attendance.manual_correction'
 */
async function recordAudit({ actorEmployeeId, action, entityType, entityId, oldValue, newValue, ipAddress }) {
  await query(
    `INSERT INTO audit_logs (actor_employee_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actorEmployeeId || null,
      action,
      entityType,
      entityId ? String(entityId) : null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ipAddress || null,
    ]
  );
}

/**
 * Middleware مساعد يضع دالة req.audit(...) جاهزة للاستخدام داخل أي route
 */
function auditMiddleware(req, res, next) {
  req.audit = (details) =>
    recordAudit({
      actorEmployeeId: req.employee ? req.employee.id : null,
      ipAddress: req.ip,
      ...details,
    });
  next();
}

module.exports = { recordAudit, auditMiddleware };
