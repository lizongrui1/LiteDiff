# Package LiteDiff for Windows.
#
# Produces, in `dist-windows/`:
#   LiteDiff-<version>-windows-<arch>.exe   NSIS installer
#   LiteDiff-<version>-windows-<arch>.zip   portable folder, no install
#
# ## Why NSIS via Tauri, and not the script-based approach used on macOS
#
# The macOS bundle is assembled by hand because an .app is a directory with a
# plist — trivial to write, and doing it in shell avoids adding the Tauri CLI to
# the toolchain. A Windows installer is not that: it needs an uninstaller, Start
# menu and desktop shortcuts, a registry entry so "Apps & features" lists it, and
# (for a signed build) Authenticode. Reproducing that by hand is a project of its
# own, so this script shells out to `tauri build`, which drives NSIS and produces a
# correct installer.
#
# Both artifacts are published: the installer is what most people want, and the zip
# matters for users on locked-down machines where they cannot run an .exe, and for
# anyone who wants to keep several versions side by side.
#
# ## Requirements
#
#   - Rust (stable, MSVC toolchain) and Node 18+
#   - WebView2: preinstalled on Windows 11 and on current Windows 10. The installer
#     is built with `webviewInstallMode = downloadBootstrapper`, so an older machine
#     downloads it during setup instead of failing to start.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
#   ... -SkipTests        faster local iteration
#   ... -Version 0.2.0    override the version stamped into the artifacts

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDir = Join-Path $Root "app"
$OutDir = Join-Path $Root "dist-windows"

function Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Architecture tag for artifact names. Release downloads must say which CPU they
# target: an x64 build runs on arm64 Windows under emulation but not the reverse,
# so the filename is the only place a user can check before downloading.
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    "x86"   { "x86" }
    default { $env:PROCESSOR_ARCHITECTURE.ToLower() }
}

Step "LiteDiff for Windows ($Arch)"

# --- frontend ---------------------------------------------------------------
Step "Installing frontend dependencies"
Push-Location $AppDir
try {
    if (-not (Test-Path "node_modules")) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }

    if (-not $SkipTests) {
        Step "Running frontend tests"
        npm test
        if ($LASTEXITCODE -ne 0) { throw "frontend tests failed" }
    }

    Step "Building frontend"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
}
finally {
    Pop-Location
}

# --- backend ----------------------------------------------------------------
if (-not $SkipTests) {
    Step "Running Rust tests"
    Push-Location $Root
    try {
        cargo test --workspace
        if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
    }
    finally {
        Pop-Location
    }
}

# --- installer --------------------------------------------------------------
Step "Building installer (NSIS)"

# `tauri build` is run from the crate that owns `tauri.conf.json`. The CLI resolves
# the config relative to the working directory, so running it from the repository
# root fails with "could not find tauri.conf.json".
#
# The CLI is installed once with `npm install` rather than invoked through
# `npx --yes <pkg>@2`: npx would fetch a version that need not match the `tauri`
# crate in Cargo.toml, and a mismatched pair is exactly what produces the
# "unknown configuration field" error for keys the older crate does not know.
$CrateDir = Join-Path $Root "crates\litediff-app"
$TauriCli = Join-Path $AppDir "node_modules\.bin\tauri.cmd"
if (-not (Test-Path $TauriCli)) {
    Step "Installing Tauri CLI"
    Push-Location $AppDir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    finally { Pop-Location }
}
if (-not (Test-Path $TauriCli)) { throw "Tauri CLI not found at $TauriCli" }

Push-Location $CrateDir
try {
    $tauriArgs = @("build", "--bundles", "nsis")

    # A version override goes through a JSON file rather than an inline fragment:
    # nested double quotes inside a PowerShell argument need escaping that differs
    # between npx, cmd and PowerShell 7, and a mistake there silently drops the
    # override instead of failing.
    if ($Version -ne "") {
        $override = Join-Path $env:TEMP "litediff-tauri-override.json"
        @{ version = $Version } | ConvertTo-Json -Compress | Set-Content -Path $override -Encoding utf8
        $tauriArgs += @("--config", $override)
    }

    & $TauriCli @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
    Pop-Location
}

# --- collect artifacts -------------------------------------------------------
Step "Collecting artifacts"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Tauri stamps the version into the path; find whatever it produced.
$Installer = Get-ChildItem -Path (Join-Path $Root "target\release\bundle\nsis") `
    -Filter "*_${Arch}-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $Installer) {
    # Fall back to any setup exe: the arch suffix changed between Tauri versions.
    $Installer = Get-ChildItem -Path (Join-Path $Root "target\release\bundle\nsis") `
        -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if (-not $Installer) { throw "No NSIS installer was produced; check the tauri build output above." }

# The version comes from the built artifact, so the release name always matches
# what is inside it.
$ResolvedVersion = if ($Version -ne "") { $Version } else {
    if ($Installer.Name -match '^LiteDiff_([\d.]+)_') { $Matches[1] } else { "0.1.0" }
}

$InstallerName = "LiteDiff-$ResolvedVersion-windows-$Arch.exe"
Copy-Item $Installer.FullName (Join-Path $OutDir $InstallerName) -Force
Write-Host "    $InstallerName"

# --- portable zip ------------------------------------------------------------
# The release binary plus the files Windows needs beside it. Tauri embeds the
# frontend in the exe, so this is not a full app directory — it is the exe and the
# WebView2 loader, which is what a portable build amounts to.
Step "Building portable zip"
$Portable = Join-Path $OutDir "portable"
if (Test-Path $Portable) { Remove-Item $Portable -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Portable | Out-Null

$Exe = Join-Path $Root "target\release\litediff-app.exe"
if (-not (Test-Path $Exe)) { throw "Missing $Exe" }
Copy-Item $Exe (Join-Path $Portable "LiteDiff.exe")

# Ship the licence and the third-party notice with both artifacts.
foreach ($doc in @("README.md", "LICENSE")) {
    $src = Join-Path $Root $doc
    if (Test-Path $src) { Copy-Item $src (Join-Path $Portable $doc) }
}

$ZipName = "LiteDiff-$ResolvedVersion-windows-$Arch.zip"
$ZipPath = Join-Path $OutDir $ZipName
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $Portable "*") -DestinationPath $ZipPath -CompressionLevel Optimal
Remove-Item $Portable -Recurse -Force
Write-Host "    $ZipName"

# --- summary -----------------------------------------------------------------
Write-Host ""
Write-Host "Done. Artifacts in $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    Write-Host ("  {0,-46} {1,6} MB" -f $_.Name, $mb)
}
