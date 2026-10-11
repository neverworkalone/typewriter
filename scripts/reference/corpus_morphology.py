#!/usr/bin/env python3
"""Local, resumable Written Corpus morphology; no dictionary/admission coupling."""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing, contextmanager
import fcntl
import hashlib
import inspect as introspection
from importlib.metadata import PackageNotFoundError, distribution
import json
from itertools import chain
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
import unicodedata

from corpus_lemma_pilot import (
    DEFAULT_PERMISSION_RECORD_PATH, ELIGIBLE_TAGS, KOREAN_LEMMA, candidate_from_token,
    open_readonly_database, read_database_metadata, read_permission_record,
)
from scripts.python.local_cache import assert_cache_path, typewriter_cache_root

CONTRACT = "corpus-morphology-slices-v1"
SLICE_COUNT = 20
DEFAULT_STORE = typewriter_cache_root() / "runs/written-corpus-morphology-v1"
DEFAULT_INDEX = typewriter_cache_root() / "indexes/written-corpus-2025.sqlite"
FACT_ORDER = "slice,chunk,kind,lemma,pos,form,document"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def rows_digest(rows, prefix=None):
    result = hashlib.sha256(encoded(prefix))
    for row in rows:
        result.update(encoded(list(row)) + b"\n")
    return result.hexdigest()


def runtime_identity():
    packages = {}
    for name in ("kiwipiepy", "kiwipiepy_model"):
        try:
            package = distribution(name)
        except PackageNotFoundError as error:
            raise RuntimeError(f"Missing {name}; run node scripts/python/bootstrap.mjs") from error
        if package.version != "0.24.0":
            raise RuntimeError(f"{name} must be 0.24.0; run node scripts/python/bootstrap.mjs")
        files = sorted(str(p) for p in (package.files or []) if "__pycache__" not in str(p))
        if not files:
            raise RuntimeError(f"No installed file identity for {name}")
        packages[name] = {"version": package.version, "files_sha256": rows_digest(
            ((p, file_digest(package.locate_file(p))) for p in files))}
    return {"python": sys.version, "python_binary_sha256": file_digest(sys.executable),
            "packages": packages, "kiwi_options": {"num_workers": 1},
            "tokenize_options": "kiwipiepy-0.24.0 defaults"}


def require_rollback_header(index_path):
    # Read-only SQLite may be unable to open sidecar-free WAL on some hosts.
    # The persisted read/write version bytes identify WAL without creating files.
    with index_path.open("rb") as stream:
        header = stream.read(20)
    if header[:16] == b"SQLite format 3\0" and 2 in header[18:20]:
        raise RuntimeError("WAL corpus index is unsupported; stop its writer and use a verified rollback-mode index")


def require_rollback_source(source):
    mode = source.execute("PRAGMA journal_mode").fetchone()[0].lower()
    if mode == "wal":
        raise RuntimeError("WAL corpus index is unsupported; stop its writer and use a verified rollback-mode index")
    if mode not in {"delete", "truncate", "persist", "off", "memory"}:
        raise RuntimeError("Unsupported corpus index journal mode")


