<script lang="ts">
  /**
   * One cell of one row: gutter number + code text.
   *
   * Three visual states, all mutually exclusive:
   *  - a real line with optional intra-line pills (`changed` non-empty)
   *  - a real line with no intra-line info (`changed` empty, whole row tinted)
   *  - a hatched placeholder for a missing side (`line === null`)
   *
   * The component is intentionally dumb: no state, no events. Row height and
   * font size come from CSS custom properties so nothing here can drift out of
   * sync with the virtual scroller's arithmetic.
   */
  import type { RowKind } from "../lib/types";
  import type { ChangedSpan } from "../lib/diffView";
  import type { Token } from "../lib/syntax";
  import { rowTint } from "../lib/theme";
  import type { SearchSlice } from "../lib/search";
  import { buildCodePieces } from "../lib/codeRender";

  interface Props {
    /** 0-based line index, or null for a padded cell. */
    line: number | null;
    kind: RowKind;
    /**
     * Character ranges the backend marked as changed, relative to `text`; empty
     * means "no character-level info".
     */
    changed: ChangedSpan[];
    /** Raw text for this cell (the visible slice when wrapped). */
    text: string;
    /** Gutter side, which also decides the tint hue. */
    side: "left" | "right";
    /**
     * True when this row belongs to the change the reader is currently on.
     *
     * Draws a caret in the gutter, so "which change am I on" is answerable at a
     * glance and not only from the toolbar counter.
     */
    active?: boolean;
    /**
     * True when this row is a continuation of a wrapped logical line.
     *
     * Continuations hide the line number — repeating it on every physical slice
     * would make one logical line look like several — and draw a quiet marker in the
     * gutter so the break is visibly not a new line of code.
     */
    continued?: boolean;
    /** Constrain the cell to the pane width in wrapped mode. */
    wrapped?: boolean;
    /** Search matches clipped to this physical wrapped slice. */
    searchSlices?: SearchSlice[];
    /**
     * Syntax tokens for this line, when the document's language is known.
     *
     * Empty means "not highlighted" — plain text, an unrecognised language, or the
     * feature switched off. The renderer then behaves exactly as before.
     *
     * Highlighting yields to character-level diffing: when `changed` is present the
     * reader is comparing two nearly identical lines, and the pills that show *which
     * character* changed carry more information than colouring a keyword.
     */
    tokens?: Token[];
  }

  let {
    line,
    kind,
    changed,
    text,
    side,
    active = false,
    continued = false,
    wrapped = false,
    tokens = [],
    searchSlices = [],
  }: Props = $props();

  const isPadded = $derived(line === null);

  // Delete/insert tinting is directional and belongs only to real lines. A padded
  // cell is an alignment placeholder, so colouring it would imply the old side has
  // an added line of its own.
  const tint = $derived(rowTint(kind, side, isPadded));
  const pieces = $derived(buildCodePieces(text, changed, tokens, searchSlices));
</script>

<div
  class="cell"
  class:padded={isPadded}
  class:active
  class:wrapped
  data-kind={kind}
  data-tint={tint}
  data-side={side}
