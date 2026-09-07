# Extension Review

Use for Chrome runtime, popup/Settings, keyboard behavior, storage,
SQLite/WASM loading, permissions, MV3, and CSP.

Check as applicable:

- packaged dictionary lookup remains local;
- SQLite/WASM/package paths remain valid;
- MV3/CSP and permissions remain valid and proportionate;
- dictionary data remains read-only and separate from user data;
- search and keyboard behavior remain correct;
- affected startup/search paths do not materially regress performance.

Visual design, copy, spacing, and general usability are user-validated.

Do not build UI automation merely to reproduce visual judgment.

When a reported UI defect has stable functional behavior worth protecting,
add a regression test; otherwise rely on direct user validation.
