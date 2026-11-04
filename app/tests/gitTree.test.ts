import { test } from "node:test";
import assert from "node:assert/strict";
import { allDirs, buildTree, type FileRow } from "../src/lib/git.ts";
import {
  emptySnapshot,
  getGitPanelState,
  resetGitPanelState,
  setGitPanelState,
} from "../src/lib/gitSession.ts";

const rowsFor = (files: string[], expanded: string[] = []) =>
  buildTree(files, new Set(expanded));

const pathsOf = (rows: FileRow[]) => rows.map((r) => (r.isDir ? `${r.path}/` : r.path));

// --- tree shape -------------------------------------------------------------

// The default view is collapsed, so only top-level entries are visible. A tree
// that emitted every file regardless of `expanded` would not be a tree.
test("a collapsed tree shows only its top level", () => {
  const rows = rowsFor(["src/a.ts", "src/b.ts", "README.md"]);
  assert.deepEqual(pathsOf(rows), ["src/", "README.md"]);
});

test("expanding a directory reveals its files", () => {
  const rows = rowsFor(["src/a.ts", "src/b.ts", "README.md"], ["src"]);
  assert.deepEqual(pathsOf(rows), ["src/", "src/a.ts", "src/b.ts", "README.md"]);
});

// A chain of single-child directories is *one* row, so the key that controls it is
// the deepest path in the chain — `src/lib`, not `src`. Expanding an intermediate
// path therefore has no effect, which matches the row the user actually clicks.
test("a collapsed chain is keyed by its deepest path", () => {
  const files = ["src/lib/theme.ts"];
  assert.deepEqual(pathsOf(rowsFor(files, [])), ["src/lib/"]);
  assert.deepEqual(pathsOf(rowsFor(files, ["src"])), ["src/lib/"], "mid-chain key is inert");
  assert.deepEqual(pathsOf(rowsFor(files, ["src/lib"])), ["src/lib/", "src/lib/theme.ts"]);
});

test("depth counts rows, not path segments", () => {
  const files = ["src/lib/theme.ts"];
  const collapsed = rowsFor(files, []);
  assert.equal(collapsed[0].depth, 0);
  // One visible row above it, even though the path names two directories.
  const open = rowsFor(files, ["src/lib"]);
  assert.equal(open[1].depth, 1);
});

// A Java/Go layout is a chain of single-child directories. One row per level would
// push every file off screen; the chain collapses into one label instead.
test("a single-child directory chain collapses into one row", () => {
  const files = ["src/main/java/com/company/App.java"];
  const rows = rowsFor(files, []);
  assert.deepEqual(pathsOf(rows), ["src/main/java/com/company/"]);
  assert.equal(rows[0].name, "src/main/java/com/company");
  assert.equal(rows[0].fileCount, 1);

  const open = rowsFor(files, ["src/main/java/com/company"]);
  assert.deepEqual(pathsOf(open), [
    "src/main/java/com/company/",
    "src/main/java/com/company/App.java",
  ]);
});

// Collapsing must stop where a directory owns files directly: otherwise those
// files would render as children of the collapsed label and look misplaced.
test("collapsing stops at a directory that contains files directly", () => {
  const files = ["src/main.go", "src/lib/deep/x.go"];
  const names = rowsFor(files, []).map((r) => r.name);
  assert.ok(names.includes("src"), names.join(","));
  assert.ok(!names.includes("src/lib"), names.join(","));
});

test("directories sort before files, then alphabetically", () => {
  const rows = rowsFor(["b.txt", "a.txt", "zdir/x", "adir/y"], ["zdir", "adir"]);
  assert.deepEqual(pathsOf(rows), [
    "adir/",
    "adir/y",
    "zdir/",
    "zdir/x",
    "a.txt",
    "b.txt",
  ]);
});

test("a file row is selectable and carries its directory", () => {
  const rows = rowsFor(["src/lib/theme.ts"], ["src/lib"]);
  const file = rows.find((r) => !r.isDir)!;
  assert.equal(file.path, "src/lib/theme.ts");
  assert.equal(file.name, "theme.ts");
  assert.equal(file.dir, "src/lib");
  // One directory row is visible above it, so depth is 1 rather than 2.
  assert.equal(file.depth, 1);
});

test("a directory row reports how many files it contains", () => {
  const rows = rowsFor(["src/a.ts", "src/b.ts", "src/nested/c.ts"], ["src"]);
  const dir = rows.find((r) => r.isDir)!;
  assert.equal(dir.fileCount, 3, "nested files count too");
});

test("the row cap bounds output even when everything is expanded", () => {
  const files = Array.from({ length: 200 }, (_, i) => `d/f${i}.txt`);
  const rows = buildTree(files, new Set(["d"]), 25);
  assert.equal(rows.length, 25);
});

test("an empty file list produces no rows", () => {
  assert.deepEqual(rowsFor([]), []);
});

// --- directory enumeration --------------------------------------------------

// Used to expand the tree on open: a picker that starts fully collapsed hides the
// files it exists to show.
test("allDirs lists every directory, deepest included, never the file itself", () => {
  const dirs = allDirs(["a/b/c.txt", "a/d.txt", "e.txt"]).sort();
  assert.deepEqual(dirs, ["a", "a/b"]);
});

test("allDirs ignores a root-level file", () => {
  assert.deepEqual(allDirs(["README.md"]), []);
});

// --- panel memory -----------------------------------------------------------

// The panel unmounts on close, so anything not stored here is lost and the user
// comes back to 未选择仓库.
test("the panel snapshot round-trips through the module store", () => {
  resetGitPanelState();
  setGitPanelState({
    repo: { root: "/r", name: "r", relativePath: "", branch: "main" },
    files: ["a.ts", "b.ts"],
    file: "b.ts",
    leftRev: "WORKTREE",
    rightRev: "abc1234",
    filter: "b",
    view: "list",
    expanded: ["src"],
  });

  const back = getGitPanelState();
  assert.equal(back.file, "b.ts");
  assert.equal(back.leftRev, "WORKTREE");
  assert.equal(back.rightRev, "abc1234");
  assert.equal(back.view, "list");
  assert.deepEqual(back.expanded, ["src"]);
});

// A partial write must not erase the fields it does not mention: the panel saves
// from several places, each knowing about only some of the state.
test("a partial update keeps the fields it does not mention", () => {
  resetGitPanelState();
  setGitPanelState({ file: "a.ts", view: "tree" });
  setGitPanelState({ filter: "zz" });

  const back = getGitPanelState();
  assert.equal(back.file, "a.ts");
  assert.equal(back.view, "tree", "a later filter change must not reset the view");
  assert.equal(back.filter, "zz");
});

// The store hands out copies: a caller mutating the returned array must not be
// able to corrupt the stored state behind the panel's back.
test("the snapshot cannot be mutated through the returned object", () => {
  resetGitPanelState();
  setGitPanelState({ expanded: ["a"] });

  const first = getGitPanelState();
  first.expanded.push("b");
  first.file = "mutated";

  const second = getGitPanelState();
  assert.deepEqual(second.expanded, ["a"]);
  assert.equal(second.file, "");
});

test("reset restores a clean snapshot", () => {
  resetGitPanelState();
  setGitPanelState({ file: "x.ts", view: "list" });
  resetGitPanelState();
  assert.deepEqual(getGitPanelState(), emptySnapshot());
});
