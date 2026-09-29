"""Synthetic, local/manual regressions for corpus_lemma_pilot.py."""

from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace


MODULE_PATH = Path(__file__).with_name("corpus_lemma_pilot.py")
SPEC = importlib.util.spec_from_file_location("corpus_lemma_pilot", MODULE_PATH)
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)


class FakeAnalyzer:
    TOKENS = {
        "바람물결": [
            ("바람", "NNG", 0, 2),
            ("바라", "VV", 0, 2),
            ("물결", "NNG", 2, 2),
        ],
        "푸른": [("푸르", "VA", 0, 2)],
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


def create_exclusion_manifest(path: Path, lemmas: list[str]) -> None:
    payload = {
        "schema_version": "m9-reviewed-lemma-exclusions-v1",
        "source_artifacts": [],
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

    def test_candidate_limit_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "candidate limit must be 1-200"):
            pilot.run_extraction(
                dictionary_path=Path("missing.sqlite"),
                analyzer=FakeAnalyzer(),
                candidate_limit=201,
            )


if __name__ == "__main__":
    unittest.main()
