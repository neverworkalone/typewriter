# A Candidate PR — direct Sense exploration

Read `candidate.md` first; `REVIEW.md` is the shared authority.

- Route only a Candidate-only `[A/<model>] <SSS>_<BB>` PR with actual `..._a_<model>.jsonl` changed file. Otherwise return to the common routing rule.
- A produces independent words and short meaning-extending expressions directly from each exact Canonical Sense/gloss, including plausible indirect directions. The producer first explores sufficiently; a second exploration is **optional only** if a valuable unvisited direction exists (#860). The reviewer evaluates **submitted output eligibility and Sense binding**, not private brainstorming rounds, candidate-count quotas, or an undocumented discovery ledger.
- Pay attention to mechanically compressed glosses, source-lemma/derivation repetition, incorrect homograph or POS binding, disguised clauses and obviously extraneous associations. Keep ordinary but meaningful alternative vocabulary and compact imagery; debatable admission/Tier remains Relation Factory Stage 2.
- Use `candidate.md`'s one-pass mechanical/form checks and narrowly scoped re-review. Verify jamo-only source Senses stay present but empty and jamo-only Candidate strings do not survive. Do not search a corpus or fabricate extra exploration evidence.
- **Proper nouns (#5745):** a source Sense whose gloss names a specific person, place, institution, organization or work must have `candidates: []`, and no candidate may mean such a proper noun (e.g. 김성수, 동아일보, a work title), even if factually related. Judge by exact Sense/gloss (인촌¹ empty vs 인촌² normal), not spelling; class nouns such as 사람·도시·소설·작가 stay valid. A surviving proper-noun candidate is a form-gate defect within the normal review scope.
