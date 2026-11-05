//! Tauri command surface.
//!
//! Every command is `async` and hands CPU-heavy work to the blocking pool, so a
//! 20k-line diff never blocks the webview's IPC thread.

use std::path::PathBuf;

use litediff_core::DiffOptions;
use tauri::State;

use crate::{
    list_text_files, read_text_file, write_text_file, AppState, OptionsPatch, Session, Side,
    SideKind,
};

/// A dropped item, resolved on the backend (drops cannot read paths in the
/// webview sandbox).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSide {
    pub side: Side,
    pub warnings: Vec<String>,
}

/// Read one file into a side without touching the session.
///
/// Lets the frontend show a filename and preview before committing to a diff.
#[tauri::command]
pub async fn load_file(path: String) -> Result<LoadedSide, String> {
    let p = PathBuf::from(&path);
    let (text, warning) = read_text_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;

    let label = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path)
        .to_string();

    Ok(LoadedSide {
        side: Side {
            path: Some(path),
            label,
            text,
            // Loaded straight from disk, so there is no revision context.
            git: None,
        },
        warnings: warning.into_iter().collect(),
    })
}

/// Assign text to one side and re-run the diff.
///
/// This is the single entry point used by file drops, clipboard paste, and
/// in-place editing: the frontend never sends a diff request without content.
#[tauri::command]
pub async fn set_side(
    state: State<'_, AppState>,
    side: String,
    side_data: Side,
) -> Result<Session, String> {
    let which = match side.as_str() {
        "left" => SideKind::Left,
        "right" => SideKind::Right,
        other => return Err(format!("unknown side: {other}")),
    };
    state.set_side(which, side_data);
    Ok(state.diff())
}

/// Assign text to both sides in one call and re-run the diff.
///
/// The paste screen commits a pair of blocks, so a single command is the honest
/// model: two `set_side` calls would each trigger a full diff, and the frontend
/// would briefly hold a session where only one side has content — enough to
/// unmount the paste screen and discard the other block.
///
/// A side whose text is empty is still assigned: "compare this against nothing"
/// is a legitimate request, and skipping it would silently reuse a stale buffer.
#[tauri::command]
pub async fn set_both(
    state: State<'_, AppState>,
    left: Side,
    right: Side,
) -> Result<Session, String> {
    state.set_side(SideKind::Left, left);
    state.set_side(SideKind::Right, right);
    Ok(state.diff())
}

/// Re-diff using the current documents, applying an optional options patch.
///
/// Used by `Cmd + Shift + W` (ignore whitespace) and the sidebar toggles.
#[tauri::command]
pub async fn rediff(
    state: State<'_, AppState>,
    patch: Option<OptionsPatch>,
) -> Result<Session, String> {
    if let Some(patch) = patch {
        let base = state.options();
        state.set_options(patch.apply_to(&base));
    }
    Ok(state.diff())
}

/// Reset both sides.
#[tauri::command]
pub async fn clear(state: State<'_, AppState>) -> Result<Session, String> {
    state.set_side(SideKind::Left, Side::default());
    state.set_side(SideKind::Right, Side::default());
    state.set_options(DiffOptions::default());
    Ok(state.diff())
}

/// Options that travel with a tab.
///
/// Sent back when a tab is restored so the backend's documents and the frontend's
/// active tab agree. Without it, a `rediff` after switching tabs would run against
/// the *previous* tab's documents.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncOptions {
    pub ignore_whitespace: Option<bool>,
    pub ignore_all_whitespace: Option<bool>,
    pub ignore_case: Option<bool>,
    pub intra_line: Option<bool>,
}

impl SyncOptions {
    /// Fold onto a base config, mirroring [`OptionsPatch::apply_to`].
    fn apply_to(&self, base: &DiffOptions) -> DiffOptions {
        OptionsPatch {
            ignore_whitespace: self.ignore_whitespace,
            ignore_all_whitespace: self.ignore_all_whitespace,
            ignore_case: self.ignore_case,
            intra_line: self.intra_line,
        }
        .apply_to(base)
    }
}