def source_identity(index_path, permission_path, runtime):
    permission = read_permission_record(permission_path)
    require_rollback_header(index_path)
    # Physical digest detects changes to text or metadata even if the producer metadata is stale.
    # A read transaction plus before/after file stamps rejects concurrent index modification.
    before = index_path.stat()
    with closing(open_readonly_database(index_path)) as index:
        index.execute("BEGIN")
        require_rollback_source(index)
        if index.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise RuntimeError("Corrupted corpus index; restore the verified index")
        if index.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("Corpus index has orphaned source/document/paragraph identities")
        metadata = read_database_metadata(index)
        if metadata["schema_version"] != "1":
            raise RuntimeError("Unsupported corpus index schema")
        for table, key in (("paragraphs", "paragraph_count"), ("documents", "document_count"),
                           ("source_files", "source_count")):
            if index.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] != int(metadata[key]):
                raise RuntimeError(f"Index {key} does not match its rows")
        sources = rows_digest(index.execute("SELECT * FROM source_files ORDER BY source_path"))
        index_sha = file_digest(index_path)
    after = index_path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise RuntimeError("Index changed while verifying identity; stop the writer and retry")
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(index_path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError("Index has a live journal/WAL; checkpoint its writer before analysis")
    scripts = [Path(__file__),
               Path(__file__).parents[1] / "python/local_cache.py",
               Path(__file__).parents[1] / "python/requirements.txt"]
    return {"contract": CONTRACT, "index_path": str(index_path), "index_sha256": index_sha,
            "index_metadata": metadata, "sources_sha256": sources,
            "permission_sha256": permission, "runtime": runtime,
            "algorithm_sha256": rows_digest(((p.name, file_digest(p)) for p in scripts),
                [introspection.getsource(candidate_from_token), ELIGIBLE_TAGS, KOREAN_LEMMA.pattern]),
            "schema_sha256": expected_schema_digest(), "index_stamp": file_stamp(index_path)}


def file_stamp(path):
    stat = Path(path).stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def seal_store(directory):
    # External mutation witness, not a substitute for checkpoint checksums.
    value = {"stamp": file_stamp(directory / "analysis.sqlite")}
    value["sha256"] = digest(value)
    staging = directory / "seal.tmp"
    with staging.open("wb") as stream:
        stream.write(encoded(value))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(staging, directory / "seal.json")
    fsync_directory(directory)


def check_seal(directory):
    try:
        value = json.loads((directory / "seal.json").read_text())
        checksum = value.pop("sha256")
        if checksum != digest(value) or value["stamp"] != file_stamp(directory / "analysis.sqlite"):
            raise ValueError("changed")
        journal = Path(str(directory / "analysis.sqlite") + "-journal")
        if journal.exists():
            with journal.open("rb") as stream:
                if stream.read(8) == bytes.fromhex("d9d505f920a163d7"):
                    raise ValueError("hot rollback journal")
    except (OSError, ValueError, KeyError) as error:
        raise RuntimeError("Store mutation seal mismatch; run explicit audit before resuming") from error


def fast_identity(index_path, permission_path, runtime, recorded, source=None):
    if source is None:
        require_rollback_header(index_path)
        with closing(open_readonly_database(index_path)) as checked_source:
            require_rollback_source(checked_source)
    else:
        # Use the actual held connection; do not close another source descriptor
        # and thereby release process-wide POSIX locks on Linux.
        require_rollback_source(source)
    if file_stamp(index_path) != recorded["index_stamp"]:
        raise RuntimeError("Index identity mismatch; preserve the original immutable index")
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(index_path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError("Index has a live journal/WAL")
    scripts = [Path(__file__), Path(__file__).parents[1] / "python/local_cache.py",
               Path(__file__).parents[1] / "python/requirements.txt"]
    algorithm = rows_digest(((p.name, file_digest(p)) for p in scripts),
        [introspection.getsource(candidate_from_token), ELIGIBLE_TAGS, KOREAN_LEMMA.pattern])
    if (recorded["index_path"] != str(index_path) or recorded["runtime"] != runtime
            or recorded["permission_sha256"] != read_permission_record(permission_path)
            or recorded["algorithm_sha256"] != algorithm
            or recorded["schema_sha256"] != expected_schema_digest()):
        raise RuntimeError("Manifest/tool/index/source identity mismatch")
    return recorded


SCHEMA = """
CREATE TABLE manifest (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL,
                       sha256 TEXT NOT NULL) STRICT;
CREATE TABLE sources (source TEXT PRIMARY KEY, metadata TEXT NOT NULL) STRICT;
CREATE TABLE documents (document INTEGER PRIMARY KEY, source TEXT NOT NULL REFERENCES sources(source),
                        metadata TEXT NOT NULL) STRICT;
CREATE TABLE route (paragraph INTEGER PRIMARY KEY, slice INTEGER NOT NULL CHECK(slice BETWEEN 0 AND 19),
                    document INTEGER NOT NULL REFERENCES documents(document)) STRICT;
CREATE INDEX route_slice ON route(slice,paragraph);
CREATE TABLE slices (slice INTEGER PRIMARY KEY CHECK(slice BETWEEN 0 AND 19), expected INTEGER NOT NULL,
                     complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
                     new_lemmas INTEGER, cumulative_lemmas INTEGER, publication_sha256 TEXT) STRICT;
CREATE TABLE slice_summaries (slice INTEGER PRIMARY KEY REFERENCES slices(slice), payload TEXT NOT NULL) STRICT;
CREATE TABLE lemmas (lemma TEXT PRIMARY KEY, first_slice INTEGER NOT NULL REFERENCES slices(slice)) STRICT;
CREATE TABLE chunks (slice INTEGER NOT NULL REFERENCES slices(slice), chunk INTEGER NOT NULL,
                     first_row INTEGER NOT NULL, last_row INTEGER NOT NULL,
                     paragraphs INTEGER NOT NULL CHECK(paragraphs>0), tokens INTEGER NOT NULL,
                     eligible INTEGER NOT NULL, accepted INTEGER NOT NULL, rejected INTEGER NOT NULL,
                     elapsed REAL NOT NULL CHECK(elapsed>=0), details TEXT NOT NULL, sha256 TEXT NOT NULL,
                     PRIMARY KEY(slice,chunk)) STRICT;
CREATE TABLE facts (slice INTEGER NOT NULL, chunk INTEGER NOT NULL,
                    kind INTEGER NOT NULL CHECK(kind BETWEEN 0 AND 2), lemma TEXT NOT NULL,
                    pos TEXT NOT NULL, form TEXT NOT NULL, document INTEGER NOT NULL REFERENCES documents(document),
                    tokens INTEGER NOT NULL CHECK(tokens>0), oov INTEGER NOT NULL CHECK(oov BETWEEN 0 AND tokens),
                    hits INTEGER NOT NULL CHECK(hits>0 AND hits<=tokens),
                    PRIMARY KEY(slice,chunk,kind,lemma,pos,form,document),
                    FOREIGN KEY(slice,chunk) REFERENCES chunks(slice,chunk) DEFERRABLE INITIALLY DEFERRED
                   ) STRICT, WITHOUT ROWID;
CREATE INDEX facts_form ON facts(kind,form,lemma,pos);
CREATE VIEW completed_facts AS SELECT f.* FROM facts f JOIN slices s USING(slice) WHERE s.complete=1;
CREATE VIEW document_totals AS
 SELECT kind,lemma,pos,form,document,SUM(tokens) tokens,SUM(oov) oov,SUM(hits) hits
 FROM completed_facts GROUP BY kind,lemma,pos,form,document;
CREATE VIEW source_totals AS
 SELECT kind,lemma,pos,form,source,SUM(tokens) tokens
 FROM document_totals JOIN documents USING(document) GROUP BY kind,lemma,pos,form,source;
CREATE VIEW morphology_totals AS
 WITH documents_aggregate AS (
   SELECT kind,lemma,pos,form,SUM(tokens) token_count,SUM(oov) oov_token_count,
          SUM(hits) paragraph_hits,COUNT(*) document_count
   FROM document_totals GROUP BY kind,lemma,pos,form
 ), sources_aggregate AS (
   SELECT kind,lemma,pos,form,COUNT(*) source_count,MAX(tokens) max_source_token_count
   FROM source_totals GROUP BY kind,lemma,pos,form
 ) SELECT * FROM documents_aggregate JOIN sources_aggregate USING(kind,lemma,pos,form);
CREATE VIEW surface_interpretations AS
 SELECT form,COUNT(*) interpretation_count FROM
 (SELECT DISTINCT form,lemma,pos FROM completed_facts WHERE kind=1) GROUP BY form;
CREATE VIEW lemma_statistics AS
 SELECT m.*,
        (SELECT COUNT(DISTINCT pos) FROM completed_facts p WHERE p.kind=0 AND p.lemma=m.lemma) pos_interpretation_count,
        (SELECT COUNT(DISTINCT p.form) FROM completed_facts p JOIN surface_interpretations i USING(form)
         WHERE p.kind=1 AND p.lemma=m.lemma AND p.pos=m.pos AND i.interpretation_count>1) ambiguous_surface_count
 FROM morphology_totals m WHERE kind=0;
"""


def schema_digest(db):
    return rows_digest(db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))


def expected_schema_digest():
    with closing(sqlite3.connect(":memory:")) as db:
        db.executescript(SCHEMA)
        return schema_digest(db)


def connect(path, readonly=False):
    db = open_readonly_database(path) if readonly else sqlite3.connect(path, timeout=0)
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA temp_store=FILE")
    # SQLite's on-disk sorts also contain corpus-derived forms and must stay local.
    temporary_directory = str(path.parent).replace("'", "''")
    db.execute(f"PRAGMA temp_store_directory='{temporary_directory}'")
    if db.execute("PRAGMA temp_store_directory").fetchone() != (str(path.parent),):
        db.close()
        raise RuntimeError("SQLite cannot keep temporary analysis files in the cache store")
    db.execute("PRAGMA cache_size=-8192")
    if not readonly:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA synchronous=FULL")
    return db


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def writer_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "writer.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("A morphology writer is already active; use status or wait for it") from error
        yield


def legacy_audit(path, acknowledge):
    if path is None:
        return {"mode": "fresh-slice-zero-reanalysis", "imported_rows": 0,
                "reason": "Historical aggregate caches are never automatically imported"}
    if not acknowledge:
        raise RuntimeError("Legacy aggregates lack per-document/source contributions; use --reanalyse-slice-zero")
    with closing(open_readonly_database(path)) as db:
        if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise RuntimeError("Corrupted legacy analysis; preserve it and restore before identifying migration")
        counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("candidates", "candidate_surfaces", "candidate_eojeol_forms")}
    return {"mode": "identified-slice-zero-reanalysis", "path": str(path), "sha256": file_digest(path),
            "aggregate_rows": counts, "imported_rows": 0,
            "reason": "Aggregates cannot deduplicate documents/sources across slices; no safe exact reuse"}


