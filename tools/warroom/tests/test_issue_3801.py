"""Issue #3801: keep per-connection work small without weakening SQLite startup."""
from __future__ import annotations

import multiprocessing
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from warroom import store as store_module
from warroom.store import Store


def _initialize_store(db_path: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    Store(Path(db_path)).set(f"worker-{index}", "ready")


class StoreWalInitialization(unittest.TestCase):
    def test_wal_is_set_once_per_store_initialization(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "warroom.sqlite"
            statements = []
            original_connect = sqlite3.connect

            class CountingConnection(sqlite3.Connection):
                def execute(self, sql, parameters=(), /):
                    if sql.strip().lower().startswith("pragma journal_mode"):
                        statements.append(sql)
                    return super().execute(sql, parameters)

            def connect(*args, **kwargs):
                kwargs["factory"] = CountingConnection
                return original_connect(*args, **kwargs)

            with mock.patch.object(store_module.sqlite3, "connect", side_effect=connect):
                store = Store(db)
                store.set("first", "value")
                self.assertEqual(store.get("first"), "value")
                Store(db).set("second", "value")

            self.assertEqual(len(statements), 2)
            with sqlite3.connect(db) as conn:
                self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")

    def test_sixteen_processes_can_open_and_initialize_the_same_database(self):
        with tempfile.TemporaryDirectory() as td:
            db = str(Path(td) / "warroom.sqlite")
            ctx = multiprocessing.get_context("spawn")
            barrier = ctx.Barrier(16)
            processes = [ctx.Process(target=_initialize_store, args=(db, i, barrier)) for i in range(16)]
            try:
                for process in processes:
                    process.start()
                for process in processes:
                    process.join(60)
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


if __name__ == "__main__":
    unittest.main()
