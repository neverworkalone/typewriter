"""Issue #3801: serialize shared database migration during concurrent startup."""
from __future__ import annotations

import multiprocessing
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from warroom import store as store_module
from warroom.store import Store


def _initialize_store(db_path: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    Store(Path(db_path)).set(f"worker-{index}", "ready")


def _crash_during_store_migration(db_path: str) -> None:
    def crash(conn) -> None:
        conn.executescript("BEGIN IMMEDIATE;\n" + store_module.SCHEMA_V2)
        conn.execute("ALTER TABLE events ADD COLUMN line TEXT")
        os._exit(73)

    store_module.Store._migrate = staticmethod(crash)
    Store(Path(db_path))


class StoreMigrationConcurrency(unittest.TestCase):
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

                reopened = Store(Path(db))
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

            reopened = Store(Path(db))
            self.assertIsNone(reopened.get("missing"))
            conn = sqlite3.connect(db)
            try:
                self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], store_module.SCHEMA_VERSION)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
