# Issue #125: deterministic projection cleanup

Issue #125 removes deterministic, reconstructible projections from the tracked
canonical-data surface. The authoritative inputs remain reviewable in Git; the
current projections are rebuilt in memory or in a temporary workspace.

## Artifact decisions

| Artifact | Decision | Producer | Consumers / replay contract |
| --- | --- | --- | --- |
| Current target inventory | Do not track | `buildTargetInventory()` joins `data/canonical/` with `data/inventory/m5-target-seed.json` | Target-inventory validation and M5 admission/recovery gates consume the in-memory object. |
| Current semantic coverage | Do not track | `buildSemanticCoverageArtifact()` | The current audit builder and batch gates consume the in-memory coverage facts. |
| Current semantic review | Do not track as a standalone projection | Authored decisions in `canonical-semantic-decision-source.json` | The current audit builder validates the source and assembles review rows in memory. |
| Current semantic audit | Do not track | `buildCanonicalSemanticAudit()` | Dataset integrity, normalization, inventory validation, promotion, refresh, and batch recovery consume the in-memory envelope. |
| Historical standalone coverage/review | Do not track | Historical audit envelopes already contain the scoped coverage and review | Historical `m5-10-wave-b` and `m5-10a-wave-a2` audit files remain the replay boundary and retain their embedded evidence. |
| Semantic boundary decisions | Keep tracked | Authored correction/review input | `apply-semantic-corrections.mjs` and correction tests consume this independent source. It is not a deterministic projection. |
| Canonical semantic decision source | Keep tracked | Authored editorial source | Current audit reconstruction and correction workflows use its source ID, digest, and authored decisions. |
| Historical canonical snapshot directories | Keep tracked | Batch stage capture | Historical manifests and replay validators bind exact paths and hashes. Migrating those contracts is outside this issue. |

The removed current projection paths remain compatibility labels in a few
historical reports and batch evidence objects. They are explicitly marked as
on-demand materializations; code only reads a file when a caller supplies an
explicit path or when a historical replay requires one.

## Machine-enforced policy

`config/artifact-policy.json` classifies the complete `data/**` surface into
deterministic projections and durable inputs. The validator at
`scripts/validate/artifact-policy.mjs` fails when:

- a classified deterministic projection is tracked;
- an equivalent projection is relocated under another data path or renamed;
- an unclassified file is added under the protected data root;
- a generated projection is materialized in the working tree; or
- CI is asked to validate a dirty checkout with `--clean`.

The policy recognizes both projection filenames and projection roles (semantic
audit/coverage/review contracts and target-inventory shape). Historical
projection envelopes are allowed only through explicit durable exceptions.
The same check is available locally as `npm run validate:artifacts` and is run
against a clean checkout in CI. The policy is intentionally pattern-based and
does not impose a blanket line or byte limit on `data/batches/**` or
`data/validation/**`.

## Reproducibility evidence

The current canonical source digest is
`334210c4739b3007980da17d1b76ee9baa7e093076afac24ec70701128686e2f`.
Rebuilding the current projections before removing their files produced the
same serialized bytes as the tracked versions:

- semantic audit: 8,975,962 bytes, SHA-256
  `2564a391135f94557f12751b612e68c023ea7afb501c3a7fd239ef548a48302b`;
- target inventory: 821,065 bytes, SHA-256
  `f2a7c36547ca4db4b3dd2bc2b3b5f8962e991aa900b42ffce34533b84e57bc67`.

The eight removed tracked projections represented 26,692,742 bytes and
620,433 newline-terminated lines in the pre-change tree. This changes the
current tree and future diff surface only; it does not rewrite or shrink Git
history. Existing historical audit envelopes and canonical snapshot directories
remain available for deterministic replay.

## Retained decision-source diff locality

`canonical-semantic-decision-source.json` remains the durable authored source;
it is not regenerated from canonical data. Correction application clones that
source, replaces only the addressed authored review records, updates the
source digest, and serializes the result with the stable
`serializeSemanticDecisionSource()` representation. The representative
`semantic-decision-source-locality` test applies a one-record future-batch
decision change and asserts that unaffected records remain identical and that
only a bounded number of serialized lines change. This guards the retained
authoritative source against whole-corpus rewrites while preserving its
complete historical decisions.

M5-11 promotion follows the same authority boundary: it binds the promotion
evidence to the durable decision-source path, digest, and source ID, then
reconstructs the semantic audit from the prospective canonical directory both
before and after the writes. Promotion succeeds only when that reconstruction
matches the admitted audit byte-for-byte; the ordinary post-promotion
validator repeats the source-bound reconstruction.
