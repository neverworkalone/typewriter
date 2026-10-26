"""Paths and operator configuration. Everything mutable lives under .local/."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .adapters import RunSpec

WARROOM_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = WARROOM_DIR.parents[1]

DEFAULTS = {
    "repo": "neverworkalone/typewriter",
    "base_branch": "master",
    "expected_account": "neverworkalone-agent",
    "git_name": "",
    "git_email": "",
    # Legacy single-worker config; used to synthesise the registry when `producers` is empty.
    "worker": {"adapter": "opencode", "method": "a", "producer": "deepseek"},
    # Model registry: logical model id (= Candidate filename producer suffix) ->
    # {"label", "adapter", "models": {"free", "go"}}. No count limit.
    "producers": {},
    # Issue #1867: reusable run settings (adapter/model/effort/permission_profile) and which one each stage uses.
    # `assignments.stage1|stage2` map a logical producer ID to a profile ID; `maintainer` may also be a profile ID.
    "model_profiles": {},
    "assignments": {},
    "methods": ["a", "b", "c", "d"],
    # Issue #1555: the logical producer ID (a key of `producers`) that runs the hidden Maintainer; None = disabled.
    "maintainer": None,
    # Extra argv lists run in a paused batch worktree after a shared fix was merged into it (all must pass).
    "shared_defect_verify": [],
    "opencode_bin": "opencode",
    "claude_bin": "claude",
    "codex_bin": "codex",
    "models": {"free": "", "go": ""},
    "free_model_pattern": "-free$",
    "quota_patterns": [
        "FreeUsageLimit",
        "free (usage|tier|quota).{0,40}(exhaust|exceed|limit)",
    ],
    "trusted_reviewers": ["genonfire"],
    "poll_seconds": 300,
    "pr_head_lag_timeout_seconds": 1800,
    "rate_limit_retries": 3,
    "rate_limit_backoff_seconds": 120,
}


@dataclass
class Paths:
    repo_root: Path = REPO_ROOT
    local: Path = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.local is None:
            self.local = self.repo_root / "tools" / "warroom" / ".local"

    @property
    def db(self) -> Path:
        return self.local / "warroom.db"

    @property
    def gh_config(self) -> Path:
        return self.local / "gh"

    @property
    def worktrees(self) -> Path:
        return self.local / "worktrees"

    @property
    def logs(self) -> Path:
        return self.local / "logs"

    @property
    def lock(self) -> Path:
        return self.local / "supervisor.lock"

    @property
    def config_file(self) -> Path:
        return self.local / "config.json"

    def ensure(self) -> None:
        for d in (self.local, self.gh_config, self.worktrees, self.logs):
            d.mkdir(parents=True, exist_ok=True)


def load_config(paths: Paths) -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    if paths.config_file.exists():
        user = json.loads(paths.config_file.read_text("utf-8"))
        if not isinstance(user, dict):
            raise ValueError("config.json의 최상위 값은 JSON 객체여야 합니다.")
        for key, value in user.items():
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(value)
            else:
                cfg[key] = value
    return cfg


_PRODUCER_ID = re.compile(r"^[a-z0-9-]+$")


KNOWN_LABELS = {"deepseek": "DeepSeek"}   # display names for producer ids that have no configured `label`


def registry(cfg: dict) -> dict[str, dict]:
    """Logical model id -> {label, adapter, model, effort, models}. Legacy `worker`/`models` is one entry.

    `model` is the single pinned model of a CLI without free/go tiers (Claude, Codex); `models` holds the
    OpenCode tiers. `effort` is the reasoning level passed explicitly on every run.
    """
    prods = cfg.get("producers") or {}
    if not prods:
        w = cfg["worker"]
        prods = {w["producer"]: {"adapter": w.get("adapter", "opencode"), "models": cfg.get("models", {})}}
    out = {}
    profs = _profiles(cfg)
    for pid, p in prods.items():
        adapter = p.get("adapter", "opencode")
        prof = profs.get(_assigned(cfg, STAGE1, pid) or _assigned(cfg, STAGE2, pid) or "")
        if prof:   # a governed producer has no pin of its own (config_problem): board/settings show its first assigned profile
            p = {**p, "model": prof["model"], "effort": prof["effort"], "permission_profile": prof["permission_profile"]}
        out[pid] = {"label": p.get("label") or KNOWN_LABELS.get(pid, pid), "adapter": adapter,
                    "model": p.get("model") or "",
                    "effort": p["effort"] if "effort" in p else LEGACY_EFFORT.get(adapter, ""),
                    "permission_profile": p.get("permission_profile") or "",
                    "models": {"free": "", "go": "", **(p.get("models") or {})}}
    return out


STAGE1, STAGE2, MAINTAINER = "stage1", "stage2", "maintainer"
ASSIGNMENT_ROLES = (STAGE1, STAGE2)   # `assignments` keys; the Maintainer is the single top-level `maintainer`


def role_of(method: str) -> str:
    """The assignment role of a batch's method: Stage 2 (`s2`), the Maintainer (`m`), else a Stage 1 Method (a-d)."""
    return {"s2": STAGE2, "m": MAINTAINER}.get(method, STAGE1)


