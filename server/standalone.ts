import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createApp } from "./app.js";

/**
 * تشغيل الخادم كخدمة Node.js/Express مستقلة (للتطوير المحلي أو أي استضافة
 * أخرى). على Netlify يعمل نفس التطبيق داخل دالة `netlify/functions/api.mts`.
 *
 * الاتصال بقاعدة البيانات يُقرأ من DATABASE_URL أو NETLIFY_DATABASE_URL.
 */
const app = createApp();

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

app.use(express.static(publicDir, { extensions: ["html"] }));

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

app.listen(port, () => {
  console.log(`[restaurant-hr] الخادم يعمل على http://localhost:${port}`);
});
