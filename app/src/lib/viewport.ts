/**
 * Viewport maths, kept free of Svelte and DOM so it can be reasoned about (and
 * tested) in isolation.
 *
 * ## Why fixed-height rows
 *
 * Synchronised scrolling between two panes is trivial only if a row index maps to
 * the same pixel offset in both. Fixed row height gives that for free: one
 * `scrollTop` drives both panes, and no measurement pass is needed. The cost is
 * that long lines wrap rather than grow the row — acceptable for a code diff,
 * where horizontal scroll is the norm.
 *
 * ## Folding
 *
 * Long unchanged runs collapse to a single "N unchanged lines" bar. Folding is
 * expressed as a *projection*: `visibleRows` maps a display index to a source row
 * index. Scroll positions and navigation all work in display space, so folding
 * never needs to touch the DOM reconciliation logic.
 */

import { metrics } from "./theme";
import type { Hunk } from "./types";

/** One physical slice of a logical line, expressed as UTF-16 offsets. */
export interface WrapRange {
  /**
   * Character offsets into the logical line, not visual columns.
   *
   * Pixel wrapping can break between any two grapheme clusters, so keeping the
   * exact string offsets avoids converting a measured boundary back through a
   * second width model.
   */
  start: number;
  end: number;
  continued: boolean;
}

/** Measured advances of the two glyph classes used by the code font. */
export interface WrapMetrics {
  /** Advance width of an ordinary Latin/code glyph, in CSS pixels. */
  charWidth: number;
  /** Advance width of a CJK or emoji grapheme, in CSS pixels. */
  wideCharWidth: number;
  /** Monospace tab stops. Keep in sync with CSS `tab-size`. */
  tabSize?: number;
}

/** One entry in the flattened display list. */
export interface DisplayItem {
  /** Index into `DiffResult.rows`. */
  row: number;
  /** Set when this item represents a folded run rather than a real row. */
  fold: FoldInfo | null;
  /**
   * Character range within the row, when the line is wrapped.
   *
   * Absent means "the whole line", which is the unwrapped case and stays the
   * default so nothing changes when wrapping is off.
   */
  wrap?: WrapRange;
  /**
   * Side-specific wrap ranges for the split view.
   *
   * The two panes can have different widths, so each side gets its own physical
   * slices. The item list remains shared and row-aligned by filling the shorter
   * side with `null` continuation ranges.
   */
  splitWrap?: {
    left: WrapRange | null;
    right: WrapRange | null;
  };
  /**
   * Set on the first row of an *expanded* unchanged run, so the pane can draw a
   * bar that collapses it again. Without this an expanded run is a one-way door.
   */
  collapsedBar?: CollapseInfo | null;
}

/** Marker shown at the top of an expanded unchanged run. */
export interface CollapseInfo {
  /** Hunk index to pass back when the user collapses it. */
  hunkIndex: number;
  /** How many rows the run spans. */
  rowCount: number;
}

export interface FoldInfo {
  /** Number of hidden rows. */
  count: number;
  /** Source row index of the first hidden row. */
  startRow: number;
  /** Hunk index this fold belongs to (for expand state). */
  hunkIndex: number;
}

/**
 * Build the display list from hunks.
 *
 * A hunk is the natural fold unit: equal hunks longer than the threshold fold,
 * change hunks always show. `expanded` holds hunk indices the user opened.
 */
