//! Tauri command surface.
//!
//! Commands are async and move file IO, Git, history serialization, and diff
//! computation into Tauri's blocking pool. Document text is cached by the app
//! state; most renderer calls carry only a session id and a small options patch.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use litediff_core::DiffOptions;
use tauri::State;

use crate::{
    list_text_files, read_text_file, AppState, OptionsPatch, Session, SessionUpdate, Side, SideKind,
};

async fn blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("后台任务失败：{error}"))?
}

/// A dropped item, resolved on the backend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSide {
    pub side: Side,
    pub warnings: Vec<String>,
}

fn pick_native_path(
    app: &tauri::AppHandle,
    state: &AppState,
    title: &str,
    directory: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dialog = app.dialog().file().set_title(title);
    let selected = if directory {
        dialog.blocking_pick_folder()
    } else {
        dialog.blocking_pick_file()
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("无法解析所选路径：{error}"))?;
    state
        .approve_path(&path)
        .map(|path| Some(path.to_string_lossy().into_owned()))
}

/// Open the native picker on the backend so a returned path is also approved.
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: String,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    blocking(move || pick_native_path(&app, &state, &title, false)).await
}

/// Open the native directory picker and approve the chosen subtree.
#[tauri::command]
pub async fn pick_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: String,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    blocking(move || pick_native_path(&app, &state, &title, true)).await
}

#[tauri::command]
pub async fn load_file(state: State<'_, AppState>, path: String) -> Result<LoadedSide, String> {
    let state = state.inner().clone();
    blocking(move || {
        let path_buf = state.require_approved_path(Path::new(&path))?;
        let label = path_buf
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_string();
        let decoded = read_text_file(&path_buf).map_err(|error| format!("{path}: {error}"))?;
        let warning = decoded.warning.clone().into_iter().collect();
        let side = Side {
            path: None,
            label,
            text: decoded.text,
            git: None,
            document_id: None,
            bom: decoded.bom,
            lossy: decoded.lossy,
        };
        let side =
            state.register_document(side, path_buf, decoded.bom, decoded.lossy, decoded.digest)?;
        Ok(LoadedSide {
            side,
            warnings: warning,
        })
    })
    .await
}

#[tauri::command]
pub async fn set_side(
    state: State<'_, AppState>,
    session_id: String,
    side: String,
    side_data: Side,
) -> Result<Session, String> {
    let which = match side.as_str() {
        "left" => SideKind::Left,
        "right" => SideKind::Right,
        other => return Err(format!("unknown side: {other}")),
    };
    let state = state.inner().clone();
    blocking(move || state.set_side(&session_id, which, side_data)).await
}

/// Replace only the draft texts that changed in the editor.
#[tauri::command]
pub async fn set_drafts(
    state: State<'_, AppState>,
    session_id: String,
    left: Option<String>,
    right: Option<String>,
) -> Result<SessionUpdate, String> {
    let state = state.inner().clone();
    blocking(move || {
        state
            .set_texts(&session_id, left, right)
            .map(Session::into_update)
    })
    .await
}

#[tauri::command]
pub async fn set_both(
    state: State<'_, AppState>,
    session_id: String,
    left: Side,
    right: Side,
) -> Result<Session, String> {
    let state = state.inner().clone();
    blocking(move || state.set_sides(&session_id, left, right)).await
}

#[tauri::command]
pub async fn rediff(
    state: State<'_, AppState>,
    session_id: String,
    patch: Option<OptionsPatch>,
) -> Result<SessionUpdate, String> {
    let state = state.inner().clone();
    blocking(move || {
        if let Some(patch) = patch {
            let base = state.options(&session_id)?;
            state.set_options(&session_id, patch.apply_to(&base))?;
        }
        state.diff(&session_id).map(Session::into_update)
    })
    .await
}

#[tauri::command]
pub async fn clear(state: State<'_, AppState>, session_id: String) -> Result<Session, String> {
    let state = state.inner().clone();
    blocking(move || state.clear(&session_id)).await
}

