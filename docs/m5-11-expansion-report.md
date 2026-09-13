# M5-11 +500 admission report

Issue #97 is held before canonical admission.

## Current state

- Input canonical: **778 starts / 820 records**
- Candidate pool: **550 selected starts**
- Intended bounded import: **500 starts**
- Candidate buffer: **50 starts**
- Current canonical import: **0 rows**
- Canonical, seed, and inventory mutation: **none**

The candidate catalog is not an editorial decision artifact. The builder refuses
to manufacture sense, POS, boundary, relation, audit, or admission verdicts. A
separately supplied human-complete decision artifact and complete gate evidence
are required before an external reviewed import can be produced.

The known mixed-sense candidates `싱겁다`, `다독이다`, `일구다`, and `삼키다`
are explicitly marked for multi-sense review. Admission validation rejects a
single-sense collapse and requires concrete boundary evidence for each admitted
record.

## Gate

`HOLD PROCESS` — editorial decision artifact, human editorial review, timing,
independent audit, and canonical promotion are incomplete. No later stage is
created or authorized.

Validation:

```sh
npm run batch:m5-11:check
```
