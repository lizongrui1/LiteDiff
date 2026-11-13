/**
 * Compact, renderer-side diff table.
 *
 * ## Why the wire does not carry rows
 *
 * The backend produces a fully padded row grid (`AlignedRow` per line). Sending
 * that as JSON costs a per-row object with two empty highlight arrays, and a
 * 200,000-row comparison arrives as 200,000 JS objects — typically the single
 * largest allocation in the app after the document text itself.
 *
 * The grid is redundant: it is a deterministic projection of the hunks, using the
 * same pairing rule as `align::pair_block` (pair `min(del, ins)` lines as
 * `Modify`, then pad the longer side). `decodeDiff` rebuilds the grid into three
 * typed arrays — 9 bytes per row instead of an object graph — and the backend
 * only has to send changed UTF-16 ranges for the `Modify` rows that actually have
 * character-level highlights. This module is that decoder plus the accessors the
 * views use.
 *
 * The pairing rule is covered by tests on both sides of the IPC boundary
 * (`crates/litediff-app/src/wire.rs` and `app/tests/diffView.test.ts`); the hunk
 * ranges are the single source of truth for row order.
 */

import type { DiffStats, Hunk, RowKind, WireDiff } from "./types";

/** Row kind ordinals stored in `DiffTable.kind`. */
export const KIND_EQUAL = 0;
export const KIND_MODIFY = 1;
export const KIND_DELETE = 2;
export const KIND_INSERT = 3;

const KIND_NAMES: readonly RowKind[] = ["equal", "modify", "delete", "insert"];

/** Decoded, typed-array form of one comparison's diff. */
export interface DiffTable {
  /** Number of aligned rows (equal to the old `DiffResult.rows.length`). */
  readonly length: number;
  readonly hunks: readonly Hunk[];
  readonly stats: DiffStats;
  readonly approximate: boolean;
  /** Source line index per row, or `-1` for the padded side. */
  readonly left: Int32Array;
  readonly right: Int32Array;
  /** One of the `KIND_*` ordinals per row. */
  readonly kind: Uint8Array;
  /**
   * Changed spans for `Modify` rows, flat `(row, start, end)` triples in
   * UTF-16 code units within the logical line, ascending by row then start.
   */
  readonly changedLeft: Int32Array;
  readonly changedRight: Int32Array;
  /** Row kind of `row`, as the string the renderer styles against. */
  kindAt(row: number): RowKind;
}

const EMPTY_I32 = new Int32Array(0);
const EMPTY_U8 = new Uint8Array(0);
const EMPTY_STATS: DiffStats = { added: 0, deleted: 0, modified: 0, unchanged: 0 };

/** Shared empty table for the paste screen and for a missing session. */
export const EMPTY_DIFF: DiffTable = {
  length: 0,
  hunks: [],
  stats: EMPTY_STATS,
  approximate: false,
  left: EMPTY_I32,
  right: EMPTY_I32,
  kind: EMPTY_U8,
  changedLeft: EMPTY_I32,
  changedRight: EMPTY_I32,
  kindAt: () => "equal",
};

function toInt32(values: number[] | undefined): Int32Array {
  if (!values || values.length === 0) return EMPTY_I32;
  return Int32Array.from(values);
}

/**
 * Build the row grid from hunks, matching `crates/litediff-core/src/align.rs`.
 *
 * Every hunk is a maximal run of rows with the same equality state, and the two
 * kinds of run have a fixed shape:
 *
 * * `equal` — `row_len` identical rows, line numbers advancing together;
 * * change — `paired = min(left_len, right_len)` modify rows, then the surplus
 *   deleted lines padded on the right, then the surplus inserted lines padded on
 *   the left.
 *
 * Rows are emitted in hunk order, exactly as the aligner pushes them.
 */
export function decodeDiff(wire: WireDiff | null | undefined): DiffTable {
  if (!wire) return EMPTY_DIFF;
  const hunks = wire.hunks ?? [];

  let total = 0;
  for (const h of hunks) total += h.row_len;

  const left = new Int32Array(total);
  const right = new Int32Array(total);
  const kind = new Uint8Array(total);
  let row = 0;

  for (const h of hunks) {
    if (h.equal) {
      for (let i = 0; i < h.row_len; i++) {
        left[row] = h.left_start + i;
        right[row] = h.right_start + i;
        kind[row] = KIND_EQUAL;
        row++;
      }
      continue;
    }

    const paired = Math.min(h.left_len, h.right_len);
    for (let i = 0; i < paired; i++) {
      left[row] = h.left_start + i;
      right[row] = h.right_start + i;
      kind[row] = KIND_MODIFY;
      row++;
    }
    for (let i = paired; i < h.left_len; i++) {
      left[row] = h.left_start + i;
      right[row] = -1;
      kind[row] = KIND_DELETE;
      row++;
    }
    for (let i = paired; i < h.right_len; i++) {
      left[row] = -1;
      right[row] = h.right_start + i;
      kind[row] = KIND_INSERT;
      row++;
    }
  }

  return {
    length: row,
    hunks,
    stats: wire.stats ?? EMPTY_STATS,
    approximate: wire.approximate,
    left,
    right,
    kind,
    changedLeft: toInt32(wire.left_changed),
    changedRight: toInt32(wire.right_changed),
    kindAt(row: number): RowKind {
      return KIND_NAMES[this.kind[row]] ?? "equal";
    },
  };
}

/** Source line on one side of `row`, or `null` for the padded side. */
export function lineAt(table: DiffTable, row: number, side: "left" | "right"): number | null {
  const value = side === "left" ? table.left[row] : table.right[row];
  return value === undefined || value < 0 ? null : value;
}

/** One changed span, already clipped to the requested slice. */
export interface ChangedSpan {
  /** Offset within the requested slice (i.e. relative to `clipStart`). */
  start: number;
  end: number;
}

/**
 * Changed spans of one row, clipped to `[clipStart, clipEnd)` and made relative
 * to `clipStart`.
 *
 * Wrapped rendering hands the renderer a slice of the logical line; spans outside
 * it must not be painted on the wrong physical rows, so the same clipping rule is
 * applied here rather than in each component.
 */
export function changedSpansAt(
  table: DiffTable,
  side: "left" | "right",
  row: number,
  clipStart = 0,
  clipEnd = Number.POSITIVE_INFINITY,
): ChangedSpan[] {
  const triples = side === "left" ? table.changedLeft : table.changedRight;
  if (triples.length === 0) return [];

  // Binary search for the first triple whose row is >= `row`.
  const groups = triples.length / 3;
  let lo = 0;
  let hi = groups;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (triples[mid * 3] < row) lo = mid + 1;
    else hi = mid;
  }

  const out: ChangedSpan[] = [];
  for (let i = lo; i < groups && triples[i * 3] === row; i++) {
    const start = triples[i * 3 + 1];
    const end = triples[i * 3 + 2];
    const from = Math.max(start, clipStart);
    const to = Math.min(end, clipEnd);
    if (to > from) out.push({ start: from - clipStart, end: to - clipStart });
  }
  return out;
}
