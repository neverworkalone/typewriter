"""Issue #1809: progress is read from saved chunks/Senses of the batch's own worktree, never estimated."""
import json
import tempfile
import unittest
from pathlib import Path

from tests.fakes import World
from warroom import control, progress
from warroom.views import card_text

S = ".warroom-scratch"


def write(path: Path, text: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8")


def ab_checkpoint(wt: Path, n: int, saved=(), method="b", model="Codex", shard="001", batch="01", sub="b01"):
    chunks = [{"number": i + 1, "file": f"chunk-{i + 1:03d}.jsonl"} for i in range(n)]
    write(wt / S / sub / "checkpoint.json", json.dumps(
        {"contract": "candidate-workbench-v2", "batch": {"shard": shard, "batch": batch, "method": method, "model": model},
         "source": {}, "chunks": chunks}))
    for i in saved:
        write(wt / S / sub / "candidates" / f"chunk-{i:03d}.jsonl", "{}\n")


def sense(**kw):
    return {"sense_id": "s", "submission": None, **kw}


def c_checkpoint(wt: Path, senses_per_record, contract="literary-checkpoint-v3", model="codex", name="c.checkpoint.json"):
    records = [{"record_id": f"r{i}", "senses": s} for i, s in enumerate(senses_per_record)]
    write(wt / S / name, json.dumps({"contract": contract, "batch": {"shard": "001", "batch": "01", "model": model},
                                     "records": records}))


def d_chunk(wt: Path, n: int, rows: int, ids=None, name=None):
    ids = ids or [f"r{n}-{i}" for i in range(rows)]
    write(wt / S / "d-001_01" / (name or f"chunk-{n:03d}.jsonl"),
          "".join(json.dumps({"record_id": i, "senses": []}) + "\n" for i in ids))


class Observe(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.wt = Path(self.tmp.name)
        progress._cache.clear()

    def obs(self, method, model="codex", total=500):
        return progress.observe(self.wt, "001", "01", method, model, total)

    def test_ab_chunks_use_the_real_checkpoint_size(self):
        for n, saved, want in [(20, (), 0), (20, range(1, 8), 7), (20, range(1, 21), 20), (10, (1, 2), 2), (4, (4,), 1)]:
            with self.subTest(n=n, saved=len(list(saved))):
                ab_checkpoint(self.wt, n, saved, sub=f"x{n}{len(list(saved))}")
                self.assertEqual(self.obs("b"), ("chunks", want, n))
                (self.wt / S / "checkpoint.json").unlink(missing_ok=True)
                import shutil
                shutil.rmtree(self.wt / S)

    def test_ab_ignores_other_batch_method_model_and_bad_checkpoints(self):
        ab_checkpoint(self.wt, 20, [1], method="a", sub="a")        # same batch, other method
        ab_checkpoint(self.wt, 20, [1], model="claude", sub="m")    # other model
        ab_checkpoint(self.wt, 20, [1], batch="02", sub="o")        # other batch
        self.assertIsNone(self.obs("b"))
        write(self.wt / S / "bad" / "checkpoint.json", "{not json")
        write(self.wt / S / "old" / "checkpoint.json", json.dumps({"contract": "other", "batch": {}, "chunks": []}))
        self.assertIsNone(self.obs("b"))
        self.assertEqual(self.obs("a", "Codex"), ("chunks", 1, 20))   # model matched case-insensitively

    def test_ab_overwritten_chunk_counts_once_and_missing_file_uncounts(self):
        ab_checkpoint(self.wt, 4, [1, 2])
        d_ = self.wt / S / "b01" / "candidates"
        write(d_ / "chunk-002.jsonl", "{}\n{}\n")
        self.assertEqual(self.obs("b"), ("chunks", 2, 4))
        (d_ / "chunk-001.jsonl").unlink()
        self.assertEqual(self.obs("b"), ("chunks", 1, 4))

    def test_c_counts_senses_by_senseDone_semantics(self):
        done = [sense(submission={"status": "SUBMITTED"}), sense(submission={"status": "ZERO_HITS"}),
                sense(search={"status": "ZERO_HITS"}), sense(search={"status": "COUNTED", "total_hits": 0}),
                sense(search={"status": "SEARCHED"}, contexts=[{"judgment": "REJECTED"}])]
        notdone = [sense(), sense(search={"status": "SEARCH_FAILED"}), sense(search={"status": "UNSEARCHABLE"}),
                   sense(search={"status": "SEARCHED"}, contexts=[{"judgment": "PENDING"}]),
                   sense(search={"status": "COUNTED", "total_hits": 4}),
                   sense(search={"status": "SEARCHED"}, contexts=[{"judgment": "VERIFIED", "sweeps": {}}])]
        for contract in ("literary-checkpoint-v3", "literary-checkpoint-v2"):
            c_checkpoint(self.wt, [done[:2], done[2:] + notdone[:3], notdone[3:]], contract=contract)
            self.assertEqual(self.obs("c"), ("senses", 5, 11))   # a variable Sense total, not 12 per chunk

    def test_c_v2_discovered_needs_both_sweeps_and_reviews(self):
        ctx = lambda res: {"judgment": "VERIFIED", "sweeps": {"1": {"results": {"image": res}}, "2": {"results": {}}}}
        ok = sense(search={"status": "SEARCHED"}, contexts=[ctx(["새  말"])],
                   candidate_reviews=[{"normalized": "새 말", "decision": "KEEP"}])
        open_ = sense(search={"status": "SEARCHED"}, contexts=[ctx(["새 말"])], candidate_reviews=[])
        c_checkpoint(self.wt, [[ok, open_]], contract="literary-checkpoint-v2")
        self.assertEqual(self.obs("c"), ("senses", 1, 2))

    def test_c_rejects_unsupported_other_model_and_garbage(self):
        c_checkpoint(self.wt, [[sense()]], contract="literary-checkpoint-v9", name="a.json")
        c_checkpoint(self.wt, [[sense()]], model="claude", name="b.json")
        write(self.wt / S / "c.json", '{"contract": "literary-checkpoint-v3", "batch": {}, "records": 5}')
        write(self.wt / S / "d.json", "[1,2")
        self.assertIsNone(self.obs("c"))

    def test_c_reparses_when_the_checkpoint_changes(self):
        c_checkpoint(self.wt, [[sense()]])
        self.assertEqual(self.obs("c"), ("senses", 0, 1))
        c_checkpoint(self.wt, [[sense(submission={"status": "SUBMITTED"}), sense()]])
        self.assertEqual(self.obs("c"), ("senses", 1, 2))

    def test_d_counts_only_complete_chunks(self):
        d_chunk(self.wt, 1, 25)
        d_chunk(self.wt, 2, 24)                                   # incomplete
        d_chunk(self.wt, 3, 25, ids=["x"] * 25)                   # duplicate ids
        d_chunk(self.wt, 4, 25, name="chunk-004.jsonl.tmp")       # not yet renamed
        d_chunk(self.wt, 21, 25)                                  # outside 1..20
        write(self.wt / S / "d-001_01" / "chunk-005.jsonl", '{"record_id": "a", "senses": []}\n{broken')
        self.assertEqual(self.obs("d"), ("chunks", 1, 20))
        self.assertIsNone(self.obs("d", total=None))              # no known record total: unconfirmed

    def test_d_short_last_chunk_and_no_marker(self):
        self.assertIsNone(self.obs("d"))                          # legacy run without the marker folder
        d_chunk(self.wt, 4, 8)                                    # 83 records -> chunks of 25,25,25,8
        d_chunk(self.wt, 3, 8)                                    # wrong size for a full chunk
        self.assertEqual(self.obs("d", total=83), ("chunks", 1, 4))

    def test_other_methods_are_not_observed(self):
        self.assertIsNone(self.obs("s2"))
        self.assertIsNone(self.obs("m"))


class Supervisor(unittest.TestCase):
    def setUp(self):
        progress._cache.clear()
        self.w = World()
        self.wt = Path(self.w.tmp.name) / "wt"
        self.wt.mkdir()
        self.bid = self.w.store.create_batch(method="b", producer="free", shard="001", batch="01", branch="x",
                                             worktree=str(self.wt), model_tier="free", records_total=500)

    def record(self):
        b = self.w.store.batch(self.bid)
        self.w.sup._record_progress(b)
        return self.w.store.batch(self.bid)

    def test_midway_progress_then_final_file_takes_over_then_clear_on_loss(self):
        self.assertIsNone(self.record()["progress_kind"])
        ab_checkpoint(self.wt, 20, range(1, 8), model="free", sub="w")
        b = self.record()
        self.assertEqual((b["progress_kind"], b["progress_done"], b["progress_total"], b["records_done"]),
                         ("chunks", 7, 20, None))
        st = control.line_status(self.w.store, "free", "b")
        self.assertEqual(st["progress"], "7/20 chunks")
        lines = card_text(st).split("\n")
        self.assertEqual(len(lines), 4)
        self.assertIn("7 / 20 chunks", lines[1])
        self.assertIn("35.0%", lines[1])
        self.assertEqual(st["state"], b["state"])                      # a full bar never changes the batch state
        write(self.wt / "data/relation-candidates/001/001_01_b_free.jsonl", "{}\n" * 500)
        b = self.record()
        self.assertEqual((b["progress_kind"], b["records_done"]), (None, 500))
        self.assertIn("500 / 500 records", card_text(control.line_status(self.w.store, "free", "b")))

    def test_corrupt_or_deleted_checkpoint_falls_back_to_unconfirmed(self):
        ab_checkpoint(self.wt, 20, [1], model="free")
        self.assertEqual(self.record()["progress_done"], 1)
        write(self.wt / S / "b01" / "checkpoint.json", "{half")
        b = self.record()
        self.assertIsNone(b["progress_kind"])
        self.assertIn("진행량 확인 중", card_text(control.line_status(self.w.store, "free", "b")))

    def test_legacy_records_row_still_renders_records(self):
        self.w.store.update(self.bid, records_done=127)
        self.assertIn("127 / 500 records", card_text(control.line_status(self.w.store, "free", "b")))
