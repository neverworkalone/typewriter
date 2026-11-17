"""Issue #7494: a C continuation must not find the previous session's consumed submit file at the official path."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from warroom import cparallel, literary


class StaleSubmitRetired(unittest.TestCase):
    def test_previous_submit_and_diag_are_moved_aside_for_every_chunk(self):
        b = {"shard": "240", "batch": "02", "producer": "codex"}
        with tempfile.TemporaryDirectory() as tmp:
            wt = Path(tmp)
            scratch = wt / literary.SCRATCH
            scratch.mkdir()
            submit = scratch / "c-chunk-016.submit.json"
            diag = scratch / "c-chunk-016.submit.json.diag.json"
            other = scratch / "c-chunk-017.submit.json"
            for path in (submit, diag, other):
                path.write_text("old", "utf-8")
            cparallel._retire_stale_submit(wt, b, 16)
            self.assertFalse(submit.exists())
            self.assertFalse(diag.exists())
            self.assertEqual((scratch / "c-chunk-016.submit.json.prev").read_text("utf-8"), "old")
            self.assertTrue(other.exists())
            cparallel._retire_stale_submit(wt, b, 16)   # nothing to retire is not an error


if __name__ == "__main__":
    unittest.main()
