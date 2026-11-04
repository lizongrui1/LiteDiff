<script lang="ts">
  /**
   * Unified (inline) view.
   *
   * Reuses the side-by-side data model: a `modify` row becomes two stacked rows
   * (old above new), which is exactly how a unified diff reads. The row list is
   * rebuilt from `rows` rather than re-diffed, so the two view modes can never
   * disagree about what changed.
   *
   * Virtualised with the same fixed-row maths as the split view. Without this a
   * 3000-line file would mount 3000+ cells and scrolling would stall — the exact
   * problem the split view was built to avoid, reintroduced by the back door.
   */

  import CodeLine from "./CodeLine.svelte";
  import type { AlignedRow, InlineSegment, RowKind } from "../lib/types";
  import type { UnifiedItem } from "../lib/viewport";
  import type { TokenSource } from "../lib/syntax";
  import { t } from "../lib/i18nStore";

  /** One physical line in the unified layout. */
  interface UnifiedLine {
    /** Row identity, unique across the whole list (used as the each key). */
    key: string;
    kind: RowKind;
    lineNumber: number | null;
    side: "left" | "right";
    text: string;
    segments: InlineSegment[];
    /** Source row this line came from, so navigation can map back. */
    sourceRow: number;
  }

  interface Props {
    rows: AlignedRow[];
    /**
     * The flattened, already-folded line list.
     *
     * Computed by `App` rather than here, because the fold state is shared with the
     * split view and because the same list decides the scroll height: two sources of
     * truth would put the scrollbar out of step with what is drawn.
     */
    items: UnifiedItem[];
    leftLines: string[];
    rightLines: string[];
    /** Render window, computed by the parent in unified-line coordinates. */
    start: number;
    end: number;
    totalHeight: number;
    offsetY: number;
    /** Source row range of the change being viewed, for the marker. */
    activeHunk: { start: number; end: number } | null;
    onScroll: (offset: { top: number; left: number }) => void;
    /** Authoritative vertical offset to mirror. */
    scrollOffset: number;
    /** Expand a collapsed run, by hunk index. */
    onExpandFold: (hunkIndex: number) => void;
    /** Lazy syntax tokens, one source per side. */
    leftTokens: TokenSource | null;
    rightTokens: TokenSource | null;
  }

  let {
    rows,
    items,
    leftLines,
    rightLines,
    start,
    end,
    totalHeight,
    offsetY,
    activeHunk,
    onScroll,
    onExpandFold,
    leftTokens,
    rightTokens,
    scrollOffset,
  }: Props = $props();

  /**
   * Project one `UnifiedItem` to the physical line it draws.
   *
   * The flattening rule lives in `buildUnifiedDisplay`; this only looks up the text
   * and numbers for the item's side.
   */
  function lineFor(item: UnifiedItem): UnifiedLine | null {
    if (item.fold !== null) return null;
    const row = rows[item.sourceRow];
    if (!row) return null;

    const isModify = row.kind === "modify";
    const side = item.side;
    const lineNumber = side === "left" ? row.left : row.right;
    const text =
      lineNumber === null ? "" : (side === "left" ? leftLines : rightLines)[lineNumber] ?? "";

    // A modify row draws as a deletion above an insertion; everything else keeps its
    // own kind. This is the canonical unified rendering.
    const kind: RowKind = isModify ? (side === "left" ? "delete" : "insert") : row.kind;

    return {
      key: `${side}${item.sourceRow}`,
      kind,
      lineNumber,
      side,
      text,
      segments: side === "left" ? row.left_inline : row.right_inline,
      sourceRow: item.sourceRow,
    };
  }

  const visible = $derived(items.slice(start, end));

  let scroller = $state<HTMLDivElement | null>(null);

  function handleScroll(): void {
    if (scroller) {
      onScroll({ top: scroller.scrollTop, left: scroller.scrollLeft });
    }
  }

  /** Mirror the parent's authoritative offset into this scroller. */
  function mirror(scrollTop: number): void {
    if (!scroller) return;
    if (Math.abs(scroller.scrollTop - scrollTop) > 0.5) {
      scroller.scrollTop = scrollTop;
    }
  }

  function isActive(sourceRow: number): boolean {
    return activeHunk !== null && sourceRow >= activeHunk.start && sourceRow < activeHunk.end;
  }

  // Follow the parent's offset, exactly like the split panes do.
  $effect(() => {
    mirror(scrollOffset);
  });
</script>

<div class="unified" bind:this={scroller} onscroll={handleScroll} role="presentation">
  <div class="spacer" style:height="{totalHeight}px">
    <div class="window" style:transform="translateY({offsetY}px)">
      {#each visible as item (item.fold ? `f${item.fold.hunkIndex}` : `${item.side}${item.sourceRow}`)}
        {#if item.fold}
          <!--
            The collapsed run, drawn exactly like the split view's bar so the two
            views are recognisably the same affordance.
          -->
          <button
            type="button"
            class="fold"
            data-row={item.sourceRow}
            onclick={() => onExpandFold(item.fold!.hunkIndex)}
            title={$t("fold.expand", {
              from: item.fold.startRow + 1,
              to: item.fold.startRow + item.fold.count,
            })}
          >
            <span class="fold-range">
              {item.fold.startRow + 1}–{item.fold.startRow + item.fold.count}
            </span>
            <span class="fold-label">
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path
                  d="M4 6l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {$t("fold.unchangedLines", { n: item.fold.count })}
            </span>
          </button>
        {:else}
          {@const u = lineFor(item)}
          {#if u}
            <CodeLine
              line={u.lineNumber}
              kind={u.kind}
              segments={u.segments}
              text={u.text}
              side={u.side}
              active={isActive(u.sourceRow)}
              tokens={u.side === "left" ? (leftTokens?.get(u.lineNumber) ?? []) : (rightTokens?.get(u.lineNumber) ?? [])}
            />
          {/if}
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  /*
   * Fold bar.
   *
   * Deliberately the same measurements as the split view's bar (full width, the
   * gutter showing the range, a chevron and the count): a reader switching between
   * the two views should recognise one affordance, not learn two. The unified view
   * has a single gutter, so the range sits at the left edge where the line number
   * would be.
   */
  .fold {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: var(--row-height);
    padding: 0;
    border: none;
    background: var(--c-bg-sunken);
    font-family: var(--font-mono);
    font-size: var(--font-size-code);
    color: var(--c-text-muted);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }

  .fold:hover {
    color: var(--c-text);
  }

  .fold-range {
    flex: 0 0 auto;
    min-width: 96px;
    padding-right: 10px;
    text-align: right;
    color: var(--c-text-faint);
    font-variant-numeric: tabular-nums;
  }

  .fold-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .unified {
    height: 100%;
    min-height: 0;
    overflow: auto;
    background: var(--c-bg);
    /* No reserved gutter; see the note in `DiffPane`. */
    scrollbar-gutter: auto;
    /*
     * Not `contain: strict`: its size containment makes the scroll port ignore
     * the spacer's height, so the view cannot scroll and the window renders only
     * the first screenful. Same defect as the split panes; `layout paint` keeps
     * the isolation without the size implication.
     */
    contain: layout paint;
  }


  .spacer {
    position: relative;
    width: 100%;
  }

  /* Same reason as the split view: rows are absolutely positioned, so the
     wrapper must size to its widest row for horizontal scrolling to exist. */
  .window {
    position: absolute;
    top: 0;
    left: 0;
    width: max-content;
    min-width: 100%;
    will-change: transform;
  }
</style>