def _profiles(cfg: dict) -> dict[str, dict]:
    """Profile ID -> {adapter, model, effort, permission_profile} (every field a string; unset = '')."""
    raw = cfg.get("model_profiles")
    raw = raw if isinstance(raw, dict) else {}
    return {pid: {k: (p.get(k) if isinstance(p, dict) and isinstance(p.get(k), str) else "")
                  for k in ("adapter", "model", "effort", "permission_profile")} for pid, p in raw.items()}


def _assigned(cfg: dict, role: str, producer: str) -> str | None:
    a = cfg.get("assignments")
    r = a.get(role) if isinstance(a, dict) else None
    return r.get(producer) if isinstance(r, dict) else None


def _assigned_profiles(cfg: dict, producer: str) -> list[str]:
    return [p for p in (_assigned(cfg, r, producer) for r in ASSIGNMENT_ROLES) if p]


def maintainer_target(cfg: dict) -> tuple[str | None, str | None, str | None]:
    """(producer, profile, problem) of the configured Maintainer. `maintainer` is a legacy producer ID or a profile ID.

    A profile ID runs on the one producer of its adapter; several producers of that adapter are narrowed to those
    assigned that profile; anything still ambiguous is an error (never guessed from the adapter name).
    """
    m = cfg.get("maintainer")
    if m is None:
        return None, None, "maintainer가 설정되지 않았습니다"
    reg, profs = registry(cfg), _profiles(cfg)
    if m in reg and m in profs:
        return None, None, f"maintainer {m!r}가 모델 ID와 프로필 ID 양쪽에 있어 모호합니다 — 이름을 구분하세요."
    if m in reg:
        if _assigned_profiles(cfg, m):
            return None, None, f"maintainer {m!r}는 프로필로 배정된 모델 ID입니다 — 프로필 ID(model_profiles)를 지정하세요."
        return m, None, None
    if m in profs:
        cands = [pid for pid, p in reg.items() if p["adapter"] == profs[m]["adapter"]]
        if len(cands) > 1:
            cands = [pid for pid in cands if m in _assigned_profiles(cfg, pid)]
        if len(cands) != 1:
            return None, None, (f"maintainer 프로필 {m!r}를 실행할 모델 ID를 하나로 정할 수 없습니다 "
                                f"(adapter {profs[m]['adapter']!r}: {', '.join(cands) or '해당 모델 없음'}) — "
                                f"assignments에 이 프로필을 배정해 모델 ID를 지정하세요.")
        return cands[0], m, None
    return None, None, f"maintainer {m!r}는 등록된 모델 ID도 프로필 ID도 아닙니다 (모델: {', '.join(reg) or '없음'}; 프로필: {', '.join(profs) or '없음'})"