export function buildDisplay(
  hunks: Hunk[],
  threshold: number,
  expanded: ReadonlySet<number>,
): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const h = hunks[hunkIndex];
    const foldable = h.equal && h.row_len > threshold && !expanded.has(hunkIndex);

    // An expanded, long unchanged run gets a collapse bar on its first row.
    const collapsible = h.equal && h.row_len > threshold && expanded.has(hunkIndex);

    if (collapsible) {
      for (let i = 0; i < h.row_len; i++) {
        items.push({
          row: h.row_start + i,
          fold: null,
          collapsedBar:
            i === 0
              ? { hunkIndex, rowCount: h.row_len }
              : null,
        });
      }
      continue;
    }

    if (foldable) {
      // Keep a little context: the first and last rows of a long equal run stay
      // visible, which is what makes a folded diff read like an outline.
      const context = Math.min(1, Math.floor(h.row_len / 2));
      for (let i = 0; i < context; i++) {
        items.push({ row: h.row_start + i, fold: null });
      }
      const hiddenCount = h.row_len - context * 2;
      if (hiddenCount > 0) {
        items.push({
          row: h.row_start + context,
          fold: {
            count: hiddenCount,
            startRow: h.row_start + context,
            hunkIndex,
          },
        });
        for (let i = 0; i < context; i++) {
          items.push({ row: h.row_start + h.row_len - context + i, fold: null });
        }
      } else {
        for (let i = context; i < h.row_len; i++) {
          items.push({ row: h.row_start + i, fold: null });
        }
      }
    } else {
      for (let i = 0; i < h.row_len; i++) {
        items.push({ row: h.row_start + i, fold: null });
      }
    }
  }

  return items;
}

const DEFAULT_TAB_SIZE = 8;

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function* graphemes(text: string): Generator<{ segment: string; index: number }> {
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(text)) {
      yield { segment: part.segment, index: part.index };
    }
    return;
  }

  let index = 0;
  for (const segment of Array.from(text)) {
    yield { segment, index };
    index += segment.length;
  }
}

/**
 * Advance of one grapheme at the current monospace column.
 *
 * Width is measured per grapheme rather than per UTF-16 code unit so emoji ZWJ
 * sequences and combining marks are not split at a wrap boundary.
 */
function graphemeAdvance(
  segment: string,
  column: number,
  metrics: WrapMetrics,
): { pixels: number; columns: number } {
  const tabSize = Math.max(1, Math.floor(metrics.tabSize ?? DEFAULT_TAB_SIZE));
  if (segment === "\t") {
    const columns = tabSize - (column % tabSize);
    return { pixels: columns * metrics.charWidth, columns };
  }

  let wide = false;
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\u200d" || isWideCodePoint(code)) {
      wide = true;
      break;
    }
  }

  if (wide) return { pixels: metrics.wideCharWidth, columns: 2 };
  if ([...segment].every((char) => ZERO_WIDTH.test(char))) {
    return { pixels: 0, columns: 0 };
  }
  return { pixels: metrics.charWidth, columns: 1 };
}

/** Rendered width of a string under the supplied code-font metrics. */
export function visualWidth(text: string, metrics: WrapMetrics): number {
  let width = 0;
  let column = 0;
  for (const { segment } of graphemes(text)) {
    const advance = graphemeAdvance(segment, column, metrics);
    width += advance.pixels;
    column += advance.columns;
  }
  return width;
}

/**
 * Split a line at the last grapheme that fits inside `maxWidth` CSS pixels.
 *
 * The previous wrapper converted text to monospace *columns*, assuming every CJK
 * glyph was exactly twice the bundled Latin font's advance. macOS renders CJK from
 * a fallback font whose glyphs are narrower than that. Long mixed-language lines
 * therefore stopped at different points depending on their ASCII/CJK mix, leaving
 * conspicuous empty space at the right edge. Returning UTF-16 offsets lets the
 * renderer slice exactly at the boundary chosen by the measured pixel widths.
 */
export function wrapTextByWidth(
  text: string,
  maxWidth: number,
  metrics: WrapMetrics,
): WrapRange[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0 || text.length === 0) {
    return [{ start: 0, end: text.length, continued: false }];
  }

  const out: WrapRange[] = [];
  let start = 0;
  let width = 0;
  let column = 0;

  for (const part of graphemes(text)) {
    const advance = graphemeAdvance(part.segment, column, metrics);
    if (width > 0 && width + advance.pixels > maxWidth) {
      out.push({ start, end: part.index, continued: start > 0 });
      start = part.index;
      width = 0;
      column = 0;
    }
    width += advance.pixels;
    column += advance.columns;
  }

  out.push({ start, end: text.length, continued: start > 0 });
  return out;
}