def route_digest(db):
    return rows_digest(db.execute("SELECT * FROM route ORDER BY paragraph"),
                       [rows_digest(db.execute("SELECT * FROM documents ORDER BY document")),
                        rows_digest(db.execute("SELECT * FROM sources ORDER BY source"))])


def initialize(directory, index_path, identity, legacy, hook):
    target = directory / "analysis.sqlite"
    staging = directory / "initializing.sqlite"
    # Never published, so an interrupted initialization can be rebuilt independently.
    for suffix in ("", "-journal"):
        Path(str(staging) + suffix).unlink(missing_ok=True)
    with closing(connect(staging)) as db, closing(open_readonly_database(index_path)) as index:
        db.executescript(SCHEMA)
        with db:
            cursor = index.execute("SELECT * FROM source_files ORDER BY source_path")
            columns = [column[0] for column in cursor.description]
            for row in cursor:
                db.execute("INSERT INTO sources VALUES (?,?)", (row[0], encoded(dict(zip(columns, row))).decode()))
            cursor = index.execute("SELECT * FROM documents ORDER BY document_rowid")
            columns = [column[0] for column in cursor.description]
            for row in cursor:
                db.execute("INSERT INTO documents VALUES (?,?,?)", (row[0], row[1], encoded(dict(zip(columns, row))).decode()))
            for row in index.execute("SELECT paragraph_rowid,ordinal,document_rowid FROM paragraphs ORDER BY paragraph_rowid"):
                paragraph, ordinal, document = row
                if paragraph <= 0 or ordinal < 0:
                    raise RuntimeError("Invalid paragraph identity or ordinal")
                db.execute("INSERT INTO route VALUES (?,?,?)", (paragraph, ordinal % SLICE_COUNT, document))
            counts = dict(db.execute("SELECT slice,COUNT(*) FROM route GROUP BY slice"))
            db.executemany("INSERT INTO slices(slice,expected) VALUES (?,?)",
                           ((s, counts.get(s, 0)) for s in range(SLICE_COUNT)))
            payload = {"identity": identity, "legacy": legacy, "route_sha256": route_digest(db)}
            db.execute("INSERT INTO manifest VALUES (1,?,?)", (encoded(payload).decode(), digest(payload)))
    hook("before-initial-publication")
    os.replace(staging, target)
    fsync_directory(directory)
    seal_store(directory)
    hook("after-initial-publication")


