#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  if [[ -x "${HOME}/.cargo/bin/cargo" ]]; then
    export PATH="${HOME}/.cargo/bin:${PATH}"
  fi
fi

missing=()
command -v cargo >/dev/null 2>&1 || missing+=("cargo")
command -v npm >/dev/null 2>&1 || missing+=("npm")

if (( ${#missing[@]} > 0 )); then
  printf 'Missing required tool(s): %s\n' "${missing[*]}" >&2
  exit 2
fi

if [[ ! -d app/node_modules ]]; then
  printf 'Frontend dependencies are missing. Run: cd app && npm ci\n' >&2
  exit 2
fi

step() {
  printf '\n==> %s\n' "$1"
}

step "cargo fmt"
cargo fmt --all -- --check

step "cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

step "cargo test"
cargo test --workspace

step "frontend tests"
(
  cd app
  npm test
)

step "frontend type check"
(
  cd app
  npm run check
)

step "frontend production build"
(
  cd app
  npm run build
)

printf '\nAll LiteDiff quality gates passed.\n'
