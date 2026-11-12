#!/bin/sh
# 복구 점검반의 Sonnet 복구 세션 실행기 (헤드리스 claude CLI).
#   session.sh start  <case-key> <prompt-file>   새 세션을 tmux에서 시작 (case당 하나, 이미 있으면 거부)
#   session.sh send   <case-key> <prompt-file>   같은 세션에 후속 지시 (실행 중이면 거부)
#   session.sh status <case-key>                 running | idle | none  + session id, 로그 경로
#   session.sh archive <case-key>                해결된 case의 세션 기록을 sessions/archive/로 옮긴다 (삭제하지 않음)
# 상태: .git/typewriter-supervisor/recovery-desk/sessions/<key>.{id,log}
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/.git/typewriter-supervisor/recovery-desk/sessions"
MODEL="${RECOVERY_DESK_MODEL:-claude-sonnet-5-5}"
mkdir -p "$DIR"

cmd="${1:-}"; key="${2:-}"
[ -n "$cmd" ] && [ -n "$key" ] || { echo "usage: $0 start|send|status <case-key> [prompt-file]" >&2; exit 2; }
slug="$(printf '%s' "$key" | tr -c 'A-Za-z0-9_-' '-')"
tmx="recovery-$slug"; idf="$DIR/$slug.id"; log="$DIR/$slug.log"

running() { tmux has-session -t "=$tmx" 2>/dev/null; }

launch() {   # $1 = claude session flag (--session-id|--resume), $2 = prompt file
  pf="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
  [ -s "$pf" ] || { echo "prompt file missing or empty: $2" >&2; exit 2; }
  sid="$(cat "$idf")"
  printf '\n===== %s %s =====\n' "$(date '+%F %T')" "$1" >> "$log"
  tmux new-session -d -s "$tmx" -c "$ROOT" \
    "claude -p --model '$MODEL' $1 '$sid' --permission-mode auto --output-format stream-json --verbose < '$pf' >> '$log' 2>&1; echo \"exit=\$?\" >> '$log'"
}

case "$cmd" in
  start)
    [ -f "$idf" ] && { echo "case $key already has session $(cat "$idf"); use send" >&2; exit 1; }
    uuidgen | tr 'A-Z' 'a-z' > "$idf"
    launch --session-id "${3:?prompt-file}"
    echo "started $key session=$(cat "$idf") log=$log" ;;
  send)
    [ -f "$idf" ] || { echo "case $key has no session; use start" >&2; exit 1; }
    running && { echo "case $key session is still running" >&2; exit 1; }
    launch --resume "${3:?prompt-file}"
    echo "resumed $key session=$(cat "$idf") log=$log" ;;
  archive)
    [ -f "$idf" ] || { echo "case $key has no session" >&2; exit 1; }
    running && { echo "case $key session is still running" >&2; exit 1; }
    mkdir -p "$DIR/archive"; stamp="$(date +%Y%m%d-%H%M%S)"
    mv "$idf" "$DIR/archive/$slug-$stamp.id"; [ -f "$log" ] && mv "$log" "$DIR/archive/$slug-$stamp.log"
    echo "archived $key -> $DIR/archive/$slug-$stamp.{id,log}" ;;
  status)
    if [ ! -f "$idf" ]; then echo none; elif running; then echo "running session=$(cat "$idf") log=$log"
    else echo "idle session=$(cat "$idf") log=$log"; fi ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
