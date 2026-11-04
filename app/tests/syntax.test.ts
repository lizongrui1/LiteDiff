import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_STATE,
  detectLanguage,
  highlightLine,
  highlightLines,
  lineStates,
  type Language,
  type Token,
} from "../src/lib/syntax.ts";

/*
 * Syntax tokenizer.
 *
 * The rules that matter are the ones a wrong answer would make *unreadable*: a
 * string that swallows the rest of the line, a block comment that ends too early,
 * a keyword colour leaking into an identifier. Colour choice is subjective; these
 * are not.
 */

const lex = (line: string, lang: Language = "go", state = INITIAL_STATE): Token[] =>
  highlightLine(line, lang, state).tokens;

/** Reassemble the tokens, which must always equal the input exactly. */
const rebuild = (tokens: Token[]): string => tokens.map((t) => t.text).join("");

/** Tokens of one kind, for assertions that do not care about adjacency. */
const of = (tokens: Token[], kind: Token["kind"]): string[] =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text);

// --- losslessness -----------------------------------------------------------
//
// The first duty of the tokenizer is to not lose text: this is a diff view, and a
// dropped character would make two sides look different when they are the same.

test("tokens always reassemble to the original line", () => {
  const samples = [
    'package main',
    'func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {',
    'x := "a\\"b" // trailing',
    '/* block */ y := 1',
    '\tif err != nil {',
    'const s = `raw "string"`',
    'var m = map[string]int{"a": 1}',
    '',
    '   ',
    '// 中文注释 with "quotes"',
  ];
  for (const line of samples) {
    assert.equal(rebuild(lex(line)), line, `lost text in ${JSON.stringify(line)}`);
  }
});

// --- keywords and identifiers ----------------------------------------------

test("Go keywords are coloured, identifiers are not", () => {
  const tokens = lex("func main() {");
  assert.deepEqual(of(tokens, "keyword"), ["func"]);
  // `main` is a call, not a keyword.
  assert.deepEqual(of(tokens, "function"), ["main"]);
});

test("a keyword used as a field is still one token of plain text", () => {
  // `range` inside an identifier must not become a keyword.
  const tokens = lex("x := arranger.Value");
  assert.deepEqual(of(tokens, "keyword"), []);
});

test("the same word is a keyword in one language and not another", () => {
  // `type` is a Go keyword; in Python it is just a name.
  assert.deepEqual(of(lex("type Foo struct{}", "go"), "keyword"), ["type", "struct"]);
  assert.deepEqual(of(lex("type = 1", "python"), "keyword"), []);
});

// --- strings ----------------------------------------------------------------

test("a string is one token, including its delimiters", () => {
  const tokens = lex('x := "hello"');
  assert.deepEqual(of(tokens, "string"), ['"hello"']);
});

test("an escaped quote does not end the string", () => {
  const tokens = lex('x := "a\\"b" + y');
  assert.deepEqual(of(tokens, "string"), ['"a\\"b"']);
});

test("an unterminated string runs to the end of the line", () => {
  const tokens = lex('x := "unterminated');
  assert.deepEqual(of(tokens, "string"), ['"unterminated']);
  assert.equal(rebuild(tokens), 'x := "unterminated');
});

test("a Go raw string keeps its internal quotes", () => {
  const tokens = lex('q := `a "b" c`');
  assert.deepEqual(of(tokens, "string"), ['`a "b" c`']);
});

test("a comment marker inside a string is not a comment", () => {
  const tokens = lex('url := "http://example.com"');
  assert.deepEqual(of(tokens, "comment"), []);
  assert.deepEqual(of(tokens, "string"), ['"http://example.com"']);
});

// --- comments ---------------------------------------------------------------

test("a line comment runs to the end of the line", () => {
  const tokens = lex("x := 1 // note: \"quoted\"");
  assert.deepEqual(of(tokens, "comment"), ['// note: "quoted"']);
  assert.deepEqual(of(tokens, "string"), []);
});

