//! End-to-end tests over the public API.
//!
//! These are the Step 1 acceptance criteria: the engine must produce a correct,
//! minimal, renderable diff for the kinds of input the UI will actually hand it.

use litediff_core::{diff, DiffOptions, InlineSegment, RowKind, SourceText};

fn myers() -> DiffOptions {
    DiffOptions::default()
}

fn rebuilt_left(result: &litediff_core::DiffResult, left: &str) -> String {
    let src = SourceText::new(left);
    result
        .rows
        .iter()
        .filter_map(|r| r.left)
        .map(|i| src.line_str(i))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rebuilt_right(result: &litediff_core::DiffResult, right: &str) -> String {
    let src = SourceText::new(right);
    result
        .rows
        .iter()
        .filter_map(|r| r.right)
        .map(|i| src.line_str(i))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every row must be justified: at most one side blank, and never both.
fn assert_rows_well_formed(result: &litediff_core::DiffResult) {
    for (i, row) in result.rows.iter().enumerate() {
        assert!(
            row.left.is_some() || row.right.is_some(),
            "row {i} is blank on both sides"
        );
        match row.kind {
            RowKind::Equal | RowKind::Modify => {
                assert!(
                    row.left.is_some() && row.right.is_some(),
                    "row {i}: {row:?}"
                );
            }
            RowKind::Delete => assert!(row.left.is_some() && row.right.is_none()),
            RowKind::Insert => assert!(row.left.is_none() && row.right.is_some()),
        }
    }
}

/// Hunks must tile the rows exactly, in order, with no gaps or overlaps.
fn assert_hunks_tile_rows(result: &litediff_core::DiffResult) {
    let mut expected_start = 0u32;
    for (i, h) in result.hunks.iter().enumerate() {
        assert_eq!(
            h.row_start, expected_start,
            "hunk {i} must start where the last ended"
        );
        assert!(h.row_len > 0, "empty hunk at {i}");
        expected_start += h.row_len;
    }
    assert_eq!(
        expected_start as usize,
        result.rows.len(),
        "hunks must cover every row"
    );
}

/// Applying the alignment must reproduce both documents.
fn assert_roundtrip(result: &litediff_core::DiffResult, left: &str, right: &str) {
    let left_src = SourceText::new(left);
    let right_src = SourceText::new(right);
    let left_lines: Vec<&str> = left_src.line_strs().collect();
    let right_lines: Vec<&str> = right_src.line_strs().collect();

    let rebuilt_l: Vec<&str> = result
        .rows
        .iter()
        .filter_map(|r| r.left)
        .map(|i| left_lines[i as usize])
        .collect();
    let rebuilt_r: Vec<&str> = result
        .rows
        .iter()
        .filter_map(|r| r.right)
        .map(|i| right_lines[i as usize])
        .collect();

    assert_eq!(
        rebuilt_l, left_lines,
        "left side must be preserved in order"
    );
    assert_eq!(
        rebuilt_r, right_lines,
        "right side must be preserved in order"
    );
}

#[test]
fn identical_documents_have_no_changes() {
    let text = "fn main() {\n    println!(\"hi\");\n}\n";
    let result = diff(text, text, &myers());

    assert!(result.is_identical());
    assert_eq!(result.rows.len(), 3);
    assert!(result.change_hunks().next().is_none());
    assert_rows_well_formed(&result);
    assert_hunks_tile_rows(&result);
}

#[test]
fn single_line_modification_is_modify_not_delete_plus_insert() {
    let left = "let x = 1;\n";
    let right = "let x = 2;\n";
    let result = diff(left, right, &myers());

    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].kind, RowKind::Modify);
    assert_eq!(result.stats.modified, 1);
    assert_eq!(result.stats.added, 0);
    assert_eq!(result.stats.deleted, 0);
    assert_eq!(result.stats.summary(), "+0 -0 ~1");
}

