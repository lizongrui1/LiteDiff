//! Line interning.
//!
//! The diff algorithms want `u32` symbols, not `&str`: comparing 4 bytes beats
//! comparing strings for every probe inside an O(ND) loop.
//!
//! Interning is done for *both* sides through one table, so a line present in
//! both documents maps to the same id — that identity is exactly what the
//! algorithms need, and it lets the frontend refer to lines by number.
//!
//! # Memory
//!
//! The table is keyed by a fixed-rule 64-bit hash of the *normalised* line, not
//! by an owned copy of the line. Each distinct id keeps only a representative
//! `(side, line_index)` — 12 bytes — plus a collision-chain link; the equality
//! proof is done against the source documents, so no line text is ever stored
//! twice. A document with 200 000 unique lines therefore costs a `Rep` plus a
//! hash bucket per line instead of a `String` header and heap buffer per line.
//!
//! Exactness is preserved: a matching hash is only a candidate, the
//! representative line is compared with the same normalisation rules the old
//! `HashMap<String, u32>` used, collisions walk the chain, and a new id is
//! allocated only when every representative on the chain compares unequal.
//! `ignore_case` normalisation is allocation-free except for lines that
//! contain capital sigma, where the standard library's context-sensitive
//! final-sigma rule is delegated to `str::to_lowercase` to stay exactly
//! equivalent (see `needs_contextual_lowercase`).

use std::collections::HashMap;

use crate::model::DiffOptions;
use crate::source::SourceText;

/// Side tag for the left document.
const LEFT: u8 = 0;
/// Side tag for the right document.
const RIGHT: u8 = 1;

/// Sentinel `next` value marking the end of a collision chain.
const NO_NEXT: u32 = u32::MAX;

/// FNV-1a parameters. The seed is fixed, so the hash is a pure function of the
/// line content and options (process-independent and reproducible).
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Boundary markers mixed into the character stream. They commit the hash to
/// where the normalised line starts and ends, so no two different character
/// streams can be confused by merely omitting a boundary (e.g. an empty line
/// versus a missing sequence), independently of the 64-bit tail.
const LINE_BEGIN: u64 = 0x9e37_79b9_7f4a_7c15;
const LINE_END: u64 = 0xc2b2_ae3d_27d4_eb4f;

#[inline]
fn mix(state: u64, value: u64) -> u64 {
    (state ^ value).wrapping_mul(FNV_PRIME)
}

#[inline]
fn mix_char(state: u64, c: char) -> u64 {
    mix(state, c as u64)
}

/// Fixed-rule hash of the normalised line, in the exact order [`normalized_eq`]
/// compares characters. Allocates nothing for lines without capital sigma.
///
/// The three normalisation rules mirror the old `normalize` helper:
/// * `ignore_all_whitespace` removes every whitespace character and, like the
///   old code, does **not** additionally fold case;
/// * otherwise `ignore_whitespace` trims leading/trailing whitespace only;
/// * then `ignore_case` applies Unicode lowercase, with the same context
///   sensitivity as `str::to_lowercase` (see [`needs_contextual_lowercase`]).
fn hash_line(line: &str, options: &DiffOptions) -> u64 {
    let mut hash = mix(FNV_OFFSET_BASIS, LINE_BEGIN);
    if options.ignore_all_whitespace {
        for c in line.chars().filter(|c| !c.is_whitespace()) {
            hash = mix_char(hash, c);
        }
    } else {
        let line = if options.ignore_whitespace {
            line.trim()
        } else {
            line
        };
        if options.ignore_case {
            // The hash must be a pure function of `str::to_lowercase(line)`:
            // equal lines have to land in the same bucket. Per-character
            // expansion is identical to the standard library except for the
            // word-final sigma rule, so only those lines take the allocating
            // path.
            if needs_contextual_lowercase(line) {
                for c in line.to_lowercase().chars() {
                    hash = mix_char(hash, c);
                }
            } else {
                for c in line.chars().flat_map(char::to_lowercase) {
                    hash = mix_char(hash, c);
                }
            }
        } else {
            for c in line.chars() {
                hash = mix_char(hash, c);
            }
        }
    }
    mix(hash, LINE_END)
}

