#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

exec node server/index.js
