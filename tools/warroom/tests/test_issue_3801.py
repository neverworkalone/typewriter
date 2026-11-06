"""Issue #3801: validate Store WAL anchors and concurrent initialization."""
from __future__ import annotations

import multiprocessing
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import World
from warroom import store as store_module
from warroom.store import Store


def _initialize_store(db_path: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    with Store(Path(db_path)) as store:
        store.set(f"worker-{index}", "ready")


def _crash_during_store_migration(db_path: str) -> None:
    def crash(conn) -> None:
        conn.executescript(store_module.SCHEMA_V2)
        conn.execute("ALTER TABLE events ADD COLUMN line TEXT")
        os._exit(73)

    store_module.Store._migrate = staticmethod(crash)
    Store(Path(db_path))


class StoreWalAnchor(unittest.TestCase):
    def test_anchor_stays_idle_and_close_is_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "warroom.sqlite"
            store = Store(db)
            anchor = store._anchor
            self.assertFalse(anchor.in_transaction)
            store.set("first", "value")
            self.assertEqual(store.get("first"), "value")
            self.assertFalse(anchor.in_transaction)

            store.close()
            store.close()
            with self.assertRaises(RuntimeError):
                store.get("first")
            with self.assertRaises(sqlite3.ProgrammingError):
                anchor.execute("SELECT 1")

            db.unlink()
            with Store(db) as reopened:
                self.assertIsNone(reopened.get("first"))

    def test_non_wal_anchor_result_fails_closed_and_closes_connection(self):
        class ModeCursor:
            @staticmethod
            def fetchone():
                return ("delete",)

        class NonWalConnection(sqlite3.Connection):
            def execute(self, sql, parameters=(), /):
                if sql.strip().lower() == "pragma journal_mode":
                    return ModeCursor()
                return super().execute(sql, parameters)

        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "warroom.sqlite"
            anchors = []
            original_connect = sqlite3.connect

            def connect(*args, **kwargs):
                if kwargs.get("check_same_thread") is False:
                    kwargs["factory"] = NonWalConnection
                conn = original_connect(*args, **kwargs)
                if kwargs.get("check_same_thread") is False:
                    anchors.append(conn)
                return conn

            with mock.patch.object(store_module.sqlite3, "connect", side_effect=connect):
                with self.assertRaisesRegex(sqlite3.OperationalError, "not in WAL mode"):
                    Store(db)
            self.assertEqual(len(anchors), 1)
            with self.assertRaises(sqlite3.ProgrammingError):
                anchors[0].execute("SELECT 1")

            with Store(db) as reopened:
                self.assertIsNone(reopened.get("missing"))

    def test_world_temp_cleanup_closes_store_before_removal(self):
        world = World()
        db = world.paths.db
        world.tmp.cleanup()
        self.assertTrue(world.store._closed)
        self.assertFalse(db.exists())
        with self.assertRaises(RuntimeError):
            world.store.get("after-cleanup")


class StoreInitializationConcurrency(unittest.TestCase):
    def test_sixteen_processes_can_open_and_initialize_the_same_database(self):
        with tempfile.TemporaryDirectory() as td:
            db = str(Path(td) / "warroom.sqlite")
            ctx = multiprocessing.get_context("spawn")
            barrier = ctx.Barrier(16)
            processes = [ctx.Process(target=_initialize_store, args=(db, i, barrier)) for i in range(16)]
            try:
                for process in processes:
                    process.start()
                deadline = time.monotonic() + 60
                for process in processes:
                    process.join(max(0, deadline - time.monotonic()))
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                        process.join(5)
                self.assertFalse(any(process.is_alive() for process in processes), "Store initialization timed out")
                self.assertEqual([process.exitcode for process in processes], [0] * 16)

                with Store(Path(db)) as reopened:
                    for i in range(16):
                        self.assertEqual(reopened.get(f"worker-{i}"), "ready")
            finally:
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                        process.join(5)

    def test_store_recovers_after_process_dies_during_migration(self):
        with tempfile.TemporaryDirectory() as td:
            db = str(Path(td) / "warroom.sqlite")
            ctx = multiprocessing.get_context("spawn")
            process = ctx.Process(target=_crash_during_store_migration, args=(db,))
            process.start()
            process.join(30)
            if process.is_alive():
                process.terminate()
                process.join(5)
            self.assertEqual(process.exitcode, 73)

            with Store(Path(db)) as reopened:
                self.assertIsNone(reopened.get("missing"))
            conn = sqlite3.connect(db)
            try:
                self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], store_module.SCHEMA_VERSION)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
