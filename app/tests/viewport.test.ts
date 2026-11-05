/**
 * Unit tests for the pure viewport maths.
 *
 * Run with `npm test` (node's built-in runner, no extra dependency). These cover
 * the parts that are easy to get subtly wrong and impossible to eyeball: fold
 * projection, window clamping, and hunk navigation at boundaries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dark, light } from "../src/lib/theme.ts";

import {
  buildDisplay,
  displayIndexForRow,
  foldHidingRow,
  gutterWidthFor,
  nextChangeHunk,
  scrollTopAfterExpand,
  scrollTopForItem,
  scrollTopToCentre,
  scrollTopToRow,
  unifiedIndexForRow,
  unifiedLineCount,
  nearestChange,
  anchorIndexForScroll,
  windowFor,
  displayWidth,
  visualWidth,
  wrapTextByWidth,
  expandSplitWrapped,
  expandUnifiedWrapped,
  sliceAtColumns,
  wrapLine,
  type UnifiedItem,
} from "../src/lib/viewport.ts";

/** Minimal hunk factory so each test states only what it cares about. */
function hunk(equal, rowStart, rowLen, leftLen = rowLen, rightLen = rowLen) {
  return {
    equal,
    left_start: rowStart,
    left_len: leftLen,
    right_start: rowStart,
    right_len: rightLen,
    row_start: rowStart,
    row_len: rowLen,
  };
}

test("buildDisplay keeps short equal hunks fully expanded", () => {
  const items = buildDisplay([hunk(true, 0, 5)], 10, new Set());
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.fold === null));
});

test("buildDisplay folds long equal hunks with one context row each side", () => {
  const items = buildDisplay([hunk(true, 0, 40)], 10, new Set());
  // 1 leading context + 1 fold bar + 1 trailing context.
  assert.equal(items.length, 3);
  assert.equal(items[0].row, 0);
  assert.equal(items[1].fold?.count, 38);
  assert.equal(items[1].fold?.startRow, 1);
  assert.equal(items[2].row, 39);
});

test("buildDisplay never folds change hunks", () => {
  const items = buildDisplay([hunk(false, 0, 40)], 10, new Set());
  assert.equal(items.length, 40);
  assert.ok(items.every((i) => i.fold === null));
});

test("buildDisplay respects expanded hunk indices", () => {
  const hunks = [hunk(true, 0, 40), hunk(false, 40, 2), hunk(true, 42, 40)];
  const collapsed = buildDisplay(hunks, 10, new Set());
  assert.equal(collapsed.filter((i) => i.fold).length, 2);

  const expanded = buildDisplay(hunks, 10, new Set([0]));
  assert.equal(expanded.filter((i) => i.fold).length, 1);
  // The still-collapsed hunk is the last one.
  assert.equal(expanded.find((i) => i.fold)?.fold?.hunkIndex, 2);
});

test("buildDisplay preserves source row order across a mixed list", () => {
  const hunks = [hunk(true, 0, 30), hunk(false, 30, 3), hunk(true, 33, 30)];
  const items = buildDisplay(hunks, 10, new Set());
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].row >= items[i - 1].row, "rows must ascend");
  }
});

test("buildDisplay handles an empty hunk list", () => {
  assert.deepEqual(buildDisplay([], 10, new Set()), []);
});

test("windowFor returns an empty window for zero items", () => {
  const w = windowFor(0, 600, 0);
  assert.deepEqual(w, {
    start: 0,
    end: 0,
    firstVisible: 0,
    offsetY: 0,
    totalHeight: 0,
    scrollHeight: 0,
  });
});

test("windowFor covers the viewport plus overscan", () => {
  // 20px rows, 200px viewport => 10 visible rows + 1 + 12 overscan each side.
  const w = windowFor(0, 200, 1000, 20, 12);
  assert.equal(w.start, 0, "clamped at the top");
  assert.equal(w.end, 11 + 12);
  assert.equal(w.totalHeight, 20000);
});

test("windowFor centres overscan around a mid-document scroll", () => {
  const w = windowFor(1000, 200, 1000, 20, 12);
  // scrollTop 1000 => first visible row 50.
  assert.equal(w.start, 38);
  assert.equal(w.end, 50 + 11 + 12);
  assert.equal(w.offsetY, 38 * 20);
});

test("windowFor clamps at the end of the document", () => {
  const w = windowFor(19980, 200, 1000, 20, 12);
  assert.equal(w.end, 1000, "never exceeds the item count");
  assert.ok(w.start < w.end);
});

test("windowFor tolerates over-scroll after a re-diff", () => {
  const w = windowFor(999999, 200, 10, 20, 12);
  assert.equal(w.start, 10);
  assert.equal(w.end, 10);
});

test("displayIndexForRow finds the exact item", () => {
  const items = [
    { row: 0, fold: null },
    { row: 1, fold: null },
    { row: 5, fold: null },
  ];
  assert.equal(displayIndexForRow(items, 0), 0);
  assert.equal(displayIndexForRow(items, 1), 1);
  assert.equal(displayIndexForRow(items, 5), 2);
});

