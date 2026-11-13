import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSearchHits,
  findTextMatches,
  groupSearchHits,
  MAX_SEARCH_HITS,
  searchSlicesFor,
  splitDisplayIndexForHit,
  unifiedDisplayIndexForHit,
} from "../src/lib/search.ts";
import { buildCodePieces } from "../src/lib/codeRender.ts";
import { decodeDiff, type DiffTable } from "../src/lib/diffView.ts";
import { lineIndex, type LineIndex } from "../src/lib/lines.ts";
import type { Hunk, RowKind } from "../src/lib/types.ts";
import type { DisplayItem, UnifiedItem } from "../src/lib/viewport.ts";

/** One-row-wide diff table built from explicit (left, right, kind) rows. */
function tableOf(...rows: Array<[number | null, number | null, RowKind]>): DiffTable {
  const hunks: Hunk[] = [];
  let rowStart = 0;
  for (const [left, right, kind] of rows) {
    if (kind === "equal") {
      hunks.push({
        equal: true,
        left_start: left ?? 0,
        left_len: 1,
        right_start: right ?? 0,
        right_len: 1,
        row_start: rowStart,
        row_len: 1,
      });
    } else if (kind === "modify") {
      hunks.push({
        equal: false,
        left_start: left ?? 0,
        left_len: 1,
        right_start: right ?? 0,
        right_len: 1,
        row_start: rowStart,
        row_len: 1,
      });
    } else if (kind === "delete") {
      hunks.push({
        equal: false,
        left_start: left ?? 0,
        left_len: 1,
        right_start: 0,
        right_len: 0,
        row_start: rowStart,
        row_len: 1,
      });
    } else {
      hunks.push({
        equal: false,
        left_start: 0,
        left_len: 0,
        right_start: right ?? 0,
        right_len: 1,
        row_start: rowStart,
        row_len: 1,
      });
    }
    rowStart++;
  }
  return decodeDiff({
    left_line_count: rows.length,
    right_line_count: rows.length,
    hunks,
    stats: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
    approximate: false,
    left_changed: [],
    right_changed: [],
  });
}

/** Line index for a list of line contents (joined the way the backend sends text). */
function linesOf(texts: string[]): LineIndex {
  return lineIndex(texts.join("\n"));
}

test("literal search is case-insensitive by default and supports case sensitivity", () => {
  assert.deepEqual(findTextMatches("Needle needle NEEDLE", "needle"), [
    { start: 0, end: 6 },
    { start: 7, end: 13 },
    { start: 14, end: 20 },
  ]);
  assert.deepEqual(findTextMatches("Needle needle NEEDLE", "needle", true), [
    { start: 7, end: 13 },
  ]);
});

test("search treats regular-expression characters as literal text", () => {
  assert.deepEqual(findTextMatches("a+b a.b a[b", "a."), [{ start: 4, end: 6 }]);
  assert.deepEqual(findTextMatches("a+b", "a+b"), [{ start: 0, end: 3 }]);
});

test("a single huge line stops allocating matches at the global cap", () => {
  const text = "a".repeat(MAX_SEARCH_HITS + 1_000);
  const hits = findSearchHits(tableOf([0, 0, "equal"]), linesOf([text]), linesOf([text]), "a");
  assert.equal(hits.length, MAX_SEARCH_HITS);
  assert.equal(hits.at(-1)?.start, MAX_SEARCH_HITS - 1);
  assert.equal(findTextMatches(text, "a").length, MAX_SEARCH_HITS);
});

test("an equal row counts once and applies to both panes", () => {
  const hits = findSearchHits(
    tableOf([0, 0, "equal"]),
    linesOf(["same text"]),
    linesOf(["same text"]),
    "text",
  );
  assert.deepEqual(hits, [{ row: 0, side: "both", start: 5, end: 9, line: 1 }]);
});

test("modified rows are searched on both sides", () => {
  const hits = findSearchHits(
    tableOf([0, 0, "modify"]),
    linesOf(["left needle"]),
    linesOf(["right needle"]),
    "needle",
  );
  assert.deepEqual(hits, [
    { row: 0, side: "left", start: 5, end: 11, line: 1 },
    { row: 0, side: "right", start: 6, end: 12, line: 1 },
  ]);
});

test("row grouping preserves hit order", () => {
  const hits = findSearchHits(
    tableOf([0, 0, "modify"], [1, 1, "equal"]),
    linesOf(["a a", "zzz"]),
    linesOf(["a", "zzz"]),
    "a",
  );
  const grouped = groupSearchHits(hits);
  assert.equal(grouped.get(0)?.length, 3);
  assert.equal(grouped.has(1), false);
  assert.deepEqual(
    grouped.get(0)?.map(({ side, start }) => ({ side, start })),
    [
      { side: "left", start: 0 },
      { side: "left", start: 2 },
      { side: "right", start: 0 },
    ],
  );
});

test("wrapped slices clip search hits and preserve their active state", () => {
  const hits = findSearchHits(
    tableOf([0, 0, "equal"]),
    linesOf(["x needle y"]),
    linesOf(["x needle y"]),
    "needle",
  );
  const slices = searchSlicesFor(hits, "right", 3, 10, hits[0]);
  assert.deepEqual(slices, [{ start: 0, end: 5, current: true }]);
});

test("search navigation resolves the split-view wrap slice containing the hit", () => {
  const items: DisplayItem[] = [
    {
      row: 7,
      fold: null,
      splitWrap: {
        left: { start: 0, end: 10, continued: false },
        right: { start: 0, end: 8, continued: false },
      },
    },
    {
      row: 7,
      fold: null,
      splitWrap: {
        left: { start: 10, end: 20, continued: true },
        right: { start: 8, end: 18, continued: true },
      },
    },
  ];
  const hit = {
    row: 7,
    side: "right" as const,
    start: 12,
    end: 18,
    line: 8,
  };
  assert.equal(splitDisplayIndexForHit(items, hit), 1);
});

test("search navigation resolves the unified-view wrap slice containing the hit", () => {
  const items: UnifiedItem[] = [
    { fold: null, sourceRow: 3, side: "left", half: 0, wrap: { start: 0, end: 9, continued: false } },
    { fold: null, sourceRow: 3, side: "left", half: 0, wrap: { start: 9, end: 18, continued: true } },
    { fold: null, sourceRow: 3, side: "right", half: 1, wrap: { start: 0, end: 7, continued: false } },
    { fold: null, sourceRow: 3, side: "right", half: 1, wrap: { start: 7, end: 15, continued: true } },
  ];
  const hit = {
    row: 3,
    side: "right" as const,
    start: 8,
    end: 13,
    line: 4,
  };
  assert.equal(unifiedDisplayIndexForHit(items, hit), 3);
});

test("code text remains exact when style spans do not match the wrapped slice", () => {
  const full = "4、选项不冗余（硬规则，优先级最高）";
  const slice = full.slice(22, 38);
  // A span that overruns the visible slice is clamped, never allowed to repeat text.
  const pieces = buildCodePieces(slice, [{ start: 0, end: full.length }], []);
  assert.equal(pieces.map((piece) => piece.text).join(""), slice);
});

test("valid inline styles and search highlights survive boundary splitting", () => {
  const text = "left needle right";
  const pieces = buildCodePieces(
    text,
    [{ start: 5, end: 11 }],
    [],
    [{ start: 5, end: 11, current: true }],
  );
  assert.equal(pieces.map((piece) => piece.text).join(""), text);
  assert.equal(pieces.find((piece) => piece.changed)?.search, "current");
});
