"""Synthetic corpus morphology integration and crash regressions; stdlib only."""
from collections import Counter, defaultdict
from contextlib import closing
import json
import io
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import corpus_morphology as m


class Analyzer:
    def tokenize(self, text):
        tokens = []
        position = 0
        for word in text.split():
            start = text.index(word, position)
            position = start + len(word)
            form, tag, length = {"밝아": ("밝", "VA", 1), "밝게": ("밝", "VV", 1),
                                 "뛰어": ("뛰", "VV", 1), "가": ("가", "NNG", 1),
                                 "는": ("는", "JX", 1)}.get(word, (word.strip(".,"), "NNG", len(word.strip(".,"))))
            tokens.append(SimpleNamespace(form=form, tag=tag, start=start + int(word.startswith(".")),
                                          len=length, oov=form == "흐름"))
        return tokens


def fixture(path):
    db = sqlite3.connect(path)
    # Same identities, constraints and metadata shape as the real reference index.
    db.executescript("""
      CREATE TABLE source_files(source_path TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, source_metadata_json TEXT NOT NULL);
      CREATE TABLE documents(document_rowid INTEGER PRIMARY KEY,source_path TEXT REFERENCES source_files(source_path),
                             document_id TEXT,document_ordinal INTEGER,UNIQUE(source_path,document_ordinal));
      CREATE TABLE paragraphs(paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER REFERENCES documents(document_rowid),
                              paragraph_id TEXT,ordinal INTEGER CHECK(ordinal>=0),form TEXT,UNIQUE(document_rowid,ordinal));
      CREATE TABLE index_metadata(key TEXT PRIMARY KEY,value TEXT);
    """)
    db.executemany("INSERT INTO source_files VALUES (?,?,?)", [("a", "a" * 64, '{}'), ("b", "b" * 64, '{}')])
    lengths = [1, 3, 21, 23, 41]
    texts = ["나무 나무 흐름 는 가", "밝아 .나무,", "밝게 뛰어", "흐름 밝아 나무"]
    for doc, length in enumerate(lengths, 1):
        db.execute("INSERT INTO documents VALUES (?,?,?,?)", (doc, "a" if doc <= 3 else "b", f"d{doc}", doc))
        for ordinal in range(length):
            db.execute("INSERT INTO paragraphs(document_rowid,paragraph_id,ordinal,form) VALUES (?,?,?,?)",
                       (doc, f"p{doc}-{ordinal}", ordinal, texts[(doc + ordinal) % len(texts)]))
    metadata = {"schema_version": "1", "source_count": "2", "document_count": "5", "paragraph_count": "89",
                "input_manifest_sha256": "c" * 64, "logical_rows_sha256": "d" * 64, "sqlite_version": sqlite3.sqlite_version}
    db.executemany("INSERT INTO index_metadata VALUES (?,?)", metadata.items())
    db.commit()
    db.close()


def union_oracle(index, residues=range(20)):
    # Independent one-pass union accounting. No production views or chunk merge code.
    values = defaultdict(lambda: {"tokens": 0, "oov": 0, "paragraphs": set(), "docs": set(), "sources": Counter()})
    token_count = accepted = paragraph_count = 0
    with closing(sqlite3.connect(index)) as db:
        for paragraph, doc, ordinal, text, source in db.execute("""SELECT p.paragraph_rowid,p.document_rowid,p.ordinal,p.form,d.source_path
                 FROM paragraphs p JOIN documents d ON p.document_rowid=d.document_rowid ORDER BY p.paragraph_rowid"""):
            if ordinal % 20 not in residues:
                continue
            paragraph_count += 1
            for token in Analyzer().tokenize(text):
                token_count += 1
                candidate = m.candidate_from_token(token, text)
                if candidate is None:
                    continue
                lemma, pos, tag, eojeol, surface, oov = candidate
                accepted += 1
                for key in ((0, lemma, pos, ""), (1, lemma, pos, surface), (2, lemma, pos, eojeol)):
                    v = values[key]
                    v["tokens"] += 1
                    v["oov"] += int(oov)
                    v["paragraphs"].add(paragraph)
                    v["docs"].add(doc)
                    v["sources"][source] += 1
    rows = sorted((*key, v["tokens"], v["oov"], len(v["paragraphs"]), len(v["docs"]),
                   len(v["sources"]), max(v["sources"].values())) for key, v in values.items())
    return rows, paragraph_count, token_count, accepted


class MorphologyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {"TYPEWRITER_CACHE_ROOT": str(self.root)})
        self.environment.start()
        self.stderr = patch.object(sys, "stderr", io.StringIO())
        self.stderr.start()
        (self.root / "indexes").mkdir()
        self.index = self.root / "indexes/tiny.sqlite"
        fixture(self.index)
        self.store = self.root / "runs/analysis"
        self.options = {"index_path": self.index, "directory": self.store, "analyzer": Analyzer(),
                        "runtime": {"synthetic": "deterministic-v1"}, "checkpoint": 2}

    def tearDown(self):
        self.environment.stop()
        self.stderr.stop()
        self.temp.cleanup()

    def run_store(self, **kwargs):
        return m.run(**(self.options | kwargs))

    def inspect(self):
        return m.inspect(index_path=self.index, directory=self.store, runtime=self.options["runtime"])

    def assert_union(self, residues):
        expected, paragraphs, tokens, accepted = union_oracle(self.index, residues)
        with closing(m.connect(self.store / "analysis.sqlite", readonly=True)) as db:
            actual = db.execute("SELECT * FROM morphology_totals ORDER BY kind,lemma,pos,form").fetchall()
            self.assertEqual(actual, expected)
            surfaces = Counter(row[3] for row in expected if row[0] == 1)
            self.assertEqual(db.execute("SELECT * FROM surface_interpretations ORDER BY form").fetchall(), sorted(surfaces.items()))
            pos_counts = Counter(row[1] for row in expected if row[0] == 0)
            for row in db.execute("SELECT * FROM lemma_statistics"):
                self.assertEqual(row[-2], pos_counts[row[1]])
                ambiguous = sum(1 for s in expected if s[0] == 1 and s[1:3] == row[1:3] and surfaces[s[3]] > 1)
                self.assertEqual(row[-1], ambiguous)
        status = self.inspect()
        self.assertEqual(status["verified_paragraphs"], paragraphs)
        self.assertEqual(sum(s["token_count"] for s in status["slices"] if s["complete"]), tokens)
        self.assertEqual(sum(s["accepted_morphemes"] for s in status["slices"] if s["complete"]), accepted)

    def test_partition_preserves_pilot_and_full_union_is_exact_idempotent(self):
        result = self.run_store()
        self.assertEqual(result["completion_bitmap"], "1" + "0" * 19)
        self.assert_union([0])
        with closing(m.connect(self.store / "analysis.sqlite")) as store, closing(sqlite3.connect(self.index)) as index:
            routes = store.execute("SELECT paragraph,slice FROM route ORDER BY paragraph").fetchall()
            expected = index.execute("SELECT paragraph_rowid,ordinal % 20 FROM paragraphs ORDER BY paragraph_rowid").fetchall()
            self.assertEqual(routes, expected)
            self.assertEqual([p for p, s in routes if s == 0], [p for p, s in expected if s == 0])
            plan = store.execute("EXPLAIN QUERY PLAN SELECT paragraph FROM route WHERE slice=1 AND paragraph>0 ORDER BY paragraph LIMIT 2").fetchall()
            self.assertTrue(any("route_slice" in row[-1] for row in plan))
        result = self.run_store(max_slices=20)
        self.assertEqual(result["coverage_percent"], 100)
        self.assertEqual(result["completion_bitmap"], "1" * 20)
        self.assert_union(range(20))
        before = m.file_digest(self.store / "analysis.sqlite")
        self.run_store(max_slices=20)
        self.assertEqual(m.file_digest(self.store / "analysis.sqlite"), before)
        self.assertEqual(self.inspect()["current_slice"], None)
        self.assertEqual(sum(s["new_unique_lemmas"] for s in result["slices"]), result["cumulative_unique_lemmas"])
        self.assertEqual(sum(s["percent_of_index"] for s in result["slices"]), 100)
        self.assertTrue(all(s["elapsed_seconds"] >= 0 for s in result["slices"]))

    def test_safe_identified_legacy_reanalysis_never_sums_aggregates(self):
        legacy = self.root / "runs/pilot/candidate-analysis.sqlite"
        legacy.parent.mkdir(parents=True)
        with closing(sqlite3.connect(legacy)) as db:
            for table in ("candidates", "candidate_surfaces", "candidate_eojeol_forms"):
                db.execute(f"CREATE TABLE {table}(tokens INTEGER)")
                db.execute(f"INSERT INTO {table} VALUES (999999)")
            db.commit()
        before = m.file_digest(legacy)
        with self.assertRaisesRegex(RuntimeError, "reanalyse"):
            self.run_store(legacy_path=legacy)
        result = self.run_store(legacy_path=legacy, reanalyse=True)
        self.assertEqual(result["legacy"]["sha256"], before)
        self.assertEqual(result["legacy"]["imported_rows"], 0)
        self.assertEqual(result["legacy"]["mode"], "identified-slice-zero-reanalysis")
        self.assertEqual(m.file_digest(legacy), before)
        self.assert_union([0])
        self.run_store(max_slices=20)
        self.assert_union(range(20))

    def test_later_slice_updates_ambiguity_and_deduplicates_shared_documents(self):
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("UPDATE paragraphs SET form=CASE WHEN ordinal % 20=0 THEN '밝아' ELSE '밝게' END")
            db.commit()
        self.run_store()
        with closing(m.connect(self.store / "analysis.sqlite", readonly=True)) as db:
            self.assertEqual(db.execute("SELECT pos_interpretation_count,ambiguous_surface_count FROM lemma_statistics").fetchall(), [(1, 0)])
        self.run_store()
        self.assert_union([0, 1])
        with closing(m.connect(self.store / "analysis.sqlite", readonly=True)) as db:
            self.assertEqual(db.execute("SELECT pos_interpretation_count,ambiguous_surface_count FROM lemma_statistics").fetchall(), [(2, 1), (2, 1)])

    def test_empty_residues_complete_without_invented_rows(self):
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("DELETE FROM paragraphs WHERE ordinal>0")
            db.execute("UPDATE index_metadata SET value='5' WHERE key='paragraph_count'")
            db.commit()
        result = self.run_store(max_slices=20)
        self.assertEqual(result["completion_bitmap"], "1" * 20)
        self.assertEqual(result["verified_paragraphs"], 5)
        self.assertTrue(all(s["expected_paragraphs"] == 0 for s in result["slices"][1:]))
        self.assert_union(range(20))

    def test_index_read_lock_prevents_change_between_identity_and_publication(self):
        def attempt_write(event):
            if event == "mid-checkpoint":
                script = "import sqlite3,sys; db=sqlite3.connect(sys.argv[1],timeout=0); db.execute(\"UPDATE paragraphs SET form='changed' WHERE paragraph_rowid=1\"); db.commit()"
                result = subprocess.run([sys.executable, "-c", script, str(self.index)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("locked", result.stderr)
        self.run_store(hook=attempt_write)
        self.assert_union([0])

    def test_interruption_at_transaction_and_publication_boundaries(self):
        for boundary in ("before-initial-publication", "after-initial-publication", "mid-checkpoint",
                         "before-checkpoint-commit", "after-checkpoint-commit", "during-publication", "after-publication"):
            with self.subTest(boundary=boundary):
                self.store = self.root / f"runs/{boundary}"
                self.options["directory"] = self.store
                fired = False
                def interrupt(event):
                    nonlocal fired
                    if event == boundary and not fired:
                        fired = True
                        raise RuntimeError("injected interruption")
                with self.assertRaisesRegex(RuntimeError, "injected"):
                    self.run_store(hook=interrupt)
                if (self.store / "analysis.sqlite").exists():
                    status = self.inspect()
                    self.assertEqual(status["completion_bitmap"], ("1" if boundary == "after-publication" else "0") + "0" * 19)
                    self.assertIsNotNone(status["error"])
                self.run_store(max_slices=20)
                self.assert_union(range(20))
                self.assertIsNone(self.inspect()["error"])

    def test_hard_process_death_rolls_back_without_duplicate_or_lost_verified_results(self):
        self.run_store()  # slice zero is already visible and must survive.
        for boundary in ("mid-checkpoint", "after-checkpoint-commit", "during-publication"):
            script = """
import os,sys
from pathlib import Path
sys.path.insert(0, 'scripts/reference')
import corpus_morphology as m
from importlib.machinery import SourceFileLoader
t = SourceFileLoader('fixture_tests', 'scripts/reference/test-corpus-morphology.py').load_module()
def hook(event):
    if event == sys.argv[3]: os._exit(77)
m.run(index_path=Path(sys.argv[1]), directory=Path(sys.argv[2]), analyzer=t.Analyzer(),
      runtime={'synthetic':'deterministic-v1'},checkpoint=2,hook=hook)
"""
            result = subprocess.run([sys.executable, "-c", script, str(self.index), str(self.store), boundary],
                                    cwd=Path(__file__).parents[2], capture_output=True, text=True)
            self.assertEqual(result.returncode, 77, result.stderr)
            self.assert_union([0])
        self.run_store(max_slices=20)
        self.assert_union(range(20))

    def test_partial_next_slice_never_changes_cumulative_views(self):
        self.run_store()
        def fail(event):
            if event == "after-checkpoint-commit":
                raise RuntimeError("interrupted next slice")
        with self.assertRaises(RuntimeError):
            self.run_store(hook=fail)
        self.assert_union([0])
        self.assertGreater(self.inspect()["slices"][1]["processed_paragraphs"], 0)
        self.run_store(max_slices=20)
        self.assert_union(range(20))

    def test_corrupted_checkpoint_manifest_route_and_bitmap_fail_closed(self):
        mutations = ["UPDATE facts SET tokens=tokens+1 WHERE slice=0",
                     "UPDATE chunks SET last_row=last_row+1 WHERE slice=0 AND chunk=0",
                     "UPDATE chunks SET sha256='bad' WHERE slice=0",
                     "UPDATE slices SET complete=1 WHERE slice=1",
                     "UPDATE slices SET new_lemmas=999 WHERE slice=0",
                     "UPDATE route SET slice=1 WHERE paragraph=1",
                     "UPDATE manifest SET sha256='bad'",
                     "DROP VIEW completed_facts"]
        for n, sql in enumerate(mutations):
            with self.subTest(sql=sql):
                self.store = self.root / f"runs/corruption-{n}"
                self.options["directory"] = self.store
                self.run_store()
                with closing(sqlite3.connect(self.store / "analysis.sqlite")) as db:
                    db.execute(sql)
                    db.commit()
                before = m.file_digest(self.store / "analysis.sqlite")
                with self.assertRaises(RuntimeError):
                    self.run_store()
                self.assertEqual(m.file_digest(self.store / "analysis.sqlite"), before)

    def test_modified_index_runtime_permission_or_algorithm_cannot_advance(self):
        self.run_store()
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.run_store(runtime={"synthetic": "changed-version"})
        with patch.object(m, "read_permission_record", return_value="bad"):
            with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                self.run_store()
        original = m.file_digest
        with patch.object(m, "file_digest", wraps=m.file_digest) as hashed:
            hashed.side_effect = lambda p: "bad" if Path(p) == Path(m.__file__) else original(p)
            with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                self.run_store()
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("UPDATE paragraphs SET form='changed' WHERE paragraph_rowid=1")
            db.commit()
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.run_store()
        with closing(sqlite3.connect(self.store / "analysis.sqlite")) as db:
            self.assertEqual(db.execute("SELECT SUM(complete) FROM slices").fetchone()[0], 1)

    def test_missing_rows_metadata_and_bad_database_fail_closed(self):
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("UPDATE index_metadata SET value='90' WHERE key='paragraph_count'")
            db.commit()
        with self.assertRaisesRegex(RuntimeError, "paragraph_count"):
            self.run_store()
        self.index.write_bytes(b"corrupted SQLite")
        with self.assertRaises(sqlite3.DatabaseError):
            self.run_store()

    def test_out_of_space_during_transaction_preserves_previous_publication(self):
        self.run_store()
        def fail(event):
            if event == "mid-checkpoint":
                raise sqlite3.OperationalError("database or disk is full")
        with self.assertRaisesRegex(sqlite3.OperationalError, "full"):
            self.run_store(hook=fail)
        self.assert_union([0])
        with patch.object(m.shutil, "disk_usage", return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(RuntimeError, "free space"):
                self.run_store()
        self.run_store(max_slices=20)
        self.assert_union(range(20))

    def test_single_writer_and_cache_path_boundaries(self):
        with m.writer_lock(self.store):
            with self.assertRaisesRegex(RuntimeError, "already active"):
                self.run_store()
        with self.assertRaisesRegex(ValueError, "inside"):
            self.run_store(directory=self.root / "outside")
        with self.assertRaisesRegex(ValueError, "inside"):
            self.run_store(index_path=self.root / "outside.sqlite")


if __name__ == "__main__":
    unittest.main()