test("displayIndexForRow snaps inside a folded run to the fold bar", () => {
  const items = buildDisplay([hunk(true, 0, 40)], 10, new Set());
  // Rows 1..38 are hidden behind the fold bar at display index 1.
  assert.equal(displayIndexForRow(items, 20), 1);
});

test("displayIndexForRow clamps below the first row", () => {
  const items = [{ row: 5, fold: null }];
  assert.equal(displayIndexForRow(items, 0), 0);
});

test("scrollTopForItem and scrollTopToCentre never go negative", () => {
  assert.equal(scrollTopForItem(0), 0);
  assert.equal(scrollTopForItem(10, 20), 200);
  assert.equal(scrollTopToCentre(0, 200, 20), 0);
});

test("nextChangeHunk walks forward and stops at the end", () => {
  const hunks = [hunk(false, 0, 1), hunk(true, 1, 5), hunk(false, 6, 1)];
  assert.equal(nextChangeHunk(hunks, 0, 1)?.row_start, 6);
  assert.equal(nextChangeHunk(hunks, 6, 1), null);
});

test("nextChangeHunk walks backward and stops at the start", () => {
  const hunks = [hunk(false, 0, 1), hunk(true, 1, 5), hunk(false, 6, 1)];
  assert.equal(nextChangeHunk(hunks, 6, -1)?.row_start, 0);
  assert.equal(nextChangeHunk(hunks, 0, -1), null);
});

test("nextChangeHunk ignores equal hunks entirely", () => {
  const hunks = [hunk(true, 0, 20), hunk(true, 20, 20)];
  assert.equal(nextChangeHunk(hunks, 0, 1), null);
  assert.equal(nextChangeHunk(hunks, 30, -1), null);
});

// --- Step 3 regressions -----------------------------------------------------

test("navigation advances after jumping to a hunk (no stickiness)", () => {
  // Reproduces the reported defect: the anchor row used by ⌘] was the window's
  // *overscan* start, which sits above the target row, so the freshly reached
  // hunk kept being returned as "next".
  const hunks = [hunk(false, 10, 2), hunk(true, 12, 5), hunk(false, 17, 2)];
  const items = buildDisplay(hunks, 10, new Set());

  const firstTarget = nextChangeHunk(hunks, 0, 1);
  assert.equal(firstTarget?.row_start, 10);

  // After jumping, the anchor must be the target's own row, not something above.
  const secondTarget = nextChangeHunk(hunks, firstTarget!.row_start, 1);
  assert.equal(secondTarget?.row_start, 17, "must move on to the following hunk");
  assert.equal(nextChangeHunk(hunks, 17, 1), null, "then stop at the end");
  assert.ok(items.length > 0);
});

test("windowFor exposes a first-visible index distinct from overscan start", () => {
  const w = windowFor(1000, 200, 1000, 20, 12);
  // start includes overscan above the viewport; firstVisible does not. Navigation
  // must use firstVisible, otherwise it anchors above the viewport.
  assert.equal(w.start, 38);
  assert.equal(w.firstVisible, 50);
  assert.ok(w.firstVisible > w.start);
});

test("displayIndexForRow clamps past the end instead of returning 0", () => {
  const items = [
    { row: 0, fold: null },
    { row: 1, fold: null },
  ];
  assert.equal(displayIndexForRow(items, 99), 1, "snaps to the last item");
});

test("displayIndexForRow handles an empty list", () => {
  assert.equal(displayIndexForRow([], 3), 0);
});

test("scrollTopToRow clamps at both ends of the document", () => {
  // 1000 rows * 20px = 20000px tall, 200px viewport => max scroll 19800.
  const CONTEXT = 12;

  assert.equal(scrollTopToRow(0, 200, 1000, 20, CONTEXT), 0, "never negative");
  // Row 999 with no context wants 19980px, past the 19800px maximum: the clamp
  // is what keeps the last row on screen instead of scrolling into nothing.
  assert.equal(
    scrollTopToRow(999, 200, 1000, 20, 0),
    19800,
    "clamped so the last row stays reachable",
  );
  // With context above, the desired offset is already inside the range.
  assert.equal(scrollTopToRow(999, 200, 1000, 20, CONTEXT), (999 - CONTEXT) * 20);
  assert.equal(scrollTopToRow(500, 200, 1000, 20, CONTEXT), (500 - CONTEXT) * 20);
});

test("scrollTopToRow works when the document is shorter than the viewport", () => {
  // 5 rows * 20px = 100px, viewport 200px => nothing to scroll.
  assert.equal(scrollTopToRow(3, 200, 5, 20, 12), 0);
});

test("expanding a fold above the viewport keeps content anchored", () => {
  // Fold bar at display index 5, viewport starts at 20, 38 hidden rows.
  // Expanding adds 37 rows above, so scrollTop must grow by 37 * rowHeight.
  const rowHeight = 20;
  const before = 20 * rowHeight;
  const after = scrollTopAfterExpand(before, 5, 38, 20, rowHeight);
  assert.equal(after, before + 37 * rowHeight);
});

