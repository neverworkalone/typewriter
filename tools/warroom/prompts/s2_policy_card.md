## Shared Stage 2 decision policy

- Do not discover candidates. Decide Relation or Drop for each listed candidate from its exact source Sense and full gloss.
- Drop only a candidate that is plainly unrelated to the source meaning. Preserve intelligible indirect associations and lower their Tier when they are weak.
- Choose the actual relation type first; do not use `association` as a default or fold `scene`/`sensory` into it or `mood` into `near`.
  - `near`: lexical neighbor or nuance close to the source meaning; `mood`: emotion, atmosphere, or tone the source evokes.
  - `scene`: a naturally unfolding situation, place, or scene; `sensory`: a sensory perception, sound, smell, or experience; `action`: a resulting act or motion.
  - `association`: a broader concept, object, or topic when no more specific relation fits. Do not force `scene` because an object evokes a scene. Do not use `direct` or `antonym`.
- Set Tier (`relevance: 1..9`) relative to `P` (approved peers), `Q` (saved candidates), and other decisions for the same source Sense and UI group: `near`/`mood` = 말의 결; `scene`/`sensory`/`action`/`association` = 연상. Tier 1 is near-substitutable; 3 quite close; 5 moderate; 7 weak; 9 peripheral but worth keeping. Even values fall between adjacent odd values. 연상 Tier 1 is only for a real informal synonym. No quotas or batch-wide assignments.
- Bind a target ID only when its full gloss exactly matches the intended meaning; do not choose a homonym by spelling or first match. Otherwise use text-only and list every target alias shown for that candidate. If there are no targets, omit the target field.
- Checkpoint direction policy: {{relation_direction_rule}}
