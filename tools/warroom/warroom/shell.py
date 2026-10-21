"""Command runner seam: production uses subprocess, tests inject a fake."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Result:
    code: int
    out: str = ""
    err: str = ""

    @property
    def ok(self) -> bool:
        return self.code == 0


class Runner:
    def run(self, argv: list[str], cwd: Path | str | None = None,
            env: dict | None = None, input: str | None = None,
            timeout: float | None = 120) -> Result:
        try:
            p = subprocess.run(argv, cwd=cwd, env=env, input=input, text=True,
                               capture_output=True, timeout=timeout)
        except FileNotFoundError as e:
            return Result(127, "", str(e))
        except subprocess.TimeoutExpired:
            return Result(124, "", f"timeout: {argv[0]}")
        return Result(p.returncode, p.stdout, p.stderr)
