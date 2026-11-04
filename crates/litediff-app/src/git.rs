//! Git integration: browse a repository, list a file's revisions, and read that
//! file at any revision.
//!
//! ## Why the `git` binary instead of `git2`
//!
//! `git2` (libgit2 bindings) would add several megabytes and a C toolchain
//! dependency to an app that currently ships at 8 MB with no native libraries
//! beyond what Tauri already needs. Every operation here — resolve a repo, list
//! commits, read a blob — is a single read-only git command whose output is
//! stable and documented, so shelling out is both smaller and less coupled to a
//! specific libgit2 version.
//!
//! ## Safety rules
//!
//! * Only read-only subcommands are ever run: `rev-parse`, `log`, `show`,
//!   `ls-files`. Nothing here can modify a repository, so a bug in this module
//!   cannot corrupt user data.
//! * Arguments are passed as an argv vector, never through a shell, so a filename
//!   containing spaces, quotes, or `;` is inert data rather than an injection.
//! * A user-supplied revision is first resolved to a 40-character object id with
//!   `rev-parse --verify`. That both normalises `HEAD~3` and eliminates option
//!   injection: a revision typed as `--upload-pack=...` is rejected by
//!   `rev-parse` instead of reaching the command that would act on it.
//! * A path is rejected if it is absolute or contains a `..` component, so a side
//!   labelled `../../.ssh/id_rsa` cannot be used to read outside the repository.
//! * Every command runs with `-C <dir>`, so the app's own working directory never
//!   matters.
//! * Output is parsed from a delimiter-separated, `--no-pager` format so a user's
//!   git config (colours, aliases, pager) cannot change the shape of the data.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Sentinel revision meaning "what is on disk right now".
///
/// Chosen as an all-caps word so it can never collide with a real branch or tag
/// name a user might create, and so the frontend and backend agree on one
/// spelling rather than passing `None` around.
pub const WORKTREE: &str = "WORKTREE";

/// One commit that touched the requested file.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// Full 40-character SHA.
    pub sha: String,
    /// Abbreviated SHA for display.
    pub short: String,
    /// Author date, ISO-8601.
    pub date: String,
    /// Author name.
    pub author: String,
    /// First line of the commit message.
    pub subject: String,
    /// Refs pointing at this commit, e.g. `HEAD -> main`, `origin/main`.
    pub refs: String,
}

/// A repository resolved from a path inside it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute path of the repository root.
    pub root: String,
    /// Last path component of `root`, for display.
    pub name: String,
    /// Path of the requested file relative to the root; empty for a directory.
    pub relative_path: String,
    /// Current branch name, or `detached HEAD`.
    pub branch: String,
}

/// Text read from a file at some revision.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlob {
    /// Decoded text. A file that does not exist at that revision yields `""`.
    pub text: String,
    /// Human label, e.g. `a1b2c3d · src/main.rs`.
    pub label: String,
    /// Non-fatal notes, e.g. "not valid UTF-8".
    pub warnings: Vec<String>,
}

/// Field separator for machine-readable `git log` output.
///
/// A unit separator (0x1f) is used because it cannot occur in a commit subject or
/// author name typed by a human, unlike `|`, tab, or comma.
const FS: char = '\u{1f}';

/// Run a git command in `dir` and return raw stdout.
///
/// stderr is surfaced verbatim: git's own message ("not a git repository",
/// "unknown revision") is far more useful than a synthesised one.
fn run(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("--no-pager")
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "找不到 git 命令，请先安装 Git".to_string()
            } else {
                format!("无法执行 git：{e}")
            }
        })?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg = err.trim();
        return Err(if msg.is_empty() {
            "git 命令失败（无错误输出）".to_string()
        } else {
            msg.to_string()
        });
    }

    Ok(output.stdout)
}

/// Run a git command and return stdout as text, tolerating invalid UTF-8.
fn run_text(dir: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&run(dir, args)?).into_owned())
}

/// The directory to hand to `-C`.
///
/// `git -C <file>` fails: it changes into the path, which a regular file is not.
/// Callers legitimately start from a file ("the history of *this* file"), so the
/// containing directory is derived here instead of at every call site.
fn work_dir(path: &Path) -> &Path {
    if path.is_dir() {
        return path;
    }
    path.parent().unwrap_or(path)
}

/// Reject a path that would escape the repository.
///
/// `git show rev:../../etc/passwd` is not valid git syntax and would fail on its
/// own, but the working-tree read in [`worktree_file`] is a plain filesystem
/// call and does need the guard.
fn check_relative(file: &str) -> Result<(), String> {
    if file.trim().is_empty() {
        return Err("文件路径为空".to_string());
    }
    let p = Path::new(file);
    if p.is_absolute() {
        return Err(format!("需要仓库内的相对路径：{file}"));
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("路径不能跳出仓库：{file}"));
    }
    Ok(())
}

