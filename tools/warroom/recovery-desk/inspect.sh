#!/bin/sh
# 복구 점검반 점검 1회를 tmux에서 헤드리스 claude(Sonnet)로 실행한다. 이전 점검이 아직 돌고 있으면 건너뛴다.
# 결과: .git/typewriter-supervisor/recovery-desk/inspector.log (stream-json, 회차마다 이어 씀)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DESK="$ROOT/.git/typewriter-supervisor/recovery-desk"
MODEL="${RECOVERY_DESK_INSPECTOR_MODEL:-claude-sonnet-5-5}"
mkdir -p "$DESK/sessions" "$DESK/prompts"
[ -f "$DESK/ledger.json" ] || echo '{"cases": []}' > "$DESK/ledger.json"

# 일시정지는 파일 하나로 둔다($DESK/paused). --force(패널의 "지금 점검")만 일시정지를 무시한다.
if [ "${1:-}" != "--force" ] && [ -f "$DESK/paused" ]; then echo "skip: paused"; exit 0; fi
if tmux has-session -t '=recovery-inspector' 2>/dev/null; then echo "skip: inspector still running"; exit 0; fi
log="$DESK/inspector.log"
# 로그가 너무 커지지 않게 마지막 회차들만 남긴다.
[ -f "$log" ] && [ "$(wc -c < "$log")" -gt 20000000 ] && tail -c 5000000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"
printf '\n===== %s inspect =====\n' "$(date '+%F %T')" >> "$log"
tmux new-session -d -s recovery-inspector -c "$ROOT" \
  "claude -p --model '$MODEL' --permission-mode auto --output-format stream-json --verbose < '$ROOT/tools/warroom/recovery-desk/inspector.md' >> '$log' 2>&1; echo \"exit=\$?\" >> '$log'"
echo "started inspector"