def role_entry(cfg: dict, producer: str, role: str) -> dict:
    """The registry entry of `producer` with the pin (model/effort/permission_profile) its `role` runs on.

    Stage 1/2: the assigned profile, else the producer's own pin. Maintainer: the configured profile when `maintainer`
    names one (it must resolve to this producer), else the producer's own pin. Raises ValueError on a mismatch.
    """
    p = dict(registry(cfg)[producer])
    if role == MAINTAINER:
        m = cfg.get("maintainer")
        if m not in _profiles(cfg):
            return p
        target, _, problem = maintainer_target(cfg)
        if problem or target != producer:
            raise ValueError(f"{producer}: maintainer 프로필 {m!r}는 이 모델 ID로 실행할 수 없습니다 ({problem or target})")
        pid = m
    else:
        pid = _assigned(cfg, role, producer)
        if not pid and _assigned_profiles(cfg, producer):   # governed: another stage's profile is never borrowed
            raise ValueError(f"{producer}: {role} 단계에 배정된 프로필이 없습니다 (assignments.{role}).")
        if not pid:
            return p
    prof = _profiles(cfg).get(pid)
    if prof is None or prof["adapter"] != p["adapter"]:
        raise ValueError(f"{producer}: {role} 프로필 {pid!r}가 없거나 adapter가 모델과 다릅니다.")
    return {**p, **{k: prof[k] for k in ("model", "effort", "permission_profile")}}


def role_problem(cfg: dict, producer: str, role: str) -> str | None:
    """Why `producer` must not run `role` (None = its resolved pin is valid). Fail closed before Start."""
    try:
        return _producer_problem(producer, role_entry(cfg, producer, role))
    except ValueError as e:
        return str(e)


def _endpoints(cfg: dict, pid: str, p: dict) -> list[str]:
    """Every concrete model ID a logical model runs on (a duplicate endpoint is a duplicate model)."""
    eps = [ep for ep in p["models"].values() if ep]
    if p["adapter"] not in TIERED_ADAPTERS:
        eps += [m for m in [p["model"]] + [_profiles(cfg).get(x, {}).get("model") for x in _assigned_profiles(cfg, pid)] if m]
    return list(dict.fromkeys(eps))


def _producer_problem(pid: str, p: dict) -> str | None:
    if not _PRODUCER_ID.match(pid):
        return f"모델 ID {pid!r}는 [a-z0-9-]만 허용됩니다."
    if p["adapter"] not in ADAPTER_LABELS:
        return f"알 수 없는 adapter {p['adapter']!r} (허용: {', '.join(ADAPTER_LABELS)})."
    if p["adapter"] not in TIERED_ADAPTERS:
        if not p["model"]:
            return "모델 ID가 설정되지 않았습니다 — CLI 기본 모델에 맡기지 않고 `model`을 명시해야 합니다."
        if not _MODEL_ID.match(p["model"]):
            return f"모델 ID {p['model']!r}는 허용되지 않는 형식입니다 (플래그처럼 보이거나 공백이 있음)."
    profile = p["permission_profile"]
    if profile and p["adapter"] != "codex":
        return f"permission_profile은 Codex 모델에만 지정할 수 있습니다 (adapter: {p['adapter']})."
    if profile and not _PROFILE_ID.match(profile):
        return f"permission_profile {profile!r}는 허용되지 않는 형식입니다 ([A-Za-z0-9_-]만 허용)."
    return effort_problem(p["adapter"], p["effort"])


def registry_problems(cfg: dict) -> dict[str, str]:
    """producer id -> reason it must not run (bad id, unknown adapter, unpinned model or effort, duplicate)."""
    reg, bad, seen = registry(cfg), {}, {}
    for pid, p in reg.items():
        problem = _producer_problem(pid, p)
        if problem:
            bad.setdefault(pid, problem)
        if pid.lower() in seen and seen[pid.lower()] != pid:
            bad[pid] = f"모델 ID {pid!r}가 {seen[pid.lower()]!r}와 중복 등록되었습니다."
        seen.setdefault(pid.lower(), pid)
    endpoints: dict[str, str] = {}
    for pid, p in reg.items():
        for ep in _endpoints(cfg, pid, p):
            if endpoints.setdefault(ep, pid) != pid:
                bad[pid] = f"엔드포인트 {ep!r}가 {endpoints[ep]!r}와 중복 — 같은 논리 모델의 중복 등록입니다."
                bad.setdefault(endpoints[ep], bad[pid])
    return bad


