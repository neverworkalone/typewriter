#!/usr/bin/env python3
"""Select Stage 1 candidates from the verified cumulative morphology store."""

from __future__ import annotations

import argparse
import ast
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
PROJECTION_SURFACE_AMBIGUITY_SQL = """
    SELECT DISTINCT form,lemma,pos
    FROM facts
    WHERE kind=1 AND slice IN (SELECT slice FROM slices WHERE complete=1)
    ORDER BY form COLLATE BINARY,lemma COLLATE BINARY,pos COLLATE BINARY
"""
PROJECTION_MORPHOLOGY_TOTALS_SQL = """
    SELECT kind,lemma,pos,form,token_count,oov_token_count,paragraph_hits,document_count,
           source_count,max_source_token_count
    FROM morphology_totals
    ORDER BY kind,lemma COLLATE BINARY,pos COLLATE BINARY,
             token_count DESC,paragraph_hits DESC,form COLLATE BINARY
"""
EXPECTED_PARAGRAPHS = 4_988_970
EXPECTED_LEMMAS = 221_392
POS_TAGS = {"noun": "NNG", "verb": "VV", "adjective": "VA"}
PROJECTION_BUILDER_COMPONENTS = (
    "PROJECTION_CONTRACT",
    "PROJECTION_SURFACE_AMBIGUITY_SQL",
    "PROJECTION_MORPHOLOGY_TOTALS_SQL",
    "POS_TAGS",
    "PROJECTION_BUILDER_COMPONENTS",
    "projection_builder_sha256",
    "projection_directory",
    "_batched",
    "configure_readonly_connection",
    "surface_ambiguity_counts",
    "build_projection",
)


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
        raise RuntimeError("Morphology source is partial; candidate selection requires all 20 completed slices")
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


def verify_store(*, store_path: Path, index_path: Path, scratch_path: Path,
                 expected_snapshot: str | None = None) -> tuple[dict, dict]:
    """Bind the completed store to its current inputs without re-auditing its slices."""
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
        # The store keeps the permission-document digest recorded when its
        # analysis was produced. Recheck today's machine-readable permissions,
        # but do not replace or compare that historical digest: policy prose
        # can change while the permitted local-use fields remain unchanged.
        current_permission_sha256 = morphology.read_permission_record(
            morphology.DEFAULT_PERMISSION_RECORD_PATH
        )
        current_binding_identity = {**recorded_identity, "permission_sha256": current_permission_sha256}
        morphology.fast_identity(
            index_path,
            morphology.DEFAULT_PERMISSION_RECORD_PATH,
            runtime,
            current_binding_identity,
        )
        db.execute("BEGIN")
        morphology.check_seal(store_path)
        # Keep validating the manifest against its recorded identity. The
        # temporary current-binding copy above is never persisted or emitted.
        morphology.verify(db, recorded_identity, current_only=True)
        current = morphology.status(db, store_path)
        db.rollback()
        morphology.check_seal(store_path)
        assert_complete_full_corpus(current)
        payload = snapshot_payload(result=current, store_path=store_path, seal=seal)
        snapshot_sha256 = digest(payload)
        if expected_snapshot and snapshot_sha256 != expected_snapshot:
            raise RuntimeError("Morphology source snapshot changed since the initial Stage 1 selection")
    store_evidence = {
        **payload,
        "source_snapshot_sha256": snapshot_sha256,
        "validation": "completed-store-reused-v1",
    }
    return current, store_evidence


