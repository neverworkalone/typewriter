"""War Room Recovery lane (former tools/warroom/recovery-desk): deterministic detection, one owner per failure group,
launch/adoption across Supervisor restarts, per-type RESOLVED and the loop guard. Fake AI/GitHub/git only."""
import json
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1, HEAD2
from tests.test_issue_1555 import make_batch
from tests.test_lines import multi_world
from warroom import config, control, recovery, views
from warroom.adapters import ClaudeCodeAdapter, RunSpec
from warroom.recovery import STALL_CHECKS, parse_report
from warroom.store import CLAIM_RECOVERY_RUN_SQL, MAINTENANCE_METHOD

REPORT = """작업 요약

STATUS: {status}
CASE: {case}
DONE: {done}
REMAINING: {remaining}
BLOCKER: {blocker}
BOUNDARY: {boundary}
PR: {pr}
"""


def report(status="IN_PROGRESS", case="batch:1", done="조사", remaining="남은 일", blocker="none", boundary="none",
           pr="none"):
    return REPORT.format(status=status, case=case, done=done, remaining=remaining, blocker=blocker, boundary=boundary,
                         pr=pr)


def rworld(recovery_target="sonnet"):
    w = multi_world()
    w.cfg["recovery"] = recovery_target
    return w


def error_batch(w, error="boom", **fields):
    return make_batch(w, "s2", "codex", state="ERROR", error=error, paused_from="PRODUCING", **fields)


class Base(unittest.TestCase):
    def setUp(self):
        self.w = rworld()

    def tearDown(self):
        self.w.tmp.cleanup()

    def step(self, sup=None):
        (sup or self.w.sup).recovery.step()

    def open_runs(self):
        return self.w.store.open_recovery_runs()

    def finish_last(self, text, code=0, session="ses_r1"):
        """The running recovery run ends: its log holds `text` and its session id."""
        pid = self.open_runs()[-1]["pid"]
        self.w.adapter.running[pid].update(code=code, text=text, session=session)
        self.w.adapter.finish(pid)


class ClaimGuard(Base):
    def test_one_open_run_per_case_and_the_parallel_limit_in_one_statement(self):
        s = self.w.store
        a = s.open_recovery_case("batch:1", "task")
        b = s.open_recovery_case("batch:2", "task")
        self.assertIsNone(s.open_recovery_case("batch:1", "task"))   # one open case per key
        claim = dict(producer="sonnet", model="m", effort="high", permission="auto", session_id=None,
                     log_file="l", exit_file="e")
        r1 = s.claim_recovery_run(a, "start", max_parallel=2, **claim)
        self.assertIsNotNone(r1)
        self.assertIsNone(s.claim_recovery_run(a, "start", max_parallel=2, **claim))   # never a second run per case
        r2 = s.claim_recovery_run(b, "start", max_parallel=2, **claim)
        self.assertIsNotNone(r2)
        c = s.open_recovery_case("batch:3", "task")
        self.assertIsNone(s.claim_recovery_run(c, "start", max_parallel=2, **claim))   # the limit
        s.finish_recovery_run(r1, "0")
        self.assertFalse(s.resolve_recovery_case(b))   # never resolved under a live run
        self.assertTrue(s.resolve_recovery_case(a))
        self.assertIsNone(s.claim_recovery_run(a, "start", max_parallel=2, **claim))   # closed case
        self.assertIsNotNone(s.open_recovery_case("batch:1", "task"))   # a new failure later is a new case

    def test_a_batch_belongs_to_one_open_case(self):
        s = self.w.store
        a = s.open_recovery_case("batch:5", "task", batch_ids=[5])
        self.assertIsNone(s.open_recovery_case("defect:9", "maintainer", batch_ids=[5, 6]))
        self.assertFalse(s.attach_recovery_batch(s.open_recovery_case("defect:9", "maintainer", batch_ids=[6]), 5))
        self.assertEqual(s.recovery_case_for_batch(5)["id"], a)

    def test_the_watchdog_uses_the_same_claim_statement(self):
        import recovery_watch
        self.assertEqual(recovery_watch.CLAIM_RECOVERY_RUN_SQL, CLAIM_RECOVERY_RUN_SQL)


