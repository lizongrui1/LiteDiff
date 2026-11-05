/**
 * IPC types, mirroring the Rust structs in `crates/litediff-core/src/model.rs`
 * and `crates/litediff-app/src/lib.rs`.
 *
 * Everything is a plain JSON shape: no classes, no methods. The backend sends one
 * payload per comparison and the UI treats it as immutable — mutation happens by
 * asking the backend for a new session, which keeps a single source of truth.
 */

/** Visual class of one side-by-side row. */
export type RowKind = "equal" | "modify" | "delete" | "insert";

/** A run of characters sharing one highlight state. */
export interface InlineSegment {
  text: string;
  /** Char offset, inclusive. */
  char_start: number;
  /** Char offset, exclusive. */
  char_end: number;
  /** True for the high-saturation pill. */
  changed: boolean;
}

/**
 * One aligned row. At most one side is null, and never both: the null side is
 * the hatched placeholder cell.
 */
export interface AlignedRow {
  left: number | null;
  right: number | null;
  kind: RowKind;
  /** Empty unless kind === "modify" and intra-line diffing is on. */
  left_inline: InlineSegment[];
  /** Empty unless kind === "modify" and intra-line diffing is on. */
  right_inline: InlineSegment[];
}

/** A maximal run of rows with the same equality state. */
export interface Hunk {
  equal: boolean;
  left_start: number;
  left_len: number;
  right_start: number;
  right_len: number;
  /** First row index in `DiffResult.rows`. */
  row_start: number;
  row_len: number;
}

export interface DiffStats {
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
}

export interface DiffResult {
  left_line_count: number;
  right_line_count: number;
  rows: AlignedRow[];
  hunks: Hunk[];
  stats: DiffStats;
}

export interface DiffOptions {
  ignore_whitespace: boolean;
  ignore_all_whitespace: boolean;
  ignore_case: boolean;
  intra_line: boolean;
  intra_line_max_tokens: number;
}

/** Where a side came from, when it came from a git revision. */
export interface GitOrigin {
  /** Absolute path of the repository root. */
  repo: string;
  /** Resolved revision, or "WORKTREE". */
  rev: string;
  /** Path relative to the repository root. */
  file: string;
  /** Short display label, e.g. "a1b2c3d" or "工作区". */
  short: string;
  /** True only for the working tree: the sole writable git origin. */
  writable: boolean;
}

/** One side of the comparison. */
export interface Side {
  /** Absolute path on disk; null for pasted text and for historical blobs. */
  path: string | null;
  label: string;
  text: string;
  /** Present when the text came from a git revision. */
  git?: GitOrigin | null;
}

/** One commit that touched a file. */
export interface CommitInfo {
  sha: string;
  short: string;
  date: string;
  author: string;
  subject: string;
  refs: string;
}

/** A repository resolved from a path inside it. */
export interface RepoInfo {
  root: string;
  name: string;
  relativePath: string;
  branch: string;
}

/** Whether a path is inside a work tree, and its description if so. */
export interface RepoStatus {
  isRepo: boolean;
  repo: RepoInfo | null;
}

/** One local branch, as the branch switcher lists it. */
export interface BranchInfo {
  /** Short name `git switch` accepts, e.g. `main`, `feature/login`. */
  name: string;
  /** Abbreviated commit id at the tip. */
  short: string;
  /** Author date of the tip commit, ISO-8601. */
  date: string;
  /** True for the branch HEAD points at. */
  current: boolean;
  /** Upstream in `origin/main` form, empty when there is none. */
  upstream: string;
  ahead: number;
  behind: number;
}

/** One file that differs between two revisions. */
export interface ChangedFile {
  /** Path relative to the repository root. */
  path: string;
  /** `A`, `M`, `D`, `R`, … — the first letter of git's status code. */
  status: string;
  /** Lines added; `null` for a binary file. */
  added: number | null;
  /** Lines deleted; `null` for a binary file. */
  deleted: number | null;
}

/** Which repository, revision and file one side should show. */
export interface GitSpec {
  repo: string;
  rev: string;
  file: string;
}

/** The full payload for one comparison. */
export interface Session {
  left: Side;
  right: Side;
  result: DiffResult;
  options: DiffOptions;
  warnings: string[];
}

/** Partial options sent from the UI. */
export interface OptionsPatch {
  ignoreWhitespace?: boolean;
  ignoreAllWhitespace?: boolean;
  ignoreCase?: boolean;
  intraLine?: boolean;
}
export interface LoadedSide {
  side: Side;
  warnings: string[];
}

/** One pasted or imported block: the text plus where it came from, if anywhere. */
export interface PasteBlock {
  text: string;
  /** Absolute path when the block came from a file, so ⌘S can write it back. */
  path: string | null;
  /** Display name; empty means "derive one from the first line". */
  label: string;
}

/** The pair of blocks entered on the first-run screen. */
export interface PastePair {
  left: PasteBlock;
  right: PasteBlock;
}

export type SideName = "left" | "right";

/** Split a side's text into lines, matching the Rust line model exactly. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline does not produce a phantom final line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // CRLF is normalised at the boundary, matching `SourceText`.
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
