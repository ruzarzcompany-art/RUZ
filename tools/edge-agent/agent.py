"""جهاز التحليل المباشر لـ«سِجل».

يعمل على جهاز صغير داخل المطعم موصول بنفس شبكة جهاز التسجيل (NVR):
يقرأ بث الكاميرات محلياً، يكشف الأشخاص باستمرار (YOLO)، ويتابع الطاولات
والطابور والمناطق الممنوعة المرسومة في «سِجل». لا يرسل للخادم إلا عند وقوع
حدث، مع لقطة واحدة دليلاً — الفيديو نفسه لا يغادر المطعم.

التشغيل:
    python agent.py                      الوضع العادي (يقرأ config.json)
    python agent.py --check              يفحص الاتصال بالخادم والكاميرات ثم يخرج
    python agent.py --source clip.mp4 --camera CAM-01 --zones zones.json
                                         تجربة على مقطع مسجَّل بلا خادم (تُطبع الأحداث)
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import logging.handlers
import queue
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2

from logic import (
    DoorCounter,
    TableConfig,
    TableTracker,
    assign_to_tables,
    bounds,
    count_in_polygon,
    expand_polygon,
    intrusion_tracker,
    is_off_hours,
    queue_tracker,
)

HERE = Path(__file__).resolve().parent
log = logging.getLogger("edge")

TABLE_EXPAND = 1.45  # تكبير مضلّع الطاولة ليشمل الجالسين حولها
CONFIG_REFRESH_SECONDS = 60
HEARTBEAT_SECONDS = 60
PREVIEW_SECONDS = 600
FOOTFALL_SECONDS = 300


# ── الخادم ───────────────────────────────────────────────────────────


class Server:
    def __init__(self, url: str, key: str, branch_code: str):
        self.url = url.rstrip("/")
        self.key = key
        self.branch_code = branch_code

    def _request(self, method: str, path: str, body: dict | None = None, timeout: float = 30.0) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.url}/api{path}",
            data=data,
            method=method,
            headers={"X-Surveillance-Key": self.key, "Content-Type": "application/json", "User-Agent": "sijil-edge/1"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            try:
                return json.loads(error.read().decode())
            except Exception:
                return {"ok": False, "error": f"HTTP {error.code}"}

    def config(self) -> dict:
        return self._request("GET", f"/control/edge/config?branchCode={urllib.parse.quote(self.branch_code)}")

    def events(self, events: list[dict], status: dict | None) -> dict:
        return self._request("POST", "/control/edge/events", {"branchCode": self.branch_code, "events": events, "status": status})

    def preview(self, camera_number: str, image_b64: str) -> dict:
        return self._request("POST", "/control/edge/preview", {"branchCode": self.branch_code, "cameraNumber": camera_number, "image": image_b64})


# ── الكاميرا ─────────────────────────────────────────────────────────


class Camera(threading.Thread):
    """يقرأ البث في خيط مستقل ويحتفظ بآخر إطار فقط (لا تراكم ولا تأخير)."""

    def __init__(self, number: str, url: str):
        super().__init__(daemon=True, name=f"cam-{number}")
        self.number = number
        self.url = url
        self.frame = None
        self.frame_at = 0.0
        self.ok = False
        self.lock = threading.Lock()
        self.stop_flag = threading.Event()

    def run(self) -> None:
        delay = 2.0
        while not self.stop_flag.is_set():
            capture = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not capture.isOpened():
                self.ok = False
                log.warning("الكاميرا %s: تعذّر فتح البث — إعادة المحاولة بعد %.0f ث", self.number, delay)
                self.stop_flag.wait(delay)
                delay = min(delay * 2, 60.0)
                continue
            log.info("الكاميرا %s: البث يعمل", self.number)
            delay = 2.0
            failures = 0
            while not self.stop_flag.is_set():
                grabbed, frame = capture.read()
                if not grabbed or frame is None:
                    failures += 1
                    if failures > 50:
                        break
                    time.sleep(0.05)
                    continue
                failures = 0
                with self.lock:
                    self.frame = frame
                    self.frame_at = time.time()
                    self.ok = True
            capture.release()
            self.ok = False
            log.warning("الكاميرا %s: انقطع البث — إعادة الاتصال", self.number)

    def latest(self, max_age: float = 5.0):
        with self.lock:
            if self.frame is None or time.time() - self.frame_at > max_age:
                return None
            return self.frame


def rtsp_url(nvr: dict, channel: int | str) -> str:
    """رابط البث الفرعي لقناة Hikvision. القناة رقماً، أو رابط rtsp كامل (أو مسار مقطع للتجربة)."""
    if isinstance(channel, str) and not channel.strip().isdigit():
        return channel
    user = urllib.parse.quote(str(nvr.get("username", "")), safe="")
    password = urllib.parse.quote(str(nvr.get("password", "")), safe="")
    auth = f"{user}:{password}@" if user else ""
    stream = int(nvr.get("stream", 2))  # 1 = رئيسي، 2 = فرعي (أخف وكافٍ للكشف)
    return f"rtsp://{auth}{nvr['host']}:{int(nvr.get('port', 554))}/Streaming/Channels/{int(channel)}0{stream}"


# ── الكاشف ───────────────────────────────────────────────────────────


class Detector:
    def __init__(self, model_name: str, confidence: float, image_size: int):
        from ultralytics import YOLO  # استيراد متأخر: ثقيل ولا يلزم لـ--help

        self.model = YOLO(model_name)
        self.confidence = confidence
        self.image_size = image_size

    def people(self, frame) -> list[tuple[float, float, float, float]]:
        height, width = frame.shape[:2]
        result = self.model.predict(frame, classes=[0], conf=self.confidence, imgsz=self.image_size, verbose=False)[0]
        return [(x1 / width, y1 / height, x2 / width, y2 / height) for x1, y1, x2, y2 in result.boxes.xyxy.tolist()]


# ── الصور ────────────────────────────────────────────────────────────


def encode_jpeg(frame, max_width: int, quality: int = 80) -> str:
    height, width = frame.shape[:2]
    if width > max_width:
        frame = cv2.resize(frame, (max_width, int(height * max_width / width)))
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buffer.tobytes()).decode() if ok else ""


def crop_zone(frame, polygon, expand: float = 1.25):
    """يقصّ منطقة الطاولة من الإطار — لقطة الدليل تُظهر الطاولة وحدها."""
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = bounds(expand_polygon(polygon, expand))
    crop = frame[int(y1 * height) : max(int(y2 * height), int(y1 * height) + 1), int(x1 * width) : max(int(x2 * width), int(x1 * width) + 1)]
    return crop if crop.size else frame


# ── تتبّع كاميرا واحدة ───────────────────────────────────────────────


class CameraState:
    """متتبّعات مناطق كاميرا واحدة. تبقى حالتها عند تحديث الإعدادات ما لم تتغيّر المنطقة."""

    def __init__(self, number: str):
        self.number = number
        self.zones: dict[int, dict] = {}
        self.trackers: dict[int, object] = {}
        self.signature: dict[int, str] = {}

    def apply(self, zones: list[dict], thresholds: dict) -> None:
        table_config = TableConfig(
            wait_seconds=float(thresholds.get("tableWaitSeconds", 300)),
            clear_seconds=float(thresholds.get("tableClearSeconds", 60)),
        )
        seen = set()
        for zone in zones:
            zone_id = int(zone["id"])
            seen.add(zone_id)
            points = [(float(x), float(y)) for x, y in zone["points"]]
            signature = json.dumps([zone["kind"], points, thresholds], sort_keys=True)
            self.zones[zone_id] = {"kind": zone["kind"], "label": zone.get("label", ""), "points": points}
            if self.signature.get(zone_id) == signature:
                continue
            self.signature[zone_id] = signature
            if zone["kind"] == "table":
                self.trackers[zone_id] = TableTracker(zone_id, zone.get("label", ""), table_config)
            elif zone["kind"] == "queue":
                self.trackers[zone_id] = queue_tracker(zone_id, int(thresholds.get("queueMax", 4)), float(thresholds.get("queueSeconds", 60)))
            elif zone["kind"] == "restricted":
                self.trackers[zone_id] = intrusion_tracker(zone_id)
            elif zone["kind"] == "door":
                self.trackers[zone_id] = DoorCounter(zone_id, points)
        for zone_id in [z for z in self.zones if z not in seen]:
            self.zones.pop(zone_id, None)
            self.trackers.pop(zone_id, None)
            self.signature.pop(zone_id, None)

    def update(self, now: float, boxes: list, off_hours: bool) -> list[dict]:
        events: list[dict] = []
        tables = {zid: expand_polygon(z["points"], TABLE_EXPAND) for zid, z in self.zones.items() if z["kind"] == "table"}
        table_counts = assign_to_tables(boxes, tables) if tables else {}
        for zone_id, zone in self.zones.items():
            tracker = self.trackers[zone_id]
            if zone["kind"] == "table":
                events += tracker.update(now, table_counts.get(zone_id, 0))
            elif zone["kind"] == "queue":
                events += tracker.update(now, count_in_polygon(boxes, zone["points"]))
            elif zone["kind"] == "restricted":
                events += tracker.update(now, count_in_polygon(boxes, zone["points"]), enabled=off_hours)
            elif zone["kind"] == "door":
                tracker.update(now, boxes)
        return events

    def attach_image(self, event: dict, frame) -> None:
        if not event.pop("wantImage", False):
            return
        zone = self.zones.get(event["zoneId"])
        if zone and zone["kind"] == "table" and event["type"] == "table_uncleared":
            event["image"] = encode_jpeg(crop_zone(frame, zone["points"]), 900, 85)
        else:
            event["image"] = encode_jpeg(frame, 960, 75)

    def door_totals(self) -> tuple[int, int]:
        doors = [t for t in self.trackers.values() if isinstance(t, DoorCounter)]
        return sum(d.entries for d in doors), sum(d.exits for d in doors)


def iso(seconds: float | None) -> str | None:
    return None if seconds is None else datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def wire_event(event: dict) -> dict:
    """يحوّل أوقات الحدث إلى ISO قبل الإرسال."""
    out = dict(event)
    for key in ("since", "at", "seatedAt", "leftAt"):
        if key in out:
            out[key] = iso(out[key])
    return out


# ── الوضع العادي ─────────────────────────────────────────────────────


class Agent:
    def __init__(self, config: dict):
        self.config = config
        self.server = Server(config["serverUrl"], config["agentKey"], config["branchCode"])
        self.fps = float(config.get("fps", 2))
        self.detector = Detector(config.get("model", "yolo11n.pt"), float(config.get("confidence", 0.35)), int(config.get("imageSize", 640)))
        self.cameras: dict[str, Camera] = {}
        self.states: dict[str, CameraState] = {}
        self.remote: dict = {}
        self.outbox: queue.Queue = queue.Queue(maxsize=300)
        self.hour_base: dict[str, tuple[int, int]] = {}
        self.hour_key = ""
        self.started = time.time()

    # الإعدادات من الخادم
    def refresh(self) -> bool:
        try:
            remote = self.server.config()
        except Exception as error:
            log.warning("تعذّر جلب الإعدادات من الخادم: %s", error)
            return False
        if not remote.get("ok"):
            log.warning("الخادم رفض طلب الإعدادات: %s", remote.get("error"))
            return False
        self.remote = remote
        channels = self.config.get("cameras", {})
        wanted = set()
        for camera in remote.get("cameras", []):
            number = camera["cameraNumber"]
            if number not in channels:
                log.warning("الكاميرا %s لها مناطق مرسومة لكنها غير معرّفة في config.json (cameras)", number)
                continue
            wanted.add(number)
            self.states.setdefault(number, CameraState(number)).apply(camera["zones"], remote["thresholds"])
            if number not in self.cameras:
                self.cameras[number] = Camera(number, rtsp_url(self.config.get("nvr", {}), channels[number]))
                self.cameras[number].start()
        for number in [n for n in self.cameras if n not in wanted]:
            self.cameras.pop(number).stop_flag.set()
            self.states.pop(number, None)
        return True

    def off_hours(self, now: float) -> bool:
        hours = self.remote.get("hours", {})
        zone = ZoneInfo(self.remote.get("branch", {}).get("timezone", "Asia/Riyadh"))
        local = datetime.fromtimestamp(now, zone)
        return is_off_hours(local.hour * 60 + local.minute, hours.get("open", "06:00"), hours.get("close", "02:00"))

    def status(self) -> dict:
        return {
            "version": 1,
            "uptimeMinutes": int((time.time() - self.started) / 60),
            "fps": self.fps,
            "cameras": [{"number": number, "ok": camera.ok} for number, camera in sorted(self.cameras.items())],
            "pending": self.outbox.qsize(),
        }

    def enqueue(self, number: str, event: dict) -> None:
        try:
            self.outbox.put_nowait((number, event))
        except queue.Full:
            log.error("قائمة الإرسال ممتلئة — أُسقط حدث %s", event.get("type"))

    # خيط الإرسال: يرسل الأحداث ويعيد أحكام لقطات الطاولات للمتتبّعات
    def sender(self) -> None:
        last_beat = 0.0
        while True:
            try:
                number, event = self.outbox.get(timeout=5)
            except queue.Empty:
                number, event = None, None
            if event is None:
                if time.time() - last_beat >= HEARTBEAT_SECONDS:
                    try:
                        self.server.events([], self.status())
                        last_beat = time.time()
                    except Exception as error:
                        log.warning("تعذّر إرسال النبض: %s", error)
                continue
            verdict = None
            for attempt in range(4):
                try:
                    reply = self.server.events([wire_event(event)], self.status())
                    last_beat = time.time()
                    result = (reply.get("results") or [{}])[0]
                    if not reply.get("ok") or not result.get("ok"):
                        log.warning("الخادم رفض الحدث %s: %s", event["type"], result.get("error") or reply.get("error"))
                    else:
                        verdict = result.get("verdict") or ("dirty" if result.get("raised") else None)
                        log.info("أُرسل %s (منطقة %s) ← %s", event["type"], event.get("zoneId"), result)
                    break
                except Exception as error:
                    log.warning("تعذّر إرسال %s (محاولة %d): %s", event["type"], attempt + 1, error)
                    time.sleep(5 * (attempt + 1))
            if event["type"] == "table_uncleared" and number in self.states:
                tracker = self.states[number].trackers.get(event["zoneId"])
                if isinstance(tracker, TableTracker):
                    for follow_up in tracker.on_verdict(time.time(), verdict):
                        self.enqueue(number, follow_up)

    def send_footfall(self, now: float) -> None:
        hour = datetime.fromtimestamp(now, timezone.utc).replace(minute=0, second=0, microsecond=0)
        key = hour.isoformat()
        totals = {number: state.door_totals() for number, state in self.states.items()}
        if not any(isinstance(t, DoorCounter) for s in self.states.values() for t in s.trackers.values()):
            return
        if key != self.hour_key:
            self.hour_key = key
            self.hour_base = dict(totals)
        entries = sum(t[0] - self.hour_base.get(n, (0, 0))[0] for n, t in totals.items())
        exits = sum(t[1] - self.hour_base.get(n, (0, 0))[1] for n, t in totals.items())
        self.enqueue("", {"type": "footfall", "hourStart": hour.timestamp(), "entries": max(entries, 0), "exits": max(exits, 0)})

    def run(self) -> None:
        while not self.refresh():
            time.sleep(15)
        threading.Thread(target=self.sender, daemon=True, name="sender").start()
        log.info("بدأ التحليل: %d كاميرا، %.1f إطار/ث", len(self.cameras), self.fps)
        last_refresh = time.time()
        last_preview: dict[str, float] = {}
        last_footfall = time.time()
        interval = 1.0 / self.fps
        while True:
            tick = time.time()
            off_hours = self.off_hours(tick)
            for number, camera in list(self.cameras.items()):
                frame = camera.latest()
                if frame is None:
                    continue
                try:
                    boxes = self.detector.people(frame)
                except Exception as error:
                    log.error("فشل الكشف على الكاميرا %s: %s", number, error)
                    continue
                state = self.states[number]
                for event in state.update(tick, boxes, off_hours):
                    state.attach_image(event, frame)
                    self.enqueue(number, event)
                if tick - last_preview.get(number, 0) >= PREVIEW_SECONDS:
                    last_preview[number] = tick
                    threading.Thread(target=self._preview, args=(number, frame.copy()), daemon=True).start()
            if tick - last_footfall >= FOOTFALL_SECONDS:
                last_footfall = tick
                self.send_footfall(tick)
            if tick - last_refresh >= CONFIG_REFRESH_SECONDS:
                last_refresh = tick
                self.refresh()
            time.sleep(max(0.0, interval - (time.time() - tick)))

    def _preview(self, number: str, frame) -> None:
        try:
            self.server.preview(number, encode_jpeg(frame, 1280, 80))
        except Exception as error:
            log.warning("تعذّر رفع معاينة الكاميرا %s: %s", number, error)

    def check(self) -> int:
        """فحص التركيب: الخادم، ثم كل كاميرا معرّفة في config.json (ولو بلا مناطق)."""
        problems = 0
        try:
            remote = self.server.config()
        except Exception as error:
            remote = {"ok": False, "error": str(error)}
        if remote.get("ok"):
            print(f"✓ الخادم: {remote['branch']['name']} — {len(remote.get('cameras', []))} كاميرا لها مناطق مرسومة")
        else:
            print(f"✗ الخادم: {remote.get('error')}")
            problems += 1
        for number, channel in self.config.get("cameras", {}).items():
            capture = cv2.VideoCapture(rtsp_url(self.config.get("nvr", {}), channel), cv2.CAP_FFMPEG)
            grabbed, frame = capture.read() if capture.isOpened() else (False, None)
            capture.release()
            if not grabbed:
                print(f"✗ الكاميرا {number} (قناة {channel}): لا بث — راجع عنوان الجهاز واسم المستخدم وكلمة المرور")
                problems += 1
                continue
            people = len(self.detector.people(frame))
            sent = self.server.preview(number, encode_jpeg(frame, 1280, 80)) if remote.get("ok") else {"ok": False}
            print(f"✓ الكاميرا {number}: {frame.shape[1]}×{frame.shape[0]}، {people} شخص في اللقطة، المعاينة {'رُفعت' if sent.get('ok') else 'لم تُرفع'}")
        return 1 if problems else 0


# ── تجربة على مقطع مسجَّل ────────────────────────────────────────────


def run_on_file(args, config: dict) -> None:
    """يشغّل المنطق على مقطع بزمن المقطع نفسه (أسرع من الزمن الحقيقي) ويطبع الأحداث."""
    spec = json.loads(Path(args.zones).read_text(encoding="utf-8"))
    thresholds = {"tableWaitSeconds": 300, "tableClearSeconds": 60, "queueMax": 4, "queueSeconds": 60, **spec.get("thresholds", {})}
    state = CameraState(args.camera)
    state.apply(spec["zones"], thresholds)
    detector = Detector(config.get("model", "yolo11n.pt"), float(config.get("confidence", 0.35)), int(config.get("imageSize", 640)))
    capture = cv2.VideoCapture(args.source)
    video_fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, round(video_fps / float(config.get("fps", 2))))
    index = 0
    out_dir = Path(args.out) if args.out else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
    while True:
        grabbed, frame = capture.read()
        if not grabbed:
            break
        if index % step == 0:
            now = index / video_fps
            boxes = detector.people(frame)
            for event in state.update(now, boxes, off_hours=bool(spec.get("offHours", False))):
                wants = event.get("wantImage")
                state.attach_image(event, frame)
                image = event.pop("image", None)
                print(f"[{now:7.1f}s] {json.dumps(event, ensure_ascii=False)}")
                if out_dir and wants and image:
                    (out_dir / f"{event['type']}_{event['zoneId']}_{int(now)}.jpg").write_bytes(base64.b64decode(image))
                # في التجربة لا خادم: تُعدّ لقطة الطاولة «متسخة» لتظهر دورة إعادة التحقق
                if event["type"] == "table_uncleared":
                    state.trackers[event["zoneId"]].on_verdict(now, "dirty")
            if args.verbose and index % (step * 10) == 0:
                print(f"[{now:7.1f}s] أشخاص: {len(boxes)}")
        index += 1
    entries, exits = state.door_totals()
    print(f"انتهى المقطع ({index / video_fps:.0f} ث). الباب: دخول {entries}، خروج {exits}.")


def main() -> int:
    parser = argparse.ArgumentParser(description="جهاز التحليل المباشر لسِجل")
    parser.add_argument("--config", default=str(HERE / "config.json"))
    parser.add_argument("--check", action="store_true", help="فحص الخادم والكاميرات ثم الخروج")
    parser.add_argument("--source", help="مقطع فيديو للتجربة بدل الكاميرات")
    parser.add_argument("--camera", default="CAM-01")
    parser.add_argument("--zones", help="ملف مناطق محلي للتجربة (JSON)")
    parser.add_argument("--out", help="مجلد تُحفظ فيه لقطات الأحداث أثناء التجربة")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if not args.source:
        handlers.append(logging.handlers.RotatingFileHandler(HERE / "agent.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)

    config_path = Path(args.config)
    config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    if args.source:
        if not args.zones:
            parser.error("--source يحتاج --zones")
        run_on_file(args, config)
        return 0
    missing = [key for key in ("serverUrl", "agentKey", "branchCode") if not config.get(key)]
    if missing:
        print(f"أكمل config.json أولاً — ناقص: {', '.join(missing)} (انسخ config.example.json)")
        return 2
    agent = Agent(config)
    if args.check:
        return agent.check()
    agent.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
