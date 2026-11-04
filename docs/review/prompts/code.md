# General code / mixed PR — focused first technical review

Read the PR HEAD's root `REVIEW.md` first. Use this route for code, CI, schema, producer/validator, War Room implementation, mixed data+code changes, unclassified files and PR types that do not meet exactly one of the Candidate/S2/S3 data-only routes. Do not infer a safe data-only shortcut solely from a PR title or directory prefix.

## Procedure

1. Read the complete PR changed-file list (merge-base to HEAD); verify requirements and material changed design, source/producer → validator/enforcer → consumer/output paths, and realistic valid/invalid behavior. Check affected ownership, retry/recovery, provenance, persistence and build boundaries only when touched. The first review is focused; do not silently substitute a removed comprehensive independent second technical review.
2. Use bounded file-scoped diff and existing shared validations; independently test the smallest plausible failure path when necessary. Do not demand a fixed adversarial probe quota, exhaustive history/CI or speculative impossible post-build mutations.
3. Confirm that a demonstrated common defect is corrected in the shared rule for applicable existing and future cases, with reusable regression evidence. Reject example-only fixes, per-word/per-batch tests and one-off validation that does not protect current behavior. Challenge redundant permanently registered tests and unnecessary CI burden.
4. On follow-up read earlier blockers/author replies and the previous reviewed HEAD→current HEAD delta first. Validate actual fixes and direct regressions; do not repeat a full initial pass or discover unrelated unchanged defects absent a concrete connection.
5. If this PR changes a specialist area, open only the necessary card(s): `search.md` (search), `toolchain.md` (CI/validators/build), `extension.md` (MV3/WASM/UI), `licensing.md` (provenance/external source), or `data.md` (Canonical/STDICT). Avoid reading all of them automatically.
6. Confirmed material failures are `-1`; otherwise provide evidence-bearing `+1` immediately. Never inspect GitHub CI run status in first technical review; only final Stage 2 under `REVIEW.md` checks CI and merges.

The linked implementation issue is the task/acceptance source for **code** PRs; this file owns the reviewer procedure. Do not treat task-local exploratory checks as standing regression requirements without a demonstrated risk.