class Detection(Base):
    def test_off_without_config_starts_nothing(self):
        self.w.cfg["recovery"] = None
        error_batch(self.w)
        self.step()
        self.assertEqual(self.w.store.open_recovery_cases(), [])
        self.assertEqual(self.w.adapter.launches, [])

    def test_normal_states_never_launch(self):
        stop = "강제 중지됨. worktree·브랜치·PR은 보존됨 (프로세스 종료 확인 후 Retry로 재개)."
        limit = "CLI 사용량 한도에 도달했습니다 — 자동 전환·재시도 없이 중지합니다. 한도 해제 후 Retry."
        scenarios = {
            "in progress": dict(state="PRODUCING"),
            "owner stop": dict(state="PAUSED", error=stop),
            "real limit": dict(state="PAUSED", error=limit),
            "review wait": dict(state="WAITING_REVIEW", pr_number=7, head_sha=HEAD1),
            "maintainer continuation": dict(state="PAUSED", pause_reason="maintainer_continuation", error="x"),
            "rate-limit back-off": dict(state="PRODUCING", retry_after=2_000_000.0),
        }
        for name, fields in scenarios.items():
            with self.subTest(name):
                w = rworld()
                self.addCleanup(w.tmp.cleanup)
                make_batch(w, "s2", "codex", **fields)
                for _ in range(2):
                    w.sup.recovery.step()
                self.assertEqual(w.store.open_recovery_cases(), [])
                self.assertEqual(w.adapter.launches, [])
        with self.subTest("clear requested"):
            w = self.w
            b = error_batch(w)
            w.store.request_clear("codex", "s2", b["id"])
            self.step()
            self.assertEqual(w.store.open_recovery_cases(), [])
            self.assertEqual(w.adapter.launches, [])

    def test_a_confirmed_error_launches_on_the_next_turn_with_the_contract_and_facts(self):
        w = self.w
        w.adapter.name = "claude"
        b = error_batch(w, error="save-chunk exit 2")
        self.step()
        case = w.store.recovery_case_by_key(f"batch:{b['id']}")
        self.assertEqual((case["kind"], case["state"]), ("task", "OPEN"))
        self.assertEqual(len(w.adapter.launches), 1)
        launch = w.adapter.launches[0]
        self.assertEqual(launch["kind"], "start")
        self.assertEqual(launch["cwd"], str(w.paths.repo_root))
        self.assertEqual(launch["extra"], {"permission_mode": "auto"})
        self.assertEqual((launch["model"], launch["effort"]), ("claude-sonnet", "high"))
        self.assertIn("War Room Recovery", launch["prompt"])
        self.assertIn("save-chunk exit 2", launch["prompt"])
        self.assertIn("loaded_code_sha", launch["prompt"])
        self.assertIn("BOUNDARY:", launch["prompt"])
        run = self.open_runs()[0]
        self.assertEqual((run["case_id"], run["pid"], run["model"]), (case["id"], launch["pid"], "claude-sonnet"))

    def test_codex_recovery_gets_the_operating_git_dir_and_its_permission_profile(self):
        w = self.w
        w.cfg["model_profiles"] = {"luna": {"adapter": "codex", "model": "gpt-luna", "effort": "high",
                                            "permission_profile": "worktree"}}
        w.cfg["recovery"] = "luna"
        w.adapter.needs_git_dir = True
        error_batch(w)
        self.step()
        launch = w.adapter.launches[0]
        self.assertEqual(launch["extra"], {"git_dir": str(w.paths.git_admin_dir)})
        self.assertEqual((launch["model"], launch["permission_profile"]), ("gpt-luna", "worktree"))

    def test_a_stall_launches_only_on_the_third_unchanged_check(self):
        w = self.w
        w.cfg["recovery_stall_seconds"] = 600
        make_batch(w, "s2", "codex", state="PRODUCING")
        for i in range(STALL_CHECKS):
            self.step()
            self.assertEqual(w.adapter.launches, [], f"check {i + 1}")
            w.now += 600
        self.step()
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.store.open_recovery_cases()[0]["kind"], "stall")

    def test_progress_between_checks_resets_the_stall(self):
        w = self.w
        b = make_batch(w, "s2", "codex", state="PRODUCING", progress_done=0)
        for i in range(6):
            w.store.update(b["id"], progress_done=i)   # the official saved count moves
            self.step()
            w.now += 600
        self.assertEqual(w.adapter.launches, [])

    def test_drain_still_recovers_the_current_batch_and_keeps_blocking_the_next(self):
        w = self.w
        b = error_batch(w)
        control.set_drain(w.store, "codex", "s2", True, w.cfg)
        self.step()
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.store.peek_line("codex", "s2")["drain"], 1)   # untouched
        self.assertEqual(w.store.recovery_case_for_batch(b["id"])["state"], "OPEN")

    def test_slow_github_reads_never_hold_the_coordinator(self):
        import threading
        import time as _time
        from concurrent.futures import ThreadPoolExecutor
        from warroom.supervisor import RECOVERY_KEY
        w = self.w
        w.cfg["poll_seconds"] = 0
        b = make_batch(w, "s3", "codex", state="WAITING_REVIEW", pr_number=7, head_sha=HEAD1)
        w.pr_info(7, HEAD1, head_ref=b["branch"])
        w.store.line("codex", "s3")
        release, entered = threading.Event(), threading.Event()

        def slow_pull(n):
            entered.set()
            release.wait(10)
            return dict(w.gh.prs[n])
        pending = {}
        with mock.patch.object(w.gh, "pull", side_effect=slow_pull), \
                mock.patch.object(w.sup, "_tick_line"), mock.patch.object(w.sup, "_parallel_maintenance"):
            with ThreadPoolExecutor(max_workers=8) as pool:
                try:
                    cursor, started = 0, _time.monotonic()
                    for _ in range(3):   # one full rotation: every key gets its turn
                        cursor = w.sup._parallel_cycle(pool, pending, cursor, 8)
                    self.assertTrue(entered.wait(5))            # the Recovery job is inside the slow GitHub read
                    self.assertLess(_time.monotonic() - started, 2)   # ... and the Coordinator was never held by it
                    self.assertIn(RECOVERY_KEY, pending)
                    self.assertIn(("codex", "s3"), pending)      # Line jobs were still submitted
                    recovery_job = pending[RECOVERY_KEY]
                    w.sup._parallel_cycle(pool, pending, cursor, 8)
                    self.assertIs(pending[RECOVERY_KEY], recovery_job)   # a slow turn only skips its own resubmission
                finally:
                    release.set()

    def test_a_recovery_exception_never_stops_a_line(self):
        w = self.w
        with mock.patch.object(w.sup.recovery, "step", side_effect=RuntimeError("bad")), \
                mock.patch.object(w.sup, "_tick_line") as line:
            w.start("single", "codex", "s2")
            w.tick()
        self.assertTrue(line.called)
        self.assertTrue(any("Recovery 예외" in e["msg"] for e in w.store.recent_events()))