# Wired once at Supervisor start (CLI binaries, GitHub client, git identity): a reload cannot change them.
RESTART_KEYS = ("repo", "opencode_bin", "claude_bin", "codex_bin", "git_name", "git_email")


def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"),)


def _strings(v, *, patterns=False, nonempty=False) -> bool:
    if not isinstance(v, list) or (nonempty and not v):
        return False
    for x in v:
        if not isinstance(x, str) or (nonempty and not x.strip()):
            return False
        if patterns:
            try:
                re.compile(x)
            except re.error:
                return False
    return True


def _entry_problems(name: str, p: dict, fields: tuple[str, ...]) -> list[str]:
    """Type problems of one producer-like entry: its scalar fields and its `models` tiers must be strings."""
    bad = [f"{name}.{k}는 문자열이어야 합니다" for k in fields if k in p and not isinstance(p[k], str)]
    m = p.get("models")
    if m is not None and not isinstance(m, dict):
        bad.append(f"{name}.models는 객체여야 합니다")
    elif isinstance(m, dict):
        bad += [f"{name}.models.{k}는 문자열이어야 합니다" for k, v in m.items() if not isinstance(v, str)]
    return bad


def config_problem(cfg: dict) -> str | None:
    """Why a loaded config cannot run (None = every value has the type its consumers need). Shared by start and reload.

    Each runtime consumer compares or iterates these values (poll_seconds/retries/backoff in the Supervisor loop,
    patterns in failure classification, ...): a wrongly typed one would raise inside a tick, not at load time.
    """
    bad = []
    for key in ("poll_seconds", "rate_limit_backoff_seconds", "pr_head_lag_timeout_seconds"):
        if not _number(cfg.get(key)) or cfg[key] < 0:
            bad.append(f"{key}는 0 이상의 숫자여야 합니다")
    r = cfg.get("rate_limit_retries")
    if not isinstance(r, int) or isinstance(r, bool) or r < 0:
        bad.append("rate_limit_retries는 0 이상의 정수여야 합니다")
    for key in ("repo", "base_branch", "expected_account", "opencode_bin", "claude_bin", "codex_bin"):
        if not isinstance(cfg.get(key), str) or not cfg[key].strip():
            bad.append(f"{key}는 비어 있지 않은 문자열이어야 합니다")
    for key in ("git_name", "git_email", "free_model_pattern"):
        if not isinstance(cfg.get(key), str):
            bad.append(f"{key}는 문자열이어야 합니다")
    if isinstance(cfg.get("free_model_pattern"), str):
        try:
            re.compile(cfg["free_model_pattern"])
        except re.error:
            bad.append("free_model_pattern이 올바른 정규식이 아닙니다")
    if not _strings(cfg.get("quota_patterns"), patterns=True):
        bad.append("quota_patterns는 정규식 문자열 목록이어야 합니다")
    if not _strings(cfg.get("trusted_reviewers")):
        bad.append("trusted_reviewers는 문자열 목록이어야 합니다")
    if not _strings(cfg.get("methods"), nonempty=True):
        bad.append("methods는 비어 있지 않은 문자열 목록이어야 합니다")
    elif {m.lower() for m in cfg["methods"]} & RESERVED_METHODS:   # Stage 2 / Maintainer are not Stage 1 Methods
        bad.append(f"methods에 예약된 이름 {sorted({m.lower() for m in cfg['methods']} & RESERVED_METHODS)}을 쓸 수 없습니다")
    if not isinstance(cfg.get("producers"), dict) or not all(isinstance(p, dict) for p in cfg["producers"].values()):
        bad.append("producers는 {모델 ID: 객체} 형태여야 합니다")
    for key in ("models", "worker"):
        if not isinstance(cfg.get(key), dict):
            bad.append(f"{key}는 객체여야 합니다")
    if isinstance(cfg.get("models"), dict):   # legacy tiers: values are model IDs
        bad += [f"models.{k}는 문자열이어야 합니다" for k, v in cfg["models"].items() if not isinstance(v, str)]
    if isinstance(cfg.get("worker"), dict):
        bad += _entry_problems("worker", cfg["worker"], ("adapter", "producer"))
    if isinstance(cfg.get("producers"), dict):
        for pid, p in cfg["producers"].items():
            if isinstance(p, dict):
                bad += _entry_problems(f"producers.{pid}", p, ("label", "adapter", "model", "effort", "permission_profile"))
    bad += _maintainer_config_problems(cfg)
    if not bad:
        bad += _profile_config_problems(cfg)
    if not bad and cfg.get("maintainer") is not None:   # an unknown/ambiguous Maintainer never falls back to a guess
        bad += [p] if (p := maintainer_target(cfg)[2]) else []
    return "; ".join(bad) or None