/**
 * Expand a split-view row using a different wrap width for each pane.
 *
 * The panes must still share one display-item list so vertical scrolling stays
 * synchronised. We therefore emit the longer side's number of rows and use `null`
 * ranges to blank the shorter side once its text has ended.
 */
export function expandSplitWrapped(
  items: DisplayItem[],
  leftMaxWidth: number,
  rightMaxWidth: number,
  leftText: (row: number) => string,
  rightText: (row: number) => string,
  metrics: WrapMetrics,
): DisplayItem[] {
  const minimumWidth = MIN_WRAP_COLUMNS * metrics.charWidth;
  if (leftMaxWidth < minimumWidth || rightMaxWidth < minimumWidth) return items;

  const out: DisplayItem[] = [];
  for (const item of items) {
    if (item.fold) {
      out.push(item);
      continue;
    }

    const left = wrapTextByWidth(leftText(item.row), leftMaxWidth, metrics);
    const right = wrapTextByWidth(rightText(item.row), rightMaxWidth, metrics);
    const count = Math.max(left.length, right.length);
    if (count <= 1) {
      out.push(item);
      continue;
    }

    for (let i = 0; i < count; i++) {
      out.push({
        row: item.row,
        fold: null,
        collapsedBar: i === 0 ? item.collapsedBar ?? null : null,
        splitWrap: {
          left: left[i] ?? null,
          right: right[i] ?? null,
        },
      });
    }
  }
  return out;
}

/** Visible window of a scroller, in display-item indices. */
export interface Window {
  /** First rendered item, including overscan above the viewport. */
  start: number;
  /** One past the last rendered item, including overscan below. */
  end: number;
  /**
   * First item actually visible (no overscan).
   *
   * Navigation must anchor here, not on `start`: `start` sits above the viewport,
   * so anchoring there makes the hunk you just jumped to look like it is still
   * ahead of you and ⌘] appears stuck.
   */
  firstVisible: number;
  /** Pixel offset of the first rendered item, for absolute positioning. */
  offsetY: number;
  /** Height of the document itself. */
  totalHeight: number;
  /**
   * Height the scroll port must be.
   *
   * Currently always equal to `totalHeight`. It stays a separate field because the
   * spacer is sized from it and every consumer already distinguishes "document"
   * from "scrollable extent" — a distinction that would be needed again if any
   * bottom padding ever came back.
   */
  scrollHeight: number;
}

/**
 * Compute the render window for a scroll position.
 *
 * `start`/`end` are half-open. The result is clamped to the item count, so an
 * over-scroll after a re-diff cannot produce a negative or out-of-range slice.
 */
export function windowFor(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number = metrics.rowHeight,
  overscan: number = metrics.overscan,
): Window {
  const totalHeight = itemCount * rowHeight;
  if (itemCount === 0) {
    return { start: 0, end: 0, firstVisible: 0, offsetY: 0, totalHeight: 0, scrollHeight: 0 };
  }

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1;

  // Clamp the window origin first: when a re-diff shrinks the document the
  // scroller can still report an old, much larger `scrollTop`, and an unclamped
  // start would point past the end of the item list.
  const start = Math.min(itemCount, Math.max(0, firstVisible - overscan));
  const end = Math.min(itemCount, Math.max(start, firstVisible + visibleCount + overscan));

  return {
    start,
    end,
    firstVisible: Math.min(itemCount, Math.max(0, firstVisible)),
    offsetY: start * rowHeight,
    totalHeight,
    /*
     * Scrollable extent.
     *
     * Equal to the document: there is no trailing padding. An earlier version
     * added half a viewport so the last line could be scrolled up to the top edge,
     * but the cost is visible and the benefit is not — at the bottom of a long file
     * the reader is left staring at up to half a screen of nothing, which reads as
     * "the content stopped but the scrollbar kept going". Reaching the end of the
     * document and having the document end is the honest behaviour.
     */
    scrollHeight: totalHeight,
  };
}

