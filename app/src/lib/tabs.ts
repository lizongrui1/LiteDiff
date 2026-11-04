/**
 * Tab list for the comparison workspace.
 *
 * ## Why the tabs live here and not in `App.svelte`
 *
 * `App` is already the whole application shell; adding tab bookkeeping to it would
 * push a single component past the point where its state can be reasoned about.
 * More importantly, the rules below are the kind that can be wrong in ways that are
 * invisible in the window — a closed tab that leaves the active index pointing at
 * nothing, a restored tab whose neighbours reorder — and they are testable here
 * without a DOM.
 *
 * ## What a tab holds
 *
 * Everything needed to put the screen back exactly as it was: the session, the
 * view mode, the fold set, the scroll offset. Not the settings and not the side
 * sheets — those are global, and restoring a per-tab theme would make switching
 * tabs feel like switching applications.
 *
 * The `Session` itself is the big object (megabytes for a large file). Tabs share
 * whatever the backend already produced rather than copying it: a tab stores the
 * reference, and switching tabs is a pointer move.
 */

import type { Session } from "./types";

/** One open comparison. */
export interface Tab {
  /** Stable identity, used as the `{#each}` key and for lookups. */
  id: string;
  session: Session;
  view: "split" | "unified";
  /** Hunk indices the user expanded in this tab. */
  expanded: Set<number>;
  scrollTop: number;
  scrollLeft: number;
}

/**
 * Label for the tab strip.
 *
 * Both filenames when both sides came from disk, because that is the one piece of
 * information a diff cannot show about itself — two tabs of the same file at
 * different revisions are otherwise indistinguishable. A pasted side contributes
 * nothing, so it degrades to the single known name rather than showing
 * "Pasted text ↔ Pasted text" on every tab.
 */
export function tabLabel(
  session: Session,
  pastedLabel: string,
  untitledLabel: string = pastedLabel,
): string {
  const name = (side: Session["left"]): string => {
    const source = side.path ?? side.git?.file ?? "";
    if (!source) return "";
    return source.split("/").pop() || source;
  };
  const left = name(session.left);
  const right = name(session.right);
  if (left && right) {
    // The same file on both sides differs only by revision, so the revision is
    // what distinguishes them; showing "a.go ↔ a.go" would be useless.
    if (left === right) {
      const l = session.left.git?.short;
      const r = session.right.git?.short;
      if (l || r) return `${left} ${l ?? pastedLabel} ↔ ${r ?? pastedLabel}`;
      return left;
    }
    return `${left} ↔ ${right}`;
  }
  if (left) return left;
  if (right) return right;
  /*
   * Nothing came from disk. A tab with no text at all is one the user just created
   * with "+" and has not filled in yet; calling it "pasted" would claim a comparison
   * exists. Both fall back to a positional name rather than an empty tab.
   */
  if (session.left.text === "" && session.right.text === "") return untitledLabel;
  return pastedLabel;
}

/**
 * Next id.
 *
 * A counter, not a timestamp or a hash of the content: two tabs may legitimately
 * show identical content (the same two pasted blocks compared twice), and they must
 * still be separate tabs. Uniqueness within a session is all that is needed.
 */
let nextId = 1;

export function createTab(session: Session): Tab {
  return {
    id: `tab-${nextId++}`,
    session,
    view: "split",
    expanded: new Set(),
    scrollTop: 0,
    scrollLeft: 0,
  };
}

/**
 * An empty comparison, for a tab the user has opened but not filled in.
 *
 * The tab strip has to show a new tab the moment "+" is pressed, otherwise the
 * button appears to do nothing until text arrives — which is exactly the report
 * this exists to fix. That state still needs a session, and this is the honest
 * one: two blank sides and an empty diff.
 *
 * `hasContent` is what distinguishes it from a real comparison, so the paste
 * screen renders inside it — an empty tab looks exactly like a fresh launch.
 */
export function emptySession(): Session {
  return {
    left: { path: null, label: "", text: "", git: null },
    right: { path: null, label: "", text: "", git: null },
    result: {
      left_line_count: 0,
      right_line_count: 0,
      rows: [],
      hunks: [],
      stats: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
    },
    options: {
      algorithm: "myers",
      ignore_whitespace: false,
      ignore_all_whitespace: false,
      ignore_case: false,
      intra_line: true,
      intra_line_max_tokens: 0,
    },
    warnings: [],
  };
}

/** A blank tab, for the "+" button. */
export function createEmptyTab(): Tab {
  return createTab(emptySession());
}

/**
 * Index of the tab that should become active after `index` is closed.
 *
 * Takes the closed tab's position and the *new* length. Closing the last tab
 * activates the new last one, so the active index never leaves the array; returning
 * the old index would point one past the end and blank the window.
 */
export function indexAfterClose(index: number, newLength: number): number {
  if (newLength <= 0) return -1;
  return Math.min(index, newLength - 1);
}

/**
 * Move a tab, for drag-to-reorder.
 *
 * Returns the new order rather than mutating: the caller holds a reactive array and
 * needs the reassignment to trigger a re-render.
 */
export function moveTab<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...list];
  if (from < 0 || from >= list.length) return [...list];
  const clamped = Math.max(0, Math.min(list.length - 1, to));
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(clamped, 0, item);
  return out;
}

/**
 * Whether a session is worth reopening as a tab.
 *
 * A tab with no content on either side is the paste screen, and the paste screen is
 * not a tab — closing the last comparison should return to it, not leave an empty
 * tab behind.
 */
export function hasContent(session: Session): boolean {
  return session.left.text !== "" || session.right.text !== "";
}

/**
 * Disambiguate labels that repeat, by appending their ordinal.
 *
 * Pressing "+" three times produced three tabs all reading "New comparison", which
 * leaves the user guessing which one they are about to click. Only the duplicated
 * labels are numbered, so a strip of distinct filenames stays clean — numbering
 * everything would add "a.go 1" for no benefit.
 *
 * The ordinal counts occurrences in strip order, so closing the second of three
 * renumbers the third rather than leaving a gap.
 *
 * A label that *could* repeat is numbered from the first one, even when it is
 * currently alone. Numbering only actual duplicates made a single "New comparison"
 * rename itself to "New comparison 1" the moment a second tab was opened, which
 * looks like the tab being replaced. `mayRepeat` is what the caller knows and the
 * label alone does not.
 */
export function numberLabels<T>(
  items: readonly T[],
  labelOf: (item: T) => string,
  mayRepeat: (item: T) => boolean = () => false,
): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = labelOf(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return items.map((item) => {
    const label = labelOf(item);
    const repeats = (counts.get(label) ?? 0) > 1 || mayRepeat(item);
    if (!repeats) return label;
    const next = (seen.get(label) ?? 0) + 1;
    seen.set(label, next);
    return `${label} ${next}`;
  });
}
