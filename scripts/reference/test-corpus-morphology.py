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
import corpus_morphology_selector as selector
import corpus_morphology_readonly as readonly


class Analyzer:
    def tokenize(self, text):
        tokens = []
        position = 0
        for word in text.split():
            start = text.index(word, position)
            position = start + len(word)
            form, tag, length = {"밝아": ("밝", "VA", 1), "밝게": ("밝", "VV", 1),
                                 "뛰어": ("뛰", "VV", 1), "가": ("가", "NNG", 1),
                                 "는": ("는", "JX", 1), "오류": ("오류", "NNG", 0)}.get(word, (word.strip(".,"), "NNG", len(word.strip(".,"))))
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
    texts = ["나무 나무 흐름 는 가 오류", "밝아 .나무,", "밝게 뛰어", "흐름 밝아 나무"]
    for doc, length in enumerate(lengths, 1):
        db.execute("INSERT INTO documents VALUES (?,?,?,?)", (doc, "a" if doc <= 3 else "b", f"d{doc}", doc))
        for ordinal in range(length):
            form = "후속어" if ordinal == 19 else texts[(doc + ordinal) % len(texts)]
            db.execute("INSERT INTO paragraphs(document_rowid,paragraph_id,ordinal,form) VALUES (?,?,?,?)",
                       (doc, f"p{doc}-{ordinal}", ordinal, form))
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
        self.last_summary = m.run_next(**(self.options | kwargs))
        return self.inspect()

    def finish(self):
        for _ in range(20):
            result = self.run_store()
            if result["current_slice"] is None:
                return result
        self.fail("20 separate invocations did not finish the 20-slice corpus")

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
        for slice_id in range(1, 20):
            result = self.run_store()
            self.assertEqual(self.last_summary["completed_slice"], slice_id)
            self.assertEqual(result["completion_bitmap"], "1" * (slice_id + 1) + "0" * (19 - slice_id))
            if slice_id < 19:
                self.assertEqual(result["slices"][slice_id + 1]["processed_paragraphs"], 0)
        self.assertEqual(result["coverage_percent"], 100)
        self.assertEqual(result["completion_bitmap"], "1" * 20)
        self.assert_union(range(20))
        before = m.file_digest(self.store / "analysis.sqlite")
        self.run_store()
        self.assertEqual(self.last_summary["result"], "no-op")
        self.assertIsNone(self.last_summary["completed_slice"])
        self.assertEqual(m.file_digest(self.store / "analysis.sqlite"), before)
        self.assertEqual(self.inspect()["current_slice"], None)
        self.assertEqual(sum(s["new_unique_lemmas"] for s in result["slices"]), result["cumulative_unique_lemmas"])
        self.assertGreater(sum(s["rejected_lemma_shapes"] for s in result["slices"]), 0)
        self.assertGreater(sum(s["rejected_spans"] for s in result["slices"]), 0)
        self.assertEqual(sum(s["percent_of_index"] for s in result["slices"]), 100)
        self.assertTrue(all(s["elapsed_seconds"] >= 0 for s in result["slices"]))

    def test_readonly_selector_projection_matches_the_full_union_and_keeps_late_slice_lemmas(self):
        result = self.finish()
        oracle, _, _, _ = union_oracle(self.index)
        expected_lemmas = len({row[1] for row in oracle if row[0] == 0})
        self.assertIn("후속어", {row[1] for row in oracle if row[0] == 0})
        self.assertFalse(any(row[1] == "후속어" for row in union_oracle(self.index, [*range(19)])[0]))

        database_path = self.store / "analysis.sqlite"
        database_digest = m.file_digest(database_path)
        seal_bytes = (self.store / "seal.json").read_bytes()
        verification_temp = self.root / "runs/readonly-verification-temp"
        verification_temp.mkdir(parents=True)
        audited = readonly.inspect_readonly(
            index_path=self.index,
            directory=self.store,
            runtime=self.options["runtime"],
            temporary_directory=verification_temp,
        )
        self.assertEqual(audited["validation"], "full-audit-passed-read-only")
        self.assertEqual(m.file_digest(database_path), database_digest)
        self.assertEqual((self.store / "seal.json").read_bytes(), seal_bytes)
        seal = json.loads(seal_bytes)
        proof = selector.snapshot_payload(result=audited, store_path=self.store, seal=seal)
        selector.assert_source_binding_current(store_path=self.store, index_path=self.index, proof=proof)
        with self.assertRaisesRegex(RuntimeError, "seal changed after completed-store validation"):
            selector.assert_source_binding_current(store_path=self.store, index_path=self.index,
                                                   proof={**proof, "store_seal_sha256": "0" * 64})

        projection_path = self.root / "runs/projection/selection.sqlite"
        projection_path.parent.mkdir(parents=True)
        source_queries = []
        with closing(m.connect(database_path, readonly=True)) as source:
            legacy_plan = source.execute("""
                EXPLAIN QUERY PLAN
                SELECT lemma,pos,pos_interpretation_count,ambiguous_surface_count
                FROM lemma_statistics WHERE kind=0
                ORDER BY lemma COLLATE BINARY,pos COLLATE BINARY
            """).fetchall()
            self.assertTrue(any("CORRELATED SCALAR SUBQUERY" in row[-1] for row in legacy_plan))
            for query in (selector.PROJECTION_SURFACE_AMBIGUITY_SQL,
                          selector.PROJECTION_MORPHOLOGY_TOTALS_SQL):
                plan = source.execute("EXPLAIN QUERY PLAN " + query).fetchall()
                self.assertFalse(any("CORRELATED SCALAR SUBQUERY" in row[-1] for row in plan))
            surface_plan = source.execute(
                "EXPLAIN QUERY PLAN " + selector.PROJECTION_SURFACE_AMBIGUITY_SQL
            ).fetchall()
            self.assertTrue(any("facts_form" in row[-1] for row in surface_plan))
            self.assertFalse(any("USE TEMP B-TREE" in row[-1] for row in surface_plan))

        open_readonly_database = selector.producer.open_readonly_database
        def trace_source_queries(path, *args, **kwargs):
            db = open_readonly_database(path, *args, **kwargs)
            if Path(path).resolve() == database_path.resolve():
                db.set_trace_callback(source_queries.append)
            return db
        with patch.object(selector.producer, "open_readonly_database", side_effect=trace_source_queries):
            counts = selector.build_projection(
                source_path=database_path,
                projection_path=projection_path,
                temporary_directory=projection_path.parent,
                source_snapshot="a" * 64,
                expected_lemmas=expected_lemmas,
            )
        normalized_queries = [" ".join(query.upper().split()) for query in source_queries]
        self.assertFalse(any("FROM LEMMA_STATISTICS" in query for query in normalized_queries))
        self.assertEqual(sum("FROM MORPHOLOGY_TOTALS" in query for query in normalized_queries), 1)
        self.assertEqual(sum(
            "SELECT DISTINCT FORM,LEMMA,POS FROM FACTS" in query
            and "SLICE IN (SELECT SLICE FROM SLICES WHERE COMPLETE=1)" in query
            for query in normalized_queries
        ), 1)
        self.assertEqual(counts["candidate_lemmas"], expected_lemmas)

        surface_interpretations = Counter(row[3] for row in oracle if row[0] == 1)
        expected_ambiguous_surface_counts = Counter(
            (row[1], row[2]) for row in oracle
            if row[0] == 1 and surface_interpretations[row[3]] > 1
        )
        expected_candidates = {
            (row[1], row[2]): (*row[4:10], expected_ambiguous_surface_counts[(row[1], row[2])])
            for row in oracle if row[0] == 0
        }
        self.assertGreater(sum(expected_ambiguous_surface_counts.values()), 0)
        expected_surfaces = sorted(
            (row[1], row[2], row[3], row[4], row[6], row[7], row[8], row[9],
             surface_interpretations[row[3]])
            for row in oracle if row[0] == 1
        )
        expected_eojeols = sorted(
            (row[1], row[2], row[3], row[4], row[6], row[7], row[8], row[9])
            for row in oracle if row[0] == 2
        )
        with closing(selector.producer.open_readonly_database(projection_path)) as projection:
            actual_candidates = {
                (lemma, pos): (tokens, oov, hits, documents, sources, max_source, ambiguous_surfaces)
                for lemma, pos, tokens, oov, hits, documents, sources, max_source, ambiguous_surfaces
                in projection.execute("""SELECT lemma,pos,token_count,oov_token_count,paragraph_hits,
                    document_count,source_count,max_source_token_count,ambiguous_surface_count FROM candidates
                    ORDER BY lemma COLLATE BINARY,pos COLLATE BINARY""")
            }
            actual_surfaces = projection.execute("""SELECT lemma,pos,surface,token_count,paragraph_hits,
                document_count,source_count,max_source_token_count,interpretation_count FROM candidate_surfaces
                ORDER BY lemma COLLATE BINARY,pos COLLATE BINARY,surface COLLATE BINARY""").fetchall()
            actual_eojeols = projection.execute("""SELECT lemma,pos,form,token_count,paragraph_hits,
                document_count,source_count,max_source_token_count FROM candidate_eojeol_forms
                ORDER BY lemma COLLATE BINARY,pos COLLATE BINARY,form COLLATE BINARY""").fetchall()
        self.assertEqual(actual_candidates, expected_candidates)
        self.assertEqual(sorted(actual_surfaces), expected_surfaces)
        self.assertEqual(sorted(actual_eojeols), expected_eojeols)

    def test_projection_cache_identity_is_source_snapshot_and_explicit_version(self):
        root = selector.cache_root()
        snapshot = "a" * 64
        current = selector.projection_directory(root, snapshot)
        self.assertEqual(current, root / snapshot / selector.PROJECTION_VERSION)
        with patch.object(selector, "PROJECTION_VERSION", "morphology-selection-v2"):
            next_version = selector.projection_directory(root, snapshot)
        self.assertNotEqual(next_version, current)

    def test_selector_reuses_completed_store_without_full_audit_and_fails_closed_on_real_drift(self):
        runtime = {
            "python": "Python 3.12.0 synthetic-selector-test",
            "packages": {
                "kiwipiepy": {"version": "0.24.0"},
                "kiwipiepy_model": {"version": "0.24.0"},
            },
        }
        self.options["runtime"] = runtime
        completed = self.finish()
        dictionary_path = self.root / "runs/selection/dictionary.sqlite"
        dictionary_path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(dictionary_path)) as dictionary:
            dictionary.executescript("""
                CREATE TABLE records(id TEXT PRIMARY KEY, lemma TEXT NOT NULL);
                CREATE TABLE search_forms(form TEXT NOT NULL, record_id TEXT NOT NULL);
                CREATE TABLE senses(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, pos TEXT NOT NULL);
                CREATE TABLE generated_surface_forms(
                    form TEXT NOT NULL, record_id TEXT NOT NULL, sense_id TEXT NOT NULL, rule_id TEXT NOT NULL
                );
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            dictionary.executemany("INSERT INTO metadata(key,value) VALUES (?,?)", [
                ("dictionary_version", "synthetic"), ("canonical_revision", "synthetic"),
                ("record_count", "0"), ("search_form_count", "0"),
                ("generated_surface_form_count", "0"),
            ])
            dictionary.commit()

        def select(name, expected_snapshot=None):
            return selector.select_from_morphology_store(
                store_path=self.store,
                dictionary_path=dictionary_path,
                index_path=self.index,
                candidate_output_path=self.root / "runs/selection" / f"{name}.json",
                exclusion_manifest_path=None,
                candidate_limit=1,
                include_canonical_lemmas=True,
                expected_source_snapshot=expected_snapshot,
            )

        build_projection = selector.build_projection
        def build_synthetic_projection(**kwargs):
            # The fixture intentionally has only 89 indexed paragraphs, so the
            # production absolute lemma-count assertion does not apply.
            kwargs["expected_lemmas"] = None
            return build_projection(**kwargs)

        with patch("corpus_morphology.runtime_identity", return_value=runtime), \
             patch.object(selector, "EXPECTED_PARAGRAPHS", completed["verified_paragraphs"]), \
             patch.object(selector, "EXPECTED_LEMMAS", completed["cumulative_unique_lemmas"]), \
             patch.object(selector, "build_projection", side_effect=build_synthetic_projection) as projection_builder, \
             patch.object(selector.morphology_readonly, "inspect_readonly", wraps=readonly.inspect_readonly) as audit:
            first = select("first")
            snapshot = first["analysis_cache"]["source_snapshot_sha256"]
            self.assertEqual(first["analysis_cache"]["validation"], "completed-store-reused-v1")
            self.assertEqual(first["analysis_cache"]["store_evidence"]["validation"], "completed-store-reused-v1")
            self.assertEqual(audit.call_count, 0)
            self.assertEqual(projection_builder.call_count, 1)

            projection_path = selector.typewriter_cache_root() / first["analysis_cache"]["selection_projection_path"]
            projection_version_directory = selector.projection_directory(selector.cache_root(), snapshot)
            self.assertEqual(projection_path.parent, projection_version_directory)
            original_inode = projection_path.stat().st_ino

            # Recreate the pre-version manifest layout around this exact DB to
            # exercise the one-time compatibility handoff without copying it.
            legacy_directory = (
                projection_version_directory.parent
                / selector.LEGACY_PROJECTION_BUILDER_SHA256
                / "legacy-producer-directory"
            )
            legacy_directory.parent.mkdir(parents=True)
            os.replace(projection_version_directory, legacy_directory)
            projection_path = legacy_directory / "selection.sqlite"
            legacy_manifest_path = selector.projection_manifest_path(legacy_directory)
            legacy_manifest = selector.load_object(legacy_manifest_path, "Synthetic legacy projection manifest")
            legacy_manifest.pop("manifest_sha256")
            legacy_manifest.pop("projection_version")
            legacy_manifest["algorithm_identity"] = {
                "projection_builder_sha256": selector.LEGACY_PROJECTION_BUILDER_SHA256,
                "candidate_producer_sha256": "ignored",
            }
            legacy_manifest["projection_database_path"] = selector.cache_relative_path(
                legacy_directory / "selection.sqlite", "Legacy morphology selection projection database"
            )
            selector.write_projection_manifest(legacy_manifest_path, legacy_manifest)

            projection_hashes = []
            projection_queries = []
            original_sha256_file = selector.sha256_file
            original_open_readonly = selector.producer.open_readonly_database
            original_apply_product_coverage = selector.producer.apply_product_coverage
            def track_projection_hash(file_path):
                if Path(file_path).resolve() == projection_path.resolve():
                    projection_hashes.append(Path(file_path))
                return original_sha256_file(file_path)
            def trace_projection_open(file_path, *args, **kwargs):
                db = original_open_readonly(file_path, *args, **kwargs)
                if Path(file_path).resolve() == projection_path.resolve():
                    db.set_trace_callback(projection_queries.append)
                return db
            with patch.object(selector, "sha256_file", side_effect=track_projection_hash), \
                 patch.object(selector.producer, "open_readonly_database", side_effect=trace_projection_open), \
                 patch.object(selector.producer, "apply_product_coverage", wraps=original_apply_product_coverage) as coverage:
                refill = select("refill", snapshot)
                self.assertEqual(coverage.call_count, 1)
            self.assertEqual(refill["analysis_cache"]["source_snapshot_sha256"], snapshot)
            self.assertEqual(audit.call_count, 0)
            self.assertEqual(projection_builder.call_count, 1)
            self.assertEqual(projection_hashes, [projection_path])
            self.assertTrue(any("PRAGMA quick_check" in query for query in projection_queries))
            self.assertTrue(any("COUNT(" in query.upper() for query in projection_queries))
            self.assertEqual(projection_path.stat().st_ino, original_inode)

            migrated = selector.read_projection_manifest(projection_version_directory, snapshot)
            self.assertEqual(migrated["projection_version"], selector.PROJECTION_VERSION)
            self.assertEqual(selector.projection_database_path(migrated), projection_path)
            self.assertEqual(
                migrated["projection_database_sha256"], first["analysis_cache"]["selection_projection_sha256"],
            )

            projection_hashes.clear()
            projection_queries.clear()
            with patch.object(selector, "sha256_file", side_effect=track_projection_hash), \
                 patch.object(selector.producer, "open_readonly_database", side_effect=trace_projection_open):
                fast_manifest = selector.verify_projection(
                    directory=projection_version_directory, source_snapshot=snapshot,
                )
                self.assertEqual(fast_manifest["projection_database_stamp"], m.file_stamp(projection_path))
                self.assertEqual(projection_hashes, [])
                self.assertEqual(projection_queries, [])

                # A stamp change uses the existing full verification once, then
                # later reuse returns to the stat-only path.
                unstamped_manifest = dict(fast_manifest)
                unstamped_manifest.pop("manifest_sha256")
                unstamped_manifest.pop("projection_database_stamp")
                selector.write_projection_manifest(
                    selector.projection_manifest_path(projection_version_directory), unstamped_manifest,
                )
                checked_manifest = selector.verify_projection(
                    directory=projection_version_directory, source_snapshot=snapshot,
                )
                self.assertEqual(checked_manifest["projection_database_stamp"], m.file_stamp(projection_path))
                self.assertEqual(len(projection_hashes), 1)
                self.assertTrue(any("PRAGMA quick_check" in query for query in projection_queries))
                self.assertTrue(any("COUNT(" in query.upper() for query in projection_queries))
                projection_hashes.clear()
                projection_queries.clear()
                selector.verify_projection(directory=projection_version_directory, source_snapshot=snapshot)
                self.assertEqual(projection_hashes, [])
                self.assertEqual(projection_queries, [])

            with patch.object(selector, "PROJECTION_VERSION", "morphology-selection-v2"):
                changed_version = select("changed-projection-version", snapshot)
                self.assertEqual(changed_version["analysis_cache"]["source_snapshot_sha256"], snapshot)
                self.assertEqual(projection_builder.call_count, 2)
                changed_version_refill = select("changed-projection-version-refill", snapshot)
                self.assertEqual(
                    changed_version_refill["analysis_cache"]["source_snapshot_sha256"], snapshot,
                )
                self.assertEqual(projection_builder.call_count, 2)

            with self.assertRaisesRegex(RuntimeError, "source snapshot changed"):
                select("stale-snapshot", "0" * 64)
            self.assertEqual(audit.call_count, 0)

            seal_path = self.store / "seal.json"
            original_seal = seal_path.read_bytes()
            tampered_seal = json.loads(original_seal)
            tampered_seal["stamp"][3] += 1
            seal_path.write_text(json.dumps(tampered_seal), encoding="utf-8")
            try:
                with self.assertRaisesRegex(RuntimeError, "Store mutation seal mismatch"):
                    select("changed-seal", snapshot)
            finally:
                seal_path.write_bytes(original_seal)
            self.assertEqual(audit.call_count, 0)

            changed_permission = self.root / "permission-record.txt"
            permission_bytes = Path(m.DEFAULT_PERMISSION_RECORD_PATH).read_bytes()
            changed_permission.write_bytes(
                permission_bytes + b"\n\n## Product publication policy\n\nPublication prose changed.\n"
            )
            with patch.object(m, "DEFAULT_PERMISSION_RECORD_PATH", changed_permission):
                prose_change = select("publication-prose-change", snapshot)
                self.assertEqual(prose_change["analysis_cache"]["source_snapshot_sha256"], snapshot)
                self.assertEqual(
                    prose_change["analysis_cache"]["store_evidence"]["source_identity"]["permission_sha256"],
                    first["analysis_cache"]["store_evidence"]["source_identity"]["permission_sha256"],
                    "historical permission provenance stays bound to the completed store",
                )
            revoked_permission = self.root / "revoked-permission.txt"
            revoked_permission.write_bytes(permission_bytes.replace(
                b"- Allowed lexical-reference use: permitted",
                b"- Allowed lexical-reference use: revoked",
            ))
            with patch.object(m, "DEFAULT_PERMISSION_RECORD_PATH", revoked_permission):
                with self.assertRaisesRegex(RuntimeError, "Allowed lexical-reference use"):
                    select("revoked-permission", snapshot)
            self.assertEqual(audit.call_count, 0)

            index_stat = self.index.stat()
            os.utime(self.index, ns=(index_stat.st_atime_ns, index_stat.st_mtime_ns + 1_000_000))
            with self.assertRaisesRegex(RuntimeError, "Index identity mismatch"):
                select("changed-index", snapshot)
            self.assertEqual(audit.call_count, 0)

    def test_separate_calls_do_not_rescan_input_completed_routes_or_facts(self):
        original_chunk = m.chunk_digest
        original_connect = m.connect
        queries = []
        def traced_connect(*args, **kwargs):
            db = original_connect(*args, **kwargs)
            db.set_trace_callback(queries.append)
            return db
        with patch.object(m, "source_identity", wraps=m.source_identity) as source_audit, \
             patch.object(m, "route_digest", wraps=m.route_digest) as routing_audit, \
             patch.object(m, "connect", side_effect=traced_connect):
            for slice_id in range(20):
                queries.clear()
                checked_slices = []
                def check_chunk(db, row):
                    checked_slices.append(row[0])
                    return original_chunk(db, row)
                with patch.object(m, "chunk_digest", side_effect=check_chunk):
                    self.run_store()
                self.assertTrue(all(s == slice_id for s in checked_slices))
                self.assertEqual(source_audit.call_count, 1)
                self.assertEqual(routing_audit.call_count, 1)
                if slice_id:
                    self.assertFalse(any("quick_check" in q or "foreign_key_check" in q for q in queries))
                    self.assertFalse(any("completed_facts" in q for q in queries))
                    fact_reads = [q for q in queries if "FROM facts" in q]
                    self.assertTrue(all(f"slice={slice_id}" in q for q in fact_reads), fact_reads)
                    # A WHERE clause alone is insufficient: SQLite can choose the
                    # global kind/form index and visit every old slice's facts.
                    with closing(original_connect(self.store / "analysis.sqlite", readonly=True)) as db:
                        for query in fact_reads:
                            plans = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + query)]
                            fact_plans = [plan for plan in plans if "SEARCH facts" in plan or "SEARCH f " in plan]
                            self.assertTrue(fact_plans, plans)
                            self.assertTrue(all("PRIMARY KEY (slice=?" in plan for plan in fact_plans), plans)
            queries.clear()
            self.run_store()
            self.assertFalse(any("FROM facts" in q or "FROM route" in q for q in queries))
        self.assert_union(range(20))

    def test_missing_published_database_cannot_silently_restart(self):
        self.run_store()
        (self.store / "analysis.sqlite").unlink()
        with self.assertRaisesRegex(RuntimeError, "Store DB missing"):
            self.run_store()
        self.assertFalse((self.store / "analysis.sqlite").exists())

    def test_sqlite_work_does_not_grow_with_previous_completed_facts(self):
        original_connect = m.connect
        work = []
        for extra_documents in (0, 4000):
            index = self.root / f"indexes/work-{extra_documents}.sqlite"
            fixture(index)
            with closing(sqlite3.connect(index)) as db:
                for document in range(6, 6 + extra_documents):
                    db.execute("INSERT INTO documents VALUES (?, 'a', ?, ?)", (document, f"d{document}", document))
                    db.execute("INSERT INTO paragraphs(document_rowid,paragraph_id,ordinal,form) VALUES (?,?,0,'나무')", (document, f"p{document}"))
                db.execute("UPDATE index_metadata SET value=? WHERE key='document_count'", (str(5 + extra_documents),))
                db.execute("UPDATE index_metadata SET value=? WHERE key='paragraph_count'", (str(89 + extra_documents),))
                db.commit()
            options = self.options | {"index_path": index, "directory": self.root / f"runs/work-{extra_documents}", "checkpoint":4096}
            m.run_next(**options)  # The extra singleton documents belong only to slice 0.
            operations = [0]
            def traced_connect(*args, **kwargs):
                db = original_connect(*args, **kwargs)
                def count():
                    operations[0] += 100
                    return 0
                db.set_progress_handler(count, 100)
                return db
            with patch.object(m, "connect", side_effect=traced_connect):
                result = m.run_next(**options)
            self.assertEqual(result["completed_slice"], 1)
            work.append(operations[0])
        # The same next slice must not pay for 12,000 extra old fact rows.
        # Allow B-tree depth differences and small statement rounding overhead.
        self.assertLessEqual(work[1], 2 * work[0] + 1000, work)

    def test_partial_checkpoint_corruption_and_stale_seal_require_valid_audit(self):
        self.run_store()
        def stop(event):
            if event == "after-checkpoint-commit":
                raise RuntimeError("stop")
        with self.assertRaises(RuntimeError):
            self.run_store(hook=stop)
        target = self.store / "analysis.sqlite"
        with closing(sqlite3.connect(target)) as db:
            db.execute("UPDATE facts SET tokens=tokens+1 WHERE slice=1")
            db.commit()
        with self.assertRaisesRegex(RuntimeError, "seal mismatch"):
            self.run_store()
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            m.inspect(index_path=self.index,directory=self.store,runtime=self.options["runtime"],audit=True)
        # Even a recreated mutation witness cannot hide corrupt current facts.
        m.seal_store(self.store)
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.run_store()

    def test_commit_seal_gap_requires_explicit_audit_and_resumes_same_slice(self):
        self.run_store()
        script = """
import os,sys
from pathlib import Path
sys.path.insert(0,'scripts/reference')
import corpus_morphology as m
from importlib.machinery import SourceFileLoader
t=SourceFileLoader('fixture_tests','scripts/reference/test-corpus-morphology.py').load_module()
m.seal_store=lambda directory: os._exit(77)
m.run_next(index_path=Path(sys.argv[1]),directory=Path(sys.argv[2]),analyzer=t.Analyzer(),runtime={'synthetic':'deterministic-v1'},checkpoint=2)
"""
        result = subprocess.run([sys.executable,"-c",script,str(self.index),str(self.store)],
                                cwd=Path(__file__).parents[2],capture_output=True,text=True)
        self.assertEqual(result.returncode,77,result.stderr)
        with self.assertRaisesRegex(RuntimeError,"seal mismatch"):
            self.run_store()
        state=m.inspect(index_path=self.index,directory=self.store,runtime=self.options["runtime"],audit=True)
        self.assertEqual(state["current_slice"],1)
        self.assertEqual(state["validation"],"full-audit-passed")
        self.run_store()
        self.assertEqual(self.last_summary["completed_slice"],1)
        self.assert_union([0,1])

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
        self.finish()
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
        result = self.finish()
        self.assertEqual(result["completion_bitmap"], "1" * 20)
        self.assertEqual(result["verified_paragraphs"], 5)
        self.assertTrue(all(s["expected_paragraphs"] == 0 for s in result["slices"][1:]))
        self.assert_union(range(20))

    def test_sidecar_free_wal_input_cannot_reach_concurrent_writer_publication(self):
        with closing(sqlite3.connect(self.index)) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        self.assertFalse(Path(str(self.index) + "-wal").exists())
        writer_called = []
        def concurrent_commit(event):
            if event == "after-checkpoint-commit" and not writer_called:
                writer_called.append(True)
                stamp = m.file_stamp(self.index)
                script = "import sqlite3,sys; db=sqlite3.connect(sys.argv[1],timeout=0); db.execute(\"UPDATE paragraphs SET form='변경' WHERE paragraph_rowid=(SELECT MAX(paragraph_rowid) FROM paragraphs WHERE ordinal%20=0)\"); db.commit()"
                result = subprocess.run([sys.executable,"-c",script,str(self.index)],capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(m.file_stamp(self.index),stamp)  # WAL commit bypasses main-file stamp.
        with self.assertRaisesRegex(RuntimeError,"WAL corpus index"):
            self.run_store(hook=concurrent_commit)
        self.assertFalse(writer_called)  # Fixed preflight rejects before tokenizing.
        self.assertFalse((self.store / "analysis.sqlite").exists())

    def test_actual_held_source_connection_rejects_wal(self):
        identity=m.source_identity(self.index,m.DEFAULT_PERMISSION_RECORD_PATH,self.options["runtime"])
        with closing(sqlite3.connect(self.index)) as owner:
            owner.execute("PRAGMA journal_mode=WAL")
            owner.execute("SELECT value FROM index_metadata LIMIT 1").fetchone()
            with closing(m.open_readonly_database(self.index)) as source:
                source.execute("BEGIN")
                source.execute("SELECT value FROM index_metadata LIMIT 1").fetchone()
                with patch.object(m,"require_rollback_header",return_value=None), \
                     patch.object(m,"open_readonly_database",side_effect=AssertionError("must use held source")):
                    with self.assertRaisesRegex(RuntimeError,"WAL corpus index"):
                        m.fast_identity(self.index,m.DEFAULT_PERMISSION_RECORD_PATH,self.options["runtime"],identity,source)

    def test_wal_commit_changes_attached_snapshot_without_main_stamp_change(self):
        with closing(sqlite3.connect(self.index)) as owner:
            owner.execute("PRAGMA journal_mode=WAL")
            owner.execute("SELECT value FROM index_metadata LIMIT 1").fetchone()
            self.assertEqual(Path(str(self.index)+"-wal").stat().st_size,0)
            with closing(m.open_readonly_database(self.index)) as source, \
                 closing(sqlite3.connect(":memory:")) as attached:
                source.execute("BEGIN")
                source.execute("SELECT value FROM index_metadata LIMIT 1").fetchone()
                attached.execute("ATTACH DATABASE ? AS corpus", (self.index.as_uri()+"?mode=ro",))
                query="SELECT form FROM paragraphs WHERE paragraph_rowid=89"
                before=source.execute(query).fetchone()
                self.assertEqual(attached.execute(query.replace("paragraphs","corpus.paragraphs")).fetchone(),before)
                stamp=m.file_stamp(self.index)
                script="import sqlite3,sys; db=sqlite3.connect(sys.argv[1],timeout=0); db.execute(\"UPDATE paragraphs SET form='변경' WHERE paragraph_rowid=89\"); db.commit()"
                result=subprocess.run([sys.executable,"-c",script,str(self.index)],capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(m.file_stamp(self.index),stamp)
                self.assertEqual(source.execute(query).fetchone(),before)
                self.assertEqual(attached.execute(query.replace("paragraphs","corpus.paragraphs")).fetchone(),('변경',))
            with self.assertRaisesRegex(RuntimeError,"WAL corpus index"):
                self.run_store()
            self.assertFalse((self.store / "analysis.sqlite").exists())

    def test_wal_mode_change_before_held_source_prevents_publication(self):
        def switch_mode(event):
            if event == "after-initial-publication":
                with closing(sqlite3.connect(self.index)) as source:
                    source.execute("PRAGMA journal_mode=WAL")
        with self.assertRaisesRegex(RuntimeError,"WAL corpus index"):
            self.run_store(hook=switch_mode)
        with closing(m.connect(self.store / "analysis.sqlite",readonly=True)) as db:
            self.assertEqual(db.execute("SELECT SUM(complete) FROM slices").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM facts").fetchone()[0],0)

    def test_incremental_identity_never_reopens_a_held_source_inode(self):
        identity=m.source_identity(self.index,m.DEFAULT_PERMISSION_RECORD_PATH,self.options["runtime"])
        original_open=Path.open
        def forbid_source_reopen(path,*args,**kwargs):
            if path == self.index:
                raise AssertionError("Closing another source inode descriptor releases Linux POSIX locks")
            return original_open(path,*args,**kwargs)
        with closing(m.open_readonly_database(self.index)) as source:
            source.execute("BEGIN")
            source.execute("SELECT value FROM index_metadata LIMIT 1").fetchone()
            with patch.object(Path,"open",forbid_source_reopen), \
                 patch.object(m,"open_readonly_database",side_effect=AssertionError("must retain held connection")):
                self.assertEqual(m.fast_identity(self.index,m.DEFAULT_PERMISSION_RECORD_PATH,self.options["runtime"],identity,source),identity)

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
                self.finish()
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
m.run_next(index_path=Path(sys.argv[1]), directory=Path(sys.argv[2]), analyzer=t.Analyzer(),
      runtime={'synthetic':'deterministic-v1'},checkpoint=2,hook=hook)
"""
            result = subprocess.run([sys.executable, "-c", script, str(self.index), str(self.store), boundary],
                                    cwd=Path(__file__).parents[2], capture_output=True, text=True)
            self.assertEqual(result.returncode, 77, result.stderr)
            self.assert_union([0])
        self.finish()
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
        result = self.run_store()
        self.assertEqual(self.last_summary["completed_slice"], 1)
        self.assertEqual(result["completion_bitmap"], "11" + "0" * 18)
        self.assertEqual(result["slices"][2]["processed_paragraphs"], 0)
        self.finish()
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

    def test_cli_emits_concise_comment_summary_and_rejects_multi_slice_option(self):
        output = io.StringIO()
        arguments = ["corpus_morphology.py", "run-next", "--index", str(self.index), "--store", str(self.store)]
        with patch.object(sys, "argv", arguments), patch.object(sys, "stdout", output), \
             patch.object(m, "runtime_identity", return_value=self.options["runtime"]), \
             patch.dict(sys.modules, {"kiwipiepy": SimpleNamespace(Kiwi=lambda **_kwargs: Analyzer())}):
            self.assertEqual(m.main(), 0)
        summary = json.loads(output.getvalue())
        status = self.inspect()
        row = status["slices"][0]
        self.assertEqual(summary["completed_slice"], 0)
        self.assertEqual(summary["result"], "completed")
        self.assertEqual(summary["validation"], "passed")
        self.assertEqual(summary["coverage_percent"], status["coverage_percent"])
        self.assertEqual(summary["cumulative_verified_paragraphs"], status["verified_paragraphs"])
        self.assertEqual(summary["new_unique_lemmas"], row["new_unique_lemmas"])
        self.assertEqual(summary["cumulative_unique_lemmas"], status["cumulative_unique_lemmas"])
        self.assertEqual(summary["digest"], row["publication_sha256"])
        self.assertEqual(summary["elapsed_seconds"], row["elapsed_seconds"])
        self.assertEqual(summary["disk_bytes"], status["disk_bytes"])
        self.assertEqual(summary["local_store"], str(self.store.resolve()))
        self.assertNotIn("slices", summary)
        before = m.file_digest(self.store / "analysis.sqlite")
        with patch.object(sys, "argv", arguments + ["--max-slices", "20"]), \
             patch.object(m, "runtime_identity", side_effect=AssertionError("must fail before loading models")):
            with self.assertRaises(SystemExit) as failed:
                m.main()
        self.assertEqual(failed.exception.code, 2)
        self.assertEqual(m.file_digest(self.store / "analysis.sqlite"), before)

    def test_twenty_separate_cli_processes_and_twenty_first_noop(self):
        script = """
import sys
sys.path.insert(0,'scripts/reference')
import corpus_morphology as m
from types import SimpleNamespace
from importlib.machinery import SourceFileLoader
t=SourceFileLoader('fixture_tests','scripts/reference/test-corpus-morphology.py').load_module()
m.runtime_identity=lambda: {'synthetic':'deterministic-v1'}
sys.modules['kiwipiepy']=SimpleNamespace(Kiwi=lambda **kwargs:t.Analyzer())
sys.argv=['corpus_morphology.py','run-next','--index',sys.argv[1],'--store',sys.argv[2],'--checkpoint-paragraphs','2']
raise SystemExit(m.main())
"""
        for slice_id in range(20):
            result = subprocess.run([sys.executable, "-c", script, str(self.index), str(self.store)],
                                    cwd=Path(__file__).parents[2], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            self.assertEqual(summary["completed_slice"], slice_id)
            self.assertEqual(summary["completion_bitmap"], "1" * (slice_id + 1) + "0" * (19 - slice_id))
            state = self.inspect()
            if slice_id < 19:
                self.assertEqual(state["slices"][slice_id + 1]["processed_paragraphs"], 0)
        self.assert_union(range(20))
        before = m.file_digest(self.store / "analysis.sqlite")
        result = subprocess.run([sys.executable, "-c", script, str(self.index), str(self.store)],
                                cwd=Path(__file__).parents[2], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["result"], "no-op")
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
        self.finish()
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