def _profile_config_problems(cfg: dict) -> list[str]:
    """`model_profiles`/`assignments` are well-formed and agree with `producers`; a legacy pin and an assignment never mix."""
    profiles, assign, bad = cfg.get("model_profiles"), cfg.get("assignments"), []
    if not isinstance(profiles, dict) or not all(isinstance(p, dict) for p in profiles.values()):
        return ["model_profiles는 {프로필 ID: 객체} 형태여야 합니다"]
    if not isinstance(assign, dict) or not all(isinstance(v, dict) for v in assign.values()):
        return ["assignments는 {stage1|stage2: {모델 ID: 프로필 ID}} 형태여야 합니다"]
    for pid, p in profiles.items():
        bad += _entry_problems(f"model_profiles.{pid}", p, ("adapter", "model", "effort", "permission_profile"))
    if bad:
        return bad
    for pid, p in _profiles(cfg).items():
        if p["adapter"] in TIERED_ADAPTERS:
            bad.append(f"model_profiles.{pid}: {adapter_label(p['adapter'])}의 Free/Go 모델은 producers.models로 설정합니다")
        elif why := _producer_problem(pid, {**p, "models": {}}):
            bad.append(f"model_profiles.{pid}: {why}")
    for role, by_producer in assign.items():
        if role not in ASSIGNMENT_ROLES:
            bad.append(f"assignments.{role}: 알 수 없는 단계입니다 (허용: {', '.join(ASSIGNMENT_ROLES)})")
            continue
        for producer, pid in by_producer.items():
            prod = cfg["producers"].get(producer)
            if prod is None:
                bad.append(f"assignments.{role}.{producer}: 등록되지 않은 모델 ID입니다")
            elif not isinstance(pid, str) or pid not in profiles:
                bad.append(f"assignments.{role}.{producer}: 프로필 {pid!r}가 없습니다")
            elif profiles[pid].get("adapter") != prod.get("adapter", "opencode"):
                bad.append(f"assignments.{role}.{producer}: 프로필 {pid!r}의 adapter가 모델 ID의 adapter와 다릅니다")
            elif any(k in prod for k in ("model", "effort", "permission_profile")):
                bad.append(f"producers.{producer}: model/effort/permission_profile과 assignments를 함께 쓸 수 없습니다 — 프로필로만 지정하세요")
    return list(dict.fromkeys(bad))


def _maintainer_config_problems(cfg: dict) -> list[str]:
    """`maintainer` is absent (disabled) or the ID of a registered producer; anything else fails closed, never falls back."""
    bad = []
    m = cfg.get("maintainer")
    if m is not None:
        if not isinstance(m, str):
            bad.append("maintainer는 producers의 모델 ID 또는 model_profiles의 프로필 ID 문자열이어야 합니다")
    v = cfg.get("shared_defect_verify")
    if not isinstance(v, list) or not all(_strings(a, nonempty=True) for a in v):
        bad.append("shared_defect_verify는 비어 있지 않은 문자열 argv 목록의 목록이어야 합니다")
    return bad


