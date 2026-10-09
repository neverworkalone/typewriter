"""Synthetic, local/manual regressions for corpus_lemma_pilot.py."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("corpus_lemma_pilot.py")
SPEC = importlib.util.spec_from_file_location("corpus_lemma_pilot", MODULE_PATH)
pilot = importlib.util.module_from_spec(SPEC)
sys.modules["corpus_lemma_pilot"] = pilot
SPEC.loader.exec_module(pilot)
CACHED_PATH = Path(__file__).with_name("select-corpus-candidates-from-analysis.py")
CACHED_SPEC = importlib.util.spec_from_file_location("select_corpus_candidates_from_analysis", CACHED_PATH)
cached = importlib.util.module_from_spec(CACHED_SPEC)
CACHED_SPEC.loader.exec_module(cached)
from scripts.python.local_cache import (
    assert_cache_path,
    cache_relative_path,
    normalize_cache_run_binding,
    typewriter_cache_root,
)

NODE_RECORD_ANALYSIS_CACHE = """
import { readFile } from 'node:fs/promises';
import { recordAnalysisCache } from './scripts/reference/run-corpus-lemma-pilot.mjs';
const selection = JSON.parse(await readFile(process.argv[1], 'utf8'));
await recordAnalysisCache({
  selection,
  stagingDatabasePath: process.argv[2],
  mode: 'full-corpus-scan',
});
"""


class TypewriterCachePathTests(unittest.TestCase):
    def test_python_artifact_paths_are_cache_scoped_and_reject_traversal(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cache = root / "cache"
            run = cache / "runs" / "task-1"
            run.mkdir(parents=True)
            with patch.dict(os.environ, {"TYPEWRITER_CACHE_ROOT": str(cache)}):
                self.assertEqual(assert_cache_path(run / "evidence.json", "runs", "evidence"), (run / "evidence.json").resolve())
                with self.assertRaisesRegex(ValueError, "outside"):
                    assert_cache_path(cache / "runs" / ".." / "outside.json", "runs", "evidence")
                with patch.dict(os.environ, {"TYPEWRITER_CACHE_ROOT": "relative-cache"}):
                    with self.assertRaisesRegex(ValueError, "absolute path"):
                        assert_cache_path(run / "evidence.json", "runs", "evidence")
                outside = root / "outside"
                outside.mkdir()
                (cache / "runs" / "escape").symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(ValueError, "outside"):
                    assert_cache_path(cache / "runs" / "escape" / "artifact.json", "runs", "evidence")

    def test_python_cache_root_matches_home_expansion_and_symlink_resolution(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            home = root / "home"
            home.mkdir()
            with patch.dict(os.environ, {"HOME": str(home), "TYPEWRITER_CACHE_ROOT": "~/shared"}):
                self.assertEqual(typewriter_cache_root(), (home / "shared").resolve())

            actual = root / "actual-cache"
            actual.mkdir()
            alias = root / "cache-alias"
            alias.symlink_to(actual, target_is_directory=True)
            with patch.dict(os.environ, {"TYPEWRITER_CACHE_ROOT": str(alias)}):
                self.assertEqual(typewriter_cache_root(), actual.resolve())

    def test_analysis_binding_uses_cache_relative_paths_and_maps_legacy_production_paths(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            analysis = root / "runs" / "issue-222" / "candidate-analysis.sqlite"
            with patch.dict(os.environ, {"TYPEWRITER_CACHE_ROOT": str(root)}):
                self.assertEqual(cache_relative_path(analysis), "runs/issue-222/candidate-analysis.sqlite")
                self.assertEqual(
                    normalize_cache_run_binding("data/reference/production/issue-222/candidate-analysis.sqlite"),
                    cache_relative_path(analysis),
                )
                self.assertEqual(
                    normalize_cache_run_binding("runs/another/candidate-analysis.sqlite"),
                    "runs/another/candidate-analysis.sqlite",
                )
                with self.assertRaisesRegex(ValueError, "traversal"):
                    normalize_cache_run_binding("runs/../outside.sqlite")


class FakeAnalyzer:
    TOKENS = {
        "바람물결": [
            ("바람", "NNG", 0, 2),
            ("바라", "VV", 0, 2),
            ("물결", "NNG", 2, 2),
        ],
        "푸른": [("푸르", "VA", 0, 2)],
        "푸르러": [("푸르", "VV", 0, 2)],
        "기록": [("기록", "NNG", 0, 2)],
        "녹음": [("녹음", "NNG", 0, 2)],
    }

    def tokenize(self, text):
        return [SimpleNamespace(form=form, tag=tag, start=start, len=length)
                for form, tag, start, length in self.TOKENS[text]]


def create_permission(path: Path, **overrides) -> None:
    values = {
        "Decision": "permitted for stated role",
        "Intended role": "reference",
        "Allowed local storage": "permitted",
        "Allowed schema scanning and processing": "permitted",
        "Allowed SQLite/FTS indexing": "permitted",
        "Allowed lexical-reference use": "permitted",
        "Distribution/embedding terms reviewed": "complete",
        "Attribution/notice terms reviewed": "complete",
    }
    values.update(overrides)
    path.write_text("\n".join(f"- {key}: {value}" for key, value in values.items()), encoding="utf-8")


def create_exclusion_manifest(path: Path, lemmas: list[str], source_artifacts: list[dict] | None = None) -> None:
    payload = {
        "schema_version": "m9-reviewed-lemma-exclusions-v1",
        "source_artifacts": source_artifacts if source_artifacts is not None else (
            [{"path": "fixture/source.json", "sha256": "a" * 64}] if lemmas else []
        ),
        "lemmas": sorted(set(lemmas)),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload["exclusion_sha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def create_index(path: Path) -> None:
    database = sqlite3.connect(path)
    database.executescript(
        """
        CREATE TABLE index_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE source_files(source_path TEXT PRIMARY KEY);
        CREATE TABLE documents(
            document_rowid INTEGER PRIMARY KEY,
            source_path TEXT NOT NULL,
            document_id TEXT NOT NULL,
            document_ordinal INTEGER NOT NULL
        );
        CREATE TABLE paragraphs(
            paragraph_rowid INTEGER PRIMARY KEY,
            document_rowid INTEGER NOT NULL,
            paragraph_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            form TEXT NOT NULL
        );
        """
    )
    database.executemany(
        "INSERT INTO index_metadata(key, value) VALUES (?, ?)",
        [
            ("schema_version", "1"),
            ("source_count", "2"),
            ("document_count", "2"),
            ("paragraph_count", "6"),
            ("input_manifest_sha256", "manifest-digest"),
            ("logical_rows_sha256", "logical-digest"),
            ("sqlite_version", sqlite3.sqlite_version),
        ],
    )
    database.executemany("INSERT INTO source_files(source_path) VALUES (?)", [("a.json",), ("b.json",)])
    database.executemany(
        "INSERT INTO documents(document_rowid, source_path, document_id, document_ordinal) VALUES (?, ?, ?, ?)",
        [(1, "a.json", "doc-a", 0), (2, "b.json", "doc-b", 0)],
    )
    database.executemany(
        "INSERT INTO paragraphs(paragraph_rowid, document_rowid, paragraph_id, ordinal, form) VALUES (?, ?, ?, ?, ?)",
        [
            (1, 1, "a-0", 0, "바람물결"),
            (2, 1, "a-1", 1, "푸른"),
            (3, 1, "a-2", 2, "기록"),
            (4, 1, "a-3", 3, "녹음"),
            (5, 2, "b-0", 0, "바람물결"),
            (6, 2, "b-1", 1, "푸른"),
        ],
    )
    database.commit()
    database.close()


def create_dictionary(path: Path) -> None:
    database = sqlite3.connect(path)
    database.executescript(
        """
        CREATE TABLE records(id TEXT PRIMARY KEY, lemma TEXT NOT NULL);
        CREATE TABLE search_forms(form TEXT NOT NULL, record_id TEXT NOT NULL);
        CREATE TABLE senses(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, pos TEXT NOT NULL);
        CREATE TABLE generated_surface_forms(
            form TEXT NOT NULL,
            record_id TEXT NOT NULL,
            sense_id TEXT NOT NULL,
            rule_id TEXT NOT NULL
        );
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    database.execute("INSERT INTO records(id, lemma) VALUES ('record-녹음', '녹음')")
    database.execute("INSERT INTO senses(id, record_id, pos) VALUES ('sense-녹음', 'record-녹음', 'noun')")
    database.execute("INSERT INTO search_forms(form, record_id) VALUES ('물결', 'record-녹음')")
    database.execute(
        "INSERT INTO generated_surface_forms(form, record_id, sense_id, rule_id) "
        "VALUES ('기록', 'record-녹음', 'sense-녹음', 'predicate-plain-past-open-a')"
    )
    database.executemany(
        "INSERT INTO metadata(key, value) VALUES (?, ?)",
        [("dictionary_version", "test"), ("canonical_revision", "synthetic"),
         ("record_count", "1"), ("search_form_count", "1"),
         ("generated_surface_form_count", "1")],
    )
    database.commit()
    database.close()


