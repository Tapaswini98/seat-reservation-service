#!/usr/bin/env bash
# One-command on-sale stampede against a running service.
#
#   ./burst.sh                               # localhost, mixed scenario, 20k requests
#   ./burst.sh https://your-service.app      # against the deployed URL
#   ./burst.sh <URL> --scenario=hot-seat --requests=5000 --concurrency=300
#
set -euo pipefail
cd "$(dirname "$0")"

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
if [ $# -gt 0 ]; then shift; fi

if [ ! -d node_modules ]; then
  echo "installing dependencies..."
  npm ci
fi

exec npx ts-node --transpile-only scripts/burst.ts "$BASE_URL" "$@"
