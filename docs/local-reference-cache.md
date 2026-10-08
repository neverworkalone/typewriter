# Shared local reference cache

Typewriter stores machine-local source material, reference indexes, evidence packs, and run outputs outside Git at `~/.cache/typewriter/`. Every worktree for the same user resolves this same location through [`scripts/typewriter-cache.mjs`](../scripts/typewriter-cache.mjs). Set `TYPEWRITER_CACHE_ROOT` to an absolute path only when the machine needs a different cache volume; Python and Node tools use the same override.

```text
~/.cache/typewriter/
├── corpus/       approved written-corpus source files
├── literature/   approved public-domain TXT sources
├── indexes/      corpus and literature SQLite indexes and manifests
├── evidence/     source/batch-bound evidence packs
└── runs/         task-scoped mutable outputs
```

The path is a storage location, not source evidence. Corpus, index, literature, and hand-off checks continue to bind inputs by their existing file, manifest, logical-row, and location digests. Historical producer source hashes are checked against the exact Git blob retained in history; tracked review evidence is not rewritten. Tracked candidates, reviews, canonical data, and timing publications stay in the repository.

## Output ownership

Read-only source trees and indexes can be shared directly. Mutable outputs live below a run or source identifier, such as `runs/<task-id>/` or `evidence/<batch-id>/<candidate-id>/`. Producers create outputs without replacing files that already exist. A task should use a fresh ID when starting a distinct run.

Stage 1 accepts its text-free candidate evidence from the shared cache and places optional attempt logs, ensemble traces, proposals, and review packs in `runs/<task-id>/`. Corpus candidate production defaults to `runs/<batch-id>/`. Literature evidence packs use `evidence/<batch-id>/<candidate-id>/`.

## Migrating an existing worktree

The migration command reads only the source directory passed to it; it never searches sibling worktrees. First inspect the plan, then copy and verify:

```bash
node scripts/reference/migrate-local-reference.mjs
node scripts/reference/migrate-local-reference.mjs --apply
```

For another specific worktree, pass that exact source path:

```bash
node scripts/reference/migrate-local-reference.mjs \
  --source /path/to/typewriter/data/reference
```

The default plan is read-only. `--apply` copies files without overwriting and checks their SHA-256 digests. Any differing destination stops the operation before copying. The source remains available for rollback. Use `--move` only after legacy writers have stopped. It atomically isolates that source tree, verifies its file inventory and every SHA-256 digest again, then removes it; any mismatch restores and retains the source. It refuses removal if it finds a local `venv` or `.venv`. Virtual environments are runtime state and are not migrated as reference data.

The migration preserves the relative run/source identifiers while mapping the old top-level folders:

| Old worktree path | Shared cache path |
| --- | --- |
| `corpus/` | `corpus/` |
| `public-domain/` | `literature/` |
| `indexes/` | `indexes/` |
| `literature-evidence/<batch>/<candidate-id>.{pack.json,md,summary.json}` | `evidence/<batch>/<candidate-id>/{pack.json,evidence.md,summary.json}` |
| `production/<issue>/<run>/` | `runs/<issue>/<run>/` |
| `pilots/<pilot>/` | `runs/<pilot>-pilot/` |
| `timing/<batch>.jsonl` | `runs/timing/<batch>.jsonl` |
| `benchmark-274/` | `runs/benchmark-274/` |

Unrecognized legacy folders are placed under `runs/legacy/` so they remain reviewable instead of colliding with a named artifact area. `.DS_Store` files are skipped. Historical tracked reports keep their original recorded paths when those paths describe where an earlier run actually wrote its artifacts.

## Validation boundary

Normal and deep CI use tracked data and synthetic fixtures; they do not require a developer's local corpus or literature collection. The explicit local evidence checks still fail closed on a missing artifact, a digest mismatch, an unapproved source, or a path outside its allowed cache area.
