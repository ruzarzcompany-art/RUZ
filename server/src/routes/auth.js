// routes/auth.js — تسجيل الدخول / تجديد الجلسة / الخروج / تغيير كلمة المرور
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { recordAudit } = require('../middleware/audit');

const router = express.Router();

const MAX_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10);
const LOCKOUT_MINUTES = parseInt(process.env.LOCKOUT_MINUTES || '15', 10);
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseDurationToMs(value, fallbackMs) {
  const match = /^(\d+)([smhd])$/.exec(String(value || '').trim());
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  const unit = match[2];
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * unitMs;
}

async function issueSession(employee, req) {
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const refreshMs = parseDurationToMs(process.env.JWT_REFRESH_EXPIRES_IN, 30 * 86400000);
  const expiresAt = new Date(Date.now() + refreshMs);

  const sessionRes = await query(
    `INSERT INTO sessions (employee_id, refresh_token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [employee.id, refreshTokenHash, req.ip, req.headers['user-agent'] || null, expiresAt]
  );
  const sessionId = sessionRes.rows[0].id;

  const accessToken = jwt.sign(
    { sub: employee.id, sid: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  return { accessToken, refreshToken, sessionId };
}

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const empRes = await query(
      `SELECT e.*, r.name AS role_name FROM employees e
       JOIN roles r ON r.id = e.role_id
       WHERE e.username = $1 AND e.deleted_at IS NULL`,
      [username]
    );
    const employee = empRes.rows[0];

    if (!employee) {
      await query('INSERT INTO login_attempts (username, success, ip_address) VALUES ($1, false, $2)', [username, req.ip]);
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    if (employee.locked_until && new Date(employee.locked_until) > new Date()) {
      return res.status(423).json({ error: 'الحساب مقفل مؤقتاً بسبب محاولات فاشلة متكررة، حاول لاحقاً' });
    }

    const passwordOk = await bcrypt.compare(password, employee.password_hash);

    if (!passwordOk) {
      const attempts = employee.failed_login_attempts + 1;
      const shouldLock = attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE employees SET failed_login_attempts = $1,
           locked_until = $2 WHERE id = $3`,
        [
          shouldLock ? 0 : attempts,
          shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null,
          employee.id,
        ]
      );
      await query('INSERT INTO login_attempts (username, employee_id, success, ip_address) VALUES ($1, $2, false, $3)', [
        username,
        employee.id,
        req.ip,
      ]);
      if (shouldLock) {
        return res.status(423).json({ error: `تم قفل الحساب لمدة ${LOCKOUT_MINUTES} دقيقة بسبب محاولات فاشلة متكررة` });
      }
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    if (!employee.is_active) {
      return res.status(403).json({ error: 'الحساب غير مفعّل' });
    }

    await query('UPDATE employees SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [employee.id]);
    await query('INSERT INTO login_attempts (username, employee_id, success, ip_address) VALUES ($1, $2, true, $3)', [
      username,
      employee.id,
      req.ip,
    ]);

    const { accessToken, refreshToken } = await issueSession(employee, req);

    res.json({
      accessToken,
      refreshToken,
      employee: {
        id: employee.id,
        fullName: employee.full_name,
        username: employee.username,
        roleName: employee.role_name,
        mustChangePassword: employee.must_change_password,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken مطلوب' });
    }
    const tokenHash = hashRefreshToken(refreshToken);

    const sessionRes = await query(
      `SELECT s.*, e.is_active, e.deleted_at FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash]
    );
    const session = sessionRes.rows[0];
    if (!session || !session.is_active || session.deleted_at) {
      return res.status(401).json({ error: 'الجلسة غير صالحة، الرجاء تسجيل الدخول مجدداً' });
    }

    const accessToken = jwt.sign(
      { sub: session.employee_id, sid: session.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.employee.sessionId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل' });
    }

    const empRes = await query('SELECT * FROM employees WHERE id = $1', [req.employee.id]);
    const employee = empRes.rows[0];

    if (!employee.must_change_password) {
      const ok = await bcrypt.compare(currentPassword || '', employee.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
      }
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(
      'UPDATE employees SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
      [newHash, req.employee.id]
    );

    await recordAudit({
      actorEmployeeId: req.employee.id,
      action: 'auth.change_password',
      entityType: 'employees',
      entityId: req.employee.id,
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ employee: req.employee });
});

module.exports = router;
