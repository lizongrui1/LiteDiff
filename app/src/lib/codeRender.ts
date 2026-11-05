import type { InlineSegment } from "./types";
import type { Token, TokenKind } from "./syntax";
import type { SearchSlice } from "./search";

export interface CodePiece {
  text: string;
  changed: boolean;
  kind: TokenKind;
  search: "none" | "hit" | "current";
}

interface StyleSpan {
  start: number;
  end: number;
  changed: boolean;
  kind: TokenKind;
}

function inlineSpans(text: string, segments: readonly InlineSegment[]): StyleSpan[] | null {
  if (segments.length === 0 || segments.map((segment) => segment.text).join("") !== text) {
    return null;
  }

  const out: StyleSpan[] = [];
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    if (end > offset) {
      out.push({ start: offset, end, changed: segment.changed, kind: "plain" });
    }
    offset = end;
  }
  return out;
}

function tokenSpans(text: string, tokens: readonly Token[]): StyleSpan[] | null {
  if (tokens.length === 0 || tokens.map((token) => token.text).join("") !== text) {
    return null;
  }

  const out: StyleSpan[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    if (end > offset) {
      out.push({ start: offset, end, changed: false, kind: token.kind });
    }
    offset = end;
  }
  return out;
}

function searchAt(slices: readonly SearchSlice[], start: number, end: number): CodePiece["search"] {
  let hit = false;
  for (const slice of slices) {
    if (slice.start <= start && slice.end >= end) {
      if (slice.current) return "current";
      hit = true;
    }
  }
  return hit ? "hit" : "none";
}

/**
 * Build the exact text nodes for one rendered code line.
 *
 * `text` is the single source of truth. Inline segments and syntax tokens only
 * add styling when their concatenation exactly matches `text`; otherwise they
 * are ignored. That validation is essential for wrapped lines: a stale or
 * over-long style span used to make several continuation rows repeat the whole
 * logical line instead of their own slice.
 */
export function buildCodePieces(
  text: string,
  segments: readonly InlineSegment[],
  tokens: readonly Token[],
  search: readonly SearchSlice[] = [],
): CodePiece[] {
  if (text.length === 0) return [];

  const styles =
    inlineSpans(text, segments) ??
    tokenSpans(text, tokens) ??
    [{ start: 0, end: text.length, changed: false, kind: "plain" as const }];

  const boundaries = new Set<number>([0, text.length]);
  for (const span of styles) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const slice of search) {
    boundaries.add(slice.start);
    boundaries.add(slice.end);
  }

  const points = [...boundaries]
    .filter((point) => point >= 0 && point <= text.length)
    .sort((a, b) => a - b);

  const out: CodePiece[] = [];
  let styleIndex = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;

    while (styleIndex < styles.length && styles[styleIndex].end <= start) styleIndex++;
    const style = styles[Math.min(styleIndex, styles.length - 1)];
    const piece: CodePiece = {
      text: text.slice(start, end),
      changed: style.start <= start && style.end >= end ? style.changed : false,
      kind: style.start <= start && style.end >= end ? style.kind : "plain",
      search: searchAt(search, start, end),
    };

    const previous = out[out.length - 1];
    if (
      previous &&
      previous.changed === piece.changed &&
      previous.kind === piece.kind &&
      previous.search === piece.search
    ) {
      previous.text += piece.text;
    } else {
      out.push(piece);
    }
  }
  return out;
}