def chunk_digest(db, row):
    return rows_digest(db.execute(f"SELECT * FROM facts WHERE slice=? AND chunk=? ORDER BY {FACT_ORDER}",
                                 row[:2]), list(row[:-1]))


def publication_digest(db, slice_id, new, cumulative):
    return rows_digest(db.execute("SELECT * FROM chunks WHERE slice=? ORDER BY chunk", (slice_id,)),
                       [slice_id, new, cumulative])


def unique_counts(db, slice_id):
    # Only the new slice is read; the indexed catalogue deduplicates previous lemmas.
    previous = db.execute("SELECT cumulative_lemmas FROM slices WHERE slice=?", (slice_id - 1,)).fetchone()
    previous = previous[0] if previous else 0
    db.execute("INSERT OR IGNORE INTO lemmas SELECT DISTINCT lemma,? FROM facts INDEXED BY sqlite_autoindex_facts_1 WHERE slice=? AND kind=0",
               (slice_id, slice_id))
    new = db.execute("SELECT changes()").fetchone()[0]
    return new, previous + new


def verify(db, identity, current_only=False):
    if schema_digest(db) != identity["schema_sha256"]:
        raise RuntimeError("Analysis schema mismatch; restore the verified DB")
    if not current_only and (db.execute("PRAGMA quick_check").fetchone() != ("ok",) or db.execute("PRAGMA foreign_key_check").fetchone()):
        raise RuntimeError("Corrupted analysis DB; preserve it and restore the last verified backup")
    manifest_rows = db.execute("SELECT payload,sha256 FROM manifest").fetchall()
    if len(manifest_rows) != 1:
        raise RuntimeError("Corrupted manifest")
    payload, checksum = manifest_rows[0]
    manifest = json.loads(payload)
    if digest(manifest) != checksum or manifest["identity"] != identity:
        raise RuntimeError("Manifest/tool/index/source identity mismatch; use the original inputs or a fresh store")
    if not current_only and route_digest(db) != manifest["route_sha256"]:
        raise RuntimeError("Partition routing checksum mismatch; no progress is safe")
    slices = db.execute("SELECT * FROM slices ORDER BY slice").fetchall()
    if len(slices) != SLICE_COUNT or [s[0] for s in slices] != list(range(SLICE_COUNT)):
        raise RuntimeError("Invalid slice bitmap")
    incomplete_seen = False
    current = next((s[0] for s in slices if not s[2]), None)
    for slice_id, expected, complete, new, cumulative, published in slices:
        if current_only and slice_id != current:
            if complete and incomplete_seen:
                raise RuntimeError("Out-of-order publication")
            if not complete:
                incomplete_seen = True
            continue
        actual = db.execute("SELECT COUNT(*) FROM route WHERE slice=?", (slice_id,)).fetchone()[0]
        if expected != actual:
            raise RuntimeError("Slice expected paragraph count mismatch")
        previous = 0
        count = 0
        for n, row in enumerate(db.execute("SELECT * FROM chunks WHERE slice=? ORDER BY chunk", (slice_id,))):
            _, chunk, first, last, paragraphs, tokens, eligible, accepted, rejected, elapsed, details_json, checksum = row
            span = db.execute("SELECT COUNT(*),MIN(paragraph),MAX(paragraph) FROM route WHERE slice=? AND paragraph>? AND paragraph<=?",
                              (slice_id, previous, last)).fetchone()
            if chunk != n or span != (paragraphs, first, last) or last <= previous:
                raise RuntimeError("Mismatched checkpoint range; would skip or duplicate paragraphs")
            if chunk_digest(db, row) != checksum:
                raise RuntimeError("Checkpoint checksum mismatch")
            details = json.loads(details_json)
            fact_rows = db.execute("SELECT COUNT(*) FROM facts WHERE slice=? AND chunk=?", (slice_id, chunk)).fetchone()[0]
            if (set(details) != {"facts_rows", "rejected_lemma_shapes", "rejected_spans"}
                    or any(type(v) is not int or v < 0 for v in details.values())
                    or details["facts_rows"] != fact_rows
                    or details["rejected_lemma_shapes"] + details["rejected_spans"] != rejected):
                raise RuntimeError("Checkpoint row/rejection accounting mismatch")
            facts = db.execute("SELECT COALESCE(SUM(tokens),0) FROM facts WHERE slice=? AND chunk=? AND kind=0",
                               (slice_id, chunk)).fetchone()[0]
            if accepted != facts or eligible != accepted + rejected or not (tokens >= eligible >= accepted >= 0):
                raise RuntimeError("Checkpoint token accounting mismatch")
            if db.execute("""SELECT 1 FROM facts f WHERE slice=? AND chunk=? AND NOT EXISTS
               (SELECT 1 FROM route r WHERE r.slice=f.slice AND r.document=f.document AND r.paragraph BETWEEN ? AND ?) LIMIT 1""",
                          (slice_id, chunk, first, last)).fetchone():
                raise RuntimeError("Checkpoint has an unrelated document")
            previous = last
            count += paragraphs
        if complete:
            if incomplete_seen or count != expected or published != publication_digest(db, slice_id, new, cumulative):
                raise RuntimeError("Invalid completed slice publication")
            summary = db.execute("SELECT payload FROM slice_summaries WHERE slice=?", (slice_id,)).fetchone()
            if not summary or json.loads(summary[0]) != slice_summary(db, slice_id):
                raise RuntimeError("Publication summary mismatch")
            # Counts are recomputed against earlier completed slices, not later ones.
            expected_new = db.execute("""SELECT COUNT(*) FROM (SELECT DISTINCT lemma FROM facts WHERE slice=? AND kind=0
                       EXCEPT SELECT DISTINCT lemma FROM facts WHERE slice<? AND kind=0)""", (slice_id, slice_id)).fetchone()[0]
            expected_cumulative = db.execute("SELECT COUNT(DISTINCT lemma) FROM facts WHERE slice<=? AND kind=0", (slice_id,)).fetchone()[0]
            if (new, cumulative) != (expected_new, expected_cumulative):
                raise RuntimeError("Publication unique lemma counts mismatch")
        else:
            if incomplete_seen and count:
                raise RuntimeError("Out-of-order slice checkpoint")
            incomplete_seen = True
            if any(value is not None for value in (new, cumulative, published)):
                raise RuntimeError("Partial slice mislabeled as published")
    if sum(s[1] for s in slices) != int(identity["index_metadata"]["paragraph_count"]):
        raise RuntimeError("Partition does not cover the complete index")
    if not current_only:
        actual_lemmas = rows_digest(db.execute("SELECT lemma,MIN(slice) FROM completed_facts WHERE kind=0 GROUP BY lemma ORDER BY lemma"))
        if actual_lemmas != rows_digest(db.execute("SELECT * FROM lemmas ORDER BY lemma")):
            raise RuntimeError("Lemma catalogue mismatch")
    return manifest