/// Whether `str::to_lowercase` may differ from a per-character lowercase
/// expansion for this line.
///
/// The standard library special-cases `Σ` (U+03A3): at the end of a cased word
/// it maps to final sigma `ς`, elsewhere to `σ`. Per-character mappings agree
/// with `str::to_lowercase` for every other scalar value, so this is the only
/// contextual mapping and the only case that needs an allocated comparison.
fn needs_contextual_lowercase(line: &str) -> bool {
    line.contains('Σ')
}

/// Exact equality of two lines after Unicode-lowercasing per
/// `str::to_lowercase`, without allocating for the common case.
fn lowercase_eq(a: &str, b: &str) -> bool {
    if needs_contextual_lowercase(a) || needs_contextual_lowercase(b) {
        // Rare Greek-text path: delegate to the standard library so the
        // context-sensitive final-sigma rule stays exactly equivalent to the
        // old `to_lowercase()` key.
        a.to_lowercase() == b.to_lowercase()
    } else {
        a.chars()
            .flat_map(char::to_lowercase)
            .eq(b.chars().flat_map(char::to_lowercase))
    }
}

/// Exact equality of two lines under the rules [`hash_line`] hashes.
///
/// Comparison is streaming: `&str::trim`, a filtering iterator for
/// `ignore_all_whitespace`, and `char::to_lowercase` expansions compared
/// element-wise. No `String` is built, with the sole exception of
/// [`lowercase_eq`]'s word-final-sigma fallback, which is what keeps the intern
/// table free of line-text copies.
fn normalized_eq(a: &str, b: &str, options: &DiffOptions) -> bool {
    if options.ignore_all_whitespace {
        a.chars()
            .filter(|c| !c.is_whitespace())
            .eq(b.chars().filter(|c| !c.is_whitespace()))
    } else {
        let (a, b) = if options.ignore_whitespace {
            (a.trim(), b.trim())
        } else {
            (a, b)
        };
        if options.ignore_case {
            lowercase_eq(a, b)
        } else {
            a == b
        }
    }
}

/// A document's lines reduced to comparable symbols.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineKeys {
    /// One symbol per line of the document, in order.
    pub ids: Vec<u32>,
    /// Number of distinct symbols, i.e. the alphabet size.
    pub distinct: u32,
}

impl LineKeys {
    pub fn new(ids: Vec<u32>, distinct: u32) -> Self {
        Self { ids, distinct }
    }
}

/// One representative occurrence of an interned line.
///
/// This replaces the owned normalized `String` the old table stored per unique
/// line. The line text is recovered from the side document on demand, so the
/// id also records where the text still lives. 12 bytes after padding, versus a
/// 24-byte `String` header plus a heap allocation per line.
#[derive(Clone, Copy, Debug)]
struct Rep {
    /// [`LEFT`] or [`RIGHT`]: which document `line_index` refers to.
    side: u8,
    /// Line position in that document.
    line_index: u32,
    /// Next id whose representative shares this hash, or [`NO_NEXT`].
    next: u32,
}

/// Interner shared by both sides of one comparison.
struct Interner<'a, F> {
    options: &'a DiffOptions,
    /// Source document per side; representative text is read from here instead
    /// of being stored in the table.
    sides: [&'a SourceText; 2],
    /// Hash of a normalised line. Injecting it lets tests force collisions
    /// without weakening the production hash.
    line_hash: F,
    /// normalised-line hash -> head id of that hash's collision chain.
    table: HashMap<u64, u32>,
    /// One entry per interned id; `reps[id]` is that id's representative.
    reps: Vec<Rep>,
}

