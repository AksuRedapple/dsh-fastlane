#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if rg -n --hidden -g '!.git/**' -g '!node_modules/**' \
  '/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/' .; then
  echo "fail: personal absolute path found" >&2
  exit 1
fi

if rg -n --hidden -g '!.git/**' -g '!node_modules/**' \
  '(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' .; then
  echo "fail: credential-shaped content found" >&2
  exit 1
fi

echo "public audit: clean"
