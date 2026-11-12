#!/bin/sh
# 운영 메인 checkout 경계 (fail-closed). 다음이 모두 참일 때만 exit 0이다.
#   1) <root>/.git 이 디렉터리다 (linked worktree는 .git이 파일이다)
#   2) Supervisor가 기록한 .git/typewriter-supervisor/runtime-root 가 이 루트와 같다
#   3) 운영 DB tools/warroom/.local/warroom.db 가 있다
# 다른 checkout·worktree에서는 아무것도 만들거나 실행하지 않고 exit 3으로 끝난다.
#   sh guard.sh [root]   (root 생략 시 이 파일 기준 저장소 루트)
ROOT="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"
ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P)" || { echo "recovery-desk: 루트 없음" >&2; exit 3; }
marker="$ROOT/.git/typewriter-supervisor/runtime-root"
if [ ! -d "$ROOT/.git" ] || [ ! -f "$marker" ] || [ ! -f "$ROOT/tools/warroom/.local/warroom.db" ]; then
  echo "recovery-desk: $ROOT 는 War Room 운영 메인 checkout이 아닙니다. 아무것도 하지 않습니다." >&2; exit 3
fi
recorded="$(cd "$(cat "$marker")" 2>/dev/null && pwd -P)"
[ "$recorded" = "$ROOT" ] || { echo "recovery-desk: runtime-root($recorded)가 $ROOT 와 다릅니다. 아무것도 하지 않습니다." >&2; exit 3; }
exit 0
