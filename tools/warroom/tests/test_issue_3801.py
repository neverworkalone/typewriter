"""Issue #3801: keep one idle WAL anchor in each test World only."""
from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from tests import fakes
from tests.fakes import World


class TestWorldAnchor(unittest.TestCase):
    def test_anchor_stays_idle_and_cleanup_closes_it_before_removal(self):
        world = World()
        db = world.paths.db
        self.assertEqual(len(world.tmp.anchors), 1)
        anchor = world.tmp.anchors[0]
        self.assertFalse(anchor.in_transaction)
        world.store.set("first", "value")
        self.assertEqual(world.store.get("first"), "value")
        self.assertFalse(anchor.in_transaction)

        world.tmp.cleanup()
        self.assertEqual(world.tmp.anchors, [])
        self.assertFalse(db.exists())
        with self.assertRaises(sqlite3.ProgrammingError):
            anchor.execute("SELECT 1")

    def test_anchors_are_per_world(self):
        first, second = World(), World()
        first_anchor, second_anchor = first.tmp.anchors[0], second.tmp.anchors[0]
        try:
            self.assertIsNot(first_anchor, second_anchor)
            self.assertNotEqual(first.paths.db, second.paths.db)
            self.assertNotEqual(first.paths.worktrees, second.paths.worktrees)
            self.assertFalse(first_anchor.in_transaction)
            first.tmp.cleanup()
            self.assertFalse(second_anchor.in_transaction)
            with self.assertRaises(sqlite3.ProgrammingError):
                first_anchor.execute("SELECT 1")
        finally:
            first.tmp.cleanup()
            second.tmp.cleanup()

    def test_non_wal_anchor_fails_closed_and_cleans_up(self):
        class ModeCursor:
            @staticmethod
            def fetchone():
                return ("delete",)

        class NonWalConnection(sqlite3.Connection):
            def execute(self, sql, parameters=()):
                if sql.strip().lower() == "pragma journal_mode":
                    return ModeCursor()
                return super().execute(sql, parameters)

        anchors, temporary_dirs = [], []
        original_connect = sqlite3.connect
        original_temporary_directory = fakes._WorldTmp

        def connect(*args, **kwargs):
            if kwargs.get("check_same_thread") is False:
                kwargs["factory"] = NonWalConnection
            conn = original_connect(*args, **kwargs)
            if kwargs.get("check_same_thread") is False:
                anchors.append(conn)
            return conn

        def temporary_directory():
            tmp = original_temporary_directory()
            temporary_dirs.append(tmp)
            return tmp

        with mock.patch.object(fakes, "_WorldTemporaryDirectory", side_effect=temporary_directory), \
             mock.patch.object(fakes.sqlite3, "connect", side_effect=connect):
            with self.assertRaisesRegex(sqlite3.OperationalError, "not in WAL mode"):
                World()

        self.assertEqual(len(anchors), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            anchors[0].execute("SELECT 1")
        self.assertEqual(len(temporary_dirs), 1)
        self.assertFalse(Path(temporary_dirs[0].name).exists())


if __name__ == "__main__":
    unittest.main()
