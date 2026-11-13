/**
 * Tests for the lazy line index.
 *
 * The index is the only reader of document text when rendering, searching or
 * wrapping, so it must reproduce the old `splitLines` semantics exactly — a
 * disagreement would shift every line number after a `\r\n` or a trailing
 * newline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_LINES, lineIndex, lineText } from "../src/lib/lines.ts";
import { splitLines } from "../src/lib/types.ts";

function assertMatchesSplit(text: string): void {
  const index = lineIndex(text);
  const expected = splitLines(text);
  assert.equal(index.length, expected.length, `line count for ${JSON.stringify(text)}`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(index.text(i), expected[i], `line ${i} for ${JSON.stringify(text)}`);
  }
  assert.equal(index.text(expected.length), "", "one past the end is empty");
  assert.equal(index.text(-1), "", "negative index is empty");
}

test("empty and single-line documents match splitLines", () => {
  assertMatchesSplit("");
  assertMatchesSplit("a");
  assert.equal(lineIndex("").length, 0);
  assert.equal(lineIndex("").text(0), "");
});

test("trailing newline does not produce a phantom line", () => {
  assertMatchesSplit("a\n");
  assertMatchesSplit("a\nb\n");
  assert.equal(lineIndex("a\nb\n").length, 2);
});

test("CRLF is normalised at the line boundary", () => {
  assertMatchesSplit("a\r\nb\r\n");
  assertMatchesSplit("a\r\nb");
  assert.equal(lineIndex("a\r\nb\r\n").text(0), "a");
  assert.equal(lineIndex("a\r\nb\r\n").text(1), "b");
});

test("a lone carriage return is content", () => {
  assertMatchesSplit("a\rb\nc");
  assert.equal(lineIndex("a\rb\nc").text(0), "a\rb");
  assertMatchesSplit("a\r\r\nb");
});

test("blank lines are preserved", () => {
  assertMatchesSplit("\n\n");
  assertMatchesSplit("a\n\nb\n");
  assert.equal(lineIndex("a\n\nb\n").text(1), "");
});

test("unicode content is sliced exactly", () => {
  assertMatchesSplit("你好\n😀 emoji\ncombining é");
  assert.equal(lineIndex("你好\n😀 emoji").text(1), "😀 emoji");
});

test("documents generated from longer text still match splitLines", () => {
  const parts: string[] = [];
  for (let i = 0; i < 500; i++) {
    parts.push(`${i % 7 === 0 ? "" : "  "}line ${i} ${i % 3 === 0 ? "with\ttab" : ""}\r`);
  }
  assertMatchesSplit(parts.join("\n"));
});

test("lineText tolerates a missing line", () => {
  const index = lineIndex("only");
  assert.equal(lineText(index, null), "");
  assert.equal(lineText(index, -2), "");
  assert.equal(lineText(index, 0), "only");
  assert.equal(lineText(EMPTY_LINES, 0), "");
});