def maintainer_id(cfg: dict) -> str | None:
    """The producer ID the Maintainer runs on (None: not configured). Call only on a config that passed config_problem;
    an unresolvable value is returned as written and refused by maintainer_problem."""
    return maintainer_target(cfg)[0] or cfg.get("maintainer")


def maintainer_problem(cfg: dict) -> str | None:
    """Why the configured Maintainer must not run (None = it may). Its producer and resolved pin must be valid."""
    producer, _, problem = maintainer_target(cfg)
    if problem:
        return problem
    return registry_problems(cfg).get(producer) or role_problem(cfg, producer, MAINTAINER)


def reload_problem(old: dict, new: dict, in_use: set[str]) -> str | None:
    """Why `new` must not replace the running `old` config (None = safe). `in_use` = producers of unfinished batches.

    Fail-closed: any registry problem, a changed start-time-only key, or a producer that still owns an
    unfinished batch disappearing rejects the whole reload; nothing is partially applied.
    """
    problem = config_problem(new)
    if problem:
        return f"설정 값 오류: {problem}"
    try:
        reg, bad = registry(new), registry_problems(new)
        methods(new)
    except Exception as e:   # a wrongly typed section (producers: [], ...) is a config error, not a crash
        return f"설정 구조 오류: {type(e).__name__}: {e}"
    if bad:
        return "; ".join(f"{pid}: {why}" for pid, why in bad.items())
    changed = [k for k in RESTART_KEYS if old.get(k) != new.get(k)]
    if changed:
        return f"{', '.join(changed)} 변경은 Supervisor 재시작이 필요합니다 (리로드로 적용 불가)."
    gone = sorted(in_use - set(reg))
    if gone:
        return f"미완료 배치가 있는 모델 {', '.join(gone)}를 설정에서 제거할 수 없습니다."
    old_reg = registry(old)
    swapped = sorted(pid for pid in in_use if pid in old_reg and old_reg[pid]["adapter"] != reg[pid]["adapter"])
    if swapped:   # the running process and its log belong to the old CLI: another adapter would misread them
        return f"미완료 배치가 있는 모델 {', '.join(swapped)}의 adapter를 바꿀 수 없습니다 (배치 완료 후 변경)."
    return None


def methods(cfg: dict) -> list[str]:
    return [m.lower() for m in cfg.get("methods") or ["a", "b", "c", "d"]]


RESERVED_METHODS = {"m", "s2"}   # the hidden Maintainer's and Stage 2's execution methods (never a Stage 1 Method)
STAGE2_ADAPTERS = ("claude", "codex")   # Issue #1684: Stage 2 runs on Claude or Codex only, never DeepSeek/OpenCode


def stage2_problem(cfg: dict, model: str) -> str | None:
    """Why `model` must not run Stage 2 (None = it may). Fail closed on the server side, not just in the UI."""
    reg = registry(cfg)
    if model not in reg:
        return f"등록되지 않은 모델 {model!r}"
    if reg[model]["adapter"] not in STAGE2_ADAPTERS:
        return (f"Stage 2는 Claude 또는 Codex에서만 실행할 수 있습니다 "
                f"({reg[model]['label']}: {adapter_label(reg[model]['adapter'])})")
    return None


def stage2_models(cfg: dict) -> list[str]:
    """Registered models that may run Stage 2, in board order."""
    reg = registry(cfg)
    return [pid for pid in ordered_models(cfg) if reg[pid]["adapter"] in STAGE2_ADAPTERS]


ADAPTER_LABELS = {"claude": "Claude", "codex": "Codex", "opencode": "OpenCode"}   # display names only
TIERED_ADAPTERS = ("opencode",)   # the only CLI with a Free and a Go model per logical model
# Reasoning effort each CLI accepts. Claude: its `--effort` choices; Codex: the values the API reports for
# gpt-6-luna (rejected with "Supported values are ..." otherwise). OpenCode variants are model-specific:
# only their format is checked here, and the OpenCode adapter proves each model+variant at Start (preflight).
ADAPTER_EFFORTS = {
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": ("none", "low", "medium", "high", "xhigh", "max"),
    "opencode": None,
}
# A DeepSeek entry without `effort` (configs written before #1373) runs at the owner-fixed `high`, passed explicitly.
LEGACY_EFFORT = {"opencode": "high"}
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]*$")   # never a flag ("-x") and never whitespace
_EFFORT_ID = re.compile(r"^[a-z0-9-]+$")
_PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")   # a TOML bare key: never a flag, whitespace, `=` or a path


