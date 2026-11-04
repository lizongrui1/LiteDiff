import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDisplay, windowFor, displayIndexForRow } from "../src/lib/viewport.ts";

function mkHunks(n: number) {
  // Alternating 40-row equal runs and 3-row change runs, like a real file.
  const out = [];
  let row = 0;
  for (let i = 0; i < n; i++) {
    const equal = i % 2 === 0;
    const len = equal ? 40 : 3;
    out.push({ equal, left_start: row, left_len: len, right_start: row, right_len: len, row_start: row, row_len: len });
    row += len;
  }
  return out;
}

test("20k-line document stays cheap to project and window", () => {
  const hunks = mkHunks(1000); // ~21.5k source rows
  const totalRows = hunks[hunks.length - 1].row_start + hunks[hunks.length - 1].row_len;

  const t0 = performance.now();
  const items = buildDisplay(hunks, 10, new Set());
  const tBuild = performance.now() - t0;

  // Folded: one context row + bar + context row per equal run.
  assert.ok(items.length < totalRows / 2, `folded to ${items.length} of ${totalRows}`);

  const t1 = performance.now();
  let renderedMax = 0;
  for (let y = 0; y < items.length * 20; y += 200) {
    const w = windowFor(y, 800, items.length);
    renderedMax = Math.max(renderedMax, w.end - w.start);
  }
  const tWindow = performance.now() - t1;

  console.log(`rows=${totalRows} display=${items.length} build=${tBuild.toFixed(1)}ms scan=${tWindow.toFixed(1)}ms maxRendered=${renderedMax}`);

  // Window must stay bounded no matter where we are in the document.
  assert.ok(renderedMax < 80, `rendered ${renderedMax} rows, expected a small window`);
  // 224 scroll positions * O(1) each: must be far below a frame budget in total.
  assert.ok(tWindow < 50, `scanning took ${tWindow}ms`);
});

test("first visible row is where navigation anchors", () => {
  const hunks = mkHunks(10);
  const items = buildDisplay(hunks, 10, new Set());
  const w = windowFor(400, 200, items.length);
  assert.ok(w.firstVisible >= w.start);
  const anchored = items[w.firstVisible]?.row ?? 0;
  // The anchored row must be the one at the top edge, not an overscan row above.
  assert.ok(anchored >= items[w.start].row);
  assert.ok(displayIndexForRow(items, anchored) >= w.firstVisible);
});
