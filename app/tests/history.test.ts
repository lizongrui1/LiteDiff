import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ENTRY_BYTES,
  dayGroup,
  entryFromSession,
  formatSize,
  formatTime,
  sessionFromEntry,
  sessionKey,
  shouldRecord,
} from "../src/lib/history.ts";
import type { Session, Side } from "../src/lib/types.ts";

/*
 * History rules.
 *
 * The interesting failures are not crashes: they are a comparison that silently
 * reopens as a *different* comparison (truncation), a list that grows a duplicate
 * on every option toggle (identity), and a day boundary that files this morning
 * under "yesterday". None of those are visible in a type check.
 */

const side = (over: Partial<Side> = {}): Side => ({
  path: null,
  label: "",
  text: "x\n",
  git: null,
  ...over,
});

const session = (left: Side, right: Side, over: Partial<Session> = {}): Session => ({
  left,
  right,
  result: {
    left_line_count: 1,
    right_line_count: 1,
    rows: [],
    hunks: [],
    stats: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
  },
  options: {
    ignore_whitespace: false,
    ignore_all_whitespace: false,
    ignore_case: false,
    intra_line: true,
    intra_line_max_tokens: 0,
  },
  warnings: [],
  ...over,
});

// --- what gets recorded ----------------------------------------------------

test("an empty pair is not recorded", () => {
  // Both sides empty is the paste screen; a row that reopens to nothing is noise.
  assert.equal(shouldRecord(session(side({ text: "" }), side({ text: "" }))), false);
});

test("a one-sided comparison is recorded", () => {
  // "Compare this against nothing" is a legitimate request, and the side that has
  // text is exactly what the user wants to reopen.
  assert.equal(shouldRecord(session(side({ text: "a\n" }), side({ text: "" }))), true);
});

test("an oversized pair is skipped, not truncated", () => {
  const half = "x".repeat(MAX_ENTRY_BYTES / 2 + 1);
  assert.equal(shouldRecord(session(side({ text: half }), side({ text: half }))), false);
});

test("an exactly-at-limit pair is still recorded", () => {
  const half = "x".repeat(MAX_ENTRY_BYTES / 2);
  assert.equal(shouldRecord(session(side({ text: half }), side({ text: half }))), true);
});

// --- identity --------------------------------------------------------------

test("the same documents produce the same key regardless of options", () => {
  /*
   * This is what stops a history row appearing on every option toggle. The
   * documents are what the user compared; the options only change the rendering
   * of that comparison.
   */
  const base = session(side({ text: "a\n" }), side({ text: "b\n" }));
  const toggled = session(base.left, base.right, {
    options: { ...base.options, ignore_whitespace: true, intra_line: false },
  });
  assert.equal(sessionKey(base), sessionKey(toggled));
});

test("changing either side changes the key", () => {
  const base = session(side({ text: "a\n" }), side({ text: "b\n" }));
  assert.notEqual(sessionKey(base), sessionKey(session(side({ text: "a2\n" }), side({ text: "b\n" }))));
  assert.notEqual(sessionKey(base), sessionKey(session(side({ text: "a\n" }), side({ text: "b2\n" }))));
});

test("the sides are not interchangeable", () => {
  // Swapping left and right is a different comparison: the tints and the
  // arrows all point the other way.
  const left = side({ text: "a\n" });
  const right = side({ text: "b\n" });
  assert.notEqual(
    sessionKey(session(left, right)),
    sessionKey(session(right, left)),
  );
});

test("a path change alone changes the key", () => {
  // The path is what `⌘S` writes back to, so two comparisons that differ only in
  // origin are not the same comparison.
  const a = session(side({ text: "x", path: "/p/a.txt" }), side({ text: "y" }));
  const b = session(side({ text: "x", path: "/p/b.txt" }), side({ text: "y" }));
  assert.notEqual(sessionKey(a), sessionKey(b));
});

// --- formatting ------------------------------------------------------------

test("formatSize keeps small counts exact and abbreviates large ones", () => {
  assert.equal(formatSize(0), "0");
  assert.equal(formatSize(999), "999");
  assert.equal(formatSize(1000), "1.0k");
  assert.equal(formatSize(1234), "1.2k");
  assert.equal(formatSize(1_000_000), "1.0M");
});

test("formatTime is zero-padded HH:MM in local time", () => {
  const at = new Date(2024, 2, 5, 9, 7, 42).getTime();
  assert.equal(formatTime(at), "09:07");
});

// --- day grouping ----------------------------------------------------------

const labels = { today: "Today", yesterday: "Yesterday" };
const noon = (y: number, m: number, d: number): number => new Date(y, m, d, 12, 0, 0).getTime();

test("the same calendar day is today, even late at night", () => {
  const now = noon(2024, 2, 5);
  assert.equal(dayGroup(noon(2024, 2, 5), now, labels), "Today");
  // 00:01 of the same day, not "yesterday" despite being ~36 hours earlier.
  assert.equal(dayGroup(new Date(2024, 2, 5, 0, 1).getTime(), now, labels), "Today");
});

test("the previous calendar day is yesterday", () => {
  const now = noon(2024, 2, 5);
  assert.equal(dayGroup(new Date(2024, 2, 4, 23, 59).getTime(), now, labels), "Yesterday");
});

test("two days back is a date, with the year only when it differs", () => {
  // Month indices are zero-based: `2` is March.
  // Month indices are zero-based: `2` is March.
  const now = noon(2024, 2, 5);
  assert.equal(dayGroup(noon(2024, 2, 3), now, labels), "03-03");
  assert.equal(dayGroup(noon(2023, 11, 30), now, labels), "2023-12-30");
});

// --- round trip ------------------------------------------------------------

test("a session survives a save/restore round trip", () => {
  const original = session(
    side({ label: "a.go", path: "/p/a.go", text: "package a\n" }),
    side({ label: "b.go", path: null, text: "package b\n" }),
    { options: { ...session(side(), side()).options, ignore_case: true } },
  );

  const entry = entryFromSession(original, 1_700_000_000_000);
  assert.equal(entry.createdAt, 1_700_000_000_000);
  assert.equal(entry.left.text, "package a\n");

  const restored = sessionFromEntry(entry);
  assert.equal(restored.left.text, original.left.text);
  assert.equal(restored.right.text, original.right.text);
  assert.equal(restored.left.path, "/p/a.go");
  assert.equal(restored.right.path, null, "a pasted side stays path-less");
  assert.equal(restored.options.ignore_case, true);
});

test("a restored session carries no diff result and no git origin", () => {
  /*
   * Both are deliberate. A stored result would go stale as soon as an option
   * changed, and a restored git side is text without a revision context —
   * keeping a stale `git` marker would make `⌘S` believe it may write a blob.
   */
  const entry = entryFromSession(session(side({ text: "a" }), side({ text: "b" })), 1);
  const restored = sessionFromEntry(entry);
  assert.deepEqual(restored.result.rows, []);
  assert.equal(restored.result.hunks.length, 0);
  assert.equal(restored.left.git, null);
  assert.equal(restored.right.git, null);
});
