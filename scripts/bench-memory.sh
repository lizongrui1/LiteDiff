#!/usr/bin/env bash
# Memory / latency benchmark driver for the dense-diff envelope (change 0003).
#
# Runs `crates/litediff-core/examples/mem_bench.rs` once per payload shape
# (`legacy` = pre-0003 `DiffResult` JSON, `compact` = 0003 `WireDiff` JSON) in
# release mode, and reports for each:
#
#   * payload size on disk
#   * diff() wall time (measured inside the example)
#   * peak process memory (`maxrss`) of the example binary itself
#
# The example is built first and then executed directly, so the captured
# `maxrss` belongs to the benchmark process rather than to `cargo`. The first
# positional argument is the repository root to measure: Point it at the
# baseline commit's worktree (`target/bench-baseline`) to measure before the
# change and at the main checkout to measure after it. This keeps "before" and
# "after" independent of whichever branch is currently checked out.
#
# A baseline worktree does not need this script (or the payload consumers) copied
# into it: pass its root as the argument and the scripts keep living here.
# The one file that must exist in the measured checkout is
# `crates/litediff-core/examples/mem_bench.rs`; copy it there before measuring
# the baseline (`cp crates/litediff-core/examples/mem_bench.rs \
#   target/bench-baseline/crates/litediff-core/examples/`).
#
# After the Rust table, `scripts/frontend-memory-bench.mjs` is invoked on the
# same payload files to report the renderer's retained JS heap (see that script
# for the methodology). Node's own output is part of this report.
#
# Usage:
#   bash scripts/bench-memory.sh [REPO_ROOT] [--lines N] [--out DIR]
#                                [--json-alloc grow|exact] [--reps N]
#
# Defaults: REPO_ROOT = this script's parent checkout, --lines 200000,
# --out <root>/target/bench-out, --json-alloc grow, --reps 1. With --reps > 1
# each mode is executed N times and the median is reported (process maxrss on a
# busy machine moves by a few MiB between runs; the median is what
# benchmarks.md records).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v cargo >/dev/null 2>&1 && [[ -x "${HOME}/.cargo/bin/cargo" ]]; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi

ROOT=""
LINES=200000
OUT=""
JSON_ALLOC="grow"
REPS=1

usage() {
  awk '
    /^# Usage:/ { printing = 1 }
    printing && /^#/ { sub(/^# ?/, ""); print; next }
    printing { exit }
  ' "${BASH_SOURCE[0]}"
}

while (( $# > 0 )); do
  case "$1" in
    --lines)
      LINES="${2:?--lines needs a value}"
      shift 2
      ;;
    --out)
      OUT="${2:?--out needs a value}"
      shift 2
      ;;
    --json-alloc)
      JSON_ALLOC="${2:?--json-alloc needs a value}"
      shift 2
      ;;
    --reps)
      REPS="${2:?--reps needs a value}"
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    -*)
      echo "bench-memory: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$ROOT" ]]; then
        echo "bench-memory: unexpected argument: $1" >&2
        exit 2
      fi
      ROOT="$1"
      shift
      ;;
  esac
done

if ! command -v cargo >/dev/null 2>&1; then
  echo "bench-memory: cargo not found (checked PATH and \$HOME/.cargo/bin)" >&2
  exit 1
fi
if [[ -z "$ROOT" ]]; then
  ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
ROOT="$(cd "$ROOT" && pwd)"

EXAMPLE="$ROOT/crates/litediff-core/examples/mem_bench.rs"
if [[ ! -f "$EXAMPLE" ]]; then
  echo "bench-memory: $EXAMPLE is missing." >&2
  echo "bench-memory: copy mem_bench.rs into the measured checkout before running the baseline." >&2
  exit 1
fi
if [[ -z "$OUT" ]]; then
  OUT="$ROOT/target/bench-out"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

TIME_BIN="/usr/bin/time"
if [[ ! -x "$TIME_BIN" ]]; then
  echo "bench-memory: /usr/bin/time is required to capture maxrss" >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin)
    TIME_FLAGS=(-l)
    RSS_PATTERN="maximum resident set size"
    RSS_MULTIPLIER=1
    ;;
  Linux)
    TIME_FLAGS=(-v)
    RSS_PATTERN="Maximum resident set size (kbytes)"
    RSS_MULTIPLIER=1024
    ;;
  *)
    echo "bench-memory: unsupported platform $(uname -s) for maxrss capture" >&2
    exit 1
    ;;
esac

