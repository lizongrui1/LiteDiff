import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSearchHits,
  findTextMatches,
  groupSearchHits,
  searchSlicesFor,
  splitDisplayIndexForHit,
  unifiedDisplayIndexForHit,
} from "../src/lib/search.ts";
import { buildCodePieces } from "../src/lib/codeRender.ts";
import type { AlignedRow } from "../src/lib/types.ts";
import type { DisplayItem, UnifiedItem } from "../src/lib/viewport.ts";

function row(
  left: number | null,
  right: number | null,
  kind: AlignedRow["kind"],
): AlignedRow {
  return { left, right, kind, left_inline: [], right_inline: [] };
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

test("an equal row counts once and applies to both panes", () => {
  const hits = findSearchHits(
    [row(0, 0, "equal")],
    ["same text"],
    ["same text"],
    "text",
  );
  assert.deepEqual(hits, [{ row: 0, side: "both", start: 5, end: 9, line: 1 }]);
});

test("modified rows are searched on both sides", () => {
  const hits = findSearchHits(
    [row(0, 0, "modify")],
    ["left needle"],
    ["right needle"],
    "needle",
  );
  assert.deepEqual(hits, [
    { row: 0, side: "left", start: 5, end: 11, line: 1 },
    { row: 0, side: "right", start: 6, end: 12, line: 1 },
  ]);
});

test("row grouping preserves hit order", () => {
  const hits = findSearchHits(
    [row(0, 0, "modify"), row(1, 1, "equal")],
    ["a a", "zzz"],
    ["a", "zzz"],
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
  const hits = findSearchHits([row(0, 0, "equal")], ["x needle y"], ["x needle y"], "needle");
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
  const stale = [{ text: full, char_start: 0, char_end: full.length, changed: false }];
  const pieces = buildCodePieces(slice, stale, []);
  assert.equal(pieces.map((piece) => piece.text).join(""), slice);
});

test("valid inline styles and search highlights survive boundary splitting", () => {
  const text = "left needle right";
  const pieces = buildCodePieces(
    text,
    [
      { text: "left ", char_start: 0, char_end: 5, changed: false },
      { text: "needle", char_start: 5, char_end: 11, changed: true },
      { text: " right", char_start: 11, char_end: 17, changed: false },
    ],
    [],
    [{ start: 5, end: 11, current: true }],
  );
  assert.equal(pieces.map((piece) => piece.text).join(""), text);
  assert.equal(pieces.find((piece) => piece.changed)?.search, "current");
});
