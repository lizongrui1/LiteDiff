$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoFallback = Join-Path $env:USERPROFILE ".cargo\bin"
    if (Test-Path (Join-Path $cargoFallback "cargo.exe")) {
        $env:PATH = "$cargoFallback;$env:PATH"
    }
}

$missing = @()
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $missing += "cargo" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $missing += "npm" }

if ($missing.Count -gt 0) {
    throw "Missing required tool(s): $($missing -join ', ')"
}

if (-not (Test-Path (Join-Path $Root "app\node_modules"))) {
    throw "Frontend dependencies are missing. Run: cd app; npm ci"
}

function Invoke-VerifyStep {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Invoke-VerifyStep "cargo fmt" { cargo fmt --all -- --check }
Invoke-VerifyStep "cargo clippy" { cargo clippy --workspace --all-targets -- -D warnings }
Invoke-VerifyStep "cargo test" { cargo test --workspace }

Push-Location (Join-Path $Root "app")
try {
    Invoke-VerifyStep "frontend tests" { npm test }
    Invoke-VerifyStep "frontend type check" { npm run check }
    Invoke-VerifyStep "frontend production build" { npm run build }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "All LiteDiff quality gates passed."