class PrFacts(Base):
    def setUp(self):
        super().setUp()
        self.w.cfg["poll_seconds"] = 0
        self.b = make_batch(self.w, "s3", "codex", state="WAITING_REVIEW", pr_number=7, head_sha=HEAD1)
        self.w.pr_info(7, HEAD1, head_ref=self.b["branch"])

    def scan(self):
        self.w.now += 1
        self.step()

    def test_a_conflict_left_alone_across_two_scans_opens_a_case(self):
        self.w.gh.prs[7]["mergeable"] = False
        self.scan()
        self.assertEqual(self.w.store.open_recovery_cases(), [])   # first sight: the Supervisor's own path first
        self.scan()
        case = self.w.store.recovery_case_by_key(f"batch:{self.b['id']}")
        self.assertEqual((case["kind"], case["pr_number"]), ("pr", 7))

    def test_a_new_push_between_scans_is_not_a_failure(self):
        self.w.gh.checks = {HEAD1: "FAILURE", HEAD2: "FAILURE"}
        self.scan()
        self.w.gh.prs[7]["head_sha"] = HEAD2
        self.scan()
        self.assertEqual(self.w.store.open_recovery_cases(), [])

    def approve(self, minutes_ago=31, head=HEAD1):
        stamp = self.w.now - minutes_ago * 60
        from datetime import datetime, timezone
        self.w.gh.reviews_ = [{"id": 1, "body": f"+1\nHEAD: {head}", "state": "COMMENTED", "user": {"login": "genonfire"},
                               "submitted_at": datetime.fromtimestamp(stamp, timezone.utc).isoformat()}]

    def test_merge_stall_is_merged_deterministically_with_the_head_match(self):
        import time as _time
        self.w.now = _time.time()
        self.approve()
        self.w.gh.checks = {HEAD1: "SUCCESS"}
        self.w.gh.prs[7].update(mergeable=True, mergeable_state="clean")
        self.scan()
        self.assertEqual(self.w.gh.merged_squash, [(7, HEAD1)])
        self.assertEqual(self.w.adapter.launches, [])

    def test_no_merge_when_any_condition_is_missing(self):
        import time as _time
        self.w.now = _time.time()
        for setup in ({"checks": {HEAD1: "PENDING"}, "state": "clean", "ago": 31},
                      {"checks": {HEAD1: "SUCCESS"}, "state": "blocked", "ago": 31},
                      {"checks": {HEAD1: "SUCCESS"}, "state": "clean", "ago": 10}):
            self.approve(setup["ago"])
            self.w.gh.checks = setup["checks"]
            self.w.gh.prs[7].update(mergeable=True, mergeable_state=setup["state"])
            self.scan()
        self.assertEqual(getattr(self.w.gh, "merged_squash", []), [])

    def test_a_failed_merge_opens_a_case(self):
        import time as _time
        from warroom.github import GhError
        self.w.now = _time.time()
        self.approve()
        self.w.gh.checks = {HEAD1: "SUCCESS"}
        self.w.gh.prs[7].update(mergeable=True, mergeable_state="clean")
        self.w.gh.merge_error = GhError("head moved")
        self.scan()
        self.assertIn("머지 정체", json.loads(self.w.store.open_recovery_cases()[0]["blocking_unit"])["reason"])


