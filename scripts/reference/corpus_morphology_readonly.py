#!/usr/bin/env python3
"""Read-only verification for consumers of the sealed corpus morphology store."""

from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import corpus_morphology as morphology
from corpus_lemma_pilot import open_readonly_database


def inspect_readonly(*, index_path, directory, runtime, permission_path=morphology.DEFAULT_PERMISSION_RECORD_PATH,
                     temporary_directory=None):
    """Run the complete source/store audit without a writer lock or seal renewal.

    This consumer path accepts only an already sealed store. It cannot recover a
    hot journal or refresh a stale mutation witness; changed inputs, publications,
    or persisted facts fail closed.
    """
    index_path = morphology.assert_cache_path(index_path, "indexes", "Corpus index")
    directory = morphology.assert_cache_path(directory, "runs", "Morphology store")
    morphology.check_seal(directory)
    database_path = directory / "analysis.sqlite"
    with closing(open_readonly_database(database_path)) as db:
        temporary_directory = Path(temporary_directory or directory.parent).resolve()
        db.execute("PRAGMA temp_store=FILE")
        escaped = str(temporary_directory).replace("'", "''")
        db.execute(f"PRAGMA temp_store_directory='{escaped}'")
        if db.execute("PRAGMA temp_store_directory").fetchone() != (str(temporary_directory),):
            raise RuntimeError("SQLite cannot keep verification temporary files outside the read-only store")
        db.execute("PRAGMA query_only=ON")
        rows = db.execute("SELECT payload FROM manifest").fetchall()
        if len(rows) != 1:
            raise RuntimeError("Corrupted manifest")
        recorded = json.loads(rows[0][0])["identity"]
        identity = morphology.source_identity(index_path, permission_path, runtime)
        db.execute("BEGIN")
        morphology.check_seal(directory)
        morphology.verify(db, identity, current_only=False)
        result = morphology.status(db, directory)
        db.rollback()
    morphology.check_seal(directory)
    if identity != recorded:
        raise RuntimeError("Manifest/tool/index/source identity mismatch")
    result["validation"] = "full-audit-passed-read-only"
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=morphology.DEFAULT_INDEX)
    parser.add_argument("--store", type=Path, default=morphology.DEFAULT_STORE)
    arguments = parser.parse_args()
    try:
        result = inspect_readonly(
            index_path=arguments.index,
            directory=arguments.store,
            runtime=morphology.runtime_identity(),
        )
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, sqlite3.Error, RuntimeError, ValueError, KeyError, TypeError, IndexError) as error:
        print(f"Read-only morphology verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
