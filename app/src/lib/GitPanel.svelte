<script lang="ts">
  /**
   * Git history picker.
   *
   * A side sheet, for the same reason the settings sheet is one: every choice in
   * here — which file, which two revisions — is only meaningful against the
   * actual contents, and covering them with a modal would hide the thing being
   * decided about.
   *
   * ## State survives closing
   *
   * The panel is unmounted whenever it closes (`{#if gitOpen}` in `App`), so all
   * local `$state` would be lost. Opening history is a repeated action — compare,
   * look, compare something else — and coming back to 未选择仓库 every time made
   * the panel feel like it forgot the conversation. The data therefore lives in
   * `gitSession.ts`, is copied in on mount and written back on change.
   *
   * ## The interaction model
   *
   * There is no "left version / right version" pair of dropdowns. Instead each
   * row in one list carries two small assign buttons, because both requested
   * comparisons are the same gesture over the same list:
   *
   * - 工作区 → a commit: the top pseudo-row is the live file.
   * - commit → commit: pick two rows.
   *
   * Two dropdowns would mean two separate commit lists to keep in sync, and
   * neither could show a date or subject next to the SHA being chosen.
   */
  import { onMount } from "svelte";
  import * as ipc from "../lib/ipc";
  import {
    WORKTREE,
    allDirs,
    basename,
    fuzzyBranches,
    buildTree,
    canCompare,
    day,
    describeRev,
    dirname,
    filterFiles,
    firstRef,
    slotOf,
    type FileRow,
  } from "../lib/git";
  import {
    getGitPanelState,
    setGitPanelState,
    type FileView,
  } from "../lib/gitSession";
  import type { BranchInfo, ChangedFile, CommitInfo, GitSpec, RepoInfo } from "../lib/types";
  import { t } from "../lib/i18nStore";
  import type { MessageKey } from "../lib/i18n";

  interface Props {
    /** Pre-select a file, so opening history from a diff lands on that file. */
    seedFile: { repo: string; file: string } | null;
    /** Both sides are chosen; the parent runs the comparison. */
    onCompare: (left: GitSpec, right: GitSpec) => Promise<void>;
    onClose: () => void;
  }

  let { seedFile, onCompare, onClose }: Props = $props();

  /**
   * Restore the previous session up front, so the sheet paints its last state
   * immediately instead of flashing an empty repository picker while git runs.
   */
  const restored = getGitPanelState();

  let repo = $state<RepoInfo | null>(restored.repo);
  let files = $state<string[]>(restored.files);
  let filter = $state(restored.filter);
  let file = $state<string>(restored.file);
  let commits = $state<CommitInfo[]>([]);
  let loadingFiles = $state(false);
  let loadingLog = $state(false);
  let error = $state("");

  let leftRev = $state<string | null>(restored.leftRev);
  let rightRev = $state<string | null>(restored.rightRev);
  let view = $state<FileView>(restored.view);
  let expanded = $state<Set<string>>(new Set(restored.expanded));

  /*
   * Branch state.
   *
   * Not persisted, except the two chosen side names: a branch list is cheap to
   * reload and goes stale the moment anything outside this app commits, while the
   * pair the user picked is a decision worth keeping — exactly the split the rest
   * of `gitSession` already makes.
   */
  let branchList = $state<BranchInfo[]>([]);
  let branchError = $state("");
  /** Branch currently being switched to; empty when idle. */
  let switching = $state("");
  /** Whether the branch list is expanded. Collapsed by default: it is not the point. */

  /*
   * Width, and its bounds.
   *
   * 240px is the narrowest that still shows a branch name beside its switch button;
   * past 640px the panel is wider than the diff it describes. The stored value is
   * clamped on load, so a hand-edited or outdated preference cannot produce an
   * unusable panel.
   */
  const MIN_WIDTH = 240;
  const MAX_WIDTH = 640;
  const DEFAULT_WIDTH = 320;
  let width = $state(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, restored.width)));
  /** True while the pointer is dragging the edge, for the active cursor state. */
  let resizing = $state(false);
  let branchesOpen = $state(restored.branchesOpen);
  /** Fuzzy query over branch names. */
  let branchFilter = $state("");
  let branchLeft = $state(restored.branchLeft);
  let branchRight = $state(restored.branchRight);
  let branchChanges = $state<ChangedFile[]>([]);
  let loadingBranchDiff = $state(false);

  /** Write the parts that should outlive the panel. */
  function persist(): void {
    setGitPanelState({
      repo,
      files,
      file,
      leftRev,
      rightRev,
      filter,
      view,
      expanded: [...expanded],
      // Only the chosen *pair* is remembered, not the file list it produced.
      branchLeft,
      branchRight,
      branchesOpen,
      width,
    });
  }

  /**
   * Reopen this panel: restore, then refresh quietly.
   *
   * The refresh is what keeps the history from going stale — commits made while
   * the panel was closed must appear — but it must not blank the restored view, so
   * the existing lists stay on screen until the new ones arrive.
   */
  onMount(() => {
    // Opening history from a comparison must land on the file being compared, even
    // when the panel already remembers a different file in the same repository:
    // "show me the history of *this* file" is the request, and answering it with a
    // remembered file would silently describe something else.
    //
    // So the seed wins for the file, while everything that is a *view* preference —
    // expanded directories, list vs tree, the filter — is restored from memory.
    const root = repo?.root ?? seedFile?.repo ?? null;
    const preferred = seedFile !== null ? seedFile.file : file;

    if (root) void openRepo(root, preferred, { silent: true });
  });

  async function chooseRepo(): Promise<void> {
    // The dev mock stands in for the native dialog, so the panel can be exercised
    // in a plain browser; without it this whole flow needs a packaged build.
    if (!ipc.isTauri && !ipc.mockActive()) {
      error = $t("git.desktopOnly");
      return;
    }
    const picked = await ipc.pickFolderDev($t("git.chooseRepo"));
    if (!picked) return;
    await openRepo(picked, "");
  }

  /**
   * Resolve `path` to a repository and load its file list.
   *
   * `silent` keeps the current rows visible while refreshing, which is what makes
   * a reopen feel instant rather than like a reload.
   */
  async function openRepo(
    path: string,
    preferred: string,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    error = "";
    if (!opts.silent) {
      files = [];
      file = "";
      commits = [];
      leftRev = null;
      rightRev = null;
      expanded = new Set();
    }
    loadingFiles = true;
    try {
      const status = await ipc.gitStatus(path);
      if (!status.isRepo || !status.repo) {
        error = $t("git.notARepo");
        repo = null;
        persist();
        return;
      }
      repo = status.repo;
      // Load the branch list alongside the files; the panel shows both, and a
      // failure to list branches must not block the file picker.
      void loadBranches();
      const list = await ipc.gitFiles(repo.root);
      files = list;
      if (list.length === 0) {
        error = $t("git.noFiles");
        persist();
        return;
      }

      // Expand every directory the first time a repository is opened: a tree that
      // starts fully collapsed hides the files the panel exists to show.
      if (expanded.size === 0) expanded = new Set(allDirs(list));

      const next = list.includes(preferred) ? preferred : (file && list.includes(file) ? file : list[0]);
      await selectFile(next, { keepRevs: opts.silent });
      persist();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingFiles = false;
    }
  }

  /**
   * Load the commit list for one file and assign sensible defaults.
   *
   * `keepRevs` preserves an assignment across a refresh: reopening the panel on
   * the same file should show the same two versions the user had chosen, and
   * silently resetting them to 工作区/HEAD would discard their decision.
   */
  async function selectFile(next: string, opts: { keepRevs?: boolean } = {}): Promise<void> {
    if (!repo || !next) return;
    const previousFile = file;
    file = next;

    // Keep an assignment only when it is both the same file and still a real
    // revision of it. A remembered SHA that no longer appears in the history —
    // rebased away, or reset — would compare against a commit the user cannot see
    // in the list, so it is dropped rather than shown as a stale label.
    const sameFile = previousFile === next && opts.keepRevs === true;
    if (!sameFile) {
      // Cleared here and assigned below, once the commit list is known: the default
      // pairing needs the history, and guessing before it arrives is what produced
      // the reversed order this used to have.
      leftRev = null;
      rightRev = null;
    }

    loadingLog = true;
    error = "";
    try {
      commits = await ipc.gitLog(repo.root, next, 200);
      if (commits.length === 0) {
        // Nothing to compare a worktree against, so say so rather than leaving the
        // panel looking merely empty.
        error = $t("git.noHistory");
        rightRev = null;
      } else {
        const known = (rev: string | null): rev is string =>
          rev !== null && (rev === WORKTREE || commits.some((c) => c.sha === rev));

        /*
         * Default pairing: the last commit on the left, the working tree on the right.
         *
         * Two things are decided here at once.
         *
         * **Order.** Old left, new right — the order a diff is read in, and the
         * order every other tool presents. It used to be the reverse (working tree
         * left, newest commit right), so the most common comparison came out
         * backwards and had to be reassigned by hand every single time.
         *
         * **Which pair.** `HEAD` against the working tree is `git diff` with no
         * arguments: "what have I changed and not committed yet". That is what the
         * panel is opened for far more often than "what did the last two commits
         * change", and the latter is two clicks away (`左` on `commits[1]`).
         *
         * `commits` is newest-first, so `commits[0]` is `HEAD`. A repository with no
         * history never reaches this branch — it is handled above with a message.
         */
        if (!known(leftRev)) leftRev = commits[0].sha;
        if (!known(rightRev)) rightRev = WORKTREE;
      }
      persist();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      commits = [];
    } finally {
      loadingLog = false;
    }
  }

  /** Files matching the filter; the tree is built from the same set. */
  const matching = $derived(filterFiles(files, filter, Number.MAX_SAFE_INTEGER));

  /**
   * Rows for whichever view is active.
   *
   * Filtering expands every directory: when a query is active the user is looking
   * for a specific file, and a match hidden inside a collapsed directory would
   * look like no match at all.
   */
  const rows = $derived.by<FileRow[]>(() => {
    if (view === "list") {
      return filterFiles(files, filter, 300).map((path) => ({
        path,
        name: basename(path),
        isDir: false,
        depth: 0,
        fileCount: 1,
        dir: dirname(path),
      }));
    }
    const expandAll = filter.trim() !== "";
    return buildTree(matching, expandAll ? new Set(allDirs(matching)) : expanded);
  });

  const ready = $derived(repo !== null && canCompare(file, leftRev, rightRev));
  /*
   * Slot labels: the revision, or a translated placeholder.
   *
   * Resolved here rather than inside `describeRev` so that helper stays free of
   * language — it is a pure function and its tests assert the abbreviation rules,
   * not the wording of "not selected".
   */
  const slotLabels = $derived({
    unassigned: $t("git.unassigned"),
    worktree: $t("git.worktree"),
  });
  const leftLabel = $derived(describeRev(leftRev, commits, slotLabels));
  const rightLabel = $derived(describeRev(rightRev, commits, slotLabels));

  function slot(sha: string): "left" | "right" | "both" | null {
    return slotOf(sha, leftRev, rightRev);
  }

  function toggleDir(path: string): void {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded = next;
    persist();
  }

  async function start(): Promise<void> {
    if (!repo || !ready || leftRev === null || rightRev === null) return;
    await onCompare(
      { repo: repo.root, rev: leftRev, file },
      { repo: repo.root, rev: rightRev, file },
    );
  }

  function setView(next: FileView): void {
    if (view === next) return;
    view = next;
    persist();
  }

  // --- branches ---------------------------------------------------------


  /**
   * Branches, loaded alongside the file list.
   *
   * A separate call from `openRepo`'s file listing because they fail
   * independently: a repository with no branches (a fresh `git init`) still has
   * files, and a branch list must not be what decides whether the file picker works.
   */
  async function loadBranches(): Promise<void> {
    if (!repo) {
      branchList = [];
      return;
    }
    try {
      branchList = await ipc.gitBranches(repo.root);
    } catch (err) {
      // Not fatal: the rest of the panel still works without a branch list.
      branchList = [];
      branchError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Switch the working tree to a branch.
   *
   * The only action in this app that changes the user's checkout, so it asks first
   * and reports the outcome. Two guards beyond the confirmation:
   *
   * - No switching while the panel is mid-operation (a second click on a slow
   *   repository would queue two `git switch` runs).
   * - The result replaces `repo` rather than patching `branch`, because the
   *   backend re-resolves the repository and that is the authoritative answer.
   *
   * After a successful switch the file list is reloaded: the files that exist on
   * one branch are not the files that exist on another, and leaving the old list
   * would let the user pick a path that no longer resolves.
   */
  async function switchTo(branch: string): Promise<void> {
    if (!repo || switching !== "") return;
    if (branch === repo.branch) return;

    const label = repo.name;
    const confirmed = window.confirm(
      $t("git.switchConfirm", { repo: label, branch }),
    );
    if (!confirmed) return;

    switching = branch;
    branchError = "";
    try {
      const next = await ipc.gitSwitchBranch(repo.root, branch);
      repo = next;
      // The old file list belongs to the branch that is no longer checked out.
      await openRepo(next.root, file, { silent: true });
      await loadBranches();
      // A branch comparison that named the old checkout is now stale in the one
      // way that matters: the left side would silently mean something else. The
      // revisions are SHAs (or branch names that still resolve), so they are kept.
      persist();
    } catch (err) {
      // git's own refusal ("Your local changes would be overwritten") is the most
      // useful text available, so it is shown verbatim rather than reworded.
      branchError = err instanceof Error ? err.message : String(err);
    } finally {
      switching = "";
    }
  }

  /**
   * Compare two branches across every file that differs.
   *
   * This is a *different* question from the per-file comparison the rest of the
   * panel answers, which is why it is its own section: the useful output is the
   * list of files the branches disagree about, and a single-file diff of
   * everything would be unreadable.
   */
  async function compareBranches(): Promise<void> {
    if (!repo || branchLeft === "" || branchRight === "") return;
    if (branchLeft === branchRight) {
      branchError = $t("git.branchSame");
      branchChanges = [];
      return;
    }
    loadingBranchDiff = true;
    branchError = "";
    try {
      branchChanges = await ipc.gitDiffFiles(repo.root, branchLeft, branchRight);
      if (branchChanges.length === 0) branchError = $t("git.branchNoChange");
    } catch (err) {
      branchError = err instanceof Error ? err.message : String(err);
      branchChanges = [];
    } finally {
      loadingBranchDiff = false;
    }
  }

  /** Open one file from the branch-to-branch list in the normal file comparison. */
  async function openChangedFile(path: string): Promise<void> {
    if (!repo || branchLeft === "" || branchRight === "") return;
    await onCompare(
      { repo: repo.root, rev: branchLeft, file: path },
      { repo: repo.root, rev: branchRight, file: path },
    );
  }

  /**
   * Status letter, mapped to the label the panel shows.
   *
   * A table of message keys rather than a computed string: `git.status${...}`
   * cannot be typed, so a missing translation would render as the raw key at
   * exactly the moment the user is reading which files changed.
   */
  /** Branches after the fuzzy filter, best match first. */
  const visibleBranches = $derived(fuzzyBranches(branchList, branchFilter));

  const STATUS_KEYS: Record<string, MessageKey> = {
    A: "git.statusAdded",
    D: "git.statusDeleted",
    R: "git.statusRenamed",
    C: "git.statusAdded",
    M: "git.statusModified",
    T: "git.statusModified",
  };

  function statusKey(status: string): MessageKey {
    return STATUS_KEYS[status] ?? "git.statusModified";
  }


  // --- resize -----------------------------------------------------------

  /**
   * Drag the panel's left edge.
   *
   * Width is derived from the pointer's distance to the *right* edge of the
   * viewport, not from accumulated movement: `movementX` drifts as soon as the
   * pointer leaves the window or the window itself resizes mid-drag, while an
   * absolute distance cannot. The sheet is anchored right, so that distance *is*
   * its width.
   *
   * Clamped, because a 0px panel is a trap the user cannot drag out of.
   */
  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    resizing = true;

    const move = (e: PointerEvent) => {
      // Leave a sliver of window for the diff itself.
      const max = Math.min(MAX_WIDTH, window.innerWidth - 120);
      width = Math.max(MIN_WIDTH, Math.min(max, window.innerWidth - e.clientX));
    };

    const end = () => {
      resizing = false;
      handle.releasePointerCapture?.(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      // Written once at the end rather than per frame: the panel remembers its
      // width, and a drag is one decision, not sixty.
      persist();
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Keyboard resizing, for the separator. Arrow keys nudge, Home/End jump. */
  function onResizeKey(event: KeyboardEvent): void {
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = width + 16;
        break;
      case "ArrowRight":
        next = width - 16;
        break;
      case "Home":
        next = MIN_WIDTH;
        break;
      case "End":
        next = MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next));
    persist();
  }
  /** Escape closes the sheet, matching the settings panel. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }
</script>

<!--
  Window-level Escape, like the settings sheet.

  A keydown listener on the panel itself only fires once focus is already inside
  it, and nothing here is focused on open, so the shortcut would silently do
  nothing until the user clicked a commit.
-->
<svelte:window onkeydown={onKeydown} />

<!--
  The drag handle sits on the panel's left edge, straddling the border.

  Making the border itself the target is what every editor does and what the user
  reached for here: the panel is a side sheet, and the one thing you want to adjust
  is how much of the diff it covers. It is positioned inside a wrapper that also
  holds the sheet, so it can ride over the border without being clipped by the
  sheet's own overflow rules.
-->
<div class="panel" style:width="{width}px">
  <!--
    `role="separator"` with `aria-valuenow` is the ARIA window-splitter widget and
    is meant to be focusable — the two lints below fire because the role is classed
    as non-interactive, not because the markup is wrong. Same reasoning as the
    split divider in `App`.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="resizer"
    class:dragging={resizing}
    role="separator"
    aria-orientation="vertical"
    aria-label={$t("git.resize")}
    aria-valuenow={Math.round(width)}
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    tabindex="0"
    onpointerdown={startResize}
    onkeydown={onResizeKey}
    ondblclick={() => {
      width = DEFAULT_WIDTH;
      persist();
    }}
  ></div>

<aside class="sheet" aria-label={$t("git.title")}>
  <div class="head">
    <h2>{$t("git.title")}</h2>
    <button type="button" class="close" onclick={onClose} title={$t("settings.closeTitle")} aria-label={$t("settings.close")}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>

  <div class="scroll">
    <!-- ── repository ────────────────────────────────────────────── -->
    <section>
      <div class="repo-line">
        {#if repo}
          <span class="repo-name" title={repo.root}>{repo.name}</span>
          <span class="branch">{repo.branch}</span>
          <span class="grow"></span>
          <button type="button" class="link" onclick={() => void chooseRepo()}>{$t("git.changeRepo")}</button>
        {:else}
          <span class="repo-name muted">{$t("git.noRepo")}</span>
          <span class="grow"></span>
          <button type="button" class="link" onclick={() => void chooseRepo()}>{$t("git.chooseRepo")}</button>
        {/if}
      </div>
    </section>

    {#if repo}
      <!-- ── branches ──────────────────────────────────────────────── -->
      <section>
        <!--
          Collapsible, because a real repository has dozens of branches.

          The list is not the point of this panel — choosing two versions of one
          file is — so an always-open branch list pushed the file picker and the
          revision list below the fold on any repository with more than a handful
          of branches. Collapsed it costs one row, and the branch you are on stays
          visible in the header above.
        -->
        <button
          type="button"
          class="section-head"
          aria-expanded={branchesOpen}
          onclick={() => {
            branchesOpen = !branchesOpen;
            persist();
          }}
        >
          <span class="twisty" class:open={branchesOpen}>
            <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <h3>{$t("git.branches")}</h3>
          <span class="grow"></span>
          <span class="head-count">{branchList.length}</span>
        </button>

        {#if branchesOpen && branchList.length === 0}
          <p class="empty pad">{$t("git.noHistory")}</p>
        {:else if branchesOpen}
          <input
            class="filter"
            type="search"
            placeholder={$t("git.branchFilter")}
            value={branchFilter}
            oninput={(e) => (branchFilter = e.currentTarget.value)}
            spellcheck="false"
            aria-label={$t("git.branchFilter")}
          />
          <div class="list branches">
            {#each visibleBranches as b (b.name)}
              <div class="branch-row" class:current={b.current}>
                <span class="branch-dot" aria-hidden="true">
                  {#if b.current}
                    <svg viewBox="0 0 16 16" width="11" height="11">
                      <circle cx="8" cy="8" r="3.4" fill="currentColor" />
                    </svg>
                  {/if}
                </span>
                <span class="branch-name" title={b.name}>{b.name}</span>
                {#if b.ahead > 0}<span class="track ahead">{$t("git.ahead", { n: b.ahead })}</span>{/if}
                {#if b.behind > 0}<span class="track behind">{$t("git.behind", { n: b.behind })}</span>{/if}
                <span class="grow"></span>
                {#if b.current}
                  <span class="branch-flag">{$t("git.branchCurrent")}</span>
                {:else}
                  <button
                    type="button"
                    class="ab"
                    disabled={switching !== ""}
                    onclick={() => void switchTo(b.name)}
                    title={$t("git.branchSwitch")}
                  >
                    {switching === b.name ? $t("git.switching") : $t("git.branchSwitch")}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if branchesOpen && branchFilter.trim() !== "" && visibleBranches.length === 0}
          <p class="empty pad">{$t("git.noMatch")}</p>
        {/if}
        {#if branchError}
          <p class="error pad" role="alert">{branchError}</p>
        {/if}
      </section>

      <!--
        Branch comparison.

        A different question from the file-by-file comparison below it, so it gets
        its own section: what the user wants from two branches is the *list of
        files* they disagree about, then a diff of one of them.
      -->
      <section>
        <h3>{$t("git.branchCompare")}</h3>

        <!--
          Two rows, not two boxes side by side.

          Side by side is what a merge-request page does, where the form is wide.
          Here the panel is 320px: two selects would leave ~130px each and truncate
          every branch name to six characters. Stacking also matches the "which two
          versions" section above, so the panel has one way of saying "left side /
          right side" instead of two.
        -->
        <div class="pick-row">
          <span class="pair-tag">{$t("git.rowLabelLeft")}</span>
          <div class="select-wrap">
            <select
              class="branch-select"
              value={branchLeft}
              onchange={(e) => {
                branchLeft = e.currentTarget.value;
                branchChanges = [];
                persist();
              }}
              aria-label={$t("git.rowLabelLeft")}
            >
              <option value="">{$t("git.unassigned")}</option>
              {#each branchList as b (b.name)}
                <option value={b.name}>{b.name}</option>
              {/each}
            </select>
            <svg class="chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
        <div class="pick-row">
          <span class="pair-tag">{$t("git.rowLabelRight")}</span>
          <div class="select-wrap">
            <select
              class="branch-select"
              value={branchRight}
              onchange={(e) => {
                branchRight = e.currentTarget.value;
                branchChanges = [];
                persist();
              }}
              aria-label={$t("git.rowLabelRight")}
            >
              <option value="">{$t("git.unassigned")}</option>
              {#each branchList as b (b.name)}
                <option value={b.name}>{b.name}</option>
              {/each}
            </select>
            <svg class="chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
        <button
          type="button"
          class="primary wide"
          disabled={branchLeft === "" || branchRight === "" || loadingBranchDiff}
          onclick={() => void compareBranches()}
        >
          {loadingBranchDiff ? $t("git.loadingHistory") : $t("git.branchCompare")}
        </button>

        {#if branchChanges.length > 0}
          <p class="note">
            {$t("git.branchFiles", { n: branchChanges.length })} · {$t("git.branchFileHint")}
          </p>
          <div class="list changes">
            {#each branchChanges as change (change.path)}
              <button
                type="button"
                class="item change"
                onclick={() => void openChangedFile(change.path)}
                title={change.path}
              >
                <span class="status" class:added={change.status === "A"} class:deleted={change.status === "D"}>
                  {$t(statusKey(change.status))}
                </span>
                <span class="item-name">{change.path}</span>
                <span class="count">
                  {#if change.added !== null}+{change.added}{/if}
                  {#if change.deleted !== null}−{change.deleted}{/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if repo}
      <!-- ── file ────────────────────────────────────────────────── -->
      <section>
        <div class="file-head">
          <h3>{$t("git.files")}</h3>
          <!--
            List / tree as a segmented control rather than one toggling button:
            a lone button relabelled itself makes the user read the label to know
            the current state, and the two modes are peers.
          -->
          <div class="segmented" role="radiogroup" aria-label={$t("git.fileView")}>
            <button type="button"
              class="seg"
              class:on={view === "list"}
              role="radio"
              aria-checked={view === "list"}
              onclick={() => setView("list")}
              title={$t("git.viewListTitle")}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path
                  d="M2.5 4h11M2.5 8h11M2.5 12h11"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
              {$t("git.viewList")}
            </button>
            <button type="button"
              class="seg"
              class:on={view === "tree"}
              role="radio"
              aria-checked={view === "tree"}
              onclick={() => setView("tree")}
              title={$t("git.viewTreeTitle")}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path
                  d="M4 3.5v9M4 8h4M8 5.5h4M8 11.5h4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
                <circle cx="3.4" cy="3.5" r="1.1" fill="none" stroke="currentColor" stroke-width="1.1" />
                <circle cx="12.6" cy="5.5" r="1.1" fill="none" stroke="currentColor" stroke-width="1.1" />
                <circle cx="12.6" cy="11.5" r="1.1" fill="none" stroke="currentColor" stroke-width="1.1" />
              </svg>
              {$t("git.viewTree")}
            </button>
          </div>
        </div>

        <input
          class="filter"
          type="search"
          placeholder={$t("git.filterPlaceholder")}
          value={filter}
          oninput={(e) => {
            filter = e.currentTarget.value;
            persist();
          }}
          spellcheck="false"
          aria-label={$t("git.filterLabel")}
        />

        <div class="list files">
          {#each rows as row (row.path + (row.isDir ? "/" : ""))}
            {#if row.isDir}
              <button type="button"
                class="item dir"
                onclick={() => toggleDir(row.path)}
                title={$t("git.fileCount", { path: row.path, count: row.fileCount })}
                aria-expanded={expanded.has(row.path) || filter.trim() !== ""}
              >
                <span class="twisty" class:open={expanded.has(row.path) || filter.trim() !== ""}>
                  <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
                    <path
                      d="M6 4l4 4-4 4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
                <span class="item-name" style:padding-left={`${row.depth * 11}px`}>{row.name}</span>
                <span class="count">{row.fileCount}</span>
              </button>
            {:else}
              <button type="button"
                class="item"
                class:on={row.path === file}
                onclick={() => void selectFile(row.path)}
                title={row.path}
              >
                {#if view === "tree"}
                  <span class="twisty spacer" aria-hidden="true"></span>
                {/if}
                <span class="item-name" style:padding-left={`${row.depth * 11}px`}>{row.name}</span>
                {#if view === "list"}
                  <span class="item-dir">{row.dir}</span>
                {/if}
              </button>
            {/if}
          {:else}
            <p class="empty">{$t("git.noMatch")}</p>
          {/each}
        </div>
      </section>

      <!-- ── which two versions ──────────────────────────────────── -->
      <section>
        <h3>{$t("git.comparison")}</h3>
        <div class="pair">
          <div class="pair-line">
            <span class="pair-tag">{$t("git.rowLabelLeft")}</span>
            <span class="pair-rev" class:empty={leftRev === null}>{leftLabel}</span>
            {#if leftRev !== null}
              <button type="button"
                class="mini"
                onclick={() => {
                  leftRev = null;
                  persist();
                }}
                title={$t("git.clearLeft")}>✕</button>
            {/if}
          </div>
          <div class="pair-line">
            <span class="pair-tag">{$t("git.rowLabelRight")}</span>
            <span class="pair-rev" class:empty={rightRev === null}>{rightLabel}</span>
            {#if rightRev !== null}
              <button type="button"
                class="mini"
                onclick={() => {
                  rightRev = null;
                  persist();
                }}
                title={$t("git.clearRight")}>✕</button>
            {/if}
          </div>
        </div>
        <p class="note">{$t("git.assignHint")}</p>
      </section>

      <!-- ── revisions ───────────────────────────────────────────── -->
      <section class="last">
        <h3>{$t("git.revisions")}</h3>
        {#if loadingLog}
          <p class="empty">{$t("git.loadingHistory")}</p>
        {:else}
          <div class="list commits">
            <!--
              The working tree is a pseudo-row at the top of the same list, not a
              separate control: comparing "what I have now" against a commit is the
              most common request, and it must be assignable by the same gesture as
              any two commits.
            -->
            <div class="row" class:left={leftRev === WORKTREE} class:right={rightRev === WORKTREE}>
              <div class="row-main">
                <span class="row-subject">{$t("git.worktree")}</span>
                <span class="row-meta">{$t("git.worktreeMeta")}</span>
              </div>
              <div class="assign">
                <button type="button"
                  class="ab"
                  class:on={leftRev === WORKTREE}
                  onclick={() => {
                    leftRev = WORKTREE;
                    persist();
                  }}
                  title={$t("git.assignLeft")}>{$t("git.rowLabelLeft")}</button>
                <button type="button"
                  class="ab"
                  class:on={rightRev === WORKTREE}
                  onclick={() => {
                    rightRev = WORKTREE;
                    persist();
                  }}
                  title={$t("git.assignRight")}>{$t("git.rowLabelRight")}</button>
              </div>
            </div>

            {#each commits as commit (commit.sha)}
              {@const assigned = slot(commit.sha)}
              <div
                class="row"
                class:left={assigned === "left" || assigned === "both"}
                class:right={assigned === "right" || assigned === "both"}
              >
                <div class="row-main">
                  <span class="row-subject" title={commit.subject}>{commit.subject || $t("git.noSubject")}</span>
                  <span class="row-meta">
                    <span class="sha">{commit.short}</span>
                    {day(commit.date)} · {commit.author}
                    {#if commit.refs}
                      <span class="refs">{firstRef(commit.refs)}</span>
                    {/if}
                  </span>
                </div>
                <div class="assign">
                  <button type="button"
                    class="ab"
                    class:on={assigned === "left" || assigned === "both"}
                    onclick={() => {
                      leftRev = commit.sha;
                      persist();
                    }}
                    title={$t("git.assignLeft")}>{$t("git.rowLabelLeft")}</button>
                  <button type="button"
                    class="ab"
                    class:on={assigned === "right" || assigned === "both"}
                    onclick={() => {
                      rightRev = commit.sha;
                      persist();
                    }}
                    title={$t("git.assignRight")}>{$t("git.rowLabelRight")}</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if loadingFiles}
      <p class="empty pad">{$t("git.loadingRepo")}</p>
    {/if}
    {#if error}
      <p class="error pad" role="alert">{error}</p>
    {/if}
  </div>

  <footer class="foot">
    <button type="button" class="primary" disabled={!ready} onclick={() => void start()}>
      {$t("git.startCompare")}
    </button>
  </footer>
</aside>
</div>

<style>
  /*
   * The panel is a flex item whose width comes from one number, and `min-width: 0`
   * is load-bearing.
   *
   * A flex item's automatic minimum size is its min-content width. This panel holds
   * long branch names and long file paths, so without this the 320px basis was
   * advisory: a branch called
   * `feature/seedance-2.5-30s-with-a-quite-long-name` alone widened the sheet from
   * 320px to 705px, which is what made the panel look like it had taken over the
   * window. Every row inside now truncates instead.
   */
  .panel {
    position: relative;
    flex: 0 0 auto;
    min-width: 0;
    display: flex;
    min-height: 0;
  }

  .sheet {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--c-border);
    background: var(--c-bg-elevated);
  }

  /*
   * Drag handle.
   *
   * 9px wide and centred on the border, with a 1px visual rule that only appears
   * on hover. A permanently visible grabber would be chrome the panel does not
   * need; the pointer changing to `col-resize` over the edge is the affordance
   * everyone already knows.
   */
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    width: 9px;
    z-index: 2;
    cursor: col-resize;
    background: transparent;
  }

  .resizer::after {
    content: "";
    position: absolute;
    inset: 0 4px;
    background: var(--c-accent);
    opacity: 0;
    transition: opacity 90ms linear;
  }

  .resizer:hover::after,
  .resizer.dragging::after,
  .resizer:focus-visible::after {
    opacity: 0.55;
  }

  .resizer:focus-visible {
    outline: none;
  }

  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 36px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--c-border);
  }

  h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 590;
    color: var(--c-text);
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--c-text-muted);
    cursor: pointer;
  }

  .close:hover {
    background: var(--c-bg-sunken);
    color: var(--c-text);
  }

  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  section {
    padding: 8px 12px 10px;
    border-bottom: 1px solid var(--c-border);
  }

  section.last {
    border-bottom: none;
  }

  h3 {
    margin: 0 0 6px;
    font-size: 10px;
    font-weight: 590;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--c-text-faint);
  }

  /* Section label on the left, view switch on the right: one row, no extra height. */
  .file-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .file-head h3 {
    margin: 0;
  }

  .grow {
    flex: 1 1 auto;
  }

  /* --- repository ------------------------------------------------------- */
  .repo-line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
  }

  .repo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 590;
    color: var(--c-text);
  }

  .repo-name.muted {
    font-weight: 400;
    color: var(--c-text-faint);
  }

  /* Branch as a quiet chip, the way a repo header reads in most clients. */
  .branch {
    flex: 0 0 auto;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--c-bg-sunken);
    font-size: 10px;
    color: var(--c-text-muted);
  }

  .link {
    flex: 0 0 auto;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: 11px;
    color: var(--c-accent);
    cursor: pointer;
  }

  .link:hover {
    text-decoration: underline;
  }

  /* --- view switch ------------------------------------------------------ */
  .segmented {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 1px;
    border-radius: 5px;
    background: var(--c-bg-sunken);
  }

  .seg {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 16px;
    padding: 0 5px;
    border: none;
    border-radius: 4px;
    background: transparent;
    font: inherit;
    font-size: 9.5px;
    color: var(--c-text-faint);
    cursor: pointer;
    white-space: nowrap;
  }

  /* Selected segments keep their own colours under the pointer. */
  .seg:hover:not(.on) {
    color: var(--c-text-muted);
  }

  .seg.on {
    background: var(--c-bg);
    color: var(--c-text);
    box-shadow: 0 0 0 1px var(--c-border);
  }

  /* --- file picker ------------------------------------------------------ */
  .filter {
    width: 100%;
    height: 24px;
    margin-bottom: 6px;
    padding: 0 7px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-bg);
    font: inherit;
    font-size: 11px;
    color: var(--c-text);
  }

  .filter:focus {
    outline: none;
    border-color: var(--c-accent);
  }

  /*
   * A fixed-height scroll box rather than an expanding list: the commit list
   * below has to stay on screen, and a file list that grows to fill the sheet
   * would push the versions off the bottom.
   */
  .list {
    overflow-y: auto;
    border-radius: 5px;
  }

  .list.files {
    max-height: 156px;
  }

  .list.commits {
    max-height: 300px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 6px 2px 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    font: inherit;
    font-size: 11px;
    text-align: left;
    color: var(--c-text);
    cursor: pointer;
  }

  /*
   * Same specificity trap as the toolbar: `:hover` outranks `.on`, so hovering a
   * selected file replaced its blue selection with the neutral wash and the
   * selection only reappeared once the pointer left.
   */
  .item:hover:not(.on) {
    background: var(--c-bg-sunken);
  }

  .item.on {
    background: var(--c-selection);
  }

  /* A directory row is a control, not content: it reads quieter than a file. */
  .item.dir {
    color: var(--c-text-muted);
  }

  .item-name {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-dir {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    font-size: 10px;
    color: var(--c-text-faint);
  }

  /* Fixed width so file names line up at every depth, whether or not a twisty
     is painted. */
  .twisty {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 11px;
    height: 11px;
    color: var(--c-text-faint);
    transition: transform 90ms ease;
  }

  .twisty.open {
    transform: rotate(90deg);
  }

  /* --- collapsible section head ----------------------------------------- */
  /*
   * The whole heading row is the button, not a small chevron beside it.
   *
   * An 11px twisty is a hard target, and with `h3` inside it the row already looks
   * like one control; making only the arrow clickable is the kind of detail that
   * reads as broken when the click lands a pixel off.
   */
  .section-head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin: 0 0 2px;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .section-head h3 {
    margin: 0;
  }

  .section-head:hover .twisty,
  .section-head:hover h3 {
    color: var(--c-text-muted);
  }

  /* Number of branches, as a quiet count rather than a badge: information, not a
     notification. */
  .head-count {
    flex: 0 0 auto;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-faint);
  }

  .twisty.spacer {
    visibility: hidden;
  }

  /* File counts are secondary, so they sit right-aligned and faint. */
  .count {
    flex: 0 0 auto;
    margin-left: auto;
    padding-left: 6px;
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-faint);
  }

  /* --- assignment slots ------------------------------------------------- */
  .pair {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 6px;
  }

  .pair-line {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 6px;
    border-radius: 5px;
    background: var(--c-bg-sunken);
    font-size: 11px;
  }

  /*
   * The "left / right" tag on an assignment row.
   *
   * `font-size` and `font-weight` are set here rather than inherited: the tag is
   * a `<span>` inside a `<div>`, so it picked up 12px from the panel while the
   * value beside it is 11px — a 12px bold CJK glyph next to 11px regular text
   * reads as a heading that has leaked into the row.
   *
   * `width` is a floor, not a cap: a tenth of a px shy of one glyph clipped the
   * 漢字 in half.
   */
  .pair-tag {
    flex: 0 0 auto;
    min-width: 12px;
    font-size: 11px;
    font-weight: 590;
    color: var(--c-text-muted);
  }

  .pair-rev {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--c-text);
  }

  .pair-rev.empty {
    font-family: inherit;
    font-style: italic;
    color: var(--c-text-faint);
  }

  .mini {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    font-size: 9px;
    line-height: 1;
    color: var(--c-text-faint);
    cursor: pointer;
  }

  .mini:hover {
    background: var(--c-bg);
    color: var(--c-text);
  }

  .note {
    margin: 0;
    font-size: 10px;
    line-height: 1.4;
    color: var(--c-text-faint);
  }

  /* --- commit rows ------------------------------------------------------ */
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 5px 4px 6px;
    border-radius: 5px;
    /* 1px transparent border keeps rows from shifting when a slot fills in. */
    border-left: 2px solid transparent;
  }

  .row:hover {
    background: var(--c-bg-sunken);
  }

  /* Assigned rows are marked on the edge, not the whole row: two rows can be
     assigned at once and a filled background on both reads as a selection. */
  .row.left {
    border-left-color: var(--c-del-edge);
    background: var(--c-del-row);
  }

  .row.right {
    border-left-color: var(--c-ins-edge);
    background: var(--c-ins-row);
  }

  .row.left.right {
    border-left-color: var(--c-border-strong);
  }

  .row-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .row-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--c-text);
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    white-space: nowrap;
    font-size: 10px;
    color: var(--c-text-faint);
  }

  .sha {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .refs {
    padding: 0 3px;
    border-radius: 3px;
    background: var(--c-selection);
    color: var(--c-text-muted);
  }

  .assign {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
  }

  .ab {
    width: 20px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--c-border);
    border-radius: 4px;
    background: var(--c-bg);
    font: inherit;
    font-size: 10px;
    color: var(--c-text-muted);
    cursor: pointer;
  }

  /* Same guard: hovering an assigned slot must not clear its accent. */
  .ab:hover:not(.on) {
    border-color: var(--c-border-strong);
    color: var(--c-text);
  }

  .ab.on {
    border-color: var(--c-accent);
    background: var(--c-selection);
    color: var(--c-text);
  }

  /* --- branches --------------------------------------------------------- */
  .branch-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 2px 5px 2px 4px;
    border-radius: 4px;
  }

  .branch-row:hover {
    background: var(--c-bg-sunken);
  }

  /* The dot column is reserved on every row, so names line up and the current
     branch is marked by a glyph rather than by indentation. */
  .branch-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 11px;
    width: 11px;
    height: 11px;
    color: var(--c-accent);
  }

  .branch-row.current .branch-name {
    font-weight: 590;
    color: var(--c-text);
  }

  .branch-name {
    font-size: 11px;
    color: var(--c-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .branch-flag {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--c-text-faint);
  }

  /* Ahead / behind are counts, so they are set in tabular figures and kept
     quieter than the branch name. */
  .track {
    flex: 0 0 auto;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-faint);
  }

  .track.ahead {
    color: var(--c-ins-text);
  }

  .track.behind {
    color: var(--c-del-text);
  }

  /* The switch button is wider than the 左/右 slots, so it drops `.ab`'s fixed
     20px and sizes to its label. */
  .branch-row .ab {
    width: auto;
    height: 18px;
    padding: 0 7px;
    white-space: nowrap;
  }

  .branch-row .ab:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --- branch comparison ------------------------------------------------ */
  /*
   * A styled native `<select>`, not a rebuilt dropdown.
   *
   * The popup itself has to stay native — it is the one list macOS draws correctly
   * with keyboard navigation, type-ahead and screen-reader support — but the closed
   * control was the ugly part: the platform draws a bevel, a grey gradient and a
   * double-triangle stepper that belongs in 2008. `appearance: none` removes all of
   * that and the chevron below is drawn by us.
   */
  .pick-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }

  .select-wrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
  }

  .branch-select {
    flex: 1 1 auto;
    min-width: 0;
    height: 24px;
    /* Right padding is the chevron's lane, so a long branch name truncates before
       reaching it instead of running underneath. */
    padding: 0 20px 0 6px;
    border: 1px solid var(--c-border-strong);
    border-radius: 5px;
    background: var(--c-bg);
    color: var(--c-text);
    font: inherit;
    font-size: 11px;
    text-overflow: ellipsis;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .branch-select:hover {
    border-color: var(--c-text-faint);
  }

  .branch-select:focus-visible {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-selection);
  }

  /* The chevron is painted over the select's own right padding and must not eat
     the click, so it is inert. */
  .chevron {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    color: var(--c-text-faint);
    pointer-events: none;
  }

  .primary.wide {
    margin-top: 6px;
  }

  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .change {
    width: 100%;
  }

  /* Status word, not a letter: "M" beside a path is a puzzle, while "modified"
     is read at a glance. The tint matches the diff's own colours. */
  .status {
    flex: 0 0 auto;
    min-width: 52px;
    font-size: 10px;
    color: var(--c-text-faint);
  }

  .status.added {
    color: var(--c-ins-text);
  }

  .status.deleted {
    color: var(--c-del-text);
  }

  .change .count {
    font-variant-numeric: tabular-nums;
    color: var(--c-text-faint);
  }

  .empty.pad {
    padding: 2px 0 4px;
  }

  /* --- messages --------------------------------------------------------- */
  .empty {
    margin: 0;
    padding: 4px 2px;
    font-size: 11px;
    color: var(--c-text-faint);
  }

  .pad {
    padding: 8px 12px;
  }

  .error {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--c-del-gutter-text);
  }

  /* --- footer ----------------------------------------------------------- */
  .foot {
    flex: 0 0 auto;
    padding: 8px 12px;
    border-top: 1px solid var(--c-border);
  }

  .primary {
    width: 100%;
    height: 26px;
    border: none;
    border-radius: 6px;
    background: var(--c-accent);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    color: #fff;
    cursor: pointer;
  }

  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