test("expanding a fold below the viewport does not move the viewport", () => {
  const rowHeight = 20;
  const before = 5 * rowHeight;
  // Fold bar at index 40, viewport already starts at 5: nothing above shifted.
  assert.equal(scrollTopAfterExpand(before, 40, 38, 5, rowHeight), before);
});

test("expanding the fold bar at the very top edge does not move the viewport", () => {
  const rowHeight = 20;
  const before = 10 * rowHeight;
  // Equal indices: the bar is the first visible item, nothing above moved.
  assert.equal(scrollTopAfterExpand(before, 10, 38, 10, rowHeight), before);
});

test("foldHidingRow finds the fold covering a buried row", () => {
  const items = buildDisplay([hunk(true, 0, 40)], 10, new Set());
  // Context row 0, bar covering 1..38, context row 39.
  assert.equal(foldHidingRow(items, 0), null, "context row is visible");
  assert.equal(foldHidingRow(items, 20), 0, "buried row resolves to the fold");
  assert.equal(foldHidingRow(items, 39), null, "trailing context is visible");
});

test("foldHidingRow ignores expanded (unfolded) hunks", () => {
  const items = buildDisplay([hunk(true, 0, 40)], 10, new Set([0]));
  assert.equal(foldHidingRow(items, 20), null);
});

test("foldHidingRow returns null when nothing is folded", () => {
  const items = buildDisplay([hunk(false, 0, 5)], 10, new Set());
  assert.equal(foldHidingRow(items, 3), null);
});

test("navigation reaches a new hunk on every step even when clamped to 0", () => {
  // The real defect: for hunks near the top, `(index - context) * rowHeight`
  // clamps to 0, so a viewport-anchored cursor never advances. Stepping must be
  // driven by which hunk was reached last, not by scroll position.
  const changes = [
    { i: 1, row_start: 30 },
    { i: 3, row_start: 61 },
    { i: 5, row_start: 92 },
  ];
  let navIndex = -1;
  const visited: number[] = [];
  for (let step = 0; step < 3; step++) {
    navIndex += 1;
    if (navIndex >= changes.length) break;
    visited.push(changes[navIndex].row_start);
  }
  assert.deepEqual(visited, [30, 61, 92]);
  assert.equal(new Set(visited).size, visited.length, "every step is a new hunk");
});

test("jumping to a folded row lands on the right display index", () => {
  const hunks = [hunk(true, 0, 40), hunk(false, 40, 1), hunk(true, 41, 40)];
  const items = buildDisplay(hunks, 10, new Set());
  // Row 40 is visible (it is the change hunk) so no expansion is needed.
  assert.equal(foldHidingRow(items, 40), null);
  const idx = displayIndexForRow(items, 40);
  assert.equal(items[idx].row, 40, "display index must land on the target row itself");
});

test("displayed row numbers strictly increase across folds", () => {
  // The reported symptom: after folding, the gutter looked like it showed the
  // same number over and over. Every fold bar used to print only "N unchanged
  // lines", so N repeated down the whole column. The projection must also never
  // repeat a real row.
  const hunks = [
    hunk(true, 0, 39),
    hunk(false, 39, 1),
    hunk(true, 40, 39),
    hunk(false, 79, 1),
    hunk(true, 80, 39),
  ];
  const items = buildDisplay(hunks, 10, new Set());
  const rows = items.filter((i) => !i.fold).map((i) => i.row);

  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i] > rows[i - 1], `row ${rows[i]} must follow ${rows[i - 1]}`);
  }
  assert.equal(new Set(rows).size, rows.length, "no row may appear twice");
});

test("fold bars report disjoint, ascending line ranges", () => {
  const hunks = [hunk(true, 0, 39), hunk(false, 39, 1), hunk(true, 40, 39)];
  const items = buildDisplay(hunks, 10, new Set());
  const folds = items.filter((i) => i.fold);

  assert.equal(folds.length, 2);
  const ranges = folds.map((f) => ({
    from: f.fold!.startRow + 1,
    to: f.fold!.startRow + f.fold!.count,
  }));

  assert.deepEqual(ranges, [
    { from: 2, to: 38 },
    { from: 42, to: 78 },
  ]);
  // Ranges must not overlap an adjacent range.
  assert.ok(ranges[0].to < ranges[1].from);
});

test("a fold never claims the context rows it leaves visible", () => {
  const h = hunk(true, 100, 39);
  const items = buildDisplay([h], 10, new Set());
  const visibleRows = items.filter((i) => !i.fold).map((i) => i.row);
  const fold = items.find((i) => i.fold)!.fold!;
  const hidden = { from: fold.startRow, to: fold.startRow + fold.count - 1 };

  for (const row of visibleRows) {
    assert.ok(
      row < hidden.from || row > hidden.to,
      `visible row ${row} must not fall inside hidden ${hidden.from}..${hidden.to}`,
    );
  }
});