/// One local branch.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Short name as `git switch` accepts it, e.g. `main`, `feature/x`.
    pub name: String,
    /// Abbreviated commit id at the branch tip.
    pub short: String,
    /// Author date of that commit, ISO-8601.
    pub date: String,
    /// True for the branch HEAD points at.
    pub current: bool,
    /// Upstream in `origin/main` form, empty when the branch has none.
    pub upstream: String,
    /// Commits this branch has that its upstream does not, or 0.
    pub ahead: u32,
    /// Commits the upstream has that this branch does not, or 0.
    pub behind: u32,
}

/// One file that differs between two revisions.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Path relative to the repository root.
    pub path: String,
    /// `A` added, `M` modified, `D` deleted, `R` renamed, and so on.
    pub status: String,
    /// Lines added, or `None` for a binary file.
    pub added: Option<u32>,
    /// Lines deleted, or `None` for a binary file.
    pub deleted: Option<u32>,
}

/// Resolve the repository that contains `path`, and the path's relation to it.
///
///
/// `path` may be a file or a directory; for a directory the relative path is
/// empty.
pub fn resolve_repo(path: &str) -> Result<RepoInfo, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }

    // `--show-toplevel` fails outside a work tree, which is exactly the error we
    // want to report rather than inventing our own detection rules.
    let root = run_text(work_dir(p), &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    if root.is_empty() {
        return Err("该路径不在 Git 仓库中".to_string());
    }

    // Canonicalise both sides before subtracting: on macOS `/var` is a symlink to
    // `/private/var`, and a `strip_prefix` between a canonicalised path and a
    // non-canonical root silently yields an empty relative path.
    let root_canon = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let target = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let relative = if target.is_dir() {
        String::new()
    } else {
        target
            .strip_prefix(&root_canon)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default()
    };

    let name = root_canon
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&root)
        .to_string();

    // `--abbrev-ref HEAD` prints "HEAD" when detached; say so plainly. A
    // repository with no commits yet also has no HEAD, and says so as an error.
    let branch = run_text(work_dir(p), &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let branch = match branch.as_str() {
        "HEAD" => "detached HEAD".to_string(),
        "" => "无提交".to_string(),
        other => other.to_string(),
    };

    Ok(RepoInfo {
        root,
        name,
        relative_path: relative,
        branch,
    })
}

/// True when `path` is inside a git work tree.
///
/// Used to decide whether to offer the history UI at all, rather than showing it
/// and failing on first use.
pub fn is_repo(path: &str) -> bool {
    let p = Path::new(path);
    if !p.exists() {
        return false;
    }
    run_text(work_dir(p), &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// List files in the repository: tracked first, then untracked-but-not-ignored.
///
/// `-z` disables git's path quoting, so a filename containing a space, a quote,
/// or a non-ASCII character arrives verbatim instead of C-escaped.
pub fn list_files(repo: &str, limit: usize) -> Result<Vec<String>, String> {
    let limit = limit.clamp(1, 20_000);
    let out = run(
        Path::new(repo),
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;

    let mut files: Vec<String> = String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    files.sort();
    // A file that is staged and also still untracked lists once, but a duplicate
    // would render as two identical rows the user cannot tell apart.
    files.dedup();
    files.truncate(limit);
    Ok(files)
}

/// List commits that touched `file`, newest first.
///
/// `--follow` keeps history across renames, which is what a user means by "the
/// history of this file". A file with no commits (new, untracked) yields an empty
/// list rather than an error: that is a normal state, not a failure.
pub fn log_for_file(repo: &str, file: &str, limit: usize) -> Result<Vec<CommitInfo>, String> {
    check_relative(file)?;
    let limit = limit.clamp(1, 500);
    let limit_arg = format!("-{limit}");

    // `--format` is machine-readable and immune to the user's colours/pager
    // settings; `%D` is the ref decoration ("HEAD -> main, origin/main").
    let format = format!("--format=%H{FS}%h{FS}%aI{FS}%an{FS}%s{FS}%D");

    let out = match run_text(
        Path::new(repo),
        &["log", &limit_arg, "--follow", &format, "--", file],
    ) {
        Ok(s) => s,
        // A fresh repository has no HEAD to walk. Report "no history" rather than
        // an error the UI would have to special-case.
        Err(e) if e.contains("does not have any commits yet") => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };

    let mut commits = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split(FS);
        let sha = parts.next().unwrap_or_default().to_string();
        let short = parts.next().unwrap_or_default().to_string();
        let date = parts.next().unwrap_or_default().to_string();
        let author = parts.next().unwrap_or_default().to_string();
        let subject = parts.next().unwrap_or_default().to_string();
        let refs = parts.next().unwrap_or_default().to_string();
        if sha.is_empty() {
            continue;
        }
        commits.push(CommitInfo {
            sha,
            short,
            date,
            author,
            subject,
            refs,
        });
    }
    Ok(commits)
}

/// Resolve any revision expression to a full object id.
///
/// This is the injection barrier described in the module docs: after it, only a
/// hex string reaches `git show`.
fn resolve_rev(repo: &str, rev: &str) -> Result<String, String> {
    let rev = rev.trim();
    if rev.is_empty() {
        return Err("版本号为空".to_string());
    }
    let spec = format!("{rev}^{{commit}}");
    let sha = run_text(
        Path::new(repo),
        &["rev-parse", "--verify", "--end-of-options", &spec],
    )?
    .trim()
    .to_string();

    // Defence in depth: `--verify` already prints exactly one object id, but a
    // non-hex result must never be allowed to be spliced into `<sha>:<path>`.
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("无法识别的版本：{rev}"));
    }
    Ok(sha)
}