class RestartSurvival(Base):
    def test_a_run_survives_the_restart_is_adopted_and_never_doubled(self):
        w = self.w
        error_batch(w)
        self.step()                              # Supervisor A launches
        self.assertEqual(len(w.adapter.launches), 1)
        run = self.open_runs()[0]
        # The run itself restarts the Supervisor (./kwar): A is gone, B starts on the same DB; the run lives on.
        b_sup = w.make_sup()
        self.assertNotEqual(b_sup.phase_instance, w.sup.phase_instance)
        import recovery_watch
        watch = recovery_watch.Watch(w.paths.repo_root, run=mock.Mock(side_effect=AssertionError("no kwar")))
        watch.db = w.paths.db
        for _ in range(3):
            self.step(b_sup)
            self.step()                          # even a leftover A step
            self.assertTrue(watch.supervisor_run_open() is False)   # not a supervisor case: the watchdog leaves it
        self.assertEqual(len(w.adapter.launches), 1)                # adopted, not relaunched
        self.assertEqual(len(self.open_runs()), 1)
        self.finish_last(report(), session="ses_rec")
        self.step(b_sup)                         # B collects the exit and sends the follow-up to the SAME session
        self.assertEqual(w.store.recovery_run(run["id"])["exit_status"], "0")
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        self.assertEqual(w.adapter.launches[-1]["session"], "ses_rec")
        self.assertEqual(len(self.open_runs()), 1)

    def test_a_crash_before_the_pid_record_is_recovered_from_the_wrapper_pid_file(self):
        w = self.w
        error_batch(w)
        self.step()
        run = self.open_runs()[0]
        with w.store._conn() as c:
            c.execute("UPDATE recovery_runs SET pid=NULL WHERE id=?", (run["id"],))
        self.step(w.make_sup())
        self.assertEqual(w.store.recovery_run(run["id"])["pid"], run["pid"])   # read back through read_pid
        self.assertEqual(len(w.adapter.launches), 1)

    def test_a_run_whose_process_vanished_without_an_exit_is_closed_as_lost(self):
        w = self.w
        error_batch(w)
        self.step()
        run = self.open_runs()[0]
        w.adapter.running.pop(run["pid"])
        self.step()
        self.assertEqual(w.store.recovery_run(run["id"])["exit_status"], "lost")

    def test_recovery_runs_never_hold_a_batch_or_the_restart_drain(self):
        w = self.w
        b = error_batch(w)
        self.step()
        self.assertFalse(w.sup._batch_has_open_work(w.store.batch(b["id"])))
        self.assertEqual(w.store.runs(b["id"]), [])

    def test_no_new_launch_while_stopping(self):
        w = self.w
        error_batch(w)
        with mock.patch.object(w.sup, "_stop_requested", return_value=True):
            self.step()
        self.assertEqual(w.adapter.launches, [])