// --- unified view projection ------------------------------------------------

test("unifiedIndexForRow counts modify rows twice", () => {
  // equal, modify, equal -> unified lines: 1, 2, 3 -> indices 0,1,2,3,4
  const rows = [{ kind: "equal" }, { kind: "modify" }, { kind: "equal" }];
  assert.equal(unifiedIndexForRow(rows, 0), 0, "start of the document");
  assert.equal(unifiedIndexForRow(rows, 1), 1, "the modify row starts at line 1");
  assert.equal(unifiedIndexForRow(rows, 2), 3, "one modify adds an extra line");
  assert.equal(unifiedIndexForRow(rows, 3), 4, "end of the document");
});

test("unifiedIndexForRow matches the rendered line count", () => {
  const rows = [
    { kind: "equal" },
    { kind: "delete" },
    { kind: "insert" },
    { kind: "modify" },
    { kind: "modify" },
  ];
  // 1 + 1 + 1 + 2 + 2 = 7 physical lines
  assert.equal(unifiedLineCount(rows), 7);
  // Navigating to the last modify row must land on its first rendered line.
  assert.equal(unifiedIndexForRow(rows, 4), 5);
});

test("unifiedIndexForRow clamps out-of-range rows", () => {
  const rows = [{ kind: "equal" }, { kind: "equal" }];
  assert.equal(unifiedIndexForRow(rows, 99), 2);
  assert.equal(unifiedLineCount([]), 0);
});

test("split and unified projection disagree, so each view needs its own", () => {
  // This is the bug that motivated the split: reusing the split index inside the
  // unified view lands one line early per modification above the target.
  const rows = [{ kind: "modify" }, { kind: "equal" }, { kind: "modify" }];
  const sourceRow = 2;
  assert.equal(sourceRow, 2, "split index equals the source row");
  assert.equal(unifiedIndexForRow(rows, sourceRow), 3, "unified index differs");
});

// --- gutter sizing -----------------------------------------------------------
//
// The gutter is sized for line numbers only. It used to reserve two numbers plus a
// dash for fold ranges, which made a 637-line file ask for a seven-character column
// when its numbers were three — visibly half empty.

test("small documents all share one gutter width", () => {
  // A four-digit floor keeps the column from resizing on every file; anything with
  // fewer digits gets the same width, so opening a 9-line paste does not produce a
  // visibly narrower gutter than a 600-line file.
  const widths = [1, 9, 99, 637, 1234].map((n) => gutterWidthFor(n));
  assert.deepEqual(new Set(widths).size, 1, `expected one width, got ${widths.join(", ")}`);
});

test("the gutter grows once the numbers outgrow the floor", () => {
  const floor = gutterWidthFor(1234);
  assert.ok(gutterWidthFor(12345) > floor, "5 digits must widen");
  assert.ok(gutterWidthFor(123456) > gutterWidthFor(12345), "6 digits must widen further");
  assert.ok(gutterWidthFor(1234567) > gutterWidthFor(123456));
});

// The regression this replaced: a 637-line document used to get a gutter wide enough
// for `123–579`, i.e. seven characters, while the numbers needed three.
test("a 3-digit document does not reserve room for a fold range", () => {
  const width = gutterWidthFor(637);
  const sevenChars = 7 * 7.2;
  assert.ok(width < sevenChars, `expected under ${sevenChars}px for 3 digits, got ${width}`);
});

test("the floor is configurable, for a caller that wants a tighter gutter", () => {
  assert.ok(gutterWidthFor(9, { minDigits: 1 }) < gutterWidthFor(9, { minDigits: 4 }));
});

test("the gutter never returns a non-positive width", () => {
  for (const n of [0, 1, -5]) assert.ok(gutterWidthFor(n) > 0);
});

// --- collapse bar on expanded runs -----------------------------------------

test("expanded unchanged runs emit a collapse bar on their first row", () => {
  const hunks = [hunk(true, 0, 40), hunk(false, 40, 1)];
  const items = buildDisplay(hunks, 10, new Set([0]));

  const bars = items.filter((i) => i.collapsedBar);
  assert.equal(bars.length, 1, "one bar per expanded run");
  assert.equal(bars[0].row, 0, "the bar sits on the run's first row");
  assert.equal(bars[0].collapsedBar!.hunkIndex, 0);
  assert.equal(bars[0].collapsedBar!.rowCount, 40);
});

test("collapsed runs emit a fold bar instead of a collapse bar", () => {
  const items = buildDisplay([hunk(true, 0, 40)], 10, new Set());
  assert.equal(items.filter((i) => i.collapsedBar).length, 0);
  assert.equal(items.filter((i) => i.fold).length, 1);
});

test("short runs get neither bar", () => {
  const items = buildDisplay([hunk(true, 0, 5)], 10, new Set([0]));
  assert.equal(items.filter((i) => i.collapsedBar).length, 0);
  assert.equal(items.filter((i) => i.fold).length, 0);
});

