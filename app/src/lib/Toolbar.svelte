<script lang="ts">
  /**
   * Native-feeling toolbar.
   *
   * Deliberately flat: a single hairline-bordered strip, no floating cards, no
   * gradients. Controls are grouped by function with 1px separators, which is how
   * AppKit toolbars read. All icons are inline SVG paths drawn at 14px — no icon
   * font, no sprite sheet.
   */
  import type { DiffStats, OptionsPatch, Session, Side } from "../lib/types";
  import { nextTheme } from "../lib/themeCycle";
  import { t } from "../lib/i18nStore";
  import type { ThemeMode } from "../lib/settings";

  interface Props {
    session: Session | null;
    view: "split" | "unified";
    stats: DiffStats;
    busy: boolean;
    themeMode: "system" | "light" | "dark";
    /** Return to the paste screen to enter new content. */
    onNew: () => void;
    onToggleView: () => void;
    onOptions: (patch: OptionsPatch) => void;
    onTheme: (mode: "system" | "light" | "dark") => void;
    onJumpPrev: () => void;
    onJumpNext: () => void;
    /** True when at least one unchanged run is still collapsed. */
    hasFolds: boolean;
    onToggleFolds: () => void;
    /** True when the settings sheet is showing. */
    settingsOpen: boolean;
    onToggleSettings: () => void;
    /** True while the side-by-side editors are open. */
    editing: boolean;
    /** Enter or leave edit mode. */
    onToggleEdit: () => void;
    position: {
      changeIndex: number;
      changeTotal: number;
      line: number;
      total: number;
    };
    /** True when long lines are wrapped instead of horizontally scrolled. */
    wrapLines: boolean;
    onToggleWrap: () => void;
    /** True while the git history sheet is showing. */
    gitOpen: boolean;
    onToggleGit: () => void;
    /** True while the comparison history sheet is showing. */
    historyOpen: boolean;
    onToggleHistory: () => void;
  }

  let {
    session,
    view,
    stats,
    busy,
    themeMode,
    onNew,
    onToggleView,
    onOptions,
    onTheme,
    onJumpPrev,
    onJumpNext,
    hasFolds,
    onToggleFolds,
    position,
    settingsOpen,
    onToggleSettings,
    editing,
    onToggleEdit,
    wrapLines,
    onToggleWrap,
    gitOpen,
    onToggleGit,
    historyOpen,
    onToggleHistory,
  }: Props = $props();

  const ignoreWhitespace = $derived(session?.options.ignore_whitespace ?? false);
  const patience = $derived(session?.options.algorithm === "patience");
  const changeCount = $derived(stats.added + stats.deleted + stats.modified);

  /** Localised display name of an appearance mode, for the tooltip and label. */
  function themeName(mode: ThemeMode): string {
    return $t(mode === "light" ? "theme.light" : mode === "dark" ? "theme.dark" : "theme.system");
  }

  /**
   * The "difference 3 of 7" readout as one string.
   *
   * Built with `$t` and `{index}/{total}` placeholders rather than as three
   * adjacent nodes: word order differs between languages ("Difference 3 of 7" vs
   * "第 3 / 7 个差异"), so the numbers have to move with the translation.
   */
  const positionLabel = $derived(
    $t("toolbar.diffPosition", {
      index: position.changeIndex,
      total: position.changeTotal,
    }),
  );
  /**
   * Last path segment, or a placeholder when a side was pasted.
   *
   * Only the basename: a full path can be most of the toolbar, and the title
   * attribute carries the rest for anyone who needs to disambiguate.
   */
  /**
   * Display name for one side.
   *
   * A git side is named after its file, not after its path: a historical blob has
   * no `path` (that is the guard against ⌘S writing it back), so keying the name
   * off `path` alone labelled both panes "粘贴内容" — the one case where the name
   * matters most, because the two sides are the same file at two revisions.
   */
  function fileName(side: Side | undefined): string {
    if (!side) return $t("side.pasted");
    const source = side.path ?? side.git?.file ?? "";
    if (!source) return $t("side.pasted");
    return source.split("/").pop() || source;
  }

  /**
   * Tooltip for one side.
   *
   * A git side shows `<sha> · <file>` rather than the on-disk path, because that
   * is the identity of the content: two panes of the same file differ only by
   * revision, and the path would be identical in both tooltips.
   */
  function fileTitle(side: Side | undefined): string {
    if (!side) return "";
    if (side.git) return `${side.git.short} · ${side.git.file}`;
    return side.path ?? $t("side.pasted");
  }

