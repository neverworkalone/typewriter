# Claude Instructions

- Read and follow `AGENTS.md` for implementation and assigned review fixes.
- Do not perform PR reviews.
- When the task and repository policy provide sufficient guidance, proceed
  without unnecessary confirmation.
- Do not spawn subagents or invoke other AI agents/model CLIs unless the owner
  explicitly requests their use. Perform the work in the main Claude context.
- If a received review event is truncated or incomplete, use `gh api` to fetch
  and read the complete review/comment and any referenced inline feedback
  before acting. Do not infer omitted findings from the preview. Use pagination
  or bounded reads as needed so no remaining text is missed.