class Judging(Base):
    def open_case(self):
        b = error_batch(self.w)
        self.step()
        return b, self.w.store.recovery_case_for_batch(b["id"])

    def test_exit_zero_or_a_resolved_claim_alone_is_not_resolved(self):
        w = self.w
        b, case = self.open_case()
        self.finish_last(report(status="RESOLVED", case=case["key"]))
        self.step()
        case = w.store.recovery_case(case["id"])
        self.assertNotEqual(case["state"], "RESOLVED")
        self.assertIn("RESOLVED 보고 반려", case["notes"])
        self.assertEqual(len(w.adapter.launches), 2)   # a follow-up, same session

    def test_resolved_needs_the_official_save_and_production_continuing(self):
        w = self.w
        b, case = self.open_case()
        w.store.update(b["id"], state="PRODUCING", error=None, progress_done=1)   # the failing task saved officially
        self.finish_last(report(status="RESOLVED", case=case["key"]))
        self.step()
        self.assertEqual(w.store.recovery_case(case["id"])["state"], "TRACKING")   # one save is not "continues" yet
        launches = len(w.adapter.launches)
        self.step()
        self.assertEqual(len(w.adapter.launches), launches)   # waiting for confirmation is not an AI turn
        w.store.update(b["id"], progress_done=2)            # the next task is saved: production continues
        self.step()
        self.assertEqual(w.store.recovery_case(case["id"])["state"], "RESOLVED")

    def test_a_retry_out_of_error_alone_is_not_progress(self):
        w = self.w
        b, case = self.open_case()
        w.store.update(b["id"], state="PRODUCING", error=None)   # Retry, nothing saved yet
        ok, why = w.sup.recovery.resolved(w.store.recovery_case(case["id"]))
        self.assertFalse(ok, why)

    def test_a_boundary_claim_must_match_the_record(self):
        w = self.w
        b, case = self.open_case()
        self.finish_last(report(status="BLOCKED", boundary="owner_control", case=case["key"]))
        self.step()
        case = w.store.recovery_case(case["id"])
        self.assertIn("BOUNDARY owner_control 주장이 공식 기록과 맞지 않아 반려", case["notes"])
        self.assertNotEqual(case["state"], "WAITING_OWNER")

    def test_owner_control_waits_and_is_released_only_by_that_record(self):
        w = self.w
        b, case = self.open_case()
        stop = "강제 중지됨. worktree·브랜치·PR은 보존됨 (프로세스 종료 확인 후 Retry로 재개)."
        w.store.update(b["id"], state="PAUSED", error=stop)   # the owner stops it meanwhile
        self.finish_last(report(status="BLOCKED", boundary="owner_control", case=case["key"]))
        self.step()
        case = w.store.recovery_case(case["id"])
        self.assertEqual(case["state"], "WAITING_OWNER")
        self.assertEqual(json.loads(case["wait_reason"])["kind"], "owner_control")
        launches = len(w.adapter.launches)
        self.step()
        self.assertEqual(len(w.adapter.launches), launches)   # an unrelated turn releases nothing
        w.store.update(b["id"], state="ERROR", error="again")   # the owner retried; it failed again
        self.step()
        self.assertEqual(len(w.adapter.launches), launches + 1)
        self.assertIn("오너 대기 해소", w.store.recovery_case(case["id"])["notes"])

    def test_blocked_without_a_boundary_is_rejected(self):
        w = self.w
        b, case = self.open_case()
        self.finish_last(report(status="BLOCKED", blocker="코드 수정 필요", case=case["key"]))
        self.step()
        self.assertIn("BOUNDARY 없는 BLOCKED 반려", w.store.recovery_case(case["id"])["notes"])

    def test_in_progress_with_a_pr_waits_without_ai_until_a_pr_fact_changes(self):
        w = self.w
        w.cfg["poll_seconds"] = 0
        b, case = self.open_case()
        w.pr_info(90, HEAD2, head_ref="fix-branch")
        self.finish_last(report(pr="#90", case=case["key"]))
        self.step()
        case = w.store.recovery_case(case["id"])
        self.assertEqual((case["state"], case["pr_number"]), ("TRACKING", 90))
        n = len(w.adapter.launches)
        w.now += 1
        self.step()
        self.assertEqual(len(w.adapter.launches), n)
        w.pr_info(90, HEAD2, state="closed", merged=True, head_ref="fix-branch", merge_sha="d" * 40)
        w.now += 1
        self.step()   # merged: the next step (apply, recover the task) is due
        self.assertEqual(len(w.adapter.launches), n + 1)

    def test_a_tracked_pr_is_not_queried_every_turn(self):
        w = self.w
        w.cfg["poll_seconds"] = 300
        b, case = self.open_case()
        w.pr_info(90, HEAD2, head_ref="fix-branch")
        self.finish_last(report(pr="90", case=case["key"]))
        with mock.patch.object(w.gh, "pull", wraps=w.gh.pull) as pull:
            for _ in range(10):
                w.now += 5
                self.step()
        self.assertLessEqual(pull.call_count, 2)

    def test_unchanged_evidence_turns_into_investigation_then_back_off_never_a_give_up(self):
        w = self.w
        b, case = self.open_case()
        self.finish_last(report(case=case["key"]))
        self.step()
        self.assertNotIn("근본 원인", w.adapter.launches[-1]["prompt"])   # changed evidence (a report): a follow-up
        self.finish_last(report(case=case["key"]))
        self.step()
        self.assertIn("근본 원인", w.adapter.launches[-1]["prompt"])      # same evidence: investigate, not "continue"
        self.finish_last(report(case=case["key"]))
        n = len(w.adapter.launches)
        self.step()
        case = w.store.recovery_case(case["id"])
        self.assertEqual(len(w.adapter.launches), n)                     # nothing resent
        self.assertIsNotNone(case["next_action_at"])
        first_wait = case["next_action_at"] - w.now
        self.assertEqual(first_wait, recovery.BACKOFF_MIN)
        w.now = case["next_action_at"] + 1
        self.step()                                                      # re-checked after the back-off
        self.assertEqual(len(w.adapter.launches), n + 1)
        case = w.store.recovery_case(case["id"])
        self.assertGreater(case["next_action_at"] - w.now, first_wait)  # a longer wait next time
        self.assertNotEqual(case["state"], "RESOLVED")
        w.store.update(b["id"], error="새 오류")                          # evidence changed: a normal follow-up again
        self.finish_last(report(case=case["key"]))
        w.now = case["next_action_at"] + 1
        self.step()
        self.assertNotIn("근본 원인", w.adapter.launches[-1]["prompt"])

    def test_a_usage_limit_of_the_run_waits_until_its_reset(self):
        w = self.w
        b, case = self.open_case()
        with mock.patch.object(w.sup, "_classify_run", return_value="usage_limit"):
            self.finish_last("You've hit your usage limit", code=1)
            self.step()
        case = w.store.recovery_case(case["id"])
        self.assertEqual(case["state"], "WAITING_OWNER")
        wait = json.loads(case["wait_reason"])
        self.assertEqual(wait["kind"], "limit")
        n = len(w.adapter.launches)
        self.step()
        self.assertEqual(len(w.adapter.launches), n)
        w.now = wait["until"] + 1
        self.step()
        self.assertEqual(len(w.adapter.launches), n + 1)

    def test_parse_report(self):
        r = parse_report("x\nSTATUS: BLOCKED\nCASE: batch:1\nDONE: a\n b\nBOUNDARY: denied\nPR: #12\n")
        self.assertEqual((r["STATUS"], r["DONE"], r["BOUNDARY"], r["PR"]), ("BLOCKED", "a b", "denied", 12))
        self.assertEqual(parse_report("no report"), {})
        self.assertEqual(parse_report("STATUS: RESOLVED | IN_PROGRESS")["STATUS"], "RESOLVED")


