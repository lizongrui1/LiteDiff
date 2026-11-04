//! Token-level (intra-line) diff.
//!
//! The two-level rendering works like this: a low-saturation row background marks
//! the line, then a high-saturation pill marks the characters that actually
//! changed. This module computes the second level.
//!
//! ## Why tokens and not characters
//!
//! A naive char diff of `foo_bar` -> `foo_baz` highlights the trailing `r`/`z`.
//! A token diff highlights the whole identifiers `bar`/`baz`, which is what a
//! reviewer reads. So each line is lexed first:
//!
//! * whitespace runs collapse to a single token (re-indentation is one change,
//!   not N spaces);
//! * identifier/number runs are split again at camelCase boundaries
//!   (`fooBarBaz` -> `foo`, `Bar`, `Baz`) so a rename shows only the changed part;
//! * every other character is its own token, keeping punctuation fine-grained.
//!
//! Identifier parts are interned case-insensitively, so `Foo` -> `foo` counts as
//! unchanged text rather than a full highlight.
//!
//! The diff then runs over token ids with the Myers engine, and the unmatched
//! runs are converted back to char ranges and split into [`InlineSegment`]s whose
//! concatenation reproduces the original line exactly.

use std::collections::HashMap;

use crate::model::{DiffOptions, InlineSegment};
use crate::myers;

/// A lexed piece of one line: a byte range plus its interned id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Token {
    start: usize,
    end: usize,
    id: u32,
}

/// Interner for tokens, shared by both lines of a pair so equal tokens compare
/// equal.
#[derive(Default)]
struct TokenTable {
    lookup: HashMap<String, u32>,
}

impl TokenTable {
    /// Intern `token`. Identifier parts are folded to lowercase so a pure case
    /// change is not reported as a textual change.
    fn intern(&mut self, token: &str, case_insensitive: bool) -> u32 {
        let key = if case_insensitive {
            token.to_lowercase()
        } else {
            token.to_string()
        };
        if let Some(&id) = self.lookup.get(&key) {
            return id;
        }
        let id = self.lookup.len() as u32;
        self.lookup.insert(key, id);
        id
    }
}

/// Characters that form identifier / number runs.
///
/// `_` is deliberately excluded: it is a separator, so `foo_bar` lexes as
/// `foo`, `_`, `bar` and a rename highlights only the part that differs.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// Lex `line` into tokens, interning against `table`.
///
/// `fold_case` must match the line-level `ignore_case` option. If it did not, a
/// line could be classified as `modify` (case-sensitive) while every token
/// compared equal (case-folded), leaving a tinted row with no pill — the exact
/// "there is a change here, but nothing is highlighted" bug that makes a diff
/// tool feel broken.
fn tokenize(line: &str, table: &mut TokenTable, fold_case: bool) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut chars = line.char_indices().peekable();

    while let Some(&(start, first)) = chars.peek() {
        // --- whitespace run ------------------------------------------------
        if first.is_whitespace() {
            let mut end = start + first.len_utf8();
            chars.next();
            while let Some(&(i, c)) = chars.peek() {
                if !c.is_whitespace() {
                    break;
                }
                end = i + c.len_utf8();
                chars.next();
            }
            let id = table.intern(&line[start..end], false);
            tokens.push(Token { start, end, id });
            continue;
        }

        // --- identifier / number run ---------------------------------------
        if is_word_char(first) {
            let mut word_start = start;
            let mut end = start;
            let mut prev: Option<char> = None;

            while let Some(&(i, c)) = chars.peek() {
                if !is_word_char(c) {
                    break;
                }
                // `lower|digit` -> `Upper` opens a new camelCase part.
                let boundary =
                    matches!(prev, Some(p) if (p.is_lowercase() || p.is_numeric()) && c.is_uppercase());
                if boundary && i > word_start {
                    let id = table.intern(&line[word_start..i], fold_case);
                    tokens.push(Token {
                        start: word_start,
                        end: i,
                        id,
                    });
                    word_start = i;
                }
                end = i + c.len_utf8();
                prev = Some(c);
                chars.next();
            }

            if end > word_start {
                let id = table.intern(&line[word_start..end], fold_case);
                tokens.push(Token {
                    start: word_start,
                    end,
                    id,
                });
            }
            continue;
        }

        // --- punctuation ----------------------------------------------------
        chars.next();
        let end = start + first.len_utf8();
        let id = table.intern(&line[start..end], false);
        tokens.push(Token { start, end, id });
    }

    tokens
}

/// Character range `[start, end)` in `chars` units.
type CharRange = (u32, u32);

