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

This inventory reflects the tracked tree at `f3822cf` (the M5 final-audit merge,
2026-09-24). The current tree has no tracked SQLite database, extension package,
or Pages artifact. Recheck it against the exact release commit before publication.

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
| `src/`, `scripts/`, `schema/`, `tests/`, `config/` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project code and authored validation fixtures; check any file-level third-party content | Application, build, schema, validation, and test source. Fixtures may reproduce project data or historical decisions. | Final source-code license is pending #151. Check fixtures and scripts for copied source text, external outputs, local paths, or credentials in #151/#152. |
| `popup.html`, `options.html`, `pack.py`, `pack.sh`, `package.json`, `package-lock.json`, `vite.config.js`, `vitest.config.js` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project; lockfile identifies third-party packages | Extension entrypoints and build/dependency metadata; SQLite WASM is a pinned runtime dependency. | Apply the final code license; audit shipped dependency licenses and required notices in #151. Do not treat a lockfile as a license audit. |
| `.github/` (currently `.github/workflows/`) | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project automation | CI workflow source; runs may produce logs and artifacts hosted separately by GitHub. | Final code license pending. Audit workflow permissions and all retained Actions logs/artifacts under #152; only approved Pages artifacts may be deployed later. |
| `docs/` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project documentation and editorial/process records | Development, design, data-policy, review, M5 reports, and audit evidence. This remains the documentation authority; it is not the Pages source tree. | Documentation license pending #151. Check third-party excerpts, source/provenance claims, personal details, and local paths in #151/#152. Keep historical evidence in scope regardless of size. |
| `AGENTS.md`, `REVIEW.md` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter project process documentation | Repository instructions and review policy. | Intended to remain useful to contributors. Review for private-only paths, credentials, personal data, and license terms before release; preserve canonical/admission safeguards. |
| `data/canonical/` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter-curated lexical records; any per-record external influence still needs verification | Canonical source of truth for words, senses, expressions, and relations; these records feed generated SQLite. | Data license and redistribution rights are unresolved until #151 completes provenance review. The records do not by themselves establish rights for every externally informed item; unresolved items stay out of any public clone or product. |
| `data/inventory/` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter editorial planning and promotion decisions | Target selection, classification, hold/reject/defer state, and promotion history; not canonical build input. | Review whether candidate identities or editorial planning disclose private material. Confirm data/evidence licensing and source independence in #151/#152. |
| `data/batches/` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter M5 process evidence; includes generated measurements, authored decisions, and historical canonical snapshots | Manifests, digests, review decisions, relation evidence, and frozen historical inputs; some files duplicate canonical records for reproducibility. | Audit both evidence text and embedded snapshots for provenance, redistribution rights, external-source residue, local paths, and sensitive metadata. Do not exempt files as “only evidence” or because they are large. |
| `data/validation/` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter-authored semantic decisions and validation inputs | Durable decisions and source-bound audit inputs; validation projections may be reproducible from these sources. | Confirm authorship, data rights, and privacy in #151/#152. Keep unresolved source or redistribution questions as blockers. |
| `public/manifest.json` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter extension manifest | Product metadata and permissions for the Chrome Extension. | Publish with the final code license; verify metadata, permissions, and URLs during #152/#153. |
| `public/logo.png`, `public/icon*.png`, `public/favicon.ico` | `PUBLIC-WITH-SEPARATE-LICENSE` | Typewriter / Never Work Alone brand assets; exact asset ownership to confirm | Logo, icons, and visual identity used by the extension and future web surface. | Keep brand ownership separate from code/data licensing. #151 must establish the brand policy and intended display/reuse permissions before release. |
| `THIRD-PARTY-NOTICES.txt`, `Apache-2.0.txt` | `PUBLIC-WITH-SEPARATE-LICENSE` | Third-party SQLite WASM notice and Apache-2.0 license text | License and notice for pinned `@sqlite.org/sqlite-wasm` 3.53.0-build1. | Preserve the applicable upstream license and complete notices in every distributed package. Reconcile notices with the actual dependency tree in #151. |
| `README.md` | `PURGE-BEFORE-PUBLIC` | Typewriter project; current text includes owner-authored repository policy | Public project entrypoint, but the current copy says the repository is private and proprietary. | Rewrite for the final license/data/brand model in #153 before publication. Retain neither contradictory private/proprietary claims nor unsupported rights claims. |
| `LICENSE.md` | `PURGE-BEFORE-PUBLIC` | Never Work Alone proprietary license | Current repository-wide proprietary terms conflict with the planned open-source/open-data release direction in #149. | Replace only after #151 resolves license and provenance decisions. Do not expose this current license as if it were the final public license. |
| `.gitignore` | `PUBLIC` | Typewriter project repository configuration | Ignore rules for local and generated files. | Keep the rules; still audit the actual tracked tree and history. Ignore rules are not proof that secrets or generated files were never committed. |
| Transient `dist/`, `artifacts/`, local SQLite files, and unapproved extension archives | `PURGE-BEFORE-PUBLIC` | Generated locally from canonical data and pinned dependencies | Build/package outputs, not editable sources of truth; none are tracked at the boundary revision. | Do not commit or attach scratch outputs. Remove any such item from reachable GitHub refs if found. Their contained data inherits its own licensing obligations. |
| Allowlisted Pages artifact and approved extension release package, including `dictionary.sqlite` | `PUBLIC-WITH-SEPARATE-LICENSE` | Deterministic build from the approved canonical revision and pinned dependencies | Generated distribution surface; SQLite contains the licensed canonical data and the package may contain third-party runtime files. | Publish only after #151 licenses the data and dependencies, #152 clears the surface, and #156 validates an explicit artifact allowlist. Record the canonical revision and preserve required notices. |
| Future `web/` source and `vite.web.config.js` | `PUBLIC-WITH-SEPARATE-LICENSE` | Planned Typewriter web product source; not present at this boundary revision | Separate Pages source and presentation layer over the shared runtime. | Keep it separate from `docs/` and extension `public/`. Apply final code/data/brand terms and the MO-1 artifact boundary when introduced by #155. |