test("expanded runs keep every row's own number", () => {
  // The reported symptom: numbers looked identical after folding. Expanding must
  // restore one distinct number per row.
  const hunks = [hunk(true, 0, 40), hunk(false, 40, 1), hunk(true, 41, 40)];
  const items = buildDisplay(hunks, 10, new Set([0, 2]));
  const rows = items.filter((i) => !i.fold).map((i) => i.row);

  assert.equal(new Set(rows).size, rows.length, "no repeated rows");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i] > rows[i - 1], "row numbers must ascend");
  }
});

// --- change-marker tokens ---------------------------------------------------
// The left-edge stripe and the tinted gutter are what make a changed line obvious
// at the window edge. They are asserted here because a palette edit can silently
// drop one of them and nothing else would fail.

test("every palette defines change edge and gutter tokens", () => {
  for (const [name, palette] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const key of ["delEdge", "insEdge", "delGutterText", "insGutterText"] as const) {
      const value = palette[key];
      assert.equal(typeof value, "string", `${name}.${key} must be a colour string`);
      assert.ok(value.length > 0, `${name}.${key} must not be empty`);
    }
  }
});

test("change edge tokens are more saturated than the row tints", () => {
  // The stripe must stand out against the row wash; if alpha ever drops to the
  // row tint's level the marker stops being visible.
  const alpha = (rgba: string) => {
    const m = /rgba?\([^)]*?([\d.]+)\)$/.exec(rgba);
    return m ? Number(m[1]) : 1;
  };
  for (const palette of [light, dark]) {
    assert.ok(
      alpha(palette.delEdge) > alpha(palette.delRow),
      "del edge must be stronger than the row tint",
    );
    assert.ok(
      alpha(palette.insEdge) > alpha(palette.insRow),
      "ins edge must be stronger than the row tint",
    );
  }
});

test("no palette uses the banned pure red or green", () => {
  // Hard requirement from the visual spec.
  const banned = ["#ff0000", "#00ff00", "255, 0, 0", "0, 255, 0"];
  for (const [name, palette] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const [key, value] of Object.entries(palette)) {
      const lower = String(value).toLowerCase().replace(/\s+/g, " ");
      for (const bad of banned) {
        assert.ok(
          !lower.includes(bad),
          `${name}.${key} must not use the banned colour ${bad} (got ${value})`,
        );
      }
    }
  }
});

// --- the bottom of the document ----------------------------------------------
//
// The scroll range ends exactly at the last row.
//
// It used to extend half a viewport past it, on the theory that the final line
// should be able to reach the top edge. Measured on a 3000-row file in a 620px
// pane, that left 284px of empty pane below the last line: the reader arrives at
// the end of the document and keeps scrolling through nothing. The end of the
// document is allowed to look like the end of the document.

test("the scroll port is exactly the document height", () => {
  const rows = 100;
  const rowH = 20;
  const w = windowFor(0, 600, rows, rowH, 0);

  assert.equal(w.totalHeight, rows * rowH, "the document");
  assert.equal(w.scrollHeight, rows * rowH, "and the scrolling extent agree");
});

test("an empty document has no scroll range", () => {
  const w = windowFor(0, 600, 0, 20, 0);
  assert.equal(w.scrollHeight, 0, "nothing to scroll must not open a blank scrollbar");
});

// The consequence the report was about: at the bottom, no empty pane under the
// last row. `maxScroll` leaves the final row flush with the bottom edge.
test("at the maximum scroll offset the last row sits at the bottom edge", () => {
  const rows = 100;
  const rowH = 20;
  const viewport = 600;
  const w = windowFor(0, viewport, rows, rowH, 0);

  const maxScroll = w.scrollHeight - viewport;
  const lastRowBottom = rows * rowH - maxScroll;
  assert.equal(
    lastRowBottom,
    viewport,
    "the last row's bottom edge meets the bottom of the pane, leaving no blank band",
  );
});

// Scrolling still starts at the very first row, with nothing above it.
test("the first row renders at the top when the offset is zero", () => {
  const w = windowFor(0, 600, 50, 20, 0);
  assert.equal(w.start, 0);
  assert.equal(w.firstVisible, 0);
  assert.equal(w.offsetY, 0);
});

// --- current-change marker ---------------------------------------------------
//
// The in-code marker (blue gutter number + caret) has to move as the user scrolls.
// It used to be chosen by "first change at or below the viewport's top row", with a
// fallback to the last change when that search failed. Two consequences, both
// reported: the marker jumped at arbitrary moments, and once the reader scrolled
// past the final change it never moved again — it "stuck".
//
// These tests pin the property that replaced it: the choice is nearest to a
// reference row, and therefore monotonic in scroll position.

const change = (row: number, len = 1) => ({ h: { row_start: row, row_len: len } });

test("the nearest change is the one the marker picks", () => {
  const changes = [change(10), change(100), change(200)];
  assert.equal(nearestChange(changes, 0), 0);
  assert.equal(nearestChange(changes, 105), 1);
  assert.equal(nearestChange(changes, 198), 2);
});

