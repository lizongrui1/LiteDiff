import { test } from "node:test";
import assert from "node:assert/strict";
import { minimapScale } from "../src/lib/viewport.ts";

/*
 * The minimap strip is always as tall as the pane, but a short document does not
 * fill the pane. Scaling `count` rows across the full strip stretched them, so a
 * 20-line file in a 771px pane drew its changes at ~50% of the axis while the eye
 * saw them at ~21% of the pane.
 */

const MAP_H = 752; // CSS height of the strip in the 1280x820 window
const PANE_H = 771; // .body clientHeight
const ROW_H = 16;

// Every assertion below compares the strip against the pane, because "the map
// disagrees with the code" is the only failure that matters.
const paneFraction = (row: number) => (row * ROW_H) / PANE_H;
const mapFraction = (row: number, count: number) =>
  (row * minimapScale(count, MAP_H, ROW_H, PANE_H).unit) / MAP_H;

test("a short document maps 1:1 with the pane", () => {
  // 20 rows is well under the 48 the pane can hold, so this is the stretched case.
  for (const row of [0, 5, 10, 15, 19]) {
    assert.ok(
      Math.abs(paneFraction(row) - mapFraction(row, 20)) < 0.005,
      `row ${row}: pane ${paneFraction(row).toFixed(3)} vs map ${mapFraction(row, 20).toFixed(3)}`,
    );
  }
});

// The specific regression: rows 10-11 of a 20-line file used to land at 50-55% of
// the axis while sitting at 21-25% of the pane.
test("a change near the top of a short file stays near the top of the strip", () => {
  const { unit } = minimapScale(20, MAP_H, ROW_H, PANE_H);
  const top = (10 * unit) / MAP_H;
  assert.ok(top < 0.25, `expected under 25% of the strip, got ${(top * 100).toFixed(1)}%`);
  assert.ok(top > 0.15, `expected over 15% of the strip, got ${(top * 100).toFixed(1)}%`);
});

test("a document shorter than the pane leaves the strip's tail unused", () => {
  const { usedHeight } = minimapScale(20, MAP_H, ROW_H, PANE_H);
  assert.ok(usedHeight < MAP_H, "the document must not fill the whole strip");
  // 20 rows of 16px in a 771px pane occupies ~41.5% of the strip.
  const ratio = usedHeight / MAP_H;
  assert.ok(Math.abs(ratio - (20 * ROW_H) / PANE_H) < 0.01, `got ${ratio.toFixed(3)}`);
});

// A document taller than the pane must keep the old, fully-utilised mapping — the
// fix must not change behaviour for the files that motivated the minimap.
test("a tall document still fills the strip", () => {
  const count = 5000;
  const { unit, usedHeight } = minimapScale(count, MAP_H, ROW_H, PANE_H);
  assert.ok(Math.abs(usedHeight - MAP_H) < 0.01, "no wasted strip for a long file");
  assert.ok(Math.abs(unit - MAP_H / count) < 1e-9, "unit is mapHeight/count again");
});

// The boundary between "short" and "tall": a document that just fills the pane
// must behave like a taller one (strip fully used), not like a short one. There
// must be no visible jump as a file grows past one screen.
test("a document that just fills the pane uses the whole strip", () => {
  const fits = Math.ceil(PANE_H / ROW_H); // 49 rows * 16px >= 771px
  const at = minimapScale(fits, MAP_H, ROW_H, PANE_H);
  const over = minimapScale(fits + 1, MAP_H, ROW_H, PANE_H);
  assert.ok(
    Math.abs(at.usedHeight - MAP_H) < 1,
    `a pane-filling document must fill the strip, got ${at.usedHeight} of ${MAP_H}`,
  );
  assert.ok(Math.abs(over.usedHeight - MAP_H) < 1);
  assert.ok(over.unit < at.unit, "more rows means a smaller unit");
});

// Defensive: a zero-height pane or row must not produce Infinity/NaN, which would
// paint nothing at all and look like the strip had disappeared.
test("degenerate inputs produce finite numbers", () => {
  for (const [count, mapH, rowH, clientH] of [
    [0, MAP_H, ROW_H, PANE_H],
    [20, MAP_H, 0, PANE_H],
    [20, MAP_H, ROW_H, 0],
    [0, 0, 0, 0],
  ]) {
    const { unit, usedHeight } = minimapScale(count, mapH, rowH, clientH);
    assert.ok(Number.isFinite(unit), `unit must be finite for ${[count, mapH, rowH, clientH]}`);
    assert.ok(Number.isFinite(usedHeight), "usedHeight must be finite");
    assert.ok(unit >= 0 && usedHeight >= 0, "no negatives");
  }
});

test("an empty document uses none of the strip", () => {
  const { usedHeight } = minimapScale(0, MAP_H, ROW_H, PANE_H);
  assert.equal(usedHeight, 0);
});