/**
 * Index of the change hunks entry whose rows are nearest `row`.
 *
 * "Nearest" is measured to the *centre* of the hunk's row range, and the caller is
 * expected to pass a reference row from the middle of the viewport rather than its
 * top edge.
 *
 * ## Why nearest, and not "first at or below"
 *
 * The marker that highlights the current change has to move as the user scrolls —
 * that is the whole point of it. Anchoring on the viewport top and searching for
 * the first change at or below it gives a marker that jumps at arbitrary moments
 * and, once every change is above the top edge, stops moving at all: the search
 * fails, the caller falls back to the last change, and the highlight sticks to a
 * row that has long scrolled off. Distance to the reference row has no such edge:
 * it keeps decreasing and increasing smoothly in both directions.
 *
 * Ties go to the earlier hunk, so scrolling up and then down again returns to the
 * same marker instead of oscillating between two equidistant changes.
 */
export function nearestChange(
  changes: readonly { h: { row_start: number; row_len: number } }[],
  row: number,
): number {
  if (changes.length === 0) return -1;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < changes.length; i++) {
    const { row_start, row_len } = changes[i].h;
    const centre = row_start + Math.max(0, row_len - 1) / 2;
    const distance = Math.abs(centre - row);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Display index of a source row, or the nearest display item at or before it.
 *
 * Used by minimap clicks and by `Cmd+]` navigation, both of which think in source
 * rows while the scroller thinks in display items.
 */
export function displayIndexForRow(items: DisplayItem[], row: number): number {
  if (items.length === 0) return 0;
  // Items are ordered by `row`, so a binary search is valid.
  let lo = 0;
  let hi = items.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = items[mid];
    if (item.row <= row) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Scroll offset that puts `itemIndex` at the top of the viewport. */
export function scrollTopForItem(
  itemIndex: number,
  rowHeight: number = metrics.rowHeight,
): number {
  return Math.max(0, itemIndex * rowHeight);
}

/**
 * Scroll offset that centres `itemIndex`, used when jumping to a diff so context
 * above and below is visible.
 */
export function scrollTopToCentre(
  itemIndex: number,
  viewportHeight: number,
  rowHeight: number = metrics.rowHeight,
): number {
  return Math.max(0, itemIndex * rowHeight - viewportHeight / 2 + rowHeight / 2);
}

/**
 * Display-item index used as the reference point for "which change am I on".
 *
 * ## Why the anchor follows scroll progress, not a fixed viewport row
 *
 * Anchoring on the middle row of the viewport reads naturally mid-document, but
 * its range is limited: at the maximum scroll offset the middle row is
 * `itemCount - viewportRows / 2`, so a change in the bottom half of the final
 * screenful can never become the nearest one. Scrolling to the end then leaves
 * the marker parked on whatever change sat at or above the midline, even though
 * changes below it are plainly visible — the "marker stops halfway down" bug.
 *
 * Mapping the scroll offset onto `[0, itemCount - 1]` fixes that: at offset 0
 * the anchor is the first item, at max scroll it is the last item, and halfway
 * through it coincides with the viewport midline (both are linear in the scroll
 * fraction). Every row, including the final one, can therefore be the anchor.
 *
 * A document that fits the viewport has no scroll progress; its anchor is the
 * middle item, so the marker starts on something representative instead of
 * pinning to the first or last change.
 */
export function anchorIndexForScroll(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number = metrics.rowHeight,
): number {
  if (itemCount <= 0) return 0;
  const maxScroll = Math.max(0, itemCount * rowHeight - viewportHeight);
  if (maxScroll <= 0) return Math.floor((itemCount - 1) / 2);
  const clamped = Math.min(maxScroll, Math.max(0, scrollTop));
  return Math.round((clamped / maxScroll) * (itemCount - 1));
}

/**
 * Scroll offset that shows `row` with a few lines of context above it.
 *
 * `contextRows` keeps the changed line off the very top edge, which is where it
 * would otherwise land and read as if it were part of the previous hunk.
 *
 * The result is clamped to `[0, totalHeight - viewportHeight]`: without the upper
 * clamp, jumping to a row near the end asks for an offset the scroller cannot
 * reach, and the browser resolves it to the maximum — leaving the target out of
 * view (or, on some engines, fighting the requested value on every frame).
 *
 * Returns 0 when the document is shorter than the viewport.
 */
export function scrollTopToRow(
  row: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number = metrics.rowHeight,
  contextRows: number = 3,
): number {
  const totalHeight = itemCount * rowHeight;
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const desired = (row - contextRows) * rowHeight;
  return Math.min(maxScroll, Math.max(0, desired));
}

/**
 * Gutter width needed to show a document's line numbers.
 *
 * ## Why fold ranges do not widen the gutter
 *
 * A fold bar prints `1234–5678` — two numbers and a dash. Sizing the column for that
 * string makes every line pay for a width only fold bars need. On a 637-line file
 * the old formula asked for 80px: enough for seven characters, when the numbers
 * themselves were three. Visibly half empty, and the most common complaint about
 * the layout.
 *
 * Fold ranges are instead allowed to overflow their cell, which costs nothing:
 * they sit on a full-width bar with no text after them, so spilling into the code
 * column reads fine, while a permanently-too-wide gutter does not.
 *
 * ## Why there is still a floor
 *
 * Below roughly four digits the column starts to look cramped against the code, and
 * it would resize on every file — a two-line paste would get a gutter half the width
 * of a real one. So the floor fits `minDigits` worth of digits and the column only
 * grows for a genuinely large file.
 */
export function gutterWidthFor(
  maxLineNumber: number,
  options: { minDigits?: number; charWidth?: number; paddingChars?: number } = {},
): number {
  const { minDigits = 4, charWidth = 7.2, paddingChars = 2.2 } = options;
  const digits = String(Math.max(1, maxLineNumber)).length;
  return Math.ceil((Math.max(digits, minDigits) + paddingChars) * charWidth);
}

/**
 * One entry in the unified view's flattened, foldable line list.
 *
 * The unified view had no folding at all: it mapped every aligned row to one or two
 * physical lines and rendered them all, so a file with one changed line showed the
 * other 414 lines in full while the split view collapsed them into two bars. This
 * type is what lets both views share one fold state.
 */
export type UnifiedItem =
  | {
      /** A real physical line. */
      fold: null;
      /** Row index into `DiffResult.rows`. */
      sourceRow: number;
      /** `"left"` for the old side of a modify, `"right"` for the new. */
      side: "left" | "right";
      /** 1-based render key suffix, disambiguating the two halves of a modify. */
      half: 0 | 1;
      /** Present when this is one physical slice of a wrapped line. */
      wrap?: WrapRange;
    }
  | {
      /** A collapsed run, drawn as a bar the user can click. */
      fold: FoldInfo;
      sourceRow: number;
      side: "left" | "right";
      half: 0 | 1;
      wrap?: WrapRange;
    };

/**
 * Build the unified view's line list, with equal runs foldable.
 *
 * Mirrors [`buildDisplay`] in intent and in its fold rules — the same threshold, the
 * same one-row-of-context on each side, the same `expanded` set of hunk indices — so
 * switching between the two views never changes which lines are collapsed.
 *
 * A `modify` row expands to two lines (old above new) and counts as one unit for
 * folding purposes: folding is decided per *hunk*, and a hunk spans whole rows.
 */
export function buildUnifiedDisplay(
  hunks: Hunk[],
  rows: ReadonlyArray<{ kind: string }>,
  threshold: number,
  expanded: ReadonlySet<number>,
): UnifiedItem[] {
  const items: UnifiedItem[] = [];

  const pushRow = (sourceRow: number, hunkIndex: number): void => {
    void hunkIndex;
    // A modify row shows the old line then the new one; every other kind shows one
    // line. This is the same rule `unifiedIndexForRow` counts with.
    if (rows[sourceRow]?.kind === "modify") {
      items.push({ fold: null, sourceRow, side: "left", half: 0 });
      items.push({ fold: null, sourceRow, side: "right", half: 1 });
      return;
    }
    items.push({ fold: null, sourceRow, side: "left", half: 0 });
  };

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const h = hunks[hunkIndex];
    const foldable = h.equal && h.row_len > threshold && !expanded.has(hunkIndex);
    const collapsible = h.equal && h.row_len > threshold && expanded.has(hunkIndex);

    if (!foldable) {
      for (let i = 0; i < h.row_len; i++) pushRow(h.row_start + i, hunkIndex);
      void collapsible;
      continue;
    }

    // One row of context at each end, then a bar standing for the rest — the same
    // shape the split view uses, so the two views agree on what is visible.
    const context = Math.min(1, Math.floor(h.row_len / 2));
    for (let i = 0; i < context; i++) pushRow(h.row_start + i, hunkIndex);
    const hidden = h.row_len - context * 2;
    if (hidden > 0) {
      items.push({
        fold: { count: hidden, startRow: h.row_start + context, hunkIndex },
        sourceRow: h.row_start + context,
        side: "left",
        half: 0,
      });
      for (let i = h.row_len - context; i < h.row_len; i++) pushRow(h.row_start + i, hunkIndex);
    } else {
      for (let i = context; i < h.row_len; i++) pushRow(h.row_start + i, hunkIndex);
    }
  }

  return items;
}

/**
 * Expand unified-view lines by measured pixel width.
 *
 * The unified view has one text side per item instead of a left/right pair, so it
 * can use the same measured slices as the split view without the two-side alignment
 * callback. Fold bars stay unchanged.
 */
export function expandUnifiedWrapped(
  items: UnifiedItem[],
  maxWidth: number,
  textFor: (item: UnifiedItem) => string,
  metrics: WrapMetrics,
): UnifiedItem[] {
  if (maxWidth < MIN_WRAP_COLUMNS * metrics.charWidth) return items;

  const out: UnifiedItem[] = [];
  for (const item of items) {
    if (item.fold !== null) {
      out.push(item);
      continue;
    }

    const ranges = wrapTextByWidth(textFor(item), maxWidth, metrics);
    if (ranges.length <= 1) {
      out.push(item);
      continue;
    }

    for (const range of ranges) {
      out.push({
        ...item,
        wrap: range,
      });
    }
  }
  return out;
}

/**
 * Unified-flow line index of a source row, in the foldable projection.
 *
 * Replaces `unifiedIndexForRow` for the folded view: with folds, a row inside a
 * collapsed run has no line of its own, so counting physical lines would point at
 * the wrong place. This counts *projected items* instead.
 */
/**
 * The collapsed run that hides `row` in the unified projection, or null.
 *
 * The unified counterpart of [`foldHidingRow`]: navigation has to expand a fold
 * before jumping into it, because a row inside a collapsed run has no line in the
 * projection and would resolve to the bar above it — the viewport then "jumps" to
 * where it already is.
 */
export function unifiedFoldHidingRow(items: readonly UnifiedItem[], row: number): number | null {
  for (const item of items) {
    if (item.fold === null) continue;
    const start = item.fold.startRow;
    const end = start + item.fold.count;
    if (row >= start && row < end) return item.fold.hunkIndex;
  }
  return null;
}

export function unifiedIndexIn(items: readonly UnifiedItem[], row: number): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.fold === null) {
      if (item.sourceRow >= row) return i;
      continue;
    }
    /*
     * A bar stands for `count` hidden rows, so a target inside one has no line of
     * its own and resolves to the bar — the caller is expected to expand that run
     * first (see `unifiedFoldHidingRow`). Testing the *bar's range* rather than its
     * starting row is what makes that resolution land on the bar instead of the item
     * after it.
     */
    const end = item.fold.startRow + item.fold.count;
    if (row >= item.fold.startRow && row < end) return i;
    if (item.fold.startRow >= row) return i;
  }
  return items.length;
}

