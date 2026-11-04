//! Tauri v2 backend for LiteDiff.
//!
//! Responsibilities are deliberately narrow: file IO, session bookkeeping, and
//! running the diff on a worker thread so the window stays responsive. All
//! comparison logic lives in `litediff-core`.
//!
//! ## Why the whole `rows` array goes over IPC
//!
//! Step 2 renders the full aligned result in one payload. For the target file
//! sizes (tens of thousands of lines) the JSON is a couple of megabytes and
//! arrives in a single structured-clone hop, which keeps the frontend stateless:
//! no request/reply per viewport, no stale-window bookkeeping, and scrolling
//! never awaits the backend. Virtualisation then happens purely in the DOM.

pub mod commands;
pub mod git;
pub mod history;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use litediff_core::{DiffOptions, DiffResult, LineAlgorithm, SourceText};
use serde::{Deserialize, Serialize};

/// Where a side came from, when it came from a git revision rather than a file.
///
/// The UI needs three things: which repository, which revision, and whether the
/// content is editable. A historical blob is immutable, and the guard is
/// structural rather than a flag: such a side has `path: None`, so `⌘S` finds no
/// target and reports "没有可保存的文件" instead of replacing today's file with an
/// old version. `editable` is carried anyway so the editor can disable itself
/// up front rather than failing on exit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOrigin {
    /// Absolute path of the repository root.
    pub repo: String,
    /// Resolved revision, or [`git::WORKTREE`].
    pub rev: String,
    /// Path of the file relative to `repo`, forward slashes.
    pub file: String,
    /// Short label for the revision, e.g. `a1b2c3d` or `工作区`.
    pub short: String,
    /// True only for the working tree: the sole writable git origin.
    pub writable: bool,
}

/// One side of the comparison.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Side {
    /// Absolute path on disk, if this side came from a file on disk.
    ///
    /// `None` for a pasted block *and* for a historical git blob: neither is a
    /// place `⌘S` may write.
    pub path: Option<String>,
    /// Display name for the tab / toolbar.
    pub label: String,
    /// Full text content.
    pub text: String,
    /// Present when the text came from a git revision.
    #[serde(default)]
    pub git: Option<GitOrigin>,
}

/// Everything the UI needs to render one comparison, in one payload.
#[derive(Clone, Debug, Serialize)]
pub struct Session {
    pub left: Side,
    pub right: Side,
    pub result: DiffResult,
    pub options: DiffOptions,
    /// Non-fatal notes, e.g. "binary file decoded as UTF-8 (lossy)".
    pub warnings: Vec<String>,
}

/// UI-facing options. Kept separate from [`DiffOptions`] so the frontend can
/// send a partial object and let the backend fill defaults.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionsPatch {
    pub algorithm: Option<String>,
    pub ignore_whitespace: Option<bool>,
    pub ignore_all_whitespace: Option<bool>,
    pub ignore_case: Option<bool>,
    pub intra_line: Option<bool>,
}

impl OptionsPatch {
    /// Fold a partial UI patch onto a base config.
    pub fn apply_to(&self, base: &DiffOptions) -> DiffOptions {
        let mut out = base.clone();
        if let Some(algo) = &self.algorithm {
            out.algorithm = match algo.as_str() {
                "patience" => LineAlgorithm::Patience,
                _ => LineAlgorithm::Myers,
            };
        }
        if let Some(v) = self.ignore_whitespace {
            out.ignore_whitespace = v;
        }
        if let Some(v) = self.ignore_all_whitespace {
            out.ignore_all_whitespace = v;
        }
        if let Some(v) = self.ignore_case {
            out.ignore_case = v;
        }
        if let Some(v) = self.intra_line {
            out.intra_line = v;
        }
        out
    }
}

/// App-wide mutable state: the two documents and the active options.
///
/// Holding the [`SourceText`] here (not just the raw string) means a re-diff on
/// an option toggle skips re-splitting both buffers.
#[derive(Default)]
pub struct AppState {
    left_text: Mutex<Option<SourceText>>,
    right_text: Mutex<Option<SourceText>>,
    left_side: Mutex<Option<Side>>,
    right_side: Mutex<Option<Side>>,
    options: Mutex<DiffOptions>,
}

impl AppState {
    pub fn options(&self) -> DiffOptions {
        self.options.lock().expect("options mutex").clone()
    }

    pub fn set_options(&self, options: DiffOptions) {
        *self.options.lock().expect("options mutex") = options;
    }

    pub fn set_side(&self, which: SideKind, side: Side) {
        let source = SourceText::new(side.text.clone());
        match which {
            SideKind::Left => {
                *self.left_text.lock().expect("left text") = Some(source);
                *self.left_side.lock().expect("left side") = Some(side);
            }
            SideKind::Right => {
                *self.right_text.lock().expect("right text") = Some(source);
                *self.right_side.lock().expect("right side") = Some(side);
            }
        }
    }

    fn side(&self, which: SideKind) -> Side {
        let lock = match which {
            SideKind::Left => self.left_side.lock().expect("left side"),
            SideKind::Right => self.right_side.lock().expect("right side"),
        };
        lock.clone().unwrap_or_default()
    }

