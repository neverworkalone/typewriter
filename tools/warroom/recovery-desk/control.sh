#!/bin/sh
# 복구 세션용 War Room Line Stop & Retry (오너 상시 허용: "Stop & Retry만이 해결법일 경우").
# 운영 메인 checkout 루트에서 실행한다 (guard.sh로 확인, 아니면 exit 3).
#   control.sh stop-retry <model> <method> <batch-id>
#     그 batch에 고정한 Stop → Supervisor가 처리할 때까지 대기 → 그 batch Retry. 공식 control.stop_batch / control.retry만 쓴다.
set -eu
ROOT="$(pwd -P)"
sh "$(dirname "$0")/guard.sh" "$ROOT" || exit 3
[ "${1:-}" = stop-retry ] && [ $# -eq 4 ] || { echo "usage: $0 stop-retry <model> <method> <batch-id>" >&2; exit 2; }
model="$2"; method="$3"; batch="$4"
case "$batch" in ''|*[!0-9]*) echo "batch-id must be a number" >&2; exit 2 ;; esac
TYPEWRITER_WARROOM_ROOT="$ROOT" PYTHONPATH="$ROOT/tools/warroom" "$ROOT/tools/warroom/.local/venv/bin/python" - "$model" "$method" "$batch" <<'PY'
import sys, time
from warroom.store import Store
from warroom import control
model, method, batch_id = sys.argv[1], sys.argv[2], int(sys.argv[3])
store = Store("tools/warroom/.local/warroom.db")
if not control.stop_batch(store, model, method, batch_id):   # 원자적 확인 + batch 고정 Stop. 거부되면 Line은 그대로다
    sys.exit(f"batch {batch_id} is not the unfinished {model}/{method} batch; nothing changed")
print(f"stop requested: {model}/{method} batch {batch_id}")
for _ in range(60):   # Supervisor가 Stop을 처리(force_stop 소비, 공통 결함이면 defect_hold 기록)할 때까지
    ln = next(l for l in store.lines() if l["model"] == model and l["method"] == method)
    if not ln["force_stop"]:
        break
    time.sleep(5)
else:
    sys.exit("Supervisor did not consume the Stop within 300s; Retry not sent")
for _ in range(12):   # _force_stop가 같은 tick에서 PAUSED·hold를 마칠 때까지 잠깐 더 기다린다
    if control.retry(store, model, method, batch_id):
        break
    time.sleep(5)
else:
    sys.exit(f"retry refused for batch {batch_id} (state/pid/task-run/defect lock); see events")
print(f"retry requested: batch {batch_id}")
PY
