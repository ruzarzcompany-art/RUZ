"""اختبارات منطق التتبع — تُشغَّل بـ: python test_logic.py"""

from logic import (
    DoorCounter,
    FrameHistory,
    TableConfig,
    TableTracker,
    assign_to_tables,
    expand_polygon,
    intrusion_tracker,
    is_off_hours,
    point_in_polygon,
    queue_tracker,
)


def run(tracker, timeline, step=0.5, start=1000.0):
    """timeline: قائمة (مدة بالثواني، عدد). تُرجع (الأحداث، الوقت النهائي)."""
    now = start
    events = []
    for duration, count in timeline:
        end = now + duration
        while now < end:
            for event in tracker.update(now, count):
                events.append((round(now - start), event))
            now += step
    return events, now


def types(events):
    return [event["type"] for _, event in events]


def test_geometry():
    square = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)]
    assert point_in_polygon(0.5, 0.5, square)
    assert not point_in_polygon(0.7, 0.5, square)
    assert point_in_polygon(0.65, 0.5, expand_polygon(square, 1.6))
    # شخص بين طاولتين يُحسب للأقرب فقط
    tables = {1: expand_polygon(square, 2.0), 2: expand_polygon([(0.7, 0.4), (0.9, 0.4), (0.9, 0.6), (0.7, 0.6)], 2.0)}
    counts = assign_to_tables([(0.60, 0.2, 0.68, 0.6)], tables)
    assert counts == {1: 1, 2: 0}, counts


def test_unattended_fires_once_after_wait():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300, clear_seconds=60))
    events, _ = run(table, [(10, 0), (400, 2)])
    assert types(events) == ["table_unattended"], events
    at, event = events[0]
    assert 309 <= at <= 312, at  # جلسوا عند الثانية 10 ← التنبيه بعد 300 ثانية
    assert event["people"] == 2 and 300 <= event["seconds"] <= 302


def test_waiter_visit_cancels_alert():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300))
    # جلس اثنان، وبعد دقيقتين وقف موظف 15 ثانية ثم ذهب
    events, _ = run(table, [(120, 2), (15, 3), (300, 2)])
    assert types(events) == [], events
    assert 118 <= table.first_visit_seconds <= 122


def test_passerby_does_not_count_as_visit():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300))
    # مارّ بجانب الطاولة ثانية ونصف فقط — لا يُلغي التنبيه
    events, _ = run(table, [(120, 2), (1.5, 3), (300, 2)])
    assert types(events) == ["table_unattended"], events


def test_friend_joining_is_not_a_visit():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300))
    # انضم ثالث وبقي: ليس موظفاً، فالتنبيه يبقى قائماً
    events, _ = run(table, [(60, 2), (400, 3)])
    assert types(events) == ["table_unattended"], events
    assert events[0][1]["people"] == 3


def test_alert_waits_while_someone_is_standing_at_table():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300))
    # الموظف وصل قبل انتهاء المهلة بثوانٍ وما زال واقفاً عندها: لا تنبيه
    events, _ = run(table, [(295, 2), (20, 3), (60, 2)])
    assert types(events) == [], events


def test_detector_flicker_is_ignored():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300))
    timeline = []
    for _ in range(80):  # عدد يومض 2 ← 3 ← 2 لإطار واحد كل 5 ثوانٍ
        timeline += [(4.5, 2), (0.5, 3)]
    events, _ = run(table, timeline)
    assert types(events) == ["table_unattended"], events


def test_short_presence_never_becomes_session():
    table = TableTracker(4, "4", TableConfig())
    events, _ = run(table, [(10, 1), (60, 0)])
    assert events == [] and table.state == "empty"


def test_vacate_then_uncleared_check_and_clean_verdict():
    table = TableTracker(4, "4", TableConfig(wait_seconds=300, clear_seconds=60))
    events, now = run(table, [(100, 2), (10, 3), (100, 2), (120, 0)])
    assert types(events) == ["table_session", "table_uncleared"], events
    session_at, session = events[0]
    check_at, check = events[1]
    assert 238 <= session_at <= 242  # 30 ثانية خلوّ بعد المغادرة عند 210
    assert session["leftAt"] is not None and session["clearedSeconds"] is None
    assert 268 <= check_at <= 272, check_at  # مهلة التنظيف 60 ثانية من المغادرة
    assert 58 <= check["seconds"] <= 62
    done = table.on_verdict(now, "clean")
    assert [e["type"] for e in done] == ["table_session"] and done[0]["clearedSeconds"] is not None
    assert table.state == "empty"


