#!/usr/bin/env python3
"""Re-select M9 candidates from an exactly bound, cached morphology analysis."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import corpus_lemma_pilot as producer
from scripts.python.local_cache import assert_cache_path, cache_relative_path, normalize_cache_run_binding


ORDERING = [
    "source_count descending",
    "document_count descending",
    "analyzer_morpheme_observations_in_sample descending",
    "lemma Unicode binary ascending",
]

_SURFACE_AMBIGUITY_UPDATE = " ".join(
    """
    UPDATE candidate_surfaces
    SET interpretation_count = (
        SELECT COUNT(*) FROM candidate_surfaces AS other
        WHERE other.surface = candidate_surfaces.surface
    )
    """.split()
)
_LEMMA_AMBIGUITY_UPDATE = " ".join(
    """
    UPDATE candidates
    SET ambiguous_surface_count = (
        SELECT COUNT(*) FROM candidate_surfaces AS surface
        WHERE surface.lemma = candidates.lemma
          AND surface.pos = candidates.pos
          AND surface.interpretation_count > 1
    )
    """.split()
)


class CachedAnalysisSelectionDatabase:
    """Reuse ambiguity counts from the SHA-bound analysis database during reselection."""

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        self.skipped_ambiguity_updates: set[str] = set()

    def execute(self, sql: str, parameters=()):
        normalized = " ".join(sql.split())
        if normalized == _SURFACE_AMBIGUITY_UPDATE:
            self.skipped_ambiguity_updates.add("surface")
            return self.connection.execute("SELECT 1 WHERE 0")
        if normalized == _LEMMA_AMBIGUITY_UPDATE:
            self.skipped_ambiguity_updates.add("lemma")
            return self.connection.execute("SELECT 1 WHERE 0")
        return self.connection.execute(sql, parameters)

    def executemany(self, sql: str, parameters):
        return self.connection.executemany(sql, parameters)

    def commit(self):
        return self.connection.commit()

    def assert_reused_ambiguity(self):
        if self.skipped_ambiguity_updates != {"surface", "lemma"}:
            raise RuntimeError(
                "Cached selection did not reuse both hash-bound morphology ambiguity aggregates."
            )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> tuple[dict, bytes]:
    try:
        data = path.read_bytes()
        value = json.loads(data.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cached {label} is unreadable: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Cached {label} must be a JSON object.")
    return value, data


def verify_source_cache(
    *,
    analysis_path: Path,
    selection_path: Path,
    selection: dict,
    selection_bytes: bytes,
    index: sqlite3.Connection,
    permission_sha256: str,
) -> dict:
    cache = selection.get("analysis_cache")
    if not isinstance(cache, dict):
        raise RuntimeError("Cached selection has no analysis database binding.")
    try:
        recorded_database_path = normalize_cache_run_binding(cache.get("database_path"))
        actual_database_path = cache_relative_path(analysis_path, "Cached candidate analysis")
    except ValueError as error:
        raise RuntimeError(f"Cached selection has an invalid analysis database path binding: {error}") from error
    if recorded_database_path != actual_database_path:
        raise RuntimeError("Cached selection points at a different analysis database.")
    actual_database_sha256 = sha256_file(analysis_path)
    if cache.get("database_sha256") != actual_database_sha256:
        raise RuntimeError("Cached candidate-analysis database digest does not match its selection.")
    if cache.get("mode") not in {"full-corpus-scan", "reused-candidate-analysis"}:
        raise RuntimeError("Cached selection has an unsupported analysis mode.")

    metadata = producer.read_database_metadata(index)
    cached_index = selection.get("index")
    if not isinstance(cached_index, dict):
        raise RuntimeError("Cached selection has no corpus index metadata.")
    for field in (
        "source_count",
        "document_count",
        "paragraph_count",
        "input_manifest_sha256",
        "logical_rows_sha256",
        "sqlite_version",
    ):
        if str(cached_index.get(field)) != metadata[field]:
            raise RuntimeError(f"Cached selection uses a different corpus index ({field}).")
    if cached_index.get("sample_every_paragraphs") != producer.SAMPLE_EVERY_PARAGRAPHS:
        raise RuntimeError("Cached selection uses a different paragraph sampling interval.")
    if selection.get("permission_record_sha256") != permission_sha256:
        raise RuntimeError("Cached selection uses a different corpus permission record.")

    extractor = selection.get("extractor")
    if not isinstance(extractor, dict):
        raise RuntimeError("Cached selection has no extractor metadata.")
    current_extractor_sha256 = hashlib.sha256(Path(producer.__file__).read_bytes()).hexdigest()
    if extractor.get("extractor_version") != producer.EXTRACTOR_VERSION:
        raise RuntimeError("Cached analysis uses a different morphology extractor version.")
    if extractor.get("script_sha256") not in {
        current_extractor_sha256,
        *producer.REUSABLE_ANALYSIS_SOURCE_DIGESTS,
    }:
        raise RuntimeError("Cached analysis was produced by a different morphology extractor source.")
    if extractor.get("python_version") != sys.version.split()[0]:
        raise RuntimeError("Cached analysis uses a different Python version.")
    if extractor.get("kiwipiepy_version") != producer.installed_package_version("kiwipiepy"):
        raise RuntimeError("Cached analysis uses a different kiwipiepy version.")
    if extractor.get("kiwipiepy_model_version") != producer.installed_package_version("kiwipiepy_model"):
        raise RuntimeError("Cached analysis uses a different Kiwi model version.")
    if extractor.get("eligible_analyzer_tags") != sorted(producer.ELIGIBLE_TAGS):
        raise RuntimeError("Cached analysis uses different eligible analyzer tags.")

    yield_data = selection.get("yield")
    if not isinstance(yield_data, dict):
        raise RuntimeError("Cached selection has no extraction summary.")
    expected_rows = yield_data.get("unique_lemma_pos_candidates_before_coverage")
    if not isinstance(expected_rows, int) or expected_rows < 1:
        raise RuntimeError("Cached selection has no valid candidate row count.")
    try:
        cache_database = producer.open_readonly_database(analysis_path)
        try:
            integrity = cache_database.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError("Cached candidate-analysis database failed SQLite integrity_check.")
            tables = {
                row[0]
                for row in cache_database.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            if not {"candidates", "candidate_surfaces", "candidate_eojeol_forms"}.issubset(tables):
                raise RuntimeError("Cached candidate-analysis database has an unsupported schema.")
            actual_rows = int(cache_database.execute("SELECT COUNT(*) FROM candidates").fetchone()[0])
            actual_lemmas = int(
                cache_database.execute("SELECT COUNT(DISTINCT normalized_lemma) FROM candidates").fetchone()[0]
            )
            if actual_rows != expected_rows:
                raise RuntimeError("Cached candidate-analysis rows do not match the selection summary.")
            if actual_lemmas != yield_data.get("unique_lemma_candidates_before_coverage"):
                raise RuntimeError("Cached candidate-analysis lemmas do not match the selection summary.")
        finally:
            cache_database.close()
    except sqlite3.Error as error:
        raise RuntimeError(f"Cached candidate-analysis database is invalid: {error}") from error

    return {
        "source_database_path": actual_database_path,
        "source_database_sha256": actual_database_sha256,
        "source_selection_path": cache_relative_path(selection_path, "Cached candidate selection"),
        "source_selection_sha256": hashlib.sha256(selection_bytes).hexdigest(),
        "source_extractor_script_sha256": extractor["script_sha256"],
        "source_analysis_elapsed_seconds": (
            cache.get("analysis_elapsed_seconds")
            if isinstance(cache.get("analysis_elapsed_seconds"), (int, float))
            else selection.get("elapsed_seconds")
        ),
    }


def select_from_cached_analysis(
    *,
    analysis_path: Path,
    selection_path: Path,
    dictionary_path: Path,
    index_path: Path,
    staging_path: Path,
    candidate_output_path: Path,
    exclusion_manifest_path: Path,
    candidate_limit: int,
    include_canonical_lemmas: bool = False,
) -> dict:
    started = time.perf_counter()
    producer.validate_candidate_limit(candidate_limit)
    for path in (analysis_path, selection_path, dictionary_path, index_path):
        if not path.is_file():
            raise RuntimeError(f"Required cached analysis input is missing: {path}")
    if analysis_path.resolve() == staging_path.resolve():
        raise RuntimeError("Cached candidate analysis must not be overwritten in place.")

    source_selection, source_selection_bytes = load_json(selection_path, "candidate selection")
    permission_sha256 = producer.read_permission_record(producer.DEFAULT_PERMISSION_RECORD_PATH)
    exclusion = producer.read_exclusion_manifest(exclusion_manifest_path)
    index = producer.open_readonly_database(index_path)
    product = producer.open_readonly_database(dictionary_path)
    staging_path.parent.mkdir(parents=True, exist_ok=True)
    if staging_path.exists():
        staging_path.unlink()

    source_binding = verify_source_cache(
        analysis_path=analysis_path,
        selection_path=selection_path,
        selection=source_selection,
        selection_bytes=source_selection_bytes,
        index=index,
        permission_sha256=permission_sha256,
    )
    source = producer.open_readonly_database(analysis_path)
    destination = sqlite3.connect(staging_path)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()

    staging = sqlite3.connect(staging_path)
    try:
        product_matches = producer.read_product_surface(product)
        product_surface_key_counts = {
            match_kind: sum(
                any(match["match_kind"] == match_kind for match in matches)
                for matches in product_matches.values()
            )
            for match_kind in (
                "canonical_lemma",
                "curated_search_form",
                "generated_surface_form",
            )
        }
        product_metadata = dict(product.execute("SELECT key, value FROM metadata").fetchall())
        # Coverage updates are keyed by normalized_lemma; the extractor's rank index
        # starts with `covered` and cannot serve that lookup without this index.
        staging.execute(
            "CREATE INDEX IF NOT EXISTS idx_candidates_normalized_lemma "
            "ON candidates(normalized_lemma)"
        )
        producer.apply_product_coverage(staging, product_matches)
        cached_selection_database = CachedAnalysisSelectionDatabase(staging)
        candidate_rows = producer.select_candidate_rows(
            cached_selection_database,
            candidate_limit,
            exclusion["lemmas"],
            include_canonical_lemmas,
        )
        cached_selection_database.assert_reused_ambiguity()

        total_candidate_rows = int(staging.execute("SELECT COUNT(*) FROM candidates").fetchone()[0])
        total_candidate_lemmas = int(
            staging.execute("SELECT COUNT(DISTINCT normalized_lemma) FROM candidates").fetchone()[0]
        )
        coverage_status_counts = {
            str(status): int(count)
            for status, count in staging.execute(
                "SELECT coverage_status, COUNT(DISTINCT normalized_lemma) "
                "FROM candidates GROUP BY coverage_status ORDER BY coverage_status COLLATE BINARY"
            ).fetchall()
        }
        exact_lemma_count = coverage_status_counts.get("exact_canonical_lemma", 0)
        search_collision_count = coverage_status_counts.get("search_form_collision", 0)
        generated_collision_count = coverage_status_counts.get("generated_surface_collision", 0)
        combined_collision_count = coverage_status_counts.get("search_and_generated_surface_collision", 0)
        collision_count = search_collision_count + generated_collision_count + combined_collision_count
        ambiguous_lemma_count = int(
            staging.execute(
                """
                SELECT COUNT(*) FROM (
                    SELECT normalized_lemma
                    FROM candidates
                    WHERE ambiguous_surface_count > 0
                       OR normalized_lemma IN (
                           SELECT normalized_lemma FROM candidates
                           GROUP BY normalized_lemma HAVING COUNT(*) > 1
                       )
                    GROUP BY normalized_lemma
                )
                """
            ).fetchone()[0]
        )
        sample_index = source_selection["index"]
        current_index_metadata = producer.read_database_metadata(index)
        current_extractor = source_selection["extractor"]
        source_yield = source_selection["yield"]
        result = {
            "schema_version": 1,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "publication_state": "local_reference_only_pending_owner_publication_confirmation",
            "permission_record_sha256": permission_sha256,
            "index": {
                **sample_index,
                "source_count": int(current_index_metadata["source_count"]),
                "document_count": int(current_index_metadata["document_count"]),
                "paragraph_count": int(current_index_metadata["paragraph_count"]),
                "input_manifest_sha256": current_index_metadata["input_manifest_sha256"],
                "logical_rows_sha256": current_index_metadata["logical_rows_sha256"],
                "sqlite_version": current_index_metadata["sqlite_version"],
                "database_bytes": index_path.stat().st_size,
            },
            "typewriter_surface": {
                "dictionary_version": product_metadata.get("dictionary_version"),
                "canonical_revision": product_metadata.get("canonical_revision"),
                "record_count": int(product_metadata.get("record_count", "0")),
                "search_form_count": int(product_metadata.get("search_form_count", "0")),
                "generated_surface_form_count": int(product_metadata.get("generated_surface_form_count", "0")),
                "normalized_surface_key_count": len(product_matches),
                "normalized_keys_with_canonical_lemmas": product_surface_key_counts["canonical_lemma"],
                "normalized_keys_with_curated_search_forms": product_surface_key_counts["curated_search_form"],
                "normalized_keys_with_generated_surface_forms": product_surface_key_counts["generated_surface_form"],
                "normalization": "Unicode NFC plus surrounding whitespace trim, matching runtime search input",
            },
            "extractor": current_extractor,
            "selection": {
                "exhaustion": producer.selection_exhaustion(staging, candidate_rows, include_canonical_lemmas),
                "contract_version": "m9-corpus-candidate-selection-v1",
                "candidate_limit": candidate_limit,
                "selected_candidate_count": len(candidate_rows),
                "ordering": ORDERING,
                "excluded_candidate_lemma_count": len(exclusion["lemmas"]),
                "exclusion_sha256": exclusion["exclusion_sha256"],
                "exclusion_source_artifacts": exclusion["source_artifacts"],
                **(
                    {
                        "include_canonical_lemmas": True,
                        "selected_lemma_count": len({row["coverage_normalized_key"] for row in candidate_rows}),
                    }
                    if include_canonical_lemmas
                    else {}
                ),
            },
            "yield": {
                **source_yield,
                "unique_lemma_pos_candidates_before_coverage": total_candidate_rows,
                "unique_lemma_candidates_before_coverage": total_candidate_lemmas,
                "exact_canonical_lemma_candidates": exact_lemma_count,
                "candidate_lemmas_without_exact_canonical_match": total_candidate_lemmas - exact_lemma_count,
                "search_form_collision_lemma_candidates": search_collision_count,
                "generated_surface_collision_lemma_candidates": generated_collision_count,
                "search_and_generated_surface_collision_lemma_candidates": combined_collision_count,
                "total_surface_collision_lemma_candidates": collision_count,
                "coverage_status_counts_by_distinct_lemma": coverage_status_counts,
                "exact_lemma_covered_candidate_count": exact_lemma_count,
                "curated_or_generated_surface_collision_candidate_count": collision_count,
                "ambiguous_lemma_candidates_before_coverage": ambiguous_lemma_count,
                "selected_inventory_count": len(candidate_rows),
            },
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "analysis_cache": {
                "mode": "reused-candidate-analysis",
                **source_binding,
                "analysis_elapsed_seconds": source_binding["source_analysis_elapsed_seconds"],
                "selector_script_sha256": sha256_file(Path(__file__)),
            },
            "candidates": candidate_rows,
        }
        candidate_output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = candidate_output_path.with_suffix(candidate_output_path.suffix + ".tmp")
        temporary_output.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_output.replace(candidate_output_path)
        return {
            "sample_paragraphs": result["index"]["sample_paragraph_count"],
            "sample_fraction": result["index"]["sample_fraction"],
            "raw_eligible_morpheme_observations": result["yield"]["accepted_morpheme_observations_in_sample"],
            "unique_lemma_candidates": result["yield"]["unique_lemma_candidates_before_coverage"],
            "exact_canonical_lemma_candidates": exact_lemma_count,
            "candidate_lemmas_without_exact_canonical_match": total_candidate_lemmas - exact_lemma_count,
            "total_surface_collision_lemma_candidates": collision_count,
            "ambiguous_lemma_candidates": ambiguous_lemma_count,
            "selected_inventory_count": len(candidate_rows),
            "elapsed_seconds": result["elapsed_seconds"],
            "analysis_cache_mode": result["analysis_cache"]["mode"],
            "candidate_selection_path": str(candidate_output_path.resolve()),
        }
    finally:
        staging.close()
        product.close()
        index.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analysis-db", required=True, type=Path)
    parser.add_argument("--analysis-selection", required=True, type=Path)
    parser.add_argument("--dictionary", required=True, type=Path)
    parser.add_argument("--index", type=Path, default=producer.DEFAULT_INDEX_PATH)
    parser.add_argument("--staging-db", required=True, type=Path)
    parser.add_argument("--candidate-json", required=True, type=Path)
    parser.add_argument("--exclusion-manifest", required=True, type=Path)
    parser.add_argument("--candidate-limit", type=int, required=True)
    parser.add_argument("--include-canonical-lemmas", action="store_true")
    arguments = parser.parse_args()
    arguments.analysis_db = assert_cache_path(arguments.analysis_db, "runs", "--analysis-db")
    arguments.analysis_selection = assert_cache_path(arguments.analysis_selection, "runs", "--analysis-selection")
    arguments.index = assert_cache_path(arguments.index, "indexes", "--index")
    arguments.staging_db = assert_cache_path(arguments.staging_db, "runs", "--staging-db")
    arguments.candidate_json = assert_cache_path(arguments.candidate_json, "runs", "--candidate-json")
    arguments.exclusion_manifest = assert_cache_path(arguments.exclusion_manifest, "runs", "--exclusion-manifest")
    if len({arguments.staging_db.parent, arguments.candidate_json.parent, arguments.exclusion_manifest.parent}) != 1:
        parser.error("all generated artifacts must stay in one task-scoped cache run directory")
    if arguments.staging_db.exists() or arguments.candidate_json.exists():
        parser.error("run output already exists; choose a fresh Typewriter cache run directory")
    try:
        result = select_from_cached_analysis(
            analysis_path=arguments.analysis_db.resolve(),
            selection_path=arguments.analysis_selection.resolve(),
            dictionary_path=arguments.dictionary.resolve(),
            index_path=arguments.index.resolve(),
            staging_path=arguments.staging_db.resolve(),
            candidate_output_path=arguments.candidate_json.resolve(),
            exclusion_manifest_path=arguments.exclusion_manifest.resolve(),
            candidate_limit=arguments.candidate_limit,
            include_canonical_lemmas=arguments.include_canonical_lemmas,
        )
    except (OSError, ValueError, sqlite3.Error, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
