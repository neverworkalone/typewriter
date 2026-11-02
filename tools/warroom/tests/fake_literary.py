"""In-memory stand-in for scripts/relation/literary-context-cli.mjs used by the Method C Supervisor tests.

State lives in the checkpoint file inside the worktree (like the real CLI), so a restarted Supervisor sees it.
"""
from __future__ import annotations

import json
import hashlib
from pathlib import Path

from warroom.shell import Result

DONE = ("ZERO_HITS", "SUBMITTED", "NO_VERIFIED", "SAMPLED_NO_VERIFIED", "DISCOVERED", "TECHNICAL_SKIPPED")


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
    def run(self, argv, cwd, env=None):
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
        if cmd == "submit":
            input_path = Path(cwd) / self.opt(argv, "--input")
            diagnostic_path = input_path.with_name(input_path.name + ".diag.json")
            if diagnostic_path.is_file():
                diagnostic = json.loads(diagnostic_path.read_text("utf-8"))
                submission = json.loads(input_path.read_text("utf-8"))
                affected = diagnostic.get("affected") or {}
                entries = submission.get("senses") or []
                target = entries[affected["entry_number"] - 1] if 1 <= affected.get("entry_number", 0) <= len(entries) else {}
                if (diagnostic.get("reason") == "context_key_not_found" and isinstance(target, dict)
                        and any(isinstance(key, str) and key != key.strip() and len(key.strip()) >= 12
                                for key in target.get("verified", []))):
                    for entry in entries:
                        saved = dict(entry)
                        saved["verified"] = [key.strip() if isinstance(key, str) else key for key in entry.get("verified", [])]
                        cp["status"][entry["sense_id"]] = "SUBMITTED"
                        cp.setdefault("submitted", {})[entry["sense_id"]] = saved
                    cp["output"] = None
                    self.save(cwd, argv, cp)
                    diagnostic_path.unlink(missing_ok=True)
                    return Result(0, json.dumps({"status": "SAVED"}))
                diagnostic["input_sha256"] = hashlib.sha256(input_path.read_bytes()).hexdigest()
                diagnostic_path.write_text(json.dumps(diagnostic) + "\n")
            return Result(1, "", "submit_validation")
        if cmd == "report" and "--sense-ids" not in argv:
            counts: dict = {}
            for s in cp["status"].values():
                counts[s] = counts.get(s, 0) + 1
            out = cp["output"]
            return Result(0, json.dumps({"batch": cp["batch"], "coverage": {"records": 500, "senses": len(cp["ids"]),
                                                                             "sense_statuses": counts},
                                         "output": ({"state": "OUTPUT", "path": out["path"], "sha256": out["sha256"],
                                                     "validation_status": "VALID"} if out else None),
                                         "technical_skips": cp.get("technical_skips", [])}))
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
        if cmd == "supervisor-skip":
            # The real CLI reads the trusted DB from Git's common repository root. The Supervisor calls this fake only
            # after it independently confirms both same-session retries in its own Store.
            retry_attempts = 2
            input_path = Path(cwd) / self.opt(argv, "--input")
            submission = json.loads(input_path.read_text("utf-8"))
            diagnostic = json.loads(input_path.with_name(input_path.name + ".diag.json").read_text("utf-8"))
            active = json.loads((Path(cwd) / ".warroom-scratch/c-active-chunk.json").read_text("utf-8"))
            entry_number = diagnostic["affected"]["entry_number"]
            target = diagnostic["affected"]["sense_id"]
            if submission["senses"][entry_number - 1]["sense_id"] != target or target not in active["sense_ids"]:
                return Result(1, "", "diagnostic mismatch")
            for entry in submission["senses"]:
                if entry["sense_id"] == target:
                    continue
                cp["status"][entry["sense_id"]] = "SUBMITTED"
                cp.setdefault("submitted", {})[entry["sense_id"]] = entry
            cp["status"][target] = "TECHNICAL_SKIPPED"
            record_id = f"record-{target}"
            skip = {"record_id": record_id, "sense_id": target, "diagnostic": diagnostic["diagnostic"],
                    "reason": diagnostic["reason"], "field": diagnostic["affected"]["field"],
                    "retry_attempts": retry_attempts}
            cp.setdefault("technical_skips", []).append(skip)
            cp["output"] = None
            self.save(cwd, argv, cp)
            return Result(0, json.dumps({"status": "TECHNICAL_SKIPPED", **skip,
                                         "pending_senses": sum(status not in DONE for status in cp["status"].values())}))
        if cmd == "validate":
            return Result(0, json.dumps({"status": "VALID", "recordCount": 500, "senseCount": len(cp["ids"]),
                                         "candidateCount": 7, "emptySenseCount": 1}))
        return Result(1, "", f"unknown command {cmd}")