test("a single-line block comment is one token", () => {
  const tokens = lex("/* hi */ x := 1");
  assert.deepEqual(of(tokens, "comment"), ["/* hi */"]);
});

// --- multi-line state -------------------------------------------------------

test("a block comment carries to the next line and closes where it should", () => {
  const first = highlightLine("x := 1 /* start", "go", INITIAL_STATE);
  assert.deepEqual(of(first.tokens, "comment"), ["/* start"]);
  assert.equal(first.state.blockComment, true);

  const second = highlightLine("still comment", "go", first.state);
  assert.deepEqual(of(second.tokens, "comment"), ["still comment"]);
  assert.equal(second.state.blockComment, true);

  const third = highlightLine("end */ y := 2", "go", second.state);
  assert.deepEqual(of(third.tokens, "comment"), ["end */"]);
  assert.equal(third.state.blockComment, false);
  assert.deepEqual(of(third.tokens, "number"), ["2"]);
});

test("a python docstring carries across lines", () => {
  const first = highlightLine('    """Doc line one', "python", INITIAL_STATE);
  assert.equal(first.state.stringDelimiter, '"""');
  const second = highlightLine('    still inside', "python", first.state);
  assert.deepEqual(of(second.tokens, "string"), ["    still inside"]);
  const third = highlightLine('    end"""', "python", second.state);
  assert.equal(third.state.stringDelimiter, null);
});

test("highlightLines threads the state and lineStates prepares a window", () => {
  const doc = ["/* start", "middle", "end */", "x := 1"];
  const states = lineStates(doc, "go");
  assert.equal(states[0].blockComment, false);
  assert.equal(states[1].blockComment, true, "inside the comment");
  assert.equal(states[3].blockComment, false, "after it closed");

  // Starting mid-document with the prepared state gives the same answer.
  const window = highlightLines(doc.slice(1), "go", states[1]);
  assert.deepEqual(of(window[0].tokens, "comment"), ["middle"]);
  assert.deepEqual(of(window[2].tokens, "number"), ["1"]);
});

// --- numbers ----------------------------------------------------------------

test("numbers are one token, including hex and exponents", () => {
  assert.deepEqual(of(lex("x := 0x1f"), "number"), ["0x1f"]);
  assert.deepEqual(of(lex("y := 1.5e-3"), "number"), ["1.5e-3"]);
  assert.deepEqual(of(lex("n := 42"), "number"), ["42"]);
});

// --- JSON -------------------------------------------------------------------

test("JSON keys, strings, numbers and literals are distinguished", () => {
  const tokens = lex('  "name": "value", "n": 12, "ok": true', "json");
  assert.deepEqual(of(tokens, "string"), ['"name"', '"value"', '"n"', '"ok"']);
  assert.deepEqual(of(tokens, "number"), ["12"]);
  assert.deepEqual(of(tokens, "keyword"), ["true"]);
  assert.equal(rebuild(tokens), '  "name": "value", "n": 12, "ok": true');
});

// --- language detection -----------------------------------------------------

test("a file extension decides the language", () => {
  assert.equal(detectLanguage("runner.go", ""), "go");
  assert.equal(detectLanguage("a.json", ""), "json");
  assert.equal(detectLanguage("x.py", ""), "python");
  assert.equal(detectLanguage("A.TS", ""), "typescript");
  assert.equal(detectLanguage("notes.md", ""), "markdown");
});

test("a pasted block is recognised from its content", () => {
  // The common case in this app: no filename at all.
  assert.equal(
    detectLanguage(null, "package agents\n\nimport (\n\t\"context\"\n)\n\nfunc Run() {}"),
    "go",
  );
  assert.equal(detectLanguage(null, '{\n  "a": 1\n}'), "json");
  assert.equal(detectLanguage(null, "def hello():\n    return 1"), "python");
  assert.equal(detectLanguage(null, "fn main() {\n    let mut x = 1;\n}"), "rust");
});

