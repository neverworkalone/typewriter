# Public Repository and Data Boundary

## Purpose and status

This document defines which repository paths and GitHub-hosted surfaces are intended
to be public, which require separate licensing, and which must stay private or be
removed before publication. It is the MO-1 boundary for the later license/provenance
audit (#151), public-surface and history audit (#152), and release preparation.

The classifications below describe project licensing and concrete content
restrictions. The repository is public for owner-approved research and
development, and the owner's 2026-10-12 release decision permits Typewriter's
independently authored lexical output under the project data license. This covers
the current canonical data and generated SQLite, Chrome Extension, Pages product,
and original project code/data in GitHub to the extent Typewriter controls the
rights. It does not expand the grant to third-party material.

The inventory was first checked against the tracked tree at f3822cf (the M5
final-audit merge, 2026-09-24); its path and GitHub surface notes are historical
audit context. The 2026-10-12 owner decision supersedes the former global data
hold and exhaustive history/surface audit as release prerequisites. For a release,
check the exact intended revision, deterministic output, package contents,
licenses/notices, and applicable Store or Pages requirements. Remediate a
specific demonstrated exposure in the target artifact; unknown ancestry alone
does not block independently authored output.

## Approved use and current release scope

**Research and development use — approved.** The owner confirmed that the
application to use the National Institute of Korean Language (NIKL) Written Corpus
2025 was approved for Typewriter's research/development reference role, as recorded
in `docs/external-material-review-written-corpus-2025.md`. That role covers
local storage, schema scanning and processing, local SQLite/FTS indexing, and
lexical-reference use. The raw corpus text, paragraphs, excerpts, and local
analysis index must never be committed, exposed in GitHub artifacts, or included
in the product.

**Public development workflow — existing owner decision.** Typewriter's GitHub
repository is public and is used for research/development with Typewriter-authored
lexical records and traceable editorial/batch artifacts. The owner explicitly
confirmed this operating policy for M10 in issue #239. Continuing ordinary
development PRs under this policy is distinct from distributing a packaged
Chrome Extension. Pending product approval alone is not a new reason to block
every research/development batch PR. A concrete new exposure of restricted source
text, copied passages, raw indexes, sensitive information, or another demonstrable
rights violation must still be reviewed and stopped.

**NIKL result-publication approval — met for the submitted result.** The owner
confirmed on 2026-10-12 that the NIKL portal shows `승인` for the application
submitted on 2026-09-27. The submitted result is Typewriter, classified as
`인공지능 모델/서비스/제품`, targeting the existing Chrome Web Store listing.
This meets the NIKL result-publication approval condition for that application.
The approval record does not include an approval number, decision timestamp, or
conditions not shown in the owner-provided evidence; see
[`external-material-review-written-corpus-2025.md`](external-material-review-written-corpus-2025.md).
Typewriter 0.1 predates corpus use and contains no corpus-informed records.

**Owner release decision — independently authored Typewriter output may ship.**
The current canonical JSONL, generated `dictionary.sqlite`, Chrome Extension,
Pages product, and original project code/data in the public repository are
distributable under the applicable project terms to the extent Typewriter owns
or controls the rights. No individual-word clearance map or exhaustive audit of
all historical refs, discussions, Actions logs, attachments, or hosted surfaces
is a general release prerequisite.

Keep raw NIKL corpus files, corpus passages and excerpts, local corpus indexes
and analysis databases, verbatim third-party dictionary/API material, leaked
credentials, and specifically demonstrated third-party infringements out of
public artifacts. If a concrete violation is found, remove or clear the affected
item; unknown source ancestry alone does not impose a global hold. For each
release, select the exact canonical revision, run the deterministic build and
package/content/license/notice checks, and satisfy applicable Chrome Web Store or
Pages requirements. The NIKL source attribution recorded in
`docs/external-material-review-written-corpus-2025.md` remains part of the
approved result's public attribution.

## Classification states

- `PUBLIC` — may be visible without a separate project-specific license decision;
  review any personal or security-sensitive metadata before release.
- `PUBLIC-WITH-SEPARATE-LICENSE` — intended to be public, with a distinct license,
  attribution, notice, or brand rule that must be finalized first.
- `PURGE-BEFORE-PUBLIC` — the current item or unapproved artifact must be rewritten,
  removed, or cleared before publication. This does not mean deleting an entire
  category when only individual violating items need remediation.
- `KEEP-PRIVATE` — do not commit, distribute, or expose this material.


**Interpretation of publication states in the existing public R&D repository:**
The path classifications below describe rights and safety checks for reuse,
redistribution, and release; they do not reverse the owner's decision to keep
the R&D repository public. In particular, `PURGE-BEFORE-PUBLIC` is a historical
classification label for material requiring audit/remediation before a new
public release or artifact exposure, not an instruction to reopen repository
visibility at every ordinary development PR. New restricted material must not
be introduced into the existing public repository.

## Repository path matrix

| Path / role | State | Owner and origin | Source role and external material | Privacy, rights, and required action |
| --- | --- | --- | --- | --- |
| src/, scripts/, schema/, tests/, config/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project code and authored validation fixtures; check any file-level third-party content | Application, build, schema, validation, and test source. Fixtures may reproduce project data or historical decisions. | Original Typewriter software/configuration is Apache-2.0 under #151. Fixture material that reproduces uncleared data remains held under the data boundary. Verify source text, paths, and credentials against the exact release commit. |
| `popup.html`, `options.html`, `pack.py`, `pack.sh`, `package.json`, `pnpm-lock.yaml`, `vite.config.js`, `vitest.config.js` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project; lockfile identifies third-party packages | Extension entrypoints and build/dependency metadata; SQLite WASM is a pinned runtime dependency. | Original software/configuration is Apache-2.0. Third-party packages retain their own licenses; shipped dependency terms are recorded in `THIRD-PARTY-NOTICES.txt`. |
| .github/workflows/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project automation | CI workflow source; runs may produce logs and artifacts hosted separately by GitHub. | Original workflow source is Apache-2.0 under LICENSE.md. Use the registered CI and exact package checks for a release; restrict a specific log, artifact, or ref only when it is shown to expose prohibited material. An exhaustive historical audit is not a general release gate. |
| docs/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project documentation and editorial/process records | Development, design, data-policy, review, M5 reports, and audit evidence. This remains the documentation authority; it is not the Pages source tree. | Original documentation text is CC BY 4.0. Embedded canonical data, third-party material, and marks are excluded. Keep raw source excerpts, sensitive details, and specifically identified restricted content out of the exact release artifact. |
| AGENTS.md, REVIEW.md | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project process documentation | Repository instructions and review policy. | Original process documentation is CC BY 4.0. Check paths, credentials, and personal data at the release boundary; preserve canonical/admission safeguards. |
| data/canonical/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter-authored lexical records; external works may inform research, while the stored result is curated and authored by Typewriter | Canonical source of truth for words, senses, expressions, and relations; these records feed generated SQLite. | Typewriter-authored output is distributable under CC BY 4.0 to the extent Typewriter controls the rights. Remove or clear a specific record only when evidence demonstrates protected copied content or another concrete violation; missing per-record source history alone is not a blanket hold. |
| data/inventory/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter editorial planning and promotion decisions | Target selection, classification, hold/reject/defer state, and promotion history; not canonical build input. | Typewriter-authored planning and promotion records may be distributed under the project license. Keep raw source text and private local review material out; remediate any specifically identified copied third-party content. |
| data/batches/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter process evidence, authored decisions, and historical snapshots | Manifests, digests, review decisions, relation evidence, and frozen historical inputs; some files duplicate canonical records for reproducibility. | Authored evidence may be distributed under the project license. Do not include raw corpus passages or verbatim third-party material; a historical snapshot is not globally held solely because a per-record rights map is absent. |
| data/validation/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter-authored semantic decisions and validation inputs | Durable decisions and source-bound audit inputs; validation projections may be reproducible from these sources. | Typewriter-authored validation records may be distributed under the project license. Keep local raw-source material private and remediate any specifically demonstrated infringement. |
| public/manifest.json | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter extension manifest | Product metadata and permissions for the Chrome Extension. | Original manifest/configuration is Apache-2.0. Verify metadata, permissions, and URLs against the exact release commit. |
| `public/logo.png`, `public/icon*.png`, `public/favicon.ico` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter / Never Work Alone brand assets | Logo, icons, and visual identity used by the extension and future web surface. | The owner confirmed direct creation and ownership. All Rights Reserved under `BRAND.md`; no artwork or mark reuse grant is made. |
| `THIRD-PARTY-NOTICES.txt`, `Apache-2.0.txt` | `PUBLIC-WITH-SEPARATE-LICENSE` | Third-party SQLite WASM and Vue runtime notices; Apache-2.0 license text | Notices cover `@sqlite.org/sqlite-wasm` 3.53.0-build1 and bundled Vue 3.5.42 runtime modules. | Preserve the upstream terms and complete notices in each package. #151's package validator compares shipped legal files with repository sources. |
| README.md | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project entrypoint and owner-authored project documentation | Public visitor guide covering product status, architecture, onboarding, and reuse boundaries. | Original README prose is CC BY 4.0. It records the approved release scope and concrete exclusions; embedded third-party material and marks retain their own terms. |
| `LICENSE.md`, `DATA-LICENSE.md`, `BRAND.md`, `PRIVACY.md` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter license, brand, and extension privacy notices | Defines code, data, documentation, brand, and current extension privacy boundaries. | Their original explanatory text is CC BY 4.0; the grants and exclusions in each file govern the corresponding material. Embedded third-party license texts and brand assets are excluded. Verify the privacy notice against the exact package permissions and runtime behavior. |
| .gitignore | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project repository configuration | Ignore rules for local and generated files. | Original repository configuration is Apache-2.0. Ignore rules do not replace checks that the exact release artifact excludes raw corpus files, credentials, and other specifically restricted material. |
| Transient dist/, artifacts/, local SQLite files, and unapproved extension archives | PURGE-BEFORE-PUBLIC | Generated locally from canonical data and pinned dependencies | Build/package outputs, not editable sources of truth; none are tracked at the boundary revision. | Do not commit or attach scratch outputs. Validate the exact intended artifact for allowed files, Typewriter-authored data, licenses/notices, and concrete restricted content; no blanket hold applies to a valid package. |
| Allowlisted Pages artifact and extension release package, including dictionary.sqlite | PUBLIC-WITH-SEPARATE-LICENSE | Deterministic build from the selected canonical revision and pinned dependencies | Generated distribution surface; SQLite contains canonical data and the package contains third-party runtime files. | Publish after exact-revision, deterministic-build, package-content/license/notice, and applicable Store or Pages checks pass. Exclude raw corpus and specifically identified copied or restricted content. Repository policy documents stay out of the Store ZIP; publish and link the privacy policy through the Store disclosure flow when required. Record the canonical revision. |
| Future `web/` source and `vite.web.config.js` | `PUBLIC-WITH-SEPARATE-LICENSE` | Planned Typewriter web product source; not present at this boundary revision | Separate Pages source and presentation layer over the shared runtime. | Original web software/configuration is Apache-2.0; Typewriter-authored data follows the project data license; brand remains All Rights Reserved. Keep it separate from `docs/` and extension `public/`. |

The original root-file groupings were checked against the tracked tree at the
boundary revision with git ls-tree and git ls-files. Recheck the complete path
inventory against the exact release commit. No generated SQLite or package output
was tracked at the boundary revision.

## GitHub-hosted publication surfaces

These are not repository paths, but repository visibility can expose them alongside
the Git tree.

| Surface | State | Required action before public visibility |
| --- | --- | --- |
| Issues, issue comments, PR bodies/comments, review submissions/comments, attachments | `PUBLIC` | These surfaces are outside repository license grants. Keep safe project discussion public; remove or restrict a specific item if it is shown to expose raw source text, copied third-party content, credentials, personal data, or another concrete violation. No exhaustive review of every historical item is a release prerequisite. |
| Commit metadata, branches, tags, releases, release assets | `PUBLIC` | Use the intended exact source revision for each release. Restrict or remove a specific ref or asset only when it is shown to retain prohibited material; no blanket audit of every historical ref is required. |
| Actions logs and artifacts | `PUBLIC` | Check the target release artifacts and address a specifically identified secret, private path, raw source, or restricted output. No exhaustive audit of all historical logs or artifacts is a general release prerequisite. |
| Repository discovery metadata (description, topics, badges, public links) | `PUBLIC` | Confirm the text and links describe the approved product and point only to reviewed public surfaces. Do not enable Pages or change visibility as part of MO-1. |

The GitHub surface rows require targeted cleanup when a concrete prohibited item
is identified. They do not require blanket deletion or exhaustive review of
historical discussions, refs, logs, or attachments before independently authored
Typewriter output can ship.

## Material that remains private

| Material | State | Boundary |
| --- | --- | --- |
| Raw API responses, scraped pages, downloaded dictionaries/corpora, restricted source files | `KEEP-PRIVATE` | Keep outside the repository. A source-policy decision and independently curated Typewriter result do not authorize publication of the raw source. |
| Unreviewed LLM/model drafts, candidate bodies, and temporary editorial staging | `KEEP-PRIVATE` | Keep outside canonical data, Git, generated databases, packages, Pages artifacts, and public GitHub attachments. |
| Private editorial/source-review notes that contain unredacted external material | `KEEP-PRIVATE` | Use only for the audit where terms permit; publish a minimal rights/provenance decision only when safe and necessary. |
| Credentials, private keys, local configuration, local absolute paths, developer machine state, and browser user data | `KEEP-PRIVATE` | Never publish or include in repository artifacts. Revoke/rotate credentials if exposure is found. |

The absence of a tracked `data/draft/` or `data/reference/` directory is intentional;
local reference assets live in the shared cache outside every worktree.
`docs/data-policy.md` and `docs/repository-structure.md` require raw sources and
unreviewed drafts to remain outside the repository. Ignore rules alone do not prove
that this boundary has held across Git history or GitHub-hosted surfaces.

## Current release checks

The NIKL result-publication approval and owner release decision for
Typewriter-authored output are met. For each product release:

1. Select and record the exact canonical/source revision and run the deterministic
   build and applicable exact-package validation.
2. Check the package file set, bundled software licenses/notices, NIKL attribution,
   and applicable Chrome Web Store or Pages requirements.
3. Keep raw NIKL corpus files, passages/excerpts, local indexing/analysis
   databases, verbatim third-party material, credentials, and any specifically
   demonstrated infringement out of the target artifact. Remediate a concrete
   violation at the affected item or artifact.

These operational checks apply to the target release. They do not impose an
individual clearance map for every authored word or an exhaustive audit of all
historical GitHub refs, conversations, logs, attachments, or hosted surfaces.
Unknown source ancestry alone is not a release blocker for Typewriter-authored
output. See `DATA-LICENSE.md` for the owner-approved scope and exclusions.

## Pages boundary

GitHub Pages must use a custom Actions workflow and a separate `web/` source tree.
The existing `docs/` stays the development/design/audit authority. The Pages artifact
contains the dictionary entrypoint and the product introduction entrypoint at
`about/index.html`, with the shared runtime/worker, SQLite WASM assets, and a database
generated from the exact canonical revision selected for that release, plus other files explicitly
allowlisted for the site. Required legal files remain in the artifact without needing
visible links on either page. It must not include `manifest.json`, Chrome-only package
files, tests, M5 evidence, raw sources, or unapproved files from the extension root
`public/` directory.

The exact Pages file set, repository base paths, SQLite integrity, legal files, and
Git and canonical revision bindings are checked by
scripts/validate/pages-artifact.mjs. Pull request builds keep the generated site
on the ephemeral runner and never upload or deploy it. Each push to `master`
uploads the artifact only after validation succeeds, then a dependent deployment job
publishes that validated artifact to GitHub Pages. Issue #157 remains historical
MO public-cutover evidence and is not a steady-state deployment prerequisite. This
workflow does not change repository visibility.

## Change control

Update this boundary when the repository gains a new top-level area, data role,
distribution surface, or materially different artifact. Keep concrete identified
rights, privacy, or security violations as blockers until the affected item is
remediated; unknown ancestry alone does not reinstate a blanket release hold.