/// Adopt a tab's documents and options without computing a diff.
///
/// Tabs hold their own `Session`, so switching one is a frontend operation. But the
/// backend also caches the documents, and every later `rediff` (option toggle,
/// `⌘⇧W`) runs against *that* copy. Syncing on switch keeps the two from drifting:
/// without it, toggling "ignore whitespace" right after switching tabs would
/// silently re-diff the tab you left.
///
/// Returning `()` rather than a `Session` is deliberate — the caller already holds
/// the session it is restoring, and re-sending a multi-megabyte payload only to
/// discard it would make tab switching feel like a reload.
#[tauri::command]
pub async fn sync_session(
    state: State<'_, AppState>,
    left: Side,
    right: Side,
    options: SyncOptions,
) -> Result<(), String> {
    state.set_side(SideKind::Left, left);
    state.set_side(SideKind::Right, right);
    let base = state.options();
    state.set_options(options.apply_to(&base));
    Ok(())
}

/// Persist an edited buffer back to its path (`Cmd + S`).
#[tauri::command]
pub async fn save_file(path: String, text: String) -> Result<(), String> {
    write_text_file(&PathBuf::from(&path), &text).map_err(|e| format!("{path}: {e}"))
}

/// Describe a dropped path: is it a directory, and if so what is inside it?
///
/// A drop gives the frontend a `File` with no dependable way to tell a folder
/// from an extension-less file, so the decision is made here where the filesystem
/// can answer it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPath {
    pub is_dir: bool,
    /// Regular files directly inside it, sorted; empty for a file path.
    pub files: Vec<String>,
}

/// Inspect a dropped path.
#[tauri::command]
pub async fn inspect_path(path: String) -> Result<DroppedPath, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;

    if !meta.is_dir() {
        return Ok(DroppedPath {
            is_dir: false,
            files: Vec::new(),
        });
    }

    let files = list_text_files(&p)
        .map_err(|e| format!("{path}: {e}"))?
        .into_iter()
        .filter_map(|f| f.to_str().map(str::to_string))
        .collect();

    Ok(DroppedPath {
        is_dir: true,
        files,
    })
}

/// Expand a dropped directory into its files.
#[tauri::command]
pub async fn expand_directory(path: String) -> Result<Vec<String>, String> {
    let files = list_text_files(&PathBuf::from(&path)).map_err(|e| format!("{path}: {e}"))?;
    Ok(files
        .into_iter()
        .filter_map(|p| p.to_str().map(str::to_string))
        .collect())
}

// --- git ---------------------------------------------------------------

/// One side of a git comparison, as chosen in the UI.
///
/// `rev` is either a real revision or [`crate::git::WORKTREE`]; resolving that
/// sentinel is the backend's job, so the frontend never has to know that the
/// working tree is read from the filesystem rather than from a blob.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSpec {
    /// Absolute path of the repository root.
    pub repo: String,
    pub rev: String,
    /// Path relative to the repository root.
    pub file: String,
}

impl Side {
    /// Build a side from a resolved blob.
    ///
    /// Only the working tree keeps a `path`: it is the one origin whose content
    /// is a real file the user may still want to save. A historical blob is
    /// deliberately path-less so `⌘S` cannot overwrite today's file with it.
    fn from_git(spec: &GitSpec, blob: crate::git::GitBlob) -> Side {
        let writable = spec.rev == crate::git::WORKTREE;
        let short = if writable {
            "工作区".to_string()
        } else {
            blob.label
                .split(" · ")
                .next()
                .unwrap_or(&spec.rev)
                .to_string()
        };

        Side {
            path: writable.then(|| {
                PathBuf::from(&spec.repo)
                    .join(&spec.file)
                    .to_string_lossy()
                    .into_owned()
            }),
            label: blob.label,
            text: blob.text,
            git: Some(crate::GitOrigin {
                repo: spec.repo.clone(),
                rev: spec.rev.clone(),
                file: spec.file.clone(),
                short,
                writable,
            }),
        }
    }
}

