# Typewriter — Chrome Extension Review Guide

Use this guide when a PR changes Typewriter's Chrome extension runtime,
popup/Settings implementation, keyboard interaction, storage, packaged
database/WASM loading, permissions, Manifest V3, or CSP behavior.

## Review goal

Review the actual supported Typewriter Chrome product.

Do not import architectural assumptions from unrelated extensions or require
browser complexity that Typewriter does not currently have.

## Runtime behavior

Check as applicable:

- packaged dictionary lookup remains local unless the issue explicitly changes
  that architecture;
- packaged SQLite/WASM paths and loading behavior remain valid;
- Manifest V3 and CSP assumptions remain valid;
- search and keyboard interaction continue to work;
- user settings and user history remain separate from the read-only dictionary
  data;
- permissions remain proportionate to current functionality;
- startup or lookup performance is not materially regressed by changes that
  affect those paths;
- install/update behavior remains valid when relevant to the issue.

Use automated validation when these properties can be reliably scripted.

## UI and usability

Visual design, copy, spacing, interaction feel, and general usability are
primarily validated by direct user evaluation.

Do not build elaborate automated UI infrastructure merely to replace user
inspection when automation provides little additional confidence.

When the user reports a UI or interaction defect:

1. verify that the implementation addresses the reported behavior;
2. evaluate whether the fix introduces a broader implementation problem;
3. if the defect has a stable scriptable behavior worth protecting, add or
   update automated regression coverage;
4. otherwise rely on user validation for the visual/usability result.

Examples of behavior that may justify automation include:

- persisted settings surviving reload;
- keyboard actions producing defined state transitions;
- a stable search result or selection behavior;
- a previously reported functional interaction regression.

Examples that normally do not require automation include:

- preferred spacing;
- visual balance;
- font or color judgment;
- copy tone;
- whether a layout feels easier to use.

## CI

When relevant extension tests pass on the exact reviewed head, do not manually
repeat those same deterministic checks.

Human review should concentrate on architecture, unintended behavior, and
areas not meaningfully covered by automation.