</script>

<div class="toolbar">
  <div class="group">
    <button class="btn" onclick={onNew} title={$t("toolbar.newTitle")}>
      {$t("toolbar.new")}
    </button>
    <!--
      Git history lives next to "重新输入" because both answer "what am I
      comparing": one replaces the content with something new, the other replaces
      it with an older revision. Putting it in the trailing group would class it
      with appearance settings, which it is not.
    -->
    <button
      class="btn icon"
      class:active={gitOpen}
      onclick={onToggleGit}
      title={$t("toolbar.gitTitle")}
      aria-label={$t("toolbar.git")}
      aria-pressed={gitOpen}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="4.6" cy="3.4" r="1.9" fill="none" stroke="currentColor" stroke-width="1.3" />
        <circle cx="4.6" cy="12.6" r="1.9" fill="none" stroke="currentColor" stroke-width="1.3" />
        <circle cx="11.6" cy="8" r="1.9" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path
          d="M4.6 5.3v2.4c0 1.2 1 2.2 2.2 2.2h2.9M4.6 10.7V9.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      </svg>
    </button>
    <!--
      History sits next to the git button: both answer "what am I comparing",
      one from a repository and one from earlier in this app. A clock-with-arrow
      glyph, not a list of lines — a list icon at 13px reads as another view mode.
    -->
    <button
      class="btn icon"
      class:active={historyOpen}
      onclick={onToggleHistory}
      title={$t("toolbar.historyTitle")}
      aria-label={$t("toolbar.history")}
      aria-pressed={historyOpen}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path
          d="M13.2 8a5.2 5.2 0 1 1-1.7-3.8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
        <path d="M13.4 1.9v2.6h-2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M8 5.3V8l1.9 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>

  <div class="sep"></div>

  <!--
    View mode as a segmented control, not a single toggling button.
    A lone button that relabels itself makes the user read the label to know the
    current state; two segments show both options and which one is live.
  -->
  <div class="segmented" role="radiogroup" aria-label={$t("toolbar.viewMode")}>
    <button
      class="seg"
      class:on={view === "split"}
      role="radio"
      aria-checked={view === "split"}
      onclick={() => view !== "split" && onToggleView()}
      title={$t("toolbar.splitTitle")}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <rect x="1.5" y="2.5" width="5.5" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="9" y="2.5" width="5.5" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
      {$t("toolbar.split")}
    </button>
    <button
      class="seg"
      class:on={view === "unified"}
      role="radio"
      aria-checked={view === "unified"}
      onclick={() => view !== "unified" && onToggleView()}
      title={$t("toolbar.unifiedTitle")}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M4.5 6.5h7M4.5 9.5h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      {$t("toolbar.unified")}
    </button>
  </div>

  <div class="sep"></div>

  <!--
    Edit toggle, next to the view switch because both answer "how am I looking at
    this". A pencil rather than a word: the toolbar's other text buttons are all
    verbs with keyboard shortcuts, and this one is a mode.

    Disabled without a session: there is nothing to edit on the paste screen, and
    a control that looks available but does nothing is worse than one that is
    visibly unavailable.
  -->
  <div class="group">
    <button
      class="btn icon"
      class:active={editing}
      disabled={!session}
      onclick={onToggleEdit}
      title={editing ? $t("toolbar.editExitTitle") : $t("toolbar.editTitle")}
      aria-label={editing ? $t("toolbar.editExit") : $t("toolbar.edit")}
      aria-pressed={editing}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M10.4 2.9a1.7 1.7 0 0 1 2.4 2.4l-6.6 6.6-3.2.8.8-3.2z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <!--
      Word-wrap toggle, immediately after edit because both change how the
      document is displayed rather than what is in it.

      The icon is the conventional "arrow turning down from a line": the line runs
      to the right edge and continues on the next. It stays active-tinted while on,
      like the other toggles in this bar.
    -->
    <button
      class="btn icon"
      class:active={wrapLines}
      disabled={!session}
      onclick={onToggleWrap}
      title={wrapLines ? $t("toolbar.wrapOn") : $t("toolbar.wrapOff")}
      aria-label={$t("toolbar.wrap")}
      aria-pressed={wrapLines}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
        <path
          d="M9.6 10.8 7.6 13l2 2.2"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  <div class="sep"></div>

  <div class="group">
    <button class="btn icon" onclick={onJumpPrev} title={$t("toolbar.prevDiffTitle")} aria-label={$t("toolbar.prevDiff")}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="m10 4-4 4 4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button class="btn icon" onclick={onJumpNext} title={$t("toolbar.nextDiffTitle")} aria-label={$t("toolbar.nextDiff")}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="m6 4 4 4-4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  <div class="sep"></div>

  <div class="group">
    <button
      class="btn"
      class:active={ignoreWhitespace}
      onclick={() => onOptions({ ignoreWhitespace: !ignoreWhitespace })}
      title={$t("toolbar.ignoreWhitespaceTitle")}
      aria-pressed={ignoreWhitespace}
    >
      {$t("toolbar.ignoreWhitespace")}
    </button>
    <button
      class="btn"
      class:active={patience}
      onclick={() => onOptions({ algorithm: patience ? "myers" : "patience" })}
      title={$t("toolbar.algorithmTitle")}
      aria-pressed={patience}
    >
      {patience ? "Patience" : "Myers"}
    </button>
  </div>

  <div class="sep"></div>

  <div class="group">
    <button
      class="btn"
      onclick={onToggleFolds}
      title={hasFolds ? $t("toolbar.expandAllTitle") : $t("toolbar.collapseAllTitle")}
    >
      {$t(hasFolds ? "toolbar.expandAll" : "toolbar.collapseAll")}
    </button>
  </div>

  <div class="spacer"></div>

  <!--
    Position readout. Two numbers on purpose: "3/12" answers "which change",
    "L481" answers "which line of the file". A reviewer needs both — one to know
    how much is left, the other to talk about the code with someone else.
  -->
  {#if position.changeTotal > 0}
    <div class="position" aria-live="polite" aria-atomic="true">
      <span class="pos-change">{positionLabel}</span>
      <span class="pos-line" title={$t("toolbar.firstDiffLine")}>
        L<span class="pos-num">{position.line}</span>
      </span>
    </div>
  {:else if position.total > 0}
    <div class="position" aria-live="polite">
      <span class="pos-line">L<span class="pos-num">{position.line}</span><span class="pos-sep">/</span>{position.total}</span>
    </div>
  {/if}

  <!--
    Filenames, when the sides came from disk.

    The pane header used to carry this, one per side. Removing the headers took
    the filenames with it, and "which file am I looking at" is the one thing a
    diff cannot answer on its own — a pasted block has no name, but an imported
    file does. Naming both here keeps that information in a single place instead
    of two strips competing with the code.
  -->
  {#if session?.left.path || session?.right.path || session?.left.git || session?.right.git}
    <div class="files" aria-live="polite">
      <span class="file" title={fileTitle(session?.left)}>
        {fileName(session?.left)}
        {#if session?.left.git}<span class="rev">{session.left.git.short}</span>{/if}
      </span>
      <span class="file-sep">↔</span>
      <span class="file" title={fileTitle(session?.right)}>
        {fileName(session?.right)}
        {#if session?.right.git}<span class="rev">{session.right.git.short}</span>{/if}
      </span>
    </div>
  {/if}

  <div class="sep"></div>

  <!-- Stats sit right-aligned, like a document status line. -->
  <div class="stats" aria-live="polite">
    {#if changeCount === 0 && session}
      <span class="stat clean">{$t("toolbar.noDiff")}</span>
    {:else}
      <span class="stat add">+{stats.added}</span>
      <span class="stat del">−{stats.deleted}</span>
      <span class="stat mod">~{stats.modified}</span>
    {/if}
  </div>

  <div class="sep"></div>

  <!-- `trailing`: pinned so the settings gear survives a narrow window. -->
  <div class="group trailing">
    <!--
      Appearance as a single cycling button.

      It used to be a three-segment control, on the reasoning that a cycling
      button hides which modes exist. In practice the segmented form took three
      times the width of every other toolbar control for a setting that is changed
      rarely, and it was the widest thing in a strip that has to fit a narrow
      window. The title carries the full explanation ("当前 深色 · 点击切换") and the
      icon is the current mode, so the state is still readable at a glance.

      The order is light → dark → system, which is the order the three choices are
      easiest to think about, and it means a full cycle returns to where it began.
    -->
    <button
      class="btn icon"
      onclick={() => onTheme(nextTheme(themeMode))}
      title={$t("theme.title", { name: themeName(themeMode) })}
      aria-label={$t("theme.ariaLabel", { name: themeName(themeMode) })}
    >
      {#if themeMode === "light"}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path
            d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      {:else if themeMode === "dark"}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" />
        </svg>
      {/if}
    </button>
    <!--
      Settings entry point. It opens a side sheet rather than a dialog so the diff
      stays visible while colours are tuned.

      The icon is a slider bank, not a gear with radiating teeth: at 14px a gear's
      teeth collapse into a fuzz indistinguishable from the sun icon beside it —
      which is exactly how the two ended up looking like duplicates.
    -->
    <button
      class="btn icon"
      class:active={settingsOpen}
      onclick={onToggleSettings}
      title={$t("toolbar.settingsTitle")}
      aria-label={$t("toolbar.settings")}
      aria-pressed={settingsOpen}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <!-- Three sliders: two horizontal tracks with a knob, one below. -->
        <path
          d="M2.2 5h11.6M2.2 11h11.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
        <circle cx="5.6" cy="5" r="1.9" fill="var(--c-bg-elevated)" stroke="currentColor" stroke-width="1.3" />
        <circle cx="10.4" cy="11" r="1.9" fill="var(--c-bg-elevated)" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
  </div>
</div>

{#if busy}
  <div class="progress" role="progressbar" aria-label={$t("toolbar.busy")}></div>
{/if}



<style>
  /*
   * Single row, no scrolling, and the trailing group is pinned.
   *
   * The toolbar used to be a plain flex row with `overflow: visible`. Below about
   * 640px the children no longer fitted, and because nothing shrank the last
   * group simply ran past the right edge and disappeared — the settings gear in
   * particular became unreachable while the theme button (one slot earlier) was
   * still visible. That reads as "settings cannot be opened".
   *
   * Now the leading half may compress (labels get clipped) while the trailing
   * group keeps its intrinsic width, so the gear is always on screen.
   */
  .toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 36px;
    padding: 0 8px;
    border-bottom: 1px solid var(--c-border);
    background: var(--c-bg-elevated);
    overflow: hidden;
    /* Nothing in a 36px strip may wrap; clipping is the acceptable failure. */
    flex-wrap: nowrap;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 2px;
    /*
     * Groups may shrink when the window is narrow, but the last one must not:
     * it holds the theme and settings controls, which have to stay reachable at
     * any width. `min-width: 0` on the others lets their labels clip instead of
     * pushing the trailing group off the edge.
     */
    flex: 0 1 auto;
    min-width: 0;
  }

  /* The trailing group (theme + settings) never shrinks or clips. */
  .group.trailing {
    flex: 0 0 auto;
    overflow: visible;
  }

  /* 1px separators between functional groups, vertically inset. */
  .sep {
    width: 1px;
    height: 16px;
    margin: 0 6px;
    background: var(--c-border);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    min-width: 24px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--c-text);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }

  /*
   * Hover must not win over an active state.
   *
   * `.btn.active` is (0,2,0) but `:hover:not(:disabled)` is (0,3,0) — higher — so
   * hovering a toggled-on button replaced its blue chip with the neutral hover
   * wash, and the colour only came back when the pointer left. This is the same
   * guard `.seg:hover:not(.on)` already had.
   *
   * An active button still needs hover feedback, or it feels inert, so it deepens
   * its own accent wash instead of reverting to neutral.
   */
  .btn:hover:not(:disabled):not(.active) {
    background: var(--c-bg-sunken);
  }

  /* Pressed/toggled state reads as a filled chip, not a border swap. */
  .btn.active {
    background: var(--c-selection);
    color: var(--c-text);
  }

  .btn.active:hover:not(:disabled) {
    background: var(--c-selection-strong);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .btn.icon {
    padding: 0;
    width: 24px;
  }

  /* --- segmented control ------------------------------------------------ */
  .segmented {
    display: inline-flex;
    padding: 1px;
    border-radius: 6px;
    background: var(--c-bg-sunken);
  }



  .seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--c-text-muted);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }

  .seg:hover:not(.on) {
    color: var(--c-text);
  }

  /* The selected segment reads as a raised chip, like a macOS segmented control. */
  .seg.on {
    background: var(--c-bg);
    color: var(--c-text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }

  /* --- position readout ------------------------------------------------ */
  .position {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 2px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-muted);
    white-space: nowrap;
  }

  /* The numbers carry the weight; the verbs around them stay quiet. */
  .pos-num {
    color: var(--c-text);
    font-weight: 590;
  }

  .pos-sep {
    margin: 0 1px;
    color: var(--c-text-faint);
  }

  .pos-line {
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--c-bg-sunken);
    color: var(--c-text-muted);
  }

  /* --- filenames -------------------------------------------------------- */
  /*
   * Quiet, monospace, clipped from the left so the basename survives: the same
   * treatment a terminal gives a path. Max-width keeps a deep path from pushing
   * the stats off the strip.
   */
  .files {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 42%;
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--c-text-muted);
  }

  .file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-sep {
    flex: 0 0 auto;
    color: var(--c-text-faint);
  }

  /* Revision tag beside a filename: small, monospaced, recessive. */
  .rev {
    margin-left: 4px;
    padding: 0 3px;
    border-radius: 3px;
    background: var(--c-bg-sunken);
    font-size: 9.5px;
    color: var(--c-text-faint);
  }

  /* --- stats ----------------------------------------------------------- */
  .stats {
    display: flex;
    gap: 8px;
    padding: 0 4px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .stat {
    font-weight: 590;
  }

  .stat.add {
    color: #1f9d55;
  }

  .stat.del {
    color: #d0355c;
  }

  .stat.mod {
    color: var(--c-text-muted);
  }

  .stat.clean {
    color: var(--c-text-faint);
    font-weight: 400;
  }

  /* Indeterminate 2px progress line: enough to say "working" without a spinner
     that would imply progress we cannot measure. */
  .progress {
    position: absolute;
    top: 36px;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--c-accent) 40%,
      var(--c-accent) 60%,
      transparent 100%
    );
    background-size: 40% 100%;
    background-repeat: no-repeat;
    animation: slide 1.1s linear infinite;
    z-index: 10;
  }

  @keyframes slide {
    from {
      background-position: -40% 0;
    }
    to {
      background-position: 140% 0;
    }
  }
</style>
