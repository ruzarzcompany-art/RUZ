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


def types(events, seated=True):
    return [event["type"] for _, event in events if seated or event["type"] != "table_seated"]


def after(events):
    """أحداث ما بعد الجلوس — لاختبارات المغادرة والتنظيف التي لا تعنيها لقطة الجلوس."""
    return [(at, event) for at, event in events if event["type"] != "table_seated"]


def test_geometry():
    square = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)]
    assert point_in_polygon(0.5, 0.5, square)
    assert not point_in_polygon(0.7, 0.5, square)
    assert point_in_polygon(0.65, 0.5, expand_polygon(square, 1.6))
    # شخص بين طاولتين يُحسب للأقرب فقط
    tables = {1: expand_polygon(square, 2.0), 2: expand_polygon([(0.7, 0.4), (0.9, 0.4), (0.9, 0.6), (0.7, 0.6)], 2.0)}
    counts = assign_to_tables([(0.60, 0.2, 0.68, 0.6)], tables)
    assert counts == {1: 1, 2: 0}, counts


def checks(events):
    return [(at, e["stage"]) for at, e in events if e["type"] == "table_order_check"]


def test_three_snapshots_seated_mid_final():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600, clear_seconds=60))
    events, _ = run(table, [(10, 0), (700, 2)])
    # لقطة عند الجلوس، ثم بعد 5 دقائق، ثم بعد 10 — ولا شيء بعدها
    assert types(events) == ["table_seated", "table_order_check", "table_order_check"], events
    assert 29 <= events[0][0] <= 32, events[0][0]  # تأكّد الجلوس بعد 20 ثانية وجود
    (mid_at, mid), (final_at, final) = checks(events)
    assert mid == "mid" and 309 <= mid_at <= 312, mid_at
    assert final == "final" and 609 <= final_at <= 612, final_at
    assert events[2][1]["people"] == 2 and 600 <= events[2][1]["seconds"] <= 602


def test_order_seen_at_mid_stops_follow_up():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600))
    events, now = run(table, [(320, 2)])
    assert checks(events) == [(events[1][0], "mid")], events
    check = events[1][1]
    table.on_order_verdict(check["since"], check["seconds"], "served")
    assert table.live(now)["state"] == "served" and 299 <= table.served_seconds <= 302
    more, now = run(table, [(400, 2)], start=now)
    assert more == [], more  # لا لقطة نهائية ولا تنبيه
    done, _ = run(table, [(40, 0)], start=now)
    assert types(done) == ["table_session"] and done[0][1]["servedSeconds"] == table.served_seconds


def test_late_verdict_marks_table_alert_once():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600))
    events, now = run(table, [(620, 2)])
    mid, final = events[1][1], events[2][1]
    table.on_order_verdict(mid["since"], mid["seconds"], "waiting")
    assert table.live(now)["alert"] is False
    table.on_order_verdict(final["since"], final["seconds"], "late")
    assert table.live(now) == {"state": "waiting", "seconds": table.live(now)["seconds"], "people": 2, "alert": True}
    more, _ = run(table, [(900, 2)], start=now)
    assert more == [], more  # تنبيه واحد فقط مهما طال الجلوس


def test_staff_standing_at_table_does_not_cancel_follow_up():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600))
    # وقوف موظف عند الطاولة لا يعني وصول الطلب — الحكم للقطة
    events, _ = run(table, [(120, 2), (15, 3), (500, 2)])
    assert [stage for _, stage in checks(events)] == ["mid", "final"], events


def test_verdict_for_old_session_is_ignored():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600))
    events, now = run(table, [(320, 2), (60, 0), (40, 2)])
    old = events[1][1]
    table.on_order_verdict(old["since"], old["seconds"], "served")
    assert table.served_seconds is None


def test_customers_leaving_early_get_no_check():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600))
    events, _ = run(table, [(200, 2), (60, 0)])
    assert types(events) == ["table_seated", "table_session"], events
    assert events[1][1]["servedSeconds"] is None


def test_detector_flicker_is_ignored():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600))
    timeline = []
    for _ in range(140):  # عدد يومض 2 ← 3 ← 2 لإطار واحد كل 5 ثوانٍ
        timeline += [(4.5, 2), (0.5, 3)]
    events, _ = run(table, timeline)
    assert types(events) == ["table_seated", "table_order_check", "table_order_check"], events


def test_short_presence_never_becomes_session():
    table = TableTracker(4, "4", TableConfig())
    events, _ = run(table, [(10, 1), (60, 0)])
    assert events == [] and table.state == "empty"


def test_vacate_then_uncleared_check_and_clean_verdict():
    table = TableTracker(4, "4", TableConfig(wait_seconds=600, clear_seconds=60))
    events, now = run(table, [(100, 2), (10, 3), (100, 2), (120, 0)])
    events = after(events)
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
    assert types(events) == ["table_seated", "table_session", "table_session", "table_seated"], events
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
