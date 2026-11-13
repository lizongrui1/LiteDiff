//! Tauri v2 backend for LiteDiff.
//!
//! File contents are cached in Rust for the lifetime of a comparison. The
//! renderer receives the text once for rendering/search/editing, but save,
//! history, option changes, and tab switches no longer send the documents back
//! across IPC.

pub mod commands;
pub mod git;
pub mod history;
pub mod wire;

pub use wire::{wire_diff, WireDiff};

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use litediff_core::{DiffOptions, SourceText};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Upper bound for a document accepted from disk or IPC.
pub const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DOCUMENT_LINES: usize = 200_000;
const MAX_REGISTERED_DOCUMENTS: usize = 256;
const MAX_APPROVED_PATHS: usize = 4096;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Where a side came from when it came from a git revision.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOrigin {
    pub repo: String,
    pub rev: String,
    pub file: String,
    pub short: String,
    pub writable: bool,
}

/// One side of the comparison.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    /// Display path. It is **not** a save capability by itself.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub label: String,
    /// Shared with [`SourceText`] so cache snapshots do not copy the document.
    pub text: Arc<str>,
    #[serde(default)]
    pub git: Option<GitOrigin>,
    /// Opaque token issued only by `load_file` / a worktree Git read.
    #[serde(default)]
    pub document_id: Option<String>,
    /// The file began with a UTF-8 BOM; writes must put it back.
    #[serde(default)]
    pub bom: bool,
    /// Invalid UTF-8 was displayed with replacement characters. Such a side is
    /// preview-only and can never be written back.
    #[serde(default)]
    pub lossy: bool,
}

/// Everything the UI needs to render one comparison.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub left: Side,
    pub right: Side,
    /// Compact diff payload; the row grid is re-derived in the renderer.
    pub result: WireDiff,
    pub options: DiffOptions,
    pub warnings: Vec<String>,
    /// Backend-computed identity of the two source documents.
    pub content_key: String,
}

/// A result update that reuses the document text already held by the renderer.
///
/// `left`/`right` are populated only when that side's text or metadata changed.
/// Option toggles therefore transfer the diff result but not either source file.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdate {
    pub result: WireDiff,
    pub options: DiffOptions,
    pub warnings: Vec<String>,
    pub content_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<Side>,
}

impl Session {
    pub fn into_update(self) -> SessionUpdate {
        SessionUpdate {
            result: self.result,
            options: self.options,
            warnings: self.warnings,
            content_key: self.content_key,
            left: None,
            right: None,
        }
    }
}

/// UI-facing options patch.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionsPatch {
    pub ignore_whitespace: Option<bool>,
    pub ignore_all_whitespace: Option<bool>,
    pub ignore_case: Option<bool>,
    pub intra_line: Option<bool>,
}

impl OptionsPatch {
    pub fn apply_to(&self, base: &DiffOptions) -> DiffOptions {
        let mut out = base.clone();
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

#[derive(Clone, Debug, Default)]
struct CachedSession {
    left: Side,
    right: Side,
    /// `Arc` so a `diff()` snapshot clones two pointers instead of the two line
    /// indexes (~2.4 MB per side at the 200,000-line limit).
    left_source: Arc<SourceText>,
    right_source: Arc<SourceText>,
    options: DiffOptions,
    left_warnings: Vec<String>,
    right_warnings: Vec<String>,
}

struct SaveTarget {
    path: PathBuf,
    bom: bool,
    expected: [u8; 32],
    text: Arc<str>,
    labels: Vec<String>,
    document_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct DocumentRecord {
    path: PathBuf,
    bom: bool,
    lossy: bool,
    digest: [u8; 32],
}

#[derive(Clone, Debug)]
struct ApprovedPath {
    path: PathBuf,
    recursive: bool,
}

#[derive(Default)]
struct StateInner {
    sessions: Mutex<HashMap<String, CachedSession>>,
    documents: Mutex<HashMap<String, DocumentRecord>>,
    approved_paths: Mutex<Vec<ApprovedPath>>,
    next_document: AtomicU64,
}

/// App-wide state. Cloning the handle is cheap and lets commands move blocking
/// work onto Tauri's blocking pool.
#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<StateInner>,
}

impl AppState {
    fn sessions(&self) -> MutexGuard<'_, HashMap<String, CachedSession>> {
        self.inner
            .sessions
            .lock()
            .expect("session state mutex poisoned")
    }

    fn documents(&self) -> MutexGuard<'_, HashMap<String, DocumentRecord>> {
        self.inner
            .documents
            .lock()
            .expect("document state mutex poisoned")
    }