class SupervisorCase(Base):
    def test_resolved_only_on_a_new_instance_with_the_fix_loaded(self):
        w = self.w
        cid = w.store.open_recovery_case("supervisor", "supervisor",
                                         blocking_unit={"instance": w.sup.phase_instance, "merge_sha": "e" * 40,
                                                        "batches": {}})
        case = w.store.recovery_case(cid)
        self.assertFalse(w.sup.recovery.resolved(case)[0])               # same instance
        b_sup = w.make_sup()
        b_sup.code_sha = "f" * 40
        with mock.patch("warroom.restart_controller._ancestor", return_value=False):
            self.assertFalse(b_sup.recovery.resolved(case)[0])           # new instance, fix not loaded
        with mock.patch("warroom.restart_controller._ancestor", return_value=True):
            self.assertTrue(b_sup.recovery.resolved(case)[0])

    def test_a_blocked_code_reload_opens_the_supervisor_case_after_one_interval(self):
        w = self.w
        req = {"defect_id": 3, "merge_sha": "e" * 40, "blocker": "checkout has local changes", "state": "waiting"}
        with mock.patch("warroom.restart_controller.pending_requests", return_value=[req]):
            self.step()
            self.assertIsNone(w.store.recovery_case_by_key("supervisor"))
            w.now += 600
            self.step()
        case = w.store.recovery_case_by_key("supervisor")
        self.assertIn("checkout has local changes", json.loads(case["blocking_unit"])["reason"])


