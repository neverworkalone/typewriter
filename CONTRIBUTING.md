# Contributing to Typewriter

Thanks for helping improve Typewriter. Contributions should make the dictionary
more useful to writers while preserving clear editorial and licensing boundaries.

## Before opening a pull request

- For code, build, or documentation changes, open a focused pull request and
  describe the user-facing reason for the change.
- For a spelling, sense, relation, or provenance concern, use the
  [dictionary data correction form](https://github.com/neverworkalone/typewriter/issues/new?template=dictionary-data-correction.yml).
  Please do not send a bulk data import or edit canonical records directly.
- The current canonical corpus and derived distributions remain held from
  redistribution pending record-level rights clearance. A report does not grant
  rights to the reported material or authorize a data change.
- Do not include copied definitions, examples, rankings, relation lists, scraped
  pages, API responses, private drafts, generated database files, extension
  archives, credentials, or local machine paths.
- Do not add a dependency, asset, or dataset unless its source and applicable
  terms are clear and documented.

## Code and documentation changes

1. Read the relevant guidance in the README and docs before changing a shared
   validator, admission rule, data boundary, or build contract.
2. Keep changes focused and use the existing shared producer, validator, and
   review path where applicable. Repository-specific implementation and review
   guidance is in [AGENTS.md](AGENTS.md) and [REVIEW.md](REVIEW.md).
3. Include the validation commands and results in the pull request description.
   For code changes, install dependencies and run normal CI and the test suite:

       npm ci --ignore-scripts --no-audit --no-fund
       npm run ci:normal
       npm test

   For documentation-only changes, check changed links and run git diff --check.
4. Run focused build or package validation for changes that affect those
   outputs. Do not publish or share data-bearing artifacts while the canonical
   data hold remains.
5. Do not weaken a common data-quality or source-binding rule to make a single
   batch pass. Use small synthetic fixtures for general invariants.

## Licensing

You may submit a change only if you have the right to contribute it. Original
software/configuration and original documentation follow the file-specific
grants described in [LICENSE.md](LICENSE.md). Data is covered by
[DATA-LICENSE.md](DATA-LICENSE.md) only when its redistribution rights are
established. Brand assets are governed by [BRAND.md](BRAND.md). If a contribution
needs different terms, discuss that before submitting it.

## Reporting a dictionary correction

Use the data correction issue form for typos, sense or part-of-speech concerns,
relation issues, attribution questions, and other lexical feedback. Include the
affected search term or record identifier when known, explain the concern in
your own words, and link to relevant public references. Do not paste restricted
source text or unpublished writing.

A report is a request for editorial review. It does not mean that the suggestion
will be accepted or that the affected data is cleared for redistribution.