/// Public facts about a path's repository, for the "打开仓库" affordance.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    /// Present only when `is_repo` is true.
    pub repo: Option<crate::git::RepoInfo>,
}

/// Ask whether a path is inside a git work tree, and describe it if so.
///
/// Returning a status object instead of an error keeps "this folder is not a
/// repository" a normal answer, which is what it is when the user drags an
/// arbitrary folder onto the window.
#[tauri::command]
pub async fn git_status(path: String) -> RepoStatus {
    if !crate::git::is_repo(&path) {
        return RepoStatus {
            is_repo: false,
            repo: None,
        };
    }
    match crate::git::resolve_repo(&path) {
        Ok(repo) => RepoStatus {
            is_repo: true,
            repo: Some(repo),
        },
        Err(_) => RepoStatus {
            is_repo: false,
            repo: None,
        },
    }
}

/// List the files a user can pick from inside a repository.
#[tauri::command]
pub async fn git_files(repo: String, limit: usize) -> Result<Vec<String>, String> {
    crate::git::list_files(&repo, limit)
}

/// List the commits that touched one file, newest first.
#[tauri::command]
pub async fn git_log(
    repo: String,
    file: String,
    limit: usize,
) -> Result<Vec<crate::git::CommitInfo>, String> {
    crate::git::log_for_file(&repo, &file, limit)
}

/// List the repository's local branches.
#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Vec<crate::git::BranchInfo>, String> {
    crate::git::list_branches(&repo)
}

/// Files that differ between two revisions.
///
/// Used by branch-to-branch comparison, where the interesting question is not one
/// file's history but which files the two branches disagree about.
#[tauri::command]
pub async fn git_diff_files(
    repo: String,
    left: String,
    right: String,
) -> Result<Vec<crate::git::ChangedFile>, String> {
    crate::git::diff_files(&repo, &left, &right)
}

/// Switch the working tree to a local branch.
///
/// The only command in this app that writes to a repository. It is reported with
/// the same [`RepoInfo`] shape `git_status` returns, so the panel can refresh from
/// the response instead of guessing the new state.
#[tauri::command]
pub async fn git_switch_branch(
    repo: String,
    branch: String,
) -> Result<crate::git::RepoInfo, String> {
    crate::git::switch_branch(&repo, &branch)
}

/// Compare two git revisions of two files and return a fresh session.
///
/// One command for the whole action, for the same reason `set_both` exists: two
/// separate calls would each run a full diff and leave the UI holding a session
/// where only one side had been replaced.
///
/// The two sides are read sequentially rather than concurrently: git commands are
/// fast enough that the coordination would cost more than it saves, and a single
/// error path is easier to explain.
#[tauri::command]
pub async fn git_compare(
    state: State<'_, AppState>,
    left: GitSpec,
    right: GitSpec,
) -> Result<Session, String> {
    let left_blob = crate::git::blob_at(&left.repo, &left.rev, &left.file)?;
    let right_blob = crate::git::blob_at(&right.repo, &right.rev, &right.file)?;

    let mut warnings = Vec::new();
    warnings.extend(left_blob.warnings.iter().cloned());
    warnings.extend(right_blob.warnings.iter().cloned());

    state.set_side(SideKind::Left, Side::from_git(&left, left_blob));
    state.set_side(SideKind::Right, Side::from_git(&right, right_blob));

    let mut session = state.diff();
    session.warnings = warnings;
    Ok(session)
}

#[cfg(test)]
mod git_tests {
    use super::*;

    fn spec(rev: &str) -> GitSpec {
        GitSpec {
            repo: "/tmp/repo".into(),
            rev: rev.into(),
            file: "src/main.rs".into(),
        }
    }

    fn blob(text: &str, label: &str) -> crate::git::GitBlob {
        crate::git::GitBlob {
            text: text.into(),
            label: label.into(),
            warnings: Vec::new(),
        }
    }

