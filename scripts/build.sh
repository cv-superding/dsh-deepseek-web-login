#!/bin/bash
# 兼容入口：真正的实现在 scripts/build.mjs（跨平台、不联网下载工具）。
# 保留这个文件名是为了老的调用习惯（文档/脚本里出现过 `bash scripts/build.sh`）。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/build.mjs