    fn approved_paths(&self) -> MutexGuard<'_, Vec<ApprovedPath>> {
        self.inner
            .approved_paths
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Remember a path the user chose in a native picker or dropped on the window.
    ///
    /// Directories grant their whole subtree; files grant only that file. Every
    /// renderer-supplied path is checked against this collection before it reaches
    /// a filesystem or Git command.
    pub fn approve_path(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical =
            std::fs::canonicalize(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let metadata = std::fs::symlink_metadata(&canonical)
            .map_err(|error| format!("{}: {error}", canonical.display()))?;
        let recursive = metadata.is_dir();
        if !recursive && !metadata.is_file() {
            return Err(format!("不是普通文件或目录：{}", canonical.display()));
        }

        let mut approved = self.approved_paths();
        if approved.iter().any(|grant| {
            (canonical == grant.path && grant.recursive == recursive)
                || (canonical != grant.path
                    && grant.recursive
                    && canonical.starts_with(&grant.path))
        }) {
            return Ok(canonical);
        }
        if recursive {
            // A broader picker choice supersedes narrower grants it already covers.
            approved.retain(|grant| !grant.path.starts_with(&canonical));
        } else {
            // The same path may have changed kind since an earlier grant.
            approved.retain(|grant| grant.path != canonical);
        }
        if approved.len() >= MAX_APPROVED_PATHS {
            return Err("已授权的路径过多，请重新启动应用后再试".to_string());
        }
        approved.push(ApprovedPath {
            path: canonical.clone(),
            recursive,
        });
        Ok(canonical)
    }

    /// Resolve a renderer path and require that the user approved it first.
    pub fn require_approved_path(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical =
            std::fs::canonicalize(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let metadata = std::fs::symlink_metadata(&canonical)
            .map_err(|error| format!("{}: {error}", canonical.display()))?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(format!("不是普通文件或目录：{}", canonical.display()));
        }
        let approved = self.approved_paths();
        if approved.iter().any(|grant| {
            if canonical == grant.path {
                metadata.is_dir() == grant.recursive
            } else {
                grant.recursive && canonical.starts_with(&grant.path)
            }
        }) {
            Ok(canonical)
        } else {
            Err(format!("路径未经用户选择或拖入授权：{}", path.display()))
        }
    }

    pub fn options(&self, session_id: &str) -> Result<DiffOptions, String> {
        validate_session_id(session_id)?;
        Ok(self
            .sessions()
            .get(session_id)
            .map(|session| session.options.clone())
            .unwrap_or_default())
    }

    pub fn set_options(&self, session_id: &str, options: DiffOptions) -> Result<(), String> {
        validate_session_id(session_id)?;
        self.sessions()
            .entry(session_id.to_string())
            .or_default()
            .options = options;
        Ok(())
    }

    /// Register a user-approved file-backed side and return its capability token.
    pub fn register_document(
        &self,
        mut side: Side,
        path: PathBuf,
        bom: bool,
        lossy: bool,
        digest: [u8; 32],
    ) -> Result<Side, String> {
        // Keep the approval invariant at the capability boundary too, not only
        // in the IPC commands: a future caller cannot mint a writable token for a
        // renderer-supplied path by forgetting the earlier check.
        let path = self.require_approved_path(&path)?;
        let id = self.next_document_id()?;
        let mut documents = self.documents();
        if documents.len() >= MAX_REGISTERED_DOCUMENTS {
            let referenced: HashSet<String> = self
                .sessions()
                .values()
                .flat_map(|session| {
                    [
                        session.left.document_id.clone(),
                        session.right.document_id.clone(),
                    ]
                })
                .flatten()
                .collect();
            let removable = documents
                .keys()
                .find(|candidate| !referenced.contains(*candidate))
                .cloned();
            if let Some(removable) = removable {
                documents.remove(&removable);
            } else {
                return Err("打开的文件过多，请先关闭一些标签页".to_string());
            }
        }
        documents.insert(
            id.clone(),
            DocumentRecord {
                path: path.clone(),
                bom,
                lossy,
                digest,
            },
        );
        side.path = Some(path.to_string_lossy().into_owned());
        side.document_id = Some(id);
        side.bom = bom;
        side.lossy = lossy;
        Ok(side)
    }

    fn next_document_id(&self) -> Result<String, String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|error| format!("无法生成文档标识：{error}"))?;
        let counter = self.inner.next_document.fetch_add(1, Ordering::Relaxed);
        Ok(format!("{counter:016x}-{}", hex(&random)))
    }

    /// Validate a renderer-supplied side before it enters trusted cache state.
    fn prepare_side(&self, mut side: Side) -> Result<Side, String> {
        if side.text.len() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "文本超过 {} MiB 限制",
                MAX_DOCUMENT_BYTES / (1024 * 1024)
            ));
        }
        if line_count(side.text.as_bytes()) > MAX_DOCUMENT_LINES {
            return Err(format!("文本超过 {MAX_DOCUMENT_LINES} 行限制"));
        }

        if let Some(id) = side.document_id.as_deref() {
            let document = self
                .documents()
                .get(id)
                .cloned()
                .ok_or_else(|| "文件来源已失效，请重新打开该文件".to_string())?;
            side.path = Some(document.path.to_string_lossy().into_owned());
            side.bom = document.bom;
            side.lossy = document.lossy;
            return Ok(side);
        }

        // A path without a backend-issued token is not a save capability.
        if side.path.is_some() {
            return Err("拒绝对未经后端登记的文件路径执行操作，请重新打开该文件".to_string());
        }
        side.bom = false;
        side.lossy = false;
        Ok(side)
    }

    pub fn set_side(
        &self,
        session_id: &str,
        which: SideKind,
        side: Side,
    ) -> Result<Session, String> {
        self.set_side_with_warnings(session_id, which, side, Vec::new())
    }

    pub fn set_side_with_warnings(
        &self,
        session_id: &str,
        which: SideKind,
        side: Side,
        warnings: Vec<String>,
    ) -> Result<Session, String> {
        validate_session_id(session_id)?;
        let side = self.prepare_side(side)?;
        let source = Arc::new(SourceText::from_shared(Arc::clone(&side.text)));
        {
            let mut sessions = self.sessions();
            let session = sessions.entry(session_id.to_string()).or_default();
            match which {
                SideKind::Left => {
                    session.left = side;
                    session.left_source = source;
                    session.left_warnings = warnings;
                }
                SideKind::Right => {
                    session.right = side;
                    session.right_source = source;
                    session.right_warnings = warnings;
                }
            }
        }
        self.diff(session_id)
    }

    pub fn set_sides(&self, session_id: &str, left: Side, right: Side) -> Result<Session, String> {
        self.set_sides_with_warnings(session_id, left, right, Vec::new(), Vec::new())
    }

    pub fn set_sides_with_warnings(
        &self,
        session_id: &str,
        left: Side,
        right: Side,
        left_warnings: Vec<String>,
        right_warnings: Vec<String>,
    ) -> Result<Session, String> {
        validate_session_id(session_id)?;
        let left = self.prepare_side(left)?;
        let right = self.prepare_side(right)?;
        let left_source = Arc::new(SourceText::from_shared(Arc::clone(&left.text)));
        let right_source = Arc::new(SourceText::from_shared(Arc::clone(&right.text)));
        {
            let mut sessions = self.sessions();
            let session = sessions.entry(session_id.to_string()).or_default();
            session.left = left;
            session.right = right;
            session.left_source = left_source;
            session.right_source = right_source;
            session.left_warnings = left_warnings;
            session.right_warnings = right_warnings;
        }
        self.diff(session_id)
    }

    /// Replace changed draft text while preserving each side's file metadata.
    pub fn set_texts(
        &self,
        session_id: &str,
        left: Option<String>,
        right: Option<String>,
    ) -> Result<Session, String> {
        validate_session_id(session_id)?;
        for text in [&left, &right].into_iter().flatten() {
            if text.len() > MAX_DOCUMENT_BYTES {
                return Err(format!(
                    "文本超过 {} MiB 限制",
                    MAX_DOCUMENT_BYTES / (1024 * 1024)
                ));
            }
            if line_count(text.as_bytes()) > MAX_DOCUMENT_LINES {
                return Err(format!("文本超过 {MAX_DOCUMENT_LINES} 行限制"));
            }
        }
        {
            let mut sessions = self.sessions();
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| "比较会话不存在".to_string())?;
            if let Some(text) = left {
                let text: Arc<str> = Arc::from(text);
                session.left.text = Arc::clone(&text);
                session.left_source = Arc::new(SourceText::from_shared(text));
            }
            if let Some(text) = right {
                let text: Arc<str> = Arc::from(text);
                session.right.text = Arc::clone(&text);
                session.right_source = Arc::new(SourceText::from_shared(text));
            }
        }
        self.diff(session_id)
    }

    pub fn clear(&self, session_id: &str) -> Result<Session, String> {
        self.set_sides(session_id, Side::default(), Side::default())?;
        self.set_options(session_id, DiffOptions::default())?;
        self.diff(session_id)
    }

    /// Diff the cached documents with the current options.
    pub fn diff(&self, session_id: &str) -> Result<Session, String> {
        validate_session_id(session_id)?;
        let snapshot = {
            let sessions = self.sessions();
            sessions.get(session_id).cloned().unwrap_or_default()
        };

        let result = litediff_core::diff_sources(
            &snapshot.left_source,
            &snapshot.right_source,
            &snapshot.options,
        );
        let mut warnings: Vec<String> = snapshot
            .left_warnings
            .iter()
            .chain(snapshot.right_warnings.iter())
            .cloned()
            .collect();
        for side in [&snapshot.left, &snapshot.right] {
            if side.lossy && !warnings.iter().any(|warning| warning.contains("UTF-8")) {
                warnings.push("文件不是有效 UTF-8，已用替换字符只读显示".to_string());
            }
        }
        if result.approximate {
            warnings.push(
                "文件差异过大，已使用快速近似对齐以保证界面响应；结果可能不是最小差异".to_string(),
            );
        }
        Ok(Session {
            content_key: content_key(&snapshot.left, &snapshot.right),
            left: snapshot.left,
            right: snapshot.right,
            // The aligned row grid stays in the backend: the renderer derives it
            // from the hunks, so only the compact payload crosses IPC.
            result: wire_diff(result),
            options: snapshot.options,
            warnings,
        })
    }

    pub fn session_parts(&self, session_id: &str) -> Result<(Side, Side, DiffOptions), String> {
        validate_session_id(session_id)?;
        let sessions = self.sessions();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "比较会话不存在".to_string())?;
        Ok((
            session.left.clone(),
            session.right.clone(),
            session.options.clone(),
        ))
    }

    pub fn drop_session(&self, session_id: &str) -> Result<(), String> {
        validate_session_id(session_id)?;
        self.sessions().remove(session_id);
        Ok(())
    }

    /// Save every file-backed side from the backend's own copy.
    ///
    /// All documents are preflighted before the first write: lossy decoding, an
    /// external edit since load, or conflicting drafts for the same file abort
    /// the whole operation rather than leaving one side saved and one not.
    pub fn save_current(&self, session_id: &str) -> Result<Vec<String>, String> {
        let _save_guard = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        validate_session_id(session_id)?;
        let (left, right, _) = self.session_parts(session_id)?;
        // Keyed by the canonical path rather than the capability token: two
        // aliases for one file must be written once, never compared with the
        // digest produced by the first write.
        let mut targets: HashMap<PathBuf, SaveTarget> = HashMap::new();

        for side in [&left, &right] {
            let Some(document_id) = side.document_id.as_deref() else {
                continue;
            };
            let document = self
                .documents()
                .get(document_id)
                .cloned()
                .ok_or_else(|| "文件来源已失效，请重新打开该文件".to_string())?;
            if document.lossy {
                return Err(format!(
                    "{} 不是有效 UTF-8，为防止损坏文件已禁止保存",
                    document.path.display()
                ));
            }
            let metadata = std::fs::symlink_metadata(&document.path)
                .map_err(|error| format!("{}: {error}", document.path.display()))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "{} 已不是可保存的普通文件，请重新打开",
                    document.path.display()
                ));
            }
            let path = std::fs::canonicalize(&document.path)
                .map_err(|error| format!("{}: {error}", document.path.display()))?;
            if let Some(existing) = targets.get_mut(&path) {
                if existing.text.as_ref() != side.text.as_ref()
                    || existing.bom != document.bom
                    || existing.expected != document.digest
                {
                    return Err(format!(
                        "同一文件在两侧存在不同草稿或快照：{}",
                        path.display()
                    ));
                }
                existing.labels.push(side.label.clone());
                existing.document_ids.push(document_id.to_string());
                continue;
            }
            targets.insert(
                path.clone(),
                SaveTarget {
                    path,
                    bom: document.bom,
                    expected: document.digest,
                    text: Arc::clone(&side.text),
                    labels: vec![side.label.clone()],
                    document_ids: vec![document_id.to_string()],
                },
            );
        }

        if targets.is_empty() {
            return Err("当前比较没有可保存的文件".to_string());
        }

        let mut prepared = Vec::with_capacity(targets.len());
        for target in targets.into_values() {
            let current = read_bounded_bytes(&target.path)
                .map_err(|error| format!("{}: {error}", target.path.display()))?;
            if digest(&current) != target.expected {
                return Err(format!(
                    "{} 在打开后已被其他程序修改，请重新打开后再保存",
                    target.path.display()
                ));
            }
            let mut body = Vec::with_capacity(target.text.len() + usize::from(target.bom) * 3);
            if target.bom {
                body.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            body.extend_from_slice(target.text.as_bytes());
            prepared.push((target, body));
        }

        let mut saved = Vec::with_capacity(prepared.len());
        for (target, body) in prepared {
            let new_digest = replace_file_atomically(&target.path, &body, Some(target.expected))
                .map_err(|error| format!("{}: {error}", target.path.display()))?;
            let mut documents = self.documents();
            for id in &target.document_ids {
                if let Some(document) = documents.get_mut(id) {
                    document.digest = new_digest;
                }
            }
            saved.extend(target.labels);
        }
        Ok(saved)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum SideKind {
    Left,
    Right,
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err("无效的比较会话标识".to_string())
    }
}