    // The whole point of the origin: ⌘S must never write an old revision over
    // today's file. The guard is structural — a historical side has no path — so
    // there is no flag to forget to check.
    #[test]
    fn a_historical_blob_has_no_path_and_is_not_writable() {
        let side = Side::from_git(&spec("a1b2c3d4"), blob("old\n", "a1b2c3d · src/main.rs"));
        assert_eq!(side.path, None, "a commit is not a place ⌘S can write");
        assert_eq!(side.text, "old\n");
        assert_eq!(side.label, "a1b2c3d · src/main.rs");
        let git = side.git.expect("origin must be recorded");
        assert!(!git.writable);
        assert_eq!(git.short, "a1b2c3d");
        assert_eq!(git.file, "src/main.rs");
    }

    #[test]
    fn the_working_tree_is_writable_and_carries_its_absolute_path() {
        let side = Side::from_git(
            &spec(crate::git::WORKTREE),
            blob("live\n", "工作区 · src/main.rs"),
        );
        assert_eq!(
            side.path.as_deref().map(PathBuf::from),
            Some(PathBuf::from("/tmp/repo").join("src/main.rs"))
        );
        let git = side.git.expect("origin");
        assert!(git.writable);
        assert_eq!(git.short, "工作区");
    }

    // Two sides of the same file differ only by revision, so the label has to
    // carry the revision — otherwise both panes would be named identically.
    #[test]
    fn labels_distinguish_two_revisions_of_one_file() {
        let old = Side::from_git(&spec("1111111"), blob("", "1111111 · a.txt"));
        let new = Side::from_git(&spec("2222222"), blob("", "2222222 · a.txt"));
        assert_ne!(old.label, new.label);
    }

    /// Throwaway repository, mirroring the helper in `git::tests`.
    ///
    /// A second copy is deliberate: `git::tests` is private to that module, and
    /// exporting test scaffolding from a production module to share it would put
    /// a `#[cfg(test)]`-only type in the public API just to save ten lines.
    struct Repo {
        dir: std::path::PathBuf,
    }