/// Read a file directly into one side of an existing comparison.
///
/// The content crosses the IPC boundary only in the response; it never makes a
/// `load_file` → `set_side` round trip with two full copies.
#[tauri::command]
pub async fn load_into(
    state: State<'_, AppState>,
    session_id: String,
    side: String,
    path: String,
) -> Result<SessionUpdate, String> {
    let which = match side.as_str() {
        "left" => SideKind::Left,
        "right" => SideKind::Right,
        other => return Err(format!("unknown side: {other}")),
    };
    let state = state.inner().clone();
    blocking(move || {
        let path_buf = state.require_approved_path(Path::new(&path))?;
        let label = path_buf
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_string();
        let decoded = read_text_file(&path_buf).map_err(|error| format!("{path}: {error}"))?;
        let warnings = decoded.warning.clone().into_iter().collect();
        let side_data = state.register_document(
            Side {
                path: None,
                label,
                text: decoded.text,
                git: None,
                document_id: None,
                bom: decoded.bom,
                lossy: decoded.lossy,
            },
            path_buf,
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )?;
        let session = state.set_side_with_warnings(&session_id, which, side_data, warnings)?;
        let changed = match which {
            SideKind::Left => Some(session.left.clone()),
            SideKind::Right => Some(session.right.clone()),
        };
        let mut update = session.into_update();
        match which {
            SideKind::Left => update.left = changed,
            SideKind::Right => update.right = changed,
        }
        Ok(update)
    })
    .await
}

#[tauri::command]
pub async fn save_current(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    blocking(move || state.save_current(&session_id)).await
}

#[tauri::command]
pub async fn drop_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || state.drop_session(&session_id)).await
}

/// Describe a user-approved dropped path.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPath {
    pub is_dir: bool,
    pub files: Vec<String>,
}

#[tauri::command]
pub async fn inspect_path(state: State<'_, AppState>, path: String) -> Result<DroppedPath, String> {
    let state = state.inner().clone();
    blocking(move || {
        let path_buf = state.require_approved_path(Path::new(&path))?;
        let metadata =
            std::fs::symlink_metadata(&path_buf).map_err(|error| format!("{path}: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("已拒绝符号链接，请直接选择真实文件或目录".to_string());
        }
        if !metadata.is_dir() {
            return Ok(DroppedPath {
                is_dir: false,
                files: Vec::new(),
            });
        }
        let files = list_text_files(&path_buf)
            .map_err(|error| format!("{path}: {error}"))?
            .into_iter()
            .filter_map(|file| file.to_str().map(str::to_string))
            .collect();
        Ok(DroppedPath {
            is_dir: true,
            files,
        })
    })
    .await
}

#[tauri::command]
pub async fn expand_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let path_buf = state.require_approved_path(Path::new(&path))?;
        let files = list_text_files(&path_buf).map_err(|error| format!("{path}: {error}"))?;
        Ok(files
            .into_iter()
            .filter_map(|file| file.to_str().map(str::to_string))
            .collect())
    })
    .await
}

// --- git ---------------------------------------------------------------

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSpec {
    pub repo: String,
    pub rev: String,
    pub file: String,
}

impl Side {
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
            text: Arc::from(blob.text),
            git: Some(crate::GitOrigin {
                repo: spec.repo.clone(),
                rev: spec.rev.clone(),
                file: spec.file.clone(),
                short,
                writable,
            }),
            document_id: None,
            bom: blob.bom,
            lossy: blob.lossy,
        }
    }
}

