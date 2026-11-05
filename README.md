<div align="center">

<img src="crates/litediff-app/icons/icon.png" alt="LiteDiff app icon" width="128" height="128" />

# LiteDiff

<p><strong>English</strong> | <a href="README.zh-CN.md">简体中文</a></p>

**A local text and code diff tool**

Pure-Rust diff engine · Native Tauri v2 window · No Electron

[![Rust](https://img.shields.io/badge/Rust-1.75%2B-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![macOS](https://img.shields.io/badge/macOS-11%2B-000000?logo=apple&logoColor=white)](#system-requirements)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)](#system-requirements)

</div>

---

## Download

Get installers from [Releases](../../releases). Each release includes:

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `LiteDiff-*-macos-arm64.dmg` | Open and drag to Applications |
| macOS (Intel) | `LiteDiff-*-macos-x64.dmg` | Same as above |
| Windows 10/11 (x64) | `LiteDiff-*-windows-x64.exe` | Installer; **no administrator rights required** |
| Windows portable | `LiteDiff-*-windows-x64.zip` | Extract and run; no installation needed |

Installation notes:

- **macOS** -- the build is ad-hoc signed but **not notarized** (notarization requires a paid Apple Developer account). If the first launch is blocked as an unverified app, open *System Settings -> Privacy & Security -> Open Anyway*, or run:
  ```bash
  xattr -dr com.apple.quarantine /Applications/LiteDiff.app
  ```
- **Windows** -- run the `.exe`. It installs for the current user and does not trigger a UAC prompt. If WebView2 is missing, the installer downloads it automatically.

**Verify your download**: every release includes `SHA256SUMS.txt`.

```bash
shasum -a 256 -c SHA256SUMS.txt    # macOS
certutil -hashfile <file> SHA256  # Windows
```

---

## Features

**Diff engine** (pure Rust, no third-party runtime dependencies)

- Linear-space Myers with middle-snake and common prefix/suffix trimming; peak memory is O(N+M), and optimality is validated against a DP LCS oracle
- Word-level inline highlighting: `foo_bar` -> `foo_baz` highlights only `bar`/`baz` instead of splitting every character
- Ignore leading/trailing whitespace, all whitespace, or letter case; CRLF and LF are treated as equivalent

**Interface**

- Seven UI languages: Simplified Chinese, English, Traditional Chinese, Japanese, Spanish, German, and French; can follow the system language
- Side-by-side split view <-> unified inline view
- Fixed-row-height virtual scrolling; a 3,000+ line file renders only about 20-40 rows around the viewport
- Strict vertical and horizontal scroll synchronization between panes
- Automatic collapse of long unchanged regions, with per-region expand/collapse and expand/collapse-all controls
- Collapsed regions show the hidden line-number range; line-number width adapts to the file size
- Canvas-rendered minimap with click, drag, and keyboard navigation
- Three levels of change emphasis: row background, 3 px gutter marker, and word-level highlight

**Interaction**

- Paste directly into either side of the start screen (`Cmd+V`), or drop a file onto one side
- `Cmd+N` or the re-enter action returns to the paste screen
- `Cmd+S` performs an atomic write to disk
- Dark, light, and system themes
- Settings panel (`Cmd+,`): accent color, red/green color-blind mode, highlight intensity, font size and line height, line numbers and minimap toggles, collapse threshold, leading/trailing whitespace, and case sensitivity

**Git history**

- Open any local repository and filter files by path
- Compare the working tree against any revision, or compare two revisions
- When comparing against history, `Cmd+S` never writes back because historical content is read-only
- Git data is read through the system `git` command using only `rev-parse`, `log`, `show`, and `ls-files`; the repository is not modified

**Comparison history**

- Every comparison is stored locally and can be restored as a tab after reopening the app
- Grouped by day (Today / Yesterday / date), with per-item delete and clear-all actions
- Retention can be configured in Settings by days or by item count; `0` means unlimited
- Data stays in the local app-data directory and is never uploaded; comparisons larger than 4 MB are not recorded because truncating them would create a different diff

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd><kbd>]</kbd> / <kbd>⌘</kbd><kbd>[</kbd> | Next / previous change |
| <kbd>⌘</kbd><kbd>D</kbd> | Toggle split / inline view |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>W</kbd> | Ignore leading/trailing whitespace and line endings |
| <kbd>⌘</kbd><kbd>⌥</kbd><kbd>E</kbd> | Expand / collapse all unchanged regions |
| <kbd>⌘</kbd><kbd>F</kbd> | Find in the current comparison |
| <kbd>⌘</kbd><kbd>S</kbd> | Save |
| <kbd>⌘</kbd><kbd>T</kbd> / <kbd>⌘</kbd><kbd>N</kbd> | New tab (return to paste screen while keeping existing comparisons) |
| <kbd>⌘</kbd><kbd>W</kbd> | Close current tab |
| <kbd>⌘</kbd><kbd>,</kbd> | Open / close Settings |
| <kbd>⌘</kbd><kbd>G</kbd> | Open / close Git history |
| <kbd>⌘</kbd><kbd>Y</kbd> | Open / close comparison history |

## Build from Source

Requires Rust 1.75+ and Node 18+.

```bash
# Dependencies
cd app && npm install && cd ..

# Tests
cargo test                # Rust
cd app && npm test        # Frontend

# Package for macOS: produces .app and .dmg
./scripts/package-macos.sh
SKIP_DMG=1 ./scripts/package-macos.sh   # .app only; faster for local iteration

# Package for Windows: produces an NSIS installer and portable zip (run on Windows)
powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
```

Releases are built by [.github/workflows/release.yml](.github/workflows/release.yml). Pushing a `v*` tag builds on macOS (arm64 and x64) and Windows, attaches the artifacts and `SHA256SUMS.txt` to a **draft** release, and waits for manual confirmation before publishing.

For development, run the app in two terminals: `cd app && npm run dev` and `cargo run -p litediff-app`.

## System Requirements

- **macOS 11+** (Big Sur or later), with native builds for both Apple Silicon and Intel; installers are about 2.3 MB
- **Windows 10 / 11 (x64)** with WebView2 (included in Windows 11 and recent Windows 10 builds; setup downloads it when missing)

## Architecture

```
Svelte 5 frontend --IPC (full Session per request)--> Tauri v2 backend --> litediff-core
```

**Three key decisions**

- **Send the full session over IPC**: the frontend stays stateless, scrolling never waits for the backend, and virtualization remains entirely on the DOM side
- **Single scroll authority**: panels only report `scrollTop`; `App` stores one value and feeds it back to both panes so they stay pixel-aligned
- **Collapse is a projection**: `buildDisplay()` projects hunks into display items. Display indexes and source-line indexes are separate coordinate systems, so every jump must go through that projection

## Testing

```bash
cargo test      # Rust
npm test        # Frontend (run from app/)
```

The core Rust guarantee is **optimality validation**: a brute-force DP LCS implementation serves as an oracle, asserting that the match count equals the LCS length across random low-alphabet inputs. This caught two intermediate-snake overlap bugs during development.

## Known Limitations

| Limitation | Reason |
|---|---|
| In-place editing | Conflicts with virtual scrolling, which recycles focused DOM nodes |
| Accept-change arrows | Require the in-place editing buffer model |
| Collapse in inline view | Available in split view, but not yet wired into inline view |
| Very large files | Whole-file comparison only; no chunked streaming yet |
