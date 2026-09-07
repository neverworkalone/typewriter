# Typewriter — Data Source and Licensing Review Guide

Use this guide only when a PR changes external data sources, data provenance,
import-source policy, licensing, attribution, or handling of third-party
material.

Ordinary canonical editorial changes that do not introduce or alter external
source handling do not require this guide.

## Review goal

Typewriter's canonical data must remain defensible as Typewriter data and must
not become a disguised copy or unauthorized redistribution of restricted
third-party material.

Consult [`data-policy.md`](data-policy.md) and
[`repository-structure.md`](repository-structure.md) when the change affects
their defined boundaries.

Do not duplicate those policies here.

## External sources

Check as applicable:

- whether the source permits the intended access and use;
- whether storage or redistribution is permitted;
- whether attribution or notice is required;
- whether the PR stores raw API responses, scraped pages, restricted
  definitions, examples, rankings, or relationship lists;
- whether an import path can accidentally move prohibited source material into
  canonical data;
- whether transformation, translation, combination, or paraphrasing is being
  incorrectly treated as removing the original source restrictions;
- whether provenance needed by repository policy remains traceable.

## Canonical data

External APIs, dictionaries, corpora, and LLMs may serve as reference,
verification, or draft-generation inputs when permitted.

The final canonical relation, classification, ranking, and curation must remain
consistent with Typewriter's own editorial process and applicable source terms.

## Automated safeguards

When a licensing or source-policy rule can be mechanically enforced, prefer a
validator or CI safeguard.

Examples may include:

- rejecting prohibited raw-data directories;
- blocking known generated/API dump file patterns;
- requiring source-policy metadata for approved import pipelines;
- detecting accidentally committed large external artifacts.

Passing automated safeguards does not replace review of the actual legal or
policy premise when a new source or license is introduced.

## Blockers

Treat a current path that can introduce prohibited, incompatible, or
untraceable third-party material into canonical or distributed Typewriter
assets as a blocker.

Do not create speculative licensing requirements for sources that the PR does
not use.
