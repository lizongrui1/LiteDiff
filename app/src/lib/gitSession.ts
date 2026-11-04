/**
 * Panel state that outlives the panel.
 *
 * The git sheet is rendered inside an `{#if gitOpen}`, so closing it destroys the
 * component and every `$state` inside it. That is the right default for a
 * transient dialog, but wrong for this one: "open the history of the file I am
 * looking at" is something a user does repeatedly while comparing, and each reopen
 * was back to 未选择仓库 — the repository, the file, the two assigned revisions and
 * the expanded tree all thrown away.
 *
 * The fix is not to keep the panel mounted (an always-present 320px overlay would
 * be far worse) but to hoist the *data* here, where it survives unmount. This is
 * plain module state, not reactive: the panel copies it into `$state` on mount and
 * writes it back as it changes, so there is exactly one writer at a time and no
 * effect loops.
 *
 * Deliberately **not** persisted to `localStorage`. Settings are preferences that
 * should follow the user between launches; this is the working context of one
 * session, and a repository path restored after a restart could point at a
 * deleted checkout. A fresh window legitimately starts with no repository.
 */

import type { RepoInfo } from "./types";

/** Which shape the file picker is in. */
export type FileView = "list" | "tree";

export interface GitPanelSnapshot {
  repo: RepoInfo | null;
  /** Repository-relative paths, as returned by `git_files`. */
  files: string[];
  /** Path of the file whose history is loaded. */
  file: string;
  /** Assigned revision for the left side, or null. */
  leftRev: string | null;
  /** Assigned revision for the right side, or null. */
  rightRev: string | null;
  /** File-picker filter text, kept so a reopen does not lose a narrow search. */
  filter: string;
  /** List or tree; a preference expressed through use, so it persists too. */
  view: FileView;
  /** Directories expanded in the tree view. */
  expanded: string[];
  /**
   * Branch chosen as the left side of a branch-to-branch comparison.
   *
   * The two names are kept even though the file list they produce is not: the pair
   * is a decision ("these are the two branches I am reviewing"), and recomputing
   * the intersection on every reopen would otherwise mean retyping it.
   */
  branchLeft: string;
  /** Branch chosen as the right side. */
  branchRight: string;
  /**
   * Whether the branch list is expanded.
   *
   * A disclosure state is a preference like the list/tree choice, so it survives
   * a reopen; the query is not, because coming back to a filtered list that hides
   * the branch you just switched to would read as "the branches are gone".
   */
  branchesOpen: boolean;
  /**
   * Panel width in px.
   *
   * Width is a *preference* rather than content: the panel is a side sheet over a
   * diff, and how much of that diff you are willing to give up is a judgement the
   * user makes once. It also has to survive a reopen, or dragging it would be
   * pointless.
   */
  width: number;
}

export function emptySnapshot(): GitPanelSnapshot {
  return {
    repo: null,
    files: [],
    file: "",
    leftRev: null,
    rightRev: null,
    filter: "",
    view: "tree",
    expanded: [],
    branchLeft: "",
    branchRight: "",
    branchesOpen: false,
    width: 320,
  };
}

let snapshot: GitPanelSnapshot = emptySnapshot();

/** Read a copy, so a caller cannot mutate the stored state behind our back. */
export function getGitPanelState(): GitPanelSnapshot {
  return { ...snapshot, expanded: [...snapshot.expanded] };
}

/** Replace the stored state, e.g. when the user opens a different repository. */
export function setGitPanelState(next: Partial<GitPanelSnapshot>): void {
  snapshot = { ...snapshot, ...next, expanded: [...(next.expanded ?? snapshot.expanded)] };
}

/** Forget everything, used when a comparison is cleared. */
export function resetGitPanelState(): void {
  snapshot = emptySnapshot();
}
