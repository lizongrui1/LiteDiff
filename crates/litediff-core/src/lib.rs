//! LiteDiff core diff engine.
//!
//! A pure-Rust, dependency-free engine for two-level text diffing:
//!
//! * **line level** — [`myers`] (minimal edit script) or [`patience`] (stable,
//!   human-readable anchors), fed by [`intern`]'s symbol table;
//! * **token level** — [`token`] produces the char ranges that the UI paints
//!   with high-saturation pills;
//! * **alignment** — [`align`] turns the edit script into padded, equal-height
//!   side-by-side rows plus hunks for the minimap.
//!
//! The public entry point is [`diff`]; everything below it is exposed for
//! testing and for the future incremental-recompute path.
//!
//! ```no_run
//! use litediff_core::{diff, DiffOptions};
//!
//! let result = diff("a\nb\n", "a\nc\n", &DiffOptions::default());
//! assert_eq!(result.stats.modified, 1);
//! ```
//!
//! Design constraints this crate satisfies (from the Step 1 brief):
//!
//! * no allocation proportional to `left * right` — Myers is the linear-space
//!   bisect variant, so peak memory is O(left + right);
//! * deterministic output for identical input, irrespective of the algorithm;
//! * every reported match is a genuine equality, so the UI can never render a
//!   highlighted "change" that is actually identical text.

pub mod align;
pub mod intern;
pub mod model;
pub mod myers;
pub mod patience;
pub mod source;
pub mod token;

pub use model::{
    ops_from_matches, AlignedRow, ChangeTag, DiffOptions, DiffResult, DiffStats, Hunk,
    InlineSegment, LineAlgorithm, LineOp, RowKind,
};
pub use source::{Line, SourceText};

/// Diff two documents and return the aligned result.
///
/// Complexity: `O((N + M) * D)` time for Myers (with `D` the edit distance, so
/// near-linear on typical edits) and `O(N + M)` peak auxiliary memory.
pub fn diff(left: &str, right: &str, options: &DiffOptions) -> DiffResult {
    let left = SourceText::new(left);
    let right = SourceText::new(right);
    diff_sources(&left, &right, options)
}

/// Diff two already-indexed documents.
///
/// Preferred when the caller keeps the [`SourceText`] around (the editor does):
/// re-splitting a large buffer on every keystroke would dominate the diff cost.
pub fn diff_sources(left: &SourceText, right: &SourceText, options: &DiffOptions) -> DiffResult {
    let (left_keys, right_keys) = intern::intern(left, right, options);

    let matches = match options.algorithm {
        LineAlgorithm::Myers => myers::matches(&left_keys.ids, &right_keys.ids),
        LineAlgorithm::Patience => patience::matches(&left_keys.ids, &right_keys.ids),
    };

    let ops = ops_from_matches(left.line_count(), right.line_count(), &matches);
    let (rows, hunks, stats) = align::build(left, right, &ops, options);

    DiffResult {
        left_line_count: left.line_count(),
        right_line_count: right.line_count(),
        rows,
        hunks,
        stats,
    }
}
