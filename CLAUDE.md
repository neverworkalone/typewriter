# Claude Instructions

## Repository Rules

- For implementation, read and follow AGENTS.md.
- For PR reviews, read REVIEW.md from the latest PR HEAD.
- Do not read AGENTS.md during PR reviews.

## Autonomous Execution

- Make technical and architectural decisions independently.
- Do not ask questions when existing requirements and
  repository conventions provide sufficient guidance.
- Choose and implement a reasonable solution rather than
  presenting multiple options.
- Ask the owner only when product requirements, security
  trust boundaries, credentials, or external permissions
  require an explicit decision.
- If blocked, report the cause and a concrete recommendation.
- Never weaken validation to complete a task.
- Execute file edits, verification, commits, and pushes as
separate tool operations, not as one compound shell command.

## Root-Cause Fixes

**Fix the cause, not the symptom.** For implementation defects and PR feedback:

- Identify the underlying cause and violated invariant before editing.
- Check other relevant paths in the affected module for the same cause. Fix the
  shared function, contract, or boundary instead of only the reported example.
- Add a shared regression for that defect class, including appropriate valid
  and invalid inputs, so future cases are covered.
- Before pushing, confirm the same cause is addressed across those paths.
- Keep the fix focused: no unrelated refactors, extra validation layers, or
  new issues. Preserve existing required checks.

## Cross-agent invocation — all implementation work

The prohibition on lexical subagents also applies to invoking **other AI agents
or model CLIs**. In particular, Codex must not shell out to Claude CLI (or
another LLM) for the B01–B04 retrospective audit or any other semantic review.
Do not query agent authentication, account, subscription, email or usage status
as a side effect of lexical production. Use the primary assigned agent's own
source-bound semantic QA and deterministic validation. Existing reviewer labels
are historical evidence, not instructions to start the named model.

## Subagent Usage — Owner Decision (2026-10-02)

- **Do not spawn subagents** for Typewriter implementation, lexical candidate
  authoring, semantic QA, batch production or M10 throughput work. The owner
  has withdrawn the previous optional-delegation permission because of token
  cost. Only a *new explicit owner authorization* may make an exception.
- Execute tasks directly in the main Claude context. Do not call self-checking
  "independent review" or create fictional reviewer identities/runs.
- For new M10 batches, implement honest AI-authored semantic QA provenance in
  the shared producer, validators, and regressions before changing acceptance.
  Do not retroactively modify M9 B05–B09 review history.
- Retain source-bound semantic checks, fail-closed decisions, CI and canonical
  invariants. Optimize total measured token usage, not just wall-clock speed.
- The independent Stage 1/2 **PR review** process is separate and governed
  exclusively by `REVIEW.md`; this instruction addresses *implementation*
  subagents, not separately commissioned reviewers.

## Communication

- Prioritize execution over discussion.
- Avoid unnecessary confirmation requests.
- Document important decisions in the PR.