/// Read a file's contents at a revision.
///
/// `rev` accepts anything git resolves: a SHA, a tag, a branch, `HEAD~3`. The
/// working tree is spelled [`WORKTREE`] and handled by [`worktree_file`], because
/// reading the live file must reflect uncommitted edits rather than a blob.
pub fn show_file(repo: &str, rev: &str, file: &str) -> Result<GitBlob, String> {
    check_relative(file)?;
    let sha = resolve_rev(repo, rev)?;

    // `<rev>:<path>` needs the path relative to the root and with forward slashes;
    // `check_relative` has already rejected absolute and `..` forms.
    let spec = format!("{sha}:{file}");
    let bytes = match run(Path::new(repo), &["show", &spec]) {
        Ok(b) => b,
        Err(e) => {
            // A path that did not exist at that revision is a normal situation
            // when browsing history (a file is added later, or renamed). Report
            // it as an empty side so the diff still opens, with a note saying why.
            if e.contains("does not exist in") || e.contains("exists on disk, but not in") {
                return Ok(GitBlob {
                    text: String::new(),
                    label: format!("{} · {file}", &sha[..7]),
                    warnings: vec![format!("该版本中不存在此文件（{}）", &sha[..7])],
                });
            }
            return Err(e);
        }
    };

    let mut warnings = Vec::new();
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            // Binary blobs are common enough (icons, archives) that failing the
            // whole comparison would be worse than showing a lossy view of it.
            warnings.push("该文件不是 UTF-8 文本，已用替换字符显示".to_string());
            String::from_utf8_lossy(e.as_bytes()).into_owned()
        }
    };

    Ok(GitBlob {
        text,
        label: format!("{} · {file}", &sha[..7]),
        warnings,
    })
}

/// Read the working-tree file, bypassing git.
///
/// Kept separate from [`show_file`] so "compare against what I have right now"
/// never goes through a blob — the file may have uncommitted edits.
pub fn worktree_file(repo: &str, file: &str) -> Result<GitBlob, String> {
    check_relative(file)?;
    let path = Path::new(repo).join(file);
    let (text, warning) =
        crate::read_text_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(GitBlob {
        text,
        label: format!("工作区 · {file}"),
        warnings: warning.into_iter().collect(),
    })
}

/// Read a file at `rev`, dispatching the [`WORKTREE`] sentinel.
///
/// One entry point for the UI: a revision picker can offer "工作区" alongside real
/// commits without the frontend knowing that the two are read completely
/// differently.
pub fn blob_at(repo: &str, rev: &str, file: &str) -> Result<GitBlob, String> {
    if rev == WORKTREE {
        worktree_file(repo, file)
    } else {
        show_file(repo, rev, file)
    }
}

// --- branches ---------------------------------------------------------------

