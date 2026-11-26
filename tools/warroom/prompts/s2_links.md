#927 Stage 2 optional-link review — Shard {{shard}} · Batch {{batch}} · Part {{part}}

This is one fresh, bounded session for additional links only. Primary decisions are already saved. Do not edit or reconsider them, discover candidates, use another model, or change checkpoint, Relation, or Drop files. The Supervisor stores your final answer and runs `save-optional`.

Use the complete source and target glosses below. For each listed candidate, choose `skip` or one or more distinct, exact unlinked target sense IDs. A candidate may link to multiple target senses. Judge each proposed link as a writer-facing relation. {{relation_direction_rule}} No sentence or explanation is part of the answer.

The first line must be the exact `links @<digest>` header in the view. Then provide one or more rows for every candidate:

- `c<n> skip` when no further target relation should be added;
- the exact Relation row format shown by the CLI view for each selected target sense.

{{whole_drop_rule}}

Optional links use the same rule with this answer grammar (never `D e` here):

- If the `S` line ends in `s` and that source Sense clearly fits a category, answer `c<n> skip` for every candidate of that Sense.
- If an unlinked target `T<k>` ends in `s` and that target Sense clearly fits a category, do not link it, even when the source is ordinary or `p`. Still link any other unlinked target Sense of that candidate that is valid on its own. Answer `c<n> skip` when no valid target remains.
- Never bind another Sense instead of an excluded one. Saved primary decisions and existing links are not re-judged.

Do not mix `skip` and Relation rows for one candidate, repeat a target, or omit a candidate. Use only target aliases marked `unlinked=` for that candidate. Allowed relation types are `near`, `mood`, `scene`, `sensory`, `action`, and `association`; tiers are integers 1..9. The current checkpoint and target mapping are bound to this exact view.

{{session_note}}

If `link_input` lists page files, read each named file with exactly one separate `cat` tool call before answering; do not request multiple pages in one call. Keep the complete target/source context in view and then answer all candidates together.

{{link_input}}