/**
 * Number of unified lines that precede a given source row.
 *
 * The unified view turns one aligned row into one line for equal/delete/insert,
 * and **two** for modify (old above new). Navigation in that view therefore needs
 * a source-row -> unified-line projection; using the source row directly would
 * drift by one line for every modification above the target.
 *
 * Mirrors `UnifiedView`'s flattening exactly; the two must stay in step.
 */
export function unifiedIndexForRow(
  rows: ReadonlyArray<{ kind: string }>,
  row: number,
): number {
  let lines = 0;
  const upto = Math.min(row, rows.length);
  for (let i = 0; i < upto; i++) {
    // A modify row renders twice; every other kind renders once.
    lines += rows[i].kind === "modify" ? 2 : 1;
  }
  return lines;
}

/**
 * Total unified line count for an aligned row list.
 */
export function unifiedLineCount(
  rows: ReadonlyArray<{ kind: string }>,
): number {
  return unifiedIndexForRow(rows, rows.length);
}

/**
 * Fold that hides `row`, if any.
 *
 * Navigation must expand a fold before jumping into it: `displayIndexForRow` can
 * only return indices that exist in the display list, so a row buried inside a
 * collapsed run resolves to the fold bar itself — the viewport then "jumps" to
 * where it already is and the shortcut looks broken.
 *
 * Returns the fold's hunk index, or null when the row is already visible.
 */