The root-file groupings above cover every tracked root entry at the boundary revision;
the path list was checked with `git ls-tree` and `git ls-files`. No generated SQLite
or package output was tracked at that revision.

## GitHub-hosted publication surfaces

These are not repository paths, but repository visibility can expose them alongside
the Git tree.

| Surface | State | Required action before public visibility |
| --- | --- | --- |
| Issues, issue comments, PR bodies/comments, review submissions/comments, attachments | `PURGE-BEFORE-PUBLIC` | Audit every open and closed item. Remove or redact only specific material that contains private data, credentials, restricted source content, or an unapproved attachment. Preserve safe project discussion. |
| Commit metadata, branches, tags, releases, release assets | `PURGE-BEFORE-PUBLIC` | Audit names, authorship metadata, reachable content, assets, and obsolete refs. Rewrite or delete only refs/items that retain a publication blocker; verify the final public ref set. |
| Actions logs and artifacts | `PURGE-BEFORE-PUBLIC` | Review retained logs/artifacts for secrets, private paths, unlicensed data, and unapproved build output. Remove or expire offending items and audit the final retained set. |
| Repository discovery metadata (description, topics, badges, public links) | `PUBLIC` | Confirm the text and links describe the approved product and point only to reviewed public surfaces. Do not enable Pages or change visibility as part of MO-1. |

The `PURGE-BEFORE-PUBLIC` state on GitHub surfaces requires an audit and targeted
cleanup, not blanket deletion. Safe material may remain available when #152 records
that it has been reviewed.

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

## Open blockers carried to later MO issues

1. **MO-2 (#151):** choose and install the code, data, documentation, and brand
   terms only after auditing actual ownership, provenance, redistribution rights,
   and third-party obligations. The proprietary `LICENSE.md` remains the current
   repository license until #151/#153 replace it.
2. **MO-2 (#151):** establish whether all 5,000 canonical starts, 42 reference-only
   records, 5,301 senses, 487 relations, inventory entries, evidence text, and
   historical snapshots can be redistributed. These are counts from the M5 final
   audit, not a provenance clearance.
3. **MO-2 (#151):** reconcile any external dictionary/API/corpus/LLM use and required
   attribution against the source records, editorial evidence, package contents,
   and history. Unknown or untraceable material is not approved for release.
4. **MO-2 (#151):** confirm ownership and allowed use of every logo/icon/brand asset;
   ensure the SQLite WASM dependency notice is complete for all distributed outputs.
5. **MO-3 (#152):** audit the complete Git history, current tree, commit metadata,
   GitHub discussions/reviews/attachments, refs, releases, and retained Actions
   logs/artifacts. This matrix does not claim those surfaces have been scanned.
6. **MO-3 (#152):** investigate and remediate any personal metadata, local path,
   credential, raw external material, or license-incompatible historical content.

These blockers are intentionally explicit. MO-1 does not decide final licenses,
approve redistribution, rewrite history, publish Pages, or change repository
visibility.

## Pages boundary

GitHub Pages must use a custom Actions workflow and a separate `web/` source tree.
The existing `docs/` stays the development/design/audit authority. A Pages artifact
may contain only the built web entrypoint, shared runtime/worker, SQLite WASM assets,
and a database generated from the MO-approved canonical revision, plus other files
explicitly allowlisted for the site. It must not include `manifest.json`, Chrome-only
package files, tests, M5 evidence, raw sources, or unapproved files from the extension
root `public/` directory.

## Change control

Update this boundary when the repository gains a new top-level area, data role,
distribution surface, or materially different artifact. Later MO work must record
any proposed change against this document and keep unresolved conditions as blockers
until their evidence is complete.
