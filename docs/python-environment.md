# Shared Typewriter Python environment (issue #336)

Python tooling (currently Kiwi) runs from one venv per machine, shared by every Git worktree:

```text
~/.cache/typewriter/venv/        # default; shared across worktrees, outside the repository
```

The tracked contract is [`scripts/python/requirements.txt`](../scripts/python/requirements.txt)
(exact pins, currently `kiwipiepy==0.24.0`, `kiwipiepy_model==0.24.0`). The venv is only a cache.

```bash
node scripts/python/bootstrap.mjs      # create if missing, install, verify; safe to rerun
node scripts/python/run.mjs --print    # path of the verified shared Python (fails if missing/stale)
node scripts/python/run.mjs script.py  # run a script with it
```

- Overrides: `TYPEWRITER_CACHE_ROOT` (shared cache root), `TYPEWRITER_PYTHON_VENV` (venv location), `TYPEWRITER_PYTHON` (explicit interpreter; still
  version-checked by the launcher), `TYPEWRITER_BASE_PYTHON` (interpreter used to create the venv, default `python3`).
- Bootstrap records the SHA-256 of the requirements file in the venv. Missing packages, wrong versions, or a
  changed requirements file make the launcher fail with the bootstrap command; there is no fallback to system packages.
- `kiwi-client.mjs` and `produce-candidates.mjs` default to the shared interpreter; `kiwi_service.py` keeps its own
  pinned-version check. Synthetic `test_kiwi_service.py` still runs with system Python.
- CI may build an ephemeral venv with `pip install -r scripts/python/requirements.txt`; it never depends on the cache.
- Creating or removing worktrees never touches the venv.