impl<'a, F> Interner<'a, F>
where
    F: Fn(&str, &DiffOptions) -> u64,
{
    fn new(
        left: &'a SourceText,
        right: &'a SourceText,
        options: &'a DiffOptions,
        line_hash: F,
    ) -> Self {
        let lines = (left.line_count() + right.line_count()) as usize;
        Self {
            options,
            sides: [left, right],
            line_hash,
            table: HashMap::with_capacity(lines),
            reps: Vec::with_capacity(lines),
        }
    }

    /// Text of line `line_index` in `side`.
    fn line(&self, side: u8, line_index: u32) -> &'a str {
        let doc: &'a SourceText = self.sides[side as usize];
        doc.line_str(line_index)
    }

    /// Intern one line, returning the id of its normalised content.
    fn intern(&mut self, side: u8, line_index: u32) -> u32 {
        let line = self.line(side, line_index);
        let hash = (self.line_hash)(line, self.options);

        let Some(head) = self.table.get(&hash).copied() else {
            return self.insert_new(hash, side, line_index);
        };

        // A hash match is only a candidate: distinct lines may map to the same
        // bucket, so every representative on the chain is compared exactly.
        let mut id = head;
        loop {
            let rep = self.reps[id as usize];
            if normalized_eq(self.line(rep.side, rep.line_index), line, self.options) {
                return id;
            }
            if rep.next == NO_NEXT {
                break;
            }
            id = rep.next;
        }
        self.insert_new(hash, side, line_index)
    }

    /// Allocate the next id and push it at the head of `hash`'s chain.
    fn insert_new(&mut self, hash: u64, side: u8, line_index: u32) -> u32 {
        debug_assert!(
            self.reps.len() < u32::MAX as usize,
            "intern table overflowed u32 ids"
        );
        let next = self.table.get(&hash).copied().unwrap_or(NO_NEXT);
        let id = self.reps.len() as u32;
        self.reps.push(Rep {
            side,
            line_index,
            next,
        });
        self.table.insert(hash, id);
        id
    }

    /// Intern every line of one side, in document order.
    fn intern_side(&mut self, side: u8) -> Vec<u32> {
        let doc = self.sides[side as usize];
        let mut ids = Vec::with_capacity(doc.line_count() as usize);
        for line_index in 0..doc.line_count() {
            ids.push(self.intern(side, line_index));
        }
        ids
    }
}

/// Build the symbol sequences for both sides.
pub fn intern(
    left: &SourceText,
    right: &SourceText,
    options: &DiffOptions,
) -> (LineKeys, LineKeys) {
    intern_with(left, right, options, hash_line)
}

