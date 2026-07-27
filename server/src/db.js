// db.js — إدارة الاتصال بقاعدة PostgreSQL عبر حوض اتصالات (pool)
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error('DATABASE_URL غير معرّف في متغيرات البيئة (.env)');
}

const useSSL = process.env.PGSSL === 'true' || /neon\.tech|render\.com|railway\.app/.test(connectionString);

const pool = new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.error('خطأ غير متوقع في حوض اتصالات PostgreSQL:', err);
});

/**
 * تنفيذ استعلام مباشر (بدون معاملة)
  */
async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV !== 'production') {
          const duration = Date.now() - start;
          if (duration > 200) {
                  console.warn(`[db] استعلام بطيء (${duration}ms): ${text.slice(0, 120)}`);
          }
    }
    return res;
}

/**
 * تنفيذ معاملة (transaction) آمنة: ترجع (rollback) تلقائياً عند الخطأ
  * callback(client) => Promise
   */
async function withTransaction(callback) {
    const client = await pool.connect();
    try {
          await client.query('BEGIN');
          const result = await callback(client);
          await client.query('COMMIT');
          return result;
    } catch (err) {
          await client.query('ROLLBACK');
          throw err;
    } finally {
          client.release();
    }
}

module.exports = { pool, query, withTransaction };
