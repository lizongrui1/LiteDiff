//! Core data model for LiteDiff's diff engine.
//!
//! The model is deliberately flat and `u32`-indexed so it can be handed to the
//! Tauri IPC boundary with a single `serde` derive in the desktop crate without
//! reshaping (Step 2 adds that derive behind a feature flag).
//!
//! Three layers, each a plain state machine over the previous one:
//!
//! ```text
//! SourceText (bytes -> lines)
//!   -> intern::line_keys        (lines -> comparable u32 ids, honouring DiffOptions)
//!   -> myers                    (ids -> ordered match pairs)
//!   -> model::ops_from_matches  (match pairs -> LineOp edit script)
//!   -> align::build             (edit script -> padded side-by-side rows + hunks)
//!   -> token::intra_line        (modify rows -> char-level highlight segments)
//! ```

/// Knobs that affect *what counts as equal*, not how it is rendered.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffOptions {
    /// Compare lines after trimming leading/trailing whitespace.
    pub ignore_whitespace: bool,
    /// Compare lines after removing every whitespace character, so that
    /// re-indentation and re-wrapping collapse to "no change".
    pub ignore_all_whitespace: bool,
    /// Case-insensitive line comparison.
    pub ignore_case: bool,
    /// Compute token-level segments for modified rows.
    pub intra_line: bool,
    /// Skip token-level diff and mark the whole line changed when either side
    /// tokenises to more than this many tokens. Keeps pathological long lines
    /// (minified bundles, base64 blobs) from stalling the UI.
    pub intra_line_max_tokens: usize,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            ignore_whitespace: false,
            ignore_all_whitespace: false,
            ignore_case: false,
            intra_line: true,
            intra_line_max_tokens: 2048,
        }
    }
}

/// Opcode tag of one entry in the line edit script.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeTag {
    /// `left_len == right_len` lines are identical.
    Equal,
    /// Lines present on the left side only.
    Delete,
    /// Lines present on the right side only.
    Insert,
}

/// A run of lines sharing one [`ChangeTag`].
///
/// Invariant: every `0..left_line_count` and every `0..right_line_count`
/// appears exactly once across the op list, in ascending order.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineOp {
    pub tag: ChangeTag,
    pub left_start: u32,
    pub left_len: u32,
    pub right_start: u32,
    pub right_len: u32,
}

/// Visual classification of one side-by-side row.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    /// Identical lines on both sides.
    Equal,
    /// Both sides present but different: render intra-line highlights.
    Modify,
    /// Left line with a padded (hatched) right cell.
    Delete,
    /// Right line with a padded (hatched) left cell.
    Insert,
}

/// One contiguous run of characters carrying the same highlight state.
///
/// `text` is the exact slice of the line, so the renderer never has to convert
/// byte offsets to UTF-16 indices: it simply concatenates segments. The char
/// offsets are provided for tooling and for absolute-position assertions.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineSegment {
    pub text: String,
    pub char_start: u32,
    pub char_end: u32,
    /// `true` for the high-saturation "this changed" pill.
    pub changed: bool,
}

impl InlineSegment {
    pub(crate) fn same(text: &str, char_start: u32) -> Self {
        let char_len = text.chars().count() as u32;
        Self {
            text: text.to_string(),
            char_start,
            char_end: char_start + char_len,
            changed: false,
        }
    }

    pub(crate) fn changed(text: &str, char_start: u32) -> Self {
        let char_len = text.chars().count() as u32;
        Self {
            text: text.to_string(),
            char_start,
            char_end: char_start + char_len,
            changed: true,
        }
    }
}

/// One row of the aligned view. Exactly one side may be `None` (the padded
/// "empty placeholder" cell that the UI paints with a 45° hatch).
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlignedRow {
    pub left: Option<u32>,
    pub right: Option<u32>,
    pub kind: RowKind,
    /// Empty unless `kind == Modify` and intra-line diffing is enabled.
    pub left_inline: Vec<InlineSegment>,
    /// Empty unless `kind == Modify` and intra-line diffing is enabled.
    pub right_inline: Vec<InlineSegment>,
}