def add_paragraph(db, slice_id, chunk, document, text, analyzer):
    counts = Counter()
    oovs = Counter()
    tokens = eligible = accepted = rejected_shape = rejected_span = 0
    for token in analyzer.tokenize(text):
        tokens += 1
        eligible += int(str(token.tag) in ELIGIBLE_TAGS)
        candidate = candidate_from_token(token, text)
        if candidate is None:
            if str(token.tag) in ELIGIBLE_TAGS:
                lemma = str(token.form) + "다" if str(token.tag) in {"VV", "VA"} else str(token.form)
                if KOREAN_LEMMA.fullmatch(unicodedata.normalize("NFC", lemma)) is None:
                    rejected_shape += 1
                else:
                    rejected_span += 1
            continue
        lemma, pos, _tag, eojeol, surface, oov = candidate
        accepted += 1
        for kind, form in ((0, ""), (1, surface), (2, eojeol)):
            key = (kind, lemma, pos, form)
            counts[key] += 1
            oovs[key] += int(oov)
    for key, count in counts.items():
        db.execute("""INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(slice,chunk,kind,lemma,pos,form,document) DO UPDATE SET
          tokens=tokens+excluded.tokens,oov=oov+excluded.oov,hits=hits+1""",
                   (slice_id, chunk, *key, document, count, oovs[key], 1))
    return tokens, eligible, accepted, rejected_shape, rejected_span