fn register_git_side(
    state: &AppState,
    spec: &GitSpec,
    blob: crate::git::GitBlob,
) -> Result<Side, String> {
    let writable = spec.rev == crate::git::WORKTREE;
    let digest = blob.digest;
    let bom = blob.bom;
    let lossy = blob.lossy;
    let path = PathBuf::from(&spec.repo).join(&spec.file);
    let side = Side::from_git(spec, blob);
    if writable {
        state.register_document(
            side,
            path,
            bom,
            lossy,
            digest.ok_or_else(|| "工作区文件缺少完整性摘要".to_string())?,
        )
    } else {
        Ok(side)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    pub repo: Option<crate::git::RepoInfo>,
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, path: String) -> Result<RepoStatus, String> {
    let state = state.inner().clone();
    blocking(move || {
        let path = state.require_approved_path(Path::new(&path))?;
        let path = path.to_string_lossy().into_owned();
        if !crate::git::is_repo(&path) {
            return Ok(RepoStatus {
                is_repo: false,
                repo: None,
            });
        }
        match crate::git::resolve_repo(&path) {
            Ok(repo) => {
                // The user already authorized this path. Following its repository
                // root lets the subsequent history/file picker operate without
                // accepting arbitrary renderer-supplied directories.
                state.approve_path(Path::new(&repo.root))?;
                Ok(RepoStatus {
                    is_repo: true,
                    repo: Some(repo),
                })
            }
            Err(_) => Ok(RepoStatus {
                is_repo: false,
                repo: None,
            }),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_files(
    state: State<'_, AppState>,
    repo: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let repo = state.require_approved_path(Path::new(&repo))?;
        crate::git::list_files(&repo.to_string_lossy(), limit)
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    repo: String,
    file: String,
    limit: usize,
) -> Result<Vec<crate::git::CommitInfo>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let repo = state.require_approved_path(Path::new(&repo))?;
        crate::git::log_for_file(&repo.to_string_lossy(), &file, limit)
    })
    .await
}

#[tauri::command]
pub async fn git_branches(
    state: State<'_, AppState>,
    repo: String,
) -> Result<Vec<crate::git::BranchInfo>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let repo = state.require_approved_path(Path::new(&repo))?;
        crate::git::list_branches(&repo.to_string_lossy())
    })
    .await
}

#[tauri::command]
pub async fn git_diff_files(
    state: State<'_, AppState>,
    repo: String,
    left: String,
    right: String,
) -> Result<Vec<crate::git::ChangedFile>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let repo = state.require_approved_path(Path::new(&repo))?;
        crate::git::diff_files(&repo.to_string_lossy(), &left, &right)
    })
    .await
}

#[tauri::command]
pub async fn git_switch_branch(
    state: State<'_, AppState>,
    repo: String,
    branch: String,
) -> Result<crate::git::RepoInfo, String> {
    let state = state.inner().clone();
    blocking(move || {
        let repo = state.require_approved_path(Path::new(&repo))?;
        crate::git::switch_branch(&repo.to_string_lossy(), &branch)
    })
    .await
}

#[tauri::command]
pub async fn git_compare(
    state: State<'_, AppState>,
    session_id: String,
    left: GitSpec,
    right: GitSpec,
) -> Result<Session, String> {
    let state = state.inner().clone();
    blocking(move || {
        let left = GitSpec {
            repo: state
                .require_approved_path(Path::new(&left.repo))?
                .to_string_lossy()
                .into_owned(),
            ..left
        };
        let right = GitSpec {
            repo: state
                .require_approved_path(Path::new(&right.repo))?
                .to_string_lossy()
                .into_owned(),
            ..right
        };
        let left_blob = crate::git::blob_at(&left.repo, &left.rev, &left.file)?;
        let right_blob = crate::git::blob_at(&right.repo, &right.rev, &right.file)?;
        let left_warnings = left_blob.warnings.clone();
        let right_warnings = right_blob.warnings.clone();
        let left_side = register_git_side(&state, &left, left_blob)?;
        let right_side = register_git_side(&state, &right, right_blob)?;
        state.set_sides_with_warnings(
            &session_id,
            left_side,
            right_side,
            left_warnings,
            right_warnings,
        )
    })
    .await
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
            bom: false,
            lossy: false,
            digest: None,
        }
    }

    #[test]
    fn a_historical_blob_has_no_save_capability() {
        let side = Side::from_git(&spec("a1b2c3d4"), blob("old\n", "a1b2c3d · src/main.rs"));
        assert_eq!(side.path, None);
        assert_eq!(side.document_id, None);
        let git = side.git.expect("origin must be recorded");
        assert!(!git.writable);
    }

    #[test]
    fn the_worktree_is_marked_writable_but_needs_a_registered_document() {
        let side = Side::from_git(
            &spec(crate::git::WORKTREE),
            blob("live\n", "工作区 · src/main.rs"),
        );
        assert!(side.path.is_some());
        assert_eq!(side.document_id, None);
        let git = side.git.expect("origin");
        assert!(git.writable);
    }

    #[test]
    fn an_unregistered_path_is_not_a_save_capability() {
        let state = AppState::default();
        let error = state
            .set_sides(
                "tab-path",
                Side {
                    path: Some("/tmp/forged.txt".into()),
                    text: Arc::from("forged"),
                    ..Default::default()
                },
                Side::default(),
            )
            .unwrap_err();
        assert!(error.contains("未经后端登记"));
    }
}