#[test]
fn intra_line_segments_pinpoint_the_change() {
    let result = diff("let timeout = 30;\n", "let timeout = 60;\n", &myers());
    let row = &result.rows[0];

    let changed = |segs: &[InlineSegment]| -> String {
        segs.iter()
            .filter(|s| s.changed)
            .map(|s| s.text.as_str())
            .collect()
    };

    assert_eq!(changed(&row.left_inline), "30");
    assert_eq!(changed(&row.right_inline), "60");

    // The segments must reconstruct the full line for the renderer.
    let joined: String = row.right_inline.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(joined, "let timeout = 60;");
}

#[test]
fn insertion_produces_padded_row_on_the_left() {
    let left = "a\nc\n";
    let right = "a\nb\nc\n";
    let result = diff(left, right, &myers());

    assert_eq!(result.stats.added, 1);

    let inserted = result
        .rows
        .iter()
        .find(|r| r.kind == RowKind::Insert)
        .expect("one inserted row");
    assert!(
        inserted.left.is_none(),
        "left cell must be a hatch placeholder"
    );
    assert_eq!(inserted.right, Some(1));
}

#[test]
fn deletion_produces_padded_row_on_the_right() {
    let left = "a\nb\nc\n";
    let right = "a\nc\n";
    let result = diff(left, right, &myers());

    assert_eq!(result.stats.deleted, 1);
    let deleted = result
        .rows
        .iter()
        .find(|r| r.kind == RowKind::Delete)
        .expect("one deleted row");
    assert!(deleted.right.is_none());
}

#[test]
fn replacement_block_pairs_then_pads() {
    // Two lines replaced by one: one Modify row plus one padded Delete row.
    let left = "x\na\nb\ny\n";
    let right = "x\nc\ny\n";
    let result = diff(left, right, &myers());

    let kinds: Vec<RowKind> = result.rows.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        vec![
            RowKind::Equal,
            RowKind::Modify,
            RowKind::Delete,
            RowKind::Equal
        ]
    );
    assert_eq!(result.stats.modified, 1);
    assert_eq!(result.stats.deleted, 1);
}

#[test]
fn both_sides_roundtrip_for_a_realistic_file() {
    let left = "import a\nimport b\n\nfn one() {\n    a();\n}\n\nfn two() {\n    b();\n}\n";
    let right = "import a\nimport c\n\nfn one() {\n    a2();\n}\n\nfn two() {\n    b();\n}\n";

    let result = diff(left, right, &myers());
    assert_rows_well_formed(&result);
    assert_hunks_tile_rows(&result);
    assert_roundtrip(&result, left, right);
    assert_eq!(rebuilt_left(&result, left), left.trim_end());
    assert_eq!(rebuilt_right(&result, right), right.trim_end());
}

#[test]
fn pure_insertion_into_empty_file() {
    let result = diff("", "a\nb\n", &myers());
    assert_eq!(result.rows.len(), 2);
    assert!(result.rows.iter().all(|r| r.kind == RowKind::Insert));
    assert_eq!(result.left_line_count, 0);
    assert_eq!(result.stats.added, 2);
}

#[test]
fn deletions_to_empty_file() {
    let result = diff("a\nb\n", "", &myers());
    assert_eq!(result.rows.len(), 2);
    assert!(result.rows.iter().all(|r| r.kind == RowKind::Delete));
    assert_eq!(result.stats.deleted, 2);
}

#[test]
fn ignore_whitespace_collapses_indentation_only_changes() {
    let left = "fn a() {\n    x();\n}\n";
    let right = "fn a() {\n        x();\n}\n";

    let strict = diff(left, right, &myers());
    assert_eq!(strict.stats.modified, 1);

    let relaxed = diff(
        left,
        right,
        &DiffOptions {
            ignore_all_whitespace: true,
            ..myers()
        },
    );
    assert!(relaxed.is_identical(), "indentation must be ignorable");
}

