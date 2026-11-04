/**
 * Pure helpers for the git history panel.
 *
 * The panel's rendering is thin; what can actually be wrong is the small amount
 * of logic that decides what a revision is called and which files a filter
 * matches. Keeping that here means it is covered by `node --test` instead of only
 * being reachable through a running desktop app.
 */

import type { CommitInfo } from "./types";

/**
 * Revision string meaning "the file on disk right now".
 *
 * Duplicated deliberately from the Rust `git::WORKTREE` constant: it is part of
 * the IPC wire format, not an internal detail, and the two sides must agree on
 * the literal spelling. A shared constant would need code generation for one
 * string.
 */
export const WORKTREE = "WORKTREE";

/** True when a revision refers to the working tree rather than a commit. */
export function isWorktree(rev: string | null | undefined): boolean {
  return rev === WORKTREE;
}

/**
 * Human label for one assigned revision.
 *
 * `null` means "not assigned" and gets its own text: an empty slot and a slot
 * holding an unknown revision are different problems, and showing "" for the
 * first would look like a rendering bug.
 */
export function describeRev(
  rev: string | null,
  commits: CommitInfo[],
  labels: { unassigned: string; worktree: string },
): string {
  if (rev === null) return labels.unassigned;
  if (rev === WORKTREE) return labels.worktree;
  const match = commits.find((c) => c.sha === rev);
  if (match) return match.short;
  // A revision that is not in the visible list is still a valid assignment (the
  // list is capped), so abbreviate rather than reporting it as missing.
  return rev.slice(0, 7);
}

/**
 * Narrow a file list by a case-insensitive substring match.
 *
 * A repository can hold tens of thousands of paths. `cap` bounds how many are
 * rendered, but the *match* is always over the full list: truncating before
 * filtering would make files past the cap unfindable, which is precisely the
 * case the filter exists for.
 */
export function filterFiles(files: string[], query: string, cap = 300): string[] {
  const q = query.trim().toLowerCase();
  const matched = q === "" ? files : files.filter((f) => f.toLowerCase().includes(q));
  return matched.slice(0, Math.max(0, cap));
}

/**
 * Fuzzy match one query against one string.
 *
 * Returns a score (higher is better) or `null` when the query does not match.
 *
 * This is a *subsequence* match, not a substring one: `f2s` matches
 * `feature/seedance-2.5-30s`, which is the whole point of typing four characters
 * into a list of forty branches. Type-ahead that only matched from the start of
 * a name would make every `fix/*` require typing `fix/`.
 *
 * Scoring, in order of weight:
 *
 * - **Consecutive characters** score far more than scattered ones, so `feat`
 *   ranks `feature` above a name where an `f`, `e`, `a`, `t` happen to appear
 *   apart.
 * - **A match at a separator** (`/`, `-`, `_`, `.`, space, or the start) scores
 *   extra, because `s25` finding its `s` just after a `/` is a word boundary
 *   rather than luck.
 * - **An earlier first match** beats a later one, so a prefix match wins ties.
 *
 * An empty query matches everything with score 0, which lets callers use one
 * code path for "no filter" and "filtered".
 */
export function fuzzyScore(text: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const haystack = text.toLowerCase();
  if (q.length > haystack.length) return null;

  const separators = new Set(["/", "-", "_", ".", " "]);
  let score = 0;
  let from = 0;
  let previous = -2;

  for (const ch of q) {
    const found = haystack.indexOf(ch, from);
    if (found === -1) return null;
    // Consecutive run: this character directly follows the previous match.
    if (found === previous + 1) score += 8;
    // Word boundary.
    if (found === 0 || separators.has(haystack[found - 1])) score += 5;
    // Distance penalty, capped so one late character cannot swamp the score.
    score -= Math.min(found - from, 6);
    score += 1;
    previous = found;
    from = found + 1;
  }
  return score;
}

/**
 * Branches matching `query`, best first.
 *
 * Ties keep their incoming order, which is "current branch, then newest", so a
 * query matching several branches equally well still shows the checked-out one
 * first.
 */