def process_slice(db, index_path, slice_id, analyzer, checkpoint, hook, directory, index_stamp):
    # Routing was created once. The covering slice index visits only this residue and
    # primary-key probes fetch its paragraphs; no 20 repeated full-index text scans.
    db.execute("ATTACH DATABASE ? AS corpus", (index_path.as_uri() + "?mode=ro",))
    rows = None
    try:
        last, chunk = db.execute("SELECT COALESCE(MAX(last_row),0),COUNT(*) FROM chunks WHERE slice=?", (slice_id,)).fetchone()
        while True:
            rows = db.execute("""SELECT r.paragraph,r.document,p.form FROM route r INDEXED BY route_slice
                 CROSS JOIN corpus.paragraphs p ON p.paragraph_rowid=r.paragraph
                 WHERE r.slice=? AND r.paragraph>? ORDER BY r.paragraph LIMIT ?""",
                              (slice_id, last, checkpoint))
            first = rows.fetchone()
            if first is None:
                break
            started = time.monotonic()
            totals = [0, 0, 0, 0, 0]
            row_count = 0
            with db:
                for paragraph, document, text in chain((first,), rows):
                    stats = add_paragraph(db, slice_id, chunk, document, text, analyzer)
                    totals = [a + b for a, b in zip(totals, stats)]
                    row_count += 1
                    last = paragraph
                    hook("mid-checkpoint")
                details = {"facts_rows": db.execute("SELECT COUNT(*) FROM facts WHERE slice=? AND chunk=?", (slice_id, chunk)).fetchone()[0],
                           "rejected_lemma_shapes": totals[3], "rejected_spans": totals[4]}
                row = (slice_id, chunk, first[0], last, row_count, *totals[:3], totals[3] + totals[4],
                       time.monotonic() - started, encoded(details).decode(), "")
                checksum = chunk_digest(db, row)
                db.execute("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (*row[:-1], checksum))
                hook("before-checkpoint-commit")
            chunk += 1
            seal_store(directory)
            hook("after-checkpoint-commit")
            print(json.dumps({"slice": slice_id, "last_row": last, "committed_chunks": chunk}), file=sys.stderr, flush=True)
    finally:
        if rows is not None:
            rows.close()
    expected = db.execute("SELECT expected FROM slices WHERE slice=?", (slice_id,)).fetchone()[0]
    processed = db.execute("SELECT COALESCE(SUM(paragraphs),0) FROM chunks WHERE slice=?", (slice_id,)).fetchone()[0]
    if expected != processed:
        raise RuntimeError("Slice input rows disappeared; completion refused")
    # Verify every committed checkpoint before visibility changes. Cumulative views
    # switch with this same transaction; there is no separate fallible merge/copy.
    for row in db.execute("SELECT * FROM chunks WHERE slice=? ORDER BY chunk", (slice_id,)):
        if chunk_digest(db, row) != row[-1]:
            raise RuntimeError("Slice integrity failed before publication")
    if file_stamp(index_path) != index_stamp:
        raise RuntimeError("Index identity mismatch during analysis; publication refused")
    with db:
        new, cumulative = unique_counts(db, slice_id)
        db.execute("UPDATE slices SET complete=1,new_lemmas=?,cumulative_lemmas=?,publication_sha256=? WHERE slice=?",
                   (new, cumulative, publication_digest(db, slice_id, new, cumulative), slice_id))
        db.execute("INSERT INTO slice_summaries VALUES (?,?)", (slice_id, encoded(slice_summary(db, slice_id)).decode()))
        hook("during-publication")
    seal_store(directory)
    hook("after-publication")


def slice_summary(db, slice_id):
    processed, elapsed, tokens, accepted = db.execute("""SELECT COALESCE(SUM(paragraphs),0),COALESCE(SUM(elapsed),0),
          COALESCE(SUM(tokens),0),COALESCE(SUM(accepted),0) FROM chunks WHERE slice=?""", (slice_id,)).fetchone()
    details = Counter()
    for (value,) in db.execute("SELECT details FROM chunks WHERE slice=?", (slice_id,)):
        details.update(json.loads(value))
    return {"processed_paragraphs": processed, "elapsed_seconds": elapsed,
            "token_count": tokens, "accepted_morphemes": accepted,
            **{key: details[key] for key in ("facts_rows", "rejected_lemma_shapes", "rejected_spans")}}


def status(db, directory):
    manifest = json.loads(db.execute("SELECT payload FROM manifest").fetchone()[0])
    total = int(manifest["identity"]["index_metadata"]["paragraph_count"])
    slices = []
    for slice_id, expected, complete, new, cumulative, checksum in db.execute("SELECT * FROM slices ORDER BY slice"):
        summary = json.loads(db.execute("SELECT payload FROM slice_summaries WHERE slice=?", (slice_id,)).fetchone()[0]) if complete else slice_summary(db, slice_id)
        slices.append({"slice": slice_id, "expected_paragraphs": expected, "percent_of_index": 100 * expected / total if total else 0,
                       "complete": bool(complete), "new_unique_lemmas": new,
                       "cumulative_unique_lemmas": cumulative, "publication_sha256": checksum, **summary})
    completed = sum(s["expected_paragraphs"] for s in slices if s["complete"])
    error_path = directory / "error.json"
    return {"contract": CONTRACT, "identity": manifest["identity"], "legacy": manifest["legacy"],
            "slices": slices, "completion_bitmap": "".join("1" if s["complete"] else "0" for s in slices),
            "current_slice": next((s["slice"] for s in slices if not s["complete"]), None),
            "total_paragraphs": total, "verified_paragraphs": completed,
            "coverage_percent": 100 * completed / total if total else 100,
            "cumulative_unique_lemmas": next((s["cumulative_unique_lemmas"] for s in reversed(slices) if s["complete"]), 0),
            "disk_bytes": sum(p.stat().st_size for p in directory.iterdir() if p.is_file()),
            "disk_free_bytes": shutil.disk_usage(directory).free,
            "error": json.loads(error_path.read_text()) if error_path.exists() else None}


def save_error(directory, error):
    staging = directory / "error.tmp"
    try:
        with staging.open("wb") as stream:
            stream.write(encoded({"error": str(error) or type(error).__name__, "time_unix": time.time(),
                                  "action": "Restore compatible inputs/checkpoints, or free disk space, then resume"}))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staging, directory / "error.json")
        fsync_directory(directory)
    except OSError:
        # Out-of-space cannot always be logged on disk. The CLI still exits nonzero.
        pass


