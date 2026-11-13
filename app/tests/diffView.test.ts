/**
 * Tests for the compact-diff decoder.
 *
 * The decoder rebuilds the row grid from hunks. If it disagrees with the Rust
 * aligner by one row, every gutter number below the divergence is wrong — the
 * kind of defect a type check cannot catch, so the pairing rule is pinned here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  changedSpansAt,
  decodeDiff,
  EMPTY_DIFF,
  KIND_DELETE,
  KIND_EQUAL,
  KIND_INSERT,
  KIND_MODIFY,
  lineAt,
} from "../src/lib/diffView.ts";
import type { Hunk, WireDiff } from "../src/lib/types.ts";

function wire(over: Partial<WireDiff> = {}): WireDiff {
  return {
    left_line_count: 0,
    right_line_count: 0,
    hunks: [],
    stats: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
    approximate: false,
    left_changed: [],
    right_changed: [],
    ...over,
  };
}

function hunk(over: Partial<Hunk> = {}): Hunk {
  return {
    equal: false,
    left_start: 0,
    left_len: 0,
    right_start: 0,
    right_len: 0,
    row_start: 0,
    row_len: 0,
    ...over,
  };
}

// --- row grid derivation ----------------------------------------------------

test("an equal hunk derives one equal row per line", () => {
  const table = decodeDiff(
    wire({ hunks: [hunk({ equal: true, left_start: 3, right_start: 7, left_len: 2, right_len: 2, row_len: 2 })] }),
  );
  assert.equal(table.length, 2);
  assert.equal(table.kind[0], KIND_EQUAL);
  assert.equal(lineAt(table, 0, "left"), 3);
  assert.equal(lineAt(table, 0, "right"), 7);
  assert.equal(lineAt(table, 1, "left"), 4);
  assert.equal(lineAt(table, 1, "right"), 8);
});

test("a change hunk pairs modify rows then pads the longer side", () => {
  // 4 deletions vs 1 insertion: one modify row, then three right-padded rows.
  const table = decodeDiff(
    wire({
      hunks: [
        hunk({
          equal: false,
          left_start: 10,
          left_len: 4,
          right_start: 20,
          right_len: 1,
          row_start: 0,
          row_len: 4,
        }),
      ],
    }),
  );
  assert.equal(table.length, 4);
  assert.deepEqual([...table.kind], [KIND_MODIFY, KIND_DELETE, KIND_DELETE, KIND_DELETE]);
  assert.equal(lineAt(table, 0, "left"), 10);
  assert.equal(lineAt(table, 0, "right"), 20);
  assert.equal(lineAt(table, 1, "left"), 11);
  assert.equal(lineAt(table, 1, "right"), null);
  assert.equal(lineAt(table, 3, "left"), 13);
});

test("a change hunk with more insertions pads the left side", () => {
  const table = decodeDiff(
    wire({
      hunks: [
        hunk({
          equal: false,
          left_start: 0,
          left_len: 0,
          right_start: 5,
          right_len: 2,
          row_start: 0,
          row_len: 2,
        }),
      ],
    }),
  );
  assert.deepEqual([...table.kind], [KIND_INSERT, KIND_INSERT]);
  assert.equal(lineAt(table, 0, "left"), null);
  assert.equal(lineAt(table, 0, "right"), 5);
  assert.equal(lineAt(table, 1, "right"), 6);
});

test("mixed hunks derive rows in hunk order", () => {
  const hunks: Hunk[] = [
    hunk({ equal: true, left_start: 0, right_start: 0, left_len: 2, right_len: 2, row_start: 0, row_len: 2 }),
    hunk({ equal: false, left_start: 2, left_len: 1, right_start: 2, right_len: 3, row_start: 2, row_len: 3 }),
    hunk({ equal: true, left_start: 3, right_start: 5, left_len: 1, right_len: 1, row_start: 5, row_len: 1 }),
  ];
  const table = decodeDiff(wire({ hunks }));
  assert.equal(table.length, 6, "row count equals the hunks' total");
  assert.deepEqual([...table.kind], [
    KIND_EQUAL,
    KIND_EQUAL,
    KIND_MODIFY,
    KIND_INSERT,
    KIND_INSERT,
    KIND_EQUAL,
  ]);
  assert.equal(table.kindAt(2), "modify");
  assert.equal(table.kindAt(5), "equal");
  // The hunk row ranges are contiguous by contract; the derived length must agree.
  const last = hunks[hunks.length - 1];
  assert.equal(table.length, last.row_start + last.row_len);
});

test("an empty payload decodes to the shared empty table", () => {
  assert.equal(decodeDiff(null), EMPTY_DIFF);
  assert.equal(decodeDiff(undefined), EMPTY_DIFF);
  assert.equal(decodeDiff(wire()).length, 0);
});

test("stats, approximate and hunks are carried through unchanged", () => {
  const hunks = [hunk({ equal: true, left_len: 1, right_len: 1, row_len: 1 })];
  const table = decodeDiff(
    wire({
      hunks,
      stats: { added: 1, deleted: 2, modified: 3, unchanged: 4 },
      approximate: true,
    }),
  );
  assert.equal(table.stats.modified, 3);
  assert.equal(table.approximate, true);
  assert.equal(table.hunks, hunks);
});

// --- changed spans ----------------------------------------------------------

test("changed spans are found by row and clipped to the visible slice", () => {
  // Row 1 (a modify row) has two changed spans: 2..5 and 9..12.
  const table = decodeDiff(
    wire({
      hunks: [
        hunk({ equal: true, left_len: 1, right_len: 1, row_len: 1 }),
        hunk({
          equal: false,
          left_start: 1,
          left_len: 1,
          right_start: 1,
          right_len: 1,
          row_start: 1,
          row_len: 1,
        }),
      ],
      left_changed: [1, 2, 5, 1, 9, 12],
      right_changed: [1, 2, 5],
    }),
  );

  assert.deepEqual(changedSpansAt(table, "left", 1), [
    { start: 2, end: 5 },
    { start: 9, end: 12 },
  ]);
  // A wrapped slice starting at 6 keeps only the part of spans inside it and
  // makes the offsets relative to the slice.
  assert.deepEqual(changedSpansAt(table, "left", 1, 6, 10), [{ start: 3, end: 4 }]);
  assert.deepEqual(changedSpansAt(table, "left", 0), []);
  assert.deepEqual(changedSpansAt(table, "right", 1), [{ start: 2, end: 5 }]);
  assert.deepEqual(changedSpansAt(table, "left", 99), []);
});

test("adjacent rows do not leak changed spans into each other", () => {
  const table = decodeDiff(
    wire({
      hunks: [hunk({ equal: true, left_len: 1, right_len: 1, row_len: 1 })],
      left_changed: [0, 0, 1, 1, 3, 4],
    }),
  );
  assert.deepEqual(changedSpansAt(table, "left", 0), [{ start: 0, end: 1 }]);
  assert.deepEqual(changedSpansAt(table, "left", 1), [{ start: 3, end: 4 }]);
});
