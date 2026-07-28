/**
 * منتقي الموقع على الخريطة — بلا أي مكتبة خارجية.
 *
 * يرسم بلاطات OpenStreetMap مباشرةً (raster tiles) داخل نافذة، فيسحب المستخدم
 * الخريطة أو يضغط على المكان المطلوب فتُقرأ الإحداثيات من مركز الخريطة. الهدف
 * أن يحدّد المسؤول موقع الفرع بإصبعه بدل كتابة خطّي الطول والعرض يدوياً.
 *
 * لا يُحمَّل أي سكربت طرف ثالث: البلاطات صور، والحساب كله Web Mercator محلي.
 */

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;
const TILE_URL = "https://tile.openstreetmap.org";

/** موقع افتراضي عند غياب أي إحداثيات (الرياض). */
const FALLBACK = { latitude: 24.7136, longitude: 46.6753, zoom: 12 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* ── تحويلات Web Mercator بين الإحداثيات وبكسلات العالم ─────────── */

const worldSize = (zoom) => TILE * 2 ** zoom;

function lngToWorldX(longitude, zoom) {
  return ((longitude + 180) / 360) * worldSize(zoom);
}

function latToWorldY(latitude, zoom) {
  const phi = (clamp(latitude, -85.05112878, 85.05112878) * Math.PI) / 180;
  const y = Math.log(Math.tan(phi) + 1 / Math.cos(phi));
  return (0.5 - y / (2 * Math.PI)) * worldSize(zoom);
}

function worldXToLng(x, zoom) {
  return (x / worldSize(zoom)) * 360 - 180;
}

function worldYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / worldSize(zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/* ── بناء النافذة ──────────────────────────────────────────────── */

function iconButton(label, title) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "btn btn--ghost btn--xs";
  node.textContent = label;
  node.title = title;
  return node;
}

/**
 * يفتح نافذة اختيار موقع ويعيد `{ latitude, longitude }` عند التأكيد،
 * أو `null` إذا أُلغيت.
 */
export function pickLocation(options = {}) {
  const start = {
    latitude: Number.isFinite(options.latitude) ? options.latitude : FALLBACK.latitude,
    longitude: Number.isFinite(options.longitude) ? options.longitude : FALLBACK.longitude,
  };
  const hasStart = Number.isFinite(options.latitude) && Number.isFinite(options.longitude);

  const view = {
    zoom: clamp(options.zoom ?? (hasStart ? 16 : FALLBACK.zoom), MIN_ZOOM, MAX_ZOOM),
    centerX: 0,
    centerY: 0,
  };
  view.centerX = lngToWorldX(start.longitude, view.zoom);
  view.centerY = latToWorldY(start.latitude, view.zoom);

  /* الهيكل */
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", options.title ?? "تحديد الموقع على الخريطة");

  const panel = document.createElement("div");
  panel.className = "modal__panel";

  const heading = document.createElement("h2");
  heading.className = "card__title card__title--sm";
  heading.textContent = options.title ?? "تحديد الموقع على الخريطة";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "اسحب الخريطة أو اضغط على المكان المطلوب حتى تستقرّ العلامة عليه، ثم اضغط «استخدام هذا الموقع».";

  const box = document.createElement("div");
  box.className = "mapbox";

  const tiles = document.createElement("div");
  tiles.className = "mapbox__tiles";

  const pin = document.createElement("span");
  pin.className = "mapbox__pin";
  pin.textContent = "📍";
  pin.setAttribute("aria-hidden", "true");

  const zoomBox = document.createElement("div");
  zoomBox.className = "mapbox__zoom";
  const zoomIn = iconButton("+", "تكبير");
  const zoomOut = iconButton("−", "تصغير");
  zoomBox.append(zoomIn, zoomOut);

  const credit = document.createElement("p");
  credit.className = "mapbox__attribution";
  credit.innerHTML =
    'بلاطات الخريطة من <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a>';

  box.append(tiles, pin, zoomBox, credit);

  const readout = document.createElement("p");
  readout.className = "hint";
  readout.setAttribute("role", "status");

  const actions = document.createElement("div");
  actions.className = "row row--wrap";

  const locateButton = document.createElement("button");
  locateButton.type = "button";
  locateButton.className = "btn btn--ghost btn--sm";
  locateButton.textContent = "موقعي الحالي";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "btn btn--primary btn--sm";
  confirmButton.textContent = "استخدام هذا الموقع";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn btn--ghost btn--sm";
  cancelButton.textContent = "إلغاء";

  actions.append(locateButton, confirmButton, cancelButton);
  panel.append(heading, hint, box, readout, actions);
  overlay.append(panel);

  /* ── الرسم ───────────────────────────────────────────────────── */

  /** يعيد استخدام عناصر الصور الموجودة حتى لا يرمش الرسم مع كل تحديث. */
  const pool = new Map();

  function draw() {
    const width = box.clientWidth || 320;
    const height = box.clientHeight || 320;
    const originX = view.centerX - width / 2;
    const originY = view.centerY - height / 2;
    const count = 2 ** view.zoom;
    const needed = new Set();

    const firstX = Math.floor(originX / TILE);
    const firstY = Math.floor(originY / TILE);
    const lastX = Math.floor((originX + width) / TILE);
    const lastY = Math.floor((originY + height) / TILE);

    for (let tileY = firstY; tileY <= lastY; tileY += 1) {
      if (tileY < 0 || tileY >= count) continue;

      for (let tileX = firstX; tileX <= lastX; tileX += 1) {
        // العالم يلتف أفقياً، فنُطابق رقم البلاطة داخل النطاق
        const wrappedX = ((tileX % count) + count) % count;
        const key = `${view.zoom}/${wrappedX}/${tileY}`;
        needed.add(key);

        let image = pool.get(key);
        if (!image) {
          image = document.createElement("img");
          image.className = "mapbox__tile";
          image.alt = "";
          image.loading = "eager";
          image.decoding = "async";
          image.src = `${TILE_URL}/${view.zoom}/${wrappedX}/${tileY}.png`;
          pool.set(key, image);
          tiles.append(image);
        }

        image.style.transform = `translate(${tileX * TILE - originX}px, ${tileY * TILE - originY}px)`;
      }
    }

    for (const [key, image] of pool) {
      if (needed.has(key)) continue;
      image.remove();
      pool.delete(key);
    }

    const latitude = round6(worldYToLat(view.centerY, view.zoom));
    const longitude = round6(worldXToLng(view.centerX, view.zoom));
    readout.textContent = `خط العرض: ${latitude} · خط الطول: ${longitude} · تكبير ${view.zoom}`;
    return { latitude, longitude };
  }

  function setZoom(next) {
    const target = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (target === view.zoom) return;

    const factor = 2 ** (target - view.zoom);
    view.centerX *= factor;
    view.centerY *= factor;
    view.zoom = target;

    // مقاسات البلاطات تغيّرت كلياً فنبدأ من رسم نظيف
    for (const [, image] of pool) image.remove();
    pool.clear();
    draw();
  }

  function moveTo(latitude, longitude, zoom) {
    if (zoom !== undefined) view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    view.centerX = lngToWorldX(longitude, view.zoom);
    view.centerY = latToWorldY(latitude, view.zoom);
    for (const [, image] of pool) image.remove();
    pool.clear();
    draw();
  }

  /* ── السحب والضغط ───────────────────────────────────────────── */

  let dragging = null;
  let moved = 0;

  box.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = { x: event.clientX, y: event.clientY };
    moved = 0;
    box.classList.add("mapbox--dragging");
    box.setPointerCapture?.(event.pointerId);
  });

  box.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging = { x: event.clientX, y: event.clientY };
    moved += Math.abs(dx) + Math.abs(dy);

    view.centerX -= dx;
    view.centerY = clamp(view.centerY - dy, 0, worldSize(view.zoom));
    draw();
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    box.classList.remove("mapbox--dragging");
    box.releasePointerCapture?.(event.pointerId);
  };

  box.addEventListener("pointerup", (event) => {
    const wasClick = moved < 6;
    endDrag(event);

    // ضغطة بلا سحب = انقل العلامة إلى المكان المضغوط
    if (wasClick) {
      const rect = box.getBoundingClientRect();
      view.centerX += event.clientX - rect.left - rect.width / 2;
      view.centerY = clamp(
        view.centerY + (event.clientY - rect.top - rect.height / 2),
        0,
        worldSize(view.zoom),
      );
      draw();
    }
  });

  box.addEventListener("pointercancel", endDrag);
  box.addEventListener("dblclick", () => setZoom(view.zoom + 1));
  zoomIn.addEventListener("click", () => setZoom(view.zoom + 1));
  zoomOut.addEventListener("click", () => setZoom(view.zoom - 1));

  box.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setZoom(view.zoom + (event.deltaY < 0 ? 1 : -1));
    },
    { passive: false },
  );

  /* ── الموقع الحالي ──────────────────────────────────────────── */

  locateButton.addEventListener("click", () => {
    if (!navigator.geolocation) {
      readout.textContent = "المتصفح لا يدعم تحديد الموقع.";
      return;
    }

    locateButton.disabled = true;
    readout.textContent = "جاري تحديد موقعك…";

    navigator.geolocation.getCurrentPosition(
      (position) => {
        locateButton.disabled = false;
        moveTo(position.coords.latitude, position.coords.longitude, 17);
      },
      (error) => {
        locateButton.disabled = false;
        readout.textContent =
          error.code === error.PERMISSION_DENIED
            ? "رُفض إذن الموقع — حدّد المكان يدوياً على الخريطة."
            : "تعذّر تحديد موقعك — حدّد المكان يدوياً على الخريطة.";
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });

  /* ── الإغلاق ────────────────────────────────────────────────── */

  return new Promise((resolve) => {
    let settled = false;

    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };

    function onKey(event) {
      if (event.key === "Escape") close(null);
    }

    confirmButton.addEventListener("click", () => {
      const point = draw();
      close({ latitude: point.latitude, longitude: point.longitude, zoom: view.zoom });
    });

    cancelButton.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });

    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    draw();
    confirmButton.focus();
  });
}
