/**
 * IPC bridge.
 *
 * A single thin wrapper over `invoke` so component code never imports Tauri
 * directly. That keeps the components testable in a plain browser (where
 * `invoke` is undefined) and gives one place to add error reporting.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  BranchInfo,
  ChangedFile,
  CommitInfo,
  DiffOptions,
  GitSpec,
  LoadedSide,
  OptionsPatch,
  RepoInfo,
  RepoStatus,
  Session,
  Side,
} from "./types";
import type { HistoryEntry, HistorySummary } from "./history";

/** True when running inside the Tauri webview. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * True when a development mock is installed.
 *
 * A function, not a constant: the mock is installed by the page after the module
 * has already been evaluated, so a value captured at import time would always be
 * `false` and dev-mode code paths would never see it.
 */
export function mockActive(): boolean {
  return typeof window !== "undefined" && typeof window.__litediffMock === "function";
}

/**
 * Development hook for running the UI in a plain browser.
 *
 * `vite dev` serves the frontend without the Rust side, which is the fastest way
 * to iterate on layout — but every command would reject. Setting
 * `window.__litediffMock` to a handler lets `npm run dev` render real sessions
 * against fixture data. It is inert in the packaged app, where the real IPC is
 * always present, and it never ships as a code path users can reach.
 */
type MockHandler = (cmd: string, args?: Record<string, unknown>) => unknown;

declare global {
  interface Window {
    __litediffMock?: MockHandler;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window !== "undefined" && window.__litediffMock) {
    return (await window.__litediffMock(cmd, args)) as T;
  }
  if (!isTauri) {
    throw new Error(`IPC unavailable outside Tauri (command: ${cmd})`);
  }
  return (await invoke(cmd, args)) as T;
}

/** Read a file from disk without changing the session. */
export function loadFile(path: string): Promise<LoadedSide> {
  return call<LoadedSide>("load_file", { path });
}

/** Commit one side and receive a fresh diff. */
export function setSide(side: "left" | "right", sideData: Side): Promise<Session> {
  return call<Session>("set_side", { side, sideData });
}


/**
 * Commit both sides at once and receive a fresh diff.
 *
 * One round trip for the paste screen: two sequential `setSide` calls would
 * produce an intermediate session with only one side filled, which is enough to
 * unmount that screen mid-commit.
 */
export function setBoth(left: Side, right: Side): Promise<Session> {
  return call<Session>("set_both", { left, right });
}
/** Re-diff, optionally changing options first. */
export function rediff(patch?: OptionsPatch): Promise<Session> {
  return call<Session>("rediff", { patch: patch ?? null });
}


/**
 * Open the native file picker and return the chosen path, or null if cancelled.
 *
 * Goes through the dialog plugin rather than an `<input type="file">`: a web file
 * input hands back a `File` with no filesystem path, which the backend cannot
 * read, and it cannot show hidden files or respect the macOS sidebar.
 */
export async function pickFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    title,
  });
  return typeof selected === "string" ? selected : null;
}
/**
 * Adopt a tab's documents and options in the backend, without a diff.
 *
 * Called when switching tabs. The session is already in memory on this side, so
 * this is not about getting a result — it is about making the backend's document
 * cache agree with the tab that is now on screen, which is what the next `rediff`
 * will run against.
 */
export function syncSession(left: Side, right: Side, options: DiffOptions): Promise<void> {
  return call<void>("sync_session", { left, right, options });
}

/** Reset both sides and options. */
export function clearSession(): Promise<Session> {
  return call<Session>("clear");
}

/** Write an edited buffer back to disk. */
export function saveFile(path: string, text: string): Promise<void> {
  return call<void>("save_file", { path, text });
}

/** Result of inspecting a dropped path. */
export interface DroppedPath {
  isDir: boolean;
  files: string[];
}

/** Ask the backend whether a dropped path is a directory, and what is in it. */
export function inspectPath(path: string): Promise<DroppedPath> {
  return call<DroppedPath>("inspect_path", { path });
}

/** Expand a dropped directory into its file paths. */
export function expandDirectory(path: string): Promise<string[]> {
  return call<string[]>("expand_directory", { path });
}

// --- git ---------------------------------------------------------------

/** Ask whether a path is inside a work tree, and describe the repository. */
export function gitStatus(path: string): Promise<RepoStatus> {
  return call<RepoStatus>("git_status", { path });
}

/** List the files that can be compared inside a repository. */
export function gitFiles(repo: string, limit = 5000): Promise<string[]> {
  return call<string[]>("git_files", { repo, limit });
}

/** List the commits that touched one file, newest first. */
export function gitLog(repo: string, file: string, limit = 200): Promise<CommitInfo[]> {
  return call<CommitInfo[]>("git_log", { repo, file, limit });
}
/** Compare two git revisions and receive a fresh diff. */
export function gitCompare(left: GitSpec, right: GitSpec): Promise<Session> {
  return call<Session>("git_compare", { left, right });
}

/** List the repository's local branches, current one first. */
export function gitBranches(repo: string): Promise<BranchInfo[]> {
  return call<BranchInfo[]>("git_branches", { repo });
}

/** Files that differ between two revisions. */
export function gitDiffFiles(repo: string, left: string, right: string): Promise<ChangedFile[]> {
  return call<ChangedFile[]>("git_diff_files", { repo, left, right });
}

/**
 * Switch the working tree to a local branch.
 *
 * The only IPC call in this app that writes to a repository. It resolves to the
 * repository's state *after* the switch, so the caller never has to assume which
 * branch it landed on.
 */
export function gitSwitchBranch(repo: string, branch: string): Promise<RepoInfo> {
  return call<RepoInfo>("git_switch_branch", { repo, branch });
}

/**
 * Open the native directory picker and return the chosen path.
 *
 * Separate from `pickFile` because macOS hides files in the repository picker
 * otherwise: a repository is a directory, and opening a *folder* is the gesture
 * users expect when they mean "add this project".
 */
export async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: true,
    title,
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Ask for a directory, preferring the dev mock when one is installed.
 *
 * `pickFolder` otherwise always needs the native dialog, which does not exist in
 * a plain browser — so without this the history panel could not be exercised in
 * `vite dev` at all, and every UI change to it would need a packaged build.
 */
export async function pickFolderDev(title: string): Promise<string | null> {
  if (mockActive()) {
    return (await window.__litediffMock!("pick_folder")) as string | null;
  }
  return pickFolder(title);
}

// --- history ---------------------------------------------------------------

/** Save one comparison; returns its id, or null when it was too large to keep. */
export function historySave(entry: HistoryEntry): Promise<string | null> {
  return call<string | null>("history_save", { entry });
}

/** List stored comparisons, newest first, without their document texts. */
export function historyList(): Promise<HistorySummary[]> {
  return call<HistorySummary[]>("history_list");
}

/** Read one stored comparison in full. */
export function historyLoad(id: string): Promise<HistoryEntry> {
  return call<HistoryEntry>("history_load", { id });
}

/** Delete one stored comparison. */
export function historyDelete(id: string): Promise<void> {
  return call<void>("history_delete", { id });
}

/** Delete every stored comparison. */
export function historyClear(): Promise<number> {
  return call<number>("history_clear");
}

/** Apply the retention rules; returns how many entries were removed. */
export function historyPrune(days: number, keep: number): Promise<number> {
  return call<number>("history_prune", { days, keep });
}
