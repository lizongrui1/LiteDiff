import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyTab,
  createTab,
  emptySession,
  hasContent,
  indexAfterClose,
  moveTab,
  normalizeTabName,
  numberLabels,
  renameTab,
  tabLabel,
} from "../src/lib/tabs.ts";
import type { Session, Side } from "../src/lib/types.ts";

/*
 * Tab bookkeeping. Every failure mode here is an index bug that blanks the window
 * or activates the wrong comparison, and none of them are visible in a type check.
 */

const side = (over: Partial<Side> = {}): Side => ({
  path: null,
  label: "",
  text: "x\n",
  git: null,
  ...over,
});

const session = (left: Side, right: Side): Session => ({
  left,
  right,
  result: {
    left_line_count: 1,
    right_line_count: 1,
    rows: [],
    hunks: [],
    stats: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
    approximate: false,
  },
  options: {
    ignore_whitespace: false,
    ignore_all_whitespace: false,
    ignore_case: false,
    intra_line: false,
    intra_line_max_tokens: 0,
  },
  warnings: [],
  contentKey: "",
});

// --- identity ---------------------------------------------------------------

// Two tabs may legitimately show identical content (the same two pasted blocks
// compared twice), so ids must be unique by construction, not by content.
test("tabs created from identical sessions get distinct ids", () => {
  const a = createTab(session(side(), side()));
  const b = createTab(session(side(), side()));
  assert.notEqual(a.id, b.id);
});

test("a new tab starts in split view with nothing expanded", () => {
  const tab = createTab(session(side(), side()));
  assert.equal(tab.name, null);
  assert.equal(tab.view, "split");
  assert.equal(tab.expanded.size, 0);
  assert.equal(tab.scrollTop, 0);
});

// --- labels -----------------------------------------------------------------

test("both filenames are shown when both sides came from disk", () => {
  const label = tabLabel(
    session(side({ path: "/a/foo.go" }), side({ path: "/b/bar.go" })),
    "pasted",
  );
  assert.equal(label, "foo.go ↔ bar.go");
});

// The same file at two revisions is the case where a plain filename says nothing:
// both sides would read "const.go" and the tab would be unidentifiable.
test("the same file at two revisions is distinguished by revision", () => {
  const git = (short: string) => ({
    repo: "/r",
    rev: "abc",
    file: "src/const.go",
    short,
    writable: false,
  });
  const label = tabLabel(
    session(
      side({ path: null, git: git("1111111") }),
      side({ path: null, git: git("2222222") }),
    ),
    "pasted",
  );
  assert.ok(label.includes("const.go"));
  assert.ok(label.includes("1111111") && label.includes("2222222"), label);
});

// A pasted side contributes no name, so the label degrades to the one known name
// instead of reading "foo.go ↔ pasted".
test("one named side produces just that name", () => {
  assert.equal(tabLabel(session(side({ path: "/a/foo.go" }), side()), "pasted"), "foo.go");
  assert.equal(tabLabel(session(side(), side({ path: "/b/bar.go" })), "pasted"), "bar.go");
});

test("two pasted sides fall back to the provided label", () => {
  assert.equal(tabLabel(session(side(), side()), "pasted"), "pasted");
});

test("the label never wraps onto a full path", () => {
  const label = tabLabel(session(side({ path: "/deep/nested/dir/file.ts" }), side()), "p");
  assert.equal(label, "file.ts");
});

test("a custom tab name overrides the session-derived label", () => {
  const s = session(side({ path: "/a/foo.go" }), side({ path: "/b/bar.go" }));
  assert.equal(tabLabel(s, "Pasted", "New", "Release check"), "Release check");
});

test("a whitespace-only custom name restores the automatic label", () => {
  const s = session(side({ path: "/a/foo.go" }), side());
  assert.equal(normalizeTabName(" \n\t "), null);
  assert.equal(tabLabel(s, "Pasted", "New", "   "), "foo.go");
});

test("renaming trims the name and preserves tab identity and order", () => {
  const a = createTab(session(side(), side()));
  const b = createTab(session(side(), side()));
  const before = [a, b];
  const after = renameTab(before, a.id, "  Release check  ");

  assert.deepEqual(
    after.map((tab) => tab.id),
    [a.id, b.id],
  );
  assert.equal(after[0].name, "Release check");
  assert.equal(after[1], b, "unrelated tabs keep their identity");
  assert.equal(a.name, null, "the input array is not mutated");
});

test("renaming to blank restores automatic naming", () => {
  const tab = createTab(session(side({ path: "/a/foo.go" }), side()));
  const named = renameTab([tab], tab.id, "Custom");
  const restored = renameTab(named, tab.id, "  ");

  assert.equal(restored[0].name, null);
  assert.equal(tabLabel(restored[0].session, "Pasted", "New", restored[0].name), "foo.go");
});

