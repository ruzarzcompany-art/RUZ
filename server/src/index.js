// index.js — نقطة تشغيل الخادم: يشغّل الترحيلات والبذر تلقائياً ثم يبدأ Express
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { runMigrations } = require('./migrate');
const { runSeed } = require('../seeds/seed');
const authRoutes = require('./routes/auth');
const employeesRoutes = require('./routes/employees');
const branchesRoutes = require('./routes/branches');
const attendanceRoutes = require('./routes/attendance');
const shiftsRoutes = require('./routes/shifts');
const miscRoutes = require('./routes/misc');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات دخول كثيرة جداً، الرجاء المحاولة لاحقاً' },
});
app.use('/api/auth/login', authLimiter);

// ===================== المسارات (Routes) =====================
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/branches', branchesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/misc', miscRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ===================== الواجهات الثابتة =====================
app.use('/admin', express.static(path.join(__dirname, '..', '..', 'admin')));
app.use('/app', express.static(path.join(__dirname, '..', '..', 'app')));

app.get('/', (req, res) => {
  res.redirect('/admin/');
});

// ===================== معالجة الأخطاء =====================
app.use((req, res) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('خطأ غير متوقع:', err);
  res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم' });
});

async function start() {
  try {
    console.log('▶ تشغيل الترحيلات (migrations) تلقائياً...');
    await runMigrations();
    console.log('▶ تشغيل البذر (seed) — آمن لإعادة التشغيل...');
    await runSeed();
  } catch (err) {
    console.error('فشل تشغيل الترحيلات أو البذر عند الإقلاع:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`✔ الخادم يعمل على المنفذ ${PORT}`);
    console.log(`  لوحة الإدارة:  http://localhost:${PORT}/admin/`);
    console.log(`  تطبيق الموظف: http://localhost:${PORT}/app/`);
  });
}

start();

module.exports = app;