def run_next(*, index_path, directory, analyzer, runtime, permission_path=DEFAULT_PERMISSION_RECORD_PATH,
             checkpoint=128, legacy_path=None, reanalyse=False, hook=lambda _event: None):
    if not 1 <= checkpoint <= 4096:
        raise ValueError("checkpoint must be 1..4096")
    index_path = assert_cache_path(index_path, "indexes", "Corpus index")
    directory = assert_cache_path(directory, "runs", "Morphology store")
    if legacy_path:
        legacy_path = assert_cache_path(legacy_path, "runs", "Historical analysis")
    with writer_lock(directory):
        try:
            target = directory / "analysis.sqlite"
            if not target.exists():
                if (directory / "seal.json").exists():
                    raise RuntimeError("Store DB missing; restore the verified store instead of restarting")
                identity = source_identity(index_path, permission_path, runtime)
                initialize(directory, index_path, identity, legacy_audit(legacy_path, reanalyse), hook)
            check_seal(directory)
            # Do not close a second connection to this inode while holding the lock:
            # on Linux POSIX locks are process-wide and such a close releases them.
            require_rollback_header(index_path)
            with closing(open_readonly_database(index_path)) as source_lock:
                source_lock.execute("BEGIN")
                require_rollback_source(source_lock)
                source_lock.execute("SELECT value FROM index_metadata LIMIT 1").fetchone()
                with closing(connect(target)) as db:
                    db.execute("PRAGMA locking_mode=EXCLUSIVE")
                    db.execute("BEGIN EXCLUSIVE")
                    db.commit()  # Exclusive mode retains the lock across checkpoints.
                    check_seal(directory)
                    recorded = json.loads(db.execute("SELECT payload FROM manifest").fetchone()[0])["identity"]
                    identity = fast_identity(index_path, permission_path, runtime, recorded, source_lock)
                    verify(db, identity, current_only=True)
                    if legacy_path:
                        recorded = json.loads(db.execute("SELECT payload FROM manifest").fetchone()[0])["legacy"]
                        if recorded != legacy_audit(legacy_path, reanalyse):
                            raise RuntimeError("Historical migration identity mismatch")
                    next_slice = db.execute("SELECT slice FROM slices WHERE complete=0 ORDER BY slice LIMIT 1").fetchone()
                    if next_slice is not None:
                        if shutil.disk_usage(directory).free < 64 * 1024 * 1024:
                            raise RuntimeError("Insufficient free space (need at least 64 MiB headroom); free cache disk and resume")
                        try:
                            process_slice(db, index_path, next_slice[0], analyzer, checkpoint, hook, directory, identity["index_stamp"])
                        except BaseException:
                            # A caught interruption has completed SQLite rollback. Seal
                            # only our own transaction, never a failed entry check.
                            if not db.in_transaction:
                                seal_store(directory)
                            raise
                    (directory / "error.json").unlink(missing_ok=True)
                    result = status(db, directory)
                    completed_slice = next_slice[0] if next_slice is not None else None
                    row = result["slices"][completed_slice] if completed_slice is not None else None
                    summary = {"contract": CONTRACT, "result": "completed" if row else "no-op",
                            "completed_slice": completed_slice,
                            "slice_paragraphs": row["expected_paragraphs"] if row else 0,
                            "slice_percent_of_index": row["percent_of_index"] if row else 0,
                            "cumulative_verified_paragraphs": result["verified_paragraphs"],
                            "total_paragraphs": result["total_paragraphs"],
                            "coverage_percent": result["coverage_percent"],
                            "new_unique_lemmas": row["new_unique_lemmas"] if row else 0,
                            "cumulative_unique_lemmas": result["cumulative_unique_lemmas"],
                            "validation": "passed", "digest": row["publication_sha256"] if row else None,
                            "analysis_identity_sha256": digest(identity),
                            "elapsed_seconds": row["elapsed_seconds"] if row else 0,
                            "disk_bytes": result["disk_bytes"], "disk_free_bytes": result["disk_free_bytes"],
                            "completion_bitmap": result["completion_bitmap"], "local_store": str(directory)}
            summary["disk_bytes"] = sum(p.stat().st_size for p in directory.iterdir() if p.is_file())
            return summary
        except BaseException as error:
            save_error(directory, error)
            raise


