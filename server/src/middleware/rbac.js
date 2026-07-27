// rbac.js — Middleware للتحقق من الصلاحيات (RBAC) وحصر مدير الفرع بفرعه
// الصلاحيات تُقرأ من قاعدة البيانات (جدولا roles/permissions) وليست ثابتة في الكود

/**
 * requirePermission('employees.create') — يتأكد أن دور الموظف يملك الصلاحية المطلوبة
 */
function requirePermission(permissionCode) {
  return (req, res, next) => {
    if (!req.employee) {
      return res.status(401).json({ error: 'غير مصرّح' });
    }
    if (!req.employee.permissions.includes(permissionCode)) {
      return res.status(403).json({ error: `لا تملك صلاحية: ${permissionCode}` });
    }
    next();
  };
}

/**
 * requireSameBranch(paramName) — يحصر مدير الفرع بفرعه فقط
 * إذا كان لدى الموظف صلاحية 'branches.all' يتم تجاوز القيد (مثل مدير عام/موارد بشرية)
 */
function requireSameBranch(paramName = 'branchId') {
  return (req, res, next) => {
    if (!req.employee) {
      return res.status(401).json({ error: 'غير مصرّح' });
    }
    if (req.employee.permissions.includes('branches.all')) {
      return next();
    }
    const requestedBranchId = Number(req.params[paramName] || req.body[paramName] || req.query[paramName]);
    const allowedBranches = new Set([req.employee.primaryBranchId, ...req.employee.branchIds]);

    if (!requestedBranchId || !allowedBranches.has(requestedBranchId)) {
      return res.status(403).json({ error: 'هذا الإجراء مقتصر على فرعك فقط' });
    }
    next();
  };
}

module.exports = { requirePermission, requireSameBranch };