fn content_key(left: &Side, right: &Side) -> String {
    fn update(hasher: &mut Sha256, side: &Side) {
        let path = side.path.as_deref().unwrap_or("");
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        hasher.update([side.bom as u8, side.lossy as u8]);
        hasher.update((side.text.len() as u64).to_le_bytes());
        hasher.update(side.text.as_bytes());
    }
    let mut hasher = Sha256::new();
    update(&mut hasher, left);
    update(&mut hasher, right);
    hex(&hasher.finalize())
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Decoded contents and preservation metadata for one file.
#[derive(Clone, Debug)]
pub struct TextFile {
    pub text: Arc<str>,
    pub bom: bool,
    pub lossy: bool,
    pub warning: Option<String>,
    pub digest: [u8; 32],
}

/// Read a regular file, rejecting symlinks and unbounded allocations.
pub fn read_text_file(path: &Path) -> std::io::Result<TextFile> {
    let bytes = read_bounded_bytes(path)?;
    let digest = digest(&bytes);
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if bom { &bytes[3..] } else { &bytes[..] };
    if line_count(body) > MAX_DOCUMENT_LINES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file exceeds the {MAX_DOCUMENT_LINES}-line limit"),
        ));
    }

    match std::str::from_utf8(body) {
        Ok(text) => Ok(TextFile {
            text: Arc::from(text),
            bom,
            lossy: false,
            warning: None,
            digest,
        }),
        Err(_) => Ok(TextFile {
            text: Arc::from(String::from_utf8_lossy(body).into_owned()),
            bom,
            lossy: true,
            warning: Some("文件不是有效 UTF-8，已用替换字符显示且禁止保存".to_string()),
            digest,
        }),
    }
}

