param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$problems = [Collections.Generic.List[string]]::new()

function Test-BuildCommand([string]$Name, [string]$Help) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        $problems.Add($Help)
        return $null
    }
    # The Windows Store shortcut satisfies `where python`, but is not an interpreter.
    if ($Name -eq 'python' -and $command.Source -match '\\WindowsApps\\' -and
        (Get-Item -LiteralPath $command.Source).Length -eq 0) {
        $problems.Add('Python points to a Windows Store shortcut. Install Python 3.12 and enable Add to PATH: https://www.python.org/downloads/windows/')
        return $null
    }
    try {
        $version = & $command.Source --version 2>&1
        if ($LASTEXITCODE -ne 0) { throw "$Name could not run." }
    } catch {
        $problems.Add($Help)
        return $null
    }
    Write-Output "[OK] $Name : $version" | Out-Host
    return $command.Source
}

$python = Test-BuildCommand 'python' 'Install Python 3.12 and enable Add to PATH: https://www.python.org/downloads/windows/'
if ($python) {
    & $python -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)'
    if ($LASTEXITCODE -ne 0) {
        $problems.Add('The installer build requires Python 3.12. Select Python 3.12 in PATH.')
    }
    foreach ($module in @('PyInstaller', 'fastapi', 'uvicorn', 'httpx', 'multipart', 'websockets', 'PIL', 'h2', 'socksio')) {
        & $python -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('$module') else 1)"
        if ($LASTEXITCODE -ne 0) {
            $problems.Add("Python module missing: $module. Restore the locked backend environment and install PyInstaller in that same environment.")
        }
    }
}

$node = Test-BuildCommand 'node' 'Install Node.js 22 with npm: https://nodejs.org/'
if ($node) {
    & $node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) {
        $problems.Add('Node.js 22 or newer is required by the frontend build.')
    }
}
$null = Test-BuildCommand 'npm.cmd' 'npm is unavailable. Install Node.js with npm and reopen the build window: https://nodejs.org/'
$null = Test-BuildCommand 'cargo' 'Install Rust and its Windows build prerequisites: https://v2.tauri.app/start/prerequisites/'
$rust = Test-BuildCommand 'rustc' 'Rust compiler is unavailable. Install Rust and reopen the build window: https://rustup.rs/'

# Restored virtual environments contain absolute paths to the previous computer.
$venvConfig = Join-Path $root 'backend\.venv\pyvenv.cfg'
if (Test-Path -LiteralPath $venvConfig -PathType Leaf) {
    $homeLine = Get-Content -LiteralPath $venvConfig -Encoding UTF8 | Where-Object { $_ -match '^home\s*=' } | Select-Object -First 1
    if ($homeLine -and -not (Test-Path -LiteralPath ($homeLine -replace '^home\s*=\s*', '') -PathType Container)) {
        Write-Output '[WARNING] The backed-up backend virtual environment points to the previous computer. Recreate it from backend/uv.lock; copying .venv does not restore Python.'
    }
}

if ($rust) {
    $hostLine = & $rust -vV | Where-Object { $_ -match '^host: ' } | Select-Object -First 1
    $configPath = Join-Path $root '.cargo\config.toml'
    if ($hostLine -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        $hostTarget = $hostLine.Substring(6)
        $inHostSection = $false
        foreach ($line in Get-Content -LiteralPath $configPath -Encoding UTF8) {
            if ($line -match '^\[target\.(.+)\]') { $inHostSection = $Matches[1] -eq $hostTarget }
            if ($inHostSection -and $line -match '^linker\s*=\s*"(.+)"') {
                $linker = $Matches[1].Replace('\\', '\')
                if ([IO.Path]::IsPathRooted($linker) -and -not (Test-Path -LiteralPath $linker -PathType Leaf)) {
                    $problems.Add('The active linker in .cargo/config.toml points to an unavailable file. Reconfigure the linker for this computer.')
                }
            }
        }
    }
}

# Reuse the existing release gate before any expensive compilation or staging.
try {
    & (Join-Path $PSScriptRoot 'verify_mpv_distribution.ps1') -MpvRoot (Join-Path $root 'mpv') -Layout source
} catch {
    $problems.Add('Built-in MPV release materials are incomplete or invalid. See mpv/README.md and mpv/distribution-manifest.json. ' + $_.Exception.Message)
}

if ($problems.Count -gt 0) {
    Write-Output ''
    Write-Output '[ERROR] Installer build prerequisites are not ready:'
    foreach ($problem in $problems) { Write-Output "  - $problem" }
    Write-Output ''
    Write-Output 'These tools are required only to BUILD an installer. End users run release/KumiPlayer-Setup.exe and do not need Python, Node.js or Rust.'
    exit 1
}
Write-Output 'Installer build prerequisites passed.'
