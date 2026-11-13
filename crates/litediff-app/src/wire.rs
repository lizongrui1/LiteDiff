//! Compact IPC payload for one diff.
//!
//! The renderer already holds both documents, so the per-row aligned grid and
//! the inline segment texts do not need to cross IPC. [`WireDiff`] keeps the
//! hunk table — from which the renderer rebuilds the row grid with the same
//! pairing rule as [`litediff_core::align::pair_block`] — plus the changed
//! character ranges of modified rows as UTF-16 code-unit offsets.

use litediff_core::{DiffResult, DiffStats, Hunk, InlineSegment, RowKind};
use serde::Serialize;

/// One diff as sent to the renderer.
///
/// Field names deliberately stay `snake_case` (no `rename_all`): they mirror the
/// existing [`Hunk`]/[`DiffStats`] JSON and the TypeScript `WireDiff` type.
#[derive(Clone, Debug, Serialize)]
pub struct WireDiff {
    pub left_line_count: u32,
    pub right_line_count: u32,
    /// Maximal runs of rows; the aligned row grid is re-derived from these.
    pub hunks: Vec<Hunk>,
    pub stats: DiffStats,
    /// The line-level search exhausted its work budget; the alignment is
    /// deterministic but not necessarily minimal. Never hidden from the UI.
    pub approximate: bool,
    /// Flat `(row, start, end)` triples of changed runs on the left side of
    /// `Modify` rows, in UTF-16 code units within the logical line, ascending
    /// by row and then start.
    pub left_changed: Vec<u32>,
    /// Same as [`Self::left_changed`], for the right side.
    pub right_changed: Vec<u32>,
}

impl WireDiff {
    /// Number of aligned rows, derived from the hunk table.
    pub fn row_count(&self) -> u32 {
        self.hunks
            .last()
            .map_or(0, |hunk| hunk.row_start + hunk.row_len)
    }

    /// True when both sides are line-for-line equal.
    pub fn is_identical(&self) -> bool {
        self.stats.added == 0 && self.stats.deleted == 0 && self.stats.modified == 0
    }
}

/// Convert a fully aligned [`DiffResult`] into its compact IPC form.
///
/// The row grid is dropped after the changed ranges have been extracted; every
/// other field is passed through untouched.
pub fn wire_diff(result: DiffResult) -> WireDiff {
    let DiffResult {
        left_line_count,
        right_line_count,
        rows,
        hunks,
        stats,
        approximate,
    } = result;

    let mut left_changed = Vec::new();
    let mut right_changed = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if row.kind != RowKind::Modify {
            continue;
        }
        let row_index = index as u32;
        collect_changed(row_index, &row.left_inline, &mut left_changed);
        collect_changed(row_index, &row.right_inline, &mut right_changed);
    }

    WireDiff {
        left_line_count,
        right_line_count,
        hunks,
        stats,
        approximate,
        left_changed,
        right_changed,
    }
}