/// [`intern`] with an injectable line hash.
///
/// Production always passes [`hash_line`]; the injection point exists so tests
/// can force hash collisions and exercise the collision-chain path without
/// weakening the real hash or adding a test-only branch to production code.
fn intern_with<F>(
    left: &SourceText,
    right: &SourceText,
    options: &DiffOptions,
    line_hash: F,
) -> (LineKeys, LineKeys)
where
    F: Fn(&str, &DiffOptions) -> u64,
{
    let mut interner = Interner::new(left, right, options, line_hash);
    let left_ids = interner.intern_side(LEFT);
    let right_ids = interner.intern_side(RIGHT);
    let distinct = interner.reps.len() as u32;
    (
        LineKeys::new(left_ids, distinct),
        LineKeys::new(right_ids, distinct),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn ids(a: &str, b: &str, options: &DiffOptions) -> (Vec<u32>, Vec<u32>) {
        let (l, r) = intern(&SourceText::new(a), &SourceText::new(b), options);
        (l.ids, r.ids)
    }

    /// Every combination of the three line-equality options, including the
    /// "all whitespace wins over case" ordering of the old normaliser.
    fn option_cases() -> [DiffOptions; 6] {
        let base = DiffOptions::default();
        [
            base.clone(),
            DiffOptions {
                ignore_whitespace: true,
                ..base.clone()
            },
            DiffOptions {
                ignore_all_whitespace: true,
                ..base.clone()
            },
            DiffOptions {
                ignore_case: true,
                ..base.clone()
            },
            DiffOptions {
                ignore_whitespace: true,
                ignore_case: true,
                ..base.clone()
            },
            DiffOptions {
                ignore_all_whitespace: true,
                ignore_case: true,
                ..base
            },
        ]
    }

    // --- reference implementation -------------------------------------------------

    /// The normaliser this change replaced, kept verbatim as the test oracle.
    fn reference_normalize(line: &str, options: &DiffOptions) -> Option<String> {
        if options.ignore_all_whitespace {
            Some(line.chars().filter(|c| !c.is_whitespace()).collect())
        } else {
            match (options.ignore_whitespace, options.ignore_case) {
                (false, false) => None,
                (trim, lower) => {
                    let trimmed = if trim { line.trim() } else { line };
                    Some(if lower {
                        trimmed.to_lowercase()
                    } else {
                        trimmed.to_string()
                    })
                }
            }
        }
    }

    /// The map-based interner this change replaced, kept verbatim as the test
    /// oracle: `HashMap<String, u32>` keyed by the normalised line.
    fn reference_intern(
        left: &SourceText,
        right: &SourceText,
        options: &DiffOptions,
    ) -> (LineKeys, LineKeys) {
        fn reference_side(
            side: &SourceText,
            table: &mut HashMap<String, u32>,
            options: &DiffOptions,
        ) -> LineKeys {
            let mut ids = Vec::with_capacity(side.line_count() as usize);
            for line in side.line_strs() {
                let key = match reference_normalize(line, options) {
                    Some(owned) => owned,
                    None => line.to_string(),
                };
                let id = match table.get(&key).copied() {
                    Some(id) => id,
                    None => {
                        let id = table.len() as u32;
                        table.insert(key, id);
                        id
                    }
                };
                ids.push(id);
            }
            LineKeys::new(ids, 0)
        }

        let mut table: HashMap<String, u32> = HashMap::new();
        let mut left_keys = reference_side(left, &mut table, options);
        let mut right_keys = reference_side(right, &mut table, options);
        let distinct = table.len() as u32;
        left_keys.distinct = distinct;
        right_keys.distinct = distinct;
        (left_keys, right_keys)
    }

    // --- deterministic fixture generation -----------------------------------------

    /// Small xorshift PRNG so fixtures are reproducible without a dependency.
    struct Rng(u64);

    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        fn below(&mut self, bound: usize) -> usize {
            (self.next_u64() % bound as u64) as usize
        }
    }

    /// Pieces chosen so generated lines exercise trimming, interior whitespace
    /// removal, ASCII/Unicode case folding (including expansions) and non-ASCII
    /// content, with plenty of repeats to exercise id reuse.
    const LINE_PIECES: &[&str] = &[
        "alpha", "BETA", "Gamma", "delta", "ZETA", "  ", "\t", " ", "x", "y", "z", "é", "É", "ß",
        "ẞ", "İ", "i\u{307}", "Σ", "σ", "ς", "日本", "🙂", "🙂🙂", "{", "}", "()", " ; ", "",
    ];

    fn generated_line(rng: &mut Rng) -> String {
        let pieces = 1 + rng.below(5);
        let mut line = String::new();
        for _ in 0..pieces {
            line.push_str(LINE_PIECES[rng.below(LINE_PIECES.len())]);
        }
        line
    }

    fn generated_doc(rng: &mut Rng, lines: usize) -> String {
        let mut doc = String::new();
        for _ in 0..lines {
            doc.push_str(&generated_line(rng));
            doc.push('\n');
        }
        if !doc.is_empty() && rng.below(3) == 0 {
            // Also exercise "last line has no terminator".
            doc.pop();
        }
        doc
    }

    // --- existing semantics -------------------------------------------------------

    #[test]
    fn equal_lines_get_equal_ids() {
        let (l, r) = ids("a\nb\n", "b\nc\n", &DiffOptions::default());
        assert_eq!(l[1], r[0], "shared line must intern to the same symbol");
        assert_ne!(l[0], r[1], "distinct lines must not collide");
    }

    #[test]
    fn exact_mode_is_whitespace_sensitive() {
        let opts = DiffOptions::default();
        let (l, r) = ids("a\n", " a\n", &opts);
        assert_ne!(l[0], r[0]);
    }

    #[test]
    fn ignore_whitespace_trims_edges_only() {
        let opts = DiffOptions {
            ignore_whitespace: true,
            ..DiffOptions::default()
        };
        let (l, r) = ids("a\n", "  a  \n", &opts);
        assert_eq!(l[0], r[0]);

        let (l2, r2) = ids("a b\n", "a  b\n", &opts);
        assert_ne!(l2[0], r2[0], "interior whitespace still differs");
    }

    #[test]
    fn ignore_all_whitespace_collapses_indentation() {
        let opts = DiffOptions {
            ignore_all_whitespace: true,
            ..DiffOptions::default()
        };
        let (l, r) = ids("if a { b }\n", "  if  a{b}\n", &opts);
        assert_eq!(l[0], r[0]);
    }

    #[test]
    fn ignore_case_folds_ascii_case() {
        let opts = DiffOptions {
            ignore_case: true,
            ..DiffOptions::default()
        };
        let (l, r) = ids("Hello\n", "hELLo\n", &opts);
        assert_eq!(l[0], r[0]);
    }

    #[test]
    fn distinct_counts_alphabet() {
        let opts = DiffOptions::default();
        let (l, r) = intern(
            &SourceText::new("a\nb\n"),
            &SourceText::new("b\nc\n"),
            &opts,
        );
        assert_eq!(l.distinct, 3);
        assert_eq!(r.distinct, 3);
    }

    #[test]
    fn ids_stay_within_alphabet() {
        let opts = DiffOptions::default();
        let (l, _) = intern(&SourceText::new("a\na\na\n"), &SourceText::new(""), &opts);
        assert_eq!(l.ids, vec![0, 0, 0]);
        assert_eq!(l.distinct, 1);
    }

    // --- new coverage -------------------------------------------------------------

    #[test]
    fn duplicate_lines_share_ids_across_sides() {
        let (l, r) = intern(
            &SourceText::new("a\nb\na\nb\na\n"),
            &SourceText::new("b\na\nb\n"),
            &DiffOptions::default(),
        );
        assert_eq!(
            l.ids,
            vec![0, 1, 0, 1, 0],
            "ids follow first occurrence order"
        );
        assert_eq!(r.ids, vec![1, 0, 1]);
        assert_eq!(l.distinct, 2);
        assert_eq!(r.distinct, 2);
        assert!(l.ids.iter().chain(&r.ids).all(|&id| id < l.distinct));
    }

    #[test]
    fn empty_and_blank_documents() {
        let exact = DiffOptions::default();
        let (l, r) = intern(&SourceText::new(""), &SourceText::new(""), &exact);
        assert!(l.ids.is_empty() && r.ids.is_empty());
        assert_eq!(l.distinct, 0);

        // A blank line is a line whose content is ""; that is distinct from an
        // empty document (zero lines) but repeats collapse.
        let left = SourceText::new("\n\n");
        let right = SourceText::new("\n \n");
        assert_eq!(left.line_count(), 2);
        let (l, r) = intern(&left, &right, &exact);
        assert_eq!(l.ids, vec![0, 0]);
        assert_eq!(
            r.ids,
            vec![0, 1],
            "a one-space line differs from an empty line"
        );
        assert_eq!(l.distinct, 2);

        let trim = DiffOptions {
            ignore_whitespace: true,
            ..DiffOptions::default()
        };
        let (l, r) = intern(&left, &right, &trim);
        assert_eq!(l.ids, vec![0, 0]);
        assert_eq!(r.ids, vec![0, 0]);
        assert_eq!(l.distinct, 1);
    }

    #[test]
    fn long_lines_intern_without_copying_them() {
        // 64 KiB single line: larger than any small-buffer optimisation and
        // enough to catch accidental O(line) copies per comparison.
        let long = "0123456789ABCDEF".repeat(4096);
        let left = SourceText::new(format!("{long}\nplain\n"));
        let right = SourceText::new(format!("  {long}  \n plain \n"));

        let trim = DiffOptions {
            ignore_whitespace: true,
            ..DiffOptions::default()
        };
        let all_ws = DiffOptions {
            ignore_all_whitespace: true,
            ..DiffOptions::default()
        };
        for options in [&trim, &all_ws] {
            let (l, r) = intern(&left, &right, options);
            assert_eq!(l.ids[0], r.ids[0], "ignoring whitespace equalises padding");
            assert_eq!(l.ids[1], r.ids[1]);
            assert_eq!(
                l.distinct, 2,
                "the long line and the short line are distinct contents"
            );
        }

        let (l, r) = intern(&left, &right, &DiffOptions::default());
        assert_ne!(l.ids[0], r.ids[0], "exact comparison keeps the padding");
        assert_ne!(
            l.ids[1], r.ids[1],
            "exact comparison keeps surrounding spaces"
        );
        assert_eq!(l.distinct, 4);
    }

    #[test]
    fn unicode_case_folding_matches_old_semantics() {
        let options = DiffOptions {
            ignore_case: true,
            ..DiffOptions::default()
        };
        let cases = [
            ("É\n", "é\n"),
            ("İSTANBUL\n", "i\u{307}stanbul\n"),
            ("ẞ\n", "ß\n"),
            ("🙂🙂\n", "🙂🙂\n"),
            ("日本\n", "日本\n"),
        ];
        for (a, b) in cases {
            let (l, r) = intern(&SourceText::new(a), &SourceText::new(b), &options);
            assert_eq!(l.ids[0], r.ids[0], "{a:?} vs {b:?} must fold together");
            assert_eq!(l.distinct, 1);
        }

        // A lone `Σ` has no preceding cased letter, so `str::to_lowercase`
        // folds it to `σ` (not word-final `ς`) and the two stay distinct.
        let (l, r) = ids("Σ\n", "ς\n", &options);
        assert_ne!(l[0], r[0]);
    }

    #[test]
    fn ignore_all_whitespace_takes_precedence_over_ignore_case_like_old_code() {
        let options = DiffOptions {
            ignore_all_whitespace: true,
            ignore_case: true,
            ..DiffOptions::default()
        };
        let (l, r) = ids("Hello\n", "hello\n", &options);
        assert_ne!(
            l[0], r[0],
            "old normalize() never applied ignore_case when ignore_all_whitespace was set"
        );

        let (l2, r2) = ids("H ell o\n", "Hello\n", &options);
        assert_eq!(l2[0], r2[0], "whitespace is still removed");
    }

    #[test]
    fn ignore_case_matches_context_sensitive_final_sigma() {
        let options = DiffOptions {
            ignore_case: true,
            ..DiffOptions::default()
        };
        // `str::to_lowercase` maps word-final `Σ` to `ς`; a per-character
        // mapping would produce `σ` and break equivalence with the old key.
        for (capitalised, lowered) in [("ΑΣ\n", "ας\n"), ("ΣΑ\n", "σα\n"), ("ΑΣΑ\n", "ασα\n")]
        {
            let (l, r) = ids(capitalised, lowered, &options);
            assert_eq!(l[0], r[0], "{capitalised:?} vs {lowered:?}");
        }
        // A lone `Σ` has no preceding cased letter, so it is not word-final.
        let (l, r) = ids("Σ\n", "ς\n", &options);
        assert_ne!(l[0], r[0], "a lone Σ folds to σ, not to ς");
    }

    #[test]
    fn consecutive_runs_are_identical() {
        let mut rng = Rng(0x1234_5678_9abc_def0);
        for _case in 0..10 {
            let left_lines = rng.below(60);
            let right_lines = rng.below(60);
            let left = SourceText::new(generated_doc(&mut rng, left_lines));
            let right = SourceText::new(generated_doc(&mut rng, right_lines));
            for options in &option_cases() {
                let first = intern(&left, &right, options);
                let second = intern(&left, &right, options);
                assert_eq!(
                    first, second,
                    "interning must be deterministic under {options:?}"
                );
            }
        }
    }

    #[test]
    fn hash_agrees_with_normalised_equality() {
        let mut rng = Rng(0x0bad_f00d);
        let lines: Vec<String> = (0..48).map(|_| generated_line(&mut rng)).collect();
        for options in &option_cases() {
            for a in &lines {
                for b in &lines {
                    if normalized_eq(a, b, options) {
                        assert_eq!(
                            hash_line(a, options),
                            hash_line(b, options),
                            "{a:?} vs {b:?} are equal under {options:?} but hash apart"
                        );
                    }
                }
            }
        }
    }

    // --- differential tests against the old implementation ------------------------

    #[test]
    fn differential_matches_reference_implementation() {
        let mut rng = Rng(0x5eed_1234_5678_9abc);
        for case in 0..40 {
            let left_lines = rng.below(40);
            let right_lines = rng.below(40);
            let left = SourceText::new(generated_doc(&mut rng, left_lines));
            let right = SourceText::new(generated_doc(&mut rng, right_lines));
            for options in &option_cases() {
                let got = intern(&left, &right, options);
                let want = reference_intern(&left, &right, options);
                assert_eq!(got, want, "case {case} under {options:?}");
            }
        }
    }

    #[test]
    fn differential_matches_reference_on_edge_case_documents() {
        let pairs: &[(&str, &str)] = &[
            ("", ""),
            ("", "\n"),
            ("\n\n\n", "\n"),
            ("a\n", "a"),
            ("a\r\nb\r\n", "a\nb\n"),
            ("  \n\t\n", "\n \n"),
            ("aaaa\nbbbb\naaaa\n", "aaaa\n"),
            ("\u{feff}bom\n", "bom\n"),
            ("🙂\n🙂\n", "🙂\n"),
        ];
        let long = "0123456789ABCDEF".repeat(4096);
        let long_pairs = [
            (format!("{long}\nplain\n"), format!("  {long}  \n plain \n")),
            (format!("{long}\n"), format!("{long}{long}\n")),
        ];
        let check = |left: &str, right: &str| {
            let left = SourceText::new(left);
            let right = SourceText::new(right);
            for options in &option_cases() {
                let got = intern(&left, &right, options);
                let want = reference_intern(&left, &right, options);
                assert_eq!(got, want, "edge-case documents under {options:?}");
            }
        };
        for &(left, right) in pairs {
            check(left, right);
        }
        for (left, right) in &long_pairs {
            check(left.as_str(), right.as_str());
        }
    }

    #[test]
    fn injected_hash_collisions_match_reference() {
        let mut rng = Rng(0x00c0_11de);
        for _case in 0..12 {
            let left_lines = rng.below(20);
            let right_lines = rng.below(20);
            let left = SourceText::new(generated_doc(&mut rng, left_lines));
            let right = SourceText::new(generated_doc(&mut rng, right_lines));
            for options in &option_cases() {
                // Truncating the real hash keeps the normalisation contract but
                // sends unrelated lines into only two buckets, so equality has
                // to be decided by walking the collision chain.
                let got = intern_with(&left, &right, options, |line, opts| {
                    hash_line(line, opts) & 1
                });
                let want = reference_intern(&left, &right, options);
                assert_eq!(got, want, "collision chain under {options:?}");
            }
        }
    }

    #[test]
    fn collision_chain_reuses_ids_after_walking_the_chain() {
        let options = DiffOptions::default();
        let left = SourceText::new("a\nb\nc\na\nb\n");
        let right = SourceText::new("c\na\nb\nd\n");
        // Constant hash: every line shares one bucket, so later lookups must
        // walk past newer representatives (chain is newest-first) to match.
        let (left_keys, right_keys) = intern_with(&left, &right, &options, |_, _| 0);
        assert_eq!(left_keys.ids, vec![0, 1, 2, 0, 1]);
        assert_eq!(right_keys.ids, vec![2, 0, 1, 3]);
        assert_eq!(left_keys.distinct, 4);
        assert_eq!(right_keys.distinct, 4);

        // A truncated hash mixes chain lengths while still honouring the
        // normalisation contract; ids must match the oracle exactly.
        let got = intern_with(&left, &right, &options, |line, opts| {
            hash_line(line, opts) % 2
        });
        let want = reference_intern(&left, &right, &options);
        assert_eq!(got, want);
    }
}