export function foldHidingRow(
  items: DisplayItem[],
  row: number,
): number | null {
  for (const item of items) {
    if (!item.fold) continue;
    const start = item.fold.startRow;
    const end = start + item.fold.count;
    if (row > start && row < end) return item.fold.hunkIndex;
  }
  return null;
}

/**
 * Scroll offset to keep the same content visible after a fold is expanded.
 *
 * Expanding replaces one fold bar with `hiddenCount` rows. If that bar sits above
 * the viewport, every visible row shifts down by `hiddenCount - 1` rows, and
 * leaving `scrollTop` untouched makes the content appear to jump upward — the
 * user loses their place for a change they did not ask to make. Compensating is
 * the whole point of anchoring.
 *
 * Expanding at or below the viewport needs no correction: nothing above moved.
 */
export function scrollTopAfterExpand(
  scrollTop: number,
  foldDisplayIndex: number,
  hiddenCount: number,
  firstVisible: number,
  rowHeight: number = metrics.rowHeight,
): number {
  if (foldDisplayIndex >= firstVisible) return scrollTop;
  const addedRows = Math.max(0, hiddenCount - 1);
  return scrollTop + addedRows * rowHeight;
}

/**
 * Next/previous change hunk relative to the current source row.
 *
 * `direction` is +1 or -1. Returns null when there is nothing further in that
 * direction, which the caller surfaces as a no-op rather than wrapping around
 * (wrapping hides the fact that you reached the end).
 */
