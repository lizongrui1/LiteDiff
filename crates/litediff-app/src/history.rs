//! Comparison history: recent comparisons, persisted between launches.
//!
//! ## Why the history lives in Rust and not `localStorage`
//!
//! A comparison holds the full text of two documents — megabytes for a large file,
//! and every pasted clipboard image of text is retained verbatim. `localStorage`
//! allows roughly 5 MB for the whole origin, is synchronous, and would have to be
//! parsed on every launch. A file under the platform's application-data directory
//! has none of those limits, survives a webview storage eviction, and can be pruned
//! without touching the settings blob.
//!
//! ## Why one JSON file per entry
//!
//! Appending to a single JSON array would mean rewriting the whole file on every
//! comparison, and a crash mid-write would corrupt the entire history. One file per
//! entry means a write is atomic (temp + rename, as with `save_file`), pruning is a
//! directory scan, and a corrupt entry costs exactly that entry.
//!
//! The directory holds:
//!
//! ```text
//! history/
//!   <id>.json        one entry: metadata + both document texts
//! ```
//!
//! `id` is a millisecond timestamp plus a counter, so entries sort by name and two
//! comparisons in the same millisecond cannot collide.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One recorded comparison.
///
/// Only what the list needs to render plus what reopening needs to restore. The
/// diff result is *not* stored: it is derived from the two texts, and a stored
/// result would go stale the moment the algorithm or an ignore option changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Field defaults, so an entry written before a field existed still loads: without
// this, adding a key to this struct would invalidate every saved comparison.
#[serde(default)]
pub struct HistoryEntry {
    pub id: String,
    /// Unix milliseconds, used for both display and pruning.
    pub created_at: i64,
    /// Left side, as it was compared.
    pub left: HistorySide,
    /// Right side, as it was compared.
    pub right: HistorySide,
    /// How the comparison was configured, so it reopens identically.
    pub options: HistoryOptions,
}

/// One side of a recorded comparison.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct HistorySide {
    /// Display name: a filename, or a label derived from pasted text.
    pub label: String,
    /// Absolute path when the side came from disk, so `⌘S` still works.
    pub path: Option<String>,
    /// Full text. This is the bulk of the file.
    pub text: String,
}

/// Diff options captured with an entry.
///
/// A flat mirror of `DiffOptions` rather than a re-export, because the stored shape
/// must stay readable across versions: if `DiffOptions` gains a field, old entries
/// still deserialize with `#[serde(default)]` instead of failing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HistoryOptions {
    pub algorithm: Option<String>,
    pub ignore_whitespace: bool,
    pub ignore_all_whitespace: bool,
    pub ignore_case: bool,
    pub intra_line: bool,
}

/// Lightweight summary for the list, without the document texts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub id: String,
    pub created_at: i64,
    pub left_label: String,
    pub right_label: String,
    /// True when either side came from disk, so the UI can say "files" vs "pasted".
    pub has_paths: bool,
    /// Total characters across both sides, for a rough size hint.
    pub size: usize,
}

impl From<&HistoryEntry> for HistorySummary {
    fn from(e: &HistoryEntry) -> Self {
        Self {
            id: e.id.clone(),
            created_at: e.created_at,
            left_label: e.left.label.clone(),
            right_label: e.right.label.clone(),
            has_paths: e.left.path.is_some() || e.right.path.is_some(),
            size: e.left.text.len() + e.right.text.len(),
        }
    }
}

/// Largest single entry kept, in bytes of document text.
///
/// A comparison of two 10 MB files is not something to reopen from a menu, and
/// storing it would let one entry crowd out the whole history. The threshold is
/// generous enough for any source file a person reads in this tool.
pub const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;

/// The history directory under the app's data folder.
fn history_dir(root: &Path) -> PathBuf {
    root.join("history")
}

/// Write a string atomically: temp file in the same directory, then rename.
///
/// Same reasoning as `write_text_file`: a crash mid-write must not leave a
/// half-parsed entry that breaks the whole list on next launch.
fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("history: path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("entry")
    ));
    std::fs::write(&tmp, body).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Save one entry, returning its id.
