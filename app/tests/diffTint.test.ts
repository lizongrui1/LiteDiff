import { test } from "node:test";
import assert from "node:assert/strict";
import { rowTint } from "../src/lib/theme.ts";

/*
 * Side-by-side alignment inserts empty cells so the two columns stay in step.
 * Those cells must stay neutral: tinting the left placeholder green makes a
 * right-side insertion look like an added line in the old document.
 */

test("padded cells are never tinted as changes", () => {
  assert.equal(rowTint("insert", "left", true), "none");
  assert.equal(rowTint("delete", "right", true), "none");
  assert.equal(rowTint("modify", "left", true), "none");
  assert.equal(rowTint("modify", "right", true), "none");
  assert.equal(rowTint("equal", "left", true), "none");
});

test("real changed lines keep directional red/green tinting", () => {
  assert.equal(rowTint("delete", "left", false), "del");
  assert.equal(rowTint("insert", "right", false), "ins");
  assert.equal(rowTint("modify", "left", false), "del");
  assert.equal(rowTint("modify", "right", false), "ins");
});

test("unchanged lines have no change tint", () => {
  assert.equal(rowTint("equal", "left", false), "none");
  assert.equal(rowTint("equal", "right", false), "none");
});
