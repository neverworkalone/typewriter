# MO-3 public-surface audit

- Issue: [#152 — Audit and sanitize full public surface and Git history](https://github.com/neverworkalone/typewriter/issues/152)
- Audit date: 2026-09-24
- Audited base revision: `3b17637836045f95fd9780ca370b355b36ff6e7e` (master after #151 / PR #164)
- Repository visibility: private; this audit does not change it.
- Result: **HOLD — unresolved publication blockers remain.**

## Scope and findings

The audit covered the complete reachable Git history available locally, including
the fetched heads of all 79 GitHub pull requests; the current tracked tree;
GitHub issue and pull-request descriptions, comments, reviews, and inline review
comments; Actions logs and artifacts; repository branches, tags, and releases;
and the prior record-level license/provenance findings in
[`license-provenance-audit.md`](license-provenance-audit.md).

| Surface | Result |
| --- | --- |
| Git history and current tree secrets | Gitleaks v8.30.1 reported no findings in the full reachable history or the 539-file tracked tree (about 72.4 MB). The full-history scan covered about 307.8 MB. Both runs used redacted output. |
| GitHub discussion secrets and sensitive strings | Scanned 85 issues, 79 pull requests, and 772 collected text surfaces (about 1.34 MB); no credential, key, or personal-email pattern was found in current text. |
| Discussion sanitization | Updated 18 existing GitHub text surfaces. Removed local machine/repository/temp paths, nine Figma links whose sharing state could not be verified, and one private Codex reference. A follow-up scan found no such values in the edited current text or the corresponding edit events. |
| Actions | Downloaded and scanned all 362 workflow logs. No credentials, keys, or personal email patterns were found. Absolute paths were standard ephemeral GitHub-hosted runner and temporary-workspace paths. The repository had zero Actions artifacts. |
| Branches, tags, releases | The repository has only the `master` branch, no tags, and no releases. The 79 pull-request head refs were fetched and included in the local history audit. |
| Personal commit metadata | **Blocker.** Existing reachable history contains a personal mailbox in 458 author records and 369 committer records. The exact address is intentionally omitted from this report. A normal push to `master` cannot rewrite GitHub's pull-request head refs; a history cleanup needs a coordinated plan covering those refs and a post-rewrite verification. |
| Canonical data and derived artifacts | **Blocker.** The corpus contains 5,042 canonical records (5,000 search starts and 42 reference-only records). Per-record source and redistribution rights are not established. Per the owner's decision recorded in #151, every untraceable record remains held; the corpus and data-bearing derived artifacts are not cleared for redistribution. |
| External or restricted source material | **Unresolved with the data hold.** No record-level source history exists that can rule out external dictionaries, APIs, corpora, or licensed data materially informing any of the 5,042 records. Therefore this audit cannot certify the absence of restricted or raw third-party material in current or historical data-bearing objects. |

No secret rotation was indicated by the completed secret scans. This does not
resolve the historical personal-email metadata or the corpus provenance hold.

## Checks and one-time audit

- Gitleaks v8.30.1 was run once for this audit against the current tracked tree
  and all locally reachable history, with a personal-home-path rule in addition
  to its default secret checks. It reported no findings. This one-time result is
  audit evidence and does not run in CI.
- `npm run validate:public-surface` scans tracked text files for absolute
  personal home paths on macOS, Linux, and Windows. Findings report relative
  filenames and path categories without printing matched path values.
- `npm run validate:commit-metadata` checks new commits in the CI change range
  and requires GitHub no-reply author and committer addresses. On pull-request
  events it excludes GitHub's synthetic merge commit and inspects the PR branch
  tip. Findings report commit IDs and roles, not the address values.
- Both validators and focused regression tests are registered in the normal CI
  artifact/clean-checkout category.

## Validation evidence

- Focused validator, metadata, and CI workflow tests: 13 passed.
- `npm run validate:public-surface`: passed on 545 tracked files in the staged
  deliverable.
- `npm run validate:commit-metadata`: passed; both audit branch commits use
  GitHub no-reply author and committer addresses.
- One-time Gitleaks v8.30.1 scan at audit head `ee93712a173edb6d55803f58c4e2aead34ad6dba`,
  with the audit's custom rule: no findings in the 545-file tree (about 72.42
  MB) or locally reachable history (443 commits, about 307.79 MB). A synthetic
  home-path fixture was detected with its value redacted.
- `git diff --check`: passed. `actionlint` is unavailable in this environment;
  the workflow regression test verifies that Gitleaks is absent from CI.
- No history rewrite was performed, so post-rewrite clean-clone validation is
  pending with the blockers above.

## Remaining work before #152 can close

1. Resolve the existing personal-email commit metadata across every reachable
   GitHub ref, including pull-request head refs; then rerun full-history and
   clean-clone validation. No history rewrite was performed in this audit.
2. Produce a verifiable source-and-rights disposition for each canonical
   record. Records with unknown sources must remain out of public canonical data;
   after removal or independent re-authoring and re-admission, rebuild every
   dependent artifact and refresh its evidence and counts.
3. Re-scan reachable history and GitHub-hosted surfaces for prohibited
   data-bearing material after the record dispositions and any history cleanup.
4. Close only after the publication blocker list reaches zero. Keep the
   repository private until the later #157 cutover gate.

The selected Apache-2.0 code, CC BY 4.0 documentation and cleared-data policy,
and All Rights Reserved brand policy remain as recorded in the #151 audit.
This report grants no rights to held dictionary content and does not authorize
a repository visibility change.