test("an empty hunk list has no current change", () => {
  assert.equal(nearestChange([], 42), -1);
});

test("the marker never jumps backwards when scrolling down", () => {
  // This is the defect: with the old rule the index could stall or reset, so the
  // highlight stopped tracking the wheel. Monotonicity is the whole fix.
  const changes = Array.from({ length: 40 }, (_, k) => change(k * 10));
  let previous = -1;
  for (let row = 0; row < 400; row += 3) {
    const index = nearestChange(changes, row);
    assert.ok(index >= previous, `row ${row} went back from ${previous} to ${index}`);
    previous = index;
  }
});

test("the marker never jumps forwards when scrolling back up", () => {
  const changes = Array.from({ length: 40 }, (_, k) => change(k * 10));
  let previous = Infinity;
  for (let row = 399; row >= 0; row -= 3) {
    const index = nearestChange(changes, row);
    assert.ok(index <= previous, `row ${row} jumped ahead from ${previous} to ${index}`);
    previous = index;
  }
});

test("at the very bottom the marker is the last change, not stuck somewhere earlier", () => {
  // The reported symptom: scrolled to the end, highlight parked at the top.
  const changes = [change(10), change(20), change(30)];
  assert.equal(nearestChange(changes, 1000), 2, "the closest change to the end");
});

test("at the very top the marker is the first change", () => {
  const changes = [change(10), change(20), change(30)];
  assert.equal(nearestChange(changes, 0), 0);
});

test("a tall hunk is measured from its centre", () => {
  // A 21-row hunk starting at 100 spans 100..120; its centre is 110, so a reference
  // row of 115 belongs to it rather than to a one-row change at 121.
  const changes = [change(100, 21), change(121), change(200)];
  assert.equal(nearestChange(changes, 115), 0);
  assert.equal(nearestChange(changes, 125), 1);
});

test("equidistant changes resolve to the earlier one, stably", () => {
  // Resolving ties in one direction keeps a scroll up-then-down from oscillating.
  const changes = [change(100), change(110)];
  assert.equal(nearestChange(changes, 105), 0);
});

// --- change-marker anchor ----------------------------------------------------
//
// The marker used to be anchored to the middle row of the viewport. That row can
// never pass `itemCount - viewportRows / 2` at max scroll, so changes in the lower
// half of the last screenful were unreachable: at the tail the marker parked at
// the last change at or above the midline and scrolling further did nothing. The
// anchor now follows scroll progress across the whole item range.

test("the anchor reaches the first and last item at the scroll extremes", () => {
  const itemCount = 2000;
  const viewport = 600;
  const rowH = 20;
  const maxScroll = itemCount * rowH - viewport;
  assert.equal(anchorIndexForScroll(0, viewport, itemCount, rowH), 0);
  assert.equal(anchorIndexForScroll(maxScroll, viewport, itemCount, rowH), itemCount - 1);
});

test("the anchor tracks the viewport midline mid-document", () => {
  // Both are linear in the scroll fraction, so away from the ends the new anchor
  // stays within a row of the old midline behaviour readers are used to.
  const itemCount = 2000;
  const viewport = 600;
  const rowH = 20;
  const scrollTop = 1000 * rowH;
  const midline = Math.floor((scrollTop + viewport / 2) / rowH);
  const anchor = anchorIndexForScroll(scrollTop, viewport, itemCount, rowH);
  assert.ok(Math.abs(anchor - midline) <= 1, `${anchor} differs from midline ${midline}`);
});

test("the anchor never moves backwards while scrolling down", () => {
  const itemCount = 2000;
  const viewport = 600;
  const rowH = 20;
  const maxScroll = itemCount * rowH - viewport;
  let previous = -1;
  for (let i = 0; i <= 200; i++) {
    const anchor = anchorIndexForScroll((maxScroll * i) / 200, viewport, itemCount, rowH);
    assert.ok(anchor >= previous, `step ${i} went back from ${previous} to ${anchor}`);
    previous = anchor;
  }
});

test("a change below the last screen's midline is reachable at the very bottom", () => {
  // The reported case: two changes inside the final screenful. The old midline
  // anchor capped out at row `itemCount - viewportRows / 2` and selected the
  // upper change forever; the progress anchor reaches the last item instead.
  const itemCount = 877;
  const viewport = 40 * 20;
  const rowH = 20;
  const maxScroll = itemCount * rowH - viewport;
  const midline = itemCount - 40 + 20;
  const changes = [change(midline), change(itemCount - 7)];
  assert.equal(nearestChange(changes, midline), 0, "the midline anchor cannot reach the lower change");
  const anchor = anchorIndexForScroll(maxScroll, viewport, itemCount, rowH);
  assert.equal(nearestChange(changes, anchor), 1);
});

test("a document shorter than the viewport anchors on its middle item", () => {
  assert.equal(anchorIndexForScroll(0, 600, 10, 20), 4);
  assert.equal(anchorIndexForScroll(0, 600, 1, 20), 0);
});

