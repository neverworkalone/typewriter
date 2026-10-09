#!/usr/bin/env python3
"""Bounded, local-only Kiwi lemma candidate extraction for issue #201.

The extractor reads paragraph rows from the shared-cache SQLite reference index in
small batches. It writes counts and candidate metadata to local run files;
it never writes corpus paragraph text. Search evidence is added by the Node
orchestrator through the shared bounded corpus-index APIs.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.python.local_cache import assert_cache_path, typewriter_cache_root


REPOSITORY_DIRECTORY = Path(__file__).resolve().parents[2]
TYPEWRITER_CACHE_ROOT = typewriter_cache_root()
DEFAULT_INDEX_PATH = TYPEWRITER_CACHE_ROOT / "indexes/written-corpus-2025.sqlite"
DEFAULT_PERMISSION_RECORD_PATH = REPOSITORY_DIRECTORY / "docs/external-material-review-written-corpus-2025.md"
LOCAL_PILOT_DIRECTORY = TYPEWRITER_CACHE_ROOT / "runs/issue-201-pilot"
DEFAULT_STAGING_PATH = LOCAL_PILOT_DIRECTORY / "candidate-analysis.sqlite"
DEFAULT_SELECTION_PATH = LOCAL_PILOT_DIRECTORY / "candidate-selection.json"
EXTRACTOR_VERSION = "2"
# These retained v2 producer files produce the same morphology-analysis tables as
# this version; their changes are limited to cache/output paths or downstream
# candidate selection. Older or unlisted source digests remain incompatible.
REUSABLE_ANALYSIS_SOURCE_DIGESTS = frozenset({
    "a65060846e1f5f0fb300823590965d569772bc952368be18d95f018ab297faeb",
    "0debcc9d58fa87327b64e21fa26b8dca335380fd8d27166db67cb7b31fdb386e",
    "7c18eee629d1c423a3a26ad5d7eede15772c5a420bad1900e6806ed442147c96",
    "5cb8cb22db737afaccd64585dfe613ea428a3fc74dbb359eac4c4a1a177b6ee6",
})
SAMPLE_EVERY_PARAGRAPHS = 20
TARGET_CANDIDATES = 200
MAX_CANDIDATE_LIMIT = 500
ROW_BATCH_SIZE = 32
TOP_SURFACE_FORMS = 5
ELIGIBLE_TAGS = {
    "NNG": "noun",
    "VV": "verb",
    "VA": "adjective",
}
KOREAN_LEMMA = re.compile(r"^[가-힣]{2,}$")
REQUIRED_PERMISSION_FIELDS = {
    "Decision": "permitted for stated role",
    "Intended role": "reference",
    "Allowed local storage": "permitted",
    "Allowed schema scanning and processing": "permitted",
    "Allowed SQLite/FTS indexing": "permitted",
    "Allowed lexical-reference use": "permitted",
    "Distribution/embedding terms reviewed": "complete",
    "Attribution/notice terms reviewed": "complete",
}


def normalize_search_form(value: str) -> str:
    """Match the runtime's NFC plus surrounding-whitespace normalization."""
    return unicodedata.normalize("NFC", value).strip()


def installed_package_version(name: str) -> str:
    try:
        return package_version(name)
    except PackageNotFoundError:
        return "not-installed-test-analyzer"


def read_permission_record(permission_record_path: Path) -> str:
    try:
        record = permission_record_path.read_text(encoding="utf-8")
    except OSError as error:
        raise RuntimeError(
            f"Corpus use is not authorized: cannot read permission record {permission_record_path}: {error}"
        ) from error

    fields: dict[str, str] = {}
    recognized_fields = set(REQUIRED_PERMISSION_FIELDS)
    for line in record.splitlines():
        match = re.match(r"^- ([^:]+):\s*(.*?)\s*$", line)
        if not match:
            continue
        field = match.group(1).strip()
        if field not in recognized_fields:
            continue
        if field in fields:
            raise RuntimeError(f"Permission record has a duplicate field: {field}")
        fields[field] = match.group(2).strip().lower()

    unresolved = [
        field
        for field, expected in REQUIRED_PERMISSION_FIELDS.items()
        if fields.get(field) != expected
    ]
    if unresolved:
        raise RuntimeError(
            "Corpus scanning, morphology analysis, and local lexical-reference use are blocked; "
            "unresolved permission fields: " + ", ".join(unresolved)
        )
    return hashlib.sha256(record.encode("utf-8")).hexdigest()


def open_readonly_database(database_path: Path) -> sqlite3.Connection:
    uri = database_path.resolve().as_uri() + "?mode=ro"
    database = sqlite3.connect(uri, uri=True)
    database.execute("PRAGMA query_only = ON")
    return database


def read_database_metadata(database: sqlite3.Connection) -> dict[str, str]:
    try:
        rows = database.execute("SELECT key, value FROM index_metadata").fetchall()
    except sqlite3.Error as error:
        raise RuntimeError(f"Corpus index metadata is unavailable: {error}") from error
    metadata = {str(key): str(value) for key, value in rows}
    required = {
        "schema_version",
        "source_count",
        "document_count",
        "paragraph_count",
        "input_manifest_sha256",
        "logical_rows_sha256",
        "sqlite_version",
    }
    missing = sorted(required - metadata.keys())
    if missing:
        raise RuntimeError("Corpus index metadata is incomplete: " + ", ".join(missing))
    return metadata


