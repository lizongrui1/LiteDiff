import type { LineIndex } from "./lines";
import { lineText } from "./lines";
import { lineAt, type DiffTable } from "./diffView";
import type { DisplayItem, UnifiedItem } from "./viewport";

export type SearchSide = "left" | "right" | "both";

/** One occurrence of the query in the comparison. */
export interface SearchHit {
  /** Source row in the aligned diff. */
  row: number;
  /** Which pane(s) contain the occurrence. */
  side: SearchSide;
  /** UTF-16 offsets within the logical source line. */
  start: number;
  end: number;
  /** One-based source line number for the hit's pane. */
  line: number;
}

/** Search state shared by both diff views. */
export interface SearchViewState {
  hitsByRow: ReadonlyMap<number, SearchHit[]>;
  active: SearchHit | null;
}

/** A hit clipped to one wrapped slice and made relative to that slice. */
export interface SearchSlice {
  start: number;
  end: number;
  current: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Upper bound keeps a one-character query in a huge file from freezing the UI. */
export const MAX_SEARCH_HITS = 50_000;

function forEachMatch(
  text: string,
  pattern: RegExp,
  limit: number,
  visit: (start: number, end: number) => void,
): void {
  if (text.length === 0 || limit <= 0) return;
  pattern.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while (count < limit && (match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    count++;
    visit(match.index, match.index + match[0].length);
  }
}

/** Literal query matches, ordered by position. Empty queries match nothing. */
export function findTextMatches(
  text: string,
  query: string,
  caseSensitive = false,
): Array<{ start: number; end: number }> {
  if (query.length === 0 || text.length === 0) return [];
  const pattern = new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi");
  const out: Array<{ start: number; end: number }> = [];
  forEachMatch(text, pattern, MAX_SEARCH_HITS, (start, end) => {
    out.push({ start, end });
  });
  return out;
}

/**
 * Search both documents in aligned-row order.
 *
 * Equal rows with byte-identical text produce one hit scoped to both panes, so
 * the result counter does not report every unchanged match twice. Modified rows
 * are searched independently because the two sides really are different text.
 */
export function findSearchHits(
  rows: DiffTable,
  leftLines: LineIndex,
  rightLines: LineIndex,
  query: string,
  caseSensitive = false,
): SearchHit[] {
  if (query.length === 0) return [];

  const out: SearchHit[] = [];
  const pattern = new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi");
  for (let row = 0; row < rows.length; row++) {
    const leftLine = lineAt(rows, row, "left");
    const rightLine = lineAt(rows, row, "right");
    const leftText = lineText(leftLines, leftLine);
    const rightText = lineText(rightLines, rightLine);

    if (rows.kindAt(row) === "equal" && leftLine !== null && rightLine !== null && leftText === rightText) {
      forEachMatch(leftText, pattern, MAX_SEARCH_HITS - out.length, (start, end) => {
        out.push({ row, side: "both", start, end, line: leftLine + 1 });
      });
      if (out.length >= MAX_SEARCH_HITS) return out;
      continue;
    }

    if (leftLine !== null) {
      forEachMatch(leftText, pattern, MAX_SEARCH_HITS - out.length, (start, end) => {
        out.push({ row, side: "left", start, end, line: leftLine + 1 });
      });
      if (out.length >= MAX_SEARCH_HITS) return out;
    }
    if (rightLine !== null) {
      forEachMatch(rightText, pattern, MAX_SEARCH_HITS - out.length, (start, end) => {
        out.push({ row, side: "right", start, end, line: rightLine + 1 });
      });
      if (out.length >= MAX_SEARCH_HITS) return out;
    }
  }
  return out;
}

/** Group hits by aligned row, preserving left-to-right order. */
export function groupSearchHits(hits: readonly SearchHit[]): Map<number, SearchHit[]> {
  const out = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const bucket = out.get(hit.row);
    if (bucket) bucket.push(hit);
    else out.set(hit.row, [hit]);
  }
  return out;
}

function appliesToSide(hit: SearchHit, side: "left" | "right"): boolean {
  return hit.side === "both" || hit.side === side;
}

function overlapsHit(
  range: { start: number; end: number },
  hit: SearchHit,
): boolean {
  return hit.start < range.end && hit.end > range.start;
}

/**
 * Split-view display index whose physical wrap slice contains a search hit.
 *
 * Row-based navigation stops at the first slice of a long wrapped line. A match
 * later in that line can therefore scroll "correctly" while remaining above the
 * viewport. This resolves the exact aligned physical row instead.
 */
export function splitDisplayIndexForHit(
  items: readonly DisplayItem[],
  hit: SearchHit,
): number | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.fold !== null || item.row !== hit.row) continue;

    if (item.splitWrap) {
      const preferred =
        hit.side === "right"
          ? [item.splitWrap.right]
          : hit.side === "left"
            ? [item.splitWrap.left]
            : [item.splitWrap.left, item.splitWrap.right];
      if (preferred.some((range) => range !== null && overlapsHit(range, hit))) {
        return i;
      }
      continue;
    }

    // Unwrapped rows have no range, but their display item is the whole line.
    return i;
  }
  return null;
}

/** Unified-view display index whose physical wrap slice contains a search hit. */
export function unifiedDisplayIndexForHit(
  items: readonly UnifiedItem[],
  hit: SearchHit,
): number | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.fold !== null || item.sourceRow !== hit.row) continue;
    if (!appliesToSide(hit, item.side)) continue;

    if (item.wrap) {
      if (overlapsHit(item.wrap, hit)) return i;
      continue;
    }
    return i;
  }
  return null;
}

/**
 * Clip row hits to one physical wrapped slice.
 *
 * A match may straddle a wrap boundary. Both resulting pieces are highlighted;
 * only the occurrence itself remains the navigation target.
 */
export function searchSlicesFor(
  hits: readonly SearchHit[],
  side: "left" | "right",
  sliceStart: number,
  sliceEnd: number,
  active: SearchHit | null,
): SearchSlice[] {
  const out: SearchSlice[] = [];
  for (const hit of hits) {
    if (!appliesToSide(hit, side)) continue;
    if (hit.end <= sliceStart || hit.start >= sliceEnd) continue;
    out.push({
      start: Math.max(hit.start, sliceStart) - sliceStart,
      end: Math.min(hit.end, sliceEnd) - sliceStart,
      current:
        active !== null &&
        active.row === hit.row &&
        active.start === hit.start &&
        active.end === hit.end &&
        appliesToSide(active, side),
    });
  }
  return out;
}