    impl Repo {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("litediff-cmd-{}-{}", name, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("mkdir");
            let repo = Repo { dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(["-c", "user.name=Test", "-c", "user.email=t@example.com"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        fn write(&self, name: &str, body: &str) {
            let p = self.dir.join(name);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).expect("mkdir -p");
            }
            std::fs::write(p, body).expect("write");
        }

        fn commit(&self, message: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", message]);
        }

        fn path(&self) -> String {
            self.dir.to_string_lossy().into_owned()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn spec_at(repo: &str, rev: &str, file: &str) -> GitSpec {
        GitSpec {
            repo: repo.to_string(),
            rev: rev.to_string(),
            file: file.to_string(),
        }
    }

    /// The whole user story, through the same functions `git_compare` calls.
    ///
    /// `git_compare` itself needs a `tauri::State`, which cannot be built outside
    /// a running app; every step it performs is exercised here instead, including
    /// the real diff, so the plumbing is the only uncovered part.
    #[test]
    fn comparing_the_worktree_against_a_commit_produces_a_real_diff() {
        let repo = Repo::new("e2e");
        repo.write("src/a.txt", "alpha\nbeta\n");
        repo.commit("v1");
        let first = crate::git::log_for_file(&repo.path(), "src/a.txt", 10).expect("log")[0]
            .sha
            .clone();

        // Uncommitted edit, which is exactly what "工作区" must show.
        repo.write("src/a.txt", "alpha\nbeta changed\ngamma\n");

        let live =
            crate::git::blob_at(&repo.path(), crate::git::WORKTREE, "src/a.txt").expect("worktree");
        let old = crate::git::blob_at(&repo.path(), &first, "src/a.txt").expect("blob");

        let left = Side::from_git(
            &spec_at(&repo.path(), crate::git::WORKTREE, "src/a.txt"),
            live,
        );
        let right = Side::from_git(&spec_at(&repo.path(), &first, "src/a.txt"), old);

        let state = AppState::default();
        state.set_side(SideKind::Left, left.clone());
        state.set_side(SideKind::Right, right.clone());
        let session = state.diff();

        assert_eq!(session.left.text, "alpha\nbeta changed\ngamma\n");
        assert_eq!(session.right.text, "alpha\nbeta\n");
        assert!(!session.result.is_identical(), "the edit must show up");
        // Line-level alignment is free to pair "beta changed" with "beta" as a
        // modification and then report "gamma" as an addition, or to report both
        // as a delete+insert run. Asserting one exact split would be asserting
        // the aligner's taste rather than the behaviour under test.
        let changed = session.result.stats.added
            + session.result.stats.deleted
            + session.result.stats.modified;
        assert!(
            changed >= 2,
            "both the edited line and the new line must show up, got {:?}",
            session.result.stats
        );
        assert!(left.path.is_some());
        assert_eq!(right.path, None);
    }

    /// The same two sides, but both historical: a revision-to-revision diff.
    #[test]
    fn comparing_two_commits_never_yields_a_writable_side() {
        let repo = Repo::new("e2e-two");
        repo.write("a.txt", "one\n");
        repo.commit("v1");
        repo.write("a.txt", "one\ntwo\n");
        repo.commit("v2");

        let commits = crate::git::log_for_file(&repo.path(), "a.txt", 10).expect("log");
        let new = crate::git::blob_at(&repo.path(), &commits[0].sha, "a.txt").expect("new");
        let old = crate::git::blob_at(&repo.path(), &commits[1].sha, "a.txt").expect("old");

        let left = Side::from_git(&spec_at(&repo.path(), &commits[1].sha, "a.txt"), old);
        let right = Side::from_git(&spec_at(&repo.path(), &commits[0].sha, "a.txt"), new);

        assert_eq!(left.path, None);
        assert_eq!(right.path, None);
        assert_eq!(left.text, "one\n");
        assert_eq!(right.text, "one\ntwo\n");
        assert_ne!(left.label, right.label, "both sides name the same file");
    }
}

// --- history ---------------------------------------------------------------

/// Resolve the app's data directory, creating it if needed.
///
/// `app_data_dir` is the platform-correct location (macOS
/// `~/Library/Application Support/app.litediff.desktop`, Windows
/// `%APPDATA%\app.litediff.desktop`). Resolving it through Tauri rather than
/// guessing means the history follows the platform's conventions and lands
/// somewhere a user can find and delete.
fn history_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Save one comparison to disk, returning its id (or `None` when it was too big).
#[tauri::command]
pub async fn history_save(
    app: tauri::AppHandle,
    entry: crate::history::HistoryEntry,
) -> Result<Option<String>, String> {
    let root = history_root(&app)?;
    crate::history::save(&root, entry)
}

/// List stored comparisons, newest first, without their document texts.
#[tauri::command]
pub async fn history_list(
    app: tauri::AppHandle,
) -> Result<Vec<crate::history::HistorySummary>, String> {
    let root = history_root(&app)?;
    crate::history::list(&root)
}

/// Read one stored comparison in full.
#[tauri::command]
pub async fn history_load(
    app: tauri::AppHandle,
    id: String,
) -> Result<crate::history::HistoryEntry, String> {
    let root = history_root(&app)?;
    crate::history::load(&root, &id)
}

/// Delete one stored comparison.
#[tauri::command]
pub async fn history_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = history_root(&app)?;
    crate::history::delete(&root, &id)
}

/// Delete every stored comparison.
#[tauri::command]
pub async fn history_clear(app: tauri::AppHandle) -> Result<usize, String> {
    let root = history_root(&app)?;
    crate::history::clear(&root)
}

/// Apply the retention rules and report how many entries were removed.
///
/// `days <= 0` disables the age rule and `keep <= 0` the count rule, which is how
/// the settings UI spells "off".
#[tauri::command]
pub async fn history_prune(app: tauri::AppHandle, days: i64, keep: usize) -> Result<usize, String> {
    let root = history_root(&app)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    crate::history::prune(&root, days, keep, now)
}