/// Append one `(row, start, end)` triple per changed segment.
///
/// `InlineSegment::text` is the exact slice of the line, so summing its UTF-16
/// code-unit length yields the offset the renderer needs for `String#slice`,
/// even for astral characters (`😀` counts as two code units).
fn collect_changed(row: u32, segments: &[InlineSegment], out: &mut Vec<u32>) {
    let mut offset = 0u32;
    for segment in segments {
        let utf16_len = segment.text.encode_utf16().count() as u32;
        if segment.changed {
            out.extend_from_slice(&[row, offset, offset + utf16_len]);
        }
        offset += utf16_len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use litediff_core::{diff, AlignedRow, DiffOptions};

    /// Inputs exercising every row shape: empty, pure insert/delete, paired
    /// modifications with padding on either side, equal runs around changes,
    /// CRLF, blank lines and an astral character.
    const FIXTURES: &[(&str, &str)] = &[
        ("", ""),
        ("a\nb\n", "a\nb\n"),
        ("", "a\nb\n"),
        ("a\nb\nc\n", ""),
        ("a\nb\nc\n", "A\nb\nC\n"),
        ("a\nb\nc\nd\n", "a\nX\nc\nd\n"),
        ("a\nb\nc\nd\ne\n", "a\nX\nc\nd\nY\ne\n"),
        ("a\nb\nc\n", "A\nB\nC\nD\nE\n"),
        ("a\nb\nc\nd\ne\n", "A\nB\n"),
        ("😀a\n", "😀b\n"),
        ("a\r\nb\r\n", "a\r\nc\r\n"),
        ("a\n\nb\n", "a\n\nc\n"),
        ("x\n", "x"),
        ("only left\n", "only right\n"),
    ];

    fn options() -> DiffOptions {
        DiffOptions::default()
    }

    fn wire_of(left: &str, right: &str, options: &DiffOptions) -> WireDiff {
        wire_diff(diff(left, right, options))
    }

    /// The aligned grid of a fresh diff, as the old IPC payload carried it.
    fn original_grid(
        left: &str,
        right: &str,
        options: &DiffOptions,
    ) -> Vec<(Option<u32>, Option<u32>, RowKind)> {
        diff(left, right, options)
            .rows
            .iter()
            .map(|row| (row.left, row.right, row.kind))
            .collect()
    }

    /// The row grid re-derived purely from `hunks`, mirroring
    /// [`litediff_core::align::pair_block`]: pair `min(del, ins)` rows as
    /// `Modify`, then pad the longer side.
    fn derived_grid(wire: &WireDiff) -> Vec<(Option<u32>, Option<u32>, RowKind)> {
        let mut rows = Vec::with_capacity(wire.row_count() as usize);
        for hunk in &wire.hunks {
            if hunk.equal {
                for i in 0..hunk.row_len {
                    rows.push((
                        Some(hunk.left_start + i),
                        Some(hunk.right_start + i),
                        RowKind::Equal,
                    ));
                }
                continue;
            }
            let paired = hunk.left_len.min(hunk.right_len);
            for i in 0..paired {
                rows.push((
                    Some(hunk.left_start + i),
                    Some(hunk.right_start + i),
                    RowKind::Modify,
                ));
            }
            for i in paired..hunk.left_len {
                rows.push((Some(hunk.left_start + i), None, RowKind::Delete));
            }
            for i in paired..hunk.right_len {
                rows.push((None, Some(hunk.right_start + i), RowKind::Insert));
            }
        }
        rows
    }

    fn triples(values: &[u32]) -> Vec<(u32, u32, u32)> {
        assert_eq!(values.len() % 3, 0, "incomplete triple list: {values:?}");
        values
            .chunks_exact(3)
            .map(|chunk| (chunk[0], chunk[1], chunk[2]))
            .collect()
    }

    fn assert_triples_ascending(values: &[u32]) {
        let mut previous: Option<(u32, u32)> = None;
        for (row, start, end) in triples(values) {
            assert!(end >= start, "negative range in {values:?}");
            if let Some((last_row, last_start)) = previous {
                assert!(
                    (row, start) > (last_row, last_start),
                    "triples must ascend by row then start: {values:?}"
                );
            }
            previous = Some((row, start));
        }
    }

    /// Reference conversion from the original inline segments, used to check
    /// the backend extraction independently of its implementation.
    fn expected_changed(rows: &[AlignedRow], left_side: bool) -> Vec<u32> {
        let mut out = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            if row.kind != RowKind::Modify {
                continue;
            }
            let segments = if left_side {
                &row.left_inline
            } else {
                &row.right_inline
            };
            let mut offset = 0u32;
            for segment in segments {
                let utf16_len = segment.text.encode_utf16().count() as u32;
                if segment.changed {
                    out.extend_from_slice(&[index as u32, offset, offset + utf16_len]);
                }
                offset += utf16_len;
            }
        }
        out
    }

    #[test]
    fn empty_documents_produce_an_empty_payload() {
        let wire = wire_of("", "", &options());
        assert_eq!(wire.left_line_count, 0);
        assert_eq!(wire.right_line_count, 0);
        assert!(wire.hunks.is_empty());
        assert_eq!(wire.stats, DiffStats::default());
        assert_eq!(wire.row_count(), 0);
        assert!(wire.is_identical());
        assert!(wire.left_changed.is_empty());
        assert!(wire.right_changed.is_empty());
    }

    #[test]
    fn identical_documents_are_identical_without_changed_ranges() {
        let wire = wire_of("a\nb\n", "a\nb\n", &options());
        assert_eq!(wire.row_count(), 2);
        assert_eq!(wire.hunks.len(), 1);
        assert!(wire.hunks[0].equal);
        assert_eq!(wire.stats.unchanged, 2);
        assert!(wire.is_identical());
        assert!(wire.left_changed.is_empty());
        assert!(wire.right_changed.is_empty());
        assert_eq!(
            derived_grid(&wire),
            original_grid("a\nb\n", "a\nb\n", &options())
        );
    }

    #[test]
    fn pure_insertion_produces_insert_rows_only() {
        let wire = wire_of("", "a\nb\n", &options());
        assert_eq!(wire.left_line_count, 0);
        assert_eq!(wire.right_line_count, 2);
        assert_eq!(wire.stats.added, 2);
        assert_eq!(wire.stats.deleted, 0);
        assert_eq!(wire.stats.modified, 0);
        assert_eq!(wire.row_count(), 2);
        assert!(!wire.is_identical());
        assert!(wire.left_changed.is_empty());
        assert!(wire.right_changed.is_empty());
        let kinds: Vec<RowKind> = derived_grid(&wire).into_iter().map(|row| row.2).collect();
        assert_eq!(kinds, vec![RowKind::Insert, RowKind::Insert]);
        assert_eq!(derived_grid(&wire), original_grid("", "a\nb\n", &options()));
    }

    #[test]
    fn pure_deletion_produces_delete_rows_only() {
        let wire = wire_of("a\nb\nc\n", "", &options());
        assert_eq!(wire.left_line_count, 3);
        assert_eq!(wire.right_line_count, 0);
        assert_eq!(wire.stats.deleted, 3);
        assert_eq!(wire.stats.added, 0);
        assert_eq!(wire.stats.modified, 0);
        assert_eq!(wire.row_count(), 3);
        assert!(!wire.is_identical());
        assert!(wire.left_changed.is_empty());
        assert!(wire.right_changed.is_empty());
        let kinds: Vec<RowKind> = derived_grid(&wire).into_iter().map(|row| row.2).collect();
        assert_eq!(
            kinds,
            vec![RowKind::Delete, RowKind::Delete, RowKind::Delete]
        );
        assert_eq!(
            derived_grid(&wire),
            original_grid("a\nb\nc\n", "", &options())
        );
    }

    #[test]
    fn modify_rows_pair_then_pad_both_sides() {
        let options = options();

        let inserted = wire_of("a\nb\nc\n", "A\nB\nC\nD\nE\n", &options);
        assert_eq!(inserted.stats.modified, 3);
        assert_eq!(inserted.stats.added, 2);
        assert_eq!(inserted.stats.deleted, 0);
        assert_eq!(inserted.row_count(), 5);
        let kinds: Vec<RowKind> = derived_grid(&inserted)
            .into_iter()
            .map(|row| row.2)
            .collect();
        assert_eq!(
            kinds,
            vec![
                RowKind::Modify,
                RowKind::Modify,
                RowKind::Modify,
                RowKind::Insert,
                RowKind::Insert
            ]
        );
        assert_eq!(
            derived_grid(&inserted),
            original_grid("a\nb\nc\n", "A\nB\nC\nD\nE\n", &options)
        );

        let deleted = wire_of("a\nb\nc\nd\ne\n", "A\nB\n", &options);
        assert_eq!(deleted.stats.modified, 2);
        assert_eq!(deleted.stats.deleted, 3);
        assert_eq!(deleted.stats.added, 0);
        assert_eq!(deleted.row_count(), 5);
        let kinds: Vec<RowKind> = derived_grid(&deleted)
            .into_iter()
            .map(|row| row.2)
            .collect();
        assert_eq!(
            kinds,
            vec![
                RowKind::Modify,
                RowKind::Modify,
                RowKind::Delete,
                RowKind::Delete,
                RowKind::Delete
            ]
        );
        assert_eq!(
            derived_grid(&deleted),
            original_grid("a\nb\nc\nd\ne\n", "A\nB\n", &options)
        );
    }

    #[test]
    fn hunks_tile_the_derived_rows() {
        for &(left, right) in FIXTURES {
            let wire = wire_of(left, right, &options());
            let mut expected_start = 0u32;
            for (index, hunk) in wire.hunks.iter().enumerate() {
                assert_eq!(
                    hunk.row_start, expected_start,
                    "fixture {left:?} vs {right:?}: hunk {index} must start where the last ended"
                );
                assert!(
                    hunk.row_len > 0,
                    "fixture {left:?} vs {right:?}: empty hunk {index}"
                );
                expected_start += hunk.row_len;
            }
            assert_eq!(
                expected_start,
                wire.row_count(),
                "fixture {left:?} vs {right:?}: hunk lengths must sum to row_count"
            );
        }
    }

    #[test]
    fn derived_grid_and_changed_ranges_match_the_original_alignment() {
        let options = options();
        for &(left, right) in FIXTURES {
            let result = diff(left, right, &options);
            let expected_rows: Vec<(Option<u32>, Option<u32>, RowKind)> = result
                .rows
                .iter()
                .map(|row| (row.left, row.right, row.kind))
                .collect();
            let expected_left = expected_changed(&result.rows, true);
            let expected_right = expected_changed(&result.rows, false);

            let wire = wire_diff(result);
            let label = format!("{left:?} vs {right:?}");
            assert_eq!(derived_grid(&wire), expected_rows, "row grid: {label}");
            assert_eq!(wire.row_count() as usize, expected_rows.len(), "{label}");
            assert_eq!(wire.left_changed, expected_left, "left changes: {label}");
            assert_eq!(wire.right_changed, expected_right, "right changes: {label}");
            assert_triples_ascending(&wire.left_changed);
            assert_triples_ascending(&wire.right_changed);
        }
    }

    #[test]
    fn changed_offsets_are_utf16_code_units_after_non_bmp_text() {
        let wire = wire_of("😀a\n", "😀b\n", &options());
        assert_eq!(wire.stats.modified, 1);
        // "😀" occupies two UTF-16 code units, so "a"/"b" starts at offset 2.
        assert_eq!(triples(&wire.left_changed), vec![(0, 2, 3)]);
        assert_eq!(triples(&wire.right_changed), vec![(0, 2, 3)]);
    }

    #[test]
    fn intra_line_disabled_emits_no_changed_ranges() {
        let options = DiffOptions {
            intra_line: false,
            ..DiffOptions::default()
        };
        let wire = wire_of("😀a\n", "😀b\n", &options);
        assert_eq!(wire.stats.modified, 1);
        assert_eq!(wire.row_count(), 1);
        assert!(wire.left_changed.is_empty());
        assert!(wire.right_changed.is_empty());
        assert_eq!(
            derived_grid(&wire),
            original_grid("😀a\n", "😀b\n", &options)
        );
    }

    #[test]
    fn whole_line_changed_fallback_is_one_utf16_range() {
        let options = DiffOptions {
            intra_line_max_tokens: 2,
            ..DiffOptions::default()
        };
        let wire = wire_of("😀abc\n", "😀abd\n", &options);
        assert_eq!(wire.stats.modified, 1);
        // The token budget is exceeded, so the whole line is one changed segment.
        assert_eq!(triples(&wire.left_changed), vec![(0, 0, 5)]);
        assert_eq!(triples(&wire.right_changed), vec![(0, 0, 5)]);
    }

    #[test]
    fn stats_and_approximate_pass_through_unchanged() {
        let result = DiffResult {
            left_line_count: 4,
            right_line_count: 3,
            rows: vec![AlignedRow {
                left: Some(0),
                right: Some(0),
                kind: RowKind::Modify,
                left_inline: vec![
                    InlineSegment {
                        text: "ab".to_string(),
                        char_start: 0,
                        char_end: 2,
                        changed: false,
                    },
                    InlineSegment {
                        text: "c".to_string(),
                        char_start: 2,
                        char_end: 3,
                        changed: true,
                    },
                ],
                right_inline: vec![
                    InlineSegment {
                        text: "ab".to_string(),
                        char_start: 0,
                        char_end: 2,
                        changed: false,
                    },
                    InlineSegment {
                        text: "d".to_string(),
                        char_start: 2,
                        char_end: 3,
                        changed: true,
                    },
                ],
            }],
            hunks: vec![Hunk {
                equal: false,
                left_start: 0,
                left_len: 4,
                right_start: 0,
                right_len: 3,
                row_start: 0,
                row_len: 1,
            }],
            stats: DiffStats {
                added: 1,
                deleted: 2,
                modified: 1,
                unchanged: 0,
            },
            approximate: true,
        };

        let wire = wire_diff(result);
        assert!(wire.approximate);
        assert_eq!(
            wire.stats,
            DiffStats {
                added: 1,
                deleted: 2,
                modified: 1,
                unchanged: 0,
            }
        );
        assert_eq!(wire.left_line_count, 4);
        assert_eq!(wire.right_line_count, 3);
        assert_eq!(triples(&wire.left_changed), vec![(0, 2, 3)]);
        assert_eq!(triples(&wire.right_changed), vec![(0, 2, 3)]);
    }

    #[test]
    fn serialized_payload_uses_snake_case_fields_and_omits_rows() {
        let wire = wire_of("a\nb\n", "a\nc\n", &options());
        let value = serde_json::to_value(&wire).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "approximate",
                "hunks",
                "left_changed",
                "left_line_count",
                "right_changed",
                "right_line_count",
                "stats",
            ]
        );
        assert!(!object.contains_key("rows"));

        let hunk = object["hunks"][0].as_object().unwrap();
        for key in [
            "equal",
            "left_start",
            "left_len",
            "right_start",
            "right_len",
            "row_start",
            "row_len",
        ] {
            assert!(hunk.contains_key(key), "hunk field {key} missing");
        }
        let stats = object["stats"].as_object().unwrap();
        for key in ["added", "deleted", "modified", "unchanged"] {
            assert!(stats.contains_key(key), "stats field {key} missing");
        }
    }
}
