/**
 * Syntax highlighting.
 *
 * ## Why hand-rolled
 *
 * The obvious answer is highlight.js or Prism, and both are wrong for this app.
 * They are 100-300 KB minified for the language set worth having, they are third-
 * party dependencies in a project that keeps its own core dependency-free, and —
 * the deciding reason — they are designed to tokenise a *whole document*. This
 * view paints a window of ~40 lines out of thousands, so every keystroke would
 * re-tokenise a file the reader is not looking at.
 *
 * What the view actually needs is far smaller: colour a line at a time, understand
 * enough of a handful of languages to be useful, and never be wrong in a way that
 * hides code. That is what this module does, in ~400 lines and zero bytes of
 * dependency.
 *
 * ## Line-at-a-time, and the state it carries
 *
 * Highlights are computed per line, because a virtual scroller renders lines
 * independently and out of order. That is fine for everything except constructs
 * that span lines — a block comment, a raw string, a Python triple-quoted string —
 * so the tokenizer returns the state it ended in and accepts it as input. The
 * caller threads that state down the visible run (see `highlightLines`); a line
 * rendered on its own with a missing state degrades to "not inside anything",
 * which can mis-colour a comment but never drop a character.
 *
 * ## What is deliberately not attempted
 *
 * No parse tree. A tokenizer that guesses at structure gets strings inside
 * comments wrong, and a diff view is exactly where that is unforgivable: the
 * reader is comparing text character by character. The rules here are lexical —
 * comments, strings, numbers, identifiers against a keyword set — and an
 * identifier that is not a keyword stays plain, which is always readable.
 */

/** What a span of text is. Drives one colour token each. */
export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "function"
  | "punctuation";

/** One coloured run of a single line. */
export interface Token {
  kind: TokenKind;
  text: string;
}

/** Tokenizer state carried from one line to the next. */
export interface LexState {
  /** True while inside a block comment that has not been closed yet. */
  blockComment: boolean;
  /** Inside a multi-line string, with the delimiter that closes it. */
  stringDelimiter: string | null;
}

export const INITIAL_STATE: LexState = { blockComment: false, stringDelimiter: null };

/** Languages this module knows how to colour, plus the fallback. */
export type Language =
  | "go"
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "java"
  | "c"
  | "json"
  | "yaml"
  | "shell"
  | "sql"
  | "css"
  | "html"
  | "markdown"
  | "plain";

/**
 * Keyword sets.
 *
 * Deliberately short: a word that is a keyword in one dialect and an identifier in
 * another (Go's `type` vs. a variable named `type`) is more jarring coloured wrong
 * than left plain, so each list holds only what is unambiguous for that language.
 */
const KEYWORDS: Record<string, readonly string[]> = {
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ],
  javascript: [
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "export", "extends", "finally",
    "for", "function", "if", "import", "in", "instanceof", "let", "new", "of",
    "return", "static", "super", "switch", "this", "throw", "try", "typeof", "var",
    "void", "while", "yield",
  ],
  python: [
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
    "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
    "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield",
  ],
  rust: [
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
    "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
    "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
  ],
  java: [
    "abstract", "assert", "break", "case", "catch", "class", "const", "continue",
    "default", "do", "else", "enum", "extends", "final", "finally", "for", "if",
    "implements", "import", "instanceof", "interface", "native", "new", "package",
    "private", "protected", "public", "return", "static", "strictfp", "super",
    "switch", "synchronized", "this", "throw", "throws", "transient", "try",
    "volatile", "while",
  ],
  shell: [
    "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if",
    "in", "select", "then", "until", "while",
  ],
  sql: [
    "ADD", "ALTER", "AND", "AS", "ASC", "BETWEEN", "BY", "CREATE", "DELETE", "DESC",
    "DISTINCT", "DROP", "FROM", "GROUP", "HAVING", "IN", "INDEX", "INNER", "INSERT",
    "INTO", "JOIN", "LEFT", "LIMIT", "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER",
    "OUTER", "PRIMARY", "RIGHT", "SELECT", "SET", "TABLE", "UPDATE", "VALUES", "WHERE",
  ],
};

/** Built-in type / constant names, coloured separately from keywords. */
const TYPES: Record<string, readonly string[]> = {
  go: [
    "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
    "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
    "uint16", "uint32", "uint64", "uintptr", "any", "nil", "true", "false", "iota",
  ],
  javascript: ["true", "false", "null", "undefined", "NaN", "Infinity", "bigint", "symbol"],
  python: ["True", "False", "None", "self", "cls"],
  rust: ["bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize",
    "str", "u8", "u16", "u32", "u64", "u128", "usize", "String", "Vec", "Option",
    "Result", "Some", "None", "Ok", "Err"],
  java: ["boolean", "byte", "char", "double", "float", "int", "long", "short",
    "void", "true", "false", "null"],
  sql: ["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST", "CASE", "WHEN", "THEN", "END"],
};