/// Everything needed to style one line: which char ranges changed.
fn changed_ranges(
    left: &str,
    right: &str,
    options: &DiffOptions,
) -> Option<(Vec<CharRange>, Vec<CharRange>)> {
    let limit = options.intra_line_max_tokens;
    if limit > 0 {
        // Guard both the lexer output size and the raw line length: a minified
        // bundle is few very long tokens but still pathological to diff.
        if left.chars().count() > limit || right.chars().count() > limit {
            return None;
        }
    }

    let mut table = TokenTable::default();
    let fold_case = options.ignore_case;
    let left_tokens = tokenize(left, &mut table, fold_case);
    let right_tokens = tokenize(right, &mut table, fold_case);

    if limit > 0 && (left_tokens.len() > limit || right_tokens.len() > limit) {
        return None;
    }

    let a: Vec<u32> = left_tokens.iter().map(|t| t.id).collect();
    let b: Vec<u32> = right_tokens.iter().map(|t| t.id).collect();
    let matched = myers::matches(&a, &b);

    let left_ranges = unmatched_byte_ranges(&left_tokens, matched.iter().map(|&(i, _)| i as usize));
    let right_ranges =
        unmatched_byte_ranges(&right_tokens, matched.iter().map(|&(_, j)| j as usize));

    Some((
        to_char_ranges(left, &left_ranges),
        to_char_ranges(right, &right_ranges),
    ))
}

/// Byte ranges of the tokens whose index is absent from `matched` (ascending).
///
/// Adjacent unmatched tokens merge into one range so a changed identifier renders
/// as a single pill instead of one pill per sub-word.
fn unmatched_byte_ranges(
    tokens: &[Token],
    matched: impl Iterator<Item = usize>,
) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut matched = matched.peekable();

    for (idx, token) in tokens.iter().enumerate() {
        let is_matched = match matched.peek() {
            Some(&m) if m == idx => {
                matched.next();
                true
            }
            _ => false,
        };
        if is_matched {
            continue;
        }
        match ranges.last_mut() {
            Some(last) if last.1 == token.start => last.1 = token.end,
            _ => ranges.push((token.start, token.end)),
        }
    }
    ranges
}

/// Convert ascending byte ranges into ascending char ranges.
///
/// A byte offset's char offset is the number of char boundaries strictly before
/// it, so one sorted boundary table plus a binary search per range is exact and
/// cheap.
fn to_char_ranges(line: &str, byte_ranges: &[(usize, usize)]) -> Vec<CharRange> {
    if byte_ranges.is_empty() {
        return Vec::new();
    }
    let mut boundaries: Vec<usize> = line.char_indices().map(|(b, _)| b).collect();
    boundaries.push(line.len());

    byte_ranges
        .iter()
        .map(|&(start, end)| {
            (
                boundaries.partition_point(|&b| b < start) as u32,
                boundaries.partition_point(|&b| b < end) as u32,
            )
        })
        .collect()
}

/// Build the inline segments for one side of a modified row.
///
/// The concatenation of the returned segment texts is exactly `line`, so the
/// renderer can lay the row out faithfully while styling the changed parts.
/// An empty line yields no segments at all.
pub fn segments(line: &str, ranges: &[CharRange]) -> Vec<InlineSegment> {
    if line.is_empty() {
        return Vec::new();
    }
    if ranges.is_empty() {
        return vec![InlineSegment::same(line, 0)];
    }

    let total = line.chars().count() as u32;
    let mut out = Vec::with_capacity(ranges.len() * 2 + 1);
    let mut cursor = 0u32;

    for &(start, end) in ranges {
        if end <= start {
            continue; // defensive: an empty range carries no styling
        }
        debug_assert!(start >= cursor, "ranges must ascend and not overlap");
        if start > cursor {
            out.push(InlineSegment::same(&char_slice(line, cursor, start), cursor));
        }
        out.push(InlineSegment::changed(
            &char_slice(line, start, end),
            start,
        ));
        cursor = end;
    }

    if cursor < total {
        out.push(InlineSegment::same(
            &char_slice(line, cursor, total),
            cursor,
        ));
    }
    out
}

/// Slice `s` by char offsets.
fn char_slice(s: &str, start: u32, end: u32) -> String {
    s.chars()
        .skip(start as usize)
        .take((end - start) as usize)
        .collect()
}

/// Diff one modified row into left/right segments.
///
/// `None` means "too large to tokenise"; the caller should then emit a single
/// whole-line changed segment per side.
pub fn diff_line(
    left: &str,
    right: &str,
    options: &DiffOptions,
) -> Option<(Vec<InlineSegment>, Vec<InlineSegment>)> {
    let (left_ranges, right_ranges) = changed_ranges(left, right, options)?;
    Some((
        segments(left, &left_ranges),
        segments(right, &right_ranges),
    ))
}