export function fuzzyBranches<T extends { name: string }>(
  branches: readonly T[],
  query: string,
): T[] {
  if (query.trim() === "") return [...branches];
  const scored: { item: T; score: number }[] = [];
  for (const item of branches) {
    const score = fuzzyScore(item.name, query);
    if (score !== null) scored.push({ item, score });
  }
  // Stable sort, so equal scores keep the caller's order.
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

/**
 * Which slot a commit currently occupies.
 *
 * Two slots can hold the same revision (comparing a commit against itself), and
 * that state must be distinguishable from "assigned to the left": it is a
 * legitimate request whose diff is empty, not a half-finished assignment.
 */
export function slotOf(
  sha: string,
  left: string | null,
  right: string | null,
): "left" | "right" | "both" | null {
  const l = left === sha;
  const r = right === sha;
  if (l && r) return "both";
  if (l) return "left";
  if (r) return "right";
  return null;
}

/** True when both slots are filled and a comparison can run. */
export function canCompare(file: string, left: string | null, right: string | null): boolean {
  return file !== "" && left !== null && right !== null;
}

/** Last path segment, for a file row's primary label. */
export function basename(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Directory part of a path, for the secondary label.
 *
 * Returned unchanged for a root-level file: an empty string renders as nothing,
 * which is the correct amount of information for a path that has no directory.
 */
export function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** `YYYY-MM-DD` from an ISO-8601 author date; the time of day is noise here. */
export function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * First ref decoration on a commit, if any.
 *
 * `%D` is a comma-separated list (`HEAD -> main, origin/main, tag: v1`). Only the
 * first is shown: the row has room for one, and the most local ref is the one
 * that answers "where am I relative to this commit".
 */
export function firstRef(refs: string): string {
  const first = refs.split(",")[0]?.trim() ?? "";
  return first;
}

// --- file tree ---------------------------------------------------------------

/**
 * One row of the file picker.
 *
 * The list and tree views render the same row type so that selection, history
 * loading and the two assign buttons do not need a second implementation: a tree
 * row carries a `depth` for indentation, a list row carries `0`.
 */
export interface FileRow {
  /** Full repository-relative path. Stable key and the value assigned to a side. */
  path: string;
  /** Label to show: a file's basename, or a directory's (possibly collapsed) name. */
  name: string;
  /** True for a directory row, which is expandable rather than selectable. */
  isDir: boolean;
  /** Indentation level in the tree view; 0 in the list view. */
  depth: number;
  /** For a directory: how many files it contains, recursively. */
  fileCount: number;
  /** Directory part of a file's path, for the list view's secondary label. */
  dir: string;
}

/** A node while the tree is being assembled. */
interface Node {
  name: string;
  /** Empty for the synthetic root. */
  path: string;
  children: Map<string, Node>;
  /** True when this node is a file leaf. */
  file: boolean;
}

function makeNode(name: string, path: string, file = false): Node {
  return { name, path, children: new Map(), file };
}

/**
 * Flatten repository paths into rows.
 *
 * ## Why the tree compresses single-child directories
 *
 * A Java or Go repository is mostly `com/company/project/module/...` — a chain of
 * directories that each contain exactly one thing. Emitting one row per level
 * means the first four rows of the tree are indentation and no information, and
 * the user scrolls to reach anything. Collapsing a chain into one row
 * (`src/main/java/com/company`, which is how editors and Git clients show it) puts
 * every level on screen at once and is the difference between a usable tree and a
 * decorative one.
 *
 * Collapsing stops at a directory that branches *or* that contains files directly
 * — a node with both `foo.go` and `sub/` must keep its own row, or the files would
 * appear to be children of the collapsed name.
 *
 * @param files repository-relative paths, forward slashes
 * @param expanded paths of directories whose contents are visible
 * @param cap maximum rows to return, so a huge repository cannot freeze the sheet
 */
export function buildTree(files: string[], expanded: Set<string>, cap = 400): FileRow[] {
  const root = makeNode("", "", false);

  for (const path of files) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");
      let child = node.children.get(name);
      if (!child) {
        child = makeNode(name, childPath, isLeaf);
        node.children.set(name, child);
      }
      // A path that is both a file and a directory prefix (`a` and `a/b`) cannot
      // happen in git, but a caller could pass it; the file flag wins so the path
      // stays selectable.
      if (isLeaf) child.file = true;
      node = child;
    }
  }

  const rows: FileRow[] = [];

  /** Recursive walk. Returns the number of files under `node`. */
  function walk(node: Node, depth: number): number {
    let total = 0;
    for (const child of sortedChildren(node)) {
      if (child.file && child.children.size === 0) {
        rows.push({
          path: child.path,
          name: child.name,
          isDir: false,
          depth,
          fileCount: 1,
          dir: dirname(child.path),
        });
        total += 1;
        continue;
      }

      // Follow a chain of single-directory children, accumulating both the label
      // and the count, but only if the directory has no files of its own.
      let label = child.name;
      let cursor = child;
      while (
        !cursor.file &&
        cursor.children.size === 1 &&
        !firstChild(cursor).file
      ) {
        cursor = firstChild(cursor);
        label = `${label}/${cursor.name}`;
      }

      const count = countFiles(cursor);
      total += count;
      rows.push({
        path: cursor.path,
        name: label,
        isDir: true,
        depth,
        fileCount: count,
        dir: "",
      });

      if (expanded.has(cursor.path)) {
        walk(cursor, depth + 1);
      }
    }
    return total;
  }

  walk(root, 0);
  return rows.slice(0, Math.max(0, cap));
}

/** Directories first, then files, each alphabetically — the Finder ordering. */
function sortedChildren(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = !(a.file && a.children.size === 0);
    const bDir = !(b.file && b.children.size === 0);
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

function firstChild(node: Node): Node {
  return sortedChildren(node)[0];
}

/** Number of file leaves at or below `node`. */
function countFiles(node: Node): number {
  if (node.file && node.children.size === 0) return 1;
  let total = node.file ? 1 : 0;
  for (const child of node.children.values()) total += countFiles(child);
  return total;
}

/**
 * Every directory path in a file list.
 *
 * Used to expand the tree by default down to the files: a picker that opens fully
 * collapsed hides everything the user came to look at.
 */
export function allDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of files) {
    const parts = path.split("/").filter(Boolean);
    // The last segment is the file itself, so stop before it.
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return [...dirs];
}
