//! Alignment state machine: edit script -> padded side-by-side rows.
//!
//! This is the bridge between the pure diff (which only reports *what* changed)
//! and the renderer (which needs rows that are equal height on both sides).
//!
//! ## The pairing rule
//!
//! An edit script comes out as runs of `Equal`, `Delete`, `Insert`. A deleted run
//! followed by an inserted run is a *replacement*, and the UI wants those on the
//! same rows so the intra-line highlight has something to sit on. So for each
//! replacement block we emit `min(del, ins)` [`RowKind::Modify`] rows and pad the
//! remainder with blank cells:
//!
//! ```text
//!   - old_a          |  + new_a        <- Modify  (intra-line diff)
//!   - old_b          |  (hatched)      <- Delete  (right side padded)
//!   (hatched)        |  + new_c        <- Insert  (left side padded)
//! ```
//!
//! Padding is what guarantees `left.len() == right.len()` per block, which is the
//! precondition for strict scroll synchronisation in Step 3.

use crate::model::{
    AlignedRow, ChangeTag, DiffOptions, DiffStats, Hunk, LineOp, RowKind,
};
use crate::source::SourceText;
use crate::token;

/// Convert an edit script into aligned rows, hunks and counters.
pub fn build(
    left: &SourceText,
    right: &SourceText,
    ops: &[LineOp],
    options: &DiffOptions,
) -> (Vec<AlignedRow>, Vec<Hunk>, DiffStats) {
    let mut rows: Vec<AlignedRow> = Vec::with_capacity((left.line_count() + right.line_count()) as usize);
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut stats = DiffStats::default();
    let mut pending_delete: Option<(u32, u32)> = None; // (start, len)
    let mut pending_insert: Option<(u32, u32)> = None;

    // Flush a replacement block: pair `min(del, ins)` lines into Modify rows,
    // then pad the longer side. Appending the rows here is what keeps the two
    // columns at equal height for strict scroll sync.
    let flush_change =
        |rows: &mut Vec<AlignedRow>,
         hunks: &mut Vec<Hunk>,
         pending_delete: &mut Option<(u32, u32)>,
         pending_insert: &mut Option<(u32, u32)>| {
            let (del_start, del_len) = pending_delete.take().unwrap_or((0, 0));
            let (ins_start, ins_len) = pending_insert.take().unwrap_or((0, 0));
            if del_len == 0 && ins_len == 0 {
                return;
            }
            let row_start = rows.len() as u32;
            for (left, right, kind) in pair_block(del_start, del_len, ins_start, ins_len) {
                rows.push(AlignedRow::plain(left, right, kind));
            }
            hunks.push(Hunk {
                equal: false,
                left_start: del_start,
                left_len: del_len,
                right_start: ins_start,
                right_len: ins_len,
                row_start,
                row_len: rows.len() as u32 - row_start,
            });
        };

    for op in ops {
        match op.tag {
            ChangeTag::Equal => {
                flush_change(&mut rows, &mut hunks, &mut pending_delete, &mut pending_insert);
                debug_assert_eq!(op.left_len, op.right_len);
                let row_start = rows.len() as u32;
                for i in 0..op.left_len {
                    rows.push(AlignedRow::plain(
                        Some(op.left_start + i),
                        Some(op.right_start + i),
                        RowKind::Equal,
                    ));
                }
                stats.unchanged += op.left_len;
                hunks.push(Hunk {
                    equal: true,
                    left_start: op.left_start,
                    left_len: op.left_len,
                    right_start: op.right_start,
                    right_len: op.right_len,
                    row_start,
                    row_len: op.left_len,
                });
            }
            ChangeTag::Delete => {
                pending_delete = Some((op.left_start, op.left_len));
            }
            ChangeTag::Insert => {
                pending_insert = Some((op.right_start, op.right_len));
            }
        }
    }
    flush_change(&mut rows, &mut hunks, &mut pending_delete, &mut pending_insert);

    // Second pass: attach intra-line segments to Modify rows.
    if options.intra_line {
        for row in rows.iter_mut() {
            if row.kind != RowKind::Modify {
                continue;
            }
            let (Some(li), Some(ri)) = (row.left, row.right) else {
                continue;
            };
            let l = left.line_str(li);
            let r = right.line_str(ri);
            match token::diff_line(l, r, options) {
                Some((left_segs, right_segs)) => {
                    row.left_inline = left_segs;
                    row.right_inline = right_segs;
                }
                None => {
                    // Too long to tokenise: mark both lines as wholly changed.
                    row.left_inline = token::whole_line_changed(l);
                    row.right_inline = token::whole_line_changed(r);
                }
            }
        }
    }

    stats.modified = rows.iter().filter(|r| r.kind == RowKind::Modify).count() as u32;
    stats.deleted = rows.iter().filter(|r| r.kind == RowKind::Delete).count() as u32;
    stats.added = rows.iter().filter(|r| r.kind == RowKind::Insert).count() as u32;

    (rows, hunks, stats)
}

/// Turn a raw replacement block into rows: pair what can be paired, pad the rest.
///
/// Extracted so the pairing rule is testable on its own.
pub fn pair_block(
    left_start: u32,
    left_len: u32,
    right_start: u32,
    right_len: u32,
) -> Vec<(Option<u32>, Option<u32>, RowKind)> {
    let paired = left_len.min(right_len);
    let mut out = Vec::with_capacity(left_len.max(right_len) as usize);

    for i in 0..paired {
        out.push((
            Some(left_start + i),
            Some(right_start + i),
            RowKind::Modify,
        ));
    }
    for i in paired..left_len {
        out.push((Some(left_start + i), None, RowKind::Delete));
    }
    for i in paired..right_len {
        out.push((None, Some(right_start + i), RowKind::Insert));
    }
    out
}

/// Rebuild the right-hand text from the edit script.
///
/// Used by the "Use Left / Use Right" actions (Step 2) and by tests asserting the
/// script faithfully describes the change. `left` is kept in the signature
/// because the reverse direction (reconstructing the left text) uses the same
/// routine with the roles swapped.
pub fn apply_ops(left: &SourceText, right: &SourceText, ops: &[LineOp]) -> String {
    let _ = left;
    let mut out = String::new();
    for op in ops {
        for i in 0..op.right_len {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(right.line_str(op.right_start + i));
        }
    }
    if right.text().ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ops_from_matches;

    #[test]
    fn pair_block_pairs_min_then_pads() {
        let rows = pair_block(0, 1, 10, 3);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], (Some(0), Some(10), RowKind::Modify));
        assert_eq!(rows[1], (None, Some(11), RowKind::Insert));
        assert_eq!(rows[2], (None, Some(12), RowKind::Insert));
    }

    #[test]
    fn pair_block_pads_left_when_more_deletions() {
        let rows = pair_block(5, 2, 0, 1);
        assert_eq!(rows[0], (Some(5), Some(0), RowKind::Modify));
        assert_eq!(rows[1], (Some(6), None, RowKind::Delete));
    }

    #[test]
    fn empty_block_yields_nothing() {
        assert!(pair_block(0, 0, 0, 0).is_empty());
    }

    #[test]
    fn ops_reproduce_the_right_side() {
        let left = SourceText::new("a\nb\nc\n");
        let right = SourceText::new("a\nX\nc\nd\n");
        let (lk, rk) = crate::intern::intern(&left, &right, &DiffOptions::default());
        let matches = crate::myers::matches(&lk.ids, &rk.ids);
        let ops = ops_from_matches(left.line_count(), right.line_count(), &matches);
        assert_eq!(apply_ops(&left, &right, &ops), right.text());
    }
}
