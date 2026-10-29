"""In-memory stand-in for scripts/relation/literary-context-cli.mjs used by the Method C Supervisor tests.

State lives in the checkpoint file inside the worktree (like the real CLI), so a restarted Supervisor sees it.
"""
from __future__ import annotations

import json
from pathlib import Path

from warroom.shell import Result

DONE = ("ZERO_HITS", "SUBMITTED", "NO_VERIFIED", "SAMPLED_NO_VERIFIED", "DISCOVERED")


class FakeLiteraryCli:
    def __init__(self, head: str = "a" * 40, senses: int = 30, zero_hit_every: int = 0):
        self.head, self.senses, self.zero_hit_every = head, senses, zero_hit_every
        self.calls: list[list[str]] = []
        self.export_error: str | None = None       # stderr JSON of a Candidate v1 rejection
        self.fail: dict[str, Result] = {}          # command -> forced result
        self.chunk_status: dict[str, str] = {}     # sense id -> SEARCH_FAILED / UNSEARCHABLE in the chunk view
        self.exports = 0
        self.clears: list[list[str]] = []

    # -- helpers ------------------------------------------------------------------------------------------------
    @staticmethod
    def opt(argv, name):
        return argv[argv.index(name) + 1] if name in argv else None

    def load(self, cwd, argv):
        return json.loads((Path(cwd) / self.opt(argv, "--checkpoint")).read_text())

    def save(self, cwd, argv, cp):
        (Path(cwd) / self.opt(argv, "--checkpoint")).write_text(json.dumps(cp))

    def mark(self, cwd, checkpoint, ids, status="SUBMITTED"):
        """What a successful `submit` does (used by the fake AI's effect)."""
        path = Path(cwd) / checkpoint
        cp = json.loads(path.read_text())
        for i in ids:
            cp["status"][i] = status
        cp["output"] = None
        cp["submits"] = cp.get("submits", 0) + 1   # the real CLI rewrites submitted_at timestamps
        path.write_text(json.dumps(cp))

    # -- CLI ----------------------------------------------------------------------------------------------------
    def run(self, argv, cwd):
        self.calls.append(list(argv))
        cmd = argv[2]
        if cmd in self.fail:
            return self.fail[cmd]
        shard, batch, model = self.opt(argv, "--shard"), self.opt(argv, "--batch"), self.opt(argv, "--model")
        if cmd == "init":
            ids = [f"s{i:04d}" for i in range(self.senses)]
            cp = {"batch": {"shard": shard, "batch": batch, "model": model, "git_head": self.head},
                  "ids": ids, "status": {i: ("PENDING" if self.zero_hit_every == 0 or n % self.zero_hit_every else "PENDING")
                                          for n, i in enumerate(ids)}, "output": None}
            (Path(cwd) / self.opt(argv, "--checkpoint")).parent.mkdir(parents=True, exist_ok=True)
            self.save(cwd, argv, cp)
            return Result(0, json.dumps({"status": "READY"}))
        cp = self.load(cwd, argv)
        if cmd == "report" and "--sense-ids" not in argv:
            counts: dict = {}
            for s in cp["status"].values():
                counts[s] = counts.get(s, 0) + 1
            out = cp["output"]
            return Result(0, json.dumps({"batch": cp["batch"], "coverage": {"records": 500, "senses": len(cp["ids"]),
                                                                             "sense_statuses": counts},
                                         "output": ({"state": "OUTPUT", "path": out["path"], "sha256": out["sha256"],
                                                     "validation_status": "VALID"} if out else None)}))
        if cmd == "report":
            ids = self.opt(argv, "--sense-ids").split(",")
            if len(set(ids)) != len(ids) or any(i not in cp["status"] for i in ids):
                return Result(1, "", "unknown sense")
            senses = [{"sense_id": i, "status": cp["status"][i], "done": cp["status"][i] in DONE} for i in ids]
            return Result(0, json.dumps({"batch": cp["batch"], "all_done": all(s["done"] for s in senses), "senses": senses}))
        if cmd == "chunk":
            wanted = self.opt(argv, "--sense-ids")
            pool = wanted.split(",") if wanted else [i for i in cp["ids"] if cp["status"][i] not in DONE]
            limit = int(self.opt(argv, "--limit") or 12)
            shown = pool[:limit]
            blocks = []
            for i in shown:
                if i in self.chunk_status:
                    blocks.append(f"## {i} — {self.chunk_status[i]}")
                else:
                    blocks.append(f"## {i} — 표제 [noun]\n뜻 {i}\nhits=3 unseen=0\n[abcdef123456] 작품 / 작가\n원문 {i} 한국어 발췌")
            done = sum(1 for s in cp["status"].values() if s in DONE)
            return Result(0, f"batch={shard or cp['batch']['shard']}_{cp['batch']['batch']} done={done}/{len(cp['ids'])} zero_hit=0 "
                             f"not_yet_read={max(0, len(pool) - len(shown))}\n\n" + "\n\n".join(blocks) + "\n")
        if cmd == "export":
            if self.export_error:
                return Result(1, "", self.export_error)
            self.exports += 1
            out = self.opt(argv, "--output")
            path = Path(cwd) / out
            path.parent.mkdir(parents=True, exist_ok=True)
            text = "".join(json.dumps({"record_id": i}) + "\n" for i in range(500))
            path.write_text(text)
            import hashlib
            cp["output"] = {"path": out, "sha256": hashlib.sha256(text.encode()).hexdigest()}
            self.save(cwd, argv, cp)
            return Result(0, json.dumps({"status": "OUTPUT", "coverage": {"records": 500, "senses": len(cp["ids"]),
                                                                           "candidates": 7, "empty_senses": 1}}))
        if cmd == "clear-candidates":
            ids = self.opt(argv, "--sense-ids").split(",")
            if len(set(ids)) != len(ids) or any(i not in cp["status"] for i in ids):
                return Result(1, "", "unknown sense")
            self.clears.append(ids)
            cp["candidate_fallbacks"] = cp.get("candidate_fallbacks", []) + ids
            self.save(cwd, argv, cp)
            self.export_error = None
            return Result(0, json.dumps({"status": "CLEARED", "senses": len(ids), "candidates": len(ids)}))
        if cmd == "validate":
            return Result(0, json.dumps({"status": "VALID", "recordCount": 500, "senseCount": len(cp["ids"]),
                                         "candidateCount": 7, "emptySenseCount": 1}))
        return Result(1, "", f"unknown command {cmd}")