#[test]
fn ignore_case_is_available() {
    let left = "Foo\nBar\n";
    let right = "foo\nbar\n";
    let opts = DiffOptions {
        ignore_case: true,
        ..myers()
    };
    assert!(diff(left, right, &opts).is_identical());
}

#[test]
fn change_hunks_are_navigable() {
    // Cmd+] / Cmd+[ walk change_hunks(); they must be ordered and clickable.
    let left = "a\nb\nc\nd\ne\nf\n";
    let right = "a\nB\nc\nd\nE\nf\n";
    let result = diff(left, right, &myers());

    let hunks: Vec<_> = result.change_hunks().collect();
    assert_eq!(hunks.len(), 2);

    let mut prev_row = 0;
    for h in &hunks {
        assert!(h.row_start >= prev_row);
        prev_row = h.row_start;
        assert!(h.row_len > 0);
        // Every change hunk must be locatable by row for the minimap.
        assert_eq!(
            result.hunk_at_row(h.row_start).map(|i| &result.hunks[i]),
            Some(*h)
        );
    }
}

#[test]
fn hunk_lookup_outside_any_hunk_returns_none() {
    let result = diff("a\n", "a\n", &myers());
    assert_eq!(
        result.hunk_at_row(0).map(|i| result.hunks[i].equal),
        Some(true)
    );
    assert!(result.hunk_at_row(99).is_none());
}

#[test]
fn large_file_diff_is_fast_and_correct() {
    // 20k lines with 50 scattered edits: this is where an O(N*M) DP would die.
    let mut left = String::new();
    for i in 0..20_000 {
        left.push_str(&format!("line {i} some content\n"));
    }
    let mut right = String::new();
    for i in 0..20_000 {
        if i % 400 == 0 {
            right.push_str(&format!("line {i} CHANGED content\n"));
        } else {
            right.push_str(&format!("line {i} some content\n"));
        }
    }

    let start = std::time::Instant::now();
    let result = diff(&left, &right, &myers());
    let elapsed = start.elapsed();

    assert_eq!(result.stats.modified, 50, "exactly 50 changed lines");
    assert!(!result.is_identical());
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "diff took {elapsed:?}, too slow for the cold-start target"
    );
}

#[test]
fn unmatched_unicode_lines_do_not_panic() {
    let left = "你好，世界\n第二行\n";
    let right = "你好，世界！\n第二行\n第三行\n";
    let result = diff(left, right, &myers());

    assert_rows_well_formed(&result);
    assert_roundtrip(&result, left, right);
    let row = &result.rows[0];
    assert_eq!(row.kind, RowKind::Modify);
    let changed: String = row
        .right_inline
        .iter()
        .filter(|s| s.changed)
        .map(|s| s.text.as_str())
        .collect();
    assert_eq!(changed, "！");
}

#[test]
fn crlf_and_lf_are_treated_as_equal_text() {
    let result = diff("a\r\nb\r\n", "a\nb\n", &myers());
    assert!(result.is_identical());
    assert_eq!(result.left_line_count, 2);
    assert_eq!(result.right_line_count, 2);
}

#[test]
fn intra_line_can_be_disabled_for_performance() {
    let result = diff(
        "let x = 1;\n",
        "let x = 2;\n",
        &DiffOptions {
            intra_line: false,
            ..myers()
        },
    );
    assert!(result.rows[0].left_inline.is_empty());
    assert!(result.rows[0].right_inline.is_empty());
    assert_eq!(result.rows[0].kind, RowKind::Modify);
}

#[test]
fn diff_is_deterministic() {
    let left = "a\nb\nc\nd\ne\n";
    let right = "a\nc\nb\nd\nf\n";
    let first = diff(left, right, &myers());
    let second = diff(left, right, &myers());
    assert_eq!(first.rows, second.rows);
    assert_eq!(first.hunks, second.hunks);
}
