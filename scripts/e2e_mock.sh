#!/usr/bin/env bash
set -euo pipefail
cd /root/天枢
PORT=9200
cat > /tmp/ts-e2e.env <<EOF
TIANSHU_DEFAULT_PROVIDER=mock
TIANSHU_PROVIDERS=[{"name":"mock","base_url":"http://127.0.0.1:${PORT}/v1","api_key":"","model":"mock-model","timeout":30}]
EOF

.venv/bin/tianshu mockllm --host 127.0.0.1 --port "$PORT" >/tmp/mock_e2e.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT

for i in $(seq 1 20); do
  if curl -s -m 2 http://127.0.0.1:"$PORT"/v1/chat/completions \
      -X POST -H 'Content-Type: application/json' \
      -d '{"model":"m","messages":[{"role":"user","content":"hi"}]}' >/dev/null 2>&1; then
    echo "mock ready (attempt $i)"
    break
  fi
  sleep 0.5
done

TIANSHU_ENV=/tmp/ts-e2e.env timeout 90 .venv/bin/python - <<'PYEOF'
import asyncio
from tianshu.app import create_app

async def main():
    t = create_app(provider_name='mock', review_mode='auto_approve')
    plan = await t.ask('用三句话介绍你自己', use_orchestrator=True)
    print('=== 子任务 ===')
    for st in plan.subtasks:
        print(f'  [{st.worker}] {st.goal}')
        print(f'        -> {st.status}')
    print('=== 主Agent汇总 ===')
    print(plan.summary[:300])

asyncio.run(main())
PYEOF