import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKTREE,
  basename,
  canCompare,
  day,
  describeRev,
  dirname,
  filterFiles,
  fuzzyBranches,
  fuzzyScore,
  firstRef,
  isWorktree,
  slotOf,
} from "../src/lib/git.ts";

// Slot placeholders are supplied by the caller so `describeRev` stays language-free.
const LABELS = { unassigned: "unassigned", worktree: "worktree" };

const commit = (sha: string, short: string, subject = "s") => ({
  sha,
  short,
  date: "2024-05-06T10:11:12+08:00",
  author: "Tal",
  subject,
  refs: "",
});

// --- revision labels --------------------------------------------------------

// An empty slot and a slot holding an unrecognised revision are different states:
// the first is "nothing assigned yet", the second is a real assignment. Rendering
// "" for the first would look like a rendering bug.
test("an unassigned slot has its own label, not an empty string", () => {
  assert.equal(describeRev(null, [], LABELS), "unassigned");
});

test("the working tree is named, not shown as its sentinel", () => {
  assert.equal(describeRev(WORKTREE, [], LABELS), "worktree");
  assert.ok(!describeRev(WORKTREE, [], LABELS).includes("WORKTREE"));
});

test("a known commit shows its short sha", () => {
  assert.equal(describeRev("abc1234def", [commit("abc1234def", "abc1234")], LABELS), "abc1234");
});

// The commit list is capped, so an assigned revision may not be in it. It is
// still valid, and must not be reported as missing.
test("an assigned revision outside the loaded list is abbreviated, not dropped", () => {
  assert.equal(describeRev("0123456789abcdef", [], LABELS), "0123456");
});

test("only the sentinel counts as the working tree", () => {
  assert.ok(isWorktree(WORKTREE));
  assert.ok(!isWorktree("HEAD"));
  assert.ok(!isWorktree(null));
  assert.ok(!isWorktree("worktree"));
});

// --- file filtering ---------------------------------------------------------

test("an empty query returns the list unchanged", () => {
  const files = ["src/a.ts", "README.md"];
  assert.deepEqual(filterFiles(files, ""), files);
});

test("filtering is case-insensitive and substring-based", () => {
  const files = ["src/App.svelte", "src/lib/theme.ts", "README.md"];
  assert.deepEqual(filterFiles(files, "THEME"), ["src/lib/theme.ts"]);
  assert.deepEqual(filterFiles(files, "  src  "), ["src/App.svelte", "src/lib/theme.ts"]);
});

// Truncating *before* filtering would make files past the cap unfindable, which
// is exactly the case the filter exists for.
test("the cap applies after matching, so late files stay findable", () => {
  const files = Array.from({ length: 500 }, (_, i) => `f${i}.txt`);
  files.push("zzz/target.txt");
  const hit = filterFiles(files, "target", 10);
  assert.deepEqual(hit, ["zzz/target.txt"]);
});

test("the cap bounds how many rows are rendered", () => {
  const files = Array.from({ length: 500 }, (_, i) => `f${i}.txt`);
  assert.equal(filterFiles(files, "", 25).length, 25);
});

test("a cap of zero returns nothing rather than the whole list", () => {
  assert.deepEqual(filterFiles(["a"], "", 0), []);
});

test("no matches yields an empty array", () => {
  assert.deepEqual(filterFiles(["a.ts"], "nope"), []);
});

// --- slot assignment --------------------------------------------------------

test("a commit can occupy either slot or both", () => {
  assert.equal(slotOf("aaa", "aaa", null), "left");
  assert.equal(slotOf("aaa", null, "aaa"), "right");
  // Comparing a commit against itself is a legal, empty comparison — not a
  // half-finished assignment to be corrected.
  assert.equal(slotOf("aaa", "aaa", "aaa"), "both");
  assert.equal(slotOf("aaa", null, null), null);
  assert.equal(slotOf("aaa", "bbb", "ccc"), null);
});

// --- runnability ------------------------------------------------------------

test("a comparison needs a file and both slots", () => {
  assert.ok(canCompare("a.ts", "x", "y"));
  assert.ok(!canCompare("", "x", "y"), "no file selected");
  assert.ok(!canCompare("a.ts", null, "y"), "left empty");
  assert.ok(!canCompare("a.ts", "x", null), "right empty");
});