class Ownership(Base):
    def setUp(self):
        super().setUp()
        self.w.cfg["maintainer"] = "claude"

    def maintainer(self, state="PRODUCING", **fields):
        w = self.w
        w.store.ensure_maintenance(101)
        mb = make_batch(w, MAINTENANCE_METHOD, "claude", shard="maint", batch="101", state=state, **fields)
        w.store.update_maintenance(101, state="ACTIVE", batch_id=mb["id"])
        w.store.line("claude", MAINTENANCE_METHOD)   # a live batch always has its Line row (tick)
        src = make_batch(w, "s2", "codex", state="PAUSED", pause_reason="shared_defect", paused_from="PRODUCING")
        with w.store._conn() as c:
            did = c.execute("INSERT INTO defects(event_key,batch_id,source,defect_class,state,report,issue_number,"
                            "created_at,updated_at) VALUES('ev-1',?,'report','cls','LINKED','r',101,0,0)",
                            (src["id"],)).lastrowid
        w.store.update(src["id"], defect_id=did)
        return mb, w.store.batch(src["id"])

    def test_a_progressing_maintainer_owns_the_failure(self):
        w = self.w
        mb, src = self.maintainer()
        for _ in range(2):
            self.step()
            w.now += 1
        self.assertEqual(w.adapter.launches, [])
        self.assertIsNone(w.store.recovery_case_by_key("defect:101"))

    def test_a_stopped_maintainer_is_taken_over_through_the_official_stop_and_one_case_per_group(self):
        w = self.w
        mb, src = self.maintainer()
        w.store.update(mb["id"], pid=4242)   # its run looks alive but makes no progress
        for _ in range(STALL_CHECKS + 1):
            self.step()
            w.now += 600
        case = w.store.recovery_case_by_key("defect:101")
        self.assertIsNotNone(case)
        self.assertEqual(sorted(w.store.recovery_case_batch_ids(case["id"])), sorted([mb["id"], src["id"]]))
        self.assertIsNone(w.store.recovery_case_by_key(f"batch:{src['id']}"))
        ln = w.store.peek_line("claude", MAINTENANCE_METHOD)
        self.assertEqual(ln["force_stop"], 1)                       # control.stop_maintainer, nothing else
        self.assertEqual(w.adapter.launches, [])                    # never while the Maintainer still runs
        w.store.update(mb["id"], state="PAUSED", pid=None,
                       error="강제 중지됨. worktree·브랜치·PR은 보존됨 (프로세스 종료 확인 후 Retry로 재개).")
        self.step()
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertIn("took_over_maintainer", w.adapter.launches[0]["prompt"])
        self.assertEqual(w.store.recovery_case(case["id"])["state"], "OPEN")   # our own takeover is not an owner Stop


class Legacy(Base):
    def test_open_ledger_cases_are_taken_over_once_and_tracked_while_the_old_tmux_lives(self):
        w = self.w
        b = error_batch(w)
        desk = w.paths.supervisor_state / "recovery-desk"
        (desk / "sessions").mkdir(parents=True)
        (desk / "ledger.json").write_text(json.dumps({"cases": [
            {"key": f"batch:{b['id']}", "status": "OPEN", "notes": "old"},
            {"key": "batch:999", "status": "OPEN"},                 # gone: nothing to take over
            {"key": "batch:7", "status": "RESOLVED"}]}))
        (desk / "sessions" / f"batch-{b['id']}.id").write_text("legacy-session\n")
        w.adapter.name = "claude"
        with mock.patch.object(recovery.Recovery, "_tmux_alive", return_value=True):
            self.step()
            self.step()
        cases = w.store.open_recovery_cases()
        self.assertEqual([c["key"] for c in cases], [f"batch:{b['id']}"])
        self.assertEqual((cases[0]["state"], cases[0]["session_id"]), ("TRACKING", "legacy-session"))
        self.assertEqual(w.adapter.launches, [])
        with mock.patch.object(recovery.Recovery, "_tmux_alive", return_value=False):
            self.step()
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        self.assertEqual(w.adapter.launches[-1]["session"], "legacy-session")
        self.step()
        self.assertEqual(len(w.store.recovery_cases()), 1)             # imported once


