# Search Review

Use for normalization, candidates, ranking, ordering, homonyms, senses, search
state, and search regressions.

Consult only when relevant:

- `search-regressions.md`
- `search-candidates.md`
- `domain-model.md`

Check:

- normalization preserves query meaning;
- required candidates remain reachable;
- candidate tiers and ranking follow the current contract;
- tie behavior is deterministic where required;
- relation or sense distinctions are not incorrectly collapsed;
- homonyms resolve according to current product behavior;
- search-state changes preserve intended navigation/history behavior;
- the fix addresses the underlying rule, not only one fixture;
- relevant regression coverage protects the reported defect.

Do not manually replay regression cases already passed by CI.

Do not require broader NLP/search architecture without a demonstrated current
need.