// --- path presentation ------------------------------------------------------

test("basename is the last segment", () => {
  assert.equal(basename("src/lib/theme.ts"), "theme.ts");
  assert.equal(basename("README.md"), "README.md");
  // A path with non-ASCII characters must survive unchanged.
  assert.equal(basename("文档/说明.md"), "说明.md");
});

test("dirname is empty for a root-level file", () => {
  assert.equal(dirname("README.md"), "");
  assert.equal(dirname("src/lib/theme.ts"), "src/lib");
  // A leading slash must not produce an empty directory for "/a.ts": the file is
  // at the repository root, so there is no directory to show.
  assert.equal(dirname("/a.ts"), "");
});

// --- date and refs ----------------------------------------------------------

test("day keeps only the calendar date", () => {
  assert.equal(day("2024-05-06T10:11:12+08:00"), "2024-05-06");
});

// %D is comma-separated; only the first is shown, and it must be trimmed so the
// chip does not render with leading whitespace.
test("only the first ref decoration is used", () => {
  assert.equal(firstRef("HEAD -> main, origin/main, tag: v1"), "HEAD -> main");
  assert.equal(firstRef("origin/main"), "origin/main");
  assert.equal(firstRef(""), "");
});

// --- fuzzy branch search -----------------------------------------------------
//
// Subsequence matching, not substring: a list of forty branches is only usable if
// four characters can find the one you mean. These assert the ranking rules, which
// are the part that decides whether the branch you wanted is on screen.

test("an empty query keeps every branch in its original order", () => {
  const branches = [{ name: "main" }, { name: "feature/x" }];
  assert.deepEqual(fuzzyBranches(branches, ""), branches);
});

test("a subsequence matches, in order", () => {
  assert.ok(fuzzyScore("feature/seedance-2.5-30s", "f2s") !== null);
  // Out of order is not a match: "s2f" must not find this branch.
  assert.equal(fuzzyScore("feature/seedance-2.5-30s", "s2f"), null);
});

test("a query that is not a subsequence does not match", () => {
  assert.equal(fuzzyScore("main", "xyz"), null);
  assert.equal(fuzzyScore("main", "mainx"), null, "longer than the name");
});

test("a prefix scores higher than a scattered match", () => {
  const prefix = fuzzyScore("feature/login", "feat");
  const scattered = fuzzyScore("fix/everything-about-tokens", "feat");
  assert.ok(prefix !== null && scattered !== null);
  assert.ok(prefix > scattered, `${prefix} should beat ${scattered}`);
});

test("consecutive characters beat the same characters spread out", () => {
  const consecutive = fuzzyScore("feature", "feat");
  const spread = fuzzyScore("f-e-a-t-ures", "feat");
  assert.ok(consecutive !== null && spread !== null);
  assert.ok(consecutive > spread, `${consecutive} should beat ${spread}`);
});

test("a match at a separator scores higher than one mid-word", () => {
  // "s" right after "/" is a word boundary; "s" inside "uses" is not.
  const boundary = fuzzyScore("feature/seedance", "s");
  const inner = fuzzyScore("feature/uses", "s");
  assert.ok(boundary !== null && inner !== null);
  assert.ok(boundary > inner);
});

test("results are ranked best first", () => {
  const branches = [
    { name: "fix/everything-about-tokens" },
    { name: "feature/login" },
    { name: "master" },
  ];
  const found = fuzzyBranches(branches, "feat").map((b) => b.name);
  assert.deepEqual(found, ["feature/login", "fix/everything-about-tokens"]);
});

test("non-matching branches are dropped entirely", () => {
  const branches = [{ name: "main" }, { name: "dev" }];
  assert.deepEqual(
    fuzzyBranches(branches, "zzz"),
    [],
    "an empty result is what shows 'no match'",
  );
});

test("equal scores keep the incoming order", () => {
  // Two names that differ only in a way the score ignores must not be reshuffled:
  // the caller's order is "current branch first", which carries meaning.
  const branches = [{ name: "a/b" }, { name: "a-c" }];
  assert.deepEqual(
    fuzzyBranches(branches, "a").map((b) => b.name),
    ["a/b", "a-c"],
  );
});