>
  <span class="gutter" class:padded-num={isPadded}>
    <!--
      The caret sits *next to* the number, never instead of it: the whole point of
      the marker is to make "which change" and "which line" readable together.
    -->
    {#if active}
      <span class="caret" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="8" height="8">
          <path d="M5.5 3.5 10 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    {/if}
    {#if continued}
      <!-- A continuation shows a soft tick instead of the number it would repeat. -->
      <span class="cont" aria-hidden="true">↳</span>
    {:else if line !== null}
      <span class="num">{line + 1}</span>
    {/if}
  </span>

  <span class="code selectable">
    {#if isPadded}
      <!-- Nothing: the hatched background is painted by the .padded rule. -->
    {:else}
      {#each pieces as piece, i (i)}
        <span
          class:pill={piece.changed}
          class:search-hit={piece.search === "hit"}
          class:search-current={piece.search === "current"}
          class={`syn-${piece.kind}`}
          data-tint={piece.changed ? tint : "none"}
        >{piece.text}</span>
      {/each}
    {/if}
  </span>
</div>

<style>
  .cell {
    display: flex;
    align-items: stretch;
    height: var(--row-height);
    line-height: var(--row-height);
    font-family: var(--font-mono);
    font-size: var(--font-size-code);
    white-space: pre;
    /* Keep in sync with TAB_COLUMNS in viewport.ts. */
    tab-size: 8;
    box-sizing: border-box;
    /*
     * The cell's background is the change tint, so it must span the full visible
     * band, not just the text.
     *
     * With plain flex defaults the cell sized itself to its content: a short line
     * produced a short stripe, and once the pane was scrolled right the tint
     * stopped at the last character with bare white to the end of the row.
     * `min-width: 100%` stretches the stripe across the row, while
     * `width: max-content` still lets a long line grow past it — which is what
     * keeps horizontal scrolling working, since the wrapper is sized by the
     * widest cell.
     *
     * No `overflow: hidden` and no `contain: layout`: a clipped cell would
     * silently truncate long lines with no scrollbar to reach them, and layout
     * containment reports a zero intrinsic width to the parent's `max-content`
     * sizing, defeating horizontal scrolling entirely.
     *
     * The floor is `100%` of the scroll container's content box. Content cannot paint
     * over a *classic* scrollbar — the port clips it — so on a platform that reserves
     * scrollbar space the tint stops at that reservation. macOS (and any platform with
     * overlay scrollbars) reserves nothing, so the tint reaches the edge.
     */
    min-width: 100%;
    width: max-content;
    contain: style;
  }

  /*
   * A wrapped cell is a viewport, not an intrinsic-width code line.
   *
   * The normal cell intentionally uses `width: max-content` so unwrapped code can
   * extend horizontally. Leaving that in place after wrapping lets the widest
   * slice create a scroll range and causes the pane to appear shifted sideways.
   */
  .cell.wrapped {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  /*
   * Syntax colours.
   *
   * Class per token kind rather than an inline style: one rule per kind keeps the
   * paint cheap across thousands of spans, and the colours come from the palette so
   * a theme switch needs no re-tokenise.
   */
  .syn-keyword {
    color: var(--c-syntax-keyword);
  }

  .syn-type {
    color: var(--c-syntax-type);
  }

  .syn-function {
    color: var(--c-syntax-function);
  }

  .syn-string {
    color: var(--c-syntax-string);
  }

  .syn-number {
    color: var(--c-syntax-number);
  }

  .syn-comment {
    color: var(--c-syntax-comment);
    font-style: italic;
  }

  .syn-punctuation {
    color: var(--c-syntax-punctuation);
  }

  /* --- row tint ------------------------------------------------------- */
  .cell[data-tint="del"] {
    background: var(--c-del-row);
  }

  .cell[data-tint="ins"] {
    background: var(--c-ins-row);
  }

  /*
   * Left edge marker.
   *
   * A 3px solid stripe on the leading edge of every changed row. The row tint
   * alone is deliberately faint (8% alpha) so long runs stay readable; the stripe
   * is what makes the *extent* of a change obvious when scanning the left margin.
   * Drawn as an inset shadow rather than a border so it cannot affect layout and
   * so it sits above the gutter background.
   */
  /* `--change-edge-w` is set from settings: 3px when the stripe is on, 0 when off. */
  .cell[data-tint="del"] {
    box-shadow: inset var(--change-edge-w, 3px) 0 0 var(--c-del-edge);
  }

  .cell[data-tint="ins"] {
    box-shadow: inset var(--change-edge-w, 3px) 0 0 var(--c-ins-edge);
  }

  /* --- gutter --------------------------------------------------------- */
  .gutter {
    flex: 0 0 var(--gutter-width);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding-right: 10px;
    text-align: right;
    color: var(--c-gutter-text);
    background: var(--c-gutter-bg);
    /* Tabular digits stop the numbers from jittering while scrolling. */
    font-variant-numeric: tabular-nums;
    /* Gutter is chrome: not selectable, not copyable with the code. */
    user-select: none;
    border-right: 1px solid var(--c-border);
  }

  /*
   * Gutter wash.
   *
   * GitHub's diff colours the *whole* left column, number included, at a slightly
   * stronger alpha than the row. That is what makes a run of changed lines read as
   * a solid block from the edge of the window instead of as a pale band behind the
   * text only. A weaker alpha than the row would defeat the purpose, so the gutter
   * uses the row colour at full strength and the number brightens for contrast.
   */
  .cell[data-tint="del"] .gutter {
    background: var(--c-del-row);
    color: var(--c-del-gutter-text);
  }

  .cell[data-tint="ins"] .gutter {
    background: var(--c-ins-row);
    color: var(--c-ins-gutter-text);

  /* Continuation marker: quieter than a number, so it reads as "same line". */
  .cont {
    color: var(--c-text-faint);
    opacity: 0.7;
  }
  }

  .gutter.padded-num {
    color: transparent;
  }

  /* Active row: accent number plus a caret, so the row is findable at a glance. */
  .cell.active .gutter {
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-gutter-bg));
  }

  .cell.active .num {
    color: var(--c-accent);
    font-weight: 600;
  }

  .caret {
    display: inline-flex;
    align-items: center;
    color: var(--c-accent);
    margin-right: 1px;
  }

  /* Numbers keep their right alignment even when a caret is present. */
  .num {
    font-variant-numeric: tabular-nums;
  }

  /* --- code ----------------------------------------------------------- */
  .code {
    flex: 0 0 auto;
    padding: 0 12px 0 10px;
    /* Intrinsic width so the row can be wider than the viewport. */
    white-space: pre;
  }

  .cell.wrapped .code {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  /* --- intra-line pill ------------------------------------------------ */
  /*
   * 2px radius per the spec. `box-decoration-break` is not needed because a
   * segment never wraps (rows are single-line by construction).
   */
  .pill {
    border-radius: 2px;
    padding: 1px 0;
  }

  .pill[data-tint="del"] {
    background: var(--c-del-pill);
    color: var(--c-del-pill-text);
  }

  .pill[data-tint="ins"] {
    background: var(--c-ins-pill);
    color: var(--c-ins-pill-text);
  }

  /* Search wins over diff pills and syntax colours on the same characters. */
  .search-hit {
    border-radius: 2px;
    background: color-mix(in srgb, var(--c-accent) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 42%, transparent);
  }

  .search-current {
    border-radius: 2px;
    background: var(--c-accent);
    color: var(--c-bg);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-accent) 72%, transparent);
    font-weight: 650;
  }

  /* --- hatched placeholder -------------------------------------------- */
  /*
   * 45° micro-stripe. Drawn as a repeating gradient rather than an image so it
   * tints correctly with the palette and costs no asset.
   */
  .cell.padded {
    background-color: var(--c-hatch-bg);
    background-image: repeating-linear-gradient(
      45deg,
      transparent 0 3px,
      var(--c-hatch-line) 3px 3.5px
    );
  }

  /*
   * Padded (hatched) cells keep the gutter transparent so the 45° stripe reads as
   * one continuous neutral surface across the whole cell. They deliberately carry
   * no red/green change tint: only lines that actually exist on that side may look
   * added or removed.
   */
  .cell.padded .gutter {
    background: transparent;
    border-right-color: transparent;
    /* The line number is absent here; a change-tinted gutter would imply one. */
    color: transparent;
  }
</style>
