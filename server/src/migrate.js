// migrate.js — مشغّل الترحيلات: يقرأ ملفات server/migrations بالترتيب الأبجدي وينفذها
// آمن لإعادة التشغيل: يسجل كل ملف منفذ في جدول schema_migrations ولا ينفذه مرتين

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client) {
  const res = await client.query('SELECT filename FROM schema_migrations');
  return new Set(res.rows.map((r) => r.filename));
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    if (!fs.existsSync(MIGRATIONS_DIR)) {
      console.log('لا يوجد مجلد migrations، تخطي.');
      return;
    }

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`⏭  تم تخطي (مطبّق مسبقاً): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`▶  تنفيذ: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✔  تم بنجاح: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✘ فشل تنفيذ ${file}:`, err.message);
        throw err;
      }
    }

    console.log('اكتملت جميع الترحيلات.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('فشل تشغيل الترحيلات:', err);
    process.exit(1);
  });
}

module.exports = { runMigrations };
