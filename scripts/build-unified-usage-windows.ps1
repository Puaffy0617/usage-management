param([switch]$DebugBuild)
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    foreach ($tool in @('node', 'corepack', 'cargo')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Missing $tool. See docs/unified-usage.md for build prerequisites."
        }
    }
    & corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & corepack pnpm typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Type checking failed.' }
    $buildArgs = @('pnpm', 'tauri', 'build', '-c', 'scripts/unified-usage-local-build.json')
    if ($DebugBuild) { $buildArgs += '--debug' }
    & corepack @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw 'Native build failed. Windows requires Microsoft C++ Build Tools, Windows SDK and WebView2.'
    }
} finally {
    Pop-Location
}
