/**
 * Lazy line index for one side of a comparison.
 *
 * ## Why not `string[]`
 *
 * `String.prototype.split("\n")` materialises one JS string per line. For a
 * 16 MiB / 200,000-line document that is 200,000 string objects (plus the text
 * they copy), retained for the whole life of the comparison even though the
 * virtual scroller only ever reads the ~40 lines on screen. The index below keeps
 * one `Int32Array` of line *start offsets* into the original string — about
 * 0.8 MB for the largest accepted document — and slices a line only when a
 * renderer, a search or a wrap pass asks for it.
 *
 * The returned strings are ordinary slices; the difference is that they are not
 * retained by the index, so the steady-state cost is the offset array, not the
 * whole document duplicated as strings.
 *
 * ## Semantics
 *
 * These mirror the Rust `SourceText` line model exactly, because row/line
 * indices cross the IPC boundary and a disagreement shows up as off-by-one
 * gutter numbers:
 *
 * * an empty document has zero lines;
 * * a trailing terminator does not produce a phantom final line;
 * * `\r\n` terminates a line and the `\r` is not part of its content;
 * * a lone `\r` is content.
 */

/** Read-only, index-based view of one document's lines. */
export interface LineIndex {
  /** Number of lines, matching the Rust line count for the same text. */
  readonly length: number;
  /** Content of one line, terminator excluded. Out-of-range returns `""`. */
  text(index: number): string;
}

/** Shared empty index: the paste screen and the "no comparison" state. */
export const EMPTY_LINES: LineIndex = {
  length: 0,
  text: () => "",
};

/** Build the line index for a document. Cost: one scan, no per-line strings. */
export function lineIndex(text: string): LineIndex {
  if (text.length === 0) return EMPTY_LINES;

  // Count first so the offset array is allocated exactly once. Scanning twice is
  // still cheaper than growing an array 200k times, and it allocates nothing.
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  // A trailing "\n" terminates the final line instead of starting a phantom one.
  if (text.charCodeAt(text.length - 1) === 10) count--;

  const starts = new Int32Array(count);
  let line = 1;
  for (let i = 0; line < count && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts[line++] = i + 1;
  }
  // `count` is derived from the same scan, but a defensive clamp keeps a corrupt
  // input from producing an index whose first entry is not zero.
  if (starts.length === 0) starts[0] = 0;

  const lastEnd = text.charCodeAt(text.length - 1) === 10 ? text.length - 1 : text.length;

  /*
   * One-entry slice cache.
   *
   * Normal documents re-read a line a handful of times at most, but a pathological
   * document — a single 16 MiB minified JSON line, say — would otherwise allocate a
   * fresh multi-megabyte string on every repaint. The cache holds at most one line
   * (the last one requested), so the retention bound is a single line, not the
   * document; for the pathological case that equals what the old `splitLines`
   * array kept permanently.
   */
  let cachedIndex = -1;
  let cachedText = "";

  return {
    length: count,
    text(index: number): string {
      if (index < 0 || index >= count) return "";
      if (index === cachedIndex) return cachedText;
      const start = starts[index];
      const end = index === count - 1 ? lastEnd : starts[index + 1] - 1;
      const trimmed = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
      const line = trimmed <= start ? "" : text.slice(start, trimmed);
      cachedIndex = index;
      cachedText = line;
      return line;
    },
  };
}

/** Text of line `index`, tolerating `null`/out-of-range as an empty line. */
export function lineText(lines: LineIndex, index: number | null): string {
  return index === null || index < 0 ? "" : lines.text(index);
}