    /// Diff the current documents with the current options.
    pub fn diff(&self) -> Session {
        let left_src = self.left_text.lock().expect("left text");
        let right_src = self.right_text.lock().expect("right text");
        let options = self.options();

        let (left, right, result) = match (left_src.as_ref(), right_src.as_ref()) {
            (Some(l), Some(r)) => (
                self.side(SideKind::Left),
                self.side(SideKind::Right),
                litediff_core::diff_sources(l, r, &options),
            ),
            // A one-sided session is normal mid-drag: show the side we have and
            // treat the other as empty rather than erroring.
            (Some(l), None) => {
                let empty = SourceText::default();
                let side = self.side(SideKind::Left);
                (
                    side,
                    Side::default(),
                    litediff_core::diff_sources(l, &empty, &options),
                )
            }
            (None, Some(r)) => {
                let empty = SourceText::default();
                let side = self.side(SideKind::Right);
                (
                    Side::default(),
                    side,
                    litediff_core::diff_sources(&empty, r, &options),
                )
            }
            (None, None) => (
                Side::default(),
                Side::default(),
                litediff_core::diff("", "", &options),
            ),
        };

        Session {
            left,
            right,
            result,
            options,
            warnings: Vec::new(),
        }
    }
}

#[derive(Clone, Copy)]
pub enum SideKind {
    Left,
    Right,
}

/// Decode a file as UTF-8, tolerating a BOM and reporting lossy decodes.
///
/// Returns `(text, warning)`. Binary files are not special-cased yet; the lossy
/// warning is enough to explain a garbled view without failing the drag.
pub fn read_text_file(path: &Path) -> std::io::Result<(String, Option<String>)> {
    let bytes = std::fs::read(path)?;
    let body = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes[..]
    };
    match std::str::from_utf8(body) {
        Ok(s) => Ok((s.to_string(), None)),
        Err(_) => Ok((
            String::from_utf8_lossy(body).into_owned(),
            Some("file is not valid UTF-8; shown with replacement characters".to_string()),
        )),
    }
}

/// Write text back to a path, atomically (temp file + rename).
///
/// `Cmd + S` overwriting an open document must never leave a truncated file if
/// the process dies mid-write.
pub fn write_text_file(path: &Path, text: &str) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(
        ".{}.litediff-tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("document")
    ));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Directory expansion for folder drops: returns text files directly inside it.
pub fn list_text_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file() {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_patch_only_overrides_present_fields() {
        let base = DiffOptions::default();
        let patch = OptionsPatch {
            ignore_case: Some(true),
            ..Default::default()
        };
        let out = patch.apply_to(&base);
        assert!(out.ignore_case);
        assert_eq!(out.algorithm, base.algorithm);
        assert_eq!(out.intra_line, base.intra_line);
    }

    #[test]
    fn options_patch_maps_algorithm_names() {
        let base = DiffOptions::default();
        let patch = OptionsPatch {
            algorithm: Some("patience".into()),
            ..Default::default()
        };
        assert_eq!(patch.apply_to(&base).algorithm, LineAlgorithm::Patience);

        let patch = OptionsPatch {
            algorithm: Some("myers".into()),
            ..Default::default()
        };
        assert_eq!(patch.apply_to(&base).algorithm, LineAlgorithm::Myers);
    }

    #[test]
    fn empty_state_diffs_to_an_empty_session() {
        let state = AppState::default();
        let session = state.diff();
        assert_eq!(session.result.rows.len(), 0);
        assert!(session.result.is_identical());
    }

    #[test]
    fn one_sided_state_diffs_against_empty() {
        let state = AppState::default();
        state.set_side(
            SideKind::Left,
            Side {
                text: "a\nb\n".into(),
                ..Default::default()
            },
        );
        let session = state.diff();
        assert_eq!(session.result.rows.len(), 2);
        assert_eq!(session.result.stats.deleted, 2);
        assert_eq!(session.left.text, "a\nb\n");
    }

    #[test]
    fn write_text_file_round_trips_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("litediff-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.txt");

        write_text_file(&path, "hello\nworld\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\nworld\n");

        // Overwrite, which is what Cmd+S does on an edited buffer.
        write_text_file(&path, "changed\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "changed\n");

        // The temp file used for the atomic rename must not survive.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("litediff-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_text_file_strips_a_utf8_bom() {
        let dir = std::env::temp_dir().join(format!("litediff-bom-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bom.txt");

        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"abc");
        std::fs::write(&path, bytes).unwrap();

        let (text, warning) = read_text_file(&path).unwrap();
        assert_eq!(text, "abc", "BOM must not become part of the first line");
        assert!(warning.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_text_file_reports_lossy_decoding() {
        let dir = std::env::temp_dir().join(format!("litediff-lossy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bin.dat");
        std::fs::write(&path, [0xFF, 0xFE, 0x00, 0x41]).unwrap();

        let (text, warning) = read_text_file(&path).unwrap();
        assert!(!text.is_empty());
        assert!(warning.is_some(), "invalid UTF-8 must be surfaced to the UI");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_text_files_returns_only_regular_files_sorted() {
        let dir = std::env::temp_dir().join(format!("litediff-list-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();

        let files = list_text_files(&dir).unwrap();
        let names: Vec<String> = files
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_string))
            .collect();

        assert_eq!(names, vec!["a.txt", "b.txt"], "sorted, no directories");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn toggling_options_rediffs_from_cached_sources() {
        let state = AppState::default();
        state.set_side(SideKind::Left, Side { text: "a\n".into(), ..Default::default() });
        state.set_side(SideKind::Right, Side { text: "a  \n".into(), ..Default::default() });

        let strict = state.diff();
        assert!(!strict.result.is_identical());

        state.set_options(DiffOptions {
            ignore_whitespace: true,
            ..DiffOptions::default()
        });
        let relaxed = state.diff();
        assert!(relaxed.result.is_identical());

        // The cached source survived the option change.
        assert_eq!(relaxed.left.text, "a\n");
    }
}