/** Multi-line string delimiters, and whether they nest/interpolate. */
interface StringRule {
  /** Opening delimiter. */
  open: string;
  /** Closing delimiter. */
  close: string;
  /** True when a backslash escapes the next character. */
  escape: boolean;
}

/**
 * String rules per language, tried in order.
 *
 * Longest-first matters: `"""` must be tested before `"`, or a Python docstring
 * would tokenise as an empty string followed by a mess.
 */
const STRINGS: Record<string, readonly StringRule[]> = {
  go: [{ open: "`", close: "`", escape: false }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  javascript: [{ open: "`", close: "`", escape: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  python: [
    { open: '"""', close: '"""', escape: true },
    { open: "'''", close: "'''", escape: true },
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'", escape: true },
  ],
  rust: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  java: [{ open: '"""', close: '"""', escape: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  c: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  shell: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: false }],
  sql: [{ open: "'", close: "'", escape: false }],
  json: [{ open: '"', close: '"', escape: true }],
  css: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  html: [{ open: '"', close: '"', escape: false }, { open: "'", close: "'", escape: false }],
};

/** Line-comment markers, longest-first so `//` wins over `/`. */
const LINE_COMMENTS: Record<string, readonly string[]> = {
  go: ["//"],
  javascript: ["//"],
  python: ["#"],
  rust: ["//"],
  java: ["//"],
  c: ["//"],
  shell: ["#"],
  sql: ["--"],
  yaml: ["#"],
  css: [],
  html: [],
};

/** Block-comment pairs. */
const BLOCK_COMMENTS: Record<string, { open: string; close: string }> = {
  go: { open: "/*", close: "*/" },
  javascript: { open: "/*", close: "*/" },
  rust: { open: "/*", close: "*/" },
  java: { open: "/*", close: "*/" },
  c: { open: "/*", close: "*/" },
  css: { open: "/*", close: "*/" },
  sql: { open: "/*", close: "*/" },
  html: { open: "<!--", close: "-->" },
};

/** Characters that end an identifier in every language supported here. */
function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$@]/.test(ch);
}

function isIdent(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Guess the language from a filename, or from the content when there is no name.
 *
 * The name wins when present: `foo.go` is conclusive, while content sniffing has to
 * guess. The content heuristics are ordered by how distinctive the marker is.
 */
export function detectLanguage(fileName: string | null, text: string): Language {
  const name = (fileName ?? "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  switch (ext) {
    case "go":
      return "go";
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "java":
    case "kt":
    case "kts":
      return "java";
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "m":
    case "mm":
      return "c";
    case "json":
    case "jsonc":
      return "json";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "shell";
    case "sql":
      return "sql";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "vue":
      return "html";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    default:
      break;
  }

  /*
   * Content sniffing.
   *
   * Only for files with no useful extension — a pasted block has no name at all, and
   * that is the common case in this app. Each test is chosen because it cannot be
   * produced by the other languages listed.
   */
  const head = text.slice(0, 4000);
  if (/^\s*package\s+[A-Za-z_]\w*\s*$/m.test(head) && /\bfunc\s+\w+\s*\(/.test(head)) return "go";
  if (/^\s*\{[\s\S]*"\s*:/.test(head.trimStart())) return "json";
  // A `def`/`class` header ending in a colon is Python's most distinctive shape;
  // `import` alone is shared with half a dozen languages, so it is not required.
  if (/^\s*(def |class )\w+.*:\s*$/m.test(head)) return "python";
  if (/\bfn\s+\w+\s*\(/.test(head) && /\blet\s+mut\b|\bimpl\b/.test(head)) return "rust";
  if (/^\s*(#!\/.*\b(bash|sh)\b|\$\s|\w+=\S+$)/m.test(head) && !/\{\s*$/.test(head)) return "shell";
  if (/^\s*<!DOCTYPE html|<html[\s>]/i.test(head)) return "html";
  if (/^\s*(SELECT|INSERT|UPDATE|CREATE|WITH)\b/i.test(head)) return "sql";
  if (/^\s*[.#]?[a-zA-Z][\w-]*\s*\{[^}]*:[^}]*;/m.test(head)) return "css";
  if (/^\s*#{1,6}\s+\S/m.test(head) && /^\s*[-*]\s+\S/m.test(head)) return "markdown";
  return "plain";
}

/** Result of tokenising one line. */
export interface LineHighlight {
  tokens: Token[];
  /** State to pass to the next line. */
  state: LexState;
}

/**
 * Tokenise one line.
 *
 * `state` is the state the previous line ended in; pass {@link INITIAL_STATE} to
 * start. The returned state must be fed to the next line, or a block comment will
 * stop being one at the line break.
 */
export function highlightLine(raw: string, language: Language, state: LexState): LineHighlight {
  if (language === "plain" || raw === "") {
    return { tokens: raw === "" ? [] : [{ kind: "plain", text: raw }], state };
  }

  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    if (text === "") return;
    // Merge with the previous token of the same kind: fewer nodes, and a big plain
    // run stays one span instead of one span per identifier.
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
      return;
    }
    tokens.push({ kind, text });
  };

  const keywords = new Set(KEYWORDS[language] ?? []);
  const types = new Set(TYPES[language] ?? []);
  const lineComments = LINE_COMMENTS[language] ?? [];
  const block = BLOCK_COMMENTS[language];
  const strings = STRINGS[language] ?? [];
  const caseInsensitive = language === "sql";

  let i = 0;
  let blockComment = state.blockComment;
  let stringDelimiter = state.stringDelimiter;

  /** Close out a multi-line string that is still open, if this line ends it. */
  const resumeString = (): boolean => {
    if (stringDelimiter === null) return false;
    const rule = strings.find((r) => r.open === stringDelimiter);
    if (!rule) {
      stringDelimiter = null;
      return false;
    }
    let j = i;
    let end = -1;
    while (j < raw.length) {
      if (rule.escape && raw[j] === "\\") {
        j += 2;
        continue;
      }
      if (raw.startsWith(rule.close, j)) {
        end = j + rule.close.length;
        break;
      }
      j++;
    }
    if (end === -1) {
      push("string", raw.slice(i));
      i = raw.length;
      return true;
    }
    push("string", raw.slice(i, end));
    i = end;
    stringDelimiter = null;
    return true;
  };

  // Finish a block comment carried over from the previous line.
  if (blockComment && block) {
    const end = raw.indexOf(block.close, i);
    if (end === -1) {
      push("comment", raw);
      return { tokens, state: { blockComment: true, stringDelimiter: null } };
    }
    const stop = end + block.close.length;
    push("comment", raw.slice(0, stop));
    i = stop;
    blockComment = false;
  } else if (blockComment) {
    // A language without block comments should never carry the flag; drop it.
    blockComment = false;
  }

  if (resumeString()) {
    // A continued string may still be closed above; fall through to scan the rest.
  }

  while (i < raw.length) {
    const rest = raw.slice(i);
    const ch = raw[i];

    // Multi-line string still open: consume to its end or the line's end.
    if (stringDelimiter !== null && resumeString()) continue;

    // Line comment: everything to the end of the line.
    const lineMarker = lineComments.find((m) => rest.startsWith(m));
    if (lineMarker) {
      push("comment", rest);
      i = raw.length;
      break;
    }

    // Block comment opening.
    if (block && rest.startsWith(block.open)) {
      const end = raw.indexOf(block.close, i + block.open.length);
      if (end === -1) {
        push("comment", rest);
        blockComment = true;
        i = raw.length;
        break;
      }
      const stop = end + block.close.length;
      push("comment", raw.slice(i, stop));
      i = stop;
      continue;
    }

    // String opening (longest delimiter first).
    const rule = strings.find((r) => rest.startsWith(r.open));
    if (rule) {
      let j = i + rule.open.length;
      let closed = false;
      while (j < raw.length) {
        if (rule.escape && raw[j] === "\\") {
          j += 2;
          continue;
        }
        if (raw.startsWith(rule.close, j)) {
          j += rule.close.length;
          closed = true;
          break;
        }
        j++;
      }
      push("string", raw.slice(i, j));
      if (!closed && j >= raw.length) stringDelimiter = rule.open;
      i = j;
      continue;
    }

    // JSON keys: a string followed by `:` reads as a property, which is the only
    // structure JSON has. Colouring them is what makes a JSON diff scannable.
    if (language === "json") {
      if (isDigit(ch) || (ch === "-" && isDigit(raw[i + 1] ?? ""))) {
        let j = i + 1;
        while (j < raw.length && /[0-9.eE+-]/.test(raw[j])) j++;
        push("number", raw.slice(i, j));
        i = j;
        continue;
      }
      if (/^(true|false|null)\b/.test(rest)) {
        const word = /^(true|false|null)/.exec(rest)![0];
        push("keyword", word);
        i += word.length;
        continue;
      }
    }

    // Number.
    if (isDigit(ch) || (ch === "." && isDigit(raw[i + 1] ?? "") && !isIdent(raw[i - 1] ?? ""))) {
      let j = i + 1;
      while (j < raw.length && /[0-9a-fA-FxXoObB._eE+-]/.test(raw[j])) {
        // Stop at a minus that is not part of an exponent.
        if ((raw[j] === "+" || raw[j] === "-") && !/[eE]/.test(raw[j - 1])) break;
        j++;
      }
      push("number", raw.slice(i, j));
      i = j;
      continue;
    }

    // Identifier, keyword, type, or function call.
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < raw.length && isIdent(raw[j])) j++;
      const word = raw.slice(i, j);
      const probe = caseInsensitive ? word.toUpperCase() : word;

      if (keywords.has(caseInsensitive ? probe : word)) {
        push("keyword", word);
      } else if (types.has(caseInsensitive ? probe : word)) {
        push("type", word);
      } else {
        // A name followed by `(` is a call or definition.
        let k = j;
        while (k < raw.length && raw[k] === " ") k++;
        push(raw[k] === "(" ? "function" : "plain", word);
      }
      i = j;
      continue;
    }

    // Everything else: whitespace and punctuation, merged into one run.
    push("punctuation", ch);
    i++;
  }

  return { tokens, state: { blockComment, stringDelimiter } };
}

/**
 * Tokenise a run of lines, threading the multi-line state through them.
 *
 * This is what the callers use: the panes render a window of lines, so they hand
 * the window's first line the state produced by re-scanning from the top of the
 * file once, and each following line gets the previous line's result.
 *
 * `startState` is the state *entering* `lines[0]`.
 */
export function highlightLines(
  lines: readonly string[],
  language: Language,
  startState: LexState = INITIAL_STATE,
): LineHighlight[] {
  const out: LineHighlight[] = [];
  let state = startState;
  for (const line of lines) {
    const result = highlightLine(line, language, state);
    out.push(result);
    state = result.state;
  }
  return out;
}

/**
 * State entering every line of a document.
 *
 * A virtual scroller can jump into the middle of a file, so a window's first line
 * needs the state that thousands of preceding lines produced. Re-scanning the whole
 * document per frame would be wasteful, so callers cache this: it changes only when
 * the document does.
 *
 * O(n) once per document, with a tokenizer that is a single pass per line — this is
 * the same order as the diff itself and runs on the same data already in memory.
 */
export function lineStates(lines: readonly string[], language: Language): LexState[] {
  const states: LexState[] = [];
  let state = INITIAL_STATE;
  for (const line of lines) {
    states.push(state);
    state = highlightLine(line, language, state).state;
  }
  return states;
}

/**
 * Lazy access to one document's tokens.
 *
 * Highlighting a 20k-line file measures at ~70ms. That is fine once, but a diff
 * view re-runs on every option toggle, edit apply and tab switch, and 70ms of
 * main-thread work per re-diff is felt. A source hands out one line at a time, so
 * only the lines actually rendered are tokenised; the per-line multi-line states
 * still need one pass over the document, and that pass is cached against the array
 * the diff produced.
 */
export interface TokenSource {
  /** Tokens for one 0-based line, or empty for an out-of-range index. */
  get(lineIndex: number | null): Token[];
}

const tokenSourceCache = new WeakMap<
  readonly string[],
  Map<Language, TokenSource | null>
>();

/**
 * Build a lazy token source for one side of a comparison.
 *
 * The cache is keyed by the `lines` array identity: a re-diff produces a new array,
 * which is precisely when the states are stale. Nothing else invalidates it, so a
 * scroll, a resize or a theme switch costs no tokenising.
 */
export function createTokenSource(
  lines: readonly string[],
  language: Language,
): TokenSource | null {
  let byLanguage = tokenSourceCache.get(lines);
  if (!byLanguage) {
    byLanguage = new Map();
    tokenSourceCache.set(lines, byLanguage);
  }
  const cached = byLanguage.get(language);
  if (cached !== undefined) return cached;
  if (language === "plain" || lines.length === 0) {
    byLanguage.set(language, null);
    return null;
  }

  const states = lineStates(lines, language);
  const memo = new Map<number, Token[]>();

  const source = {
    get(lineIndex: number | null): Token[] {
      if (lineIndex === null || lineIndex < 0 || lineIndex >= lines.length) return [];
      const cached = memo.get(lineIndex);
      if (cached) return cached;
      const tokens = highlightLine(lines[lineIndex], language, states[lineIndex]).tokens;
      memo.set(lineIndex, tokens);
      return tokens;
    },
  };
  byLanguage.set(language, source);
  return source;
}
