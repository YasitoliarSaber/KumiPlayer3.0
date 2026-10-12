param(
    [switch]$Apply,
    [switch]$ResetUserData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
foreach ($required in @('src', 'backend\app', 'backend\tests', 'src-tauri\src', '.git', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $required))) {
        throw 'This script must remain inside the KumiPlayer source workspace.'
    }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to protect tracked source files.' }

function Assert-CleanupTarget([string]$Target) {
    $full = [IO.Path]::GetFullPath($Target)
    if (-not $full.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target is outside the workspace: $full"
    }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Top-level cleanup target cannot be a link: $full"
    }
    $tracked = @(git -C $taskRoot ls-files -- $full)
    if ($LASTEXITCODE -ne 0 -or $tracked.Count -gt 0) {
        throw "Cleanup target contains tracked source files: $full"
    }
    return $full
}

function Measure-CleanupTarget([string]$Target) {
    $pending = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
    $initial = Get-Item -LiteralPath $Target -Force
    $pending.Push($initial)
    [long]$bytes = 0
    [long]$files = 0
    $links = [Collections.Generic.List[string]]::new()
    while ($pending.Count -gt 0) {
        $item = $pending.Pop()
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $links.Add($item.FullName)
        } elseif ($item -is [IO.DirectoryInfo]) {
            foreach ($child in $item.GetFileSystemInfos()) {
                $pending.Push($child)
            }
        } else {
            $bytes += $item.Length
            $files++
        }
    }
    return [pscustomobject]@{Path=$Target;Bytes=$bytes;Files=$files;Links=$links}
}

$relativeTargets = @('.pytest_tmp', 'tmp', '.mypy_cache', '.ruff_cache', '.playwright-cli',
    '.mimosa', 'output', 'packaging\runtime', 'backend\.pytest_runtime', '旧内容',
    'release\KumiPlayer-Setup.exe')
$context = Join-Path $taskRoot '.context'
if (Test-Path -LiteralPath $context) {
    # Keep root-level handbooks and the current space audit; remove old run folders.
    foreach ($item in Get-ChildItem -LiteralPath $context -Force) {
        if ($item.PSIsContainer -or $item.Name -match '\.(db|sqlite|sqlite3)(-wal|-shm)?$|\.trace\.json$') {
            $relativeTargets += '.context\' + $item.Name
        }
    }
}
if ($ResetUserData) {
    $relativeTargets += @('data', '.env')
    foreach ($item in Get-ChildItem -LiteralPath $taskRoot -File -Force) {
        if ($item.Name -match '_(目录树|文件目录).*\.txt$') { $relativeTargets += $item.Name }
    }
}
$plan = @()
foreach ($relative in $relativeTargets | Select-Object -Unique) {
    $target = Join-Path $taskRoot $relative
    if (Test-Path -LiteralPath $target) {
        $target = Assert-CleanupTarget $target
        $plan += Measure-CleanupTarget $target
    }
}
$plan | Select-Object @{Name='Target';Expression={$_.Path.Substring($taskRoot.Length + 1)}},
    @{Name='GiB';Expression={[math]::Round($_.Bytes / 1GB, 3)}}, Files | Format-Table -AutoSize
$totalBytes = ($plan | Measure-Object -Property Bytes -Sum).Sum
Write-Host ("Total selected: {0:N2} GiB. Core source, tests, Git, dependencies and MPV are preserved." -f ($totalBytes / 1GB))
if (-not $Apply) {
    Write-Host 'Preview only. Add -Apply to remove the displayed targets. Add -ResetUserData to also clear library/config/posters and the local .env file.'
    exit 0
}
if (@(Get-CimInstance Win32_Process -Filter "Name = 'KumiPlayer.exe' OR Name = 'KumiPlayerBackend.exe'").Count -gt 0) {
    throw 'Close KumiPlayer normally before cleanup. No process will be terminated.'
}
$backends = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^pythonw?\.exe$' -and $_.CommandLine -and
    $_.CommandLine.Contains($taskRoot) -and $_.CommandLine -match 'uvicorn|app\.main:app'
})
if ($backends.Count -gt 0) { throw 'A workspace backend is active. Close it normally before cleanup.' }
foreach ($entry in $plan) {
    $target = Assert-CleanupTarget $entry.Path
    # Re-read the tree immediately before deletion. Unlink junctions without entering their targets.
    $current = Measure-CleanupTarget $target
    foreach ($link in $current.Links) {
        $linkItem = Get-Item -LiteralPath $link -Force
        if (-not $linkItem.FullName.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            -not ($linkItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'A linked path changed during cleanup; nothing further will be removed.'
        }
        if ($linkItem.PSIsContainer) { [IO.Directory]::Delete($linkItem.FullName, $false) }
        else { [IO.File]::Delete($linkItem.FullName) }
    }
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host ('Removed: ' + $target.Substring($taskRoot.Length + 1))
}
Write-Host 'Cleanup completed. Windows Credential Manager was not accessed or modified.'
