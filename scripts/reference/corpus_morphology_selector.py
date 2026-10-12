#!/usr/bin/env python3
"""Select Stage 1 candidates from the verified cumulative morphology store."""

from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import corpus_lemma_pilot as producer
import corpus_morphology as morphology
import corpus_morphology_readonly as morphology_readonly
from scripts.python.local_cache import assert_cache_path, cache_relative_path, typewriter_cache_root


SOURCE_CONTRACT = "verified-full-corpus-morphology-source-v1"
PROJECTION_CONTRACT = "corpus-morphology-selection-projection-v1"
EXPECTED_PARAGRAPHS = 4_988_970
EXPECTED_LEMMAS = 221_392
POS_TAGS = {"noun": "NNG", "verb": "VV", "adjective": "VA"}


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(json_bytes(value)).hexdigest()


def sha256_file(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def load_object(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is unreadable: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be a JSON object")
    return value


def cache_root() -> Path:
    root = assert_cache_path(
        typewriter_cache_root() / "runs" / "written-corpus-morphology-selection-v1",
        "runs",
        "Morphology selection cache",
    )
    root.mkdir(parents=True, exist_ok=True)
    return root


def configure_readonly_connection(db: sqlite3.Connection, temporary_directory: Path, *, query_only: bool = True) -> None:
    db.execute(f"PRAGMA query_only={'ON' if query_only else 'OFF'}")
    db.execute("PRAGMA temp_store=FILE")
    escaped = str(temporary_directory).replace("'", "''")
    db.execute(f"PRAGMA temp_store_directory='{escaped}'")
    if db.execute("PRAGMA temp_store_directory").fetchone() != (str(temporary_directory),):
        raise RuntimeError("SQLite cannot keep morphology selection temporary files in the shared cache")


def snapshot_payload(*, result: dict, store_path: Path, seal: dict) -> dict:
    identity = result["identity"]
    return {
        "contract": SOURCE_CONTRACT,
        "store_contract": result["contract"],
        "store_database_path": cache_relative_path(store_path / "analysis.sqlite", "Morphology source database"),
        "store_database_stamp": seal["stamp"],
        "store_seal_sha256": seal["sha256"],
        "source_identity_sha256": morphology.digest(identity),
        "source_identity": identity,
        "completion_bitmap": result["completion_bitmap"],
        "verified_paragraphs": result["verified_paragraphs"],
        "total_paragraphs": result["total_paragraphs"],
        "cumulative_unique_lemmas": result["cumulative_unique_lemmas"],
        "slice_publications": [
            {
                "slice": item["slice"],
                "complete": item["complete"],
                "expected_paragraphs": item["expected_paragraphs"],
                "new_unique_lemmas": item["new_unique_lemmas"],
                "cumulative_unique_lemmas": item["cumulative_unique_lemmas"],
                "publication_sha256": item["publication_sha256"],
            }
            for item in result["slices"]
        ],
    }


def assert_complete_full_corpus(result: dict) -> None:
    if result.get("contract") != morphology.CONTRACT:
        raise RuntimeError("Morphology store has an unsupported contract")
    if result.get("completion_bitmap") != "1" * morphology.SLICE_COUNT:
        raise RuntimeError("Morphology source is partial; verify all 20 slices before candidate selection")
    if (result.get("verified_paragraphs"), result.get("total_paragraphs")) != (
        EXPECTED_PARAGRAPHS,
        EXPECTED_PARAGRAPHS,
    ):
        raise RuntimeError("Morphology source does not cover the verified 4,988,970-paragraph corpus")
    if result.get("cumulative_unique_lemmas") != EXPECTED_LEMMAS:
        raise RuntimeError("Morphology source lemma total differs from the verified 221,392-lemma corpus")
    if len(result.get("slices", [])) != morphology.SLICE_COUNT:
        raise RuntimeError("Morphology source does not report all 20 slice publications")
    if any(not item.get("complete") or not item.get("publication_sha256") for item in result["slices"]):
        raise RuntimeError("Morphology source has a missing slice publication")


def verify_store(*, store_path: Path, index_path: Path, scratch_path: Path, proof: dict | None = None,
                 expected_snapshot: str | None = None, full_audit: bool = False) -> tuple[dict, dict]:
    """Verify current store state and reuse only a still-bound complete audit proof."""
    store_path = assert_cache_path(store_path, "runs", "Morphology store")
    index_path = assert_cache_path(index_path, "indexes", "Corpus index")
    database_path = store_path / "analysis.sqlite"
    if not database_path.is_file():
        raise RuntimeError("Verified morphology analysis.sqlite is missing")
    morphology.check_seal(store_path)
    seal = load_object(store_path / "seal.json", "Morphology store seal")
    runtime = morphology.runtime_identity()

    with closing(producer.open_readonly_database(database_path)) as db:
        configure_readonly_connection(db, scratch_path)
        manifest_rows = db.execute("SELECT payload FROM manifest").fetchall()
        if len(manifest_rows) != 1:
            raise RuntimeError("Morphology store has a corrupt manifest")
        recorded_identity = json.loads(manifest_rows[0][0])["identity"]
        fast_identity = morphology.fast_identity(
            index_path,
            morphology.DEFAULT_PERMISSION_RECORD_PATH,
            runtime,
            recorded_identity,
        )
        db.execute("BEGIN")
        morphology.check_seal(store_path)
        morphology.verify(db, fast_identity, current_only=True)
        current = morphology.status(db, store_path)
        db.rollback()
        morphology.check_seal(store_path)
        assert_complete_full_corpus(current)
        payload = snapshot_payload(result=current, store_path=store_path, seal=seal)
        snapshot_sha256 = digest(payload)
        if expected_snapshot and snapshot_sha256 != expected_snapshot:
            raise RuntimeError("Morphology source snapshot changed since the initial Stage 1 selection")

        proof_is_current = (
            not full_audit
            and isinstance(proof, dict)
            and proof.get("validation") == "full-audit-passed-read-only"
            and proof.get("source_snapshot_sha256") == snapshot_sha256
            and {key: value for key, value in proof.items() if key not in {"validation", "source_snapshot_sha256"}} == payload
        )
        if not proof_is_current:
            audited = morphology_readonly.inspect_readonly(
                index_path=index_path,
                directory=store_path,
                runtime=runtime,
                temporary_directory=scratch_path,
            )
            assert_complete_full_corpus(audited)
            audited_seal = load_object(store_path / "seal.json", "Morphology store seal")
            audited_payload = snapshot_payload(result=audited, store_path=store_path, seal=audited_seal)
            audited_snapshot = digest(audited_payload)
            if audited_snapshot != snapshot_sha256:
                raise RuntimeError("Morphology source changed during its full read-only audit")
            current = audited
            payload = audited_payload
            snapshot_sha256 = audited_snapshot
            seal = audited_seal

    proof = {**payload, "source_snapshot_sha256": snapshot_sha256,
             "validation": "full-audit-passed-read-only"}
    return current, proof


def assert_source_binding_current(*, store_path: Path, index_path: Path, proof: dict) -> None:
    """Reject a store/index change that races projection or candidate selection."""
    morphology.check_seal(store_path)
    seal = load_object(store_path / "seal.json", "Morphology store seal")
    if (seal.get("stamp") != proof.get("store_database_stamp")
            or seal.get("sha256") != proof.get("store_seal_sha256")):
        raise RuntimeError("Morphology store seal changed after its full audit")
    identity = proof.get("source_identity")
    if not isinstance(identity, dict):
        raise RuntimeError("Morphology audit proof has no source identity")
    morphology.require_rollback_header(index_path)
    if (identity.get("index_path") != str(index_path.resolve())
            or identity.get("index_stamp") != morphology.file_stamp(index_path)
            or identity.get("permission_sha256") != morphology.read_permission_record(
                morphology.DEFAULT_PERMISSION_RECORD_PATH
            )):
        raise RuntimeError("Corpus index or permission record changed after its full audit")
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(index_path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError("Corpus index has a live journal/WAL after its full audit")
    morphology.check_seal(store_path)
    final_seal = load_object(store_path / "seal.json", "Morphology store seal")
    if final_seal != seal:
        raise RuntimeError("Morphology store seal changed during candidate selection")


def projection_manifest_path(directory: Path) -> Path:
    return directory / "projection-manifest.json"


def projection_algorithm_identity() -> dict:
    return {
        "selector_script_sha256": sha256_file(Path(__file__)),
        "candidate_producer_sha256": sha256_file(Path(producer.__file__)),
    }


def read_projection_manifest(directory: Path, source_snapshot: str) -> dict | None:
    path = projection_manifest_path(directory)
    if not path.exists():
        return None
    manifest = load_object(path, "Morphology selection projection manifest")
    recorded_digest = manifest.pop("manifest_sha256", None)
    if recorded_digest != digest(manifest):
        raise RuntimeError("Morphology selection projection manifest digest mismatch")
    manifest["manifest_sha256"] = recorded_digest
    if manifest.get("contract") != PROJECTION_CONTRACT:
        raise RuntimeError("Morphology selection projection has an unsupported contract")
    if manifest.get("source_snapshot_sha256") != source_snapshot:
        raise RuntimeError("Morphology selection projection is bound to a different source snapshot")
    if manifest.get("algorithm_identity") != projection_algorithm_identity():
        raise RuntimeError("Morphology selection projection was built by different selector code")
    proof = manifest.get("audit_evidence")
    if (not isinstance(proof, dict) or proof.get("validation") != "full-audit-passed-read-only"
            or proof.get("source_snapshot_sha256") != source_snapshot):
        raise RuntimeError("Morphology selection projection has no matching full-audit evidence")
    return manifest


def write_projection_manifest(path: Path, manifest: dict) -> None:
    payload = dict(manifest)
    payload["manifest_sha256"] = digest(manifest)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n")
    os.replace(temporary, path)


def _batched(cursor, size: int = 2048):
    while True:
        rows = cursor.fetchmany(size)
        if not rows:
            return
        yield rows


def build_projection(*, source_path: Path, projection_path: Path, temporary_directory: Path,
                     source_snapshot: str, expected_lemmas: int | None = EXPECTED_LEMMAS) -> dict:
    temporary_path = projection_path.with_name(f"{projection_path.name}.tmp-{os.getpid()}")
    temporary_path.unlink(missing_ok=True)
    counts = {"candidate_rows": 0, "candidate_lemmas": 0, "candidate_surfaces": 0, "candidate_eojeol_forms": 0}
    previous_lemma = None
    with closing(producer.open_readonly_database(source_path)) as source, closing(sqlite3.connect(temporary_path)) as output:
        configure_readonly_connection(source, temporary_directory)
        output.execute("PRAGMA temp_store=FILE")
        escaped = str(temporary_directory).replace("'", "''")
        output.execute(f"PRAGMA temp_store_directory='{escaped}'")
        producer.create_staging_schema(output)
        output.execute("BEGIN")

        cursor = source.execute("""
            SELECT lemma,pos,token_count,oov_token_count,paragraph_hits,document_count,source_count,
                   max_source_token_count,pos_interpretation_count,ambiguous_surface_count
            FROM lemma_statistics WHERE kind=0
            ORDER BY lemma COLLATE BINARY,pos COLLATE BINARY
        """)
        for rows in _batched(cursor):
            values = []
            for (lemma, pos, tokens, oov, hits, documents, sources, max_source,
                 pos_count, ambiguous_surfaces) in rows:
                if pos not in POS_TAGS or producer.KOREAN_LEMMA.fullmatch(lemma) is None:
                    raise RuntimeError("Morphology store contains a lemma/POS outside the pinned candidate contract")
                values.append((lemma, producer.normalize_search_form(lemma), pos, POS_TAGS[pos],
                               tokens, oov, hits, documents, sources, max_source, 0,
                               "uncovered", "[]", ambiguous_surfaces))
                counts["candidate_rows"] += 1
                if lemma != previous_lemma:
                    counts["candidate_lemmas"] += 1
                    previous_lemma = lemma
            output.executemany("""
                INSERT INTO candidates(lemma,normalized_lemma,pos,analyzer_tag,token_count,oov_token_count,
                    paragraph_hits,document_count,source_count,max_source_token_count,covered,coverage_status,
                    coverage_matches_json,ambiguous_surface_count)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, values)

        surfaces = source.execute("""
            SELECT totals.lemma,totals.pos,totals.form,totals.token_count,totals.paragraph_hits,
                   totals.document_count,totals.source_count,totals.max_source_token_count,
                   interpretations.interpretation_count
            FROM morphology_totals AS totals
            JOIN surface_interpretations AS interpretations USING(form)
            WHERE totals.kind=1
            ORDER BY totals.lemma COLLATE BINARY,totals.pos COLLATE BINARY,
                     totals.token_count DESC,totals.paragraph_hits DESC,totals.form COLLATE BINARY
        """)
        key = None
        rank = 0
        for rows in _batched(surfaces):
            values = []
            for lemma, pos, form, tokens, hits, documents, sources, max_source, interpretations in rows:
                current_key = (lemma, pos)
                rank = rank + 1 if current_key == key else 1
                key = current_key
                if rank <= producer.TOP_SURFACE_FORMS:
                    values.append((lemma, pos, form, tokens, hits, documents, sources, max_source, interpretations))
            output.executemany("INSERT INTO candidate_surfaces VALUES(?,?,?,?,?,?,?,?,?)", values)
            counts["candidate_surfaces"] += len(values)

        eojeols = source.execute("""
            SELECT lemma,pos,form,token_count,paragraph_hits,document_count,source_count,max_source_token_count
            FROM morphology_totals WHERE kind=2
            ORDER BY lemma COLLATE BINARY,pos COLLATE BINARY,
                     token_count DESC,paragraph_hits DESC,form COLLATE BINARY
        """)
        key = None
        rank = 0
        for rows in _batched(eojeols):
            values = []
            for lemma, pos, form, tokens, hits, documents, sources, max_source in rows:
                current_key = (lemma, pos)
                rank = rank + 1 if current_key == key else 1
                key = current_key
                if rank <= producer.TOP_SURFACE_FORMS:
                    values.append((lemma, pos, form, tokens, hits, documents, sources, max_source))
            output.executemany("INSERT INTO candidate_eojeol_forms VALUES(?,?,?,?,?,?,?,?)", values)
            counts["candidate_eojeol_forms"] += len(values)

        output.commit()
        output.execute("PRAGMA optimize")
        integrity = output.execute("PRAGMA integrity_check").fetchone()
        if integrity != ("ok",):
            raise RuntimeError("Morphology selection projection failed SQLite integrity_check")
        if expected_lemmas is not None and counts["candidate_lemmas"] != expected_lemmas:
            raise RuntimeError("Morphology selection projection lemma count differs from the verified source")
        output.close()
    os.replace(temporary_path, projection_path)
    return counts


def verify_projection(*, directory: Path, source_snapshot: str) -> dict:
    manifest = read_projection_manifest(directory, source_snapshot)
    if manifest is None:
        return None
    projection_path = directory / "selection.sqlite"
    if not projection_path.is_file() or sha256_file(projection_path) != manifest.get("projection_database_sha256"):
        raise RuntimeError("Morphology selection projection database digest mismatch")
    with closing(producer.open_readonly_database(projection_path)) as db:
        integrity = db.execute("PRAGMA quick_check").fetchone()
        if integrity != ("ok",):
            raise RuntimeError("Morphology selection projection failed SQLite quick_check")
        actual_counts = {
            "candidate_rows": db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0],
            "candidate_lemmas": db.execute("SELECT COUNT(DISTINCT normalized_lemma) FROM candidates").fetchone()[0],
            "candidate_surfaces": db.execute("SELECT COUNT(*) FROM candidate_surfaces").fetchone()[0],
            "candidate_eojeol_forms": db.execute("SELECT COUNT(*) FROM candidate_eojeol_forms").fetchone()[0],
        }
    if actual_counts != manifest.get("row_counts"):
        raise RuntimeError("Morphology selection projection row counts differ from its manifest")
    return manifest


def projection_for_source(*, store_path: Path, source_proof: dict, root: Path) -> tuple[Path, dict]:
    source_snapshot = source_proof["source_snapshot_sha256"]
    assert_source_binding_current(store_path=store_path, index_path=Path(source_proof["source_identity"]["index_path"]),
                                  proof=source_proof)
    directory = assert_cache_path(root / source_snapshot, "runs", "Morphology selection projection")
    directory.mkdir(parents=True, exist_ok=True)
    projection_path = directory / "selection.sqlite"
    manifest = verify_projection(directory=directory, source_snapshot=source_snapshot)
    if manifest is None:
        row_counts = build_projection(
            source_path=store_path / "analysis.sqlite",
            projection_path=projection_path,
            temporary_directory=directory,
            source_snapshot=source_snapshot,
        )
        manifest = {
            "contract": PROJECTION_CONTRACT,
            "source_snapshot_sha256": source_snapshot,
            "algorithm_identity": projection_algorithm_identity(),
            "audit_evidence": source_proof,
            "projection_database_path": cache_relative_path(projection_path, "Morphology selection projection"),
            "projection_database_sha256": sha256_file(projection_path),
            "row_counts": row_counts,
        }
        write_projection_manifest(projection_manifest_path(directory), manifest)
        manifest["manifest_sha256"] = digest(manifest)
    assert_source_binding_current(store_path=store_path,
                                  index_path=Path(source_proof["source_identity"]["index_path"]),
                                  proof=source_proof)
    return projection_path, manifest


def coverage_metrics(staging: sqlite3.Connection, candidate_rows: list[dict]) -> tuple[dict, int, int]:
    counts = {
        str(status): int(count)
        for status, count in staging.execute(
            "SELECT coverage_status,COUNT(DISTINCT normalized_lemma) FROM candidates "
            "GROUP BY coverage_status ORDER BY coverage_status COLLATE BINARY"
        ).fetchall()
    }
    exact = counts.get("exact_canonical_lemma", 0)
    collisions = sum(counts.get(key, 0) for key in (
        "search_form_collision", "generated_surface_collision", "search_and_generated_surface_collision"))
    ambiguous = int(staging.execute("""
        SELECT COUNT(*) FROM (
            SELECT normalized_lemma FROM candidates
            WHERE ambiguous_surface_count > 0 OR normalized_lemma IN (
                SELECT normalized_lemma FROM candidates GROUP BY normalized_lemma HAVING COUNT(*) > 1
            ) GROUP BY normalized_lemma
        )
    """).fetchone()[0])
    return counts, exact, collisions


def select_from_morphology_store(*, store_path: Path, dictionary_path: Path, index_path: Path,
                                 candidate_output_path: Path, exclusion_manifest_path: Path | None,
                                 candidate_limit: int, include_canonical_lemmas: bool = False,
                                 expected_source_snapshot: str | None = None) -> dict:
    started = time.perf_counter()
    producer.validate_candidate_limit(candidate_limit)
    store_path = assert_cache_path(store_path, "runs", "Morphology store")
    dictionary_path = Path(dictionary_path).expanduser().resolve()
    if not dictionary_path.is_file():
        raise RuntimeError("Temporary canonical dictionary is missing")
    index_path = assert_cache_path(index_path, "indexes", "Corpus index")
    candidate_output_path = assert_cache_path(candidate_output_path, "runs", "Candidate selection output")
    if candidate_output_path.exists():
        raise RuntimeError("Candidate selection output already exists; choose a fresh Typewriter cache run directory")
    root = cache_root()
    scratch = root / "verification"
    scratch.mkdir(parents=True, exist_ok=True)

    fast_result, fast_proof = verify_store(
        store_path=store_path,
        index_path=index_path,
        scratch_path=scratch,
        expected_snapshot=expected_source_snapshot,
    )
    snapshot_sha = fast_proof["source_snapshot_sha256"]
    directory = assert_cache_path(root / snapshot_sha, "runs", "Morphology selection projection")
    existing_manifest = read_projection_manifest(directory, snapshot_sha) if directory.exists() else None
    proof = existing_manifest.get("audit_evidence") if existing_manifest else None
    if proof is None:
        # A first selection establishes full read-only audit evidence. A later
        # page may reuse it only after the current seal/identity still matches.
        result, proof = verify_store(
            store_path=store_path,
            index_path=index_path,
            scratch_path=scratch,
            expected_snapshot=expected_source_snapshot or snapshot_sha,
            full_audit=True,
        )
    else:
        result, proof = verify_store(
            store_path=store_path,
            index_path=index_path,
            scratch_path=scratch,
            proof=proof,
            expected_snapshot=expected_source_snapshot,
        )
    assert_complete_full_corpus(result)

    projection_path, projection_manifest = projection_for_source(
        store_path=store_path,
        source_proof=proof,
        root=root,
    )
    exclusion = producer.read_exclusion_manifest(exclusion_manifest_path)
    product = producer.open_readonly_database(dictionary_path)
    staging = producer.open_readonly_database(projection_path)
    try:
        configure_readonly_connection(staging, projection_path.parent, query_only=False)
        staging.execute("CREATE TEMP TABLE candidates AS SELECT * FROM main.candidates")
        staging.execute("CREATE INDEX temp.idx_candidates_coverage_rank "
                        "ON candidates(covered,normalized_lemma,source_count,document_count,token_count)")
        staging.execute("CREATE TEMP VIEW candidate_surfaces AS SELECT * FROM main.candidate_surfaces")
        staging.execute("CREATE TEMP VIEW candidate_eojeol_forms AS SELECT * FROM main.candidate_eojeol_forms")
        product_matches = producer.read_product_surface(product)
        producer.apply_product_coverage(staging, product_matches)
        candidate_rows = producer.select_candidate_rows(
            staging,
            candidate_limit,
            exclusion["lemmas"],
            include_canonical_lemmas,
            precomputed_ambiguity=True,
        )
        total_candidate_rows = int(staging.execute("SELECT COUNT(*) FROM candidates").fetchone()[0])
        total_candidate_lemmas = int(staging.execute(
            "SELECT COUNT(DISTINCT normalized_lemma) FROM candidates").fetchone()[0])
        coverage_status_counts, exact_lemma_count, collision_count = coverage_metrics(staging, candidate_rows)
        ambiguous_lemma_count = int(staging.execute("""
            SELECT COUNT(*) FROM (
                SELECT normalized_lemma FROM candidates
                WHERE ambiguous_surface_count > 0 OR normalized_lemma IN (
                    SELECT normalized_lemma FROM candidates GROUP BY normalized_lemma HAVING COUNT(*) > 1
                ) GROUP BY normalized_lemma
            )
        """).fetchone()[0])
        oov_lemma_count = int(staging.execute(
            "SELECT COUNT(*) FROM candidates WHERE oov_token_count > 0").fetchone()[0])
        typewriter_metadata = dict(product.execute("SELECT key,value FROM metadata").fetchall())
        source_identity = proof["source_identity"]
        index_metadata = source_identity["index_metadata"]
        accepted = sum(int(item["accepted_morphemes"]) for item in result["slices"])
        eligible = accepted + sum(int(item["rejected_lemma_shapes"]) + int(item["rejected_spans"])
                                  for item in result["slices"])
        projected_accepted = int(staging.execute("SELECT COALESCE(SUM(token_count),0) FROM candidates").fetchone()[0])
        if projected_accepted != accepted:
            raise RuntimeError("Morphology selection projection token total differs from the audited slice summaries")
        yield_data = {
            "eligible_pos_token_observations_before_shape_filter": eligible,
            "accepted_morpheme_observations_in_sample": accepted,
            "rejected_lemma_shape_observations": sum(int(item["rejected_lemma_shapes"]) for item in result["slices"]),
            "rejected_span_observations": sum(int(item["rejected_spans"]) for item in result["slices"]),
            "unique_lemma_pos_candidates_before_coverage": total_candidate_rows,
            "unique_lemma_candidates_before_coverage": total_candidate_lemmas,
            "exact_canonical_lemma_candidates": exact_lemma_count,
            "candidate_lemmas_without_exact_canonical_match": total_candidate_lemmas - exact_lemma_count,
            "search_form_collision_lemma_candidates": coverage_status_counts.get("search_form_collision", 0),
            "generated_surface_collision_lemma_candidates": coverage_status_counts.get("generated_surface_collision", 0),
            "search_and_generated_surface_collision_lemma_candidates": coverage_status_counts.get("search_and_generated_surface_collision", 0),
            "total_surface_collision_lemma_candidates": collision_count,
            "coverage_status_counts_by_distinct_lemma": coverage_status_counts,
            "exact_lemma_covered_candidate_count": exact_lemma_count,
            "curated_or_generated_surface_collision_candidate_count": collision_count,
            "ambiguous_lemma_candidates_before_coverage": ambiguous_lemma_count,
            "oov_lemma_candidates_before_coverage": oov_lemma_count,
            "selected_inventory_count": len(candidate_rows),
            "selected_count": 0,
            "admitted_count": 0,
            "correction_rate": "NOT_MEASURED_NO_HUMAN_REVIEW",
            "editorial_workload": "NOT_MEASURED_NO_WRITER_REVIEW",
            "extraction_error_classes": [
                "one-best morphology can misclassify unknown or context-ambiguous forms",
                "compound segmentation can surface morphemes that still need lexical-boundary review",
                "POS and lemma confidence have no calibrated score in this pilot",
            ],
        }
        selection = {
            "schema_version": 1,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "publication_state": "local_reference_only_pending_owner_publication_confirmation",
            "permission_record_sha256": source_identity["permission_sha256"],
            "index": {
                "source_count": int(index_metadata["source_count"]),
                "document_count": int(index_metadata["document_count"]),
                "paragraph_count": int(index_metadata["paragraph_count"]),
                "input_manifest_sha256": index_metadata["input_manifest_sha256"],
                "logical_rows_sha256": index_metadata["logical_rows_sha256"],
                "sqlite_version": index_metadata["sqlite_version"],
                "database_bytes": Path(index_path).stat().st_size,
                "sample_policy": "complete verified 20-slice corpus; no paragraph subsampling",
                "sample_every_paragraphs": 1,
                "sample_paragraph_count": result["verified_paragraphs"],
                "sample_fraction": 1.0,
                "sample_document_count": int(index_metadata["document_count"]),
                "sample_source_count": int(index_metadata["source_count"]),
            },
            "typewriter_surface": {
                "dictionary_version": typewriter_metadata.get("dictionary_version"),
                "canonical_revision": typewriter_metadata.get("canonical_revision"),
                "record_count": int(typewriter_metadata.get("record_count", "0")),
                "search_form_count": int(typewriter_metadata.get("search_form_count", "0")),
                "generated_surface_form_count": int(typewriter_metadata.get("generated_surface_form_count", "0")),
                "normalized_surface_key_count": len(product_matches),
                "normalized_keys_with_canonical_lemmas": sum(any(m["match_kind"] == "canonical_lemma" for m in rows) for rows in product_matches.values()),
                "normalized_keys_with_curated_search_forms": sum(any(m["match_kind"] == "curated_search_form" for m in rows) for rows in product_matches.values()),
                "normalized_keys_with_generated_surface_forms": sum(any(m["match_kind"] == "generated_surface_form" for m in rows) for rows in product_matches.values()),
                "normalization": "Unicode NFC plus surrounding whitespace trim, matching runtime search input",
            },
            "extractor": {
                "name": "Kiwi morphological analyzer via verified cumulative morphology store",
                "extractor_version": morphology.CONTRACT,
                "python_version": source_identity["runtime"]["python"].split()[0],
                "kiwipiepy_version": source_identity["runtime"]["packages"]["kiwipiepy"]["version"],
                "kiwipiepy_model_version": source_identity["runtime"]["packages"]["kiwipiepy_model"]["version"],
                "script_sha256": source_identity["algorithm_sha256"],
                "eligible_analyzer_tags": sorted(producer.ELIGIBLE_TAGS),
                "tag_to_typewriter_pos": producer.ELIGIBLE_TAGS,
                "predicate_lemma_rule": "VV and VA morpheme forms receive the citation ending 다; NNG forms remain unchanged",
                "minimum_lemma_shape": "two or more precomposed Hangul syllables",
                "confidence": "not calibrated; Kiwi one-best output is a proposal",
                "source_contract": SOURCE_CONTRACT,
                "source_snapshot_sha256": proof["source_snapshot_sha256"],
            },
            "selection": {
                "exhaustion": producer.selection_exhaustion(staging, candidate_rows, include_canonical_lemmas),
                "contract_version": "m9-corpus-candidate-selection-v1",
                "candidate_limit": candidate_limit,
                "selected_candidate_count": len(candidate_rows),
                "ordering": ["source_count descending", "document_count descending",
                             "analyzer_morpheme_observations_in_sample descending", "lemma Unicode binary ascending"],
                "excluded_candidate_lemma_count": len(exclusion["lemmas"]),
                "exclusion_sha256": exclusion["exclusion_sha256"],
                "exclusion_source_artifacts": exclusion["source_artifacts"],
                "source_snapshot_sha256": proof["source_snapshot_sha256"],
                **({"include_canonical_lemmas": True,
                    "selected_lemma_count": len({row["coverage_normalized_key"] for row in candidate_rows})}
                   if include_canonical_lemmas else {}),
            },
            "yield": yield_data,
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "analysis_cache": {
                "mode": "verified-full-corpus-morphology-v1",
                "source_store_path": cache_relative_path(store_path, "Morphology source store"),
                "source_database_path": proof["store_database_path"],
                "source_database_bytes": (store_path / "analysis.sqlite").stat().st_size,
                "source_snapshot_sha256": proof["source_snapshot_sha256"],
                "source_identity_sha256": proof["source_identity_sha256"],
                "completion_bitmap": proof["completion_bitmap"],
                "verified_paragraphs": proof["verified_paragraphs"],
                "total_paragraphs": proof["total_paragraphs"],
                "validation": proof["validation"],
                "audit_evidence": proof,
                "selection_projection_contract": PROJECTION_CONTRACT,
                "selection_projection_path": projection_manifest["projection_database_path"],
                "selection_projection_sha256": projection_manifest["projection_database_sha256"],
                "selector_script_sha256": sha256_file(Path(__file__)),
            },
            "candidates": candidate_rows,
        }
        assert_source_binding_current(store_path=store_path, index_path=index_path, proof=proof)
        candidate_output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = candidate_output_path.with_suffix(candidate_output_path.suffix + ".tmp")
        temporary_output.write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary_output, candidate_output_path)
        return selection
    finally:
        staging.close()
        product.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--dictionary", required=True, type=Path)
    parser.add_argument("--index", type=Path, default=morphology.DEFAULT_INDEX)
    parser.add_argument("--candidate-json", required=True, type=Path)
    parser.add_argument("--candidate-limit", required=True, type=int)
    parser.add_argument("--exclusion-manifest", type=Path)
    parser.add_argument("--include-canonical-lemmas", action="store_true")
    parser.add_argument("--expected-source-snapshot", type=str)
    arguments = parser.parse_args()
    if arguments.expected_source_snapshot and len(arguments.expected_source_snapshot) != 64:
        parser.error("--expected-source-snapshot must be a SHA-256 digest")
    result = select_from_morphology_store(
        store_path=arguments.store,
        dictionary_path=arguments.dictionary,
        index_path=arguments.index,
        candidate_output_path=arguments.candidate_json,
        exclusion_manifest_path=arguments.exclusion_manifest,
        candidate_limit=arguments.candidate_limit,
        include_canonical_lemmas=arguments.include_canonical_lemmas,
        expected_source_snapshot=arguments.expected_source_snapshot,
    )
    print(json.dumps({
        "sample_paragraphs": result["index"]["sample_paragraph_count"],
        "sample_fraction": result["index"]["sample_fraction"],
        "raw_eligible_morpheme_observations": result["yield"]["accepted_morpheme_observations_in_sample"],
        "unique_lemma_candidates": result["yield"]["unique_lemma_candidates_before_coverage"],
        "selected_inventory_count": result["selection"]["selected_candidate_count"],
        "remaining_lemma_count": result["selection"]["exhaustion"]["remaining_lemma_count"],
        "elapsed_seconds": result["elapsed_seconds"],
        "source_snapshot_sha256": result["analysis_cache"]["source_snapshot_sha256"],
        "validation": result["analysis_cache"]["validation"],
        "candidate_selection_path": str(arguments.candidate_json.resolve()),
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