// --- history -----------------------------------------------------------

fn history_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve app data dir: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir)
}

fn history_side(side: &Side) -> crate::history::HistorySide {
    crate::history::HistorySide {
        label: side.label.clone(),
        path: side.path.clone(),
        text: side.text.to_string(),
        bom: side.bom,
        lossy: side.lossy,
    }
}

/// Save the backend's copy of a session without sending either document back.
#[tauri::command]
pub async fn history_save_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    created_at: i64,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (left, right, options) = state.session_parts(&session_id)?;
        let root = history_root(&app)?;
        crate::history::save(
            &root,
            crate::history::HistoryEntry {
                id: String::new(),
                created_at,
                left: history_side(&left),
                right: history_side(&right),
                options: crate::history::HistoryOptions {
                    ignore_whitespace: options.ignore_whitespace,
                    ignore_all_whitespace: options.ignore_all_whitespace,
                    ignore_case: options.ignore_case,
                    intra_line: options.intra_line,
                },
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn history_list(
    app: tauri::AppHandle,
) -> Result<Vec<crate::history::HistorySummary>, String> {
    blocking(move || {
        let root = history_root(&app)?;
        crate::history::list(&root)
    })
    .await
}

#[tauri::command]
pub async fn history_load(
    app: tauri::AppHandle,
    id: String,
) -> Result<crate::history::HistoryEntry, String> {
    blocking(move || {
        let root = history_root(&app)?;
        crate::history::load(&root, &id)
    })
    .await
}

fn restored_side(side: crate::history::HistorySide) -> Side {
    Side {
        // History is a snapshot, not proof that the current file still holds
        // these bytes. It intentionally carries no path or document capability.
        path: None,
        label: side.label,
        text: Arc::from(side.text),
        git: None,
        document_id: None,
        bom: side.bom,
        lossy: side.lossy,
    }
}

/// Load a history snapshot directly into a session.
#[tauri::command]
pub async fn history_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    id: String,
) -> Result<Session, String> {
    let state = state.inner().clone();
    blocking(move || {
        let root = history_root(&app)?;
        let entry = crate::history::load(&root, &id)?;
        let default = DiffOptions::default();
        let options = DiffOptions {
            ignore_whitespace: entry.options.ignore_whitespace,
            ignore_all_whitespace: entry.options.ignore_all_whitespace,
            ignore_case: entry.options.ignore_case,
            intra_line: entry.options.intra_line,
            intra_line_max_tokens: default.intra_line_max_tokens,
        };
        state.set_options(&session_id, options)?;
        state.set_sides_with_warnings(
            &session_id,
            restored_side(entry.left),
            restored_side(entry.right),
            vec!["历史快照为只读；如需编辑，请重新打开原文件".to_string()],
            Vec::new(),
        )
    })
    .await
}

#[tauri::command]
pub async fn history_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        let root = history_root(&app)?;
        crate::history::delete(&root, &id)
    })
    .await
}

#[tauri::command]
pub async fn history_clear(app: tauri::AppHandle) -> Result<usize, String> {
    blocking(move || {
        let root = history_root(&app)?;
        crate::history::clear(&root)
    })
    .await
}

#[tauri::command]
pub async fn history_prune(app: tauri::AppHandle, days: i64, keep: usize) -> Result<usize, String> {
    blocking(move || {
        let root = history_root(&app)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        crate::history::prune(&root, days, keep, now)
    })
    .await
}
