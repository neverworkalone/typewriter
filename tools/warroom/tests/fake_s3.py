"""Fake `edit-cli.mjs` for the parallel Stage 3 scheduler tests (#3149): explicit chunk read/save over a checkpoint file.

It reproduces the contract the Supervisor depends on (view digest binding, idempotent `already_saved`, strict
rejection, pending digests), not the real Relation logic - that is covered by edit-cli.test.mjs."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from warroom.shell import Result


class FakeEditCli:
    def __init__(self):
        self.chunks = 0
        self.salt: dict[str, int] = {}        # chunk -> view generation (bumping it changes the digest)
        self.reject: dict[str, str] = {}      # chunk -> strict rejection text for the next saves
        self.calls: list[list[str]] = []
        self.saves: list[str] = []            # chunks actually written, in order

    def view(self, shard: str, chunk: str) -> dict:
        n = int(chunk)
        return {"shard": shard, "chunk": chunk, "relation_count": 2, "senses": [{
            "source": {"lemma": f"말{n}", "pos": "noun", "gloss": f"뜻{n}."},
            "relations": [{"n": 1, "type": "scene", "tier": 5, "target": f"t{n}"},
                          {"n": 2, "type": "mood", "tier": 4, "text": f"글{n}",
                           "targets": [{"alias": "T1", "record_id": f"r{n}", "sense_id": f"r{n}-s1",
                                        "lemma": f"글{n}", "pos": "noun", "gloss": "g"}]}]}]}

    def digest(self, shard: str, chunk: str) -> str:
        return hashlib.sha256(json.dumps([self.view(shard, chunk), self.salt.get(chunk, 0)]).encode()).hexdigest()

    def prompt_view(self, view: dict) -> str:
        n = view["chunk"]
        return "\n".join([f"chunk {n}/{self.chunks:03d} relations 2", f"S\t{view['senses'][0]['source']['lemma']}\tnoun\tg",
                          f"I1\tt{int(n)}\tscene\t5", f"X2\t글{int(n)}\tmood\t4", "T1\t글\tnoun\tg"])

    @staticmethod
    def path(cwd, shard):
        return Path(cwd) / ".warroom-scratch" / f"relation-edit-{shard}.json"

    def load(self, cwd, shard):
        return json.loads(self.path(cwd, shard).read_text("utf-8"))

    def write(self, cwd, shard, state):
        path = self.path(cwd, shard)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state), "utf-8")

    def run(self, argv, cwd):
        self.calls.append(list(argv))
        args = dict(zip(argv[3::2], argv[4::2]))
        command, shard = argv[2], args.get("--shard", "001")
        if command == "prepare":
            self.write(cwd, shard, {"version": 1, "shard": shard, "chunk_total": self.chunks,
                                    "completed_chunks": [], "decisions": []})
            return Result(0, json.dumps({"shard": shard, "chunk_count": self.chunks, "relation_count": 2 * self.chunks,
                                         "resumed": False}))
        state = self.load(cwd, shard)
        if command == "read-chunk":
            chunk = args["--chunk"]
            view = self.view(shard, chunk)
            return Result(0, json.dumps({**view, "prompt_view": self.prompt_view(view), "view_sha256": self.digest(shard, chunk),
                                         "completed": chunk in state["completed_chunks"]}))
        if command == "save-chunk":
            return self.save(cwd, shard, state, args)
        if command == "refresh-pending":
            pending = [f"{n:03d}" for n in range(1, self.chunks + 1) if f"{n:03d}" not in state["completed_chunks"]]
            first = pending[0] if pending else None
            view = self.view(shard, first) if first else None
            return Result(0, json.dumps({
                "shard": shard, "chunk_count": self.chunks, "current_chunk": first, "active_changed": False,
                "current_view": view, "prompt_view": self.prompt_view(view) if view else None,
                "pending_view_sha256": {c: self.digest(shard, c) for c in pending}}))
        return Result(1, "", f"unsupported {command}")

    def save(self, cwd, shard, state, args):
        chunk = args["--chunk"]
        if args["--expect-view-sha256"] != self.digest(shard, chunk):
            return Result(1, "", f"Stage 3 chunk {chunk} view changed since it was launched")
        lines = [x.strip() for x in (Path(cwd) / args["--in"]).read_text("utf-8").splitlines() if x.strip()]
        if lines[0] != f"chunk {chunk}":
            return Result(1, "", f'decision input must begin with "chunk {chunk}"')
        body = [] if lines[1:] == ["none"] else lines[1:]
        decisions = []
        for line in body:
            match = re.fullmatch(r"(D) (\d)|(L) (\d) T1", line)
            if not match:
                return Result(1, "", f"invalid decision line {line!r}")
            decisions.append({"chunk": chunk, "row": int(chunk) * 10 + int(match.group(2) or match.group(4)),
                              "action": "drop" if match.group(1) else "repair"})
        if chunk in state["completed_chunks"]:
            saved = [d for d in state["decisions"] if d["chunk"] == chunk]
            if sorted(map(json.dumps, saved)) != sorted(map(json.dumps, decisions)):
                return Result(1, "", f"Stage 3 chunk {chunk} is already saved with different decisions")
            return Result(0, json.dumps({"shard": shard, "chunk": chunk, "already_saved": True,
                                         "completed_chunks": len(state["completed_chunks"]), "total_chunks": self.chunks}))
        if self.reject.get(chunk):
            return Result(1, "", self.reject[chunk])
        state["completed_chunks"] = sorted([*state["completed_chunks"], chunk])
        state["decisions"] = sorted([*state["decisions"], *decisions], key=lambda d: d["row"])
        self.write(cwd, shard, state)
        self.saves.append(chunk)
        return Result(0, json.dumps({"shard": shard, "chunk": chunk, "already_saved": False,
                                     "completed_chunks": len(state["completed_chunks"]), "total_chunks": self.chunks}))
