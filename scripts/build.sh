#!/bin/bash
# 构建 dsh-deepseek-web-login：tsdown 一次产出 host(lib/index.js) + client(lib/client.js)。
# 不需要 DSH_CHECKOUT —— 宿主包自包含（除 node: 内置与 electron 外全部打进 lib）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -x node_modules/.bin/tsdown ]; then
  node_modules/.bin/tsdown --config tsdown.config.ts
else
  echo "[build] local tsdown not found — fetching via npx (first build only)"
  npx --yes tsdown@^0.22.14 --config tsdown.config.ts
fi

echo "[build] done:"
ls -la lib/ 2>/dev/null
