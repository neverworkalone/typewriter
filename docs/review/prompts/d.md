# D Candidate PR — written-corpus method

Read `candidate.md` first; `REVIEW.md` is the shared authority.

- Route only a Candidate-only `[D/<model>] <SSS>_<BB>` PR with an actual `..._d_<model>.jsonl` file. The D producer's execution contract is #1156; **production** has PASS A/B/C, but PR review is **not** three new independent semantic audit stages.
- D uses authorized read-only written-corpus contexts. PASS A ties observed usage to exact lemma/POS/Sense with truthful `VERIFIED`, ambiguous/rejected/no-result/error statuses. PASS B explores five directions in one integrated pass, with selective further search only when justified. PASS C checks every produced string before submission. A real demonstrated wrong Sense, fabricated VERIFIED attribution, missing mandatory production step or forbidden Candidate form is blocking.
- Private source contexts, raw excerpts, DB and cursor/locator logs are not shipped in the PR. Do not substitute PR-body claims for independent proof; also do not treat unavailable private corpus evidence as an automatic `-1` or demand per-candidate receipts, extra corpus scans or a fixed two-pass census.
- Apply `candidate.md`'s one-pass machine checks and risk-first output eligibility. Do not reject legitimate scene/image words because they are familiar. Distinguish Supervisor technical skips from ordinary empty Senses; never demand that unaffected Senses be deleted for a bounded failure.
