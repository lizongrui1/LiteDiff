/**
 * Comparison history: retention rules and display formatting.
 *
 * The storage itself is in Rust (one JSON file per entry under the app-data
 * directory); this module holds the rules that decide *what* to keep and how an
 * entry reads in the list. Both are pure, so the tests can drive them without a
 * filesystem or a window.
 */

import type { Session } from "./types";

/** How long entries are kept, and how many. */
export interface Retention {
  /** Delete entries older than this many days. `0` disables the age rule. */
  days: number;
  /** Keep at most this many entries. `0` means unlimited. */
  keep: number;
}

/**
 * Defaults chosen to be forgettable rather than surprising.
 *
 * A week and a hundred entries covers "what was I comparing yesterday" without
 * letting a month of pasted client data accumulate on disk. Both are adjustable,
 * and `0` turns each rule off for anyone who wants an unlimited log.
 */
export const DEFAULT_RETENTION: Retention = { days: 7, keep: 100 };

/** Bounds for the settings inputs, so a typo cannot delete the whole log. */
export const RETENTION_LIMITS = {
  days: { min: 0, max: 365, step: 1 },
  keep: { min: 0, max: 1000, step: 10 },
} as const;

/** One row of the history list, as the backend reports it. */
export interface HistorySummary {
  id: string;
  createdAt: number;
  leftLabel: string;
  rightLabel: string;
  hasPaths: boolean;
  size: number;
}

/** One stored comparison, in full. */
export interface HistoryEntry {
  id: string;
  createdAt: number;
  left: { label: string; path: string | null; text: string; bom?: boolean; lossy?: boolean };
  right: { label: string; path: string | null; text: string; bom?: boolean; lossy?: boolean };
  options: {
    ignoreWhitespace: boolean;
    ignoreAllWhitespace: boolean;
    ignoreCase: boolean;
    intraLine: boolean;
  };
}

/**
 * Entries per entry is capped in Rust; this mirrors the limit for the UI's message.
 *
 * Above it a comparison is not stored at all rather than truncated, because a
 * truncated document would reopen as a *different* comparison.
 */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

/**
 * Whether a session is worth recording.
 *
 * Two empty sides is the paste screen, and recording it would fill the list with
 * rows that reopen to nothing.
 */
export function shouldRecord(session: Session): boolean {
  if (session.left.text === "" && session.right.text === "") return false;
  return session.left.text.length + session.right.text.length <= MAX_ENTRY_BYTES;
}

/**
 * A stable identity for what was compared, ignoring the *result*.
 *
 * Used to avoid recording the same comparison twice when the user toggles an
 * option or switches tabs: the documents are the same, so the earlier entry stands
 * and re-recording would push duplicates into a list the reader scrolls.
 *
 * The options are deliberately excluded. "Ignore whitespace" changes the diff, not
 * the comparison the user is looking at, and a history list that grows on every
 * option toggle is noise.
 */
export function sessionKey(session: Session): string {
  if (session.contentKey) return session.contentKey;
  const side = (s: Session["left"]): string =>
    `${s.path ?? ""}\u0000${s.text.length}\u0000${s.text}`;
  return `${side(session.left)}\u0001${side(session.right)}`;
}

/**
 * Human size for a list row.
 *
 * Characters, not bytes: this is a text tool, and the number is there to warn that
 * an entry is large, not to be exact. One decimal is enough for that.
 */
export function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}`;
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}k`;
  return `${(chars / 1_000_000).toFixed(1)}M`;
}

/**
 * Group label for a timestamp: "今天", "昨天", or a date.
 *
 * Grouping is what makes a list of comparisons scannable — the absolute date of
 * something from three weeks ago is less useful than knowing it is not recent.
 * `now` is injected so the boundaries are testable.
 */
export function dayGroup(
  timestamp: number,
  now: number,
  labels: { today: string; yesterday: string },
): string {
  const startOf = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = startOf(now);
  const day = startOf(timestamp);
  const oneDay = 24 * 60 * 60 * 1000;

  if (day >= today) return labels.today;
  if (day >= today - oneDay) return labels.yesterday;
  const d = new Date(timestamp);
  // Year included only when it is not the current one: "2024-03-05" for an old
  // entry, "03-05" for one from this year, which is shorter and unambiguous.
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${month}-${date}`
    : `${d.getFullYear()}-${month}-${date}`;
}

/** `HH:MM` for a timestamp, in the local timezone. */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Build the entry to persist from a live session.
 *
 * `createdAt` is passed in rather than read here so tests are deterministic.
 */
export function entryFromSession(
  session: Session,
  createdAt: number,
  id = "",
): HistoryEntry {
  return {
    id,
    createdAt,
    left: {
      label: session.left.label,
      path: session.left.path,
      text: session.left.text,
      bom: session.left.bom ?? false,
      lossy: session.left.lossy ?? false,
    },
    right: {
      label: session.right.label,
      path: session.right.path,
      text: session.right.text,
      bom: session.right.bom ?? false,
      lossy: session.right.lossy ?? false,
    },
    options: {
      ignoreWhitespace: session.options.ignore_whitespace,
      ignoreAllWhitespace: session.options.ignore_all_whitespace,
      ignoreCase: session.options.ignore_case,
      intraLine: session.options.intra_line,
    },
  };
}

/**
 * Convert a stored entry back into the session shape the UI diffs.
 *
 * The result is deliberately empty: it is recomputed by the backend from the two
 * texts, because a stored result would go stale as soon as an ignore option
 * changed. The frontend renders whatever the fresh diff returns.
 */
export function sessionFromEntry(entry: HistoryEntry): Session {
  return {
    left: {
      // A history snapshot is not proof that the current file still has these
      // bytes. Without a backend document token it must remain read-only.
      path: null,
      label: entry.left.label,
      text: entry.left.text,
      git: null,
      documentId: null,
      bom: entry.left.bom ?? false,
      lossy: entry.left.lossy ?? false,
    },
    right: {
      path: null,
      label: entry.right.label,
      text: entry.right.text,
      git: null,
      documentId: null,
      bom: entry.right.bom ?? false,
      lossy: entry.right.lossy ?? false,
    },
    result: {
      left_line_count: 0,
      right_line_count: 0,
      hunks: [],
      stats: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
      approximate: false,
      left_changed: [],
      right_changed: [],
    },
    options: {
      ignore_whitespace: entry.options.ignoreWhitespace,
      ignore_all_whitespace: entry.options.ignoreAllWhitespace,
      ignore_case: entry.options.ignoreCase,
      intra_line: entry.options.intraLine,
      intra_line_max_tokens: 0,
    },
    warnings: [],
    contentKey: "",
  };
}