# Print the median of the numeric arguments (one decimal place).
median() {
  if (( $# == 0 )); then
    echo "0"
    return
  fi
  printf '%s\n' "$@" | sort -n | awk '
    { values[NR] = $1 }
    END {
      if (NR % 2 == 1) {
        printf "%.1f", values[(NR + 1) / 2]
      } else {
        printf "%.1f", (values[NR / 2] + values[NR / 2 + 1]) / 2
      }
    }'
}

COMMIT="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
# A dedicated target dir keeps baseline and after runs (and other agents' builds
# in the same checkout) from sharing a cargo lock or stale binaries.
export CARGO_TARGET_DIR="$ROOT/target/bench-target"
BIN="$CARGO_TARGET_DIR/release/examples/mem_bench"

echo "==> building mem_bench (release)"
echo "    root:   $ROOT"
echo "    commit: $COMMIT"
(
  cd "$ROOT"
  cargo build --release -p litediff-core --example mem_bench
)
if [[ ! -x "$BIN" ]]; then
  echo "bench-memory: expected binary at $BIN after build" >&2
  exit 1
fi

declare -a MODES=()
declare -a JSON_BYTES=()
declare -a DIFF_MS=()
declare -a MAXRSS_MB=()

for MODE in legacy compact; do
  echo "==> running mem_bench --mode $MODE --lines $LINES (reps: $REPS)"
  REP_JSON=()
  REP_DIFF=()
  REP_RSS=()
  for ((REP = 1; REP <= REPS; REP++)); do
    STDOUT_LOG="$OUT/stdout-$MODE.log"
    TIME_LOG="$OUT/time-$MODE-$REP.log"
    "$TIME_BIN" "${TIME_FLAGS[@]}" \
      "$BIN" --lines "$LINES" --mode "$MODE" --out "$OUT" --json-alloc "$JSON_ALLOC" \
      >"$STDOUT_LOG" 2>"$TIME_LOG"
    cat "$STDOUT_LOG"

    JSON_BYTES_VALUE="$(sed -n 's/.*json_bytes=\([0-9][0-9]*\).*/\1/p' "$STDOUT_LOG" | tail -n 1)"
    DIFF_MS_VALUE="$(sed -n 's/.*diff_ms=\([0-9.][0-9.]*\).*/\1/p' "$STDOUT_LOG" | tail -n 1)"
    RSS_VALUE="$(awk -v pattern="$RSS_PATTERN" 'index($0, pattern) { print $1; exit }' "$TIME_LOG")"
    if [[ -z "$JSON_BYTES_VALUE" || -z "$DIFF_MS_VALUE" || -z "$RSS_VALUE" ]]; then
      echo "bench-memory: could not parse results for mode $MODE (rep $REP)" >&2
      echo "--- stdout ---" >&2
      cat "$STDOUT_LOG" >&2
      echo "--- time ---" >&2
      cat "$TIME_LOG" >&2
      exit 1
    fi
    REP_JSON+=("$JSON_BYTES_VALUE")
    REP_DIFF+=("$DIFF_MS_VALUE")
    REP_RSS+=("$(awk -v bytes="$((RSS_VALUE * RSS_MULTIPLIER))" 'BEGIN { printf "%.1f", bytes / 1048576 }')")
  done

  MODES+=("$MODE")
  JSON_BYTES+=("$(median "${REP_JSON[@]}" | awk '{ printf "%.0f", $1 }')")
  DIFF_MS+=("$(median "${REP_DIFF[@]}")")
  MAXRSS_MB+=("$(median "${REP_RSS[@]}")")
done

printf '\n## Rust backend benchmark\n\n'
printf 'root: `%s` (commit `%s`), lines per side: %s, json alloc: %s, repetitions: %s (median)\n\n' "$ROOT" "$COMMIT" "$LINES" "$JSON_ALLOC" "$REPS"
printf '| mode | JSON bytes | JSON MiB | diff ms | maxrss MB |\n'
printf '|---|---:|---:|---:|---:|\n'
for index in "${!MODES[@]}"; do
  printf '| %s | %s | %s | %s | %s |\n' \
    "${MODES[$index]}" \
    "${JSON_BYTES[$index]}" \
    "$(awk -v bytes="${JSON_BYTES[$index]}" 'BEGIN { printf "%.2f", bytes / 1048576 }')" \
    "${DIFF_MS[$index]}" \
    "${MAXRSS_MB[$index]}"
done

NODE_BENCH="$SCRIPT_DIR/frontend-memory-bench.mjs"
if [[ -f "$OUT/diff-legacy.json" && -f "$OUT/diff-compact.json" ]]; then
  printf '\n## Renderer heap benchmark\n\n'
  if command -v node >/dev/null 2>&1 && [[ -f "$NODE_BENCH" ]]; then
    node --expose-gc "$NODE_BENCH" --dir "$OUT"
  else
    echo "node or frontend-memory-bench.mjs unavailable; skipping renderer heap benchmark"
  fi
fi
