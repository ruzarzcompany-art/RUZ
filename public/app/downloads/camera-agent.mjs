#!/usr/bin/env node
/**
 * جهاز ربط الكاميرات — يعمل على أي كمبيوتر داخل شبكة المطعم (Windows/Mac/Linux)
 * ويحتاج Node.js 18 أو أحدث فقط، بلا أي مكتبات إضافية.
 *
 * كل دورة: يسأل البرنامج عن الكاميرات المستحقة، يأخذ لقطة من كل كاميرا عبر
 * الشبكة المحلية (يدعم Basic و Digest كما في Hikvision و Dahua)، ويرسلها
 * للبرنامج ليحلّلها بالذكاء الاصطناعي ويُصدر التنبيهات. إن لم تستجب الكاميرا
 * يُبلغ البرنامج بذلك فيُنبّه بأنها متوقفة.
 *
 * الإعداد: انسخ config.example.json إلى config.json وعدّل القيم، ثم شغّل:
 *   node camera-agent.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "config.json");
const fileConfig = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const config = {
  serverUrl: (process.env.SERVER_URL ?? fileConfig.serverUrl ?? "").replace(/\/$/, ""),
  agentKey: process.env.AGENT_KEY ?? fileConfig.agentKey ?? "",
  branchCode: process.env.BRANCH_CODE ?? fileConfig.branchCode ?? "",
  pollSeconds: Number(process.env.POLL_SECONDS ?? fileConfig.pollSeconds ?? 30),
};
if (!config.serverUrl || !config.agentKey) {
  console.error("اضبط serverUrl و agentKey في config.json");
  process.exit(1);
}

const log = (...args) => console.log(new Date().toLocaleString("ar-SA"), ...args);
const md5 = (text) => createHash("md5").update(text).digest("hex");

function digest(url, username, password, header) {
  const p = {};
  for (const m of header.replace(/^Digest\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    p[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  const uri = url.pathname + url.search;
  const qop = (p.qop ?? "").split(",").map((q) => q.trim()).includes("auth") ? "auth" : "";
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = md5(`${username}:${p.realm ?? ""}:${password}`);
  const ha2 = md5(`GET:${uri}`);
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  const parts = [`username="${username}"`, `realm="${p.realm ?? ""}"`, `nonce="${p.nonce}"`, `uri="${uri}"`, `response="${response}"`, 'algorithm="MD5"'];
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(", ")}`;
}

async function snapshot(job) {
  const url = new URL(job.snapshotUrl);
  const get = (headers) =>
    fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).catch((error) => {
      const code = error?.cause?.code ?? error?.name ?? "";
      throw new Error(`لا يمكن الوصول للكاميرا ${url.host} (${code || "خطأ شبكة"}) — تحقق من العنوان والشبكة والكهرباء`);
    });
  const basic = job.username ? { Authorization: `Basic ${Buffer.from(`${job.username}:${job.password}`).toString("base64")}` } : {};
  let res = await get(basic);
  const challenge = res.headers.get("www-authenticate") ?? "";
  if (res.status === 401 && job.username && /^Digest/i.test(challenge)) {
    res = await get({ Authorization: digest(url, job.username, job.password, challenge) });
  }
  if (!res.ok) throw new Error(`الكاميرا ردّت بالرمز ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  if (!contentType.startsWith("image/")) throw new Error("الرابط لا يُرجع صورة");
  return { contentType, data: Buffer.from(await res.arrayBuffer()) };
}

async function api(path, options = {}) {
  const res = await fetch(`${config.serverUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Surveillance-Key": config.agentKey, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function handle(job) {
  const capturedAt = new Date().toISOString();
  let payload;
  try {
    const image = await snapshot(job);
    payload = { cameraId: job.cameraId, capturedAt, contentType: image.contentType, imageBase64: image.data.toString("base64") };
  } catch (error) {
    payload = { cameraId: job.cameraId, capturedAt, error: error.message };
    log(`⚠ ${job.cameraNumber}: ${error.message}`);
  }
  const { result } = await api("/surveillance/snapshots", { method: "POST", body: JSON.stringify(payload) });
  const alerts = result?.alerts?.length ?? 0;
  log(`${job.cameraNumber}: ${result?.cameraState ?? "?"}${alerts ? ` — ${alerts} تنبيه جديد` : ""}`);
}

async function cycle() {
  const query = config.branchCode ? `?branchCode=${encodeURIComponent(config.branchCode)}` : "";
  const { jobs } = await api(`/surveillance/agent/jobs${query}`);
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const job = queue.shift();
        await handle(job).catch((error) => log(`✖ ${job.cameraNumber}: ${error.message}`));
      }
    }),
  );
}

log(`جهاز الربط يعمل — ${config.serverUrl}`);
for (;;) {
  await cycle().catch((error) => log(`✖ تعذّر الاتصال بالبرنامج: ${error.message}`));
  await new Promise((resolve) => setTimeout(resolve, Math.max(10, config.pollSeconds) * 1000));
}
