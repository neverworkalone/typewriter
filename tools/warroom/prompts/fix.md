PR #{{pr}} (branch `{{branch}}`, current head {{head}}) has new review feedback.

Only an effective blocking `-1` review event calls for a producer response. **Never respond to `+1` or `+2` PASS reviews:** no PR or inline comments, acknowledgments, status messages, commits, or requests for another review. If only PASS events are presented, exit silently without touching files. For a `-1`, make accepted corrections or leave a concise evidence-based disagreement for the reviewer to assess on re-review. Do not leave review findings unresolved merely because a broader review request cannot be completed; correct the specific findings or rebut the unsupported scope with evidence.

{{session_note}} Keep the assigned worktree, branch, and current HEAD; never merge, rebase, reset, or switch branches. Do not create another PR, request review, or merge.

**You submit the judgment only.** The Supervisor applies it with the official CLI: it runs `amend`, commits only the files that amend changed, verifies the exact commit, pushes, and posts your reply. Do not run `amend` or `verify`, do not commit or push, and do not post PR comments yourself.

Run commands from the worktree root. Use `.warroom-scratch/...` as paths; do not `cd .warroom-scratch`. Write `.warroom-scratch/s2-fix-response.json` using any available, permitted file-writing method (a file tool or the shell); do not require a tool named Write. If writing is actually denied, report that instead of working around it.

If a reproducible shared-layer defect blocks this work, including an official CLI failure on valid input, follow `tools/warroom/prompts/shared-defect.md`: write the actual case, command and return value, and suspected layer to `.warroom-scratch/shared-defect.json`, then stop. Root-cause analysis is not required for this report. Do not treat an unresolved blocker as a completed fix.

## Source-bound review work

- **Shared judgment policy for this checkpoint:**

{{s2_policy_card}}

- Assess each review event against the current PR HEAD, the policy card above, and the supplied `source_context`. The context contains exact candidate pairs from events where that Sense has no prose mention, plus full-Sense detail for every Part source Sense mentioned outside a tuple span or named by an unmatched tuple. Its Q rows are comparison context, not extra review targets.
- Use the supplied context first. If a concrete finding still lacks necessary source or target information, use one narrow read-only `inspect` for only the required Sense or candidate. Do not reread docs or scripts, and do not inspect each candidate separately.
- Read every page of one inspect scope together. If a row is split into `F` records, decode each JSON string and join the parts with the same row-id in part order to recover the complete row. Keep the digest and aliases from that same scope and snapshot.
- Make semantic judgments yourself. Put all accepted candidate changes together in one amend input. It starts with `amend <sorted source sense IDs> @<inspect digest>`, followed only by sparse `c<n> R ...` or `c<n> D <reason>` rows from the matching inspect view. Use the exact target row form shown by the checkpoint policy. Do not split the findings into several inputs.
- Obtain the amend header's digest and every `c<n>`/`T<n>` alias from **one inspect view that includes all Senses being amended**. If another Sense is needed, inspect the union of the original and added Senses again; never mix aliases or a digest from separate per-Sense views.
- Never edit the checkpoint, Relation JSONL, or Drop JSONL directly. Do not dump the full checkpoint with `rg` or `cat`, and do not dump large docs or scripts.
- When all review events are judged, write `.warroom-scratch/s2-fix-response.json` as one JSON object with exactly these keys, then stop:

  `{"event_keys": [<every review event key below>], "amend": <the complete amend input text, or null when nothing changes>, "reply": <one concise reply>}`

  The reply states what changed and gives the evidence for every finding you keep or disagree with, and includes each review event key as `[<key>]`. A disagreement without file changes uses `"amend": null`. The Supervisor checks the official amend result, the exact commit, Part verification and concurrent shard claims before returning the PR to review; if it cannot apply your submission it returns the reason to this session.

## Review events

{{review_events}}

## Bounded source context

{{source_context}}
