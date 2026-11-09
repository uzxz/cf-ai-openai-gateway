#!/usr/bin/env bash
# 本地/线上端到端冒烟测试。凭据全部从环境变量读取，脚本内不含凭据字面量。
# 用法：
#   GATEWAY_URL=http://127.0.0.1:8787 GATEWAY_KEY=你的key ./scripts/smoke.sh
set -u

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
GATEWAY_KEY="${GATEWAY_KEY:-}"
if [ -z "$GATEWAY_KEY" ]; then
  echo "ERROR: 请通过环境变量 GATEWAY_KEY 提供网关密钥" >&2
  exit 1
fi

pass=0; fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name (HTTP $actual)"; pass=$((pass+1))
  else
    echo "  FAIL  $name: expected $expected, got $actual"; fail=$((fail+1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== 基础端点 =="
check "/health" 200 "$(code "${GATEWAY_URL}/health")"
check "/v1/models" 200 "$(code "${GATEWAY_URL}/v1/models")"
check "无鉴权" 401 "$(code -X POST "${GATEWAY_URL}/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"gpt-4o-mini","messages":[]}')"
check "错误 key" 401 "$(code -X POST "${GATEWAY_URL}/v1/chat/completions" -H 'Authorization: Bearer wrong-key' -H 'Content-Type: application/json' -d '{"model":"gpt-4o-mini","messages":[]}')"
check "/v1/responses 应为 404" 404 "$(code -X POST "${GATEWAY_URL}/v1/responses" -H "Authorization: Bearer ${GATEWAY_KEY}" -H 'Content-Type: application/json' -d '{"input":"x"}')"
check "不支持的模型" 400 "$(code -X POST "${GATEWAY_URL}/v1/chat/completions" -H "Authorization: Bearer ${GATEWAY_KEY}" -H 'Content-Type: application/json' -d '{"model":"claude-3","messages":[]}')"

echo "== 真实推理（会消耗 Workers AI 额度） =="
resp=$(curl -s --max-time 90 -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_KEY}" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: pong"}]}')
if printf '%s' "$resp" | grep -q '"content":"pong"'; then
  echo "  PASS  gpt-4o-mini -> pong"; pass=$((pass+1))
else
  echo "  FAIL  gpt-4o-mini: $resp"; fail=$((fail+1))
fi

sse=$(curl -s --max-time 90 -N -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_KEY}" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","max_tokens":20,"stream":true,"messages":[{"role":"user","content":"say pong"}]}')
if printf '%s' "$sse" | grep -q 'chat.completion.chunk'; then
  echo "  PASS  SSE 流式"; pass=$((pass+1))
else
  echo "  FAIL  SSE: $sse"; fail=$((fail+1))
fi

echo
echo "结果: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