/// Validate a branch name before it reaches `git switch`.
///
/// `git switch` rejects options and malformed refs on its own (verified: `-x`,
/// `--force`, `a b`, `HEAD`, `origin/main` and names containing a newline are all
/// refused), so this is the second lock on the same door. It exists because the
/// first lock belongs to a program that is not ours: the name arrives from the
/// frontend, and a git whose parsing differs in some later version must not become
/// a way to pass `--force`.
///
/// The rules are git's own for a branch name, minus the cases this app never needs.
fn check_branch(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 {
        return Err(format!("分支名无效：{name:?}"));
    }
    // No leading dash: that is the only form that can look like an option.
    if name.starts_with('-') {
        return Err(format!("分支名不能以 - 开头：{name}"));
    }
    // Reject the characters git itself forbids, plus whitespace and control codes.
    // `..` and `@{` are the two sequences that make `git rev-parse` reinterpret a
    // name as a revision expression.
    let forbidden = [
        ' ', '\t', '\n', '\r', '~', '^', ':', '?', '*', '[', '\\', '\u{7f}',
    ];
    if name.chars().any(|c| forbidden.contains(&c) || c.is_control()) {
        return Err(format!("分支名含有非法字符：{name}"));
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return Err(format!("分支名含有非法序列：{name}"));
    }
    if name.ends_with('/') || name.ends_with(".lock") || name == "@" {
        return Err(format!("分支名无效：{name}"));
    }
    // `HEAD` and its friends are revisions, not branches. git rejects them, but a
    // name that can be read as a revision expression is the shape this function
    // exists to refuse — refusing it here keeps that rule in one place.
    if name == "HEAD" || name.starts_with("HEAD/") || name == "ORIG_HEAD" {
        return Err(format!("不是一个分支名：{name}"));
    }
    // A remote-tracking ref (`origin/main`, `refs/remotes/...`) is not a local
    // branch and is not something `git switch` can move HEAD to without first
    // creating the branch. Accepting it would put entries in the list that fail
    // on use.
    if name.starts_with("refs/") || name.starts_with("origin/") {
        return Err(format!("不是本地分支名：{name}"));
    }
    Ok(())
}

/// Local branches, current one first, then most recently committed.
///
/// Only `refs/heads`: remote-tracking branches are not things `git switch` can
/// move HEAD to, so offering them would produce a list where half the entries
/// fail. The upstream and ahead/behind counts are decoration for the branch list.
pub fn list_branches(repo: &str) -> Result<Vec<BranchInfo>, String> {
    let format = format!(
        "--format=%(refname:short){FS}%(objectname:short){FS}%(committerdate:iso8601){FS}%(HEAD){FS}%(upstream:short){FS}%(upstream:track,nobracket)"
    );
    let out = run_text(Path::new(repo), &["for-each-ref", &format, "refs/heads"])?;
    let mut branches = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split(FS);
        let name = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let short = parts.next().unwrap_or("").to_string();
        let date = parts.next().unwrap_or("").to_string();
        let head = parts.next().unwrap_or("");
        let upstream = parts.next().unwrap_or("").to_string();
        let track = parts.next().unwrap_or("");

        // `%(upstream:track,nobracket)` renders "ahead 2, behind 1". Parsing it is
        // the only way `for-each-ref` exposes the counts, and the two words are
        // fixed by git's own output template.
        let count = |word: &str| -> u32 {
            track
                .split(',')
                .find_map(|part| part.trim().strip_prefix(word))
                .and_then(|n| n.trim().parse().ok())
                .unwrap_or(0)
        };

        branches.push(BranchInfo {
            name,
            short,
            date,
            current: head == "*",
            upstream,
            ahead: count("ahead"),
            behind: count("behind"),
        });
    }

    // Current branch first, then newest. Comparing across branches is the reason
    // this list exists, and the branch you are on is the one you compare *from*
    // most of the time.
    branches.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then_with(|| b.date.cmp(&a.date))
    });
    Ok(branches)
}