fn read_bounded_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing to follow a symbolic link",
        ));
    }
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "file exceeds the {} MiB limit",
                MAX_DOCUMENT_BYTES / (1024 * 1024)
            ),
        ));
    }
    let mut file = File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take((MAX_DOCUMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "file exceeds the {} MiB limit",
                MAX_DOCUMENT_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(bytes)
}

fn line_count(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count();
    newlines + usize::from(!bytes.ends_with(b"\n"))
}

/// Atomically replace a text file without rendering lossy bytes irreversible.
pub fn write_text_file(path: &Path, text: &str) -> std::io::Result<()> {
    let expected = match std::fs::symlink_metadata(path) {
        Ok(_) => Some(digest(&read_bounded_bytes(path)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    replace_file_atomically(path, text.as_bytes(), expected).map(|_| ())
}

/// Replace a regular file via a same-directory `create_new` temp file.
///
/// Unix permissions are copied from the old inode. ACLs and extended attributes
/// are outside std's portable filesystem API and remain a known limitation.
fn replace_file_atomically(
    path: &Path,
    bytes: &[u8],
    expected_digest: Option<[u8; 32]>,
) -> std::io::Result<[u8; 32]> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let existing = match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "refusing to replace a symbolic link",
                ));
            }
            if !metadata.is_file() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "target is not a regular file",
                ));
            }
            if let Some(expected) = expected_digest {
                if digest(&read_bounded_bytes(path)?) != expected {
                    return Err(std::io::Error::other("file changed after it was opened"));
                }
            }
            Some(metadata)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected_digest.is_some() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "file was removed after it was opened",
                ));
            }
            None
        }
        Err(error) => return Err(error),
    };

    let (mut file, tmp) = create_temp_file(parent, path)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(metadata) = &existing {
            copy_replacement_permissions(&file, metadata)?;
        }
        drop(file);

        // Narrow the TOCTOU window without pretending std file APIs provide a
        // fully race-free compare-and-swap.
        if let Some(expected) = expected_digest {
            if digest(&read_bounded_bytes(path)?) != expected {
                return Err(std::io::Error::other(
                    "file changed while it was being saved",
                ));
            }
        }

        std::fs::rename(&tmp, path)?;
        sync_parent(parent)?;
        Ok(digest(bytes))
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn create_temp_file(parent: &Path, target: &Path) -> std::io::Result<(File, PathBuf)> {
    let stem = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document");
    for _ in 0..32 {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random)
            .map_err(|error| std::io::Error::other(format!("random temp name: {error}")))?;
        let tmp = parent.join(format!(".{stem}.litediff-{}.tmp", hex(&random)));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&tmp) {
            Ok(file) => return Ok((file, tmp)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary file",
    ))
}

