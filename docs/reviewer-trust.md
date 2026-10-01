# Reviewer trust for semantic review inputs

Semantic review inputs (`data/batches/*-semantic-review-input.json`) name a
`reviewer`. A name written by the producer proves nothing, so Typewriter decides
which reviewer identities are trusted outside the change that uses them.

## Trust root

- `config/semantic-reviewers.json` lists the trusted identities. It is evaluated
  **as it exists on the protected base branch (`master`)**, never from the pull
  request being checked.
- A change may add registry entries, but an entry becomes usable only after the
  change that adds it has been merged. A review input added or modified in the
  same change as its reviewer's registry entry is rejected.
- Base entries are immutable: a change may not remove or rewrite a trusted
  reviewer.
- A reviewer must differ from the candidate-review author recorded in the same
  batch's candidate review (case-insensitive).
- The gate rejects a review input whose reviewer the base registry does not
  list, even when the head registry does.

## Enforcement that the pull request cannot edit

`.github/workflows/reviewer-trust-gate.yml` triggers on `pull_request_target`.
GitHub runs that workflow definition from the base branch, and the job runs
`scripts/ci/reviewer-trust-gate.mjs` from the base checkout; the pull request head
is checked out only as data and nothing from it is executed. The job has
read-only permissions and no secrets. A pull request therefore cannot change the
validation code, the workflow, or the registry that judges it.

Only unchanged review inputs are skipped; their reviewer was checked when the
input was introduced.

## What the repository owner must configure

The gate is only binding if GitHub enforces it. The owner should:

1. Mark the **Reviewer trust gate** check as required in branch protection for
   `master`.
2. Require code-owner review. `.github/CODEOWNERS` assigns the registry, the gate,
   its workflow, and this document to the owner.

Until both are set, the gate reports failures but does not block a merge.

## What this gate does NOT prove

The gate separates the *trust root* from the producer; it does not authenticate
authorship. Both the review input's `reviewer` and the candidate review's
`reviewer` are labels read from the pull request head. A producer can write an
already-trusted identifier and a different candidate-author string, and the gate
accepts that shape (`tests/reviewer-trust.test.mjs`, "gate boundary" test).
Passing this gate must therefore **not** be described as independent review.

Authenticating who produced a review needs evidence the producer cannot mint,
for example a review executed by a workflow or GitHub App that the producer
cannot edit and that attests its output (artifact attestation bound to that
workflow identity), or a human review recorded under a separate GitHub account.
That mechanism is an owner decision and is not provided here. Until it exists, a
batch that depends on this gate should not be claimed as independently reviewed.

## Limits

- A registered reviewer name shows who is *trusted*, not that a given review was
  independent. Independent evidence additionally needs the reviewer's own run
  record and original judgments preserved and verified apart from the
  producer's output; that belongs to the batch that consumes the review.
- Trusted reviewers in the registry may share a model family with the producer.
  The registry and the self-review rule make that boundary explicit; they do not
  claim an external organization.