/// The whole line as one changed segment, for the fallback path.
pub fn whole_line_changed(line: &str) -> Vec<InlineSegment> {
    if line.is_empty() {
        Vec::new()
    } else {
        vec![InlineSegment::changed(line, 0)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> DiffOptions {
        DiffOptions::default()
    }

    fn token_texts(line: &'static str) -> Vec<&'static str> {
        let mut table = TokenTable::default();
        let toks = tokenize(line, &mut table, false);
        toks.iter().map(|t| &line[t.start..t.end]).collect()
    }

    /// Segments must always reproduce the original line.
    fn assert_roundtrip(line: &str, segs: &[InlineSegment]) {
        let rebuilt: String = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(rebuilt, line, "segments must reproduce the line");
    }

    fn changed_text(segs: &[InlineSegment]) -> String {
        segs.iter()
            .filter(|s| s.changed)
            .map(|s| s.text.as_str())
            .collect()
    }

    #[test]
    fn tokenizer_splits_identifiers_and_punctuation() {
        assert_eq!(
            token_texts("foo(bar_baz, 42);"),
            vec!["foo", "(", "bar", "_", "baz", ",", " ", "42", ")", ";"]
        );
    }

    #[test]
    fn tokenizer_collapses_whitespace_runs() {
        assert_eq!(token_texts("a    b"), vec!["a", "    ", "b"]);
    }

    #[test]
    fn tokenizer_splits_camel_case_parts() {
        assert_eq!(token_texts("fooBarBaz"), vec!["foo", "Bar", "Baz"]);
    }

    #[test]
    fn identical_lines_have_no_highlights() {
        let (l, r) = diff_line("let x = 1;", "let x = 1;", &opts()).unwrap();
        assert!(changed_text(&l).is_empty());
        assert!(changed_text(&r).is_empty());
    }

    #[test]
    fn highlights_whole_identifier_part_not_single_chars() {
        let (l, r) = diff_line("foo_bar()", "foo_baz()", &opts()).unwrap();
        assert_eq!(changed_text(&l), "bar");
        assert_eq!(changed_text(&r), "baz");
        assert_roundtrip("foo_bar()", &l);
        assert_roundtrip("foo_baz()", &r);
    }

    #[test]
    fn highlights_changed_camel_case_part() {
        let (l, r) = diff_line("let name = fooBar();", "let name = fooBaz();", &opts()).unwrap();
        assert_eq!(changed_text(&l), "Bar");
        assert_eq!(changed_text(&r), "Baz");
    }

    #[test]
    fn case_change_is_highlighted_when_case_matters() {
        // Line-level diffing is case-sensitive by default, so the intra-line pass
        // must agree: a tinted row with no pill would look like a rendering bug.
        let (l, r) = diff_line("let Foo = 1;", "let foo = 1;", &opts()).unwrap();
        assert_eq!(changed_text(&l), "Foo");
        assert_eq!(changed_text(&r), "foo");
    }

    #[test]
    fn case_change_is_ignored_when_case_is_ignored() {
        let o = DiffOptions {
            ignore_case: true,
            ..DiffOptions::default()
        };
        let (l, r) = diff_line("let Foo = 1;", "let foo = 1;", &o).unwrap();
        assert!(changed_text(&l).is_empty());
        assert!(changed_text(&r).is_empty());
    }

    #[test]
    fn highlights_changed_number() {
        let (l, r) = diff_line("timeout = 30", "timeout = 60", &opts()).unwrap();
        assert_eq!(changed_text(&l), "30");
        assert_eq!(changed_text(&r), "60");
    }

    #[test]
    fn insertion_marks_only_new_text() {
        let (l, r) = diff_line("a + b", "a + b + c", &opts()).unwrap();
        assert_eq!(changed_text(&l), "");
        assert_eq!(changed_text(&r).trim(), "+ c");
        assert_roundtrip("a + b + c", &r);
    }

    #[test]
    fn handles_unicode_without_splitting_chars() {
        let (l, r) = diff_line("名称 = 一", "名称 = 二", &opts()).unwrap();
        assert_eq!(changed_text(&l), "一");
        assert_eq!(changed_text(&r), "二");
        assert_roundtrip("名称 = 一", &l);
        assert_roundtrip("名称 = 二", &r);
    }

    #[test]
    fn empty_line_against_content_has_no_left_segments() {
        let (l, r) = diff_line("", "hello", &opts()).unwrap();
        assert!(l.is_empty());
        assert_eq!(changed_text(&r), "hello");
    }

    #[test]
    fn char_offsets_are_contiguous() {
        let (l, _r) = diff_line("abc def", "abc xyz", &opts()).unwrap();
        let mut expected = 0u32;
        for seg in &l {
            assert_eq!(seg.char_start, expected);
            expected = seg.char_end;
        }
        assert_eq!(expected, "abc def".chars().count() as u32);
    }

    #[test]
    fn respects_size_limit() {
        let long_a = "x".repeat(4000);
        let long_b = "y".repeat(4000);
        let o = DiffOptions {
            intra_line_max_tokens: 16,
            ..DiffOptions::default()
        };
        assert!(
            diff_line(&long_a, &long_b, &o).is_none(),
            "must bail out instead of stalling"
        );
    }

    #[test]
    fn whole_line_changed_fallback() {
        let segs = whole_line_changed("abc");
        assert_eq!(segs.len(), 1);
        assert!(segs[0].changed);
        assert_eq!(segs[0].text, "abc");
        assert!(whole_line_changed("").is_empty());
    }
}