/// Files that differ between two revisions.
///
/// Two git calls, because neither one alone is enough: `--name-status` gives the
/// change kind (added / modified / deleted / renamed) and `--numstat` gives the
/// line counts. `--numstat` prints `-` instead of counts for a binary file, which
/// is why the counts are `Option`.
///
/// `rev` values are resolved first, so only object ids reach the diff command.
pub fn diff_files(repo: &str, left: &str, right: &str) -> Result<Vec<ChangedFile>, String> {
    let left_sha = resolve_rev(repo, left)?;
    let right_sha = resolve_rev(repo, right)?;

    let status_out = run_text(
        Path::new(repo),
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            &left_sha,
            &right_sha,
        ],
    )?;

    let numstat_out = run_text(
        Path::new(repo),
        &["diff", "--numstat", "-z", "--no-renames", &left_sha, &right_sha],
    )?;

    // One entry per path, so the two streams can be joined without depending on
    // their order matching.
    let mut counts: std::collections::HashMap<String, (Option<u32>, Option<u32>)> =
        std::collections::HashMap::new();
    // `-z` output for --numstat is "added\tdeleted\tpath\0".
    for record in numstat_out.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, '\t');
        let added = fields.next().unwrap_or("");
        let deleted = fields.next().unwrap_or("");
        let path = fields.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let parse = |v: &str| v.parse::<u32>().ok();
        counts.insert(path.to_string(), (parse(added), parse(deleted)));
    }

    // `-z` --name-status output is "STATUS\0path\0".
    let mut files = Vec::new();
    let mut fields = status_out.split('\0');
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let Some(path) = fields.next() else {
            break;
        };
        if path.is_empty() {
            continue;
        }
        let (added, deleted) = counts
            .get(path)
            .copied()
            .unwrap_or((Some(0), Some(0)));
        files.push(ChangedFile {
            path: path.to_string(),
            status: status.chars().next().unwrap_or('M').to_string(),
            added,
            deleted,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Switch the working tree to a local branch.
///
/// ## This is the app's only write to the repository
///
/// Everything else here reads. Switching branches rewrites the working tree, so
/// three properties are load-bearing:
///
/// 1. **Never destructive.** No `--force`, no `-C`, no `checkout --`. If git would
///    have to discard local changes, it refuses and that refusal is reported
///    verbatim. The user's edits must survive a mis-click.
/// 2. **The name is validated twice.** [`check_branch`] rejects anything shaped
///    like an option or a revision expression, and `--end-of-options` plus git's
///    own `git switch` parsing (which accepts only a branch name, not
///    `refs/heads/x`, not `HEAD~1`, not a remote ref) is the second lock.
/// 3. **It reports where it landed.** The returned [`RepoInfo`] is re-resolved
///    after the switch rather than patched in, because git may have normalised the
///    branch or the work tree may have a state the caller cannot predict.
pub fn switch_branch(repo: &str, branch: &str) -> Result<RepoInfo, String> {
    check_branch(branch)?;
    let dir = Path::new(repo);
    if !dir.is_dir() {
        return Err(format!("仓库路径无效：{repo}"));
    }

    run(
        dir,
        // `--end-of-options` terminates option parsing, so a name that survived
        // `check_branch` still cannot be reinterpreted as a flag.
        &["switch", "--end-of-options", branch],
    )?;

    // Re-resolve instead of trusting the requested name: a branch checked out
    // through a path-like name, or a worktree whose HEAD git rewrote, would
    // otherwise leave the panel showing a branch it is not on.
    resolve_repo(repo)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repository with a known history.
    ///
    /// Settings are pinned per-invocation (`-c user.name=...`) so the test does not
    /// depend on the machine's global git config, which is what makes it pass on a
    /// clean CI runner.
    struct TempRepo {
        dir: PathBuf,
    }

    impl TempRepo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "litediff-git-{}-{}",
                name,
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp repo");
            let t = TempRepo { dir };
            t.run(&["init", "-q", "-b", "main"]);
            t
        }

        fn run(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .expect("run git");
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).to_string()
        }

        fn write(&self, name: &str, body: &str) {
            let p = self.dir.join(name);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(p, body).expect("write");
        }

        fn commit(&self, message: &str) {
            self.run(&["add", "-A"]);
            self.run(&["commit", "-q", "-m", message]);
        }

        fn path(&self) -> String {
            self.dir.to_string_lossy().to_string()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn resolves_repo_and_relative_path() {
        let repo = TempRepo::new("resolve");
        repo.write("src/main.rs", "fn main() {}\n");
        repo.commit("initial");

        let info = resolve_repo(&repo.dir.join("src/main.rs").to_string_lossy()).expect("resolve");
        assert_eq!(info.relative_path, "src/main.rs");
        assert_eq!(info.branch, "main");
        assert!(info.root.ends_with(
            repo.dir.file_name().expect("name").to_string_lossy().as_ref()
        ));
    }

    #[test]
    fn resolves_from_the_repository_root_and_a_subdirectory() {
        // `git -C <file>` fails, so passing a file path must be routed through its
        // parent directory; a directory has no relative path.
        let repo = TempRepo::new("resolve-dir");
        repo.write("src/deep/a.rs", "a\n");
        repo.commit("initial");

        let root = resolve_repo(&repo.path()).expect("root");
        assert_eq!(root.relative_path, "");
        assert!(!root.name.is_empty());

        let sub = resolve_repo(&repo.dir.join("src/deep").to_string_lossy()).expect("subdir");
        assert_eq!(sub.relative_path, "");
        assert_eq!(sub.root, root.root);
    }

    #[test]
    fn logs_only_commits_that_touched_the_file() {
        let repo = TempRepo::new("log");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.write("other.txt", "x\n");
        repo.commit("unrelated");
        repo.write("a.txt", "two\n");
        repo.commit("second");

        let commits = log_for_file(&repo.path(), "a.txt", 10).expect("log");
        // Two commits touched a.txt; the unrelated one must not appear.
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second", "newest first");
        assert_eq!(commits[1].subject, "first");
        // Short SHAs are the abbreviation of the full ones.
        assert!(commits[0].sha.starts_with(&commits[0].short));
        assert_eq!(commits[0].sha.len(), 40);
    }

    #[test]
    fn log_survives_a_repository_with_no_commits() {
        let repo = TempRepo::new("empty");
        repo.write("a.txt", "uncommitted\n");
        let commits = log_for_file(&repo.path(), "a.txt", 10).expect("log");
        assert!(commits.is_empty(), "a fresh repo has no history, not an error");
    }

    #[test]
    fn shows_file_at_an_older_revision() {
        let repo = TempRepo::new("show");
        repo.write("a.txt", "v1\n");
        repo.commit("first");
        let first = log_for_file(&repo.path(), "a.txt", 10).expect("log")[0].sha.clone();

        repo.write("a.txt", "v2\n");
        repo.commit("second");

        let old = show_file(&repo.path(), &first, "a.txt").expect("show old");
        assert_eq!(old.text, "v1\n");
        assert_eq!(old.warnings.len(), 0);
        assert!(old.label.contains("a.txt"));

        let current = worktree_file(&repo.path(), "a.txt").expect("worktree");
        assert_eq!(current.text, "v2\n");
    }

    #[test]
    fn uncommitted_edits_show_in_the_worktree_but_not_in_a_blob_scoped_by_rev() {
        // The whole point of comparing "工作区" against a commit: ⌘S-less edits on
        // disk must be visible on the left even though the blob is untouched.
        let repo = TempRepo::new("dirty");
        repo.write("a.txt", "committed\n");
        repo.commit("first");
        let sha = log_for_file(&repo.path(), "a.txt", 10).expect("log")[0].sha.clone();

        repo.write("a.txt", "edited but not staged\n");

        let head = show_file(&repo.path(), &sha, "a.txt").expect("show");
        assert_eq!(head.text, "committed\n");
        let live = blob_at(&repo.path(), WORKTREE, "a.txt").expect("worktree");
        assert_eq!(live.text, "edited but not staged\n");
    }

    #[test]
    fn missing_path_at_revision_is_empty_with_a_warning() {
        let repo = TempRepo::new("missing");
        repo.write("a.txt", "a\n");
        repo.commit("first");
        let first = log_for_file(&repo.path(), "a.txt", 10).expect("log")[0].sha.clone();

        repo.write("b.txt", "b\n");
        repo.commit("add b");

        // b.txt did not exist at the first commit.
        let blob = show_file(&repo.path(), &first, "b.txt").expect("show");
        assert_eq!(blob.text, "");
        assert_eq!(blob.warnings.len(), 1);
        assert!(blob.warnings[0].contains("不存在"));
    }

    #[test]
    fn accepts_branch_and_relative_revisions() {
        let repo = TempRepo::new("revspec");
        repo.write("a.txt", "v1\n");
        repo.commit("first");
        repo.write("a.txt", "v2\n");
        repo.commit("second");

        // Any rev spec git understands must work, not just full SHAs.
        assert_eq!(
            show_file(&repo.path(), "HEAD~1", "a.txt").expect("head~1").text,
            "v1\n"
        );
        assert_eq!(
            show_file(&repo.path(), "main", "a.txt").expect("branch").text,
            "v2\n"
        );
        assert_eq!(
            show_file(&repo.path(), "HEAD", "a.txt").expect("head").text,
            "v2\n"
        );
    }

    #[test]
    fn an_option_shaped_revision_is_rejected_rather_than_executed() {
        // Without `rev-parse --verify` this string would reach `git show` as a
        // genuine option. It must fail as an unknown revision instead.
        let repo = TempRepo::new("injection");
        repo.write("a.txt", "a\n");
        repo.commit("first");

        let err = show_file(&repo.path(), "--upload-pack=touch /tmp/pwned", "a.txt")
            .expect_err("must not resolve");
        assert!(!err.is_empty());
    }

    #[test]
    fn paths_that_escape_the_repository_are_rejected() {
        let repo = TempRepo::new("escape");
        repo.write("a.txt", "a\n");
        repo.commit("first");

        assert!(worktree_file(&repo.path(), "../../etc/passwd").is_err());
        assert!(worktree_file(&repo.path(), "/etc/passwd").is_err());
        assert!(show_file(&repo.path(), "HEAD", "../a.txt").is_err());
        assert!(log_for_file(&repo.path(), "", 10).is_err());
    }

    #[test]
    fn non_repo_path_reports_a_clear_error() {
        let dir = std::env::temp_dir().join(format!("litediff-norepo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        assert!(!is_repo(&dir.to_string_lossy()));
        assert!(resolve_repo(&dir.to_string_lossy()).is_err());
        assert!(!is_repo("/definitely/not/here"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filenames_with_spaces_and_quotes_are_safe() {
        // The classic injection shape: a name that would break a shell string.
        let repo = TempRepo::new("weirdname");
        let name = "a b'c;d e.txt";
        repo.write(name, "content\n");
        repo.commit("weird");

        let commits = log_for_file(&repo.path(), name, 10).expect("log");
        assert_eq!(commits.len(), 1);
        assert_eq!(
            show_file(&repo.path(), &commits[0].sha, name).expect("show").text,
            "content\n"
        );
    }

    #[test]
    fn listing_files_includes_nested_and_non_ascii_names_verbatim() {
        let repo = TempRepo::new("lsfiles");
        repo.write("src/文件 名.rs", "x\n");
        repo.write("b.txt", "b\n");
        repo.commit("initial");
        // Untracked but not ignored: the user can still want its (empty) history.
        repo.write("new.txt", "n\n");

        let files = list_files(&repo.path(), 100).expect("ls-files");
        assert!(files.contains(&"src/文件 名.rs".to_string()), "{files:?}");
        assert!(files.contains(&"b.txt".to_string()));
        assert!(files.contains(&"new.txt".to_string()));

        // Sorted and deduplicated so the picker has one stable order.
        let mut sorted = files.clone();
        sorted.sort();
        assert_eq!(files, sorted);
    }

    #[test]
    fn commit_subject_is_parsed_whole_even_with_separators() {
        let repo = TempRepo::new("subject");
        repo.write("a.txt", "x\n");
        // Pipes and tabs must not split fields; only the unit separator does.
        repo.commit("fix: handle | pipes\tand tabs");

        let commits = log_for_file(&repo.path(), "a.txt", 5).expect("log");
        assert_eq!(commits[0].subject, "fix: handle | pipes\tand tabs");
    }

    #[test]
    fn limit_is_clamped_to_a_sane_range() {
        let repo = TempRepo::new("limit");
        repo.write("a.txt", "0\n");
        repo.commit("c0");
        for i in 1..5 {
            repo.write("a.txt", &format!("{i}\n"));
            repo.commit(&format!("c{i}"));
        }
        // A zero limit must not produce "no commits"; it is clamped to at least 1.
        assert_eq!(log_for_file(&repo.path(), "a.txt", 0).expect("log").len(), 1);
        // A request above the cap is clamped, not rejected.
        assert_eq!(log_for_file(&repo.path(), "a.txt", 10_000).expect("log").len(), 5);
    }

    #[test]
    fn history_follows_a_rename() {
        // `--follow` is what makes "the history of this file" mean the file rather
        // than the path.
        let repo = TempRepo::new("rename");
        repo.write("old.txt", "one\n");
        repo.commit("first");
        repo.write("old.txt", "two\n");
        repo.commit("second");
        repo.run(&["mv", "old.txt", "new.txt"]);
        repo.commit("rename");

        let commits = log_for_file(&repo.path(), "new.txt", 10).expect("log");
        assert!(
            commits.len() >= 3,
            "history must survive the rename, got {:?}",
            commits.iter().map(|c| &c.subject).collect::<Vec<_>>()
        );
    }

    #[test]
    fn binary_blobs_decode_lossily_with_a_warning_instead_of_failing() {
        let repo = TempRepo::new("binary");
        std::fs::write(repo.dir.join("blob.bin"), [0xFF, 0xFE, 0x00, 0x41]).expect("write");
        repo.commit("binary");

        let blob = show_file(&repo.path(), "HEAD", "blob.bin").expect("show binary");
        assert!(!blob.text.is_empty());
        assert_eq!(blob.warnings.len(), 1, "the UI must be told the view is lossy");
    }

    // --- branches ----------------------------------------------------------

    #[test]
    fn lists_local_branches_with_the_current_one_first() {
        let repo = TempRepo::new("branches");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.run(&["branch", "feature"]);
        // Move main ahead so "newest" and "current" disagree, then check that
        // "current" wins the ordering.
        repo.write("a.txt", "two\n");
        repo.commit("second");

        let branches = list_branches(&repo.path()).expect("branches");
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current, "the checked-out branch sorts first");
        assert!(!branches[1].current);
        assert_eq!(branches[1].name, "feature");
        assert!(!branches[0].short.is_empty(), "the tip id is shown");
    }

    #[test]
    fn switching_branches_moves_head_and_reports_the_new_branch() {
        let repo = TempRepo::new("switch");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.run(&["branch", "feature"]);

        let info = switch_branch(&repo.path(), "feature").expect("switch");
        assert_eq!(info.branch, "feature", "the returned state is re-resolved");

        // And back, to prove the command is not one-way.
        let info = switch_branch(&repo.path(), "main").expect("switch back");
        assert_eq!(info.branch, "main");
    }

    // The one write in this module must never discard work.
    #[test]
    fn switching_with_local_changes_is_refused_rather_than_forced() {
        let repo = TempRepo::new("switch-dirty");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.run(&["branch", "feature"]);
        repo.write("a.txt", "two\n");
        repo.commit("second");

        // A change that conflicts with the other branch's history.
        repo.write("a.txt", "uncommitted\n");

        let result = switch_branch(&repo.path(), "feature");
        assert!(
            result.is_err(),
            "git must refuse, and the refusal must be reported instead of forced"
        );
        // The work is still there.
        assert_eq!(
            std::fs::read_to_string(repo.dir.join("a.txt")).expect("read"),
            "uncommitted\n",
            "an unforced switch cannot lose the user's edits"
        );
    }

    // The name reaches a process argument, so option-looking input is the risk.
    #[test]
    fn branch_names_that_look_like_options_or_revisions_are_rejected() {
        let repo = TempRepo::new("switch-names");
        repo.write("a.txt", "one\n");
        repo.commit("first");

        for bad in [
            "-f",
            "--force",
            "-C",
            "HEAD",
            "HEAD~1",
            "main..feature",
            "@{upstream}",
            "origin/main",
            "a b",
            "",
            "a\nb",
            "refs/heads/main",
        ] {
            assert!(
                check_branch(bad).is_err(),
                "{bad:?} must not reach git switch"
            );
        }
        // A nested branch name is legitimate and must pass.
        check_branch("feature/login").expect("nested names are legal");
    }

    // --- branch comparison -------------------------------------------------

    #[test]
    fn diff_files_reports_each_change_with_its_kind_and_counts() {
        let repo = TempRepo::new("difffiles");
        repo.write("keep.txt", "same\n");
        repo.write("edit.txt", "one\ntwo\n");
        repo.commit("base");
        repo.run(&["branch", "feature"]);

        // On main: modify one file, delete another, add a third.
        repo.write("edit.txt", "one\nTWO\nthree\n");
        repo.write("added.txt", "new\n");
        repo.commit("main work");

        // feature only sees the base state; compare the branch against main.
        let files = diff_files(&repo.path(), "feature", "main").expect("diff");
        let by_path: std::collections::HashMap<&str, &ChangedFile> =
            files.iter().map(|f| (f.path.as_str(), f)).collect();

        let added = by_path.get("added.txt").expect("added.txt");
        assert_eq!(added.status, "A");
        assert_eq!(added.added, Some(1));

        let edited = by_path.get("edit.txt").expect("edit.txt");
        assert_eq!(edited.status, "M");
        assert_eq!(edited.added, Some(2), "TWO + three");
        assert_eq!(edited.deleted, Some(1), "two");

        assert!(
            !by_path.contains_key("keep.txt"),
            "an unchanged file is not part of the difference"
        );
    }

    #[test]
    fn diff_files_accepts_branch_names_as_well_as_shas() {
        // The UI compares branches by name; the command resolves first, so both
        // spellings must work.
        let repo = TempRepo::new("difffiles-names");
        repo.write("a.txt", "one\n");
        repo.commit("base");
        repo.run(&["branch", "feature"]);
        repo.write("a.txt", "two\n");
        repo.commit("changed");

        let sha = run_text(&repo.dir, &["rev-parse", "HEAD"]).expect("sha");
        let by_name = diff_files(&repo.path(), "feature", "main").expect("by name");
        let by_sha = diff_files(&repo.path(), "feature", sha.trim()).expect("by sha");
        assert_eq!(by_name.len(), by_sha.len());
        assert_eq!(by_name[0].path, "a.txt");
    }

    #[test]
    fn identical_branches_have_no_difference() {
        let repo = TempRepo::new("difffiles-same");
        repo.write("a.txt", "one\n");
        repo.commit("base");
        repo.run(&["branch", "copy"]);

        let files = diff_files(&repo.path(), "main", "copy").expect("diff");
        assert!(files.is_empty(), "same content means no rows");
    }
}
