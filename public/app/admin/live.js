/**
 * المراقبة المباشرة — كل الكاميرات بالترتيب، وعلى كل واحدة مناطقها ملوّنة بحالتها الآن
 * مع عدّاد الوقت، وفوقها قائمة الأخطاء المفتوحة. تتحدّث تلقائياً ما دامت الشاشة مفتوحة.
 */
import { api } from "../api.js";

const POLL_MS = 4000;
const W = 960;
const H = 540;

const COLORS = {
  none: "#8f8a7a",
  empty: "#8f8a7a",
  served: "#5fae6a",
  waiting: "#e0a030",
  vacated: "#e08a30",
  ok: "#6fa8dc",
  alert: "#e5483a",
};
const KIND_NAMES = { table: "طاولة", queue: "الطابور", door: "الباب", restricted: "منطقة محظورة" };

const state = {
  branchId: null,
  timer: null,
  ticker: null,
  data: null,
  fetchedAt: 0,
  images: new Map(), // cameraId → { stamp, image }
  wide: null,
  busy: false,
};

const el = (id) => document.getElementById(id);

function chip(text, cls) {
  const node = document.createElement("span");
  node.className = `badge ${cls}`;
  node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function ago(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? "الآن" : minutes < 60 ? `قبل ${minutes} د` : `قبل ${Math.floor(minutes / 60)} س`;
}

/** وصف حالة المنطقة ولونها؛ الثواني تتقدّم محلياً بين كل تحديثين. */
function describe(zone, elapsed) {
  const live = zone.live;
  const name = /^\d+$/.test(zone.label) && zone.kind === "table" ? `طاولة ${zone.label}` : zone.label || KIND_NAMES[zone.kind] || "";
  if (!live) return { color: COLORS.none, text: name, dashed: true, alert: false };
  const seconds = (live.seconds ?? 0) + (live.state === "empty" || live.state === "ok" ? 0 : elapsed);
  if (zone.kind === "table") {
    if (live.state === "waiting") {
      return { color: live.alert ? COLORS.alert : COLORS.waiting, text: `${name} · ينتظر موظف ${clock(seconds)}`, alert: live.alert };
    }
    if (live.state === "served") return { color: COLORS.served, text: `${name} · مخدومة ${clock(seconds)}`, alert: false };
    if (live.state === "vacated") {
      return { color: live.alert ? COLORS.alert : COLORS.vacated, text: `${name} · تحتاج تنظيف ${clock(seconds)}`, alert: live.alert };
    }
    return { color: COLORS.empty, text: `${name} · فارغة`, alert: false };
  }
  if (zone.kind === "door") return { color: COLORS.ok, text: `${name} · دخل ${live.entries ?? 0} / خرج ${live.exits ?? 0}`, alert: false };
  if (zone.kind === "queue") {
    return { color: live.alert ? COLORS.alert : COLORS.ok, text: `${name} · ${live.people ?? 0} أشخاص`, alert: Boolean(live.alert) };
  }
  return {
    color: live.alert ? COLORS.alert : COLORS.none,
    text: live.alert ? `${name} · شخص داخل المنطقة!` : name,
    alert: Boolean(live.alert),
  };
}

function draw(camera, canvas, elapsed) {
  const ctx = canvas.getContext("2d");
  const cached = state.images.get(camera.id);
  if (cached?.image) ctx.drawImage(cached.image, 0, 0, W, H);
  else {
    ctx.fillStyle = "#16150f";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#a99f88";
    ctx.font = "24px 'IBM Plex Sans Arabic', sans-serif";
    ctx.textAlign = "center";
    ctx.direction = "rtl";
    ctx.fillText("لا توجد صورة من هذه الكاميرا بعد", W / 2, H / 2);
  }
  const blink = Math.floor(Date.now() / 600) % 2 === 0;
  for (const zone of camera.zones) {
    const info = describe(zone, elapsed);
    ctx.beginPath();
    zone.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    if (zone.kind !== "door") ctx.closePath();
    ctx.lineWidth = info.alert ? 6 : 3;
    ctx.setLineDash(info.dashed ? [10, 8] : []);
    ctx.strokeStyle = info.color;
    if (zone.kind !== "door") {
      ctx.fillStyle = `${info.color}${info.alert && blink ? "88" : "40"}`;
      ctx.fill();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const cx = (zone.points.reduce((sum, p) => sum + p[0], 0) / zone.points.length) * W;
    const cy = (zone.points.reduce((sum, p) => sum + p[1], 0) / zone.points.length) * H;
    ctx.font = "bold 30px 'IBM Plex Sans Arabic', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.direction = "rtl";
    const width = ctx.measureText(info.text).width + 24;
    ctx.fillStyle = info.alert ? COLORS.alert : "#12120cdd";
    ctx.fillRect(cx - width / 2, cy - 22, width, 44);
    ctx.fillStyle = "#fff8e8";
    ctx.fillText(info.text, cx, cy);
  }
}

async function loadImage(camera) {
  const stamp = camera.lastFrameAt ?? "";
  const cached = state.images.get(camera.id);
  if (!stamp || cached?.stamp === stamp || cached?.loading) return;
  state.images.set(camera.id, { ...cached, loading: true });
  const res = await api(`/surveillance/cameras/${camera.id}/latest`);
  if (!res.ok || !res.image) {
    state.images.set(camera.id, { ...cached, loading: false });
    return;
  }
  const image = new Image();
  await new Promise((resolve) => {
    image.onload = resolve;
    image.onerror = resolve;
    image.src = res.image;
  });
  state.images.set(camera.id, { stamp, image: image.naturalWidth ? image : cached?.image, loading: false });
}

function renderStatus() {
  const data = state.data;
  const zones = data.cameras.flatMap((camera) => camera.zones);
  const tables = zones.filter((zone) => zone.kind === "table");
  const count = (name) => tables.filter((zone) => zone.live?.state === name).length;
  const busy = count("waiting") + count("served");
  const queue = zones.filter((zone) => zone.kind === "queue").reduce((sum, zone) => sum + (zone.live?.people ?? 0), 0);
  const box = el("lv-status");
  box.replaceChildren(
    data.online
      ? data.fresh
        ? chip("جهاز التحليل يعمل الآن", "badge--ok")
        : chip("جهاز التحليل متصل — بانتظار التحديث", "badge--warn")
      : chip("جهاز التحليل غير متصل — الصور قديمة", "badge--disputed"),
  );
  if (tables.length === 0) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn btn--primary btn--xs";
    go.textContent = "ارسم الطاولات الآن ←";
    go.onclick = () => {
      document.querySelector('[data-sv="cameras"]')?.click();
      setTimeout(() => document.querySelector('[data-sv-section="ct-zones"]')?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    };
    box.append(chip("لم تُرسم الطاولات بعد", "badge--warn"), go);
    return;
  }
  box.append(
    chip(`الطاولات المشغولة: ${busy} من ${tables.length}`, "badge--reviewed"),
    chip(`تنتظر موظف: ${count("waiting")}`, count("waiting") ? "badge--warn" : "badge--ok"),
    chip(`تحتاج تنظيف: ${count("vacated")}`, count("vacated") ? "badge--warn" : "badge--ok"),
  );
  if (zones.some((zone) => zone.kind === "queue")) box.append(chip(`في الطابور: ${queue}`, "badge--reviewed"));
}

function renderAlerts() {
  const box = el("lv-alerts");
  const live = state.data.cameras.flatMap((camera) =>
    camera.zones
      .map((zone) => ({ zone, camera, info: describe(zone, 0) }))
      .filter((item) => item.info.alert),
  );
  box.replaceChildren();
  if (live.length === 0 && state.data.alerts.length === 0) {
    const ok = document.createElement("p");
    ok.className = "live-ok";
    ok.textContent = "✓ لا أخطاء الآن";
    box.append(ok);
    return;
  }
  for (const item of live) {
    const row = document.createElement("div");
    row.className = "live-alert live-alert--now";
    row.textContent = `● ${item.info.text} — كاميرا ${item.camera.cameraNumber}`;
    box.append(row);
  }
  for (const alert of state.data.alerts) {
    const row = document.createElement("div");
    row.className = `live-alert${alert.urgent ? " live-alert--now" : ""}`;
    row.textContent = `${alert.label}${alert.location ? ` — ${alert.location}` : ""} · ${ago(alert.occurredAt)}`;
    box.append(row);
  }
}

function renderGrid() {
  const grid = el("lv-grid");
  const known = new Set([...grid.querySelectorAll("figure")].map((node) => Number(node.dataset.camera)));
  const wanted = state.data.cameras.map((camera) => camera.id);
  if (known.size !== wanted.length || wanted.some((id) => !known.has(id))) {
    grid.replaceChildren();
    for (const camera of state.data.cameras) {
      const figure = document.createElement("figure");
      figure.className = "live-cam";
      figure.dataset.camera = String(camera.id);
      const caption = document.createElement("figcaption");
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      figure.append(caption, canvas);
      figure.addEventListener("click", () => {
        state.wide = state.wide === camera.id ? null : camera.id;
        for (const node of grid.querySelectorAll("figure")) node.classList.toggle("is-wide", Number(node.dataset.camera) === state.wide);
      });
      grid.append(figure);
    }
  }
  paint();
}

function paint() {
  if (!state.data) return;
  const elapsed = (Date.now() - state.fetchedAt) / 1000;
  for (const camera of state.data.cameras) {
    const figure = el("lv-grid").querySelector(`figure[data-camera="${camera.id}"]`);
    if (!figure) continue;
    const alerting = camera.zones.some((zone) => describe(zone, 0).alert);
    figure.classList.toggle("is-alert", alerting);
    figure.querySelector("figcaption").textContent = `${camera.cameraNumber} · ${camera.name}`;
    draw(camera, figure.querySelector("canvas"), elapsed);
  }
}

async function poll() {
  const section = el("lv-grid")?.closest("[data-sv-section]");
  if (!section || section.hidden || section.offsetParent === null) {
    stopLive();
    return;
  }
  if (state.busy || document.hidden) return;
  state.busy = true;
  try {
    const res = await api(`/control/live?branchId=${state.branchId}`);
    if (!res.ok) {
      el("lv-status").replaceChildren(chip(res.error ?? "تعذّر التحميل", "badge--disputed"));
      return;
    }
    state.data = res;
    state.fetchedAt = Date.now();
    renderStatus();
    renderAlerts();
    renderGrid();
    await Promise.all(res.cameras.map((camera) => loadImage(camera)));
    paint();
  } finally {
    state.busy = false;
  }
}

export function stopLive() {
  clearInterval(state.timer);
  clearInterval(state.ticker);
  state.timer = null;
  state.ticker = null;
}

export async function refreshLiveTab(branchId) {
  if (state.branchId !== branchId) {
    state.images.clear();
    state.data = null;
    el("lv-grid").replaceChildren();
  }
  state.branchId = branchId;
  stopLive();
  state.timer = setInterval(poll, POLL_MS);
  state.ticker = setInterval(paint, 1000);
  await poll();
}
