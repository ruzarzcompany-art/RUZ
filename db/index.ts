import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema.js";

function createClient() {
  normalizeConnectionEnv();
  return drizzle({ schema });
}

type Db = ReturnType<typeof createClient>;

let cached: Db | undefined;

/**
 * يوحّد اسم متغيّر الاتصال. مُشغّل Netlify Database يقرأ `NETLIFY_DB_URL`،
 * لذا نمرّر إليه `DATABASE_URL` أو `NETLIFY_DATABASE_URL` عند توفّرهما
 * (مثل رابط Neon الحالي) حتى يعمل نفس الكود محلياً وعلى Netlify.
 */
function normalizeConnectionEnv(): void {
  if (process.env.NETLIFY_DB_URL) return;

  const fallback =
    process.env.DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;

  if (fallback) process.env.NETLIFY_DB_URL = fallback;
}

/**
 * عميل قاعدة البيانات (Drizzle على Netlify Database / Neon).
 * يُهيّأ عند أول استخدام فقط حتى لا يفشل الاستيراد وقت البناء.
 */
export function getDb(): Db {
  cached ??= createClient();
  return cached;
}

export { schema };
