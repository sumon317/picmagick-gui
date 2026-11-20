#!/usr/bin/env bash
# One-click launcher for Compakta on Linux.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")")" && pwd)"
cd -- "$SCRIPT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo
  echo "  bun is not installed or not on PATH."
  echo "  Install it from https://bun.sh"
  echo
  exit 1
fi

echo "Starting Compakta..."
exec bun run src/server.ts --open "$@"