test("an unknown file is plain, not guessed", () => {
  // Wrong colours are worse than none: they imply structure that is not there.
  assert.equal(detectLanguage("data.bin", "\x00\x01binary"), "plain");
  assert.equal(detectLanguage("", "just some prose about nothing"), "plain");
});

test("plain text is returned untouched as one token", () => {
  const tokens = lex("func main() { // not highlighted", "plain");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].kind, "plain");
  assert.equal(rebuild(tokens), "func main() { // not highlighted");
});

test("an empty line produces no tokens", () => {
  assert.deepEqual(lex(""), []);
});

// --- contrast ---------------------------------------------------------------
//
// A token colour exists to be read. These are the palette's own values, asserted
// here because the tokenizer choosing the right kind is worthless if the colour it
// maps to is invisible — and a hand-picked palette drifts the moment someone
// "brightens" a hue.

import { buildPalette } from "../src/lib/theme.ts";

/** WCAG relative luminance. */
function luminance(color: string): number {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color.trim());
  let rgb: number[];
  if (hex) {
    rgb = [1, 2, 3].map((i) => parseInt(hex[i], 16));
  } else {
    const parts = /rgba?\(([^)]+)\)/.exec(color.trim());
    if (!parts) throw new Error(`unsupported colour: ${color}`);
    rgb = parts[1].split(",").slice(0, 3).map((v) => parseFloat(v));
  }
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/** Blend an `rgba()` colour over an opaque background. */
function over(color: string, background: string): string {
  const parts = /rgba?\(([^)]+)\)/.exec(color.trim());
  if (!parts) return color;
  const [r, g, b, a = "1"] = parts[1].split(",").map((v) => parseFloat(v));
  const bg = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(background.trim());
  if (!bg) throw new Error(`unsupported background: ${background}`);
  const base = [1, 2, 3].map((i) => parseInt(bg[i], 16));
  const mix = [r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a)));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(over(fg, bg));
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const SYNTAX_ROLES = [
  "syntaxKeyword",
  "syntaxType",
  "syntaxFunction",
  "syntaxString",
  "syntaxNumber",
  "syntaxComment",
] as const;

for (const isDark of [false, true]) {
  const palette = buildPalette(isDark);
  const bg = palette.bg;

  test(`every syntax colour is legible on the ${isDark ? "dark" : "light"} pane`, () => {
    // 4.5:1 is the WCAG AA threshold for body text. Code is body text here.
    for (const role of SYNTAX_ROLES) {
      const ratio = contrast(palette[role], bg);
      assert.ok(ratio >= 4.5, `${role} is ${ratio.toFixed(2)}:1 on ${bg}`);
    }
  });
}

test("syntax colours do not collide with the change tints", () => {
  /*
   * The add/remove hues carry the actual information in a diff, so no token may use
   * them: a string that looks like an insertion is worse than no colour at all.
   * Compared by hue distance rather than by exact value, because the tints are
   * alpha-composited and the tokens are solid.
   */
  const palette = buildPalette(false);
  const hueOf = (color: string): number => {
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
    if (!hex) return -1;
    const [r, g, b] = [1, 2, 3].map((i) => parseInt(hex[i], 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  // The rose/green pair from the visual spec.
  const delHue = hueOf("#f43f5e");
  const insHue = hueOf("#22c55e");
  const tooClose = (a: number, b: number): boolean => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d) < 20;
  };

  for (const role of ["syntaxString", "syntaxFunction", "syntaxNumber"] as const) {
    const hue = hueOf(palette[role]);
    assert.ok(
      !tooClose(hue, delHue),
      `${role} (hue ${hue}) is indistinguishable from the delete tint`,
    );
    assert.ok(
      !tooClose(hue, insHue),
      `${role} (hue ${hue}) is indistinguishable from the insert tint`,
    );
  }
});
