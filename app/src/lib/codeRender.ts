import type { ChangedSpan } from "./diffView";
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

/** Changed spans clipped to the visible text; `null` when there are none. */
function changedSpans(text: string, changed: readonly ChangedSpan[]): StyleSpan[] | null {
  const out: StyleSpan[] = [];
  for (const span of changed) {
    const start = Math.max(0, span.start);
    const end = Math.min(text.length, span.end);
    if (end > start) out.push({ start, end, changed: true, kind: "plain" });
  }
  return out.length === 0 ? null : out;
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
 * `text` is the single source of truth. Two styling sources are possible, and
 * they are mutually exclusive:
 *
 * * `changed` — character ranges the backend reported as modified. When present
 *   they win, because the reader is comparing two nearly identical lines and the
 *   pills showing *which character* changed carry more information than colouring
 *   a keyword. How a gap between two ranges is styled is "plain"; it is not a
 *   token-coloured region, exactly as before.
 * * syntax `tokens` — used when the row has no character-level information
 *   (equal/insert/delete rows, or a modify row produced with intra-line diffing
 *   switched off).
 *
 * Both inputs are offsets into `text`; anything out of range is clamped rather
 * than trusted.
 */
export function buildCodePieces(
  text: string,
  changed: readonly ChangedSpan[],
  tokens: readonly Token[],
  search: readonly SearchSlice[] = [],
): CodePiece[] {
  if (text.length === 0) return [];

  const changedStyles = changedSpans(text, changed);
  const styles = changedStyles ?? tokenSpans(text, tokens);

  const boundaries = new Set<number>([0, text.length]);
  if (styles !== null) {
    for (const span of styles) {
      boundaries.add(span.start);
      boundaries.add(span.end);
    }
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

    let changedHere = false;
    let kind: TokenKind = "plain";
    if (styles !== null) {
      while (styleIndex < styles.length && styles[styleIndex].end <= start) styleIndex++;
      const style = styles[styleIndex];
      if (style && style.start <= start && style.end >= end) {
        changedHere = style.changed;
        kind = style.kind;
      }
    }

    const piece: CodePiece = {
      text: text.slice(start, end),
      changed: changedHere,
      kind,
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
