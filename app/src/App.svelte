<script lang="ts">
  /**
   * Application shell.
   *
   * Owns all mutable state and is the *only* place that talks to the backend.
   * Children are presentational and receive data + callbacks.
   *
   * Scroll authority: both panes report their scrollTop here; this component
   * stores one `scrollTop` and writes it back to both. Because the panes are
   * pixel-identical (same row height, same item list), "strictly synchronised"
   * falls out of that single number rather than needing ratio maths.
   */
  import { onMount, tick } from "svelte";
  import Toolbar from "./lib/Toolbar.svelte";
  import DiffPane from "./lib/DiffPane.svelte";
  import Minimap from "./lib/Minimap.svelte";
  import UnifiedView from "./lib/UnifiedView.svelte";
  import EmptyState from "./lib/EmptyState.svelte";
  import EditPane from "./lib/EditPane.svelte";
  import GitPanel from "./lib/GitPanel.svelte";
  import { resetGitPanelState } from "./lib/gitSession";
  import SameBanner from "./lib/SameBanner.svelte";
  import * as ipc from "./lib/ipc";
  import {
    buildDisplay,
    displayIndexForRow,
    foldHidingRow,
    scrollTopAfterExpand,
    gutterWidthFor,
    scrollTopToRow,
    scrollTopToCentre,
    anchorIndexForScroll,
    unifiedFoldHidingRow,
    unifiedIndexIn,
    buildUnifiedDisplay,
    windowFor,
    expandWrapped,
    nearestChange,
  } from "./lib/viewport";
  import type { DisplayItem } from "./lib/viewport";
  import { applyPalette, buildPalette, metrics } from "./lib/theme";
  import {
    DEFAULTS,
    loadSettings,
    normalizeSettings,
    rowHeightFor,
    saveSettings,
    type Settings,
    type ThemeMode,
  } from "./lib/settings";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import type {
    GitSpec,
    OptionsPatch,
    PasteBlock,
    PastePair,
    Session,
    Side,
    SideName,
  } from "./lib/types";
  import { splitLines } from "./lib/types";
  import { createTokenSource, detectLanguage } from "./lib/syntax";
  import { t, resolveLocale, setLocale } from "./lib/i18nStore";
  import TabStrip from "./lib/TabStrip.svelte";
  import { createEmptyTab, indexAfterClose, moveTab, type Tab } from "./lib/tabs";
  import HistoryPanel from "./lib/HistoryPanel.svelte";
  import {
    entryFromSession,
    sessionFromEntry,
    sessionKey,
    shouldRecord,
    type HistorySummary,
  } from "./lib/history";

  // --- state ------------------------------------------------------------

  /*
   * Tabs hold the comparisons; `session` is a view onto the active one.
   *
   * Keeping `session` derived rather than a second copy means the rest of this
   * component — which reads `session`, `rows`, `stats` in dozens of places — did not
   * have to change: activating a tab changes `activeId` and every downstream value
   * follows.
   *
   * The per-tab view state (`scrollTop`, `expanded`) is *not* derived; it is written
   * back to the outgoing tab on switch. Making that reactive too would fight the
   * scroll observer, which writes the same values during a programmatic scroll.
   */
  /*
   * The app opens with one blank tab, not with none.
   *
   * A tab strip only renders when there is a tab, so starting with an empty list
   * meant the "+" button did not exist on first launch: there was no way to open a
   * new tab until a comparison already existed. One blank tab gives the strip a
   * home, keeps `activeId` total ("which tab am I in" always has an answer), and
   * renders the identical paste screen inside it.
   */
  const firstTab = createEmptyTab();
  let tabs = $state<Tab[]>([firstTab]);
  let activeId = $state<string | null>(firstTab.id);
  const activeTab = $derived(tabs.find((tab) => tab.id === activeId) ?? null);
  const session = $derived<Session | null>(activeTab?.session ?? null);
  let view: "split" | "unified" = $state("split");
  let expanded = $state<Set<number>>(new Set());
  let scrollTop = $state(0);
  /** Scroll container of whichever view is showing, for viewport measurement. */
  let splitHost = $state<HTMLDivElement | null>(null);
  /** Horizontal offset, shared so both panes always show the same columns. */
  let scrollLeft = $state(0);
  /**
   * Hunk index reached by the last ⌘]/⌘[ jump.
   *
   * Navigation cannot rely on the viewport's top row alone: jumping to a hunk
   * near the top of the document clamps the scroll offset to 0, so the anchor row
   * stays at 0 and the next ⌘] finds the very same hunk again. Remembering the
   * target makes stepping monotonic regardless of where the clamp lands.
   */
  let navHunk = $state<number | null>(null);
  /**
   * Scroll offset we last commanded programmatically.
   *
   * The pane echoes our own `scrollTop` back through `onScroll`. Comparing the
   * echoed value against this target — instead of relying on a boolean cleared by
   * a timer — is immune to event-ordering: any echo at the commanded offset is
   * ours, and anything else is the user. A timing flag can leak when a scroll
   * event is coalesced or when the requested offset is already current, which
   * leaves `navHunk` pinned and the readout frozen.
   */
  let programmaticTarget: number | null = null;
  let viewportHeight = $state(0);
  let hovered = $state<number | null>(null);
  let status = $state<string>("");
  let busy = $state(false);
  let dragSide = $state<SideName | null>(null);
  /**
   * User settings, loaded once at module init.
   *
   * `themeMode` is now a view onto `settings.theme` rather than its own state:
   * two sources for the same preference meant the toolbar toggle and the settings
   * sheet could disagree after a reload.
   */
  let settings = $state<Settings>(loadSettings());
  let settingsOpen = $state(false);
  /**
   * Git history sheet.
   *
   * Separate from `settingsOpen`: the two are different tools that happen to both
  let gitOpen = $state(false);

  /**
   * Comparison history sheet, plus the list it renders.
   *
   * `historySeq` guards against an out-of-order refresh overwriting a newer
   * list: the calls are async and a fast double-delete can resolve its reloads
   * backwards, which would resurrect a deleted row until the next open.
   */
  let historyOpen = $state(false);
  let historyEntries = $state<HistorySummary[]>([]);
  let historyLoading = $state(false);
  let historySeq = 0;

  /**
   * Identity of the comparison most recently written to disk.
   *
   * A commit fires on every option toggle, tab switch and edit apply, and each
   * one would otherwise append another copy of the same two documents. Comparing
   * `sessionKey` means "the same pair of documents was already saved", which is
   * the right granularity: the key deliberately ignores the *result*.
   */
  let lastSavedKey = "";

  /**
   * Git history sheet.
   *
   * Separate from `settingsOpen`: the two are different tools that happen to both
   * open on the right, and closing one must not reveal that the other was open
   * underneath. Opening either closes the other, so there is never a stack.
   */
  let gitOpen = $state(false);

  /**
   * Edit mode: both sides become one full-text editor each.
   *
   * Off by default. The read-only view is the product — a diff is something you
   * *read* — but once the user wants to act on what they found, retyping into a
   * separate window and re-pasting is the worst part of every diff tool. An
   * explicit switch keeps the default state unambiguous while making the edit
   * path one click away.
   */
  let editing = $state(false);

  /** Horizontal padding inside a cell: 10px left + 12px right (see `CodeLine`). */
  const CHAR_PADDING = 22;

  /**
   * Advance width of one monospace character, in px.
   *
   * Reactive, and measured from the rendered font rather than assumed: the bundled
   * JetBrains Mono advance differs from Menlo's, so a hard-coded value wraps a few
   * characters early or late.
   */
  let charWidth = $state(7.2);

  /**
   * Measured width of the narrower pane, in px.
   *
   * Kept as state and filled by the resize observer rather than read from
   * `splitHost` inside the derived value: the host element lives inside an `{#if}`
   * branch, so on first evaluation it is null and the width would be 0 — which
   * silently disables wrapping the first time the button is pressed.
   */
  let paneWidth = $state(0);

  /**
   * Draft buffers for edit mode, kept separate from `session`.
   *
   * Writing straight into `session.left.text` would make the rendered diff
   * disagree with the text being edited, and it would fire a re-diff on every
   * keystroke. Drafts let the comparison stay frozen until the user says it is
   * done, which is also what makes "cancel" meaningful.
   */
  let draftLeft = $state("");
  let draftRight = $state("");
  /** True while the split divider is being dragged, to show the resize cursor. */
  let dividerDragging = $state(false);

  const themeMode = $derived<ThemeMode>(settings.theme);

  const leftLines = $derived(session ? splitLines(session.left.text) : []);
  const rightLines = $derived(session ? splitLines(session.right.text) : []);

  /*
   * Language, per side.
   *
   * Detected from each side's own filename, falling back to its content: comparing
   * `runner.go` against `runner_old.go` highlights both as Go, while a pasted block
   * has no name at all and is recognised from what it contains. Per side rather than
   * per comparison because a diff may legitimately pit JSON against YAML — comparing
   * a config file's rewrite is exactly that — and colouring one as the other would
   * be wrong.
   */
  const languageEnabled = $derived(settings.syntaxHighlight);
  const leftLanguage = $derived(
    languageEnabled && session
      ? detectLanguage(session.left.git?.file ?? session.left.path ?? session.left.label, session.left.text)
      : "plain",
  );
  const rightLanguage = $derived(
    languageEnabled && session
      ? detectLanguage(session.right.git?.file ?? session.right.path ?? session.right.label, session.right.text)
      : "plain",
  );

  /**
   * Token sources per side.
   *
   * Lazy and memoised (see `createTokenSource`): a window of ~40 lines tokenises 40
   * lines, not the whole file, and the per-document state pass is reused across
   * scrolls. A new comparison produces new arrays, which is the only thing that
   * invalidates either cache.
   */
  const leftTokens = $derived(createTokenSource(leftLines, leftLanguage));
  const rightTokens = $derived(createTokenSource(rightLines, rightLanguage));

  const rows = $derived(session?.result.rows ?? []);

  const hunks = $derived(session?.result.hunks ?? []);

  /**
   * The unified view's line list, folded.
   *
   * Shared state with the split view on purpose: `expanded` holds hunk indices, so
   * a run the user opened in one view stays open in the other. Without folding here
   * the inline view rendered every unchanged line in full while the side-by-side
   * view collapsed them — the same file, two different amounts of scrolling.
   *
   * Declared after `hunks` because it projects them; `unifiedCount` follows from it.
   */
  const unifiedItems = $derived(
    buildUnifiedDisplay(
      hunks,
      rows,
      settings.autoFold ? settings.foldThreshold : Infinity,
      expanded,
    ),
  );

  const unifiedCount = $derived(unifiedItems.length);
  const stats = $derived(session?.result.stats ?? { added: 0, deleted: 0, modified: 0, unchanged: 0 });
  /** True when there is something on screen to compare, as opposed to the paste screen. */
  const hasContent = $derived(
    session !== null && (session.left.text !== "" || session.right.text !== ""),
  );

  /** True when a real comparison produced no changes at all. */
  const isIdentical = $derived(
    session !== null &&
      stats.added === 0 &&
      stats.deleted === 0 &&
      stats.modified === 0 &&
      rows.length > 0,
  );

  /**
   * Dismissal is keyed to the comparison, not to a bare boolean.
   *
   * A boolean would keep the banner hidden for the *next* comparison too, so a
   * second pair of identical documents would silently show no notice. Storing a
   * fingerprint means "I have read this one", which is what the user meant.
   */
  let dismissedFor = $state<string | null>(null);

  const comparisonKey = $derived(
    session
      ? `${session.left.text.length}:${session.right.text.length}:${rows.length}:${stats.added}:${stats.deleted}:${stats.modified}`
      : "",
  );

  const showSameBanner = $derived(isIdentical && dismissedFor !== comparisonKey);

  /** Which comparison options are suppressing differences, for the banner text. */
  const ignoringOptions = $derived.by(() => {
    const out: string[] = [];
    if (session?.options.ignore_whitespace) out.push($t("ignore.leadingTrailingWhitespace"));
    if (session?.options.ignore_all_whitespace) out.push($t("ignore.allWhitespace"));
    if (session?.options.ignore_case) out.push($t("ignore.case"));
    return out;
  });

  /**
   * Base display list: folding only.
   *
   * Wrapping is applied afterwards because the two sides wrap to their own width
   * and their own text — the same aligned row can be two physical lines on the left
   * and one on the right.
   */
  const baseItems: DisplayItem[] = $derived(
    buildDisplay(hunks, settings.autoFold ? settings.foldThreshold : Infinity, expanded),
  );

  /**
   * Characters that fit in one wrapped line.
   *
   * Derived from the measured pane width rather than a fixed count, so the wrap
   * follows the divider and the window. Gutter and cell padding are subtracted.
   */
  const wrapColumns = $derived.by(() => {
    if (!settings.wrapLines) return Infinity;
    // `paneWidth` is measured by the ResizeObserver below, not read from `splitHost`
    // here: the host is bound inside the `{#if}` branch, so at the moment this
    // derived value first evaluates the element does not exist yet and the width
    // would be 0 — which silently disabled wrapping on first use.
    if (paneWidth <= 0) return Infinity;
    const usable = paneWidth - gutterWidth - CHAR_PADDING;
    return Math.max(1, Math.floor(usable / Math.max(1, charWidth)));
  });

  const items: DisplayItem[] = $derived(
    settings.wrapLines
      ? expandWrapped(baseItems, wrapColumns, (row) => {
          const r = rows[row];
          if (!r) return 0;
          const l = r.left !== null ? (leftLines[r.left]?.length ?? 0) : 0;
          const rt = r.right !== null ? (rightLines[r.right]?.length ?? 0) : 0;
          // Longer side wins: both panes must yield the same item count or the
          // synchronised scroll drifts by the difference in wrapped lines.
          return Math.max(l, rt);
        })
      : baseItems,
  );

  /**
   * Gutter width for the current document.
   *
   * Published as a CSS variable so every row and fold bar sizes consistently;
   * computing it per row would let them disagree by a pixel mid-render.
   */
  const gutterWidth = $derived(
    settings.lineNumbers ? gutterWidthFor(Math.max(leftLines.length, rightLines.length)) : 0,
  );

  /**
   * Live row height, derived from the font size the user chose.
   *
   * Passed explicitly to every viewport helper rather than read from `metrics`:
   * the helpers default to the build-time constant, and relying on that default
   * would keep the arithmetic at 20px while CSS rendered 24px rows — the panes
   * would then scroll to the wrong offsets.
   */
  const rowHeight = $derived(rowHeightFor(settings));

  /*
   * No trailing space below the last row.
   *
   * This used to add half a viewport so the final line could be scrolled up to the
   * top edge. Measured at the bottom of a 3000-row file: the last row sat 336px
   * below the top of a 620px viewport, leaving 284px of empty pane under it — the
   * reader reaches the end of the document and keeps scrolling through nothing.
   * The document now ends where the scroll range ends.
   */
  const splitWin = $derived(
    windowFor(scrollTop, viewportHeight, items.length, rowHeight, metrics.overscan),
  );

  /**
   * Split-view column widths, as CSS-flex basis percentages.
   *
   * The panes are flex items, so expressing the split as a percentage keeps both
   * panes resizing with the window while preserving the user's chosen ratio.
   */
  const leftPct = $derived(settings.splitRatio * 100);
  const rightPct = $derived(100 - leftPct);

  /** Render window for unified mode: no folds, one line per (sub)row. */
  const unifiedWin = $derived(
    windowFor(scrollTop, viewportHeight, unifiedCount, rowHeight, metrics.overscan),
  );
  /**
   * Item range actually on screen, for the minimap indicator.

   * Expressed in **display-item** indices, matching the scroller's own space.
   *
   * Deriving this in source rows was the old behaviour, and it is why the minimap
   * disagreed with the scrollbar: folding maps many rows onto one item, so a row
   * range and an item range are not proportional.
   *
   * Derived from `firstVisible` rather than from the render window, because the
   * window includes overscan and would draw an indicator taller than what the
   * user can actually see.
   */
  const visibleItems = $derived.by(() => {
    if (items.length === 0) return { start: 0, end: 0 };
    const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
    const start = Math.min(splitWin.firstVisible, items.length - 1);
    const end = Math.min(items.length, start + visibleCount);
    return { start, end };
  });

  /** All change hunks, with their index into `hunks`. */
  const changeHunks = $derived(
    hunks.map((h, i) => ({ h, i })).filter(({ h }) => !h.equal),
  );

  /**
   * Human-readable position for the toolbar readout.
   *
   * Two numbers because they answer different questions: which change of how many
   * ("第 3 / 12 个差异"), and which line of the file ("第 481 行"). After a ⌘] jump
   * the first is authoritative; when the user scrolls freely it falls back to
   * whatever change is under the viewport top.
   *
   * `navHunk` wins over scroll position because a jump can clamp the scroll (near
   * the top or the end of the document) and the viewport would otherwise report
   * the wrong change.
   */
  const position = $derived.by(() => {
    if (changeHunks.length === 0) {
      return { changeIndex: 0, changeTotal: 0, line: currentRow + 1, total: rows.length };
    }

    let idx = -1;

    if (navHunk !== null) {
      idx = changeHunks.findIndex(({ i }) => i === navHunk);
    }

    if (idx === -1) {
      /*
       * Nearest change to a scroll-progress anchor, not the first one below the
       * viewport top.
       *
       * The old rule was `row_start >= currentRow`, i.e. "the first change at or
       * below the top row". It fails exactly where the user reported it: when the
       * top row sits *between* two changes, the next change can be a whole
       * screenful below the fold, so nothing is highlighted even though a change
       * is plainly visible — and at the very bottom of the document every change is
       * above the top row, the search returns -1, and the fallback pinned the
       * marker to the last change forever, off-screen above.
       *
       * A middle-of-viewport anchor fixed that at first, but it has a ceiling:
       * at max scroll the midline is `itemCount - rowsVisible / 2`, so changes in
       * the bottom half of the last screenful can never be selected. The marker
       * then parks mid-screen and stops following the wheel. `anchorIndexForScroll`
       * maps the whole scroll range onto the whole item range instead, so the
       * marker still coincides with the midline mid-document but can reach the
       * final row at the bottom.
       */
      const anchorIndex = anchorIndexForScroll(
        scrollTop,
        viewportHeight,
        view === "split" ? items.length : unifiedCount,
        rowHeight,
      );
      const anchor =
        (view === "split" ? items[anchorIndex]?.row : unifiedItems[anchorIndex]?.sourceRow) ??
        currentRow;
      idx = nearestChange(changeHunks, anchor);
    }

    const line = changeHunks[idx].h.row_start + 1;
    return {
      changeIndex: idx + 1,
      changeTotal: changeHunks.length,
      line,
      total: rows.length,
    };
  });

  /** Row range of the change currently being viewed, for the in-code marker. */
  const activeHunkRows = $derived.by(() => {
    if (position.changeIndex === 0 || changeHunks.length === 0) return null;
    const h = changeHunks[position.changeIndex - 1].h;
    return { start: h.row_start, end: h.row_start + h.row_len };
  });

  /**
   * Which edge of the viewport the current change is past, if any.
   *
   * Virtualisation renders only the rows near the viewport, so a change that has
   * scrolled out of view is not merely off-screen — it is absent from the DOM. When
   * that happens the in-code marker has nothing to draw on, and the pane looks as
   * though it holds no changes at all. That is the state reported as "the highlight
   * stuck at the top": scroll far enough past the last change and every trace of it
   * is gone.
   *
   * The panes draw a thin bar against the edge instead, so the direction of the
   * change stays readable while scrolling through a part of the file that has none.
   */



  /**
   * Source row at the *top edge* of the viewport, used as the anchor for ⌘]/⌘[.
   *
   * Deliberately `win.firstVisible`, not `win.start`: `start` includes the
   * overscan rows above the viewport, so anchoring there reports a row that is
   * already scrolled off-screen — which makes the hunk you just jumped to look
   * like it is still ahead, and navigation appears stuck on it.
   */
  const currentRow = $derived(
    items[Math.min(splitWin.firstVisible, Math.max(0, items.length - 1))]?.row ?? 0,
  );

  // --- lifecycle --------------------------------------------------------

  /**
   * Repaint whenever anything that affects appearance changes.
   *
   * Reading the system preference inside this effect also makes it re-run when
   * the OS switches to dark mode while the theme is "follow system" — no media
   * query listener needed.
   */
  $effect(() => {
    const isDark =
      settings.theme === "dark" ||
      (settings.theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);

    applyPalette(
      buildPalette(isDark, {
        accent: settings.accent,
        scheme: settings.scheme,
        intensity: settings.intensity,
      }),
      isDark,
    );
  });

  /**
   * Mirror type metrics into CSS custom properties.
   *
   * The scroller's arithmetic uses `rowHeight`; the rows use `--row-height`. Both
   * must come from the same number, so both are written here in one place.
   */
  $effect(() => {
    const root = document.documentElement;
    root.style.setProperty("--row-height", `${rowHeight}px`);
    root.style.setProperty("--font-size-code", `${settings.fontSize}px`);
    root.style.setProperty("--gutter-width", `${gutterWidth}px`);
    root.style.setProperty("--change-edge-w", settings.changeEdge ? "3px" : "0px");
  });

  /**
   * Measure the monospace advance width after the font metrics are in effect.
   *
   * Done in an effect rather than inside the derived `wrapColumns`, because a
   * derived value must be a pure function of its inputs: appending a probe element
   * during evaluation would read layout mid-render and could loop. The effect runs
   * after the CSS variables above are applied, so it measures the real font, and it
   * re-runs on a font-size change.
   */
  $effect(() => {
    const fontSize = settings.fontSize;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(40);
    probe.style.cssText =
      `position:absolute;visibility:hidden;white-space:pre;` +
      `font-family:var(--font-mono);font-size:${fontSize}px`;
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    // A zero width means the element was not laid out (hidden window); keep the
    // estimate rather than wrapping every line to one character.
    if (width > 0) {
      const next = width / 40;
      if (Math.abs(next - charWidth) > 0.01) charWidth = next;
    }
  });

  /** Persist on every change; the write is a few hundred bytes. */
  $effect(() => {
    saveSettings(settings);
  });

  /**
   * Keep the language store in step with the setting.
   *
   * `settings.locale === null` means "follow the OS", so the effect resolves that
   * to a concrete locale rather than storing `null` in the store. This is the only
   * place the two representations meet; components read `$t` and never see either.
   */
  $effect(() => {
    setLocale(resolveLocale(settings.locale));
  });

  /**
   * Apply the retention window.
   *
   * Declared as an effect rather than called once from `onMount` so that changing
   * either number in the settings sheet prunes immediately: a user who lowers
   * "keep 100" to 10 expects the list to shorten now, not after a restart. The
   * three settings are the only tracked reads, so this does not re-run on a theme
   * change.
   */
  $effect(() => {
    if (!settings.historyEnabled) return;
    const days = settings.historyDays;
    const keep = settings.historyKeep;
    void ipc
      .historyPrune(days, keep)
      .then((removed) => {
        if (removed > 0 && historyOpen) void refreshHistory();
      })
      .catch(() => {
        /* Retention is housekeeping; a failure must not disturb the window. */
      });
  });

  onMount(() => {
    window.addEventListener("resize", syncViewport);
    window.addEventListener("keydown", handleKeydown);

    /*
     * Observe the scroll host rather than listening only for window resizes.
     *
     * The viewport can change without the window changing: the settings sheet
     * takes width (which reflows the panes and can change their height once the
     * horizontal scrollbar appears), switching split/unified remounts the host,
     * and font-size changes alter how much content fits. Each of those left
     * `viewportHeight` stale, and a stale height makes the virtual window render
     * too few rows — the pane looked like it stopped a screenful in.
     */
    const observer = new ResizeObserver(() => syncViewport());
    const host = document.querySelector<HTMLDivElement>(".body");
    if (host) observer.observe(host);

    syncViewport();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("keydown", handleKeydown);
    };
  });

  /**
   * Re-measure the scroll host.
   *
   * Registered as `syncViewport` (not an inline arrow) so it can be removed by
   * identity. Also re-checks on the next frame: `onMount` runs before layout is
   * committed, so a single synchronous read can see `clientHeight === 0` and
   * leave the window empty until the first resize.
   */
  function syncViewport(): void {
    const apply = () => {
      const host = document.querySelector<HTMLDivElement>(".body");
      const next = host?.clientHeight ?? 0;
      if (next > 0 && next !== viewportHeight) viewportHeight = next;

      /*
       * Measure one pane's width for wrapping.
       *
       * `splitHost` is bound inside the `{#if}` branch, so it is null until the
       * comparison renders — the reason writing `splitHost.clientWidth` into the
       * derived `wrapColumns` silently produced 0 and wrapping appeared dead on the
       * first click. Reading the first `.side` element here, after layout, avoids
       * depending on the binding's lifecycle.
       */
      const side = document.querySelector<HTMLElement>(".side");
      const sideWidth = side?.clientWidth ?? 0;
      if (sideWidth > 0 && sideWidth !== paneWidth) paneWidth = sideWidth;
    };
    apply();
    requestAnimationFrame(apply);
  }

  /**
   * Apply a settings change.
   *
   *
   * Settings that the *backend* also has an opinion about (whitespace, case,
   * intra-line) are mirrored into a re-diff, so the two can never disagree about
   * what is being compared.
   */
  async function patchSettings(patch: Partial<Settings>): Promise<void> {
    // Every write goes through `normalizeSettings`, so the clamp ranges are
    // enforced in one place. Merging the patch directly let a drag write a ratio
    // outside LIMITS, which only the stored-blob loader would have rejected.
    settings = normalizeSettings({ ...settings, ...patch });
    const diffPatch: OptionsPatch = {};
    if (patch.ignoreWhitespace !== undefined) diffPatch.ignoreWhitespace = patch.ignoreWhitespace;
    if (patch.ignoreCase !== undefined) diffPatch.ignoreCase = patch.ignoreCase;
    if (patch.intraLine !== undefined) diffPatch.intraLine = patch.intraLine;

    if (Object.keys(diffPatch).length > 0 && session) {
      await applyOptions(diffPatch);
    }
  }

  function resetSettings(): void {
    void patchSettings({ ...DEFAULTS });
  }

  // --- backend interaction ---------------------------------------------

  /**
   * Commit a backend response.
   */
  /**
   * Replace the active comparison with a fresh one.
   *
   * The distinction that matters: a *new* comparison opens a tab, while changing the
   * current one (an option toggle, an edit, loading a file into a side) updates the
   * tab in place. So this replaces the active tab's session and leaves the others
   * alone — `openTab` is the entry point for "start something new".
   */
  async function commit(promise: Promise<Session>): Promise<void> {
    busy = true;
    status = "";
    try {
      const next = await promise;
      if (!next || !next.left || !next.right || !next.result) {
        status = $t("app.compareFailed");
        return;
      }
      navHunk = null;
      if (next.warnings.length > 0) status = next.warnings.join(" · ");

      /*
       * Record before branching on the tab.
       *
       * The history entry belongs to the *comparison*, not to the tab that holds
       * it, and both branches below produce exactly one new comparison. Recording
       * here also means an option toggle reaches it — `sessionKey` then decides
       * that nothing new was compared and skips the write.
       */
      recordHistory(next);

      /*
       * Fill the active tab in place.
       *
       * There is always an active tab now — the app starts with a blank one and "+"
       * makes another — so this is a single update, not a branch. A blank tab and a
       * tab holding a comparison are handled identically, which is what makes
       * "open a tab, then paste into it" and "paste into the tab you are in" the
       * same operation.
       *
       * The view state is deliberately preserved: an option toggle must not throw
       * away where the user was reading, and the row count is unchanged by "ignore
       * whitespace".
       */
      const current = activeId;
      tabs = tabs.map((tab) => (tab.id === current ? { ...tab, session: next } : tab));
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  /**
   * Open a new, empty tab and switch to it.
   *
   * This is the whole point of the tab strip: "重新输入" used to destroy the
   * comparison in front of you, so keeping it meant not looking at it.
   *
   * The tab appears *immediately*, empty. An earlier version only cleared the
   * active pointer and waited for the first commit to materialise a tab, on the
   * theory that an empty tab reads as a broken state. What it actually read as was
   * a "+" button that did nothing: pressing it left the strip unchanged and the old
   * tab still highlighted, and only typing produced a tab. The blank tab is a
   * legitimate state — it renders the same two panes a fresh launch does.
   */
  function openNewTab(): void {
    stashActiveView();
    const tab = createEmptyTab();
    tabs = [...tabs, tab];
    activeId = tab.id;
    restoreView(tab);
    resetGitPanelState();
    status = "";
  }

  /** Show an existing tab, saving the outgoing one's view state first. */
  function activateTab(id: string): void {
    if (id === activeId) return;
    stashActiveView();
    const tab = tabs.find((entry) => entry.id === id);
    if (!tab) return;
    activeId = id;
    restoreView(tab);
    /*
     * Tell the backend which documents are now current.
     *
     * Tab switching is a frontend operation — the session is already in memory — but
     * the backend caches its own copy for `rediff`. Skipping this makes the next
     * option toggle silently re-diff the tab we just left.
     */
    void ipc.syncSession(tab.session.left, tab.session.right, tab.session.options);
  }

  /** Write the live scroll/fold state back onto the tab we are leaving. */
  function stashActiveView(): void {
    if (activeId === null) return;
    const current = activeId;
    tabs = tabs.map((tab) =>
      tab.id === current ? { ...tab, view, expanded, scrollTop, scrollLeft } : tab,
    );
  }

  /** Adopt a tab's saved view state. */
  function restoreView(tab: Tab): void {
    view = tab.view;
    expanded = new Set(tab.expanded);
    scrollTop = tab.scrollTop;
    scrollLeft = tab.scrollLeft;
    navHunk = null;
    editing = false;
    // Claim the pending offset so the pane's echo is not mistaken for a user scroll.
    programmaticTarget = tab.scrollTop;
  }

  /** Close a tab and activate a neighbour. */
  function closeTab(id: string): void {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const remaining = tabs.filter((tab) => tab.id !== id);
    tabs = remaining;
    if (id !== activeId) return;

    /*
     * Closing the active tab must land somewhere valid.
     *
     * `indexAfterClose` returns -1 for an empty list. That used to mean "the paste
     * screen, with no tab", which is now the one state the strip cannot represent:
     * "+" always leaves a real tab behind, and closing every tab had to fall back
     * to a pointer-less paste screen — the strip vanishing on the last close, then
     * reappearing on the next "+", reads as a flicker and leaves the toolbar
     * pointing at no comparison.
     *
     * One blank tab is the honest equivalent: it shows the same paste screen and
     * keeps the strip stable.
     */
    const nextIndex = indexAfterClose(index, remaining.length);
    if (nextIndex === -1) {
      const blank = createEmptyTab();
      tabs = [blank];
      activeId = blank.id;
      restoreView(blank);
      resetGitPanelState();
      return;
    }
    const next = remaining[nextIndex];
    activeId = next.id;
    restoreView(next);
    void ipc.syncSession(next.session.left, next.session.right, next.session.options);
  }

  /** Reorder tabs after a drag. */
  function moveTabTo(from: number, to: number): void {
    tabs = moveTab(tabs, from, to);
  }

  // --- history ----------------------------------------------------------

  /**
   * Record the active comparison, if it is worth recording.
   *
   * Called from `commit`, which is the single funnel every new comparison passes
   * through — a paste, a file drop, a git pair, an edit apply. Recording from
   * there rather than from each entry point means a future entry point cannot
   * forget to record.
   *
   * Deliberately fire-and-forget: the disk write is a few hundred kilobytes at
   * most and awaiting it would put a filesystem round-trip in front of the diff
   * appearing on screen.
   */
  function recordHistory(next: Session): void {
    if (settings.historyEnabled === false) return;
    if (!shouldRecord(next)) return;

    const key = sessionKey(next);
    // The same two documents were already stored by an earlier commit. Option
    // toggles and tab switches land here, and re-saving would push duplicates
    // into a list the reader scrolls.
    if (key === lastSavedKey) return;
    lastSavedKey = key;

    const entry = entryFromSession(next, Date.now());
    void ipc
      .historySave(entry)
      .then(() => {
        // A successful save invalidates the rendered list, but only that: reloading
        // while the sheet is closed would be work nobody sees.
        if (historyOpen) void refreshHistory();
      })
      .catch(() => {
        /*
         * A failed save must not surface as an error line.
         *
         * History is a convenience, and the comparison the user asked for is on
         * screen and correct. Reporting "could not write history" would read as
         * a failure of the comparison itself — and the next launch simply starts
         * with a shorter list.
         */
        lastSavedKey = "";
      });
  }

  /** Reload the history list, ignoring any response that is not the newest. */
  async function refreshHistory(): Promise<void> {
    const seq = ++historySeq;
    historyLoading = true;
    try {
      const list = await ipc.historyList();
      if (seq === historySeq) historyEntries = list;
    } catch (err) {
      if (seq === historySeq) {
        historyEntries = [];
        status = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (seq === historySeq) historyLoading = false;
    }
  }

  /*
   * Retention is not triggered from here: it is an effect on the two settings,
   * which covers launch and every later change in one place.
   */
  function toggleHistory(): void {
    if (!historyOpen) {
      // One sheet at a time; see the note on `gitOpen`.
      settingsOpen = false;
      gitOpen = false;
    }
    historyOpen = !historyOpen;
    if (historyOpen) void refreshHistory();
  }

  /**
   * Reopen a stored comparison as a new tab.
   *
   * The texts go back through `set_both` rather than being diffed in the
   * frontend: the result is not stored (it would go stale as soon as an
   * algorithm default or an ignore option changed), so the backend recomputes it
   * exactly as it would for a fresh paste.
   *
   * The sheet closes first — the point of picking an entry is to look at it.
   */
  async function openHistoryEntry(id: string): Promise<void> {
    try {
      const entry = await ipc.historyLoad(id);
      historyOpen = false;
      const restored = sessionFromEntry(entry);
      // A recovered comparison is already on disk, so it is not re-recorded:
      // reopening the same entry ten times must not create ten rows.
      lastSavedKey = sessionKey(restored);
      await commit(ipc.setBoth(restored.left, restored.right));
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    }
  }

  async function deleteHistoryEntry(id: string): Promise<void> {
    try {
      await ipc.historyDelete(id);
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    }
    await refreshHistory();
  }

  async function clearHistory(): Promise<void> {
    try {
      await ipc.historyClear();
      // Every stored row is gone, so the next commit is a new comparison again.
      lastSavedKey = "";
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    }
    await refreshHistory();
  }

  /**
   * Read a path into a block, for the paste screen.
   *
   * Uses `load_file`, which decodes and validates the bytes on the Rust side, and
   * returns a block rather than committing a session: the paste screen keeps its
   * own state, and the comparison only starts once both sides have content.
   */
  async function readBlock(path: string): Promise<PasteBlock | null> {
    try {
      const loaded = await ipc.loadFile(path);
      return { text: loaded.side.text, path: loaded.side.path, label: loaded.side.label };
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * Resolve a dropped path into a block.
   *
   * A folder is expanded and its first text file is used: a comparison needs
   * exactly one document per side, and silently picking the first is better than
   * rejecting the drop, with the chosen name shown in the strip.
   */
  async function blockFromDrop(dropped: string): Promise<PasteBlock | null> {
    try {
      const info = await ipc.inspectPath(dropped);
      if (info.isDir) {
        if (info.files.length === 0) {
          status = $t("home.folderEmpty", { path: dropped });
          return null;
        }
        if (info.files.length > 1) {
          status = $t("home.folderFirst", { name: info.files[0].split("/").pop() ?? "", count: info.files.length });
        }
        return await readBlock(info.files[0]);
      }
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
      return null;
    }
    return await readBlock(dropped);
  }

  async function pickFile(): Promise<PasteBlock | null> {
    if (!ipc.isTauri) {
      status = $t("app.filePickerDesktopOnly");
      return null;
    }
    const path = await ipc.pickFile($t("home.importFile"));
    if (!path) return null;
    return await readBlock(path);
  }

  /**
   * Commit the pair of blocks the user entered.
   *
   * Both sides go in one command (`set_both`): committing one side first makes
   * the session non-empty, which unmounts the paste screen and would discard the
   * other block before it was ever sent.
   *
   * A block that came from a file keeps its path, so `⌘S` writes back to the real
   * file instead of refusing; a pasted block gets a label derived from its first
   * line so the pane header says what is being compared.
   */
  async function submitText(pair: PastePair): Promise<void> {
    const toSide = (block: PasteBlock): Side => ({
      path: block.path,
      label: block.path ? block.label : labelForText(block.text),
      text: block.text,
    });
    await commit(ipc.setBoth(toSide(pair.left), toSide(pair.right)));
  }

  /** Short, human label for a pasted block. */
  function labelForText(text: string): string {
    if (text.trim() === "") return "";
    const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
    const trimmed = firstLine.trim();
    if (trimmed === "") return "";
    return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
  }

  async function applyOptions(patch: OptionsPatch): Promise<void> {
    await commit(ipc.rediff(patch));
  }

  /**
   * `⌘S`: write the edited buffer back to disk.
   *
   * Both sides are saved when both have paths, because the diff is a single
   * document-level action: leaving one pane dirty would make the next diff
   * compare against a stale file.
   *
   * A side read from a git revision has no path, so it is filtered out here rather
   * than special-cased: the guard against overwriting a historical blob with
   * today's working copy is structural, not a flag this function has to remember
   * to check.
   */
  async function saveActive(): Promise<void> {
    if (!session) return;

    const targets = [session.left, session.right].filter(
      (side): side is typeof side & { path: string } => side.path !== null,
    );

    if (targets.length === 0) {
      // Distinguish "nothing to save" from "deliberately read-only": a user who
      // compared two commits should not be told the content came from the
      // clipboard, and should be told why ⌘S does nothing.
      const historical = [session.left, session.right].some((s) => s.git && !s.git.writable);
      status = historical
        ? $t("app.historyReadOnly")
        : $t("app.nothingToSave");
      return;
    }


    const saved: string[] = [];
    for (const target of targets) {
      try {
        await ipc.saveFile(target.path, target.text);
        saved.push(target.label);
      } catch (err) {
        status = `保存失败 ${target.label}：${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
    status = $t("app.saved", { names: saved.join(", ") });
  }

  /**
   * `重新输入` / `⌘N`: start a new comparison.
   *
   * This used to clear both sides in place, which destroyed whatever was on
   * screen — the reason a tab strip was wanted. Now it opens the paste screen in a
   * new tab and leaves every existing comparison untouched; the new tab only
   * materialises once the first pair of documents is committed.
   *
   * The backend is *not* cleared here: the outgoing tab still holds its session,
   * and calling `clear` would throw away the documents a later switch needs to
   * restore. `openNewTab` resets only the frontend's active pointer.
   */
  function clearAll(): void {
    openNewTab();
  }

  // --- git --------------------------------------------------------------

  /**
   * Run a git comparison and show it.
   *
   * The sheet closes first: the whole point of choosing two revisions is to look
   * at the result, and leaving a 320px panel over it would hide the right side of
   * every row. `commit` handles the failure paths, so a bad revision leaves the
   * sheet closed with a status line rather than nothing on screen.
   */
  async function compareGit(left: GitSpec, right: GitSpec): Promise<void> {
    gitOpen = false;
    await commit(ipc.gitCompare(left, right));
  }

  /**
   * The file the history sheet should open on, when there is one.
   *
   * Derived from the current session so "open history" from inside a comparison
   * continues with that file instead of asking again. Only a side that came from
   * git can seed it: a pasted block has no repository.
   */
  const gitSeed = $derived.by(() => {
    if (!session) return null;
    for (const side of [session.left, session.right]) {
      if (side.git) return { repo: side.git.repo, file: side.git.file };
    }
    return null;
  });

  function toggleGit(): void {
    // Three sheets share the right edge; only one may be open at a time, or
    // closing the top one reveals another underneath.
    if (!gitOpen) {
      settingsOpen = false;
      historyOpen = false;
    }
    gitOpen = !gitOpen;
  }

  /** True when a draft differs from what the session holds. */
  const draftDirty = $derived(
    session !== null && (draftLeft !== session.left.text || draftRight !== session.right.text),
  );

  function startEditing(): void {
    if (!session) return;
    draftLeft = session.left.text;
    draftRight = session.right.text;
    editing = true;
  }

  /** Leave edit mode without applying the drafts. */
  function cancelEditing(): void {
    editing = false;
    draftLeft = session?.left.text ?? "";
    draftRight = session?.right.text ?? "";
  }

  /**
   * Apply the drafts and re-run the comparison.
   *
   * `path` and `git` are carried over unchanged. Dropping `git` would make the
   * revision tags vanish from the toolbar after an edit and, worse, make a
   * historical side look writable again — the origin is what records that it is
   * not. The label keeps the revision for a git side, so two panes of the same
   * file stay distinguishable once their text diverges.
   */
  async function applyEditing(): Promise<void> {
    if (!session) return;

    const toSide = (text: string, previous: Side): Side => ({
      path: previous.path,
      label: previous.git || previous.path ? previous.label : labelForText(text),
      text,
      git: previous.git ?? null,
    });

    const next = ipc.setBoth(
      toSide(draftLeft, session.left),
      toSide(draftRight, session.right),
    );
    editing = false;
    await commit(next);
  }

  /** ⌘Enter inside edit mode commits rather than inserting a newline. */
  function onEditKeydown(event: KeyboardEvent): void {
    if (!editing) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void applyEditing();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
  }

  // --- drag & drop ------------------------------------------------------

  function handleDragOver(event: DragEvent, side: SideName): void {
    event.preventDefault();
    dragSide = side;
  }

  function handleDragLeave(): void {
    dragSide = null;
  }

  /**
   * Load a file into one side of an *existing* comparison.
   *
   * Distinct from the paste screen's `readBlock`: in the diff view there is
   * already a session, so the file is committed immediately rather than returned
   * as a block for later.
   */
  async function loadInto(side: SideName, path: string): Promise<void> {
    try {
      const loaded = await ipc.loadFile(path);
      await commit(ipc.setSide(side, loaded.side));
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Load a dropped filesystem path into a side of the current comparison.
   *
   * Let the backend decide whether this is a folder: the dropped `File` has no
   * dependable "is directory" flag, and guessing from the name is wrong for
   * extension-less files. A folder contributes its first text file, with the
   * choice reported in the status line.
   */
  async function handleDroppedPath(side: SideName, dropped: string): Promise<void> {
    try {
      const info = await ipc.inspectPath(dropped);
      if (info.isDir) {
        if (info.files.length === 0) {
          status = $t("home.folderEmpty", { path: dropped });
          return;
        }
        await loadInto(side, info.files[0]);
        if (info.files.length > 1) {
          const name = info.files[0].split("/").pop();
          status = $t("home.folderFirst", { name: name ?? "", count: info.files.length });
        }
        return;
      }
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
      return;
    }

    await loadInto(side, dropped);
  }

  /** Drag-and-drop entry point for a pane. */
  async function handleDrop(event: DragEvent, side: SideName): Promise<void> {
    event.preventDefault();
    dragSide = null;

    // Tauri exposes real paths on the drag payload; a plain browser does not.
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const first = files[0] as File & { path?: string };
    if (!first.path) {
      status = $t("app.dropPathUnavailable");
      return;
    }
    await handleDroppedPath(side, first.path);
  }

  // --- scrolling --------------------------------------------------------

  /**
   * Scroll handler for unified mode.
   *
   * Same single-authority model as the panes, but the offsets are in unified
   * line space. Kept separate because the two views have different row counts and
   * sharing one number would make ⌘D jump to a different place.
   */
  function handleUnifiedScroll(next: { top: number; left: number }): void {
    const moved = Math.abs(next.top - scrollTop) >= 0.5;
    if (moved) scrollTop = next.top;
    if (Math.abs(next.left - scrollLeft) >= 0.5) scrollLeft = next.left;
    if (moved) navHunk = null;
  }

  /** Single source of truth: both panes mirror these values. */
  function handleScroll(next: { top: number; left: number }): void {
    const moved = Math.abs(next.top - scrollTop) >= 0.5;
    if (moved) scrollTop = next.top;
    if (Math.abs(next.left - scrollLeft) >= 0.5) scrollLeft = next.left;
    // Only a scroll that did not land on our commanded offset counts as manual.
    if (moved) {
      const isOurs =
        programmaticTarget !== null && Math.abs(next.top - programmaticTarget) < 1;
      if (!isOurs) navHunk = null;
    }
  }

  // --- split divider ----------------------------------------------------

  /**
   * Drag the divider to rebalance the two panes.
   *
   * The pointer is captured on the divider itself and the ratio is derived from
   * the *container* rect, not from pointer deltas. Accumulating `movementX`
   * drifts whenever the pointer leaves the window or the window resizes mid-drag;
   * an absolute position cannot.
   *
   * Clamped rather than free: below ~15% a code pane stops being readable, and a
   * split that lets you hide a side entirely is a worse trap than a limit.
   */
  function startDividerDrag(event: PointerEvent): void {
    if (event.button !== 0 || !splitHost) return;
    event.preventDefault();

    const host = splitHost;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    // While dragging, keep the resize from feeding back into the pointer maths.
    dividerDragging = true;

    const move = (e: PointerEvent) => {
      const ratio = (e.clientX - rect.left) / rect.width;
      void patchSettings({ splitRatio: ratio });
    };

    const end = () => {
      dividerDragging = false;
      target.releasePointerCapture?.(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };

    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  /**
   * Keyboard resizing on the divider.
   *
   * A separator with `tabindex` is expected to be operable without a mouse; arrow
   * keys nudge by 2%, shift by 10%, Home/End jump to the limits.
   */
  function onDividerKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;

    switch (event.key) {
      case "ArrowLeft":
        next = settings.splitRatio - step;
        break;
      case "ArrowRight":
        next = settings.splitRatio + step;
        break;
      case "Home":
        next = 0.15;
        break;
      case "End":
        next = 0.85;
        break;
      case "Enter":
        // Double-click parity: Enter restores an even split from the keyboard.
        next = 0.5;
        break;
      default:
        return;
    }

    event.preventDefault();
    void patchSettings({ splitRatio: next });
  }

  /**
   * Move the viewport to a source row.
   *
   * Both panes follow `scrollTop` through their own reactive mirror, so setting
   * this one value is the entire synchronisation.
   */
  /**
   * Scroll so a source row is visible, in whichever view is active.
   *
   * The two views use different coordinate systems — split counts display items
   * (folds collapse many rows into one), unified counts physical lines (a modify
   * row becomes two) — so the offset must be computed against the active one.
   * Reusing the split index in unified mode lands in the wrong place.
   */
  async function scrollToRow(row: number): Promise<void> {
    let index: number;
    let count: number;

    if (view === "split") {
      // A jump target can be inside a collapsed run. Expand first, otherwise the
      // only display item that "matches" the row is the fold bar itself and the
      // viewport never actually moves.
      const hiddenBy = foldHidingRow(items, row);
      if (hiddenBy !== null) {
        const next = new Set(expanded);
        next.add(hiddenBy);
        expanded = next;
        await tick();
      }
      index = displayIndexForRow(items, row);
      count = items.length;
    } else {
      /*
       * Unified space, in the *folded* projection.
       *
       * Counting physical lines (as this did before folding existed) overestimates
       * the offset for every collapsed run above the target, so a ⌘] jump landed
       * short by exactly the number of hidden lines.
       *
       * A target inside a collapsed run has no line of its own, so the run is
       * expanded first — the same rule the split view follows.
       */
      const hiddenBy = unifiedFoldHidingRow(unifiedItems, row);
      if (hiddenBy !== null) {
        const next = new Set(expanded);
        next.add(hiddenBy);
        expanded = next;
        await tick();
      }
      index = unifiedIndexIn(unifiedItems, row);
      count = unifiedCount;
    }

    const target = scrollTopToRow(
      index,
      viewportHeight,
      count,
      rowHeight,
      metrics.jumpContext,
    );
    programmaticTarget = target;
    scrollTop = target;
    await tick();
  }

  /**
   * Scroll so a display-item index is centred, for minimap jumps.
   *
   * Centred rather than top-aligned on purpose: the strip shows a band, so the
   * user picked a *region*, and landing that region at the top edge makes the
   * click feel off by half a viewport. Centring also makes the indicator land
   * where the pointer was, which is the mental model of dragging a scrollbar.
   *
   * The index is clamped against the current item count rather than trusted: a
   * click can race a re-diff that shrank the document.
   */
  async function scrollToDisplayIndex(index: number): Promise<void> {
    const count = items.length;
    if (count === 0) return;

    const clamped = Math.max(0, Math.min(count - 1, Math.round(index)));
    // `scrollTopToCentre` puts the item at mid-viewport; the clamp below keeps the
    // result inside the scroll range, which centring on its own does not.
    const centred = scrollTopToCentre(clamped, viewportHeight, rowHeight);
    const maxScroll = Math.max(0, count * rowHeight - viewportHeight);
    const target = Math.max(0, Math.min(maxScroll, centred));

    programmaticTarget = target;
    scrollTop = target;
    await tick();
  }


  async function jumpToHunk(direction: 1 | -1): Promise<void> {
    const changes = hunks
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => !h.equal);

    if (changes.length === 0) return;

    // Prefer the remembered target; fall back to the viewport top when the user
    // has scrolled manually since the last jump.
    let nextIndex: number;
    if (navHunk === null) {
      const anchorRow = currentRow;
      nextIndex =
        direction === 1
          ? changes.findIndex(({ h }) => h.row_start > anchorRow)
          : changes.reduce(
              (best, { h }, idx) => (h.row_start < anchorRow ? idx : best),
              -1,
            );
    } else {
      const at = changes.findIndex(({ i }) => i === navHunk);
      nextIndex = at === -1 ? 0 : at + direction;
    }

    if (nextIndex < 0 || nextIndex >= changes.length) return;

    const target = changes[nextIndex];
    navHunk = target.i;
    await scrollToRow(target.h.row_start);
  }

  /** Every equal hunk that is long enough to fold. */
  const foldableHunks = $derived(
    hunks
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.equal && h.row_len > settings.foldThreshold)
      .map(({ i }) => i),
  );

  /** True when at least one fold is still collapsed. */
  const hasFolds = $derived(foldableHunks.some((i) => !expanded.has(i)));

  /**
   * Expand every fold, or collapse them all when nothing is left to open.
   *
   * Toggling both ways from one control is what makes the keyboard shortcut
   * useful: a reviewer alternates between "read the whole file" and "show me just
   * the changes" constantly.
   */
  function toggleAllFolds(): void {
    if (hasFolds) {
      expanded = new Set(foldableHunks);
      return;
    }
    // Everything is expanded: this is a genuine collapse-all, including runs the
    // reader opened one at a time.
    // Collapsing everything above the viewport would shift content upward by the
    // total hidden row count, so return to an anchored position.
    const hiddenAbove = items
      .slice(0, splitWin.firstVisible)
      .reduce((sum, it) => sum + (it.fold ? 0 : 1), 0);
    expanded = new Set();
    scrollTop = Math.min(
      scrollTop,
      Math.max(0, (hiddenAbove - 1) * rowHeight),
    );
  }

  /**
   * Collapse an already-expanded unchanged run.
   *
   * Without this, expanding a fold was a one-way door: the bar disappeared, and
   * the only way back was "collapse all", which also collapsed unrelated runs the
   * reader had deliberately opened.
   */
  function collapseFold(hunkIndex: number): void {
    if (!expanded.has(hunkIndex)) return;

    // Count how many display rows this hunk contributes while expanded, so the
    // viewport can stay anchored on the same content once they are replaced by a
    // single bar.
    const hunk = hunks[hunkIndex];
    const rowsRemoved = hunk ? Math.max(0, hunk.row_len - 1) : 0;
    const firstRowIndex = hunk
      ? items.findIndex((i) => !i.fold && i.row >= hunk.row_start)
      : -1;

    const next = new Set(expanded);
    next.delete(hunkIndex);
    expanded = next;

    // Only compensate when the collapsed region starts above the viewport.
    if (firstRowIndex >= 0 && firstRowIndex < splitWin.firstVisible) {
      scrollTop = Math.max(0, scrollTop - rowsRemoved * rowHeight);
    }
  }

  function expandFold(hunkIndex: number): void {
    // Locate the bar before rebuilding: once `items` changes, the bar is gone.
    const foldIndex = items.findIndex((i) => i.fold?.hunkIndex === hunkIndex);
    const hiddenCount = foldIndex >= 0 ? (items[foldIndex].fold?.count ?? 0) : 0;

    const next = new Set(expanded);
    next.add(hunkIndex);
    expanded = next;

    // Keep the viewport anchored on the same content.
    scrollTop = scrollTopAfterExpand(
      scrollTop,
      foldIndex,
      hiddenCount,
      splitWin.firstVisible,
      rowHeight,
    );
  }

  // --- keyboard ---------------------------------------------------------

  function handleKeydown(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;

    switch (event.key) {
      case "]":
        event.preventDefault();
        void jumpToHunk(1);
        break;
      case "[":
        event.preventDefault();
        void jumpToHunk(-1);
        break;

      /*
       * Tabs.
       *
       * ⌘T and ⌘N do the same thing: ⌘T is what a browser user reaches for
       * reflexively, ⌘N is what "new comparison" means in an editor, and this app
       * documented ⌘N before it had tabs. Both are kept rather than picking one.
       *
       * ⌘W closes the current tab. ⌘⇧W is *not* a tab shortcut — it is "ignore
       * whitespace", which this app has used since before tabs existed — so the
       * shift case must be handled here rather than falling through.
       */
      case "t":
      case "T":
        if (!event.shiftKey && !event.altKey) {
          event.preventDefault();
          clearAll();
        }
        break;
      case "n":
      case "N":
        event.preventDefault();
        clearAll();
        break;
      case "w":
      case "W":
        if (event.shiftKey) {
          event.preventDefault();
          void toggleWhitespace();
        } else if (!event.altKey) {
          event.preventDefault();
          if (activeId !== null) closeTab(activeId);
        }
        break;

      case "d":
        event.preventDefault();
        view = view === "split" ? "unified" : "split";
        break;
      case "e":
      case "E":
        if (event.altKey) {
          event.preventDefault();
          toggleAllFolds();
        }
        break;
      case ",":
        // The macOS Settings shortcut. Expected by muscle memory.
        event.preventDefault();
        if (!settingsOpen) {
          gitOpen = false;
          historyOpen = false;
        }
        settingsOpen = !settingsOpen;
        break;
      case "s":
      case "S":
        if (!event.shiftKey) {
          event.preventDefault();
          void saveActive();
        }
        break;
      case "g":
      case "G":
        // Git history. `⌘G` is free and reads as "git"; `⌘⇧G` is left alone so it
        // can later become "find next" without a conflict.
        if (!event.shiftKey && !event.altKey) {
          event.preventDefault();
          toggleGit();
        }
        break;
      case "y":
      case "Y":
        // "Y" for 历史 — ⌘H is taken by macOS "Hide application".
        if (!event.shiftKey && !event.altKey) {
          event.preventDefault();
          toggleHistory();
        }
        break;
    }
  }

  /**
   * `⌘⇧W`: ignore leading/trailing whitespace and line endings.
   *
   * Deliberately the *trim* option, not `ignoreAllWhitespace`: the spec names
   * "首尾空白与换行符", so interior spacing and indentation still count. The
   * stronger mode stays available from the toolbar for its own use.
   */
  async function toggleWhitespace(): Promise<void> {
    const current = session?.options.ignore_whitespace ?? false;
    await applyOptions({ ignoreWhitespace: !current });
  }
</script>

<div class="app">
  <!--
    The tab strip sits above the toolbar, not below it.

    Tabs answer "what am I looking at"; the toolbar answers "what can I do with it".
    Putting identity above actions matches every browser and editor, and it means
    the tool row does not shift when a tab is added or closed.

    Rendered only when at least one comparison exists: the paste screen is not a
    tab, and an empty strip over it would imply a comparison is open.
  -->
  {#if tabs.length > 0}
    <TabStrip
      {tabs}
      {activeId}
      pastedLabel={$t("tabs.pasted")}
      untitledLabel={$t("tabs.untitled")}
      onActivate={activateTab}
      onClose={closeTab}
      onNew={openNewTab}
      onMove={moveTabTo}
    />
  {/if}
  <Toolbar
    {session}
    {view}
    {stats}
    {busy}
    {themeMode}
    onNew={() => void clearAll()}
    onToggleView={() => (view = view === "split" ? "unified" : "split")}
    onOptions={applyOptions}
    onTheme={(mode) => void patchSettings({ theme: mode })}
    onJumpPrev={() => jumpToHunk(-1)}
    onJumpNext={() => jumpToHunk(1)}
    {hasFolds}
    onToggleFolds={toggleAllFolds}
    {position}
    {settingsOpen}
    onToggleSettings={() => {
      // Only one side sheet at a time; see the note on `gitOpen`.
      if (!settingsOpen) {
        gitOpen = false;
        historyOpen = false;
      }
      settingsOpen = !settingsOpen;
    }}
    {editing}
    onToggleEdit={() => (editing ? cancelEditing() : startEditing())}
    wrapLines={settings.wrapLines}
    onToggleWrap={() => void patchSettings({ wrapLines: !settings.wrapLines })}
    {gitOpen}
    onToggleGit={toggleGit}
    {historyOpen}
    onToggleHistory={toggleHistory}
  />

  <!--
    The banner sits between the toolbar and the panes, in normal flow.

    Not an overlay: covering the top of the document would hide the first lines
    of the comparison the banner is describing, and not a status-bar message
    either, because the bottom of the window is where the eye goes last.
  -->
  {#if showSameBanner}
    <SameBanner
      lines={rows.length}
      ignoring={ignoringOptions}
      onDismiss={() => (dismissedFor = comparisonKey)}
    />
  {/if}

  <!--
    Edit mode takes over the whole body, including the paste screen's slot.

    It is checked before `hasContent` because the two are mutually exclusive by
    construction (editing can only start from a session), and putting it first
    keeps the read-only branch free of a second condition.
  -->
  {#if editing && session}
    <div class="edit-bar" onkeydown={onEditKeydown} role="presentation">
      <span class="edit-hint">
        {$t("edit.bar")}
      </span>
      <span class="grow"></span>
      <button class="edit-btn" onclick={cancelEditing}>{$t("edit.cancel")}</button>
      <button class="edit-btn primary" disabled={!draftDirty} onclick={() => void applyEditing()}>
        重新比对
      </button>
    </div>

    <div class="body">
      <div class="split">
        <div class="side" style:flex-basis="{leftPct}%">
          <EditPane
            side="left"
            text={draftLeft}
            path={session.left.path}
            dirty={draftLeft !== session.left.text}
            onInput={(text) => (draftLeft = text)}
            onDone={() => void applyEditing()}
            onCancel={cancelEditing}
          />
        </div>
        <div class="rule-static" role="presentation"></div>
        <div class="side" style:flex-basis="{rightPct}%">
          <EditPane
            side="right"
            text={draftRight}
            path={session.right.path}
            dirty={draftRight !== session.right.text}
            onInput={(text) => (draftRight = text)}
            onDone={() => void applyEditing()}
            onCancel={cancelEditing}
          />
        </div>
      </div>
    </div>
  {:else}
  <div class="body">
    {#if !hasContent}
      <EmptyState
        onDrop={(_side, path) => blockFromDrop(path)}
        onPickFile={() => pickFile()}
        onCompare={(pair) => void submitText(pair)}
      />
    {:else if view === "split"}
      <div class="split" bind:this={splitHost}>
        <div
          class="side"
          class:dragging={dragSide === "left"}
          style:flex-basis="{leftPct}%"
          ondragover={(e) => handleDragOver(e, "left")}
          ondragleave={handleDragLeave}
          ondrop={(e) => handleDrop(e, "left")}
          role="presentation"
        >
          <!--
            No title strip.

            It used to show a label derived from the content, which for a pasted
            block is just its first line — text the code pane below already shows
            verbatim. On an imported file it did carry the filename, but that
            belongs next to the file, not as a header over the code: see the
            `files` readout in the toolbar, which names both sides in one place.
          -->
          <DiffPane
            side="left"
            lines={leftLines}
            {rows}
            {items}
            win={splitWin}
            {hovered}
            {scrollTop}
            {scrollLeft}
            activeHunk={activeHunkRows}
            tokens={leftTokens}
            onScroll={handleScroll}
            onExpandFold={expandFold}
            onCollapseFold={collapseFold}
            onHover={(i) => (hovered = i)}
          />
        </div>

        <!--
          Resizable separator.

          The hit area is 9px wide and centred on a 1px visual line: a 1px target
          is unhittable in practice, but a visibly thick divider contradicts the
          hairline look the rest of the window follows. So the line stays 1px and
          an invisible, wider grip sits over it.

          `separator` with `aria-valuenow` is the ARIA window-splitter widget, and
          it is meant to be focusable — the two lints below fire because the role
          is classed as non-interactive, not because the markup is wrong.
        -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="divider"
          class:dragging={dividerDragging}
          role="separator"
          aria-orientation="vertical"
          aria-label={$t("split.resizeLabel")}
          aria-valuenow={Math.round(leftPct)}
          aria-valuemin={15}
          aria-valuemax={85}
          tabindex="0"
          title={$t("split.resizeTitle")}
          onpointerdown={startDividerDrag}
          onkeydown={onDividerKey}
          ondblclick={() => void patchSettings({ splitRatio: 0.5 })}
        >
          <span class="grip" aria-hidden="true"></span>
        </div>

        <div
          class="side"
          class:dragging={dragSide === "right"}
          style:flex-basis="{rightPct}%"
          ondragover={(e) => handleDragOver(e, "right")}
          ondragleave={handleDragLeave}
          ondrop={(e) => handleDrop(e, "right")}
          role="presentation"
        >
          <!-- No title strip; see the note on the left pane. -->
          <DiffPane
            side="right"
            lines={rightLines}
            {rows}
            {items}
            win={splitWin}
            {hovered}
            {scrollTop}
            {scrollLeft}
            activeHunk={activeHunkRows}
            tokens={rightTokens}
            onScroll={handleScroll}
            onExpandFold={expandFold}
            onCollapseFold={collapseFold}
            onHover={(i) => (hovered = i)}
          />
        </div>

        {#if settings.minimap}
          <!--
            Display-item space, not source rows: the strip must share a
            coordinate system with the scrollbar or the two disagree once a run
            is folded. `visibleItems` is the item range actually on screen.
          -->
          <Minimap
            rowKinds={rows.map((r) => r.kind)}
            {items}
            viewStart={visibleItems.start}
            {rowHeight}
            clientHeight={viewportHeight}
            {scrollTop}
            onJump={(index) => void scrollToDisplayIndex(index)}
          />
        {/if}
      </div>
    {:else}
      <div class="unified-host" bind:this={splitHost}>
        <UnifiedView
          {rows}
          items={unifiedItems}
          {leftLines}
          {rightLines}
          start={unifiedWin.start}
          end={unifiedWin.end}
          totalHeight={unifiedWin.scrollHeight}
          offsetY={unifiedWin.offsetY}
          activeHunk={activeHunkRows}
          scrollOffset={scrollTop}
          leftTokens={leftTokens}
          rightTokens={rightTokens}
          onScroll={handleUnifiedScroll}
          onExpandFold={expandFold}
        />
      </div>
    {/if}

    {#if settingsOpen}
      <SettingsPanel
        {settings}
        onPatch={(patch) => void patchSettings(patch)}
        onReset={resetSettings}
        onClose={() => (settingsOpen = false)}
      />
    {/if}

    {#if gitOpen}
      <GitPanel seedFile={gitSeed} onCompare={compareGit} onClose={() => (gitOpen = false)} />
    {/if}

    {#if historyOpen}
      <HistoryPanel
        entries={historyEntries}
        loading={historyLoading}
        onOpen={(id) => void openHistoryEntry(id)}
        onDelete={(id) => void deleteHistoryEntry(id)}
        onClear={() => void clearHistory()}
        onClose={() => (historyOpen = false)}
      />
    {/if}
  </div>
  {/if}

  {#if status}
    <div class="status" role="status">{status}</div>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--c-bg);
    color: var(--c-text);
  }
  /* --- edit mode -------------------------------------------------------- */
  /*
   * A commit bar above the editors, not floating buttons over them.
   *
   * Editing is a mode with an exit, so the exit has to be persistently visible
   * rather than something you find by scrolling. Putting it above the text also
   * keeps it away from the caret's usual position at the end of the document.
   */
  .edit-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px;
    border-bottom: 1px solid var(--c-border);
    background: var(--c-bg-elevated);
    font-size: 11px;
  }

  .edit-hint {
    color: var(--c-text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .grow {
    flex: 1 1 auto;
  }

  .edit-btn {
    height: 22px;
    padding: 0 10px;
    border: 1px solid var(--c-border-strong);
    border-radius: 5px;
    background: var(--c-bg);
    color: var(--c-text);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .edit-btn:hover:not(:disabled) {
    background: var(--c-bg-sunken);
  }

  .edit-btn.primary {
    border-color: transparent;
    background: var(--c-accent);
    color: #fff;
    font-weight: 590;
  }

  .edit-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .edit-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Static rule between the two editors: no drag, matching the paste screen. */
  .rule-static {
    flex: 0 0 1px;
    background: var(--c-border);
  }


  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }

  .split {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
    min-width: 0;
    /*
     * Containing block for the minimap overlay.
     *
     * The strip is `position: absolute` so it reserves no width; without a
     * positioned ancestor it would anchor to the window instead of to the panes,
     * and would float over the settings sheet.
     */
    position: relative;
  }

  /*
   * Panes are sized by an explicit flex-basis from settings, and are allowed to
   * shrink (`flex-shrink: 1`) but never to grow past it: growing would let the
   * window's slack silently override the ratio the user dragged.
   */
  .side {

    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    /* Sub-pixel bases would otherwise round inconsistently between the panes. */
    min-width: 120px;
    min-height: 0;
  }

  /* Drop target feedback: a tinted overlay, not an outline, so it reads at a
     glance without shifting layout. */
  .side.dragging {
    box-shadow: inset 0 0 0 2px var(--c-accent);
  }


  /*
   * Resizable separator.
   *
   * The visible line is 1px (the same hairline as every other border), drawn as
   * a centred pseudo-element. The element itself is 9px wide so the pointer has
   * something to hit: a 1px drag target is technically operable and practically
   * not. Colored `transparent` so the hit area adds no visual weight.
   */
  .divider {
    flex: 0 0 9px;
    position: relative;
    /* -4px on each side keeps the pair of panes at their exact ratios. */
    margin: 0 -4px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: col-resize;
    /* Never let a drag select the diff text underneath. */
    user-select: none;
    touch-action: none;
    z-index: 3;
  }

  /* The hairline, centred inside the wider grip. */
  .divider::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 1px;
    background: var(--c-border);
    transition: background-color 120ms ease;
  }

  /* Hover and drag both brighten the line: the only affordance it has room for. */
  .divider:hover::before,
  .divider.dragging::before {
    background: var(--c-accent);
  }

  .divider:focus-visible {
    outline: none;
  }

  .divider:focus-visible::before {
    background: var(--c-accent);
    box-shadow: 0 0 0 1px var(--c-accent);
  }

  /*
   * Grab dots.
   *
   * Three 1px dots in the middle of the line: enough to say "this is a control"
   * when hovering, invisible otherwise. Shown only on hover/drag/focus so the
   * resting window stays chrome-free.
   */
  .grip {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 3px;
    height: 22px;
    transform: translate(-50%, -50%);
    border-radius: 2px;
    background: repeating-linear-gradient(
      to bottom,
      var(--c-text-faint) 0 1px,
      transparent 1px 3px
    );
    opacity: 0;
    transition: opacity 120ms ease;
    pointer-events: none;
  }

  .divider:hover .grip,
  .divider.dragging .grip,
  .divider:focus-visible .grip {
    opacity: 1;
  }

  .unified-host {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .status {
    flex: 0 0 auto;
    padding: 4px 10px;
    border-top: 1px solid var(--c-border);
    background: var(--c-bg-elevated);
    color: var(--c-text-muted);
    font-size: 11px;
  }
</style>
