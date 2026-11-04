//! Line interning.
//!
//! The diff algorithms want `u32` symbols, not `&str`: comparing 4 bytes beats
//! comparing strings for every probe inside an O(ND) loop.
//!
//! Interning is done for *both* sides through one hash map, so a line present in
//! both documents maps to the same id — that identity is exactly what the
//! algorithms need, and it lets the frontend refer to lines by number.

use std::collections::HashMap;

use crate::model::DiffOptions;
use crate::source::SourceText;

/// Normalise a line according to [`DiffOptions`] before it becomes a key.
///
/// Returns a borrowed slice when no normalisation is needed, so the common case
/// (exact comparison) allocates nothing per line.
fn normalize(line: &str, options: &DiffOptions) -> Option<String> {
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

/// Interner shared by both sides of one comparison.
struct Interner {
    table: HashMap<String, u32>,
}

impl Interner {
    fn with_capacity(cap: usize) -> Self {
        Self {
            table: HashMap::with_capacity(cap),
        }
    }

    /// Intern one line, allocating only when the key is genuinely new.
    fn intern(&mut self, line: &str, options: &DiffOptions) -> u32 {
        match normalize(line, options) {
            None => self.lookup_or_insert(line),
            Some(owned) => self.lookup_or_insert(&owned),
        }
    }

    fn lookup_or_insert(&mut self, key: &str) -> u32 {
        if let Some(&id) = self.table.get(key) {
            return id;
        }
        let id = self.table.len() as u32;
        self.table.insert(key.to_string(), id);
        id
    }

    fn intern_all(&mut self, side: &SourceText, options: &DiffOptions) -> LineKeys {
        let mut ids = Vec::with_capacity(side.line_count() as usize);
        for line in side.line_strs() {
            ids.push(self.intern(line, options));
        }
        LineKeys::new(ids, 0)
    }
}

/// Build the symbol sequences for both sides.
pub fn intern(left: &SourceText, right: &SourceText, options: &DiffOptions) -> (LineKeys, LineKeys) {
    let cap = (left.line_count() + right.line_count()) as usize;
    let mut interner = Interner::with_capacity(cap);

    let mut left_keys = interner.intern_all(left, options);
    let mut right_keys = interner.intern_all(right, options);

    let distinct = interner.table.len() as u32;
    left_keys.distinct = distinct;
    right_keys.distinct = distinct;
    (left_keys, right_keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(a: &str, b: &str, options: &DiffOptions) -> (Vec<u32>, Vec<u32>) {
        let (l, r) = intern(&SourceText::new(a), &SourceText::new(b), options);
        (l.ids, r.ids)
    }

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
        let (l, r) = intern(&SourceText::new("a\nb\n"), &SourceText::new("b\nc\n"), &opts);
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
}
