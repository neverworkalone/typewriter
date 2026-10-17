# Local reference data

Approved machine-local reference sources and their derived indexes stay outside
Git under `~/.cache/typewriter/reference/`. The current layout is:

```text
~/.cache/typewriter/reference/
├── corpus/          approved written-corpus source files
│   └── indexes/     derived corpus SQLite indexes
├── dict/            source dictionary downloads and inventory files
└── literature/      approved public-domain texts and local indexes
    └── indexes/
```

Raw source files, corpus passages, and local SQLite indexes are not product
inputs and must not be committed or packaged. Canonical JSONL remains the
tracked source for the product dictionary. Before using a source, check its
source-specific terms and permission record in [`docs/data-policy.md`](data-policy.md).

The directory layout records where local reference material is stored; it does
not itself establish permission, provenance, or publication rights. Builders
and reviews must continue to bind source files and generated indexes to their
approved manifests and digests.
