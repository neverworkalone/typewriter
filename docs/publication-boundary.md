# Public Repository and Data Boundary

## Purpose and status

This document defines which repository paths and GitHub-hosted surfaces are intended
to be public, which require separate licensing, and which must stay private or be
removed before publication. It is the MO-1 boundary for the later license/provenance
audit (#151), public-surface and history audit (#152), and release preparation.

The classifications below are publication decisions, not a grant of rights or a
release approval. `PUBLIC-WITH-SEPARATE-LICENSE` means the material is an intended
public surface only after its applicable license, provenance, and notices are
confirmed. Unknown rights, provenance, privacy, or security conditions remain
blockers. The repository must stay private until the MO-8 release gate explicitly
approves a specific release commit.

The path inventory was first checked against the tracked tree at f3822cf (the M5
final-audit merge, 2026-09-24). MO-2 / #151 finalized the license model. GitHub
issue #152 is closed, but the current tree has no record-level clearance allowlist
for the canonical corpus; data-bearing paths remain held from redistribution.
The current tree also does not contain or link a verifiable disposition of the
exact Git refs and GitHub-hosted surfaces required by #152. Issue closure does not
grant rights or approve release. The current tree has no tracked SQLite database,
extension package, or Pages artifact. Recheck the inventory and all release
conditions against the exact release commit.

## Classification states

- `PUBLIC` — may be visible without a separate project-specific license decision;
  review any personal or security-sensitive metadata before release.
- `PUBLIC-WITH-SEPARATE-LICENSE` — intended to be public, with a distinct license,
  attribution, notice, or brand rule that must be finalized first.
- `PURGE-BEFORE-PUBLIC` — the current item or unapproved artifact must be rewritten,
  removed, or cleared before publication. This does not mean deleting an entire
  category when only individual violating items need remediation.
- `KEEP-PRIVATE` — do not commit, distribute, or expose this material.

## Repository path matrix

| Path / role | State | Owner and origin | Source role and external material | Privacy, rights, and required action |
| --- | --- | --- | --- | --- |
| src/, scripts/, schema/, tests/, config/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project code and authored validation fixtures; check any file-level third-party content | Application, build, schema, validation, and test source. Fixtures may reproduce project data or historical decisions. | Original Typewriter software/configuration is Apache-2.0 under #151. Fixture material that reproduces uncleared data remains held under the data boundary. Verify source text, paths, and credentials against the exact release commit. |
| `popup.html`, `options.html`, `pack.py`, `pack.sh`, `package.json`, `package-lock.json`, `vite.config.js`, `vitest.config.js` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project; lockfile identifies third-party packages | Extension entrypoints and build/dependency metadata; SQLite WASM is a pinned runtime dependency. | Original software/configuration is Apache-2.0. Third-party packages retain their own licenses; shipped dependency terms are recorded in `THIRD-PARTY-NOTICES.txt`. |
| .github/workflows/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project automation | CI workflow source; runs may produce logs and artifacts hosted separately by GitHub. | Original workflow source is Apache-2.0 under LICENSE.md. Verify workflow permissions, retained Actions logs/artifacts, and release refs before publication. |
| docs/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project documentation and editorial/process records | Development, design, data-policy, review, M5 reports, and audit evidence. This remains the documentation authority; it is not the Pages source tree. | Original documentation text is CC BY 4.0. Embedded canonical data, third-party material, and marks are excluded. Verify provenance claims, excerpts, personal details, and local paths against the exact release commit. |
| AGENTS.md, REVIEW.md | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project process documentation | Repository instructions and review policy. | Original process documentation is CC BY 4.0. Check paths, credentials, and personal data at the release boundary; preserve canonical/admission safeguards. |
| data/canonical/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter-curated lexical records; any per-record external influence still needs verification | Canonical source of truth for words, senses, expressions, and relations; these records feed generated SQLite. | Selected license is CC BY 4.0 only for individually cleared records. The entire current corpus remains held until each included record has an evidence-backed rights disposition; exclude or independently rewrite records without a verifiable basis. |
| data/inventory/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter editorial planning and promotion decisions | Target selection, classification, hold/reject/defer state, and promotion history; not canonical build input. | CC BY 4.0 applies only to cleared items. Hold any item reproducing uncleared lexical content and review private planning data and metadata at the release boundary. |
| data/batches/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter M5 process evidence; includes generated measurements, authored decisions, and historical canonical snapshots | Manifests, digests, review decisions, relation evidence, and frozen historical inputs; some files duplicate canonical records for reproducibility. | CC BY 4.0 applies only to cleared evidence. Historical snapshots and embedded lexical content remain held until individually cleared, removed, or independently rewritten. |
| data/validation/ | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter-authored semantic decisions and validation inputs | Durable decisions and source-bound audit inputs; validation projections may be reproducible from these sources. | CC BY 4.0 applies only to cleared items. Untraceable or data-bearing validation inputs remain held until their content has an evidence-backed rights disposition. |
| public/manifest.json | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter extension manifest | Product metadata and permissions for the Chrome Extension. | Original manifest/configuration is Apache-2.0. Verify metadata, permissions, and URLs against the exact release commit. |
| `public/logo.png`, `public/icon*.png`, `public/favicon.ico` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter / Never Work Alone brand assets | Logo, icons, and visual identity used by the extension and future web surface. | The owner confirmed direct creation and ownership. All Rights Reserved under `BRAND.md`; no artwork or mark reuse grant is made. |
| `THIRD-PARTY-NOTICES.txt`, `Apache-2.0.txt` | `PUBLIC-WITH-SEPARATE-LICENSE` | Third-party SQLite WASM and Vue runtime notices; Apache-2.0 license text | Notices cover `@sqlite.org/sqlite-wasm` 3.53.0-build1 and bundled Vue 3.5.42 runtime modules. | Preserve the upstream terms and complete notices in each package. #151's package validator compares shipped legal files with repository sources. |
| README.md | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project entrypoint and owner-authored project documentation | Public visitor guide covering product status, architecture, onboarding, and reuse boundaries. | Original README prose is CC BY 4.0. Embedded data, third-party material, and marks are excluded. The current README states that data and product releases remain held. |
| `LICENSE.md`, `DATA-LICENSE.md`, `BRAND.md` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter license and policy notices | Defines code, data, documentation, and brand boundaries. | Their original explanatory text is CC BY 4.0; the grants and exclusions in each file govern the corresponding material. Embedded third-party license texts and brand assets are excluded. |
| .gitignore | PUBLIC-WITH-SEPARATE-LICENSE | Typewriter project repository configuration | Ignore rules for local and generated files. | Original repository configuration is Apache-2.0. Ignore rules do not establish that secrets or generated files are absent from reachable history; verify that at the release gate. |
| Transient dist/, artifacts/, local SQLite files, and unapproved extension archives | PURGE-BEFORE-PUBLIC | Generated locally from canonical data and pinned dependencies | Build/package outputs, not editable sources of truth; none are tracked at the boundary revision. | Do not commit or attach scratch outputs. Any output containing the current uncleared corpus remains held; resolve all reachable-ref and hosted-surface blockers before release. |
| Allowlisted Pages artifact and approved extension release package, including dictionary.sqlite | PUBLIC-WITH-SEPARATE-LICENSE | Deterministic build from the approved canonical revision and pinned dependencies | Generated distribution surface; SQLite contains canonical data and the package contains third-party runtime files. | Publish only after every included record has rights clearance, the exact history and hosted surfaces pass audit, and the applicable artifact allowlist gate approves the output. Packages carry LICENSE.md, DATA-LICENSE.md, BRAND.md, and third-party notices. Record the canonical revision. |
| Future `web/` source and `vite.web.config.js` | `PUBLIC-WITH-SEPARATE-LICENSE` | Planned Typewriter web product source; not present at this boundary revision | Separate Pages source and presentation layer over the shared runtime. | Original web software/configuration is Apache-2.0; data requires item-level CC BY 4.0 clearance; brand remains All Rights Reserved. Keep it separate from `docs/` and extension `public/`. |

The original root-file groupings were checked against the tracked tree at the
boundary revision with git ls-tree and git ls-files. Recheck the complete path
inventory against the exact release commit. No generated SQLite or package output
was tracked at the boundary revision.

## GitHub-hosted publication surfaces

These are not repository paths, but repository visibility can expose them alongside
the Git tree.

| Surface | State | Required action before public visibility |
| --- | --- | --- |
| Issues, issue comments, PR bodies/comments, review submissions/comments, attachments | `PURGE-BEFORE-PUBLIC` | These surfaces are outside the repository license grants. Audit every open and closed item; remove or redact specific private data, credentials, restricted source content, or unapproved attachments. Preserve safe project discussion. |
| Commit metadata, branches, tags, releases, release assets | `PURGE-BEFORE-PUBLIC` | Audit names, authorship metadata, reachable content, assets, and obsolete refs. Rewrite or delete only refs/items that retain a publication blocker; verify the final public ref set. |
| Actions logs and artifacts | `PURGE-BEFORE-PUBLIC` | Review retained logs/artifacts for secrets, private paths, unlicensed data, and unapproved build output. Remove or expire offending items and audit the final retained set. |
| Repository discovery metadata (description, topics, badges, public links) | `PUBLIC` | Confirm the text and links describe the approved product and point only to reviewed public surfaces. Do not enable Pages or change visibility as part of MO-1. |

The `PURGE-BEFORE-PUBLIC` state on GitHub surfaces requires an audit and targeted
cleanup, not blanket deletion. Safe material may remain available only after
the review is documented for the exact release surfaces and the release gate approves
publication. Issue closure alone is not evidence of that approval.

## Material that remains private

| Material | State | Boundary |
| --- | --- | --- |
| Raw API responses, scraped pages, downloaded dictionaries/corpora, restricted source files | `KEEP-PRIVATE` | Keep outside the repository. A source-policy decision and independently curated Typewriter result do not authorize publication of the raw source. |
| Unreviewed LLM/model drafts, candidate bodies, and temporary editorial staging | `KEEP-PRIVATE` | Keep outside canonical data, Git, generated databases, packages, Pages artifacts, and public GitHub attachments. |
| Private editorial/source-review notes that contain unredacted external material | `KEEP-PRIVATE` | Use only for the audit where terms permit; publish a minimal rights/provenance decision only when safe and necessary. |
| Credentials, private keys, local configuration, local absolute paths, developer machine state, and browser user data | `KEEP-PRIVATE` | Never publish or include in repository artifacts. Revoke/rotate credentials if exposure is found. |

The absence of a tracked `data/draft/` or `data/reference/` directory is intentional.
`docs/data-policy.md` and `docs/repository-structure.md` require raw sources and
unreviewed drafts to remain outside the repository. Ignore rules alone do not prove
that this boundary has held across Git history or GitHub-hosted surfaces.

## Release conditions still active

MO-3 issue #152 is closed. Its closure does not provide item-level rights evidence,
does not provide a verifiable audit disposition for the exact refs and hosted
surfaces, and does not approve repository visibility. The following release
conditions remain active:

1. Establish whether every canonical record, inventory item, evidence file, and
   historical snapshot may be redistributed. The M5 counts are not a provenance
   clearance; the current corpus remains held.
2. Reconcile external dictionary/API/corpus/model use and required attribution
   against source records, editorial evidence, package contents, and history.
   Unknown or untraceable material is not approved for release.
3. Verify the exact release tree, reachable Git history, commit metadata, GitHub
   discussions/reviews/attachments, refs, releases, and retained Actions logs and
   artifacts. Commit or link verifiable audit evidence tied to the release commit,
   with a disposition for every audited surface.
4. Investigate and remediate any personal metadata, local path, credential, raw
   external material, or license-incompatible historical content.

These blockers are intentionally explicit. MO-1 does not decide final licenses,
approve redistribution, rewrite history, publish Pages, or change repository
visibility.

## Pages boundary

GitHub Pages must use a custom Actions workflow and a separate `web/` source tree.
The existing `docs/` stays the development/design/audit authority. The Pages artifact
contains the dictionary entrypoint and the product introduction entrypoint at
`about/index.html`, with the shared runtime/worker, SQLite WASM assets, and a database
generated from the MO-approved canonical revision, plus other files explicitly
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
distribution surface, or materially different artifact. Later MO work must record
any proposed change against this document and keep unresolved conditions as blockers
until their evidence is complete.