// --- closing ----------------------------------------------------------------

// The bug this guards: closing the last tab while it was active must return to the
// paste screen (-1), not leave an index pointing past the end of an empty array.
test("closing the only tab yields no active index", () => {
  assert.equal(indexAfterClose(0, 0), -1);
});

test("closing a middle tab activates the one that took its place", () => {
  // [A,B,C] with B (index 1) closed → [A,C]; the neighbour at index 1 is C.
  assert.equal(indexAfterClose(1, 2), 1);
});

test("closing the last tab activates the new last one", () => {
  // [A,B,C] with C (index 2) closed → [A,B]; index 2 is out of range, so B.
  assert.equal(indexAfterClose(2, 2), 1);
});

test("closing the first tab activates the one after it", () => {
  assert.equal(indexAfterClose(0, 2), 0);
});

// --- reordering -------------------------------------------------------------

test("moving a tab forward places it at the target index", () => {
  assert.deepEqual(moveTab(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
});

test("moving a tab backward places it at the target index", () => {
  assert.deepEqual(moveTab(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
});

test("moving a tab onto itself changes nothing", () => {
  assert.deepEqual(moveTab(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
});

// A drop can land outside the list when the pointer leaves the strip; clamping is
// what keeps that from producing a hole.
test("an out-of-range destination is clamped", () => {
  assert.deepEqual(moveTab(["a", "b", "c"], 0, 99), ["b", "c", "a"]);
  assert.deepEqual(moveTab(["a", "b", "c"], 2, -5), ["c", "a", "b"]);
});

test("an out-of-range source is ignored", () => {
  assert.deepEqual(moveTab(["a", "b"], 5, 0), ["a", "b"]);
});

// The caller holds a reactive array; returning a new one is what triggers the
// re-render, so the input must never be mutated.
test("moving returns a new array and leaves the input alone", () => {
  const input = ["a", "b", "c"];
  const out = moveTab(input, 0, 1);
  assert.notEqual(out, input);
  assert.deepEqual(input, ["a", "b", "c"]);
});

// --- content ----------------------------------------------------------------

// A tab with nothing in it is the paste screen, and the paste screen is not a tab:
// closing the last comparison should leave no empty tab behind.
test("a session with no text on either side has no content", () => {
  assert.ok(!hasContent(session(side({ text: "" }), side({ text: "" }))));
});

test("content on either side is enough", () => {
  assert.ok(hasContent(session(side({ text: "a\n" }), side({ text: "" }))));
  assert.ok(hasContent(session(side({ text: "" }), side({ text: "b\n" }))));
});

// --- accumulation ------------------------------------------------------------
//
// The bug this guards: `commit` appended a new comparison with `tabs = [tab]`
// instead of `tabs = [...tabs, tab]`. Both are well-typed, and the second one
// silently destroyed every open comparison — the exact thing tabs exist to prevent.
// A behaviour test cannot see it (it lives in a component), so the source is
// asserted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appSource = readFileSync(
  fileURLToPath(new URL("../src/App.svelte", import.meta.url)),
  "utf8",
);

test("committing into an empty tab fills it instead of appending another", () => {
  /*
   * The shape that matters: "+" creates the tab up front, so `commit` must not
   * create a second one. The earlier version created the tab only on commit,
   * which is why pressing "+" appeared to do nothing.
   *
   * Reading the source rather than mounting the component: `commit` needs the
   * whole backend, and the failure this guards against is a one-line assignment
   * that no type checker would notice.
   */
  const fn = appSource.slice(
    appSource.indexOf("async function commit"),
    appSource.indexOf("function openNewTab"),
  );
  assert.ok(fn.length > 0, "could not locate commit");

  // Only executable lines: the explanatory comments quote the other shapes.
  const code = fn
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  assert.match(
    code,
    /tabs\s*=\s*tabs\.map\(\(tab\)\s*=>/,
    "an existing tab is updated in place",
  );
  assert.ok(
    !/tabs\s*=\s*\[tab\]/.test(code),
    "assigning a fresh array here discards every other comparison",
  );
});

test("the new-tab button creates a tab immediately", () => {
  const fn = appSource.slice(
    appSource.indexOf("function openNewTab"),
    appSource.indexOf("function activateTab"),
  );
  assert.ok(fn.length > 0, "could not locate openNewTab");

  const code = fn
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  assert.match(code, /createEmptyTab\(\)/, "the tab is created up front");
  assert.match(code, /tabs\s*=\s*\[\.\.\.tabs,\s*tab\]/, "and appended to the strip");
  assert.match(code, /activeId\s*=\s*tab\.id/, "and becomes the active tab");
  assert.ok(
    !/activeId\s*=\s*null/.test(code),
    "clearing the pointer leaves the strip unchanged, which is the bug",
  );
});

// --- blank tabs --------------------------------------------------------------
//
// Pressing "+" has to produce a tab immediately. That tab is a real `Tab` whose
// session is empty, so the paste screen renders inside it and the strip shows what
// the user just created.

test("an empty session has no content, so the paste screen shows", () => {
  const blank = createEmptyTab();
  assert.equal(hasContent(blank.session), false);
});

test("an empty tab is a normal tab otherwise", () => {
  const blank = createEmptyTab();
  assert.equal(blank.view, "split");
  assert.equal(blank.scrollTop, 0);
  assert.equal(blank.expanded.size, 0);
});

test("each blank tab gets its own identity", () => {
  // Two "+" presses in a row must produce two tabs; a shared id would make the
  // strip collapse them into one under its keyed `{#each}`.
  const a = createEmptyTab();
  const b = createEmptyTab();
  assert.notEqual(a.id, b.id);
});

test("a blank session has both sides and no diff rows", () => {
  const s = emptySession();
  assert.equal(s.left.text, "");
  assert.equal(s.right.text, "");
  assert.equal(s.left.path, null);
  assert.deepEqual(s.result.rows, []);
  assert.equal(s.result.stats.added, 0);
});

test("filling an empty session makes it a real comparison", () => {
  // What `commit` relies on: the same tab object becomes "having content" once the
  // documents land in it, so `hasContent` switches the pane from paste screen to diff.
  const blank = emptySession();
  const filled: Session = {
    ...blank,
    left: { ...blank.left, text: "a\n" },
    right: { ...blank.right, text: "b\n" },
  };
  assert.equal(hasContent(blank), false);
  assert.equal(hasContent(filled), true);
});

test("a blank tab is labelled as new, not as a pasted comparison", () => {
  // "Pasted comparison" would claim a comparison exists when the tab is empty.
  assert.equal(tabLabel(emptySession(), "Pasted", "New"), "New");
});

test("a filled-in pasted comparison keeps the pasted label", () => {
  const s = emptySession();
  s.left.text = "a\n";
  assert.equal(tabLabel(s, "Pasted", "New"), "Pasted");
});

test("a file name wins over both fallbacks", () => {
  const s = emptySession();
  s.left.path = "/p/a.go";
  s.left.text = "a\n";
  assert.equal(tabLabel(s, "Pasted", "New"), "a.go");
});

test("repeated blank tabs are numbered so they can be told apart", () => {
  // Three "+" presses produced three tabs all reading "New comparison": the strip
  // gave the user no way to know which one they were clicking.
  const labels = numberLabels(
    [
      { id: "a", label: "New" },
      { id: "b", label: "New" },
      { id: "c", label: "a.go" },
      { id: "d", label: "New" },
    ],
    (t) => t.label,
  );
  assert.deepEqual(labels, ["New 1", "New 2", "a.go", "New 3"]);
});

test("a label that appears once is not numbered", () => {
  const labels = numberLabels(
    [
      { id: "a", label: "a.go" },
      { id: "b", label: "b.go" },
    ],
    (t) => t.label,
  );
  assert.deepEqual(labels, ["a.go", "b.go"]);
});

test("a label that may repeat is numbered from the first one", () => {
  // Otherwise the only blank tab reads "New comparison" and renames itself to
  // "New comparison 1" when a second one is opened, as if it had been replaced.
  const labels = numberLabels(
    [{ id: "a", label: "New", repeatable: true }],
    (t) => t.label,
    (t) => t.repeatable,
  );
  assert.deepEqual(labels, ["New 1"]);
});

test("numbering does not depend on there being a duplicate yet", () => {
  const labels = numberLabels(
    [
      { id: "a", label: "New", repeatable: true },
      { id: "b", label: "New", repeatable: true },
    ],
    (t) => t.label,
    (t) => t.repeatable,
  );
  assert.deepEqual(labels, ["New 1", "New 2"]);
});

test("an explicitly named blank tab is not force-numbered", () => {
  const tab = { ...createEmptyTab(), name: "Notes" };
  const labels = numberLabels(
    [tab],
    (item) => tabLabel(item.session, "Pasted", "New", item.name),
    (item) => item.name === null && !hasContent(item.session),
  );
  assert.deepEqual(labels, ["Notes"]);
});

test("duplicate custom tab names are still numbered", () => {
  const a = { ...createEmptyTab(), name: "Notes" };
  const b = { ...createEmptyTab(), name: "Notes" };
  const labels = numberLabels(
    [a, b],
    (item) => tabLabel(item.session, "Pasted", "New", item.name),
    (item) => item.name === null && !hasContent(item.session),
  );
  assert.deepEqual(labels, ["Notes 1", "Notes 2"]);
});
