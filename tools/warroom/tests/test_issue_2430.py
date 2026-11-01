"""#2430: durable one-shot Drain schedules and Supervisor execution."""
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from tests.fakes import World
from warroom import control
from warroom.store import SCHEMA_VERSION, Store


def local_time(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute).timestamp()


class DrainSchedules(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def tearDown(self):
        self.w.tmp.cleanup()

    def add_paused_batch(self, model="deepseek", method="a", batch="01"):
        bid = self.w.store.create_batch(method=method, producer=model, shard="001", batch=batch,
                                        branch=f"{method}-{model}-001-{batch}", worktree="/tmp/worktree")
        self.w.store.update(bid, state="PAUSED")
        return bid

    def test_next_hour_is_local_and_a_reached_hour_means_tomorrow(self):
        cases = [
            (local_time(2026, 10, 30, 0), "00", local_time(2026, 10, 31, 0)),
            (local_time(2026, 10, 30, 0), "23", local_time(2026, 10, 30, 23)),
            (local_time(2026, 10, 30, 22, 59), "23", local_time(2026, 10, 30, 23)),
            (local_time(2026, 10, 30, 23), "23", local_time(2026, 10, 31, 23)),
            (local_time(2026, 10, 30, 0, 1), "00", local_time(2026, 10, 31, 0)),
        ]
        for now, hour, expected in cases:
            with self.subTest(now=now, hour=hour):
                self.assertEqual(control.next_drain_due(hour, now), expected)
        for invalid in ("24", "-1", "12:00", True):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                control.next_drain_due(invalid, 0)

    def test_schedule_is_persistent_and_cancel_does_not_change_drain(self):
        store, now = self.w.store, self.w.now
        ok, msg = control.schedule_drain_all(store, "23", now)
        self.assertTrue(ok, msg)
        scheduled = Store(self.w.paths.db).drain_schedule("all")
        self.assertIsNotNone(scheduled)
        self.assertEqual(scheduled["due_at"], control.next_drain_due("23", now))
        self.assertEqual(store.peek_line("deepseek", "a")["drain"], 0)
        self.assertTrue(control.cancel_drain_schedule(store, "all"))
        self.assertIsNone(Store(self.w.paths.db).drain_schedule("all"))
        self.assertEqual(store.peek_line("deepseek", "a")["drain"], 0)

    def test_supervisor_fires_board_and_batch_reservations_once(self):
        w = self.w
        batch_id = self.add_paused_batch()
        ok, msg = control.schedule_batch_drain(w.store, "deepseek", "a", batch_id, "23", w.now)
        self.assertTrue(ok, msg)
        ok, msg = control.schedule_drain_all(w.store, "23", w.now)
        self.assertTrue(ok, msg)
        due = w.store.drain_schedule("all")["due_at"]
        w.store.complete_batch(batch_id)  # target selection happens when Drain All fires
        next_batch_id = self.add_paused_batch(method="b")
        self.assertNotEqual(batch_id, next_batch_id)
        w.store.set_line("deepseek", "c", run=1)  # an empty pending Start is canceled without a Drain
        w.now = due
        w.sup = w.make_sup()  # reservations survive a Supervisor restart
        w.tick()
        keys = control.board_line_keys(w.store, w.cfg)
        self.assertIn(("deepseek", "a"), keys)
        self.assertEqual(w.store.peek_line("deepseek", "a")["drain"], 0)  # completed before firing
        self.assertEqual(w.store.peek_line("deepseek", "b")["drain"], 1)  # started after scheduling
        self.assertEqual((w.store.peek_line("deepseek", "c")["run"],
                          w.store.peek_line("deepseek", "c")["drain"]), (0, 0))
        self.assertTrue(all(w.store.peek_line(model, method)["drain"] == (method == "b")
                            for model, method in keys))
        self.assertEqual(w.store.peek_line("deepseek", "m")["drain"], 0)
        self.assertIsNone(w.store.drain_schedule("all"))
        self.assertIsNone(w.store.drain_schedule(f"batch:{batch_id}"))
        w.tick()
        events = [event["msg"] for event in w.store.recent_events(100)]
        self.assertEqual(sum("예약 Drain All 발화" in msg for msg in events), 1)
        self.assertTrue(any("예약 Drain All 발화: 1개 미완료 배치 보유 Line Drain ON" == msg for msg in events))
        self.assertEqual(sum("예약 Drain 발화" in msg and f"batch id {batch_id}" in msg for msg in events), 0)
        self.assertEqual(sum("예약 Drain 만료" in msg and f"batch id {batch_id}" in msg for msg in events), 1)

    def test_canceled_future_schedule_never_drains(self):
        w = self.w
        self.assertTrue(control.schedule_drain_all(w.store, "23", w.now)[0])
        due = w.store.drain_schedule("all")["due_at"]
        self.assertTrue(control.cancel_drain_schedule(w.store, "all"))
        w.now = due
        w.tick()
        self.assertEqual(w.store.peek_line("deepseek", "a")["drain"], 0)

    def test_detail_schedule_expires_when_its_batch_is_replaced(self):
        w = self.w
        old_id = self.add_paused_batch()
        ok, msg = control.schedule_batch_drain(w.store, "deepseek", "a", old_id, "23", w.now)
        self.assertTrue(ok, msg)
        due = w.store.drain_schedule(f"batch:{old_id}")["due_at"]
        w.store.complete_batch(old_id)
        new_id = self.add_paused_batch(batch="02")
        self.assertNotEqual(old_id, new_id)
        w.now = due
        w.sup = w.make_sup()
        w.tick()
        self.assertEqual(w.store.peek_line("deepseek", "a")["drain"], 0)
        self.assertIsNone(w.store.drain_schedule(f"batch:{old_id}"))
        messages = [event["msg"] for event in w.store.recent_events(100)]
        self.assertEqual(sum(f"예약 Drain 만료: batch id {old_id}" in msg for msg in messages), 1)

    def test_detail_schedule_requires_current_owned_non_maintainer_batch(self):
        w = self.w
        batch_id = self.add_paused_batch()
        self.assertFalse(control.schedule_batch_drain(w.store, "sonnet", "a", batch_id, "23", w.now)[0])
        self.assertFalse(control.schedule_batch_drain(w.store, "deepseek", "m", batch_id, "23", w.now)[0])
        self.assertFalse(control.schedule_batch_drain(w.store, "deepseek", "a", batch_id + 100, "23", w.now)[0])

    def test_v12_database_migrates_to_schedules_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "warroom.db"
            Store(path)
            with sqlite3.connect(path) as db:
                db.execute("DROP TABLE drain_schedules")
                db.execute("PRAGMA user_version=12")
            migrated = Store(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertIsNotNone(db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='drain_schedules'").fetchone())
            Store(path)  # opening a second time must leave the new table and version alone
