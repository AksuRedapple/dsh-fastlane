#!/bin/bash
# M7 验收 + 回归（0=全绿）
set -u
cd "$(dirname "$0")/../.." || exit 1
echo "== 单测 =="; node --test tests/ >/tmp/m7-unit.log 2>&1 || { echo "单测失败"; tail -20 /tmp/m7-unit.log; exit 1; }
tail -6 /tmp/m7-unit.log | grep -E "pass|fail"
echo "== 线上回归 =="; node tools/verify.mjs >/tmp/m7-verify.log 2>&1 || { echo "回归失败"; tail -20 /tmp/m7-verify.log; exit 1; }
tail -2 /tmp/m7-verify.log
echo "== M7 判据 =="; node tools/tests/m7-rpc-cache.mjs || exit 1