def adapter_label(adapter: str) -> str:
    return ADAPTER_LABELS.get(adapter, adapter)


def effort_problem(adapter: str, effort: str) -> str | None:
    """Why `effort` cannot be passed to `adapter` (None = acceptable). An unset effort is never accepted."""
    if not effort:
        return "추론 수준(effort)이 설정되지 않았습니다 — CLI 기본값에 맡기지 않고 명시해야 합니다."
    allowed = ADAPTER_EFFORTS.get(adapter)
    if allowed is None:
        return None if _EFFORT_ID.match(effort) else f"추론 수준 {effort!r}의 형식이 올바르지 않습니다."
    if effort not in allowed:
        return f"{adapter_label(adapter)}는 추론 수준 {effort!r}를 지원하지 않습니다 (허용: {', '.join(allowed)})."
    return None


def run_spec(cfg: dict, producer: str, tier: str = "free", role: str = STAGE1) -> RunSpec:
    """The exact model and effort one run of `producer` in `role` is pinned to. Raises ValueError if either is unset.

    Tiered (OpenCode): the model of `tier`; a Go switch changes only the model, never the effort.
    Single-model CLIs: their one `model`; `tier` is ignored (they have no Free/Go tiers).
    """
    p = role_entry(cfg, producer, role)
    model = p["models"].get(tier, "") if p["adapter"] in TIERED_ADAPTERS else p["model"]
    if not model:
        raise ValueError(f"{producer}: {tier if p['adapter'] in TIERED_ADAPTERS else 'model'} 모델 ID가 설정되지 않았습니다.")
    problem = effort_problem(p["adapter"], p["effort"])
    if problem:
        raise ValueError(f"{producer}: {problem}")
    return RunSpec(model=model, effort=p["effort"], permission_profile=p["permission_profile"])


def pin_summary(p: dict) -> str:
    """What one logical model runs on: its CLI model ID(s) and the pinned reasoning effort."""
    effort = p["effort"] or "(미설정)"
    if p["adapter"] in TIERED_ADAPTERS:
        return f"free={p['models']['free'] or '(미설정)'}  go={p['models']['go'] or '(미설정)'}  effort={effort}"
    profile = f"  permission_profile={p['permission_profile']}" if p["permission_profile"] else ""
    return f"model={p['model'] or '(미설정)'}  effort={effort}{profile}"


def ordered_models(cfg: dict) -> list[str]:
    """Registered logical models in board order: adapter label, then model label, then id.

    Independent of `producers` registration order, so Claude -> Codex -> OpenCode always holds.
    """
    reg = registry(cfg)
    return sorted(reg, key=lambda pid: (adapter_label(reg[pid]["adapter"]), reg[pid]["label"], pid))


def adapters(cfg: dict) -> list[str]:
    """Adapters that have at least one registered logical model, ordered by display label (Claude, Codex, OpenCode)."""
    found = {p["adapter"] for p in registry(cfg).values()}
    return sorted(found, key=lambda a: (adapter_label(a), a))


def role_pin_lines(cfg: dict) -> list[str]:
    """Settings lines for what each stage runs on (profile ID, model, effort); only when profiles are configured."""
    profs, lines = _profiles(cfg), []
    def one(label, pid):
        p = profs.get(pid, {})
        return f"  {label}: {pid} (model={p.get('model') or '(미설정)'} effort={p.get('effort') or '(미설정)'})"
    for role in ASSIGNMENT_ROLES:
        for producer, pid in sorted((cfg.get("assignments", {}).get(role) or {}).items()):
            lines.append(one(f"{role}/{producer}", pid))
    if cfg.get("maintainer") in profs:
        lines.append(one("maintainer", cfg["maintainer"]))
    return lines