class CorpusLemmaPilotTests(unittest.TestCase):
    def test_surface_normalization_matches_runtime_nfc_trim(self):
        self.assertEqual(pilot.normalize_search_form("  바람  "), "바람")

    def test_permission_gate_requires_every_reference_and_terms_scope(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            permission_path = Path(temporary_directory) / "permission.md"
            create_permission(permission_path, **{"Allowed lexical-reference use": "pending"})
            with self.assertRaisesRegex(RuntimeError, "Allowed lexical-reference use"):
                pilot.read_permission_record(permission_path)

    def test_nonempty_exclusion_manifest_requires_a_source_binding(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            unbound_path = root / "unbound.json"
            create_exclusion_manifest(unbound_path, ["바람"], source_artifacts=[])
            with self.assertRaisesRegex(RuntimeError, "must bind at least one source artifact"):
                pilot.read_exclusion_manifest(unbound_path)

            empty_source_path = root / "empty-source-path.json"
            create_exclusion_manifest(
                empty_source_path,
                ["바람"],
                source_artifacts=[{"path": "", "sha256": "a" * 64}],
            )
            with self.assertRaisesRegex(RuntimeError, "source bindings must include paths"):
                pilot.read_exclusion_manifest(empty_source_path)

            empty_path = root / "empty.json"
            create_exclusion_manifest(empty_path, [])
            self.assertEqual(pilot.read_exclusion_manifest(empty_path)["lemmas"], [])

    def test_exact_lemma_is_covered_while_search_and_generated_collisions_are_held(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            index_path = root / "index.sqlite"
            dictionary_path = root / "dictionary.sqlite"
            permission_path = root / "permission.md"
            exclusion_path = root / "excluded.json"
            staging_path = root / "staging.sqlite"
            candidate_path = root / "candidates.json"
            create_index(index_path)
            create_dictionary(dictionary_path)
            create_permission(permission_path)
            create_exclusion_manifest(exclusion_path, ["바람"])

            result = pilot.run_extraction(
                index_path=index_path,
                dictionary_path=dictionary_path,
                staging_path=staging_path,
                candidate_output_path=candidate_path,
                permission_record_path=permission_path,
                analyzer=FakeAnalyzer(),
                sample_every=1,
                candidate_limit=5,
                batch_size=2,
            )

            self.assertEqual(result["index"]["sample_paragraph_count"], 6)
            self.assertEqual(result["index"]["sample_document_count"], 2)
            self.assertEqual(result["index"]["sample_source_count"], 2)
            self.assertEqual(result["yield"]["exact_canonical_lemma_candidates"], 1)
            self.assertEqual(result["yield"]["search_form_collision_lemma_candidates"], 1)
            self.assertEqual(result["yield"]["generated_surface_collision_lemma_candidates"], 1)
            self.assertEqual(result["yield"]["selected_inventory_count"], 5)
            self.assertEqual(result["selection"]["excluded_candidate_lemma_count"], 0)
            self.assertEqual(result["selection"]["selected_candidate_count"], 5)
            candidates = {row["proposed_lemma"]: row for row in result["candidates"]}
            self.assertNotIn("녹음", candidates)
            staging = sqlite3.connect(staging_path)
            exact_match = staging.execute(
                "SELECT covered, coverage_status, coverage_matches_json "
                "FROM candidates WHERE normalized_lemma = '녹음'"
            ).fetchone()
            staging.close()
            self.assertEqual(exact_match[0:2], (1, "exact_canonical_lemma"))
            self.assertEqual(
                json.loads(exact_match[2]),
                [{
                    "match_kind": "canonical_lemma",
                    "record_id": "record-녹음",
                    "canonical_lemma": "녹음",
                    "sense_id": None,
                    "pos": None,
                    "rule_id": None,
                }],
            )
            self.assertEqual(candidates["물결"]["coverage_status"], "search_form_collision")
            self.assertEqual(candidates["물결"]["decision_state"], "held")
            self.assertEqual(
                candidates["물결"]["typewriter_surface_matches"],
                [{
                    "match_kind": "curated_search_form",
                    "record_id": "record-녹음",
                    "canonical_lemma": "녹음",
                    "sense_id": None,
                    "pos": None,
                    "rule_id": None,
                }],
            )
            self.assertEqual(candidates["기록"]["coverage_status"], "generated_surface_collision")
            self.assertEqual(candidates["기록"]["decision_state"], "held")
            self.assertEqual(
                candidates["기록"]["typewriter_surface_matches"],
                [{
                    "match_kind": "generated_surface_form",
                    "record_id": "record-녹음",
                    "canonical_lemma": "녹음",
                    "sense_id": "sense-녹음",
                    "pos": "noun",
                    "rule_id": "predicate-plain-past-open-a",
                }],
            )
            self.assertEqual(
                candidates["바람"]["ambiguity_status"],
                "held_surface_has_multiple_analyzer_interpretations",
            )
            self.assertEqual(
                candidates["바라다"]["ambiguity_status"],
                "held_surface_has_multiple_analyzer_interpretations",
            )
            self.assertEqual(candidates["푸르다"]["proposed_pos"], "adjective")
            self.assertEqual(candidates["푸르다"]["observed_surface_forms"][0]["surface"], "푸른")
            self.assertEqual(candidates["바람"]["observed_surface_forms"][0]["surface"], "바람물결")
            self.assertEqual(candidates["바람"]["observed_morpheme_spans"][0]["surface"], "바람")

            excluded = pilot.run_extraction(
                index_path=index_path,
                dictionary_path=dictionary_path,
                staging_path=root / "excluded-staging.sqlite",
                candidate_output_path=root / "excluded-candidates.json",
                permission_record_path=permission_path,
                exclusion_manifest_path=exclusion_path,
                analyzer=FakeAnalyzer(),
                sample_every=1,
                candidate_limit=4,
                batch_size=2,
            )
            excluded_candidates = {row["proposed_lemma"] for row in excluded["candidates"]}
            self.assertNotIn("바람", excluded_candidates)
            self.assertIn("바라다", excluded_candidates)
            self.assertEqual(excluded["selection"]["excluded_candidate_lemma_count"], 1)

    def _multi_pos_fixture(self, root):
        index_path = root / "index.sqlite"
        dictionary_path = root / "dictionary.sqlite"
        permission_path = root / "permission.md"
        create_index(index_path)
        create_dictionary(dictionary_path)
        create_permission(permission_path)
        # Seventh paragraph: the same lemma 푸르다 observed as a second POS (verb) with its own form.
        database = sqlite3.connect(index_path)
        database.execute("UPDATE index_metadata SET value = '7' WHERE key = 'paragraph_count'")
        database.execute("INSERT INTO paragraphs VALUES (7, 2, 'b-2', 2, '푸르러')")
        database.commit()
        database.close()
        return index_path, dictionary_path, permission_path

    def _extract(self, root, name, fixture, include, limit=10):
        index_path, dictionary_path, permission_path = fixture
        return pilot.run_extraction(
            index_path=index_path,
            dictionary_path=dictionary_path,
            staging_path=root / f"{name}-staging.sqlite",
            candidate_output_path=root / f"{name}-candidates.json",
            permission_record_path=permission_path,
            analyzer=FakeAnalyzer(),
            sample_every=1,
            candidate_limit=limit,
            batch_size=2,
            include_canonical_lemmas=include,
        )

    def _select_cached(self, root, name, fixture, include, limit=10, mutate=None):
        index_path, dictionary_path, permission_path = fixture
        run_directory = root.resolve() / "runs" / "issue-222"
        run_directory.mkdir(parents=True, exist_ok=True)
        analysis_path = run_directory / "candidate-analysis.sqlite"
        shutil.copy2(root / "default-staging.sqlite", analysis_path)
        with patch.dict(os.environ, {"TYPEWRITER_CACHE_ROOT": str(root.resolve())}):
            selection_input = root / "default-candidates.json"
            selection_path = run_directory / "candidate-selection.json"
            # The JavaScript producer writes the cache-relative binding that the Python reader consumes below.
            subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    NODE_RECORD_ANALYSIS_CACHE,
                    str(selection_input),
                    str(analysis_path),
                ],
                cwd=Path(__file__).resolve().parents[2],
                env=os.environ.copy(),
                check=True,
                capture_output=True,
                text=True,
            )
            selection = json.loads(selection_path.read_text(encoding="utf-8"))
            if mutate:
                mutate(selection)
            bound_selection = run_directory / f"{name}-bound-selection.json"
            bound_selection.write_text(json.dumps(selection), encoding="utf-8")
            exclusion_path = run_directory / "no-exclusions.json"
            create_exclusion_manifest(exclusion_path, [])
            original = pilot.DEFAULT_PERMISSION_RECORD_PATH
            pilot.DEFAULT_PERMISSION_RECORD_PATH = permission_path
            try:
                cached.select_from_cached_analysis(
                    analysis_path=analysis_path,
                    selection_path=bound_selection,
                    dictionary_path=dictionary_path,
                    index_path=index_path,
                    staging_path=run_directory / f"{name}-cached-staging.sqlite",
                    candidate_output_path=run_directory / f"{name}-cached-candidates.json",
                    exclusion_manifest_path=exclusion_path,
                    candidate_limit=limit,
                    include_canonical_lemmas=include,
                )
                return json.loads((run_directory / f"{name}-cached-candidates.json").read_text(encoding="utf-8"))
            finally:
                pilot.DEFAULT_PERMISSION_RECORD_PATH = original

    def test_factory_mode_keeps_canonical_lemmas_and_every_pos_in_both_selection_paths(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fixture = self._multi_pos_fixture(root)
            original_sample = pilot.SAMPLE_EVERY_PARAGRAPHS
            pilot.SAMPLE_EVERY_PARAGRAPHS = 1  # the cached path binds the sampling interval
            try:
                direct_default = self._extract(root, "default", fixture, False)
                direct_factory = self._extract(root, "factory", fixture, True)
                cached_default = self._select_cached(root, "off", fixture, False)
                cached_factory = self._select_cached(root, "on", fixture, True)
            finally:
                pilot.SAMPLE_EVERY_PARAGRAPHS = original_sample

            def pairs(result):
                return sorted((row["proposed_lemma"], row["proposed_pos"]) for row in result["candidates"])

            # Historical M9 behaviour: exact canonical lemmas are dropped and one POS row per lemma.
            self.assertNotIn("녹음", {lemma for lemma, _ in pairs(direct_default)})
            self.assertEqual(len([1 for lemma, _ in pairs(direct_default) if lemma == "푸르다"]), 1)
            self.assertNotIn("include_canonical_lemmas", direct_default["selection"])
            self.assertEqual(pairs(cached_default), pairs(direct_default))
            self.assertNotIn("include_canonical_lemmas", cached_default["selection"])

            # Factory mode: the canonical lemma stays and no observed POS of a lemma is lost.
            for result in (direct_factory, cached_factory):
                found = pairs(result)
                self.assertIn(("녹음", "noun"), found)
                self.assertIn(("푸르다", "adjective"), found)
                self.assertIn(("푸르다", "verb"), found)
                self.assertTrue(result["selection"]["include_canonical_lemmas"])
                self.assertEqual(result["selection"]["selected_candidate_count"], len(result["candidates"]))
                self.assertEqual(
                    result["selection"]["selected_lemma_count"],
                    len({lemma for lemma, _ in found}),
                )
                by_pos = {row["proposed_pos"]: row for row in result["candidates"] if row["proposed_lemma"] == "푸르다"}
                self.assertEqual({form["surface"] for form in by_pos["verb"]["observed_surface_forms"]}, {"푸르러"})
                self.assertEqual(by_pos["verb"]["pos_interpretation_count_in_sample"], 2)
                self.assertEqual(
                    next(r for r in result["candidates"] if r["proposed_lemma"] == "녹음")["coverage_status"],
                    "exact_canonical_lemma",
                )
            self.assertEqual(pairs(cached_factory), pairs(direct_factory))

    def test_factory_bound_counts_distinct_lemmas_not_pos_rows(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fixture = self._multi_pos_fixture(root)
            full = self._extract(root, "full", fixture, True, limit=10)
            ranked = []
            for row in full["candidates"]:
                if row["proposed_lemma"] not in ranked:
                    ranked.append(row["proposed_lemma"])
            limited = self._extract(root, "limited", fixture, True, limit=2)
            lemmas = {row["proposed_lemma"] for row in limited["candidates"]}
            self.assertEqual(lemmas, set(ranked[:2]))
            self.assertEqual(limited["selection"]["selected_lemma_count"], 2)

    def test_cached_selection_rejects_stale_or_mismatched_cache(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fixture = self._multi_pos_fixture(root)
            original_sample = pilot.SAMPLE_EVERY_PARAGRAPHS
            pilot.SAMPLE_EVERY_PARAGRAPHS = 1
            try:
                self._extract(root, "default", fixture, False)

                def other_source(selection):
                    selection["extractor"]["script_sha256"] = "0" * 64

                def other_database(selection):
                    selection["analysis_cache"]["database_sha256"] = "0" * 64

                def other_database_path(selection):
                    selection["analysis_cache"]["database_path"] = "runs/another/candidate-analysis.sqlite"

                def unapproved_historical_extractor(selection):
                    selection["extractor"]["script_sha256"] = "f" * 64

                def incompatible_v1_extractor(selection):
                    selection["extractor"].update({
                        "extractor_version": "1",
                        "script_sha256": "35f8e5d66ad00885bc495f62707086fef8a8daad7437240a95a9e86997ce0786",
                    })

                with self.assertRaisesRegex(RuntimeError, "different morphology extractor source"):
                    self._select_cached(root, "stale", fixture, True, mutate=other_source)
                with self.assertRaisesRegex(RuntimeError, "digest does not match"):
                    self._select_cached(root, "tampered", fixture, True, mutate=other_database)
                with self.assertRaisesRegex(RuntimeError, "different analysis database"):
                    self._select_cached(root, "different-path", fixture, True, mutate=other_database_path)
                with self.assertRaisesRegex(RuntimeError, "different morphology extractor source"):
                    self._select_cached(root, "unapproved-source", fixture, True, mutate=unapproved_historical_extractor)
                with self.assertRaisesRegex(RuntimeError, "different morphology extractor version"):
                    self._select_cached(root, "incompatible-v1", fixture, True, mutate=incompatible_v1_extractor)
            finally:
                pilot.SAMPLE_EVERY_PARAGRAPHS = original_sample

    def test_cached_selection_accepts_a_moved_legacy_analysis_binding(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fixture = self._multi_pos_fixture(root)
            original_sample = pilot.SAMPLE_EVERY_PARAGRAPHS
            pilot.SAMPLE_EVERY_PARAGRAPHS = 1
            try:
                self._extract(root, "default", fixture, False)

                compatible_historical_digests = (
                    "0debcc9d58fa87327b64e21fa26b8dca335380fd8d27166db67cb7b31fdb386e",
                    "a65060846e1f5f0fb300823590965d569772bc952368be18d95f018ab297faeb",
                )
                for index, digest in enumerate(compatible_historical_digests):
                    def migrated_legacy_binding(selection):
                        selection["analysis_cache"]["database_path"] = (
                            "data/reference/production/issue-222/candidate-analysis.sqlite"
                        )
                        selection["extractor"]["script_sha256"] = digest

                    result = self._select_cached(
                        root,
                        f"legacy-binding-{index}",
                        fixture,
                        True,
                        mutate=migrated_legacy_binding,
                    )
                    self.assertEqual(result["analysis_cache"]["mode"], "reused-candidate-analysis")
                    self.assertEqual(
                        result["analysis_cache"]["source_database_path"],
                        "runs/issue-222/candidate-analysis.sqlite",
                    )
                    self.assertEqual(result["analysis_cache"]["source_extractor_script_sha256"], digest)
            finally:
                pilot.SAMPLE_EVERY_PARAGRAPHS = original_sample

    def test_candidate_limit_is_bounded(self):
        self.assertEqual(pilot.TARGET_CANDIDATES, 200)
        self.assertEqual(pilot.MAX_CANDIDATE_LIMIT, 500)
        self.assertEqual(pilot.validate_candidate_limit(200), 200)
        self.assertEqual(pilot.validate_candidate_limit(500), 500)
        with self.assertRaisesRegex(ValueError, "Candidate limit must be 1-500"):
            pilot.validate_candidate_limit(501)
        with self.assertRaisesRegex(ValueError, "Candidate limit must be 1-500"):
            pilot.run_extraction(
                dictionary_path=Path("missing.sqlite"),
                analyzer=FakeAnalyzer(),
                candidate_limit=501,
            )


if __name__ == "__main__":
    unittest.main()
