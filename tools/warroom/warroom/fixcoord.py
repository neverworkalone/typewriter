"""Review FIXING Coordinator (#6555): the Supervisor applies a review-fix judgment that the AI only submits.

The fix session writes one response file — the review event keys it judged, an amend input for its Stage's official
CLI (or null for a rebuttal), and its reply. The coordinator then owns every side effect, each step re-entrant:

    response check → official amend → commit of exactly the amended files → exact-HEAD verify → push → one reply
    → the Stage's own completion gate → WAITING_REVIEW

It knows nothing about Relation data. A Stage plugs in its amend command, its allowed files, its exact-commit verify
and its completion gate; everything else (baseline, bounded retry of a refused judgment, crash recovery, the
at-most-once reply) is shared. Stage 3 is the first user; the refinement Stages after it reuse the same coordinator.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .github import GhError, GhTransient
from .gitops import GitError, GitTransient

TRANSIENT = (GhTransient, GitTransient)


@dataclass(frozen=True)
class FixSpec:
    prefix: str            # kv keys and the reply marker: `<prefix>_fix_start_<batch>`, `<!-- warroom-<prefix>-fix <nonce> -->`
    label: str             # "Stage 3"
    response: str          # worktree-relative response file the AI writes
    amend_input: str       # worktree-relative file the Supervisor writes the amend text to
    commit_subject: str
    amend_header: str      # the first line of a valid amend text
    attempts: int = 2      # returns of a refused judgment to the same session before the batch stops
    reply_wait_seconds: int = 600   # a possibly posted reply is awaited, never posted again; then ERROR


@dataclass(frozen=True)
class FixStage:
    """What a Stage plugs into the coordinator."""
    allowed: Callable[[dict], set]                       # batch -> worktree-relative files an amend may change
    amend: Callable[[dict, dict, Path, str], dict]       # (batch, baseline, worktree, input) -> receipt with `outputs`
    rejected: type                                       # the amend's "input refused" GitError subclass
    verify_exact: Callable[[dict, str], tuple]           # (batch, head) -> (ok, tail) on that exact commit
    completion: Callable[[dict, dict, str | None], str | None]   # (batch, PR info, verified head) -> problem


def _sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


class ReviewFixCoordinator:
    def __init__(self, sup, spec: FixSpec, stage: FixStage):
        self.sup, self.spec, self.stage = sup, spec, stage

    def _key(self, name: str, b) -> str:
        return f"{self.spec.prefix}_fix_{name}_{b['id']}"

    # --- baseline ---------------------------------------------------------------------------------------------------
    def begin(self, b, events, *, head: str, base: str, **extra) -> dict:
        """Record a fresh fix round before its AI run starts; any earlier round's submission is discarded."""
        baseline = {"supervised": True, "branch": b["branch"], "worktree": str(b["worktree"]), "head": head,
                    "base": base, "event_head": b["head_sha"], "event_keys": [e["key"] for e in events],
                    "events": [{k: e.get(k) for k in ("kind", "author", "path", "line", "key", "body")} for e in events],
                    "nonce": uuid.uuid4().hex, **extra}
        self.sup.store.set(self._key("start", b), json.dumps(baseline, sort_keys=True))
        self.sup.store.delete(self._key("apply_attempts", b))
        for rel in (self.spec.response, self.spec.amend_input):
            (Path(b["worktree"]) / rel).unlink(missing_ok=True)
        return baseline

    def baseline(self, b) -> dict | None:
        try:
            baseline = json.loads(self.sup.store.get(self._key("start", b)) or "")
        except (TypeError, ValueError):
            return None
        if not isinstance(baseline, dict) or baseline.get("supervised") is not True \
                or baseline.get("branch") != b["branch"] or baseline.get("worktree") != str(b["worktree"]) \
                or not isinstance(baseline.get("event_keys"), list) or not isinstance(baseline.get("events"), list) \
                or not isinstance(baseline.get("nonce"), str) or not isinstance(baseline.get("event_head"), str) \
                or not isinstance(baseline.get("head"), str) or not isinstance(baseline.get("base"), str):
            return None
        return baseline

    def finish(self, b) -> None:
        self.sup.store.delete(self._key("start", b))

    # --- the AI's submission ----------------------------------------------------------------------------------------
    def response(self, b, baseline) -> tuple[dict | None, str | None]:
        rel = self.spec.response
        try:
            data = json.loads((Path(b["worktree"]) / rel).read_text("utf-8"))
        except FileNotFoundError:
            return None, f"{rel} was not written"
        except (OSError, ValueError) as e:
            return None, f"{rel} is not valid JSON: {e}"
        if not isinstance(data, dict) or set(data) != {"event_keys", "amend", "reply"}:
            return None, f"{rel} must be one object with exactly event_keys, amend and reply"
        keys = data["event_keys"]
        if not isinstance(keys, list) or len(set(map(str, keys))) != len(keys) or set(keys) != set(baseline["event_keys"]):
            return None, f"event_keys must list exactly this run's review event keys {sorted(baseline['event_keys'])}"
        amend = data["amend"]
        if amend is not None and (not isinstance(amend, str)
                                  or amend.lstrip().split("\n", 1)[0].strip() != self.spec.amend_header):
            return None, f"amend must be null or the complete amend input text whose first line is `{self.spec.amend_header}`"
        if not isinstance(data["reply"], str) or not data["reply"].strip():
            return None, "reply must be the non-empty PR reply text"
        return data, None

    def retry(self, b, baseline, problem: str) -> None:
        """Return an unusable judgment or a refused amend to the same fix session, a bounded number of times."""
        sup, key = self.sup, self._key("apply_attempts", b)
        try:
            attempts = int(sup.store.get(key) or 0)
        except ValueError:
            attempts = self.spec.attempts
        if attempts >= self.spec.attempts or not b["session_id"]:
            return sup._fail(b, "ERROR", f"{self.spec.label} 리뷰 수정 판정을 적용하지 못했습니다: {problem}. "
                             "worktree·PR·세션을 보존합니다.")
        sup.store.set(key, str(attempts + 1))
        (Path(b["worktree"]) / self.spec.response).unlink(missing_ok=True)
        sup.store.log(b["id"], f"{self.spec.label} 리뷰 수정 판정 적용 거부 ({attempts + 1}/{self.spec.attempts}): {problem} "
                      "— 같은 세션에 사유를 전달합니다", "warn")
        return sup._launch(sup.store.batch(b["id"]), "fix_resume", baseline["events"], s2_fix_note=problem)

    # --- the reply --------------------------------------------------------------------------------------------------
    def _marker(self, baseline) -> str:
        return f"<!-- warroom-{self.spec.prefix}-fix {baseline['nonce']} -->"

    def reply_lines(self, baseline, head: str) -> list[str]:
        """The reply's binding: every review event it answers, the PR HEAD it answers with and this round's nonce."""
        return ([f"WarRoom-Review-Event: {key}" for key in baseline["event_keys"]]
                + [f"WarRoom-Fix-Head: {head}", self._marker(baseline)])

    def reply_id(self, b, baseline, head: str) -> int | None:
        """This round's reply on GitHub: posted by our account, carrying its nonce, every event key and `head`."""
        login = str(self.sup.cfg["expected_account"]).casefold()
        wanted, marker = set(self.reply_lines(baseline, head)), self._marker(baseline)
        for comment in self.sup.gh.issue_comments(b["pr_number"]):
            body = str(comment.get("body") or "")
            if marker not in body:
                continue
            lines = {line.strip() for line in body.splitlines()}
            user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
            if str(user.get("login") or "").casefold() != login or not wanted <= lines \
                    or not isinstance(comment.get("id"), int):
                raise GitError(f"이번 리뷰 수정 답글(nonce {baseline['nonce'][:8]})이 계정·이벤트·HEAD 결속과 다릅니다")
            return comment["id"]
        return None

    def post_reply(self, b, baseline, response, head: str) -> int:
        """Post the AI's reply at most once per round and return its comment id; a re-entry finds its own post."""
        sup = self.sup
        reply_id = self.reply_id(b, baseline, head)
        if reply_id is not None:
            return reply_id
        posted_key = self._key("reply_posted", b)
        try:
            posted = json.loads(sup.store.get(posted_key) or "")
        except (TypeError, ValueError):
            posted = None
        if not (isinstance(posted, dict) and posted.get("nonce") == baseline["nonce"]):
            reply = response["reply"].strip()
            missing = "".join(f"[{event}] " for event in response["event_keys"] if f"[{event}]" not in reply)
            # Recorded before the call and never cleared by a failure: a `gh` exit cannot prove the post did not
            # happen, so a round posts at most once and afterwards only looks for its own post.
            posted = {"nonce": baseline["nonce"], "at": sup.clock()}
            sup.store.set(posted_key, json.dumps(posted))
            try:
                sup.gh.comment_issue(b["pr_number"], "\n".join([f"{missing}{reply}", ""] + self.reply_lines(baseline, head)))
            except (GhError, GhTransient) as e:
                raise GhTransient(f"{self.spec.label} 리뷰 수정 답글 게시 결과를 확정할 수 없습니다({e}); 게시 여부를 다시 조회합니다") from e
            reply_id = self.reply_id(b, baseline, head)
        if reply_id is None:
            if sup.clock() - float(posted.get("at") or 0) < self.spec.reply_wait_seconds:
                raise GhTransient(f"게시한 {self.spec.label} 리뷰 수정 답글이 아직 PR 댓글 목록에 없습니다")
            raise GitError(f"{self.spec.label} 리뷰 수정 답글 게시를 시도했지만 {self.spec.reply_wait_seconds}s 동안 PR 댓글에서 "
                           f"확인하지 못했습니다. 중복을 피하려고 다시 게시하지 않습니다. PR #{b['pr_number']}에 "
                           f"`{self._marker(baseline)}` 댓글이 있는지 확인하세요; 리뷰 이벤트는 미완료로 보존합니다")
        return reply_id

    # --- application ------------------------------------------------------------------------------------------------
    def _state(self, wt: Path, allowed: set) -> tuple:
        """Everything an amend can write: the changed tracked files and the allowed files, with their contents."""
        rels = sorted(set(self.sup.git.changed_paths(wt)) | allowed)
        return tuple((rel, _sha256(wt / rel)) for rel in rels)

    def apply(self, b, baseline) -> bool:
        """Apply the submitted judgment. False when the run wrote no response at all (the Stage's existing handling of
        a silent fix decides); True when this call decided the outcome."""
        if not (Path(b["worktree"]) / self.spec.response).exists():
            return False
        self._apply(b, baseline)
        return True

    def _apply(self, b, baseline) -> None:
        sup, spec, stage = self.sup, self.spec, self.stage
        wt, timings, label = Path(b["worktree"]), {}, self.spec.label
        base_head, allowed = baseline["head"], stage.allowed(b)
        verified = None

        def timed(name, call, *args):
            started = sup.clock()
            try:
                return call(*args)
            finally:
                timings[name] = round((sup.clock() - started) * 1000)

        try:
            head = sup.git.head(wt)
            if head == base_head:
                dirty = set(sup.git.changed_paths(wt))
                response, problem = self.response(b, baseline)
                if problem:
                    if dirty:
                        return sup._fail(b, "ERROR", f"worktree 변경 {sorted(dirty)}이 있는데 제출 판정을 쓸 수 없습니다: "
                                         f"{problem}. 보존합니다.")
                    return self.retry(b, baseline, problem)
                text = response["amend"]
                text = None if text is None else text if text.endswith("\n") else text + "\n"
                input_path = wt / spec.amend_input
                # Changes are resumable only as this submission's own interrupted amend: allowed files, with its exact
                # input still in place. Anything else is preserved untouched.
                if dirty and (text is None or not dirty <= allowed or not input_path.is_file()
                              or input_path.read_text("utf-8") != text):
                    return sup._fail(b, "ERROR", f"{label} 리뷰 수정 제출과 연결되지 않은 worktree 변경이 있습니다: "
                                     f"{sorted(dirty)}. 적용하지 않고 보존합니다.")
                if text is not None:
                    if not dirty:
                        input_path.parent.mkdir(parents=True, exist_ok=True)
                        input_path.write_text(text, "utf-8")
                    before = self._state(wt, allowed)
                    try:
                        receipt = timed("amend", stage.amend, b, baseline, wt, spec.amend_input)
                    except TRANSIENT:
                        raise
                    except GitError as e:
                        if dirty:   # this input was already accepted once: a failed replay is not a new judgment
                            return sup._fail(b, "ERROR", f"중단된 공식 amend를 같은 입력으로 복구하지 못했습니다: {e}. "
                                             "입력·판정·worktree를 보존합니다.")
                        if isinstance(e, stage.rejected) and self._state(wt, allowed) == before:
                            return self.retry(b, baseline, f"the official amend refused the submitted input: {e}")
                        # An operational failure: the judgment stands. Run the same input once more, then stop.
                        try:
                            receipt = timed("amend_recovery", stage.amend, b, baseline, wt, spec.amend_input)
                        except TRANSIENT:
                            raise
                        except GitError as again:
                            return sup._fail(b, "ERROR", f"공식 amend 실행이 판정과 무관하게 실패했고 같은 입력의 재시도도 "
                                             f"실패했습니다: {again}. 입력·판정·worktree를 보존합니다.")
                    changed = set(sup.git.changed_paths(wt))
                    outputs = receipt["outputs"]
                    if not changed <= allowed or any(_sha256(wt / rel) != outputs.get(rel) for rel in changed):
                        return sup._fail(b, "ERROR", f"공식 amend 결과와 다른 파일 변경이 있습니다: {sorted(changed)}. 보존합니다.")
                    if changed:
                        timed("commit", sup.git.commit_paths, wt, sorted(changed), spec.commit_subject)
            else:
                # Re-entry after this application's own commit: a clean direct child of the baseline with our subject.
                if sup.git.dirty(wt).strip() or sup.git.commit_parent(wt) != base_head \
                        or sup.git.commit_subject(wt) != spec.commit_subject:
                    return sup._fail(b, "ERROR", f"{label} 리뷰 수정 적용을 재개할 수 없는 worktree 상태입니다 "
                                     f"(HEAD {head[:10]}, 기준 {base_head[:10]}). 보존합니다.")
                response, problem = self.response(b, baseline)
                if problem:
                    return sup._fail(b, "ERROR", f"{label} 리뷰 수정 재개에 제출 판정이 없습니다: {problem}. 보존합니다.")
            head = sup.git.head(wt)
            if head != base_head:
                ok, tail = timed("exact_verify", stage.verify_exact, b, head)
                if not ok:
                    return sup._fail(b, "ERROR", f"{label} 리뷰 수정 commit의 정확한 HEAD verify 실패: {tail}. "
                                     "push하지 않고 보존합니다.")
                verified = head
                remote = sup.git.remote_head(b["branch"])
                if remote == base_head:
                    timed("push", sup.git.push_owned_fix, wt, b["branch"], remote, head)
                elif remote != head:
                    return sup._fail(b, "ERROR", f"원격 소유 브랜치가 리뷰 수정 기준에서 이동했습니다 ({remote} / {base_head}). 보존합니다.")
            timed("reply", self.post_reply, b, baseline, response, head)
            info = sup.gh.pull(b["pr_number"])
        except TRANSIENT:
            raise
        except GitError as e:
            return sup._fail(b, "ERROR", f"{label} 리뷰 수정 적용 실패: {e}. worktree·PR을 보존합니다.")
        if sup._check_fix_head(b, info) != "ok":
            return
        if problem := timed("completion", stage.completion, b, info, verified):
            return sup._fail(b, "ERROR", problem)
        self.finish(b)
        sup.store.log(b["id"], f"{label} 리뷰 수정 적용 " + " ".join(f"{k}={v}ms" for k, v in timings.items())
                      + (" verify=reused" if verified else ""))
        sup._to_review(b, info)
