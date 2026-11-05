<script lang="ts">
  /**
   * One scrolling pane of the side-by-side view.
   *
   * Virtualisation: only the window around `scrollTop` is in the DOM, positioned
   * with a single translated wrapper. Because every row is exactly
   * `--row-height`, the arithmetic is exact — no measurement, no reflow loop.
   *
   * Synchronisation: this component never scrolls itself in response to a user
   * scroll. It reports `onScroll` upward, and the parent writes the same
   * `scrollTop` back into both panes. One authority, so the two panes cannot
   * fight each other into a feedback loop.
   */
  import CodeLine from "./CodeLine.svelte";
  import type { AlignedRow, InlineSegment, SideName } from "../lib/types";
  import type { DisplayItem, Window } from "../lib/viewport";
  import type { Token, TokenSource } from "../lib/syntax";
  import { t } from "../lib/i18nStore";
  import { searchSlicesFor, type SearchViewState } from "../lib/search";

  interface Props {
    side: SideName;
    /** Raw text of this side, for looking up line content. */
    lines: string[];
    rows: AlignedRow[];
    items: DisplayItem[];
    win: Window;
    /** Display index under the pointer, for the hover affordance. */
    hovered: number | null;
    /**
     * Source row range of the change the user is currently on.
     *
     * Drawn as a left-edge marker so "where am I" is answerable without reading
     * the gutter, which matters after a ⌘] jump when the target is one line among
     * thousands.
     */
    activeHunk: { start: number; end: number } | null;
    /**
     * Lazy syntax tokens for this side, or null when the language is unknown or the
     * feature is off.
     *
     * Indexed by *source* line, not by display item: wrapping and folding both change
     * the item index while the token stream belongs to the text. A source rather than
     * an array so a window of 40 lines tokenises 40 lines instead of the document.
     */
    tokens: TokenSource | null;
    /**
     * Authoritative scroll offsets. The pane mirrors these rather than owning
     * them, so the two panes always show the same row *and* the same columns.
     */
    scrollTop: number;
    scrollLeft: number;
    /** Wrapping is a strict no-horizontal-scroll mode. */
    wrapped: boolean;
    /** Query hits for this comparison, or null while search is closed. */
    search: SearchViewState | null;
    onScroll: (offset: { top: number; left: number }) => void;
    onExpandFold: (hunkIndex: number) => void;
    onCollapseFold: (hunkIndex: number) => void;
    onHover: (displayIndex: number | null) => void;
  }

  let {
    side,
    lines,
    rows,
    items,
    win,
    hovered,
    activeHunk,
    tokens,
    scrollTop,
    scrollLeft,
    wrapped,
    search,
    onScroll,
    onExpandFold,
    onCollapseFold,
    onHover,
  }: Props = $props();

  let scroller = $state<HTMLDivElement | null>(null);


  /**
   * Mirror the parent's scroll offset into this pane.
   *
   * A reactive statement rather than an exported method: the parent already owns
   * the value, so the pane only has to follow it. The 0.5px guard prevents a
   * feedback loop with the `scroll` event we emit ourselves.
   */
  $effect(() => {
    const targetTop = scrollTop;
    const targetLeft = wrapped ? 0 : scrollLeft;
    const isWrapped = wrapped;
    if (!scroller) return;
    if (Math.abs(scroller.scrollTop - targetTop) > 0.5) {
      scroller.scrollTop = targetTop;
    }
    // Horizontal sync matters for wide lines: without it one pane can show
    // columns the other does not, and the two sides stop lining up visually.
    if (isWrapped && scroller.scrollLeft !== 0) {
      scroller.scrollLeft = 0;
    } else if (!isWrapped && Math.abs(scroller.scrollLeft - targetLeft) > 0.5) {
      scroller.scrollLeft = targetLeft;
    }
  });

  function handleScroll(): void {
    if (scroller) {
      if (wrapped && scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
      onScroll({ top: scroller.scrollTop, left: wrapped ? 0 : scroller.scrollLeft });
    }
  }

  const visible = $derived(items.slice(win.start, win.end));

  /** True when a source row belongs to the change being viewed. */
  /**
   * Tokens for one rendered item.
   *
   * A wrapped item shows a slice of its logical line, so its tokens have to be
   * sliced with the same character range. Slicing the *token* list rather than
   * re-tokenising the fragment matters: a string split across two physical lines
   * would otherwise be coloured as code on the second one.
   */
  function tokensFor(
    lineIndex: number | null,
    range: { start: number; end: number },
    wrapped: boolean,
  ): Token[] {
    if (tokens === null || lineIndex === null) return [];
    const lineTokens = tokens.get(lineIndex);
    if (!lineTokens || !wrapped) return lineTokens ?? [];

    const { start, end } = range;
    const out: Token[] = [];
    let offset = 0;
    for (const token of lineTokens) {
      const tokenStart = offset;
      const tokenEnd = offset + token.text.length;
      offset = tokenEnd;
      if (tokenEnd <= start) continue;
      if (tokenStart >= end) break;
      const from = Math.max(0, start - tokenStart);
      const to = Math.min(token.text.length, end - tokenStart);
      if (to > from) out.push({ kind: token.kind, text: token.text.slice(from, to) });
    }
    return out;
  }

  /**
   * Slice inline highlights with the same character range as the displayed text.
   *
   * The backend builds segments for the full logical line. Reusing them untouched
   * on every wrapped slice made each physical line repeat the whole row, and the
   * character pills stopped lining up with the visible fragment.
   */
  function segmentsFor(
    segments: InlineSegment[],
    range: { start: number; end: number },
    wrapped: boolean,
  ): InlineSegment[] {
    if (!wrapped || segments.length === 0) return segments;

    const out: InlineSegment[] = [];
    let offset = 0;
    for (const segment of segments) {
      const segmentStart = offset;
      const segmentEnd = offset + segment.text.length;
      offset = segmentEnd;
      if (segmentEnd <= range.start) continue;
      if (segmentStart >= range.end) break;

      const from = Math.max(0, range.start - segmentStart);
      const to = Math.min(segment.text.length, range.end - segmentStart);
      if (to > from) {
        out.push({
          ...segment,
          text: segment.text.slice(from, to),
          char_start: Math.max(segment.char_start, range.start),
          char_end: Math.min(segment.char_end, range.end),
        });
      }
    }
    return out;
  }

  function isActive(row: number): boolean {
    return activeHunk !== null && row >= activeHunk.start && row < activeHunk.end;
  }

  /**
   * Stable identity for keyed reconciliation.
   *
   * Keying by list position is unsafe here: the render window slides, so the same
   * key comes to mean a different item, and a fold bar (a `<button>`) can swap
   * slots with a code row (a `<div>`) under that key. Svelte then reconciles nodes
   * across those mismatched branches, which is how a gutter ends up displaying a
   * neighbouring row's number.
   *
   * The key must therefore encode what the item *is*, not where it sits:
   * a row index is unique among rows, and a hunk index is unique among folds.
   */
  function keyFor(item: DisplayItem): string {
    if (item.fold) return `fold:${item.fold.hunkIndex}`;
    /*
     * A wrapped row appears several times in the list, so the row index alone is no
     * longer unique: `row:1` would be produced once per physical line and Svelte
     * throws `each_key_duplicate`, which aborted the whole render the moment
     * wrapping was switched on. The slice start disambiguates them.
     */
    if (item.wrap) return `row:${item.row}:${item.wrap.start}`;
    if (item.splitWrap) {
      const left = item.splitWrap.left?.start ?? "x";
      const right = item.splitWrap.right?.start ?? "x";
      return `row:${item.row}:${left}:${right}`;
    }
    return `row:${item.row}`;
  }
</script>

<div
  class="pane"
  class:wrapped
  bind:this={scroller}
  onscroll={handleScroll}
  role="presentation"
>

  <!--
    Spacer: the scrollable height, so the scrollbar is proportional to the document.

    Equal to the document height — no trailing padding. See `windowFor`.
  -->
  <div class="spacer" style:height="{win.scrollHeight}px">
    <div class="window" style:transform="translateY({win.offsetY}px)">
      {#each visible as item, i (keyFor(item))}
        {#if item.fold}
          <button
            class="fold"
            data-key={keyFor(item)}
            data-row={item.row}
            onclick={() => onExpandFold(item.fold!.hunkIndex)}
            title={$t("fold.expand", { from: item.fold.startRow + 1, to: item.fold.startRow + item.fold.count })}
          >
            <!--
              The gutter must stay populated on a fold bar. Leaving it blank makes
              the numbers around it read as if they repeated or skipped: the bar
              visually belongs to the row column, so it has to state which lines it
              stands for.
            -->
            <span class="fold-range">
              {item.fold.startRow + 1}–{item.fold.startRow + item.fold.count}
            </span>
            <span class="fold-label">
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              {$t("fold.unchangedLines", { n: item.fold.count })}
            </span>
          </button>
        {:else}
          {@const row = rows[item.row]}
          {@const line = side === "left" ? row.left : row.right}
          {@const segs = side === "left" ? row.left_inline : row.right_inline}
          {@const fullText = line !== null ? (lines[line] ?? "") : ""}
          <!--
            A wrapped item shows only its own character slice of the logical line.
            Split-view items carry one range per side because each pane has its own
            width; a `null` range is the shorter side's blank continuation.
          -->
          {@const sideWrap = item.splitWrap ? item.splitWrap[side] : item.wrap}
          {@const blankContinuation = item.splitWrap !== undefined && sideWrap === null}
          {@const wrapped = sideWrap !== undefined && sideWrap !== null}
          {@const range = sideWrap
            ? {
                start: sideWrap.start,
                end: sideWrap.end,
                text: fullText.slice(sideWrap.start, sideWrap.end),
              }
            : blankContinuation
              ? { start: 0, end: 0, text: "" }
              : { start: 0, end: fullText.length, text: fullText }}
          {@const continued = blankContinuation || (sideWrap?.continued ?? false)}
          {@const searchSlices = search === null
            ? []
            : searchSlicesFor(
                search.hitsByRow.get(item.row) ?? [],
                side,
                range.start,
                range.end,
                search.active,
              )}
          <div
            class="row"
            data-key={keyFor(item)}
            data-row={item.row}
            class:active={isActive(item.row)}
            class:hovered={hovered === win.start + i}
            onmouseenter={() => onHover(win.start + i)}
            onmouseleave={() => onHover(null)}
          >
            {#if item.collapsedBar}
              <button
                class="collapse"
                onclick={() => onCollapseFold(item.collapsedBar!.hunkIndex)}
                title={$t("fold.collapse", { n: item.collapsedBar.rowCount })}
                aria-label={$t("fold.collapse", { n: item.collapsedBar.rowCount })}
              >
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                  <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            {/if}
            <CodeLine
              {line}
              active={isActive(item.row)}
              kind={row.kind}
              segments={segmentsFor(segs, range, wrapped)}
              text={range.text}
              {continued}
              {side}
              {wrapped}
              {searchSlices}
              tokens={tokensFor(line, range, wrapped)}
            />
          </div>
        {/if}
      {/each}
    </div>
  </div>

</div>

<style>
  .pane {
    flex: 1 1 0;
    min-width: 0;
    /*
     * The positioning context for the off-screen marker.
     *
     * `relative` is enough: an absolutely positioned child of a scroll container is
     * laid out against the padding box, and only *in-flow* content scrolls away from
     * it. That is what lets the marker sit at a viewport-relative `top` instead of
     * travelling with the document like a sticky box would.
     */
    position: relative;
    /*
     * `min-height: 0` is required, not cosmetic: this pane is a flex item in a
     * column flex chain, and a flex item's default `min-height: auto` refuses to
     * shrink below its content. Without it the pane grows to the spacer's full
     * document height and stops being the scroll port.
     */
    min-height: 0;
    overflow: auto;
    background: var(--c-bg);
    /*
     * No reserved scrollbar gutter.
     *
     * `scrollbar-gutter: stable` keeps a 10px strip permanently free so the content
     * does not shift when a scrollbar appears. Two things made that strip visible and
     * unwanted: a row's tint is `min-width: 100%` of the *content* box, so the strip
     * stayed untinted — a white band down the right edge of every coloured row — and
     * it was there even for a document too short to scroll at all.
     *
     * macOS draws overlay scrollbars that take no space, so dropping the reservation
     * also removes the shift it was meant to prevent. On Windows the scrollbar does
     * occupy space, but both panes render the same number of aligned rows, so they
     * cross that threshold together and stay in step.
     */
    scrollbar-gutter: auto;
    /*
     * Deliberately NOT `contain: strict`.
     *
     * That shorthand includes size containment, which tells the engine to ignore
     * the element's contents when computing its own size. In a scroll container
     * that is self-defeating: the spacer exists precisely to give the port a
     * content-derived scroll height, and size containment makes that height
     * collapse to the port's own height. The pane could never scroll, and the
     * virtual window was computed from the wrong bounds — content stopped about
     * one screenful in, with blank space below.
     *
     * `layout paint` keeps the useful half (no reflow escape, clipped painting)
     * without the size implication.
     */
    contain: layout paint;
  }

  /*
   * Wrapping removes horizontal scrolling entirely.
   *
   * Slicing text is not enough by itself: `width: max-content` on the virtual
   * window can still preserve a few pixels of overflow, and an old scrollLeft can
   * then shift every row left. In wrapped mode the window, row and cell are all
   * constrained to the visible pane width.
   */
  .pane.wrapped {
    overflow-x: hidden;
    overflow-y: auto;
  }

  .spacer {
    position: relative;
    width: 100%;
  }

  /*
   * `width: max-content` is what makes horizontal scrolling possible at all:
   * rows are absolutely positioned, so they contribute no intrinsic width to the
   * spacer, and a fixed `width: 100%` would clip every long line with no way to
   * scroll to it. With `max-content` the wrapper grows to the widest rendered
   * row and the pane's own scrollbar picks it up.
   */
  .window {
    position: absolute;
    top: 0;
    left: 0;
    width: max-content;
    min-width: 100%;
    will-change: transform;
  }

  .pane.wrapped .window {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  /*
   * A row spans the full scrollable width, not just its text's width.
   *
   * `.window` is `max-content`, so it grows to the widest line in the document.
   * Without an explicit width each row shrank to its own text, and once the pane
   * was scrolled right the short rows ran out of background: their tint stopped at
   * the last character and the rest of the band was bare white. A row of a diff is
   * a full-width stripe, so the colour has to reach the right edge of whatever is
   * currently in view.
   *
   * `CodeLine` gives the cell the matching `min-width: 100%`. There is deliberately
   * no `width: 100%` on the cell: that would out-specify its `width: max-content`
   * and pin every cell to the row width, clipping long lines that horizontal
   * scrolling exists to reach.
   */
  /*
   * A row spans the full scrollable width, so its tint never stops short.
   *
   * `width: 100%` resolves against `.window`, which is `width: max-content` and is
   * therefore exactly as wide as the widest row — that is what makes horizontal
   * scrolling work at all.
   *
   * `min-width: max-content` is the second half, and it is what this rule used to
   * get wrong. A row's own content is gutter + text; without this line a row could
   * be *narrower* than the window when its cell refused to stretch, and the area
   * past the last character showed the pane's plain background instead of the
   * change tint — the "white band on the right" that appeared after scrolling to
   * the end of a line.
   */
  .row {
    height: var(--row-height);
    position: relative;
    width: 100%;
    min-width: max-content;
  }

  .pane.wrapped .row {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  /* Hover is a 1px hairline, not a background: it must not compete with tints. */
  .row.hovered {
    box-shadow: inset 0 0 0 1px var(--c-border);
  }

  /*
   * Active change marker: a solid accent bar on the left edge.
   *
   * Placed on the row's leading edge rather than as a row background so it reads
   * even on a row that already carries a red/green tint, and so the tint keeps
   * its meaning (added vs removed) while the bar answers "this is the one you
   * jumped to".
   */
  .row.active {
    position: relative;
  }

  /*
   * Active-change marker sits on the *trailing* edge of the gutter, not the
   * window's leading edge.
   *
   * The leading edge is now used by the per-row change stripe (added/removed),
   * which answers "is this line changed". This marker answers a different
   * question — "is this the change I just jumped to" — and two bars stacked in the
   * same 3px would be indistinguishable. Separating them keeps both readable.
   */
  .row.active::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--gutter-width);
    width: 2px;
    background: var(--c-accent);
    pointer-events: none;
  }

  /* --- fold bar -------------------------------------------------------- */
  .fold {
    display: flex;
    align-items: center;
    width: 100%;
    height: var(--row-height);
    padding: 0 10px 0 0;
    border: none;
    border-top: 1px solid var(--c-border);
    border-bottom: 1px solid var(--c-border);
    background: var(--c-fold-bg);
    color: var(--c-fold-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-code);
    text-align: left;
    cursor: pointer;
    /* The range inside is allowed to overflow the gutter; a button clips by
       default, which would defeat that. */
    overflow: visible;
  }

  .fold:hover {
    color: var(--c-text);
    background: var(--c-bg-elevated);
  }

  /*
   * Range sits in the gutter column so the bar lines up with the row numbers, but
   * is allowed to overflow it.
   *
   * The gutter is sized for line numbers only (see `gutterWidthFor`), which is
   * right for the 99% of rows that show a number — but a range like `1234–5678` is
   * wider than that column. Clipping it would print "12–56"; sized to fit, every
   * line would pay for a width only fold bars need. Overflowing is the cheap
   * option: nothing follows the range on this bar, so the text simply extends into
   * the empty code column beside it.
   */
  .fold-range {
    flex: 0 0 var(--gutter-width);
    padding-right: 10px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-faint);
    white-space: nowrap;
    overflow: visible;
  }

  .fold-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding-left: 10px;
  }

  /*
   * Collapse bar for an *expanded* unchanged run.
   *
   * Deliberately much quieter than a fold bar: it is an affordance on content the
   * user asked to see, not a stand-in for content that is hidden. A small circular
   * chevron straddles the gutter's trailing padding, like an editor's folding
   * control, so it is easy to find without covering the line number or code text.
   */
  .collapse {
    /*
     * Absolutely positioned so it adds no height: the virtual scroller's maths
     * assumes exactly one --row-height per display item, and an extra in-flow bar
     * would desynchronise the two panes by a few pixels per expanded run.
     */
    position: absolute;
    /*
     * Centre the 16px control on the gutter/code boundary. The line number ends
     * 10px before that boundary and the code starts 10px after it, leaving a 2px
     * gap on each side. With line numbers disabled, `max()` pins the control to
     * the pane edge while the code's own left padding still keeps it off the text.
     */
    left: max(0px, calc(var(--gutter-width) - 8px));
    top: 50%;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    transform: translateY(-50%);
    border: 1px solid var(--c-border-strong);
    border-radius: 50%;
    background: var(--c-bg-elevated);
    color: var(--c-text-muted);
    cursor: pointer;
    z-index: 2;
    /* Always visible but quiet; the tooltip carries the unchanged-line count. */
    opacity: 0.65;
    transition:
      opacity 100ms ease,
      background-color 100ms ease,
      border-color 100ms ease,
      color 100ms ease;
  }

  .row:hover .collapse,
  .collapse:focus-visible {
    opacity: 1;
  }

  .collapse:hover {
    color: var(--c-accent);
    background: var(--c-bg-sunken);
    border-color: var(--c-accent);
  }

  .collapse:focus-visible {
    outline: 2px solid var(--c-accent);
    outline-offset: 1px;
  }
</style>
