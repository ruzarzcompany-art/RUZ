"""منطق التتبع لجهاز التحليل — بلا أي مكتبة خارجية حتى يُختبر وحده.

كل الإحداثيات نِسَب من عرض الصورة وارتفاعها (0–1)، وكل الأوقات ثوانٍ (epoch).
الكاشف يعطي في كل لحظة صناديق الأشخاص فقط؛ وهنا تتحول إلى حالات:

    TableTracker      طاولة: فاضية ← جلس عملاء ← (وصلهم موظف؟) ← غادروا ← نُظّفت؟
    QueueTracker      طابور الكاشير فوق الحد لمدة متصلة
    IntrusionTracker  شخص في منطقة ممنوعة خارج ساعات العمل
    DoorCounter       عدّ العابرين لخط الباب في الاتجاهين

وصول الموظف للطاولة يُستنتج من العدد لا من التعرّف على الأشخاص: إذا زاد عدد
مَن حول الطاولة عن عدد الجالسين لبضع ثوانٍ ثم عاد كما كان، فقد وقف عندها أحد
(موظف). وإن بقيت الزيادة فهو عميل انضم إليهم.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

Point = tuple[float, float]
Box = tuple[float, float, float, float]  # x1, y1, x2, y2


# ── هندسة ────────────────────────────────────────────────────────────


def point_in_polygon(x: float, y: float, polygon: list[Point]) -> bool:
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def centroid(polygon: list[Point]) -> Point:
    return (sum(p[0] for p in polygon) / len(polygon), sum(p[1] for p in polygon) / len(polygon))


def expand_polygon(polygon: list[Point], factor: float) -> list[Point]:
    """يكبّر المضلّع حول مركزه — الجالسون يحيطون بسطح الطاولة لا فوقه."""
    cx, cy = centroid(polygon)
    return [(cx + (x - cx) * factor, cy + (y - cy) * factor) for x, y in polygon]


def bounds(polygon: list[Point]) -> Box:
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return (max(0.0, min(xs)), max(0.0, min(ys)), min(1.0, max(xs)), min(1.0, max(ys)))


def seat_anchor(box: Box) -> Point:
    """نقطة تمثّل الشخص عند الطاولة: منتصف العرض وعلى 70% من الارتفاع (الخصر)."""
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2, y1 + (y2 - y1) * 0.7)


def foot_anchor(box: Box) -> Point:
    """موضع القدمين — للواقفين في الطابور وللعابرين من الباب."""
    x1, _, x2, y2 = box
    return ((x1 + x2) / 2, y2)


def assign_to_tables(boxes: list[Box], tables: dict[int, list[Point]]) -> dict[int, int]:
    """يعدّ الأشخاص عند كل طاولة. الشخص يُحسب لطاولة واحدة فقط: الأقرب مركزاً."""
    counts = {zone_id: 0 for zone_id in tables}
    centers = {zone_id: centroid(polygon) for zone_id, polygon in tables.items()}
    for box in boxes:
        x, y = seat_anchor(box)
        best = None
        best_distance = 0.0
        for zone_id, polygon in tables.items():
            if not point_in_polygon(x, y, polygon):
                continue
            cx, cy = centers[zone_id]
            distance = (x - cx) ** 2 + (y - cy) ** 2
            if best is None or distance < best_distance:
                best, best_distance = zone_id, distance
        if best is not None:
            counts[best] += 1
    return counts


def count_in_polygon(boxes: list[Box], polygon: list[Point]) -> int:
    return sum(1 for box in boxes if point_in_polygon(*foot_anchor(box), polygon))


# ── تنعيم العدد ──────────────────────────────────────────────────────


class Smoother:
    """وسيط العدد خلال نافذة قصيرة — يتجاهل وميض الكاشف لإطار أو إطارين."""

    def __init__(self, window_seconds: float = 3.0):
        self.window = window_seconds
        self.samples: deque[tuple[float, int]] = deque()

    def add(self, now: float, count: int) -> int:
        self.samples.append((now, count))
        while self.samples and now - self.samples[0][0] > self.window:
            self.samples.popleft()
        values = sorted(c for _, c in self.samples)
        return values[len(values) // 2]


# ── الطاولة ──────────────────────────────────────────────────────────


@dataclass
class TableConfig:
    wait_seconds: float = 300.0  # مهلة وصول الموظف بعد جلوس العملاء
    clear_seconds: float = 60.0  # مهلة تنظيف الطاولة بعد مغادرتهم
    occupy_seconds: float = 20.0  # وجود متصل يُعدّ بعده العملاء جالسين
    vacate_seconds: float = 30.0  # خلوّ متصل تُعدّ بعده الطاولة فاضية
    visit_min_seconds: float = 4.0  # أقل وقوف يُحسب زيارة موظف (يستبعد المارّين)
    seat_seconds: float = 45.0  # زيادة تدوم أكثر من ذلك = عميل انضم لا موظف
    settle_seconds: float = 10.0  # انتظار بعد ابتعاد الموظف قبل تصوير الطاولة
    max_checks: int = 3  # أقصى عدد لقطات تحقق لكل جلسة (يضبط التكلفة)
    recheck_seconds: float = 180.0  # إعادة التحقق إن بقيت متسخة ولم يقترب أحد


class TableTracker:
    """آلة حالات طاولة واحدة. `update` تُرجع قائمة أحداث (قواميس) إن وُجدت."""

    def __init__(self, zone_id: int, label: str, config: TableConfig):
        self.zone_id = zone_id
        self.label = label
        self.config = config
        self.smoother = Smoother()
        self.state = "empty"  # empty | occupied | vacated
        self._reset_session()
        self.presence_since: float | None = None
        self.zero_since: float | None = None

    def _reset_session(self) -> None:
        self.seated_at: float | None = None
        self.left_at: float | None = None
        self.baseline = 0
        self.max_people = 0
        self.rise_since: float | None = None
        self.drop_since: float | None = None
        self.first_visit_seconds: int | None = None
        self.unattended_sent = False
        # بعد المغادرة
        self.checks = 0
        self.check_pending = False
        self.next_check_at: float | None = None
        self.cleared_seconds: int | None = None
        self.staff_since: float | None = None

    # ── أدوات ──

    def _session_event(self) -> dict:
        return {
            "type": "table_session",
            "zoneId": self.zone_id,
            "seatedAt": self.seated_at,
            "leftAt": self.left_at,
            "firstVisitSeconds": self.first_visit_seconds,
            "clearedSeconds": self.cleared_seconds,
            "people": self.max_people,
        }

    def _start_session(self, seated_at: float, count: int) -> None:
        self._reset_session()
        self.state = "occupied"
        self.seated_at = seated_at
        self.baseline = max(count, 1)
        self.max_people = self.baseline
        self.zero_since = None

    # ── التحديث ──

    def update(self, now: float, raw_count: int) -> list[dict]:
        count = self.smoother.add(now, raw_count)
        events: list[dict] = []
        config = self.config

        if count > 0:
            if self.presence_since is None:
                self.presence_since = now
            self.zero_since = None
        else:
            if self.zero_since is None:
                self.zero_since = now
            if now - self.zero_since >= 2.0:
                self.presence_since = None

        if self.state == "empty":
            if self.presence_since is not None and now - self.presence_since >= config.occupy_seconds:
                self._start_session(self.presence_since, count)
            return events

        if self.state == "occupied":
            self.max_people = max(self.max_people, count)
            if self.zero_since is not None and now - self.zero_since >= config.vacate_seconds:
                # غادروا: يبدأ عدّ مهلة التنظيف من لحظة الخلو
                self.state = "vacated"
                self.left_at = self.zero_since
                self.next_check_at = self.left_at + config.clear_seconds
                self.rise_since = None
                events.append(self._session_event())
                return events
            if count == 0:
                return events

            if count > self.baseline:
                self.drop_since = None
                if self.rise_since is None:
                    self.rise_since = now
                elif now - self.rise_since >= config.seat_seconds:
                    self.baseline = count  # عميل انضم
                    self.rise_since = None
            else:
                if self.rise_since is not None:
                    stayed = now - self.rise_since
                    if stayed >= config.visit_min_seconds and self.first_visit_seconds is None:
                        self.first_visit_seconds = int(self.rise_since - self.seated_at)
                    self.rise_since = None
                if count < self.baseline:
                    if self.drop_since is None:
                        self.drop_since = now
                    elif now - self.drop_since >= config.seat_seconds:
                        self.baseline = count  # عميل غادر وبقي غيره
                        self.drop_since = None
                else:
                    self.drop_since = None

            waited = now - self.seated_at
            if (
                self.first_visit_seconds is None
                and not self.unattended_sent
                and self.rise_since is None  # لا أحد واقف عند الطاولة الآن
                and waited >= config.wait_seconds
            ):
                self.unattended_sent = True
                events.append(
                    {
                        "type": "table_unattended",
                        "zoneId": self.zone_id,
                        "since": self.seated_at,
                        "at": now,
                        "seconds": int(waited),
                        "people": self.baseline,
                        "wantImage": True,
                    }
                )
            return events

        # ── vacated: فضيت وتنتظر التنظيف ──
        if count > 0:
            if self.staff_since is None:
                self.staff_since = self.presence_since or now
            if now - self.staff_since >= config.seat_seconds:
                # بقاء طويل = عملاء جدد جلسوا قبل التحقق من نظافتها
                events.append(self._session_event())
                self._start_session(self.staff_since, count)
            return events

        if self.staff_since is not None:
            # اقترب أحد ثم ابتعد (غالباً موظف ينظّف): تُصوَّر بعد أن يهدأ المشهد
            self.staff_since = None
            if not self.check_pending and self.checks < config.max_checks:
                self.next_check_at = max(now + config.settle_seconds, self.left_at + config.clear_seconds)

        if (
            not self.check_pending
            and self.next_check_at is not None
            and now >= self.next_check_at
            and self.checks < config.max_checks
        ):
            self.checks += 1
            self.check_pending = True
            self.next_check_at = None
            events.append(
                {
                    "type": "table_uncleared",
                    "zoneId": self.zone_id,
                    "since": self.left_at,
                    "at": now,
                    "seconds": int(now - self.left_at),
                    "people": 0,
                    "wantImage": True,
                }
            )
        return events

    def on_verdict(self, now: float, verdict: str | None) -> list[dict]:
        """رد الخادم على لقطة الطاولة: clean / dirty / occupied / unverified / None (تعذّر الاتصال)."""
        if self.state != "vacated" or not self.check_pending:
            return []
        self.check_pending = False
        if verdict == "clean":
            self.cleared_seconds = int(now - self.left_at)
            event = self._session_event()
            self.state = "empty"
            self._reset_session()
            return [event]
        if verdict == "occupied":
            return []  # سيلتقطها `update` كجلسة جديدة
        if self.checks < self.config.max_checks:
            self.next_check_at = now + self.config.recheck_seconds
        return []


# ── الطابور والمنطقة الممنوعة ────────────────────────────────────────


class SustainedTracker:
    """يُطلق حدثاً واحداً حين يتحقق الشرط لمدة متصلة، ثم يتسلّح بعد زواله."""

    def __init__(self, zone_id: int, event_type: str, threshold: int, hold_seconds: float, rearm_seconds: float):
        self.zone_id = zone_id
        self.event_type = event_type
        self.threshold = threshold  # الشرط: العدد > threshold
        self.hold_seconds = hold_seconds
        self.rearm_seconds = rearm_seconds
        self.smoother = Smoother()
        self.since: float | None = None
        self.clear_since: float | None = None
        self.fired = False
        self.peak = 0

    def update(self, now: float, raw_count: int, enabled: bool = True) -> list[dict]:
        count = self.smoother.add(now, raw_count)
        if not enabled:
            self.since = None
            self.fired = False
            return []
        if count > self.threshold:
            self.clear_since = None
            if self.since is None:
                self.since = now
                self.peak = count
            self.peak = max(self.peak, count)
            if not self.fired and now - self.since >= self.hold_seconds:
                self.fired = True
                return [
                    {
                        "type": self.event_type,
                        "zoneId": self.zone_id,
                        "since": self.since,
                        "at": now,
                        "seconds": int(now - self.since),
                        "people": self.peak,
                        "wantImage": True,
                    }
                ]
            return []
        if self.since is not None:
            if self.clear_since is None:
                self.clear_since = now
            # انقطاع قصير قبل الإطلاق يُلغي العدّ؛ وبعده يُنتظر زمن إعادة التسليح
            limit = self.rearm_seconds if self.fired else 5.0
            if now - self.clear_since >= limit:
                self.since = None
                self.fired = False
        return []


def queue_tracker(zone_id: int, queue_max: int, queue_seconds: float) -> SustainedTracker:
    return SustainedTracker(zone_id, "queue_long", queue_max, queue_seconds, rearm_seconds=120.0)


def intrusion_tracker(zone_id: int) -> SustainedTracker:
    return SustainedTracker(zone_id, "intrusion", 0, 5.0, rearm_seconds=300.0)


# ── عدّ الباب ────────────────────────────────────────────────────────


def _side(a: Point, b: Point, p: Point) -> float:
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _segments_cross(p1: Point, p2: Point, a: Point, b: Point) -> bool:
    d1 = _side(a, b, p1)
    d2 = _side(a, b, p2)
    d3 = _side(p1, p2, a)
    d4 = _side(p1, p2, b)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


class DoorCounter:
    """يتتبّع الأقدام بين الإطارات ويعدّ من يقطع الخط.

    الخط مرسوم من النقطة الأولى إلى الثانية. «دخول» = العبور إلى الجهة التي
    تقع أسفل الخط حين يُرسم من اليسار إلى اليمين. إن انعكس العدّ يُرسم الخط
    بالاتجاه المعاكس.
    """

    def __init__(self, zone_id: int, line: list[Point], max_jump: float = 0.15, ttl_seconds: float = 1.5):
        self.zone_id = zone_id
        self.a, self.b = line[0], line[1]
        self.max_jump = max_jump
        self.ttl = ttl_seconds
        self.tracks: dict[int, dict] = {}
        self.next_id = 1
        self.entries = 0
        self.exits = 0

    def update(self, now: float, boxes: list[Box]) -> None:
        points = [foot_anchor(box) for box in boxes]
        for track_id in [t for t, track in self.tracks.items() if now - track["seen"] > self.ttl]:
            del self.tracks[track_id]

        pairs = []
        for track_id, track in self.tracks.items():
            for index, point in enumerate(points):
                distance = ((point[0] - track["pos"][0]) ** 2 + (point[1] - track["pos"][1]) ** 2) ** 0.5
                if distance <= self.max_jump:
                    pairs.append((distance, track_id, index))
        pairs.sort()
        used_tracks: set[int] = set()
        used_points: set[int] = set()
        for _, track_id, index in pairs:
            if track_id in used_tracks or index in used_points:
                continue
            used_tracks.add(track_id)
            used_points.add(index)
            track = self.tracks[track_id]
            previous, current = track["pos"], points[index]
            if now - track["counted"] > 3.0 and _segments_cross(previous, current, self.a, self.b):
                if _side(self.a, self.b, current) > 0:
                    self.entries += 1
                else:
                    self.exits += 1
                track["counted"] = now
            track["pos"] = current
            track["seen"] = now
        for index, point in enumerate(points):
            if index not in used_points:
                self.tracks[self.next_id] = {"pos": point, "seen": now, "counted": -1e9}
                self.next_id += 1


# ── ساعات العمل ──────────────────────────────────────────────────────


def is_off_hours(minute_of_day: int, open_time: str, close_time: str) -> bool:
    """هل الدقيقة خارج ساعات العمل؟ (يدعم الإغلاق بعد منتصف الليل)"""

    def minutes(value: str) -> int:
        hour, _, minute = value.partition(":")
        return int(hour or 0) * 60 + int(minute or 0)

    open_m, close_m = minutes(open_time), minutes(close_time)
    if open_m == close_m:
        return False
    if open_m < close_m:
        return minute_of_day < open_m or minute_of_day >= close_m
    return close_m <= minute_of_day < open_m