fn copy_replacement_permissions(file: &File, original: &std::fs::Metadata) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(
            original.permissions().mode(),
        ))
    }
    #[cfg(not(unix))]
    {
        file.set_permissions(original.permissions())
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> std::io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Directory expansion for folder drops: regular files directly inside it.
pub fn list_text_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "litediff-save-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn register_approved(
        state: &AppState,
        side: Side,
        path: PathBuf,
        bom: bool,
        lossy: bool,
        digest: [u8; 32],
    ) -> Result<Side, String> {
        state.approve_path(&path)?;
        state.register_document(side, path, bom, lossy, digest)
    }

    #[test]
    fn options_patch_only_overrides_present_fields() {
        let base = DiffOptions::default();
        let patch = OptionsPatch {
            ignore_case: Some(true),
            ..Default::default()
        };
        let out = patch.apply_to(&base);
        assert!(out.ignore_case);
        assert_eq!(out.intra_line, base.intra_line);
    }

    #[test]
    fn empty_state_diffs_to_an_empty_session() {
        let state = AppState::default();
        let session = state.diff("tab-1").unwrap();
        assert_eq!(session.result.row_count(), 0);
        assert!(session.result.is_identical());
    }

    #[test]
    fn one_sided_state_diffs_against_empty() {
        let state = AppState::default();
        state
            .set_side(
                "tab-1",
                SideKind::Left,
                Side {
                    text: Arc::from("a\nb\n"),
                    ..Default::default()
                },
            )
            .unwrap();
        let session = state.diff("tab-1").unwrap();
        assert_eq!(session.result.row_count(), 2);
        assert_eq!(session.result.stats.deleted, 2);
        assert_eq!(session.left.text.as_ref(), "a\nb\n");
    }

    #[test]
    fn a_path_must_be_user_approved_before_the_backend_will_use_it() {
        let dir = temp_dir("approval-file");
        let path = dir.join("doc.txt");
        let sibling = dir.join("other.txt");
        std::fs::write(&path, "approved\n").unwrap();
        std::fs::write(&sibling, "not approved\n").unwrap();
        let state = AppState::default();

        assert!(state.require_approved_path(&path).is_err());
        let approved = state.approve_path(&path).unwrap();
        assert_eq!(approved, std::fs::canonicalize(&path).unwrap());
        assert!(state.require_approved_path(&path).is_ok());
        assert!(
            state.require_approved_path(&sibling).is_err(),
            "approving one file must not approve its directory"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn approving_a_directory_grants_its_subtree_but_not_siblings() {
        let dir = temp_dir("approval-directory");
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let path = nested.join("doc.txt");
        std::fs::write(&path, "inside\n").unwrap();
        let sibling = temp_dir("approval-directory-sibling");
        let outside = sibling.join("outside.txt");
        std::fs::write(&outside, "outside\n").unwrap();
        let state = AppState::default();

        state.approve_path(&dir).unwrap();
        assert!(state.require_approved_path(&path).is_ok());
        assert!(state.require_approved_path(&dir).is_ok());
        assert!(
            state.require_approved_path(&outside).is_err(),
            "a directory grant must not escape to a sibling tree"
        );
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&sibling).ok();
    }

    #[test]
    fn write_text_file_round_trips_and_leaves_no_temp_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("doc.txt");

        write_text_file(&path, "hello\nworld\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\nworld\n");
        write_text_file(&path, "changed\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "changed\n");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("litediff-") && name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bom_round_trips_without_becoming_text() {
        let dir = temp_dir("bom");
        let path = dir.join("bom.txt");
        std::fs::write(&path, [0xEF, 0xBB, 0xBF, b'a', b'b', b'c']).unwrap();

        let decoded = read_text_file(&path).unwrap();
        assert!(decoded.bom);
        assert_eq!(decoded.text.as_ref(), "abc");

        let state = AppState::default();
        let side = register_approved(
            &state,
            Side {
                label: "bom.txt".into(),
                text: decoded.text,
                ..Default::default()
            },
            path.clone(),
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )
        .unwrap();
        state.set_sides("tab-bom", side, Side::default()).unwrap();
        state.save_current("tab-bom").unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            [0xEF, 0xBB, 0xBF, b'a', b'b', b'c']
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lossy_decoding_is_reported_and_save_is_refused() {
        let dir = temp_dir("lossy");
        let path = dir.join("bin.dat");
        std::fs::write(&path, [0xFF, 0xFE, 0x00, 0x41]).unwrap();

        let decoded = read_text_file(&path).unwrap();
        assert!(decoded.lossy);
        assert!(decoded.warning.is_some());
        let original = std::fs::read(&path).unwrap();

        let state = AppState::default();
        let side = register_approved(
            &state,
            Side {
                text: decoded.text,
                ..Default::default()
            },
            path.clone(),
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )
        .unwrap();
        state.set_sides("tab-lossy", side, Side::default()).unwrap();
        assert!(state.save_current("tab-lossy").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn external_change_after_open_is_rejected() {
        let dir = temp_dir("external");
        let path = dir.join("doc.txt");
        std::fs::write(&path, "before\n").unwrap();
        let decoded = read_text_file(&path).unwrap();
        let state = AppState::default();
        let side = register_approved(
            &state,
            Side {
                text: decoded.text,
                ..Default::default()
            },
            path.clone(),
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )
        .unwrap();
        state
            .set_sides("tab-external", side, Side::default())
            .unwrap();
        std::fs::write(&path, "changed elsewhere\n").unwrap();
        assert!(state.save_current("tab-external").is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "changed elsewhere\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_capabilities_for_one_canonical_path_are_saved_once() {
        let dir = temp_dir("duplicate-path");
        let path = dir.join("doc.txt");
        std::fs::write(&path, "before\n").unwrap();
        let first = read_text_file(&path).unwrap();
        let second = read_text_file(&dir.join(".").join("doc.txt")).unwrap();
        let state = AppState::default();
        let left = register_approved(
            &state,
            Side {
                label: "doc.txt (left)".into(),
                text: first.text,
                ..Default::default()
            },
            path.clone(),
            first.bom,
            first.lossy,
            first.digest,
        )
        .unwrap();
        let right = register_approved(
            &state,
            Side {
                label: "doc.txt (right)".into(),
                text: second.text,
                ..Default::default()
            },
            dir.join(".").join("doc.txt"),
            second.bom,
            second.lossy,
            second.digest,
        )
        .unwrap();
        state.set_sides("tab-duplicate", left, right).unwrap();

        let saved = state.save_current("tab-duplicate").unwrap();
        assert_eq!(saved.len(), 2, "both pane labels are reported");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "before\n");
        assert_eq!(
            state.save_current("tab-duplicate").unwrap().len(),
            2,
            "both capabilities must receive the new digest"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conflicting_drafts_for_one_canonical_path_abort_before_writing() {
        let dir = temp_dir("duplicate-conflict");
        let path = dir.join("doc.txt");
        std::fs::write(&path, "before\n").unwrap();
        let decoded = read_text_file(&path).unwrap();
        let state = AppState::default();
        let left = register_approved(
            &state,
            Side {
                text: decoded.text.clone(),
                ..Default::default()
            },
            path.clone(),
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )
        .unwrap();
        let right = register_approved(
            &state,
            Side {
                text: Arc::from("different draft\n"),
                ..Default::default()
            },
            dir.join(".").join("doc.txt"),
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )
        .unwrap();
        state.set_sides("tab-conflict", left, right).unwrap();

        let error = state.save_current("tab-conflict").unwrap_err();
        assert!(error.contains("不同草稿"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "before\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn saves_are_serialized_before_their_digest_preflight() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = temp_dir("save-lock");
        let path = dir.join("doc.txt");
        std::fs::write(&path, "before\n").unwrap();
        let decoded = read_text_file(&path).unwrap();
        let state = AppState::default();
        let side = register_approved(
            &state,
            Side {
                text: Arc::from("after\n"),
                ..Default::default()
            },
            path.clone(),
            decoded.bom,
            decoded.lossy,
            decoded.digest,
        )
        .unwrap();
        state
            .set_sides("tab-save-lock", side, Side::default())
            .unwrap();

        let guard = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let worker_state = state.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(worker_state.save_current("tab-save-lock")).unwrap();
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "a second save must wait for the process save lock"
        );
        drop(guard);
        assert!(rx
            .recv_timeout(Duration::from_secs(5))
            .expect("save completed")
            .is_ok());
        worker.join().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn files_over_the_line_limit_are_rejected_before_diffing() {
        let dir = temp_dir("line-limit");
        let path = dir.join("many-lines.txt");
        let body = vec![b'\n'; MAX_DOCUMENT_LINES + 1];
        std::fs::write(&path, body).unwrap();
        let error = read_text_file(&path).unwrap_err();
        assert!(error.to_string().contains("line limit"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_save_preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let path = dir.join("private.txt");
        std::fs::write(&path, "secret\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        write_text_file(&path, "updated\n").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_text_files_skips_symlinks() {
        let dir = temp_dir("list");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("a.txt"), dir.join("link.txt")).unwrap();

        let files = list_text_files(&dir).unwrap();
        let names: Vec<String> = files
            .iter()
            .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
            .map(str::to_string)
            .collect();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn preexisting_temp_symlink_is_never_followed() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir("symlink-temp");
        let target = dir.join("doc.txt");
        let outside = dir.join("outside.txt");
        std::fs::write(&target, "inside\n").unwrap();
        std::fs::write(&outside, "outside\n").unwrap();
        symlink(&outside, dir.join(".doc.txt.litediff-tmp")).unwrap();

        write_text_file(&target, "new\n").unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside\n");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_a_symlink_target_is_rejected() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir("symlink-target");
        let real = dir.join("real.txt");
        let link = dir.join("link.txt");
        std::fs::write(&real, "original\n").unwrap();
        symlink(&real, &link).unwrap();

        assert!(write_text_file(&link, "changed\n").is_err());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "original\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn toggling_options_rediffs_from_cached_sources() {
        let state = AppState::default();
        state
            .set_sides(
                "tab-options",
                Side {
                    text: Arc::from("a\n"),
                    ..Default::default()
                },
                Side {
                    text: Arc::from("a  \n"),
                    ..Default::default()
                },
            )
            .unwrap();

        let strict = state.diff("tab-options").unwrap();
        assert!(!strict.result.is_identical());

        state
            .set_options(
                "tab-options",
                DiffOptions {
                    ignore_whitespace: true,
                    ..DiffOptions::default()
                },
            )
            .unwrap();
        let relaxed = state.diff("tab-options").unwrap();
        assert!(relaxed.result.is_identical());
        assert_eq!(relaxed.left.text.as_ref(), "a\n");
    }

    #[test]
    fn session_json_keeps_its_shape_but_carries_a_compact_result() {
        let state = AppState::default();
        state
            .set_sides(
                "tab-json",
                Side {
                    text: Arc::from("a\nb\n"),
                    ..Default::default()
                },
                Side {
                    text: Arc::from("a\nc\n"),
                    ..Default::default()
                },
            )
            .unwrap();
        let value = serde_json::to_value(state.diff("tab-json").unwrap()).unwrap();
        let session = value.as_object().unwrap();
        // The outer Session object keeps its camelCase IPC shape.
        for key in [
            "left",
            "right",
            "result",
            "options",
            "warnings",
            "contentKey",
        ] {
            assert!(session.contains_key(key), "Session field {key} missing");
        }
        // Only the nested diff payload changed: no row grid, compact fields.
        let result = session["result"].as_object().unwrap();
        assert!(!result.contains_key("rows"));
        for key in [
            "left_line_count",
            "right_line_count",
            "hunks",
            "stats",
            "approximate",
            "left_changed",
            "right_changed",
        ] {
            assert!(result.contains_key(key), "WireDiff field {key} missing");
        }
    }

    #[test]
    fn cached_sources_share_the_side_text_allocation() {
        let state = AppState::default();
        let text: Arc<str> = Arc::from("a\nb\n");
        state
            .set_sides(
                "tab-shared",
                Side {
                    text: Arc::clone(&text),
                    ..Default::default()
                },
                Side::default(),
            )
            .unwrap();

        // A diff() snapshot must clone the pointer, never the line index.
        let sessions = state.sessions();
        let session = sessions.get("tab-shared").unwrap();
        assert!(Arc::ptr_eq(&session.left.text, &text));
        assert!(Arc::ptr_eq(&session.left_source.shared_text(), &text));
        assert!(Arc::ptr_eq(
            &session.left_source.shared_text(),
            &session.left.text
        ));
    }
}