def inspect(*, index_path, directory, runtime, permission_path=DEFAULT_PERMISSION_RECORD_PATH, audit=False):
    index_path = assert_cache_path(index_path, "indexes", "Corpus index")
    directory = assert_cache_path(directory, "runs", "Morphology store")
    with writer_lock(directory):
        if not audit:
            check_seal(directory)
        # Audit also allows SQLite to recover a hot rollback journal. It never
        # rewrites facts/checksums or silently blesses changed contributions.
        with closing(connect(directory / "analysis.sqlite", readonly=not audit)) as db:
            if audit:
                db.execute("PRAGMA locking_mode=EXCLUSIVE")
                db.execute("BEGIN EXCLUSIVE")
                db.commit()
            recorded = json.loads(db.execute("SELECT payload FROM manifest").fetchone()[0])["identity"]
            identity = source_identity(index_path, permission_path, runtime) if audit else fast_identity(index_path, permission_path, runtime, recorded)
            db.execute("BEGIN")
            if not audit:
                check_seal(directory)
            verify(db, identity, current_only=not audit)
            result = status(db, directory)
            db.rollback()
            if audit:
                seal_store(directory)
                result["validation"] = "full-audit-passed"
        result["disk_bytes"] = sum(p.stat().st_size for p in directory.iterdir() if p.is_file())
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run-next", "status", "audit"))
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE)
    parser.add_argument("--checkpoint-paragraphs", type=int, default=128)
    parser.add_argument("--legacy-analysis", type=Path)
    parser.add_argument("--reanalyse-slice-zero", action="store_true")
    arguments = parser.parse_args()
    try:
        runtime = runtime_identity()
        options = {"index_path": arguments.index, "directory": arguments.store, "runtime": runtime}
        if arguments.command in {"status", "audit"}:
            result = inspect(**options, audit=arguments.command == "audit")
        else:
            from kiwipiepy import Kiwi
            result = run_next(**options, analyzer=Kiwi(num_workers=1),
                         checkpoint=arguments.checkpoint_paragraphs, legacy_path=arguments.legacy_analysis,
                         reanalyse=arguments.reanalyse_slice_zero)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except KeyboardInterrupt:
        print("Morphology interrupted; committed checkpoints are preserved. Rerun to resume.", file=sys.stderr)
        return 130
    except (OSError, sqlite3.Error, RuntimeError, ValueError, KeyError, TypeError, IndexError) as error:
        print(f"Morphology stopped: {error}. No partial slice is published; inspect the store and resume after repair.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
