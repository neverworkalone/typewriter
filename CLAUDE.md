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

## Subagent Usage

- Prefer direct execution over spawning subagents.
- Do not spawn subagents merely because a task
  mentions independent review.
- Delegate only when separate execution provides
  a clear benefit or is explicitly required.
- Avoid duplicate context loading and repository exploration.
- Optimize total token usage, not just elapsed time.
- Never weaken validation to reduce token consumption.

## Communication

- Prioritize execution over discussion.
- Avoid unnecessary confirmation requests.
- Document important decisions in the PR.