def read_exclusion_manifest(exclusion_path: Path | None) -> dict:
    if exclusion_path is None:
        payload = {
            "schema_version": "m9-reviewed-lemma-exclusions-v1",
            "source_artifacts": [],
            "lemmas": [],
        }
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload["exclusion_sha256"] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        return payload

    try:
        payload = json.loads(exclusion_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Reviewed-lemma exclusion manifest is unreadable: {error}") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != "m9-reviewed-lemma-exclusions-v1":
        raise RuntimeError("Reviewed-lemma exclusion manifest has an unsupported contract.")
    lemmas = payload.get("lemmas")
    source_artifacts = payload.get("source_artifacts")
    if not isinstance(lemmas, list) or not isinstance(source_artifacts, list):
        raise RuntimeError("Reviewed-lemma exclusion manifest is incomplete.")
    if lemmas and not source_artifacts:
        raise RuntimeError("Reviewed-lemma exclusions with lemmas must bind at least one source artifact.")
    normalized = []
    for lemma in lemmas:
        if not isinstance(lemma, str) or not lemma or lemma != lemma.strip() or lemma != unicodedata.normalize("NFC", lemma):
            raise RuntimeError("Reviewed-lemma exclusion values must be non-empty trimmed NFC strings.")
        normalized.append(lemma)
    if normalized != sorted(set(normalized)):
        raise RuntimeError("Reviewed-lemma exclusions must be unique and sorted deterministically.")
    for artifact in source_artifacts:
        if (not isinstance(artifact, dict)
                or not isinstance(artifact.get("path"), str)
                or not artifact.get("path")
                or not re.fullmatch(r"[0-9a-f]{64}", str(artifact.get("sha256", "")))):
            raise RuntimeError("Reviewed-lemma exclusion source bindings must include paths and SHA-256 digests.")
    expected = hashlib.sha256(json.dumps(
        {"schema_version": payload["schema_version"], "source_artifacts": source_artifacts, "lemmas": normalized},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    if payload.get("exclusion_sha256") != expected:
        raise RuntimeError("Reviewed-lemma exclusion digest does not match its contents.")
    return payload


def read_product_surface(database: sqlite3.Connection) -> dict[str, list[dict]]:
    """Read normalized product forms with their distinct runtime match sources."""
    matches_by_form: dict[str, list[dict]] = defaultdict(list)
    query = """
        SELECT lemma AS form, 'canonical_lemma' AS match_kind,
               id AS record_id, lemma AS canonical_lemma,
               NULL AS sense_id, NULL AS pos, NULL AS rule_id
        FROM records
        UNION ALL
        SELECT sf.form, 'curated_search_form', r.id, r.lemma,
               NULL, NULL, NULL
        FROM search_forms AS sf
        JOIN records AS r ON r.id = sf.record_id
        UNION ALL
        SELECT g.form, 'generated_surface_form', r.id, r.lemma,
               g.sense_id, s.pos, g.rule_id
        FROM generated_surface_forms AS g
        JOIN records AS r ON r.id = g.record_id
        JOIN senses AS s ON s.id = g.sense_id AND s.record_id = g.record_id
    """
    cursor = database.execute(query)
    while True:
        batch = cursor.fetchmany(1024)
        if not batch:
            break
        for form, match_kind, record_id, canonical_lemma, sense_id, pos, rule_id in batch:
            normalized_form = normalize_search_form(str(form))
            matches_by_form[normalized_form].append(
                {
                    "match_kind": str(match_kind),
                    "record_id": str(record_id),
                    "canonical_lemma": str(canonical_lemma),
                    "sense_id": str(sense_id) if sense_id is not None else None,
                    "pos": str(pos) if pos is not None else None,
                    "rule_id": str(rule_id) if rule_id is not None else None,
                }
            )
    for matches in matches_by_form.values():
        matches.sort(
            key=lambda match: (
                match["match_kind"],
                match["record_id"],
                match["sense_id"] or "",
                match["rule_id"] or "",
            )
        )
    return dict(matches_by_form)


def apply_product_coverage(
    staging: sqlite3.Connection,
    product_matches: dict[str, list[dict]],
) -> dict[str, int]:
    """Cover exact lemmas and retain search/generated collisions as held candidates."""
    match_kind_counts = {
        "canonical_lemma": 0,
        "curated_search_form": 0,
        "generated_surface_form": 0,
    }
    cursor = staging.execute(
        "SELECT DISTINCT normalized_lemma FROM candidates ORDER BY normalized_lemma COLLATE BINARY"
    )
    while True:
        batch = cursor.fetchmany(1024)
        if not batch:
            break
        updates = []
        for (normalized_lemma,) in batch:
            matches = product_matches.get(str(normalized_lemma), [])
            exact_matches = [
                match for match in matches if match["match_kind"] == "canonical_lemma"
            ]
            if exact_matches:
                match_kind_counts["canonical_lemma"] += 1
                coverage_status = "exact_canonical_lemma"
                covered = 1
            else:
                collision_kinds = {
                    match["match_kind"]
                    for match in matches
                    if match["match_kind"] in {
                        "curated_search_form",
                        "generated_surface_form",
                    }
                }
                match_kind_counts["curated_search_form"] += int(
                    "curated_search_form" in collision_kinds
                )
                match_kind_counts["generated_surface_form"] += int(
                    "generated_surface_form" in collision_kinds
                )
                if collision_kinds == {"curated_search_form"}:
                    coverage_status = "search_form_collision"
                elif collision_kinds == {"generated_surface_form"}:
                    coverage_status = "generated_surface_collision"
                elif collision_kinds:
                    coverage_status = "search_and_generated_surface_collision"
                else:
                    coverage_status = "uncovered"
                covered = 0
            updates.append(
                (
                    covered,
                    coverage_status,
                    json.dumps(matches, ensure_ascii=False, separators=(",", ":")),
                    normalized_lemma,
                )
            )
        staging.executemany(
            """
            UPDATE candidates
            SET covered = ?, coverage_status = ?, coverage_matches_json = ?
            WHERE normalized_lemma = ?
            """,
            updates,
        )
    staging.commit()
    return match_kind_counts


def candidate_from_token(token, paragraph: str):
    tag = str(token.tag)
    pos = ELIGIBLE_TAGS.get(tag)
    if pos is None:
        return None

    form = str(token.form)
    lemma = form + "다" if tag in {"VV", "VA"} else form
    lemma = unicodedata.normalize("NFC", lemma)
    if KOREAN_LEMMA.fullmatch(lemma) is None:
        return None

    start = int(token.start)
    length = int(token.len)
    if start < 0 or length < 1 or start + length > len(paragraph):
        return None
    morpheme_surface = unicodedata.normalize("NFC", paragraph[start : start + length])
    if not morpheme_surface.strip():
        return None

    surface_start = start
    surface_end = start + length
    while surface_start > 0 and not paragraph[surface_start - 1].isspace():
        surface_start -= 1
    while surface_end < len(paragraph) and not paragraph[surface_end].isspace():
        surface_end += 1
    while (
        surface_start < surface_end
        and unicodedata.category(paragraph[surface_start]).startswith("P")
    ):
        surface_start += 1
    while (
        surface_end > surface_start
        and unicodedata.category(paragraph[surface_end - 1]).startswith("P")
    ):
        surface_end -= 1
    observed_surface = unicodedata.normalize("NFC", paragraph[surface_start:surface_end])
    if not observed_surface:
        return None

    return lemma, pos, tag, observed_surface, morpheme_surface, bool(getattr(token, "oov", False))


def create_staging_schema(database: sqlite3.Connection) -> None:
    database.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE candidates (
            lemma TEXT NOT NULL,
            normalized_lemma TEXT NOT NULL,
            pos TEXT NOT NULL,
            analyzer_tag TEXT NOT NULL,
            token_count INTEGER NOT NULL DEFAULT 0,
            oov_token_count INTEGER NOT NULL DEFAULT 0,
            paragraph_hits INTEGER NOT NULL DEFAULT 0,
            document_count INTEGER NOT NULL DEFAULT 0,
            source_count INTEGER NOT NULL DEFAULT 0,
            max_source_token_count INTEGER NOT NULL DEFAULT 0,
            covered INTEGER NOT NULL DEFAULT 0,
            coverage_status TEXT NOT NULL DEFAULT 'uncovered',
            coverage_matches_json TEXT NOT NULL DEFAULT '[]',
            ambiguous_surface_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (lemma, pos)
        ) STRICT;
        CREATE TABLE candidate_surfaces (
            lemma TEXT NOT NULL,
            pos TEXT NOT NULL,
            surface TEXT NOT NULL,
            token_count INTEGER NOT NULL DEFAULT 0,
            paragraph_hits INTEGER NOT NULL DEFAULT 0,
            document_count INTEGER NOT NULL DEFAULT 0,
            source_count INTEGER NOT NULL DEFAULT 0,
            max_source_token_count INTEGER NOT NULL DEFAULT 0,
            interpretation_count INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (lemma, pos, surface),
            FOREIGN KEY (lemma, pos) REFERENCES candidates(lemma, pos)
        ) STRICT;
        CREATE TABLE candidate_eojeol_forms (
            lemma TEXT NOT NULL,
            pos TEXT NOT NULL,
            form TEXT NOT NULL,
            token_count INTEGER NOT NULL DEFAULT 0,
            paragraph_hits INTEGER NOT NULL DEFAULT 0,
            document_count INTEGER NOT NULL DEFAULT 0,
            source_count INTEGER NOT NULL DEFAULT 0,
            max_source_token_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (lemma, pos, form),
            FOREIGN KEY (lemma, pos) REFERENCES candidates(lemma, pos)
        ) STRICT;
        CREATE INDEX idx_candidates_coverage_rank
            ON candidates(covered, normalized_lemma, source_count, document_count, token_count);
        CREATE INDEX idx_candidate_surfaces_form ON candidate_surfaces(surface);
        CREATE INDEX idx_candidate_eojeol_forms_form ON candidate_eojeol_forms(form);
        PRAGMA foreign_keys = ON;
        """
    )


def add_document_aggregates(
    database: sqlite3.Connection,
    document_candidates: dict,
    document_surfaces: dict,
    document_eojeols: dict,
    source_candidates: dict,
    source_surfaces: dict,
    source_eojeols: dict,
) -> None:
    if not document_candidates:
        return
    for (lemma, pos), counts in document_candidates.items():
        database.execute(
            """
            INSERT INTO candidates
                (lemma, normalized_lemma, pos, analyzer_tag, token_count, oov_token_count,
                 paragraph_hits, document_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(lemma, pos) DO UPDATE SET
                token_count = token_count + excluded.token_count,
                oov_token_count = oov_token_count + excluded.oov_token_count,
                paragraph_hits = paragraph_hits + excluded.paragraph_hits,
                document_count = document_count + 1
            """,
            (lemma, normalize_search_form(lemma), pos, counts["analyzer_tag"],
             counts["token_count"], counts["oov_token_count"], counts["paragraph_hits"]),
        )
        source_candidates[(lemma, pos)] += counts["token_count"]

    for (lemma, pos, surface), counts in document_surfaces.items():
        database.execute(
            """
            INSERT INTO candidate_surfaces
                (lemma, pos, surface, token_count, paragraph_hits, document_count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(lemma, pos, surface) DO UPDATE SET
                token_count = token_count + excluded.token_count,
                paragraph_hits = paragraph_hits + excluded.paragraph_hits,
                document_count = document_count + 1
            """,
            (lemma, pos, surface, counts["token_count"], counts["paragraph_hits"]),
        )
        source_surfaces[(lemma, pos, surface)] += counts["token_count"]

    for (lemma, pos, form), counts in document_eojeols.items():
        database.execute(
            """
            INSERT INTO candidate_eojeol_forms
                (lemma, pos, form, token_count, paragraph_hits, document_count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(lemma, pos, form) DO UPDATE SET
                token_count = token_count + excluded.token_count,
                paragraph_hits = paragraph_hits + excluded.paragraph_hits,
                document_count = document_count + 1
            """,
            (lemma, pos, form, counts["token_count"], counts["paragraph_hits"]),
        )
        source_eojeols[(lemma, pos, form)] += counts["token_count"]


def close_source(
    database: sqlite3.Connection,
    source_candidates: dict,
    source_surfaces: dict,
    source_eojeols: dict,
) -> None:
    for (lemma, pos), token_count in source_candidates.items():
        database.execute(
            """
            UPDATE candidates
            SET source_count = source_count + 1,
                max_source_token_count = MAX(max_source_token_count, ?)
            WHERE lemma = ? AND pos = ?
            """,
            (token_count, lemma, pos),
        )
    for (lemma, pos, surface), token_count in source_surfaces.items():
        database.execute(
            """
            UPDATE candidate_surfaces
            SET source_count = source_count + 1,
                max_source_token_count = MAX(max_source_token_count, ?)
            WHERE lemma = ? AND pos = ? AND surface = ?
            """,
            (token_count, lemma, pos, surface),
        )
    for (lemma, pos, form), token_count in source_eojeols.items():
        database.execute(
            """
            UPDATE candidate_eojeol_forms
            SET source_count = source_count + 1,
                max_source_token_count = MAX(max_source_token_count, ?)
            WHERE lemma = ? AND pos = ? AND form = ?
            """,
            (token_count, lemma, pos, form),
        )


def select_candidate_rows(
    staging: sqlite3.Connection,
    candidate_limit: int,
    excluded_lemmas: list[str] | None = None,
    include_canonical_lemmas: bool = False,
) -> list[dict]:
    # Factory Stage 1 (issue #289): an exact canonical lemma may still carry an evidence-backed new
    # POS or sense, so it must reach Stage 1/2 instead of being dropped here as `covered`. The
    # default stays the historical M9 behaviour.
    coverage_filter = "TRUE" if include_canonical_lemmas else "covered = 0"
    staging.execute(
        """
        UPDATE candidate_surfaces
        SET interpretation_count = (
            SELECT COUNT(*) FROM candidate_surfaces AS other
            WHERE other.surface = candidate_surfaces.surface
        )
        """
    )
    staging.execute(
        """
        UPDATE candidates
        SET ambiguous_surface_count = (
            SELECT COUNT(*) FROM candidate_surfaces AS surface
            WHERE surface.lemma = candidates.lemma
              AND surface.pos = candidates.pos
              AND surface.interpretation_count > 1
        )
        """
    )
    staging.commit()

    staging.execute("CREATE TEMP TABLE excluded_candidate_lemmas (normalized_lemma TEXT PRIMARY KEY) STRICT")
    staging.executemany(
        "INSERT INTO excluded_candidate_lemmas(normalized_lemma) VALUES (?)",
        [(lemma,) for lemma in (excluded_lemmas or [])],
    )

    ranked_pos_sql = f"""
        WITH ranked_pos AS (
            SELECT candidates.*,
                   COUNT(*) OVER (PARTITION BY normalized_lemma) AS pos_interpretation_count,
                   ROW_NUMBER() OVER (
                       PARTITION BY normalized_lemma
                       ORDER BY source_count DESC, document_count DESC,
                                token_count DESC, pos COLLATE BINARY
                   ) AS pos_rank
            FROM candidates
            WHERE {coverage_filter}
              AND NOT EXISTS (
                  SELECT 1 FROM excluded_candidate_lemmas AS excluded
                  WHERE excluded.normalized_lemma = candidates.normalized_lemma
              )
        )
        SELECT lemma, normalized_lemma, pos, analyzer_tag,
               token_count, oov_token_count, paragraph_hits, document_count, source_count,
               max_source_token_count, ambiguous_surface_count,
               pos_interpretation_count, coverage_status, coverage_matches_json
        FROM ranked_pos
        """
    rows = staging.execute(
        ranked_pos_sql
        + """
        WHERE pos_rank = 1
        ORDER BY source_count DESC, document_count DESC, token_count DESC,
                 lemma COLLATE BINARY
        LIMIT ?
        """,
        (candidate_limit,),
    ).fetchall()
    if include_canonical_lemmas:
        # The bound counts distinct lemmas. Every observed POS of a selected lemma is kept as its own
        # candidate row (own surface forms and source evidence) so a lower-ranked POS, e.g. a new POS
        # of an existing canonical lemma, is not lost before Stage 1.
        lemma_order = {str(row[1]): index for index, row in enumerate(rows)}
        all_pos_rows = staging.execute(
            ranked_pos_sql
            + """
        WHERE normalized_lemma IN (SELECT value FROM json_each(?))
        ORDER BY pos_rank
        """,
            (json.dumps(list(lemma_order), ensure_ascii=False),),
        ).fetchall()
        rows = sorted(all_pos_rows, key=lambda row: lemma_order[str(row[1])])  # stable: keeps pos_rank order
    candidates: list[dict] = []
    for row in rows:
        (
            lemma,
            normalized_lemma,
            pos,
            analyzer_tag,
            token_count,
            oov_token_count,
            paragraph_hits,
            document_count,
            source_count,
            max_source_token_count,
            ambiguous_surface_count,
            pos_interpretation_count,
            coverage_status,
            coverage_matches_json,
        ) = row
        surfaces = staging.execute(
            """
            SELECT surface, token_count, paragraph_hits, document_count, source_count,
                   max_source_token_count, interpretation_count
            FROM candidate_surfaces
            WHERE lemma = ? AND pos = ?
            ORDER BY token_count DESC, paragraph_hits DESC, surface COLLATE BINARY
            LIMIT ?
            """,
            (lemma, pos, TOP_SURFACE_FORMS),
        ).fetchall()
        eojeol_forms = staging.execute(
            """
            SELECT form, token_count, paragraph_hits, document_count, source_count,
                   max_source_token_count
            FROM candidate_eojeol_forms
            WHERE lemma = ? AND pos = ?
            ORDER BY token_count DESC, paragraph_hits DESC, form COLLATE BINARY
            LIMIT ?
            """,
            (lemma, pos, TOP_SURFACE_FORMS),
        ).fetchall()
        morphology_ambiguous = (
            int(ambiguous_surface_count) > 0
            or int(pos_interpretation_count) > 1
            or int(oov_token_count) > 0
        )
        coverage_collision = str(coverage_status) not in {
            "uncovered",
            "exact_canonical_lemma",
        }
        if int(ambiguous_surface_count) > 0:
            ambiguity_status = "held_surface_has_multiple_analyzer_interpretations"
        elif int(pos_interpretation_count) > 1:
            ambiguity_status = "held_lemma_has_multiple_pos_interpretations"
        elif int(oov_token_count) > 0:
            ambiguity_status = "held_oov_morphology"
        else:
            ambiguity_status = "single_observed_analysis_unverified"
        candidates.append(
            {
                "proposed_lemma": lemma,
                "proposed_pos": pos,
                "analyzer_pos": analyzer_tag,
                "kiwi_morpheme_occurrences_in_sample": int(token_count),
                "oov_morpheme_occurrences_in_sample": int(oov_token_count),
                "paragraph_hits_in_sample": int(paragraph_hits),
                "distinct_documents_in_sample": int(document_count),
                "distinct_sources_in_sample": int(source_count),
                "max_source_morpheme_occurrences_in_sample": int(max_source_token_count),
                "source_concentration_ratio_in_sample": round(
                    int(max_source_token_count) / int(token_count), 4
                ),
                "pos_interpretation_count_in_sample": int(pos_interpretation_count),
                "ambiguous_observed_surface_count_in_sample": int(ambiguous_surface_count),
                "ambiguity_status": ambiguity_status,
                "analyzer_confidence": "not_calibrated",
                "decision_state": "held" if morphology_ambiguous or coverage_collision else "candidate",
                "coverage_status": str(coverage_status),
                "typewriter_surface_matches": json.loads(str(coverage_matches_json)),
                "observed_surface_forms": [
                    {
                        "surface": str(form),
                        "kiwi_morpheme_occurrences_in_sample": int(form_tokens),
                        "paragraph_hits_in_sample": int(form_paragraphs),
                        "distinct_documents_in_sample": int(form_documents),
                        "distinct_sources_in_sample": int(form_sources),
                        "max_source_morpheme_occurrences_in_sample": int(form_max_source_tokens),
                    }
                    for (
                        form,
                        form_tokens,
                        form_paragraphs,
                        form_documents,
                        form_sources,
                        form_max_source_tokens,
                    ) in eojeol_forms
                ],
                "observed_morpheme_spans": [
                    {
                        "surface": str(surface),
                        "kiwi_morpheme_occurrences_in_sample": int(surface_tokens),
                        "paragraph_hits_in_sample": int(surface_paragraphs),
                        "distinct_documents_in_sample": int(surface_documents),
                        "distinct_sources_in_sample": int(surface_sources),
                        "max_source_morpheme_occurrences_in_sample": int(surface_max_source_tokens),
                        "interpretation_count_in_sample": int(interpretation_count),
                    }
                    for (
                        surface,
                        surface_tokens,
                        surface_paragraphs,
                        surface_documents,
                        surface_sources,
                        surface_max_source_tokens,
                        interpretation_count,
                    ) in surfaces
                ],
                "coverage_normalized_key": normalized_lemma,
            }
        )
    return candidates


def validate_candidate_limit(candidate_limit: int) -> int:
    if candidate_limit < 1 or candidate_limit > MAX_CANDIDATE_LIMIT:
        raise ValueError(f"Candidate limit must be 1-{MAX_CANDIDATE_LIMIT}.")
    return candidate_limit


def run_extraction(
    *,
    index_path: Path = DEFAULT_INDEX_PATH,
    dictionary_path: Path,
    staging_path: Path = DEFAULT_STAGING_PATH,
    candidate_output_path: Path = DEFAULT_SELECTION_PATH,
    permission_record_path: Path = DEFAULT_PERMISSION_RECORD_PATH,
    exclusion_manifest_path: Path | None = None,
    analyzer,
    sample_every: int = SAMPLE_EVERY_PARAGRAPHS,
    candidate_limit: int = TARGET_CANDIDATES,
    batch_size: int = ROW_BATCH_SIZE,
    include_canonical_lemmas: bool = False,
) -> dict:
    validate_candidate_limit(candidate_limit)
    if sample_every < 1 or batch_size < 1:
        raise ValueError("Sample interval and row batch size must be positive.")
    permission_sha256 = read_permission_record(permission_record_path)
    exclusion_manifest = read_exclusion_manifest(exclusion_manifest_path)
    for path in (index_path, dictionary_path):
        if not path.is_file():
            raise RuntimeError(f"Required local SQLite input is missing: {path}")

    index = open_readonly_database(index_path)
    product = open_readonly_database(dictionary_path)
    staging_path.parent.mkdir(parents=True, exist_ok=True)
    candidate_output_path.parent.mkdir(parents=True, exist_ok=True)
    if staging_path.exists():
        staging_path.unlink()

    started = time.perf_counter()
    paragraph_count = 0
    eligible_tag_token_count = 0
    accepted_morpheme_count = 0
    rejected_lemma_shape_count = 0
    rejected_span_count = 0
    sampled_documents: set[int] = set()
    sampled_sources: set[str] = set()
    database_metadata = read_database_metadata(index)
    index_paragraph_count = int(database_metadata["paragraph_count"])
    index_database = None
    staging = None
    candidate_rows: list[dict] = []

    try:
        product_surface_matches = read_product_surface(product)
        product_surface_key_counts = {
            match_kind: sum(
                any(match["match_kind"] == match_kind for match in matches)
                for matches in product_surface_matches.values()
            )
            for match_kind in (
                "canonical_lemma",
                "curated_search_form",
                "generated_surface_form",
            )
        }
        product_metadata = dict(product.execute("SELECT key, value FROM metadata").fetchall())
        index_database = index.execute(
            """
            SELECT sf.source_path, d.document_rowid, d.document_id, d.document_ordinal,
                   p.paragraph_id, p.ordinal AS paragraph_ordinal, p.form
            FROM paragraphs AS p
            JOIN documents AS d ON d.document_rowid = p.document_rowid
            JOIN source_files AS sf ON sf.source_path = d.source_path
            WHERE p.ordinal % ? = 0
            ORDER BY sf.source_path COLLATE BINARY, d.document_ordinal, p.ordinal
            """,
            (sample_every,),
        )
        staging = sqlite3.connect(staging_path)
        create_staging_schema(staging)
        staging.execute("BEGIN")

        current_document: int | None = None
        current_source: str | None = None
        document_candidates: dict = defaultdict(
            lambda: {"token_count": 0, "oov_token_count": 0, "paragraph_hits": 0, "analyzer_tag": ""}
        )
        document_surfaces: dict = defaultdict(
            lambda: {"token_count": 0, "paragraph_hits": 0}
        )
        document_eojeols: dict = defaultdict(
            lambda: {"token_count": 0, "paragraph_hits": 0}
        )
        source_candidates: dict = defaultdict(int)
        source_surfaces: dict = defaultdict(int)
        source_eojeols: dict = defaultdict(int)

        while True:
            batch = index_database.fetchmany(batch_size)
            if not batch:
                break
            for row in batch:
                source_path, document_rowid, _document_id, _document_ordinal, _paragraph_id, _paragraph_ordinal, paragraph = row
                document_rowid = int(document_rowid)
                source_path = str(source_path)
                if current_document is not None and document_rowid != current_document:
                    add_document_aggregates(
                        staging,
                        document_candidates,
                        document_surfaces,
                        document_eojeols,
                        source_candidates,
                        source_surfaces,
                        source_eojeols,
                    )
                    document_candidates.clear()
                    document_surfaces.clear()
                    document_eojeols.clear()
                    current_document = None
                if current_source is not None and source_path != current_source:
                    close_source(staging, source_candidates, source_surfaces, source_eojeols)
                    source_candidates.clear()
                    source_surfaces.clear()
                    source_eojeols.clear()
                    current_source = None
                if current_document is None:
                    current_document = document_rowid
                    sampled_documents.add(document_rowid)
                if current_source is None:
                    current_source = source_path
                    sampled_sources.add(source_path)

                paragraph = str(paragraph)
                paragraph_candidates: dict = defaultdict(int)
                paragraph_candidate_tags: dict = {}
                paragraph_candidate_oov: dict = defaultdict(int)
                paragraph_surfaces: dict = defaultdict(int)
                paragraph_eojeols: dict = defaultdict(int)
                for token in analyzer.tokenize(paragraph):
                    if str(token.tag) in ELIGIBLE_TAGS:
                        eligible_tag_token_count += 1
                    candidate = candidate_from_token(token, paragraph)
                    if candidate is None:
                        if str(token.tag) in ELIGIBLE_TAGS:
                            form = str(token.form)
                            lemma = form + "다" if str(token.tag) in {"VV", "VA"} else form
                            if KOREAN_LEMMA.fullmatch(unicodedata.normalize("NFC", lemma)) is None:
                                rejected_lemma_shape_count += 1
                            else:
                                rejected_span_count += 1
                        continue
                    lemma, pos, tag, observed_surface, morpheme_surface, is_oov = candidate
                    key = (lemma, pos)
                    paragraph_candidates[key] += 1
                    paragraph_candidate_tags[key] = tag
                    if is_oov:
                        paragraph_candidate_oov[key] += 1
                    paragraph_surfaces[(lemma, pos, morpheme_surface)] += 1
                    paragraph_eojeols[(lemma, pos, observed_surface)] += 1
                    accepted_morpheme_count += 1

                for (lemma, pos), count in paragraph_candidates.items():
                    target = document_candidates[(lemma, pos)]
                    target["token_count"] += count
                    target["oov_token_count"] += paragraph_candidate_oov[(lemma, pos)]
                    target["paragraph_hits"] += 1
                    target["analyzer_tag"] = paragraph_candidate_tags[(lemma, pos)]
                for (lemma, pos, surface), count in paragraph_surfaces.items():
                    target = document_surfaces[(lemma, pos, surface)]
                    target["token_count"] += count
                    target["paragraph_hits"] += 1
                for (lemma, pos, form), count in paragraph_eojeols.items():
                    target = document_eojeols[(lemma, pos, form)]
                    target["token_count"] += count
                    target["paragraph_hits"] += 1

                paragraph_count += 1
                if paragraph_count % 20000 == 0:
                    elapsed = max(time.perf_counter() - started, 0.001)
                    print(
                        json.dumps(
                            {
                                "processed_sample_paragraphs": paragraph_count,
                                "sample_paragraphs_per_second": round(paragraph_count / elapsed, 1),
                                "eligible_morpheme_observations": accepted_morpheme_count,
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    )

        add_document_aggregates(
            staging,
            document_candidates,
            document_surfaces,
            document_eojeols,
            source_candidates,
            source_surfaces,
            source_eojeols,
        )
        close_source(staging, source_candidates, source_surfaces, source_eojeols)
        staging.commit()

        apply_product_coverage(staging, product_surface_matches)
        candidate_rows = select_candidate_rows(
            staging, candidate_limit, exclusion_manifest["lemmas"], include_canonical_lemmas
        )

        total_candidate_rows = int(staging.execute("SELECT COUNT(*) FROM candidates").fetchone()[0])
        total_candidate_lemmas = int(
            staging.execute("SELECT COUNT(DISTINCT normalized_lemma) FROM candidates").fetchone()[0]
        )
        exact_canonical_lemma_candidates = int(
            staging.execute(
                "SELECT COUNT(DISTINCT normalized_lemma) FROM candidates WHERE covered = 1"
            ).fetchone()[0]
        )
        coverage_collision_counts = {
            str(status): int(count)
            for status, count in staging.execute(
                """
                SELECT coverage_status, COUNT(DISTINCT normalized_lemma)
                FROM candidates
                WHERE coverage_status IN (
                    'search_form_collision',
                    'generated_surface_collision',
                    'search_and_generated_surface_collision'
                )
                GROUP BY coverage_status
                """
            ).fetchall()
        }
        coverage_status_counts = {
            str(status): int(count)
            for status, count in staging.execute(
                "SELECT coverage_status, COUNT(DISTINCT normalized_lemma) FROM candidates GROUP BY coverage_status ORDER BY coverage_status COLLATE BINARY"
            ).fetchall()
        }
        search_form_collision_candidates = coverage_collision_counts.get(
            "search_form_collision", 0
        )
        generated_surface_collision_candidates = coverage_collision_counts.get(
            "generated_surface_collision", 0
        )
        search_and_generated_collision_candidates = coverage_collision_counts.get(
            "search_and_generated_surface_collision", 0
        )
        total_surface_collision_candidates = (
            search_form_collision_candidates
            + generated_surface_collision_candidates
            + search_and_generated_collision_candidates
        )
        ambiguous_candidate_lemmas = int(
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
        if accepted_morpheme_count == 0:
            raise RuntimeError("The analyzer produced no eligible Korean noun, verb, or adjective morphemes.")

        elapsed_seconds = round(time.perf_counter() - started, 3)
        metadata = {
            "schema_version": 1,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "publication_state": "local_reference_only_pending_owner_publication_confirmation",
            "permission_record_sha256": permission_sha256,
            "index": {
                "source_count": int(database_metadata["source_count"]),
                "document_count": int(database_metadata["document_count"]),
                "paragraph_count": index_paragraph_count,
                "input_manifest_sha256": database_metadata["input_manifest_sha256"],
                "logical_rows_sha256": database_metadata["logical_rows_sha256"],
                "sqlite_version": database_metadata["sqlite_version"],
                "database_bytes": index_path.stat().st_size,
                "sample_policy": f"one paragraph when paragraph ordinal modulo {sample_every} is zero, within each source-ordered document",
                "sample_every_paragraphs": sample_every,
                "sample_paragraph_count": paragraph_count,
                "sample_fraction": round(paragraph_count / index_paragraph_count, 6),
                "sample_document_count": len(sampled_documents),
                "sample_source_count": len(sampled_sources),
            },
            "typewriter_surface": {
                "dictionary_version": product_metadata.get("dictionary_version"),
                "canonical_revision": product_metadata.get("canonical_revision"),
                "record_count": int(product_metadata.get("record_count", "0")),
                "search_form_count": int(product_metadata.get("search_form_count", "0")),
                "generated_surface_form_count": int(product_metadata.get("generated_surface_form_count", "0")),
                "normalized_surface_key_count": len(product_surface_matches),
                "normalized_keys_with_canonical_lemmas": product_surface_key_counts[
                    "canonical_lemma"
                ],
                "normalized_keys_with_curated_search_forms": product_surface_key_counts[
                    "curated_search_form"
                ],
                "normalized_keys_with_generated_surface_forms": product_surface_key_counts[
                    "generated_surface_form"
                ],
                "normalization": "Unicode NFC plus surrounding whitespace trim, matching runtime search input",
            },
            "extractor": {
                "name": "Kiwi morphological analyzer via kiwipiepy",
                "extractor_version": EXTRACTOR_VERSION,
                "python_version": sys.version.split()[0],
                "kiwipiepy_version": installed_package_version("kiwipiepy"),
                "kiwipiepy_model_version": installed_package_version("kiwipiepy_model"),
                "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "eligible_analyzer_tags": sorted(ELIGIBLE_TAGS),
                "tag_to_typewriter_pos": ELIGIBLE_TAGS,
                "predicate_lemma_rule": "VV and VA morpheme forms receive the citation ending 다; NNG forms remain unchanged",
                "minimum_lemma_shape": "two or more precomposed Hangul syllables",
                "confidence": "not calibrated; Kiwi one-best output is a proposal",
                "row_batch_size": batch_size,
            },
            "selection": {
                "contract_version": "m9-corpus-candidate-selection-v1",
                "candidate_limit": candidate_limit,
                "selected_candidate_count": len(candidate_rows),
                "ordering": [
                    "source_count descending",
                    "document_count descending",
                    "analyzer_morpheme_observations_in_sample descending",
                    "lemma Unicode binary ascending",
                ],
                "excluded_candidate_lemma_count": len(exclusion_manifest["lemmas"]),
                "exclusion_sha256": exclusion_manifest["exclusion_sha256"],
                "exclusion_source_artifacts": exclusion_manifest["source_artifacts"],
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
                "eligible_pos_token_observations_before_shape_filter": eligible_tag_token_count,
                "accepted_morpheme_observations_in_sample": accepted_morpheme_count,
                "rejected_lemma_shape_observations": rejected_lemma_shape_count,
                "rejected_span_observations": rejected_span_count,
                "unique_lemma_pos_candidates_before_coverage": total_candidate_rows,
                "unique_lemma_candidates_before_coverage": total_candidate_lemmas,
                "exact_canonical_lemma_candidates": exact_canonical_lemma_candidates,
                "candidate_lemmas_without_exact_canonical_match": (
                    total_candidate_lemmas - exact_canonical_lemma_candidates
                ),
                "search_form_collision_lemma_candidates": search_form_collision_candidates,
                "generated_surface_collision_lemma_candidates": generated_surface_collision_candidates,
                "search_and_generated_surface_collision_lemma_candidates": (
                    search_and_generated_collision_candidates
                ),
                "total_surface_collision_lemma_candidates": total_surface_collision_candidates,
                "coverage_status_counts_by_distinct_lemma": coverage_status_counts,
                "exact_lemma_covered_candidate_count": coverage_status_counts.get("exact_canonical_lemma", 0),
                "curated_or_generated_surface_collision_candidate_count": total_surface_collision_candidates,
                "ambiguous_lemma_candidates_before_coverage": ambiguous_candidate_lemmas,
                "oov_lemma_candidates_before_coverage": int(
                    staging.execute("SELECT COUNT(*) FROM candidates WHERE oov_token_count > 0").fetchone()[0]
                ),
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
            },
            "elapsed_seconds": elapsed_seconds,
            "candidates": candidate_rows,
        }
        temporary_output = candidate_output_path.with_suffix(candidate_output_path.suffix + ".tmp")
        temporary_output.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_output, candidate_output_path)
        return metadata
    finally:
        if staging is not None:
            staging.close()
        product.close()
        index.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dictionary", required=True, type=Path)
    parser.add_argument("--staging-db", type=Path, default=DEFAULT_STAGING_PATH)
    parser.add_argument("--candidate-json", type=Path, default=DEFAULT_SELECTION_PATH)
    parser.add_argument("--candidate-limit", type=int, default=TARGET_CANDIDATES)
    parser.add_argument("--exclusion-manifest", type=Path)
    parser.add_argument("--include-canonical-lemmas", action="store_true")
    arguments = parser.parse_args()
    arguments.staging_db = assert_cache_path(arguments.staging_db, "runs", "--staging-db")
    arguments.candidate_json = assert_cache_path(arguments.candidate_json, "runs", "--candidate-json")
    if arguments.staging_db.parent != arguments.candidate_json.parent:
        parser.error("--staging-db and --candidate-json must share one task-scoped run directory")
    if arguments.staging_db.exists() or arguments.candidate_json.exists():
        parser.error("run output already exists; choose a fresh Typewriter cache run directory")
    try:
        from kiwipiepy import Kiwi
    except ImportError as error:
        raise SystemExit(
            "Install the locally pinned analyzer first: python -m pip install kiwipiepy==0.24.0"
        ) from error

    result = run_extraction(
        dictionary_path=arguments.dictionary.resolve(),
        staging_path=arguments.staging_db.resolve(),
        candidate_output_path=arguments.candidate_json.resolve(),
        candidate_limit=arguments.candidate_limit,
        exclusion_manifest_path=arguments.exclusion_manifest.resolve() if arguments.exclusion_manifest else None,
        analyzer=Kiwi(),
        include_canonical_lemmas=arguments.include_canonical_lemmas,
    )
    print(
        json.dumps(
            {
                "sample_paragraphs": result["index"]["sample_paragraph_count"],
                "sample_fraction": result["index"]["sample_fraction"],
                "raw_eligible_morpheme_observations": result["yield"]["accepted_morpheme_observations_in_sample"],
                "unique_lemma_candidates": result["yield"]["unique_lemma_candidates_before_coverage"],
                "exact_canonical_lemma_candidates": result["yield"]["exact_canonical_lemma_candidates"],
                "candidate_lemmas_without_exact_canonical_match": (
                    result["yield"]["candidate_lemmas_without_exact_canonical_match"]
                ),
                "total_surface_collision_lemma_candidates": (
                    result["yield"]["total_surface_collision_lemma_candidates"]
                ),
                "ambiguous_lemma_candidates": result["yield"]["ambiguous_lemma_candidates_before_coverage"],
                "selected_inventory_count": result["yield"]["selected_inventory_count"],
                "elapsed_seconds": result["elapsed_seconds"],
                "candidate_selection_path": str(arguments.candidate_json.resolve()),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