class ConfigAndAdapter(unittest.TestCase):
    def cfg(self, **over):
        c = json.loads(json.dumps(config.DEFAULTS))
        c["producers"] = {"claude": {"adapter": "claude", "model": "claude-x", "effort": "high"},
                          "codex": {"adapter": "codex"}}
        c["model_profiles"] = {"sonnet": {"adapter": "claude", "model": "claude-sonnet-5-5", "effort": "medium"},
                               "terra": {"adapter": "codex", "model": "gpt-terra", "effort": "high",
                                         "permission_profile": "worktree"},
                               "bare": {"adapter": "codex", "model": "gpt-terra", "effort": "high"}}
        c["assignments"] = {"stage2": {"codex": "terra"}}
        c.update(over)
        return c

    def test_maintainer_and_recovery_take_a_producer_or_profile_id(self):
        c = self.cfg(maintainer="terra", recovery="claude")
        self.assertIsNone(config.config_problem(c))
        self.assertEqual(config.recovery_target(c)[0], "claude")
        self.assertEqual(config.run_spec(c, "claude", config.RECOVERY), RunSpec("claude-x", "high", ""))
        c = self.cfg(recovery="terra")
        self.assertEqual(config.recovery_target(c)[:2], ("codex", "terra"))
        self.assertIsNone(config.recovery_problem(c))
        self.assertEqual(config.run_spec(c, "codex", config.RECOVERY).permission_profile, "worktree")

    def test_codex_recovery_needs_a_permission_profile_and_limits_are_checked(self):
        self.assertIn("permission_profile", config.recovery_problem(self.cfg(recovery="bare")))
        self.assertIn("recovery_max_parallel", config.config_problem(self.cfg(recovery_max_parallel=3)))
        self.assertIn("recovery_stall_seconds", config.config_problem(self.cfg(recovery_stall_seconds=5)))
        self.assertIn("recovery", config.config_problem(self.cfg(recovery="nope")))

    def test_claude_permission_mode_is_optional_and_never_a_bypass(self):
        ad = ClaudeCodeAdapter("claude")
        seen = []
        ad._spawn = lambda cmd, *a, **k: seen.append(cmd)
        run = RunSpec("claude-sonnet-5-5", "medium")
        ad.start("p", "/tmp", {}, run, "t", "/tmp/l", "/tmp/e")
        ad.start("p", "/tmp", {}, run, "t", "/tmp/l", "/tmp/e", permission_mode="auto")
        ad.resume("s", "p", "/tmp", {}, run, "/tmp/l", "/tmp/e", permission_mode="auto")
        self.assertNotIn("--permission-mode", seen[0])
        self.assertEqual(seen[1][-2:], ["--permission-mode", "auto"])
        self.assertIn("--permission-mode", seen[2])
        with self.assertRaises(ValueError):
            ad.start("p", "/tmp", {}, run, "t", "/tmp/l", "/tmp/e", permission_mode="bypassPermissions")


class Card(Base):
    def test_card_states_and_text(self):
        w = self.w
        card = control.recovery_card(w.store, w.cfg)
        self.assertEqual(card["state"], "IDLE")
        self.assertIn("Recovery", views.recovery_card_text(card))
        b = error_batch(w)
        self.step()
        card = control.recovery_card(w.store, w.cfg)
        self.assertEqual((card["state"], card["key"], card["model"]), ("WORKING", f"batch:{b['id']}", "claude-sonnet"))
        text = views.recovery_card_text(card)
        self.assertEqual(len(text.splitlines()), views.CARD_LINES)
        failed = control.recovery_card(w.store, w.cfg, {"failed_key": "k", "evidence": {"kwar_exit": 1}})
        self.assertEqual(failed["state"], "ERROR")
        detail = control.recovery_detail(w.store)
        self.assertEqual(detail[0]["key"], f"batch:{b['id']}")

    def test_the_card_sits_directly_below_the_maintainer_card(self):
        try:
            from warroom import tui
        except ImportError:   # the suite's interpreter may lack Textual (no skips allowed): check the source instead
            import ast
            src = (Path(__file__).resolve().parents[1] / "warroom" / "tui.py").read_text("utf-8")
            cls = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.ClassDef) and n.name == "RecoveryCard")
            self.assertIn("ROW = MaintainerCard.ROW + 1", ast.get_source_segment(src, cls))
            self.assertIn("column == MAINTAINER_COLUMN and card.ROW == RecoveryCard.ROW", src)
            return
        self.assertEqual(tui.RecoveryCard.ROW, tui.MaintainerCard.ROW + 1)
        w = self.w
        error_batch(w)
        self.step()
        import asyncio

        async def board():
            with mock.patch.object(tui, "Paths", return_value=w.paths), \
                    mock.patch.object(tui, "load_config", return_value=w.cfg), \
                    mock.patch.object(tui, "ensure_supervisor", return_value=("running", None)), \
                    mock.patch.object(tui.WarRoom, "on_mount", lambda app: app.refresh_view()):
                app = tui.WarRoom()
                async with app.run_test(size=(200, 60)) as pilot:
                    await pilot.pause()
                    m = app.query_one("#card-maintainer")
                    r = app.query_one("#card-recovery")
                    return m.region, r.region, str(r.render())
        m, r, text = asyncio.run(board())
        self.assertEqual(r.x, m.x)                 # the same (Maintainer) column
        self.assertGreaterEqual(r.y, m.y + m.height)   # the cell directly below it
        self.assertIn("Recovery", text)
        self.assertIn("batch:", text)


if __name__ == "__main__":
    unittest.main()