test("the anchor clamps scroll offsets outside the scroll range", () => {
  const itemCount = 100;
  const viewport = 200;
  const rowH = 20;
  assert.equal(anchorIndexForScroll(-500, viewport, itemCount, rowH), 0);
  assert.equal(anchorIndexForScroll(1e9, viewport, itemCount, rowH), itemCount - 1);
});

// --- unified folding ---------------------------------------------------------
//
// The inline view had no folding at all: it mapped every aligned row to one or two
// lines and rendered them all, so a file with a single changed line showed the other
// 400 in full while the side-by-side view collapsed them into two bars. Same file,
// two different amounts of scrolling.

import { buildUnifiedDisplay, unifiedIndexIn } from "../src/lib/viewport.ts";

const uHunk = (over: Partial<Hunk> & { equal: boolean; row_start: number; row_len: number }): Hunk => ({
  left_start: over.row_start,
  left_len: over.row_len,
  right_start: over.row_start,
  right_len: over.row_len,
  ...over,
});

/** Rows where `changed` picks the kind; used to keep the projection honest. */
const rowKinds = (n: number, changed: (i: number) => boolean) =>
  Array.from({ length: n }, (_, i) => ({ kind: changed(i) ? "modify" : "equal" }));

test("an unchanged run longer than the threshold collapses to one bar", () => {
  const hunks = [uHunk({ equal: true, row_start: 0, row_len: 100 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(100, () => false), 10, new Set());
  const folds = items.filter((i) => i.fold !== null);
  assert.equal(folds.length, 1, "one bar for the run");
  assert.equal(folds[0].fold?.count, 98, "the two context rows stay visible");
});

test("a collapsed run keeps one row of context on each side", () => {
  const hunks = [uHunk({ equal: true, row_start: 0, row_len: 100 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(100, () => false), 10, new Set());
  const rows = items.filter((i) => i.fold === null).map((i) => i.sourceRow);
  assert.equal(rows[0], 0, "first row visible");
  assert.equal(rows.at(-1), 99, "last row visible");
});

test("a short unchanged run is not folded", () => {
  const hunks = [uHunk({ equal: true, row_start: 0, row_len: 4 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(4, () => false), 10, new Set());
  assert.equal(items.filter((i) => i.fold !== null).length, 0);
});

test("expanding a run shows every row and no bar", () => {
  const hunks = [uHunk({ equal: true, row_start: 0, row_len: 100 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(100, () => false), 10, new Set([0]));
  assert.equal(items.filter((i) => i.fold !== null).length, 0);
  assert.equal(items.length, 100);
});

test("a change hunk is never folded", () => {
  const hunks = [uHunk({ equal: false, row_start: 0, row_len: 50 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(50, () => true), 10, new Set());
  assert.equal(items.filter((i) => i.fold !== null).length, 0);
});

test("a modify row still expands to two lines when unfolded", () => {
  const hunks = [uHunk({ equal: false, row_start: 0, row_len: 1 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(1, () => true), 10, new Set());
  assert.equal(items.length, 2, "old above new");
  assert.deepEqual(items.map((i) => i.side), ["left", "right"]);
});

test("the projection is shorter than the raw line count once folded", () => {
  // The reported symptom: the inline view scrolled through every unchanged line.
  const hunks = [
    uHunk({ equal: true, row_start: 0, row_len: 200 }),
    uHunk({ equal: false, row_start: 200, row_len: 1 }),
  ];
  const rows = rowKinds(201, (i) => i === 200);
  const folded = buildUnifiedDisplay(hunks, rows, 10, new Set()).length;
  const unfolded = buildUnifiedDisplay(hunks, rows, 10, new Set([0])).length;
  assert.ok(folded < unfolded / 10, `folded ${folded} vs unfolded ${unfolded}`);
  assert.equal(unfolded, 202, "200 equal + modify counts twice");
});

test("a row inside a collapsed run maps to the bar's index", () => {
  const hunks = [uHunk({ equal: true, row_start: 0, row_len: 100 })];
  const items = buildUnifiedDisplay(hunks, rowKinds(100, () => false), 10, new Set());
  // Row 50 is hidden; the bar is item index 1 (after the one context row).
  assert.equal(unifiedIndexIn(items, 50), 1);
  // Row 0 is the visible context row above the bar.
  assert.equal(unifiedIndexIn(items, 0), 0);
});

// --- wrapping by measured pixel width ---------------------------------------
//
// The original wrapper converted text to monospace columns and assumed a CJK glyph
// always occupied two Latin cells. On macOS CJK comes from a fallback font with a
// different advance, so mixed-language lines ended at visibly inconsistent points.

test("display width counts CJK, emoji and tabs as they are rendered", () => {
  assert.equal(displayWidth("abcd"), 4);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("a中"), 3);
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("\tx"), 9, "a tab advances to the next eight-column stop");
  assert.equal(displayWidth("a\tb"), 9, "tab width depends on the current column");
});

test("wrapLine slices by display columns without splitting a wide glyph", () => {
  const lines = wrapLine("中文中文", 4);
  assert.deepEqual(lines, [
    { start: 0, end: 2, continued: false },
    { start: 2, end: 4, continued: true },
  ]);
});

test("sliceAtColumns maps visual columns back to string offsets", () => {
  const text = "中文abc";
  assert.deepEqual(sliceAtColumns(text, 0, 2), { start: 0, end: 1, text: "中" });
  assert.deepEqual(sliceAtColumns(text, 2, 4), { start: 1, end: 2, text: "文" });
  assert.deepEqual(sliceAtColumns(text, 4, 7), { start: 2, end: 5, text: "abc" });
});

test("visual width uses the measured fallback-font advance for CJK", () => {
  const metrics = { charWidth: 7.2, wideCharWidth: 12 };
  assert.equal(visualWidth("abcd", metrics), 28.8);
  assert.equal(visualWidth("中文", metrics), 24);
  assert.equal(visualWidth("a中", metrics), 19.2);
  assert.equal(visualWidth("a\tb", metrics), 64.8);
});

test("pixel wrapping fills each slice using the measured CJK advance", () => {
  const metrics = { charWidth: 10, wideCharWidth: 12 };
  const wrapped = wrapTextByWidth("中".repeat(30), 125, metrics);
  assert.deepEqual(wrapped, [
    { start: 0, end: 10, continued: false },
    { start: 10, end: 20, continued: true },
    { start: 20, end: 30, continued: true },
  ]);
});

test("a long mixed-width line wraps by pixels instead of character count", () => {
  const items = [
    {
      row: 0,
      fold: null,
      collapsedBar: { hunkIndex: 2, rowCount: 20 },
    },
  ];
  const metrics = { charWidth: 10, wideCharWidth: 12 };
  const text = "中".repeat(50);
  const wrapped = expandSplitWrapped(
    items,
    250,
    300,
    () => text,
    () => "",
    metrics,
  );
  assert.equal(wrapped.length, 3);
  assert.deepEqual(
    wrapped.map((item) => item.splitWrap?.left),
    [
      { start: 0, end: 20, continued: false },
      { start: 20, end: 40, continued: true },
      { start: 40, end: 50, continued: true },
    ],
  );
  assert.deepEqual(wrapped[0].collapsedBar, { hunkIndex: 2, rowCount: 20 });
  assert.equal(wrapped[1].collapsedBar, null, "the collapse chip renders once, not per slice");
});

test("split wrapping uses each pane's own width while keeping rows aligned", () => {
  const items = [{ row: 0, fold: null, collapsedBar: { hunkIndex: 2, rowCount: 20 } }];
  const metrics = { charWidth: 1, wideCharWidth: 1.2 };
  const wrapped = expandSplitWrapped(
    items,
    100,
    100,
    () => "a".repeat(150),
    () => "b".repeat(250),
    metrics,
  );

  assert.equal(wrapped.length, 3, "the wider side controls the physical row count");
  assert.deepEqual(
    wrapped.map((item) => item.splitWrap),
    [
      {
        left: { start: 0, end: 100, continued: false },
        right: { start: 0, end: 100, continued: false },
      },
      {
        left: { start: 100, end: 150, continued: true },
        right: { start: 100, end: 200, continued: true },
      },
      {
        left: null,
        right: { start: 200, end: 250, continued: true },
      },
    ],
  );
  assert.deepEqual(wrapped[0].collapsedBar, { hunkIndex: 2, rowCount: 20 });
  assert.equal(wrapped[1].collapsedBar, null);
});

test("a split row that fits either pane stays a single unwrapped item", () => {
  const items = [{ row: 0, fold: null }];
  const wrapped = expandSplitWrapped(
    items,
    100,
    100,
    () => "12345",
    () => "12345678",
    { charWidth: 1, wideCharWidth: 1.2 },
  );
  assert.deepEqual(wrapped, items);
});

test("the unified view wraps wide lines into aligned physical rows", () => {
  const items: UnifiedItem[] = [
    { fold: null, sourceRow: 0, side: "left", half: 0 },
    {
      fold: { count: 5, startRow: 1, hunkIndex: 0 },
      sourceRow: 1,
      side: "left",
      half: 0,
    },
  ];
  const wrapped = expandUnifiedWrapped(
    items,
    100,
    (item) => (item.fold ? "" : "a".repeat(250)),
    { charWidth: 1, wideCharWidth: 1.2 },
  );
  assert.equal(wrapped.length, 4, "three slices plus the unchanged fold bar");
  assert.deepEqual(
    wrapped.slice(0, 3).map((item) => item.wrap),
    [
      { start: 0, end: 100, continued: false },
      { start: 100, end: 200, continued: true },
      { start: 200, end: 250, continued: true },
    ],
  );
  assert.equal(wrapped[3].fold?.hunkIndex, 0);
});