export function nextChangeHunk(
  hunks: Hunk[],
  currentRow: number,
  direction: 1 | -1,
): Hunk | null {
  if (direction === 1) {
    for (const h of hunks) {
      if (!h.equal && h.row_start > currentRow) return h;
    }
    return null;
  }
  let candidate: Hunk | null = null;
  for (const h of hunks) {
    if (!h.equal && h.row_start < currentRow) candidate = h;
  }
  return candidate;
}

/**
 * Split one logical line into fixed-width segments.
 *
 * Wrapping is implemented as *segmentation into fixed-height physical lines*, not
 * as CSS `white-space: pre-wrap`.
 *
 * That distinction is what keeps the rest of the viewer intact. The virtual
 * scroller positions everything by `index * rowHeight`; with real CSS wrapping a
 * row's height depends on its content, so offsets would have to be measured after
 * layout, on every font/size/window change, in two panes that must stay aligned.
 * Segmenting produces N lines of the known height instead, so rendering, folding,
 * and the synchronised scroll all keep working unchanged.
 *
 * Splitting is by display columns rather than string indices: CJK glyphs and
 * emoji occupy two monospace cells, while tabs advance to the next tab stop.
 * Counting JavaScript code units made a line of Chinese look half as wide as it
 * rendered, so wrapping either did not start or still overflowed after it did.
 */
export function wrapLine(text: string, columns: number): WrapRange[] {
  const width = Math.max(1, Math.floor(columns));
  const total = displayWidth(text);
  if (total <= width) return [{ start: 0, end: text.length, continued: false }];

  const out: WrapRange[] = [];
  for (let start = 0; start < total; start += width) {
    const end = Math.min(total, start + width);
    const slice = sliceAtColumns(text, start, end);
    if (slice.end > slice.start) {
      out.push({ start: slice.start, end: slice.end, continued: start > 0 });
    }
  }
  return out;
}

