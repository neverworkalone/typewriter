"""Issue #3006: bound a shared Stage 2 correction to every exact candidate-local failure."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world
from warroom import control, stage2

CHUNK = "001-01-01-001"


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


def failures(chunk=CHUNK):
    return (f"chunk {chunk} not saved, checkpoint unchanged: 2 problem(s)\n"
            "c1 candidate-0: relation field is malformed\n"
            "c2 candidate-1: target_resolution must name an available target")


def start_world(test, *plans, candidates=3):
    world = s2_world(test)
    world.git.chunk_view_total = candidates
    control.start(world.store, "claude", S2, "single", cfg=world.cfg)
    world.adapter.plan.extend(plans)
    world.tick()
    return world, world.store.active_batch("claude", S2)


def finish(world, batch, ticks=1):
    world.adapter.finish(world.adapter.launches[-1]["pid"])
    world.tick(ticks)
    return world.store.batch(batch["id"])


def checkpoint_path(batch):
    bb, pp = stage2.split_key(batch["batch"])
    return Path(batch["worktree"]) / ".warroom-scratch" / f"relation-admission-{batch['shard']}-{bb}-{pp}.json"


class MultiCandidateCorrection(unittest.TestCase):
    def test_complete_diagnostic_requires_unique_aliases_candidate_names_and_exact_count(self):
        self.assertEqual(stage2.candidate_local_failure_aliases(failures(), CHUNK), ["c1", "c2"])
        self.assertEqual(stage2.single_candidate_failure_alias(
            f"chunk {CHUNK} not saved, checkpoint unchanged: 1 problem(s)\nc1 candidate-0: bad\ntypes: near; tier: one digit 1..9",
            CHUNK), "c1")
        for diagnostic in (
            failures().replace("2 problem(s)", "3 problem(s)"),
            failures().replace("c2 candidate-1: target_resolution must name an available target", "types: unexpected mixed error"),
            failures().replace("c2 candidate-1: target_resolution must name an available target",
                               "c1 candidate-0: target_resolution must name an available target"),
            failures().replace("c2 candidate-1", "c99 unknown-candidate"),
        ):
            with self.subTest(diagnostic=diagnostic):
                self.assertIsNone(stage2.candidate_local_failure_aliases(diagnostic, CHUNK))

    def test_two_distinct_errors_retry_together_and_preserve_the_normal_row(self):
        original = answer(f"chunk {CHUNK}\nc1 R near 3 BAD\nc2 R scene 5 T999\nc3 D x")
        corrected = answer(f"chunk {CHUNK}\nc1 R near 3\nc2 R scene 5")
        world, batch = start_world(self, {"code": 0, "session": "s1", "text": original},
                                   {"code": 0, "session": "s1", "text": corrected})

        batch = finish(world, batch)
        self.assertEqual(batch["run_kind"], "s2_chunk_fix", batch["error"])
        state = json.loads(world.store.get(stage2.correction_key(batch["id"])))
        self.assertEqual((state["version"], [row["alias"] for row in state["candidates"]], state["retry_count"]),
                         (2, ["c1", "c2"], 1))
        self.assertEqual(len([run for run in world.store.runs(batch["id"]) if run["kind"] == "s2_chunk_fix"]), 1)
        self.assertIn("c1 candidate-0", world.adapter.launches[-1]["prompt"])
        self.assertIn("c2 candidate-1", world.adapter.launches[-1]["prompt"])
        self.assertIn("type`, `relevance`", world.adapter.launches[-1]["prompt"])

        batch = finish(world, batch)
        self.assertEqual(len(world.git.save_calls), 3)  # initial, exact failure replay, corrected official save path
        self.assertEqual(world.git.save_calls[-1].splitlines(), [f"chunk {CHUNK}", "c1 R near 3", "c2 R scene 5", "c3 D x"])
        saved = json.loads(checkpoint_path(batch).read_text("utf-8"))
        self.assertEqual((saved["pending_chunk"], saved["next_chunk_number"]), (None, 2))
        self.assertIsNone(world.store.get(stage2.correction_key(batch["id"])))

    def test_one_still_failing_candidate_gets_only_one_existing_policy_fallback(self):
        original = answer(f"chunk {CHUNK}\nc1 R near 3 BAD\nc2 R scene 5 T999\nc3 D x")
        corrected = answer(f"chunk {CHUNK}\nc1 R near 3\nc2 R scene 5 T999")
        world, batch = start_world(self, {"code": 0, "session": "s1", "text": original},
                                   {"code": 0, "session": "s1", "text": corrected})

        batch = finish(world, batch)
        self.assertEqual(batch["run_kind"], "s2_chunk_fix")
        batch = finish(world, batch)

        self.assertEqual(len(world.git.technical_fallback_calls), 1)
        self.assertEqual(world.git.technical_fallback_calls[0]["alias"], "c2")
        self.assertEqual(world.git.save_calls[-1].splitlines(), [f"chunk {CHUNK}", "c1 R near 3", "c3 D x"])
        saved = json.loads(checkpoint_path(batch).read_text("utf-8"))
        decisions = [candidate["decision"] for item in saved["items"] for candidate in item["candidates"]]
        self.assertEqual(decisions, [
            {"disposition": "drop", "reason": "x"},
            {"disposition": "drop", "reason": "f"},
            {"disposition": "drop", "reason": "x"},
        ])

    def test_failed_fallback_is_not_spent_again_after_owner_retry(self):
        original = answer(f"chunk {CHUNK}\nc1 R near 3 BAD\nc2 R scene 5 T999\nc3 D x")
        corrected = answer(f"chunk {CHUNK}\nc1 R near 3\nc2 R scene 5 T999")
        world, batch = start_world(self, {"code": 0, "session": "s1", "text": original},
                                   {"code": 0, "session": "s1", "text": corrected})
        real_save = world.git.stage2_save_chunk

        def reject_fallback(worktree, shard, batch_number, part, timeout=900,
                            supervisor_fallback=None, supervisor_state_dir=None):
            if supervisor_fallback is not None:
                world.git.technical_fallback_calls.append(dict(supervisor_fallback))
                return False, "synthetic official save-chunk rejection"
            return real_save(worktree, shard, batch_number, part, timeout=timeout,
                             supervisor_fallback=supervisor_fallback,
                             supervisor_state_dir=supervisor_state_dir)

        world.git.stage2_save_chunk = reject_fallback
        batch = finish(world, batch)
        self.assertEqual(batch["run_kind"], "s2_chunk_fix")
        batch = finish(world, batch)
        self.assertEqual((batch["state"], len(world.git.technical_fallback_calls)), ("ERROR", 1))
        state = json.loads(world.store.get(stage2.correction_key(batch["id"])))
        self.assertTrue(state["fallback_attempted"])
        decisions = Path(batch["worktree"]) / stage2.DECISIONS
        before = decisions.read_bytes()

        world.sup = world.make_sup()
        self.assertTrue(control.retry(world.store, "claude", S2))
        world.tick(2)
        batch = world.store.batch(batch["id"])
        self.assertEqual((batch["state"], len(world.adapter.launches), len(world.git.technical_fallback_calls)),
                         ("ERROR", 2, 1))
        self.assertEqual(decisions.read_bytes(), before)

    def test_partial_fix_fails_closed_and_owner_retry_cannot_spend_a_second_run(self):
        original = answer(f"chunk {CHUNK}\nc1 R near 3 BAD\nc2 R scene 5 T999\nc3 D x")
        partial = answer(f"chunk {CHUNK}\nc1 R near 3")
        world, batch = start_world(self, {"code": 0, "session": "s1", "text": original},
                                   {"code": 0, "session": "s1", "text": partial})

        batch = finish(world, batch)
        decisions = Path(batch["worktree"]) / stage2.DECISIONS
        original_bytes = decisions.read_bytes()
        checkpoint_before = checkpoint_path(batch).read_bytes()
        batch = finish(world, batch)
        self.assertEqual(batch["state"], "ERROR")
        self.assertIn("실패한 후보 각각의 행 하나", batch["error"])
        self.assertEqual(decisions.read_bytes(), original_bytes)
        self.assertEqual(len(world.git.technical_fallback_calls), 0)
        self.assertEqual(checkpoint_path(batch).read_bytes(), checkpoint_before)

        world.sup = world.make_sup()  # persisted correction budget survives a Supervisor restart
        self.assertTrue(control.retry(world.store, "claude", S2))
        world.tick(2)
        batch = world.store.batch(batch["id"])
        self.assertEqual((batch["state"], len(world.adapter.launches)), ("ERROR", 2))
        self.assertEqual(decisions.read_bytes(), original_bytes)
        self.assertEqual(checkpoint_path(batch).read_bytes(), checkpoint_before)
        self.assertEqual(len(world.git.technical_fallback_calls), 0)

    def test_unknown_alias_and_stale_view_or_checkpoint_do_not_reserve_repair(self):
        for stale in ("alias", "view", "checkpoint"):
            with self.subTest(stale=stale):
                world = s2_world(self)
                world.git.chunk_view_total = 3
                control.start(world.store, "claude", S2, "single", cfg=world.cfg)
                world.tick()
                batch = world.store.active_batch("claude", S2)
                stage2.write_decisions(batch["worktree"], CHUNK, ["c1 D x", "c2 D e", "c3 D x"])
                diagnostic = failures()
                if stale == "alias":
                    diagnostic = diagnostic.replace("c2 candidate-1", "c99 unknown-candidate")
                elif stale == "view":
                    view = Path(batch["worktree"]) / stage2.CHUNK_VIEW
                    view.write_text(view.read_text("utf-8") + "# drift\n", "utf-8")
                else:
                    path = checkpoint_path(batch)
                    data = json.loads(path.read_text("utf-8"))
                    data["unexpected"] = True
                    path.write_text(json.dumps(data), "utf-8")
                self.assertIsNone(world.sup._stage2_reserve_candidate_correction(batch, CHUNK, diagnostic))
                self.assertIsNone(world.store.get(stage2.correction_key(batch["id"])))


if __name__ == "__main__":
    unittest.main()