impl AlignedRow {
    pub(crate) fn plain(left: Option<u32>, right: Option<u32>, kind: RowKind) -> Self {
        Self {
            left,
            right,
            kind,
            left_inline: Vec::new(),
            right_inline: Vec::new(),
        }
    }
}

/// A maximal run of rows with the same equality state.
///
/// Equal runs longer than the fold threshold are what Step 3 collapses into a
/// "N unchanged lines" bar; change runs are the minimap's red/green ticks.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub equal: bool,
    pub left_start: u32,
    pub left_len: u32,
    pub right_start: u32,
    pub right_len: u32,
    /// Row index of the first row of this hunk, in [`DiffResult::rows`].
    pub row_start: u32,
    pub row_len: u32,
}

/// Aggregate counters for the status bar.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiffStats {
    /// Rows where only the right side has content.
    pub added: u32,
    /// Rows where only the left side has content.
    pub deleted: u32,
    /// Rows paired as a modification of one line into another.
    pub modified: u32,
    pub unchanged: u32,
}

impl DiffStats {
    /// Conventional `+added -deleted` summary used in the toolbar.
    pub fn summary(&self) -> String {
        format!("+{} -{} ~{}", self.added, self.deleted, self.modified)
    }
}

/// Fully aligned diff, ready to be streamed to the frontend.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffResult {
    pub left_line_count: u32,
    pub right_line_count: u32,
    pub rows: Vec<AlignedRow>,
    pub hunks: Vec<Hunk>,
    pub stats: DiffStats,
    /// The line-level search hit its work budget and fell back to a coarse
    /// replacement. The result is deterministic but not minimal.
    pub approximate: bool,
}

impl DiffResult {
    /// Change hunks only — the minimap heat strip and `Cmd + ]` / `Cmd + [`
    /// navigation both walk this list.
    pub fn change_hunks(&self) -> impl Iterator<Item = &Hunk> {
        self.hunks.iter().filter(|h| !h.equal)
    }

    /// True when both sides are line-for-line equal.
    pub fn is_identical(&self) -> bool {
        self.stats.added == 0 && self.stats.deleted == 0 && self.stats.modified == 0
    }

    /// Index of the hunk containing `row`, by binary search on `row_start`.
    pub fn hunk_at_row(&self, row: u32) -> Option<usize> {
        let idx = self
            .hunks
            .partition_point(|h| h.row_start <= row)
            .checked_sub(1)?;
        let h = &self.hunks[idx];
        if row < h.row_start + h.row_len {
            Some(idx)
        } else {
            None
        }
    }
}

/// Number of ops the greedy script below will contain.
///
/// The old capacity bound (`matches.len() * 2 + 2`) is two orders of magnitude
/// above the real count for near-identical documents — one equal run plus a few
/// change runs — and at 200,000 matched lines that over-allocation is several
/// megabytes of peak memory. Counting first is one extra O(matches) pass with no
/// allocation, and lets the output buffer be sized exactly once.
///
/// The counter must mirror every push in [`ops_from_matches`]: a push per
/// non-empty delete gap, per non-empty insert gap, per equal run that does not
/// continue the previous equal run, and for the trailing gaps.
fn op_count(left_len: u32, right_len: u32, matches: &[(u32, u32)]) -> usize {
    let mut count = 0usize;
    let mut li = 0u32;
    let mut ri = 0u32;
    let mut equal_end: Option<(u32, u32)> = None;

    for &(al, br) in matches {
        if al > li {
            count += 1;
        }
        if br > ri {
            count += 1;
        }
        let continues_equal = equal_end == Some((al, br));
        if !continues_equal {
            count += 1;
        }
        equal_end = Some((al + 1, br + 1));
        li = al + 1;
        ri = br + 1;
    }

    if left_len > li {
        count += 1;
    }
    if right_len > ri {
        count += 1;
    }
    count
}