def test_dirty_then_staff_cleans_then_recheck():
    table = TableTracker(4, "4", TableConfig(clear_seconds=60))
    events, now = run(table, [(100, 2), (95, 0)])
    assert types(events)[-1] == "table_uncleared"
    assert table.on_verdict(now, "dirty") == []
    # موظف اقترب 20 ثانية ثم ابتعد ← لقطة تحقق جديدة بعد أن يهدأ المشهد
    events, now = run(table, [(20, 1), (30, 0)], start=now)
    assert types(events) == ["table_uncleared"], events
    done = table.on_verdict(now, "clean")
    assert done and done[0]["type"] == "table_session"


def test_checks_are_capped():
    table = TableTracker(4, "4", TableConfig(clear_seconds=60, max_checks=3, recheck_seconds=180))
    events, now = run(table, [(100, 2), (95, 0)])
    total = types(events).count("table_uncleared")
    for _ in range(6):
        table.on_verdict(now, "dirty")
        events, now = run(table, [(200, 0)], start=now)
        total += types(events).count("table_uncleared")
    assert total == 3, total


def test_new_customers_before_cleaning_start_new_session():
    table = TableTracker(4, "4", TableConfig(clear_seconds=600))
    events, now = run(table, [(100, 2), (40, 0), (120, 3)])
    assert types(events) == ["table_session", "table_session"], events
    assert table.state == "occupied" and table.baseline == 3


def test_lost_connection_does_not_loop():
    table = TableTracker(4, "4", TableConfig(clear_seconds=60, max_checks=3))
    events, now = run(table, [(100, 2), (95, 0)])
    table.on_verdict(now, None)
    events, now = run(table, [(100, 0)], start=now)
    assert types(events) == [], events  # ينتظر مهلة إعادة التحقق


def test_queue():
    queue = queue_tracker(9, queue_max=4, queue_seconds=60)
    events, now = run(queue, [(30, 3), (50, 6), (20, 2), (200, 7)])
    assert types(events) == ["queue_long"], events
    assert events[0][1]["people"] == 7 and events[0][1]["seconds"] >= 60
    # يبقى الطابور ← لا تكرار؛ ينتهي دقيقتين ثم يعود ← تنبيه جديد
    events, now = run(queue, [(300, 7), (130, 1), (70, 6)], start=now)
    assert types(events) == ["queue_long"], events


def test_intrusion_only_off_hours():
    zone = intrusion_tracker(3)
    now, events = 0.0, []
    for _ in range(40):
        events += zone.update(now, 1, enabled=False)
        now += 0.5
    assert events == []
    for _ in range(40):
        events += zone.update(now, 1, enabled=True)
        now += 0.5
    assert [e["type"] for e in events] == ["intrusion"]


def test_off_hours():
    assert is_off_hours(3 * 60, "06:00", "02:00")
    assert not is_off_hours(1 * 60, "06:00", "02:00")
    assert not is_off_hours(12 * 60, "06:00", "02:00")
    assert is_off_hours(23 * 60, "08:00", "22:00")


def test_door_counter():
    door = DoorCounter(1, [(0.3, 0.5), (0.7, 0.5)])

    def walk(start_y, end_y, x, t0):
        steps = 10
        for i in range(steps + 1):
            y = start_y + (end_y - start_y) * i / steps
            door.update(t0 + i * 0.5, [(x - 0.03, y - 0.2, x + 0.03, y)])

    walk(0.3, 0.7, 0.5, 0)  # داخل (نحو أسفل الصورة)
    walk(0.3, 0.7, 0.45, 20)  # داخل
    walk(0.7, 0.3, 0.55, 40)  # خارج
    walk(0.3, 0.7, 0.9, 60)  # مرّ خارج طرف الخط — لا يُعدّ
    assert (door.entries, door.exits) == (2, 1), (door.entries, door.exits)
    # شخص يقف على الخط ويتذبذب: لا يُعدّ أكثر من مرة خلال 3 ثوانٍ
    for i in range(12):
        y = 0.49 if i % 2 else 0.51
        door.update(100 + i * 0.2, [(0.47, y - 0.2, 0.53, y)])
    assert door.entries + door.exits <= 4


def test_frame_history_keeps_spaced_earlier_frames():
    history = FrameHistory(spacing=3.0, keep=3)
    for i in range(40):  # إطاران في الثانية لمدة 20 ثانية
        history.push(100 + i * 0.5, f"f{i}")
    now = 100 + 39 * 0.5
    earlier = history.earlier(now, count=2)
    assert len(earlier) == 2
    assert earlier[0][0] < earlier[1][0] <= now - 1.5
    assert earlier[1][0] - earlier[0][0] >= 3.0
    # الإطارات القديمة جداً لا تُرفق (انقطع البث ثم عاد)
    assert history.earlier(now + 120) == []
    assert FrameHistory().earlier(5.0) == []


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print("ok ", test.__name__)
    print(f"{len(tests)} tests passed")