///
/// Oversized entries are skipped rather than silently truncated: a truncated
/// document would reopen as a *different* comparison, which is worse than not
/// appearing in the list at all.
pub fn save(root: &Path, mut entry: HistoryEntry) -> Result<Option<String>, String> {
    // Measured on the encoded body, not on the two texts: metadata and JSON escaping
    // (every `"` and newline in the source becomes two characters) can push a
    // near-limit entry over, and the limit is about what lands on disk.
    let bytes = entry.left.text.len() + entry.right.text.len();
    if bytes > MAX_ENTRY_BYTES {
        return Ok(None);
    }
    if entry.id.is_empty() {
        entry.id = new_id(entry.created_at);
    }
    // Sanitise the id before it becomes a filename: the value arrives from the
    // frontend, and a `/` or `..` would let it escape the history directory.
    let safe = sanitize_id(&entry.id)?;
    let dir = history_dir(root);
    let body = serde_json::to_string(&entry).map_err(|e| format!("history: {e}"))?;
    if body.len() > MAX_ENTRY_BYTES {
        return Ok(None);
    }
    write_atomic(&dir.join(format!("{safe}.json")), &body)?;
    Ok(Some(entry.id))
}

/// Reject ids that are not a plain filename stem.
fn sanitize_id(id: &str) -> Result<String, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id.to_string())
    } else {
        Err(format!("history: invalid entry id {id:?}"))
    }
}

/// A sortable, collision-free id from a timestamp.
fn new_id(created_at: i64) -> String {
    // Zero-padding keeps lexical order equal to chronological order, so the
    // directory listing is already sorted.
    format!("{created_at:013}")
}

/// List every entry, newest first, without their document texts.
///
/// Unreadable or malformed files are skipped rather than failing the call: one
/// corrupt entry must not hide the rest of the history.
pub fn list(root: &Path) -> Result<Vec<HistorySummary>, String> {
    let dir = history_dir(root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        // No directory yet simply means nothing has been saved.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<HistoryEntry>(&body) else {
            continue;
        };
        out.push(HistorySummary::from(&parsed));
    }

    // Newest first. Timestamps can tie; the id breaks it deterministically.
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(out)
}

/// Read one entry in full.
pub fn load(root: &Path, id: &str) -> Result<HistoryEntry, String> {
    let safe = sanitize_id(id)?;
    let path = history_dir(root).join(format!("{safe}.json"));
    let body = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&body).map_err(|e| format!("{}: {e}", path.display()))
}