/// Convert an ordered, ascending list of matched `(left, right)` index pairs
/// into a gap-filling edit script. Deleting gaps are emitted before inserting
/// gaps so that a replacement reads as "delete then insert" and the aligner can
/// pair them into [`RowKind::Modify`] rows.
pub fn ops_from_matches(left_len: u32, right_len: u32, matches: &[(u32, u32)]) -> Vec<LineOp> {
    let mut ops: Vec<LineOp> = Vec::with_capacity(op_count(left_len, right_len, matches));
    let mut li = 0u32;
    let mut ri = 0u32;

    for &(al, br) in matches {
        debug_assert!(al >= li && br >= ri, "matches must be ascending");
        if al > li {
            ops.push(LineOp {
                tag: ChangeTag::Delete,
                left_start: li,
                left_len: al - li,
                right_start: ri,
                right_len: 0,
            });
        }
        if br > ri {
            ops.push(LineOp {
                tag: ChangeTag::Insert,
                left_start: al,
                left_len: 0,
                right_start: ri,
                right_len: br - ri,
            });
        }

        let merged = match ops.last_mut() {
            Some(last)
                if last.tag == ChangeTag::Equal
                    && last.left_start + last.left_len == al
                    && last.right_start + last.right_len == br =>
            {
                last.left_len += 1;
                last.right_len += 1;
                true
            }
            _ => false,
        };
        if !merged {
            ops.push(LineOp {
                tag: ChangeTag::Equal,
                left_start: al,
                left_len: 1,
                right_start: br,
                right_len: 1,
            });
        }

        li = al + 1;
        ri = br + 1;
    }

    if left_len > li {
        ops.push(LineOp {
            tag: ChangeTag::Delete,
            left_start: li,
            left_len: left_len - li,
            right_start: ri,
            right_len: 0,
        });
    }
    if right_len > ri {
        ops.push(LineOp {
            tag: ChangeTag::Insert,
            left_start: left_len,
            left_len: 0,
            right_start: ri,
            right_len: right_len - ri,
        });
    }

    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The counting pass must agree with what the builder actually emits, or a
    /// future change to the push rules would silently regress the allocation.
    fn assert_count_matches_output(left_len: u32, right_len: u32, matches: &[(u32, u32)]) {
        let ops = ops_from_matches(left_len, right_len, matches);
        assert_eq!(
            op_count(left_len, right_len, matches),
            ops.len(),
            "op_count disagrees with ops_from_matches for left={left_len} right={right_len} matches={matches:?}"
        );
    }

    #[test]
    fn op_count_matches_output_for_every_shape() {
        assert_count_matches_output(0, 0, &[]);
        // Empty left, all inserted.
        assert_count_matches_output(0, 5, &[]);
        // All deleted.
        assert_count_matches_output(5, 0, &[]);
        // Identical documents: one merged equal run.
        assert_count_matches_output(4, 4, &[(0, 0), (1, 1), (2, 2), (3, 3)]);
        // A single replacement in the middle.
        assert_count_matches_output(4, 4, &[(0, 0), (2, 2), (3, 3)]);
        // Alternating matches and gaps (every gap opens a new equal run).
        assert_count_matches_output(3, 3, &[(0, 0), (2, 2)]);
        // One side longer than the other with a tail.
        assert_count_matches_output(6, 3, &[(0, 0), (1, 1), (2, 2)]);
        // Interleaved insertion-then-deletion gaps.
        assert_count_matches_output(5, 7, &[(0, 0), (2, 3), (4, 6)]);
    }

    #[test]
    fn op_count_is_never_above_the_old_upper_bound() {
        let matches: Vec<(u32, u32)> = (0..10).map(|i| (i, i)).collect();
        assert!(op_count(10, 10, &matches) <= matches.len() * 2 + 2);
    }
}
