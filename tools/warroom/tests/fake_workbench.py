"""File-based stand-in for scripts/relation/candidate-workbench.mjs (prepare / read-chunk --format compact / save-chunk
--format compact / merge) used by the A/B answer-only tests. Like the real tool it keeps everything in files inside the
worktree and reports the real tool's error wording, so a restarted Supervisor sees the same state."""
from __future__ import annotations

import json
import re
from pathlib import Path

from warroom.shell import Result

CLI = ["node", "scripts/relation/candidate-workbench.mjs"]


class FakeWorkbenchCli:
    def __init__(self, records: int = 120):
        self.records = records
        self.calls: list[list[str]] = []
        self.merge_error: str | None = None   # a merge rejection (naming a record), consumed once
        self.merges = 0

    def rows(self) -> list[dict]:
        return [{"id": f"w{n:04d}", "lemma": f"표제{n}",
                 "senses": [{"id": f"w{n:04d}-s{k}", "pos": "noun", "gloss": f"뜻 {n}-{k}"} for k in range(1, 3 if n % 3 == 0 else 2)]}
                for n in range(1, self.records + 1)]

    def write_canonical(self, worktree: Path) -> None:
        path = Path(worktree) / "data/canonical/stdict-0001.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.rows()), "utf-8")

    @staticmethod
    def opt(argv, name):
        return argv[argv.index(name) + 1] if name in argv else None

    def run(self, argv, cwd):
        self.calls.append(list(argv))
        command = argv[2]
        base = Path(cwd) / self.opt(argv, "--scratch-dir") if self.opt(argv, "--scratch-dir") else None
        if command == "prepare":
            return self._prepare(argv, base, Path(cwd))
        if command == "read-chunk":
            return self._read(argv, base, Path(cwd))
        if command == "save-chunk":
            return self._save(argv, base, Path(cwd))
        if command == "merge":
            return self._merge(argv, base, Path(cwd))
        return Result(1, "", f"unknown command {command}")

    def _prepare(self, argv, base, cwd):
        if (base / "checkpoint.json").exists():
            return Result(0, json.dumps({"resumed": True}))
        size = int(self.opt(argv, "--chunk-size") or 25)
        rows = self.rows()[:500]
        chunks = []
        for start in range(0, len(rows), size):
            part = rows[start:start + size]
            n = len(chunks) + 1
            chunks.append({"number": n, "file": f"chunk-{n:03d}.jsonl", "start_index": start, "record_ids": [r["id"] for r in part],
                           "sense_count": sum(len(r["senses"]) for r in part)})
            (base / "source").mkdir(parents=True, exist_ok=True)
            (base / "source" / f"chunk-{n:03d}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in part), "utf-8")
        (base / "checkpoint.json").write_text(json.dumps({
            "contract": "candidate-workbench-v2",
            "batch": {"shard": self.opt(argv, "--shard"), "batch": self.opt(argv, "--batch"), "method": self.opt(argv, "--method"),
                      "model": self.opt(argv, "--model")},
            "source": {"canonical_path": "data/canonical/stdict-0001.jsonl", "canonical_sha256": "x", "first_record_index": 1,
                       "record_count": len(rows), "sense_count": sum(len(r["senses"]) for r in rows), "chunk_size": size},
            "chunks": chunks}), "utf-8")
        return Result(0, json.dumps({"resumed": False}))

    def _chunk(self, base, n):
        cp = json.loads((base / "checkpoint.json").read_text("utf-8"))
        chunk = cp["chunks"][n - 1]
        return chunk, [json.loads(l) for l in (base / "source" / chunk["file"]).read_text("utf-8").splitlines() if l]

    def _read(self, argv, base, cwd):
        n = int(self.opt(argv, "--chunk"))
        chunk, src = self._chunk(base, n)
        saved = base / "candidates" / chunk["file"]
        by_sense = {}
        if saved.exists():
            by_sense = {s["sense_id"]: s["candidates"] for l in saved.read_text("utf-8").splitlines() if l for s in json.loads(l)["senses"]}
        lines = [f"# chunk {n:03d}", "# S<n>\tsense_id\tlemma [homograph]\tpos\tsearch_forms\tfull gloss"]
        i = 0
        for rec in src:
            for s in rec["senses"]:
                i += 1
                lines.append(f"S{i}\t{s['id']}\t{rec['lemma']}\t{s['pos']}\t\t{s['gloss']}")
                if by_sense.get(s["id"]):
                    lines.append("\t".join(["C", f"S{i}", *by_sense[s["id"]]]))
        out = cwd / self.opt(argv, "--out")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("\n".join(lines) + "\n", "utf-8")
        return Result(0, json.dumps({"chunk": n}))

    def _save(self, argv, base, cwd):
        n = int(self.opt(argv, "--chunk"))
        chunk, src = self._chunk(base, n)
        lines = (cwd / self.opt(argv, "--input")).read_text("utf-8").split("\n")
        if lines[-1] == "":
            lines.pop()
        if lines[0] != f"chunk {n:03d}":
            return Result(1, "", f'compact answer must start with "chunk {n:03d}"')
        senses = [(rec, s) for rec in src for s in rec["senses"]]
        answered = {}
        for k, line in enumerate(lines[1:], 2):
            alias, *cands = line.split("\t")
            if not re.fullmatch(r"S[1-9]\d*", alias):
                return Result(1, "", f"chunk {n:03d} compact line {k} must start with an S<n> alias")
            if int(alias[1:]) > len(senses):
                return Result(1, "", f"chunk {n:03d} compact line {k} alias {alias} is outside chunk {n:03d} (S1..S{len(senses)})")
            if alias in answered:
                return Result(1, "", f"chunk {n:03d} compact line {k} repeats alias {alias}")
            answered[alias] = cands
        missing = [f"S{i}" for i in range(1, len(senses) + 1) if f"S{i}" not in answered]
        if missing:
            return Result(1, "", f"compact answer for chunk {n:03d} is missing alias(es): {', '.join(missing)}")
        for i, (rec, s) in enumerate(senses, 1):
            for c in answered[f"S{i}"]:
                if c == rec["lemma"]:
                    return Result(1, "", f"chunk {n:03d} input line {i} record_id {rec['id']} sense_id {s['id']} candidate "
                                         f'"{c}" repeats source lemma "{rec["lemma"]}"')
        (base / "candidates").mkdir(parents=True, exist_ok=True)
        rows, i = [], 0
        for rec in src:
            row = {"record_id": rec["id"], "senses": []}
            for s in rec["senses"]:
                i += 1
                row["senses"].append({"sense_id": s["id"], "candidates": answered[f"S{i}"]})
            rows.append(json.dumps(row, ensure_ascii=False))
        tmp = base / "candidates" / (chunk["file"] + ".tmp")
        tmp.write_text("\n".join(rows) + "\n", "utf-8")
        tmp.replace(base / "candidates" / chunk["file"])
        return Result(0, json.dumps({"chunk": n, "duplicatesRemoved": 0}))

    def _merge(self, argv, base, cwd):
        if self.merge_error:
            error, self.merge_error = self.merge_error, None
            return Result(1, "", error)
        cp = json.loads((base / "checkpoint.json").read_text("utf-8"))
        rows = []
        for chunk in cp["chunks"]:
            rows += [l for l in (base / "candidates" / chunk["file"]).read_text("utf-8").splitlines() if l]
        out = cwd / self.opt(argv, "--out")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("\n".join(rows) + "\n", "utf-8")
        self.merges += 1
        parsed = [json.loads(r) for r in rows]
        senses = [s for r in parsed for s in r["senses"]]
        cands = sum(len(s["candidates"]) for s in senses)
        empty = sum(1 for s in senses if not s["candidates"])
        return Result(0, json.dumps({"path": str(out), "changed": True, "validation": {
            "recordCount": len(parsed), "senseCount": len(senses), "candidateCount": cands, "emptySenseCount": empty}}, separators=(",", ":")))