def assert_source_binding_current(*, store_path: Path, index_path: Path, proof: dict) -> None:
    """Reject a store/index or permission change that races candidate selection."""
    morphology.check_seal(store_path)
    seal = load_object(store_path / "seal.json", "Morphology store seal")
    if (seal.get("stamp") != proof.get("store_database_stamp")
            or seal.get("sha256") != proof.get("store_seal_sha256")):
        raise RuntimeError("Morphology store seal changed after completed-store validation")
    identity = proof.get("source_identity")
    if not isinstance(identity, dict):
        raise RuntimeError("Completed-store evidence has no source identity")
    morphology.require_rollback_header(index_path)
    if (identity.get("index_path") != str(index_path.resolve())
            or identity.get("index_stamp") != morphology.file_stamp(index_path)
            ):
        raise RuntimeError("Corpus index changed after completed-store validation")
    # This is an authorization check, not a comparison with the historical
    # permission-document digest retained in the store manifest.
    morphology.read_permission_record(morphology.DEFAULT_PERMISSION_RECORD_PATH)
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(index_path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError("Corpus index has a live journal/WAL after completed-store validation")
    morphology.check_seal(store_path)
    final_seal = load_object(store_path / "seal.json", "Morphology store seal")
    if final_seal != seal:
        raise RuntimeError("Morphology store seal changed during candidate selection")


def projection_manifest_path(directory: Path) -> Path:
    return directory / "projection-manifest.json"


def projection_algorithm_identity() -> dict:
    return {
        "selector_script_sha256": sha256_file(Path(__file__)),
        "projection_builder_sha256": projection_builder_sha256(),
        "candidate_producer_sha256": sha256_file(Path(producer.__file__)),
        "readonly_auditor_sha256": sha256_file(Path(morphology_readonly.__file__)),
    }


def projection_builder_sha256() -> str:
    """Identify only code and constants that determine the selection projection."""
    source = Path(__file__).read_text(encoding="utf-8")
    module = ast.parse(source)
    definitions = {}
    for node in module.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            definitions[node.name] = node
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    definitions[target.id] = node
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            definitions[node.target.id] = node

    # Keep orchestration edits out of this identity so an existing projection
    # remains reusable. Include the builder and its local inputs so changes to
    # projection rows or their schema use a fresh cache directory automatically.
    segments = {}
    for name in PROJECTION_BUILDER_COMPONENTS:
        node = definitions.get(name)
        segment = ast.get_source_segment(source, node) if node is not None else None
        if not segment:
            raise RuntimeError(f"Morphology projection builder identity is missing {name}")
        segments[name] = segment
    return hashlib.sha256(json_bytes(segments)).hexdigest()


def projection_directory(root: Path, source_snapshot: str) -> Path:
    identity = projection_algorithm_identity()
    return assert_cache_path(
        root / source_snapshot / identity["projection_builder_sha256"] / identity["candidate_producer_sha256"],
        "runs",
        "Morphology selection projection",
    )


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
    current_algorithm = projection_algorithm_identity()
    recorded_algorithm = manifest.get("algorithm_identity")
    # Selector orchestration and the read-only audit implementation do not
    # determine projection rows. Bind reuse to the builder and its data
    # producer, while the DB digest below binds the produced projection.
    if (not isinstance(recorded_algorithm, dict)
            or any(recorded_algorithm.get(key) != current_algorithm.get(key)
                   for key in ("projection_builder_sha256", "candidate_producer_sha256"))):
        raise RuntimeError("Morphology selection projection was built by different builder or producer code")
    source_evidence = manifest.get("store_evidence") or manifest.get("audit_evidence")
    if (not isinstance(source_evidence, dict)
            or source_evidence.get("source_snapshot_sha256") != source_snapshot):
        raise RuntimeError("Morphology selection projection has no matching completed-store evidence")
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


def surface_ambiguity_counts(source: sqlite3.Connection) -> tuple[dict[str, int], dict[tuple[str, str], int]]:
    """Count ambiguous forms from completed slices in facts_form index order."""
    interpretation_counts = {}
    ambiguous_surface_counts = {}
    current_form = None
    current_interpretations = []

    def finish_form() -> None:
        if current_form is None or len(current_interpretations) <= 1:
            return
        interpretation_counts[current_form] = len(current_interpretations)
        for lemma, pos in current_interpretations:
            key = (lemma, pos)
            ambiguous_surface_counts[key] = ambiguous_surface_counts.get(key, 0) + 1

    for rows in _batched(source.execute(PROJECTION_SURFACE_AMBIGUITY_SQL)):
        for form, lemma, pos in rows:
            if form != current_form:
                finish_form()
                current_form = form
                current_interpretations = []
            current_interpretations.append((lemma, pos))
    finish_form()
    return interpretation_counts, ambiguous_surface_counts


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

        interpretation_counts, ambiguous_surface_counts = surface_ambiguity_counts(source)
        cursor = source.execute(PROJECTION_MORPHOLOGY_TOTALS_SQL)
        surface_key = None
        surface_rank = 0
        eojeol_key = None
        eojeol_rank = 0
        for rows in _batched(cursor):
            candidate_values = []
            surface_values = []
            eojeol_values = []
            for kind, lemma, pos, form, tokens, oov, hits, documents, sources, max_source in rows:
                if kind == 0:
                    if pos not in POS_TAGS or producer.KOREAN_LEMMA.fullmatch(lemma) is None:
                        raise RuntimeError("Morphology store contains a lemma/POS outside the pinned candidate contract")
                    candidate_values.append((lemma, producer.normalize_search_form(lemma), pos, POS_TAGS[pos],
                                             tokens, oov, hits, documents, sources, max_source, 0,
                                             "uncovered", "[]", ambiguous_surface_counts.get((lemma, pos), 0)))
                    counts["candidate_rows"] += 1
                    if lemma != previous_lemma:
                        counts["candidate_lemmas"] += 1
                        previous_lemma = lemma
                elif kind == 1:
                    current_key = (lemma, pos)
                    surface_rank = surface_rank + 1 if current_key == surface_key else 1
                    surface_key = current_key
                    if surface_rank <= producer.TOP_SURFACE_FORMS:
                        surface_values.append((lemma, pos, form, tokens, hits, documents, sources, max_source,
                                               interpretation_counts.get(form, 1)))
                elif kind == 2:
                    current_key = (lemma, pos)
                    eojeol_rank = eojeol_rank + 1 if current_key == eojeol_key else 1
                    eojeol_key = current_key
                    if eojeol_rank <= producer.TOP_SURFACE_FORMS:
                        eojeol_values.append((lemma, pos, form, tokens, hits, documents, sources, max_source))
            if candidate_values:
                output.executemany("""
                    INSERT INTO candidates(lemma,normalized_lemma,pos,analyzer_tag,token_count,oov_token_count,
                        paragraph_hits,document_count,source_count,max_source_token_count,covered,coverage_status,
                        coverage_matches_json,ambiguous_surface_count)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, candidate_values)
            if surface_values:
                output.executemany("INSERT INTO candidate_surfaces VALUES(?,?,?,?,?,?,?,?,?)", surface_values)
                counts["candidate_surfaces"] += len(surface_values)
            if eojeol_values:
                output.executemany("INSERT INTO candidate_eojeol_forms VALUES(?,?,?,?,?,?,?,?)", eojeol_values)
                counts["candidate_eojeol_forms"] += len(eojeol_values)

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
    if not projection_path.is_file():
        raise RuntimeError("Morphology selection projection database digest mismatch")
    current_stamp = morphology.file_stamp(projection_path)
    if manifest.get("projection_database_stamp") == current_stamp:
        # The builder performed the full integrity and count checks before
        # publishing this immutable local projection. A matching file stamp
        # lets subsequent batches reuse it without rescanning its contents.
        return manifest
    if sha256_file(projection_path) != manifest.get("projection_database_sha256"):
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
    # Older manifests, or a metadata-only file replacement, incur the full
    # proof once. Persist the current stamp after the original digest, SQLite
    # integrity and row-count evidence all pass.
    updated_manifest = dict(manifest)
    updated_manifest.pop("manifest_sha256", None)
    updated_manifest["projection_database_stamp"] = current_stamp
    write_projection_manifest(projection_manifest_path(directory), updated_manifest)
    updated_manifest["manifest_sha256"] = digest(updated_manifest)
    return updated_manifest


def projection_for_source(*, store_path: Path, source_proof: dict, root: Path) -> tuple[Path, dict]:
    source_snapshot = source_proof["source_snapshot_sha256"]
    assert_source_binding_current(store_path=store_path, index_path=Path(source_proof["source_identity"]["index_path"]),
                                  proof=source_proof)
    directory = projection_directory(root, source_snapshot)
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
            "store_evidence": source_proof,
            "projection_database_path": cache_relative_path(projection_path, "Morphology selection projection"),
            "projection_database_sha256": sha256_file(projection_path),
            "projection_database_stamp": morphology.file_stamp(projection_path),
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

    result, store_evidence = verify_store(
        store_path=store_path,
        index_path=index_path,
        scratch_path=scratch,
        expected_snapshot=expected_source_snapshot,
    )
    source_evidence = store_evidence
    snapshot_sha = source_evidence["source_snapshot_sha256"]
    assert_complete_full_corpus(result)

    projection_path, projection_manifest = projection_for_source(
        store_path=store_path,
        source_proof=source_evidence,
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
        source_identity = source_evidence["source_identity"]
        index_metadata = source_identity["index_metadata"]
        accepted = sum(int(item["accepted_morphemes"]) for item in result["slices"])
        eligible = accepted + sum(int(item["rejected_lemma_shapes"]) + int(item["rejected_spans"])
                                  for item in result["slices"])
        projected_accepted = int(staging.execute("SELECT COALESCE(SUM(token_count),0) FROM candidates").fetchone()[0])
        if projected_accepted != accepted:
            raise RuntimeError("Morphology selection projection token total differs from completed slice summaries")
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
                "source_snapshot_sha256": source_evidence["source_snapshot_sha256"],
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
                "source_snapshot_sha256": source_evidence["source_snapshot_sha256"],
                **({"include_canonical_lemmas": True,
                    "selected_lemma_count": len({row["coverage_normalized_key"] for row in candidate_rows})}
                   if include_canonical_lemmas else {}),
            },
            "yield": yield_data,
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "analysis_cache": {
                "mode": "verified-full-corpus-morphology-v1",
                "source_store_path": cache_relative_path(store_path, "Morphology source store"),
                "source_database_path": source_evidence["store_database_path"],
                "source_database_bytes": (store_path / "analysis.sqlite").stat().st_size,
                "source_snapshot_sha256": source_evidence["source_snapshot_sha256"],
                "source_identity_sha256": source_evidence["source_identity_sha256"],
                "completion_bitmap": source_evidence["completion_bitmap"],
                "verified_paragraphs": source_evidence["verified_paragraphs"],
                "total_paragraphs": source_evidence["total_paragraphs"],
                "validation": source_evidence["validation"],
                "store_evidence": source_evidence,
                "selection_projection_contract": PROJECTION_CONTRACT,
                "selection_projection_path": projection_manifest["projection_database_path"],
                "selection_projection_sha256": projection_manifest["projection_database_sha256"],
                "selector_script_sha256": sha256_file(Path(__file__)),
            },
            "candidates": candidate_rows,
        }
        assert_source_binding_current(store_path=store_path, index_path=index_path, proof=source_evidence)
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
