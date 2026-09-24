# MO-2 license and provenance audit

- Issue: [#151 — Audit licenses and canonical provenance](https://github.com/neverworkalone/typewriter/issues/151)
- Audit date: 2026-09-24
- Audited source revision: `0c8a66cd7a85d1aaed30aaf977b45ceec9f03de8` (master after MO-1 / #150)
- Repository visibility: private; this audit does not change it.

## Owner decision

The owner selected this licensing model:

| Material | Decision | Scope |
| --- | --- | --- |
| Typewriter source code | Apache-2.0 | Original code only; third-party components retain their own licenses. |
| Documentation | CC BY 4.0 | Original `docs/` text; embedded data, third-party content, and marks are excluded. |
| Dictionary data | CC BY 4.0 | Only records with established redistribution rights. No NC, AI-training, competition, or other field-of-use limits. |
| Brand | All Rights Reserved | Typewriter and Never Work Alone names, logos, icons, and visual identity. |

CC BY 4.0 requires attribution and permits commercial reuse. The owner confirmed
that AI-training and competing-use restrictions are not desired. This audit does
not apply a data license to records whose provenance is unresolved.

## Current license files and shipped dependencies

The previous `LICENSE.md` asserted a blanket proprietary license over code,
documentation, and data. It has been replaced by a scope-specific license map.
`Apache-2.0.txt` supplies the full Apache-2.0 terms for Typewriter source code and
the SQLite WASM wrapper notice in extension packages. `DATA-LICENSE.md` limits
CC BY 4.0 to data whose rights have been cleared; `BRAND.md` reserves brand use.

| Package in product | Locked version | License | Distribution note |
| --- | --- | --- | --- |
| `@sqlite.org/sqlite-wasm` | 3.53.0-build1 | Apache-2.0 | Vendored JavaScript and WASM runtime; Apache text included. SQLite core itself is public domain. |
| `vue` | 3.5.42 | MIT | Vue runtime is bundled into extension JavaScript. |
| `@vue/runtime-core`, `@vue/runtime-dom`, `@vue/reactivity`, `@vue/shared` | 3.5.42 | MIT | Runtime modules bundled with Vue; full MIT text included in third-party notices. |

The direct runtime dependencies are declared in `package.json`; exact versions and
license metadata are pinned in `package-lock.json`. Vite, the Vue SFC compiler,
and other development dependencies are build-time tools and are not included as
standalone runtime packages in the extension. `THIRD-PARTY-NOTICES.txt` now names
the shipped Vue runtime and includes the full MIT text. The package validator
checks the runtime package versions and license text against the lockfile and
installed Vue package.

References checked on 2026-09-24:

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.html) and [Apache guidance for applying it](https://www.apache.org/legal/apply-license.html).
- [CC BY 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode), including licensor authority, attribution, and database-right provisions.
- [SQLite copyright notice](https://www.sqlite.org/copyright.html).
- [Vue source license](https://github.com/vuejs/core/blob/main/LICENSE); the bundled notice is taken from locked `vue@3.5.42` in `node_modules/vue/LICENSE`.
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/), effective 2026-01-01, assign output rights between the user and OpenAI to the extent permitted by law while requiring users to have rights in submitted input and evaluate output before sharing.
- [OpenAI Service Terms](https://openai.com/policies/service-terms/), updated 2026-09-21, state that Codex and code-generation output may be subject to third-party licenses. These terms do not identify historical dictionary inputs or clear a record's upstream source.

## Canonical provenance findings

The final M5 audit records 5,042 canonical records: 5,000 search starts and 42
reference-only records. The current canonical files are `data/canonical/pilot.jsonl`
and the twelve M5 batch files in that directory. The M5 reports bind editorial
decisions, generator identities, and artifact digests, but those bindings do not
provide a record-level registry of every external dictionary, API, corpus, or
other source that may have informed each record, nor the source terms applicable
at the time.

The repository's `docs/data-policy.md` already says external source use must be
recorded and that unknown terms leave material pending. Some M5 reports also state
that raw external responses and unreviewed drafts were not committed, and the
later M5 batches identify agent-authored lexical sources. These statements are
useful process evidence; they do not independently prove that every current
definition, relation, or durable evidence item is free of externally informed
material.

The owner could not confirm whether external Korean dictionaries, APIs, corpora,
or licensed datasets materially informed M1–M5 definitions or relations, and
explicitly directed that untraceable records be treated as blockers. Accordingly,
this audit does **not** clear any current canonical record for redistribution and
does not approve restricted or raw third-party content for publication.

### MO-3 actions assigned to #152

1. Produce a record-level disposition for every entry in all current
   `data/canonical/*.jsonl` files, keyed by canonical record ID. For each record,
   identify any material sources, source role, the applicable terms and date, and
   the basis for redistribution. A claim that a row is Typewriter-authored or
   agent-generated is not a substitute for source history when that history is
   unknown.
2. Keep any record without a verifiable source and rights basis out of public
   canonical data. Remove it or independently rewrite and re-admit it using a
   source process with recorded rights. Apply the same disposition to dependent
   evidence, inventory, generated SQLite, extension packages, and future web
   artifacts that reproduce the uncleared content.
3. Rebuild and validate all derived data and evidence after removals or rewrites;
   refresh counts, digests, and license attribution from the resulting cleared
   dataset.
4. Scan reachable Git history and GitHub surfaces for external source material,
   raw responses, and stale distributions under the broader #152 history/surface
   audit. Current-file cleanup alone is insufficient if the material remains in
   a reachable commit or GitHub-hosted artifact.

Until those actions pass, the entire current canonical corpus and every generated
artifact containing it remain held from redistribution. `DATA-LICENSE.md` records
the selected CC BY 4.0 policy but makes no grant over the held corpus.

## Documentation, brand, and public wording

The owner selected CC BY 4.0 for original `docs/` text. The license map excludes
embedded canonical data, third-party material, and brand assets from that grant.
Where such content occurs in a document, #152 must verify its source and remove,
replace, or explicitly mark it before public release.

The owner confirmed that the current logo and icons were directly created and
owned by the Typewriter owner. They remain All Rights Reserved under `BRAND.md`.
This is a brand-use boundary, not a license to redistribute the artwork as a
standalone identity or to imply endorsement.

The public-facing license statement can therefore say: **Typewriter source code
is Apache-2.0; original project documentation is CC BY 4.0; data is CC BY 4.0 only
after item-level rights clearance; Typewriter and Never Work Alone brand assets
are All Rights Reserved.** It must retain the data hold until #152 closes it.

## Gate result

- Code license: finalized as Apache-2.0.
- Documentation license: finalized as CC BY 4.0 for original documentation text.
- Data license: finalized as CC BY 4.0 for records with proven redistribution
  rights; the current corpus has no cleared allowlist and remains held for #152.
- Brand policy: finalized as All Rights Reserved; owner confirmed direct creation
  and ownership of current logo and icons.
- Third-party runtime notices: SQLite Apache-2.0 and Vue/Vue runtime MIT covered.
- Restricted or raw third-party material: none approved for publication.
- Provenance blockers: assigned to #152 with corpus-wide record-level disposition,
  remove/rewrite, rebuild, and reachable-history actions.
- Public visibility: unchanged; public cutover remains gated by #157 in the #149
  execution plan.