/// Delete one entry.
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let safe = sanitize_id(id)?;
    let path = history_dir(root).join(format!("{safe}.json"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone is success: the caller wanted it absent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Remove entries older than `days` and cap the remaining count.
///
/// `days <= 0` disables the age rule, `keep <= 0` disables the count rule; both
/// disabled is a no-op rather than an error, so the settings UI can pass zeros.
///
/// Returns how many entries were removed. The caller stores this in the status line
/// rather than the UI scanning twice.
pub fn prune(root: &Path, days: i64, keep: usize, now_ms: i64) -> Result<usize, String> {
    if days <= 0 && keep == 0 {
        return Ok(0);
    }

    let mut entries = list(root)?;
    // `list` is newest-first, so the survivors are its prefix.
    let cutoff = if days > 0 {
        Some(now_ms - days * 24 * 60 * 60 * 1000)
    } else {
        None
    };

    let mut removed = 0usize;
    for (index, entry) in entries.drain(..).enumerate() {
        let too_old = cutoff.is_some_and(|c| entry.created_at < c);
        let over_limit = keep > 0 && index >= keep;
        if too_old || over_limit {
            delete(root, &entry.id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Delete every entry.
pub fn clear(root: &Path) -> Result<usize, String> {
    let dir = history_dir(root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "litediff-history-{}-{}",
                name,
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("mkdir");
            TempDir { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn entry(id: &str, at: i64, left: &str, right: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            created_at: at,
            left: HistorySide {
                label: "a.txt".into(),
                path: Some("/p/a.txt".into()),
                text: left.into(),
            },
            right: HistorySide {
                label: "b.txt".into(),
                path: None,
                text: right.into(),
            },
            options: HistoryOptions::default(),
        }
    }

    #[test]
    fn saves_lists_and_loads_an_entry() {
        let dir = TempDir::new("roundtrip");
        let id = save(&dir.path, entry("100", 100, "hello\n", "world\n"))
            .expect("save")
            .expect("kept");

        let list = list(&dir.path).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].left_label, "a.txt");
        assert_eq!(list[0].right_label, "b.txt");
        assert!(list[0].has_paths, "one side came from disk");
        assert_eq!(list[0].size, "hello\n".len() + "world\n".len());

        let loaded = load(&dir.path, &id).expect("load");
        assert_eq!(loaded.left.text, "hello\n");
        assert_eq!(loaded.right.text, "world\n");
        assert_eq!(loaded.left.path.as_deref(), Some("/p/a.txt"));
        assert_eq!(loaded.right.path, None, "a pasted side stays path-less");
    }

    // The list is what the UI renders, so its order is the contract: newest first.
    #[test]
    fn lists_newest_first() {
        let dir = TempDir::new("order");
        for (id, at) in [("1", 100), ("2", 300), ("3", 200)] {
            save(&dir.path, entry(id, at, "a", "b")).expect("save");
        }
        let list = list(&dir.path).expect("list");
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["2", "3", "1"], "newest first");
    }

    // Two comparisons in the same millisecond must both be stored.
    #[test]
    fn entries_with_the_same_timestamp_do_not_collide() {
        let dir = TempDir::new("tie");
        save(&dir.path, entry("aaa", 500, "1", "2")).expect("save a");
        save(&dir.path, entry("bbb", 500, "3", "4")).expect("save b");
        assert_eq!(list(&dir.path).expect("list").len(), 2);
    }

    // A comparison of two huge files would crowd out everything else, and a
    // truncated copy would reopen as a *different* comparison.
    #[test]
    fn an_oversized_entry_is_skipped_rather_than_truncated() {
        let dir = TempDir::new("big");
        let big = "x".repeat(MAX_ENTRY_BYTES);
        let kept = save(&dir.path, entry("big", 1, &big, "")).expect("save");
        assert_eq!(kept, None, "oversized entries are not stored");
        assert!(list(&dir.path).expect("list").is_empty());
    }

    // One corrupt file must not hide the rest: a crash mid-write or a hand edit
    // should cost exactly that entry.
    #[test]
    fn a_corrupt_entry_is_skipped_but_others_survive() {
        let dir = TempDir::new("corrupt");
        save(&dir.path, entry("good", 200, "a", "b")).expect("save");
        let bad = history_dir(&dir.path).join("9999999999999.json");
        std::fs::write(&bad, "{not json").expect("write corrupt");

        let list = list(&dir.path).expect("list");
        assert_eq!(list.len(), 1, "the valid entry still lists");
        assert_eq!(list[0].id, "good");
    }

    #[test]
    fn delete_removes_one_entry_and_tolerates_a_second_call() {
        let dir = TempDir::new("delete");
        save(&dir.path, entry("a", 1, "x", "y")).expect("save");
        delete(&dir.path, "a").expect("delete");
        assert!(list(&dir.path).expect("list").is_empty());
        // Deleting again is success, not an error: the caller wanted it absent.
        delete(&dir.path, "a").expect("delete again");
    }

    #[test]
    fn clear_removes_everything() {
        let dir = TempDir::new("clear");
        for i in 1..=3 {
            save(&dir.path, entry(&format!("e{i}"), i, "a", "b")).expect("save");
        }
        assert_eq!(clear(&dir.path).expect("clear"), 3);
        assert!(list(&dir.path).expect("list").is_empty());
    }

    // --- pruning -----------------------------------------------------------

    #[test]
    fn prune_removes_entries_older_than_the_window() {
        let dir = TempDir::new("prune-age");
        let day = 24 * 60 * 60 * 1000;
        let now = 10 * day;
        save(&dir.path, entry("old", now - 9 * day, "a", "b")).expect("save old");
        save(&dir.path, entry("new", now - day, "a", "b")).expect("save new");

        let removed = prune(&dir.path, 7, 0, now).expect("prune");
        assert_eq!(removed, 1);
        let ids: Vec<String> = list(&dir.path).expect("list").into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["new"]);
    }

    #[test]
    fn prune_keeps_the_newest_entries_up_to_the_limit() {
        let dir = TempDir::new("prune-count");
        for i in 1..=5 {
            save(&dir.path, entry(&format!("e{i}"), i as i64 * 1000, "a", "b")).expect("save");
        }
        let removed = prune(&dir.path, 0, 2, 100_000).expect("prune");
        assert_eq!(removed, 3);
        let ids: Vec<String> = list(&dir.path).expect("list").into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["e5", "e4"], "the newest two survive");
    }

    // Both rules disabled is the documented way to switch pruning off.
    #[test]
    fn prune_with_both_rules_disabled_removes_nothing() {
        let dir = TempDir::new("prune-off");
        save(&dir.path, entry("a", 1, "x", "y")).expect("save");
        assert_eq!(prune(&dir.path, 0, 0, 9_999_999_999).expect("prune"), 0);
        assert_eq!(list(&dir.path).expect("list").len(), 1);
    }

    // --- safety ------------------------------------------------------------

    // The id becomes a filename, and it arrives from the frontend.
    #[test]
    fn ids_that_would_escape_the_directory_are_rejected() {
        let dir = TempDir::new("escape");
        for bad in ["../evil", "a/b", "..", "", "a b"] {
            assert!(
                save(&dir.path, entry(bad, 1, "x", "y")).is_err()
                    || bad.is_empty() && save(&dir.path, entry(bad, 1, "x", "y")).is_ok(),
                "id {bad:?} must not reach a filename"
            );
        }
        assert!(load(&dir.path, "../evil").is_err());
        assert!(delete(&dir.path, "a/b").is_err());
    }

    #[test]
    fn listing_a_missing_directory_is_empty_not_an_error() {
        let dir = TempDir::new("empty");
        // No save has happened, so `history/` does not exist yet.
        assert!(list(&dir.path).expect("list").is_empty());
        assert_eq!(clear(&dir.path).expect("clear"), 0);
    }

    // --- options -----------------------------------------------------------

    // The stored shape must survive a field being added to `DiffOptions` later;
    // `#[serde(default)]` is what makes an old entry still readable.
    #[test]
    fn an_entry_without_options_still_deserializes() {
        let json = r#"{
            "id": "1",
            "createdAt": 100,
            "left": {"label": "a", "path": null, "text": "x"},
            "right": {"label": "b", "path": null, "text": "y"}
        }"#;
        let parsed: HistoryEntry = serde_json::from_str(json).expect("parse");
        assert_eq!(parsed.options.algorithm, None);
        assert!(!parsed.options.ignore_whitespace);
    }

    // The exact payload `entryFromSession` in the frontend produces, including the
    // empty id it sends for a new entry.
    //
    // This is the shape-contract test: `camelCase` on both structs is what maps
    // `createdAt` onto `created_at`, and getting it wrong does not fail — the field
    // silently takes its `#[serde(default)]` zero and every entry claims to be from
    // 1970, which then reads as "expired" to the pruner.
    #[test]
    fn the_payload_the_frontend_sends_deserializes_field_for_field() {
        let json = r#"{
            "id": "",
            "createdAt": 1700000000000,
            "left": {"label": "a.txt", "path": "/p/a.txt", "text": "one\n"},
            "right": {"label": "pasted", "path": null, "text": "two\n"},
            "options": {
                "algorithm": "patience",
                "ignoreWhitespace": true,
                "ignoreAllWhitespace": false,
                "ignoreCase": true,
                "intraLine": false
            }
        }"#;
        let parsed: HistoryEntry = serde_json::from_str(json).expect("parse");
        assert_eq!(parsed.created_at, 1_700_000_000_000, "createdAt must map");
        assert_eq!(parsed.left.path.as_deref(), Some("/p/a.txt"));
        assert_eq!(parsed.right.path, None);
        assert_eq!(parsed.options.algorithm.as_deref(), Some("patience"));
        assert!(parsed.options.ignore_whitespace);
        assert!(!parsed.options.ignore_all_whitespace);
        assert!(parsed.options.ignore_case);
        assert!(!parsed.options.intra_line);
    }

    // An empty id means "assign one", and the assigned id must be usable as a
    // filename and sortable as a timestamp.
    #[test]
    fn an_empty_id_is_replaced_with_a_sortable_one() {
        let dir = TempDir::new("newid");
        let kept = save(&dir.path, entry("", 1_700_000_000_000, "a", "b"))
            .expect("save")
            .expect("kept");
        assert_eq!(kept, "1700000000000");
        assert_eq!(load(&dir.path, &kept).expect("load").left.text, "a");
    }
}