/**
 * Tab width used by both the wrapper and the rendered code.
 *
 * Keep this in sync with `tab-size` in `CodeLine.svelte`. If the two disagree,
 * wrapping either leaves indentation hanging past the pane edge or breaks the
 * line before the visible text needs it.
 */
export const TAB_COLUMNS = 8;

/** True for code points rendered two monospace cells wide. */
function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

/** Combining marks and format controls add no advance of their own. */
const ZERO_WIDTH = /^[\p{Mark}\p{Cf}]$/u;

function codePointColumns(char: string, column: number): number {
  if (char === "\t") return TAB_COLUMNS - (column % TAB_COLUMNS);
  if (ZERO_WIDTH.test(char)) return 0;
  return isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
}

/**
 * Visual width of one logical line, in monospace columns.
 *
 * A tab is measured from the current column, exactly as CSS renders it, so two
 * otherwise equal lines with different indentation still wrap at the same point.
 */
export function displayWidth(text: string, tabSize = TAB_COLUMNS): number {
  let column = 0;
  for (const char of text) {
    if (char === "\t") column += tabSize - (column % tabSize);
    else if (!ZERO_WIDTH.test(char)) {
      column += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
    }
  }
  return column;
}

/**
 * Slice a line by display columns.
 *
 * Returned offsets are UTF-16 indices for `String.slice`, because tokens and
 * inline segments use the same coordinate system. A wide glyph never straddles a
 * boundary: it belongs to the first slice in which it starts.
 */
export function sliceAtColumns(
  text: string,
  startColumn: number,
  endColumn: number,
  tabSize = TAB_COLUMNS,
): { start: number; end: number; text: string } {
  const start = Math.max(0, startColumn);
  const end = Math.max(start, endColumn);
  let column = 0;
  let index = 0;
  let from = -1;
  let to = -1;

  while (index < text.length) {
    if (from === -1 && column >= start) from = index;
    if (column >= end) break;

    const codePoint = text.codePointAt(index) ?? 0;
    const units = codePoint > 0xffff ? 2 : 1;
    const char = text.slice(index, index + units);
    to = index + units;
    column += char === "\t" ? tabSize - (column % tabSize) : codePointColumns(char, column);
    index += units;
  }

  if (from === -1) from = text.length;
  if (to === -1 || to < from) to = from;
  return { start: from, end: to, text: text.slice(from, to) };
}

/**
 * Narrowest column count worth wrapping to.
 *
 * Below roughly 24 monospace characters a code line is mostly continuation
 * markers, and the gutter plus padding already eats much of a narrow pane; at that
 * point horizontal scrolling is the lesser annoyance.
 */
export const MIN_WRAP_COLUMNS = 24;

/**
 * Vertical mapping for the minimap.
 *
 * The strip is as tall as the pane, but a short document does not fill the pane.
 * Scaling `count` rows across the full strip therefore stretches them: a 20-line
 * file in a 771px pane put its changes near the middle of the axis while the eye
 * saw them in the top fifth of the pane, so the map and the code disagreed about
 * where a change was.
 *
 * Taking the larger of the row count and the rows the pane can hold fixes that:
 *
 *   - a document taller than the pane keeps the fully-utilised mapping;
 *   - a short document maps 1:1 in pixels, leaving the area below it blank on the
 *     strip exactly as it is blank in the pane.
 *
 * `unit` is the pixel height of one row on the strip; `usedHeight` is how much of
 * the strip the document occupies. The viewport band and the change ticks must
 * both use these, or they drift apart.
 */
export function minimapScale(
  count: number,
  mapHeight: number,
  rowHeight: number,
  clientHeight: number,
): { unit: number; usedHeight: number } {
  // A zero row height would make `rowsVisible` infinite; guard rather than trust.
  const rowH = Math.max(1, rowHeight);
  const rowsVisible = Math.max(1, clientHeight / rowH);
  const span = Math.max(count, rowsVisible);
  const unit = span > 0 ? mapHeight / span : 0;
  return { unit, usedHeight: count * unit };
}
