"""In-memory stand-in for scripts/relation/d-chunk-cli.mjs (prepare) and candidate-contract.mjs used by Method D tests.

Like the real CLI it keeps everything in files inside the worktree, so a restarted Supervisor sees the same state.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from warroom.shell import Result

D_DIR = ".warroom-scratch/d-001_01"


class FakeDChunkCli:
    def __init__(self, records: int = 60):
        self.records = records
        self.calls: list[list[str]] = []
        self.auto: set[int] = set()          # chunk numbers `prepare` completes without an AI
        self.failed: set[int] = set()        # chunk numbers whose search fails
        self.padding = 0                     # extra view lines (to force the page fallback)
        self.validate_error: str | None = None
        self.validations = 0

    # -- Canonical -------------------------------------------------------------------------------------------------
    def rows(self) -> list[dict]:
        return [{"id": f"w{n:04d}", "lemma": f"표제{n}", "senses": [{"id": f"w{n:04d}-s{k}", "pos": "noun", "gloss": "뜻"}
                                                                    for k in range(1, 3 if n % 3 == 0 else 2)]}
                for n in range(1, self.records + 1)]

    def write_canonical(self, worktree: Path) -> None:
        path = Path(worktree) / "data/canonical/stdict-0001.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.rows()), "utf-8")

    def chunk(self, number: int) -> list[dict]:
        return self.rows()[(number - 1) * 25:number * 25]

    def save(self, worktree: Path, number: int, candidates=lambda sid: ["후보"]) -> Path:
        """What a successful `save` (or an automatic chunk) leaves: one atomically written chunk file."""
        folder = Path(worktree) / D_DIR
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"chunk-{number:03d}.jsonl"
        lines = [json.dumps({"record_id": r["id"], "senses": [{"sense_id": s["id"], "candidates": candidates(s["id"])}
                                                              for s in r["senses"]]}, ensure_ascii=False) for r in self.chunk(number)]
        target.write_text("\n".join(lines) + "\n", "utf-8")
        return target

    # -- CLI -------------------------------------------------------------------------------------------------------
    @staticmethod
    def opt(argv, name):
        return argv[argv.index(name) + 1] if name in argv else None

    def run(self, argv, cwd):
        self.calls.append(list(argv))
        if argv[1] == "scripts/relation/candidate-contract.mjs":
            self.validations += 1
            if self.validate_error:
                return Result(1, "", self.validate_error)
            rows = [json.loads(l) for l in (Path(cwd) / argv[3]).read_text("utf-8").splitlines() if l]
            senses = sum(len(r["senses"]) for r in rows)
            cands = sum(len(s["candidates"]) for r in rows for s in r["senses"])
            empty = sum(1 for r in rows for s in r["senses"] if not s["candidates"])
            return Result(0, f"Candidate v1 valid: {len(rows)} records, {senses} senses, {cands} candidates, {empty} empty senses, 0 source-lemma candidates.\n")
        if argv[2] != "prepare":
            return Result(1, "", f"unknown command {argv[2]}")
        number = int(self.opt(argv, "--chunk"))
        total = -(-self.records // 25)
        base = {"chunk_no": number, "total_chunks": total, "records": len(self.chunk(number))}
        if number in self.failed:
            return Result(3, json.dumps({"status": "SEARCH_FAILED", "failed_records": [self.chunk(number)[0]["id"]], **base}))
        if number in self.auto:
            self.save(Path(cwd), number, lambda sid: [])
            return Result(0, json.dumps({"status": "AUTO_COMPLETE", **base}))
        senses = [{"ref": f"s{i}", "sense_id": s["id"]} for i, s in enumerate((s for r in self.chunk(number) for s in r["senses"]), 1)]
        view = f"batch=001_01 chunk={number:03d}/{total:03d}\n\n" + "\n".join(
            f"## {r['id']} {r['lemma']}\n" + "\n".join(f"{x['ref']} {x['sense_id']}" for x in senses if x["sense_id"].startswith(r["id"]))
            for r in self.chunk(number)) + "\n" + "".join(f"padding {i} 한국어 원문 발췌\n" for i in range(self.padding))
        folder = Path(cwd) / D_DIR
        folder.mkdir(parents=True, exist_ok=True)
        number_text = f"{number:03d}"
        (folder / f"view-{number_text}.txt").write_text(view, "utf-8")
        (folder / f"search-{number_text}.jsonl").write_text("", "utf-8")
        (folder / f"active-{number_text}.json").write_text(json.dumps({
            "shard": self.opt(argv, "--shard"), "batch": self.opt(argv, "--batch"), "model": self.opt(argv, "--model"),
            "git_head": self.opt(argv, "--head"), "chunk_no": number, "view_sha256": hashlib.sha256(view.encode()).hexdigest(),
            "view_bytes": len(view.encode()),
            "senses": senses}))
        return Result(0, json.dumps({"status": "READY", "ai_senses": len(senses), **base}))
