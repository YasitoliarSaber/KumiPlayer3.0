param(
    [Parameter(Mandatory = $true)][string]$MpvRoot,
    [ValidateSet('source', 'staged')][string]$Layout = 'source',
    [switch]$LocalTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($MpvRoot)
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'MPV distribution refused: runtime root must not be a reparse point.'
}

function Resolve-BundledPath([string]$RelativePath) {
    # 清单只能引用包内相对文件；不允许绝对路径、ADS、通配符或父目录。
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        $RelativePath -match '[:*?\[\]]|^[/\\]|(^|[/\\])\.{1,2}([/\\]|$)') {
        throw "MPV distribution refused: invalid bundled path: $RelativePath"
    }
    $relative = $RelativePath.Replace('\', '/')
    if ($Layout -eq 'source') {
        if ($relative.StartsWith('portable_config/') -or $relative.StartsWith('kumiplayer/')) {
            $relative = 'config/' + $relative
        } elseif ($relative -notmatch '^(licenses/|sources/)' -and
            $relative -notin @('runtime-manifest.json', 'components-manifest.json', 'THIRD_PARTY_NOTICES.md', 'SOURCE_CODE.txt')) {
            $relative = 'runtime/' + $relative
        }
    }
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'MPV distribution refused: bundled path escaped its root.'
    }
    return $path
}

function Assert-FileHash([string]$Path, [string]$ExpectedHash) {
    if ($ExpectedHash -notmatch '^[0-9a-fA-F]{64}$' -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Length -eq 0 -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $ExpectedHash) {
        throw "MPV distribution refused: missing, empty or changed release material: $Path"
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $root 'runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($LocalTest) {
    # Explicit local installation tests verify the actual player, without claiming release approval.
    $binaryRoot = if ($Layout -eq 'source') { Join-Path $root 'runtime' } else { $root }
    $metadata = @('README.md', 'runtime-manifest.json', 'components-manifest.json', 'distribution-manifest.json', 'THIRD_PARTY_NOTICES.md', 'SOURCE_CODE.txt', 'LOCAL_TEST_ONLY.txt')
    $binaryFiles = @(Get-ChildItem -LiteralPath $binaryRoot -File -Force | Where-Object { $_.Name -notin $metadata })
    if ($binaryFiles.Count -eq 0 -or (Compare-Object @($binaryFiles.Name) @($manifest.files | ForEach-Object { $_.path }))) {
        throw 'Local MPV test refused: runtime file set differs from runtime-manifest.json.'
    }
    foreach ($entry in $manifest.files) {
        Assert-FileHash (Resolve-BundledPath $entry.path) $entry.sha256
    }
    foreach ($config in @('portable_config/mpv.conf', 'kumiplayer/mpv.conf', 'kumiplayer/scripts/kumiplayer_bindings.lua')) {
        if (-not (Test-Path -LiteralPath (Resolve-BundledPath $config) -PathType Leaf)) {
            throw "Local MPV test refused: required config missing: $config"
        }
    }
    if ($Layout -eq 'staged' -and -not (Test-Path -LiteralPath (Join-Path $root 'LOCAL_TEST_ONLY.txt') -PathType Leaf)) {
        throw 'Local MPV test refused: LOCAL_TEST_ONLY.txt marker is missing.'
    }
    Write-Output "LOCAL TEST ONLY: verified $($binaryFiles.Count) MPV runtime hashes. Public release review remains incomplete."
    return
}
if ($manifest.distribution_status -ne 'public-release') {
    throw 'MPV distribution refused: only public-release may enter an installer; qualified, development-only and unknown states are blocked.'
}
$evidence = Get-Content -LiteralPath (Join-Path $root 'distribution-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($evidence.schema_version -ne 1 -or $evidence.review_status -ne 'approved' -or
    [string]::IsNullOrWhiteSpace($evidence.reviewed_by) -or
    $evidence.reviewed_at -notmatch '^\d{4}-\d{2}-\d{2}$' -or @($evidence.blockers).Count -ne 0) {
    throw 'MPV distribution refused: corresponding-source and license review is incomplete.'
}
if ($evidence.source_delivery -ne 'bundled' -or $evidence.source_archive.path -notmatch '^sources/[^/\\]+\.(zip|tar\.gz|tar\.xz)$') {
    throw 'MPV distribution refused: an audited corresponding-source archive must be bundled under sources/.'
}
Assert-FileHash (Resolve-BundledPath $evidence.source_archive.path) $evidence.source_archive.sha256

# 许可证目录存在不代表材料完整；逐项要求当前已登记组件的正文。
$requiredLicenses = @(
    'mpv-v0.41.0/LICENSE.GPL', 'mpv-v0.41.0/LICENSE.LGPL',
    'ffmpeg/COPYING.GPLv2', 'ffmpeg/LICENSE.md', 'libass/COPYING', 'dav1d/COPYING',
    'libplacebo/LICENSE', 'fribidi/COPYING', 'libiconv/COPYING.LIB',
    'freetype/LICENSE.TXT', 'freetype/FTL.TXT', 'harfbuzz/COPYING', 'lcms2/LICENSE',
    'shaderc/LICENSE', 'spirv-cross/LICENSE', 'vulkan-loader/LICENSE.txt', 'zlib/LICENSE',
    'gcc-runtime/COPYING3', 'gcc-runtime/COPYING.RUNTIME', 'mingw-w64/COPYING',
    'luajit/COPYRIGHT', 'mujs/COPYING'
)
$components = Get-Content -LiteralPath (Join-Path $root 'components-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($component in $components.components) {
    foreach ($notice in $component.notices) {
        if ($notice -notmatch '^mpv/licenses/') {
            throw 'MPV distribution refused: component notice is outside mpv/licenses.'
        }
        $requiredLicenses += $notice.Substring('mpv/licenses/'.Length)
    }
    foreach ($bundledFile in $component.bundled_files) {
        if ($bundledFile -notmatch '^mpv/config/(portable_config|kumiplayer)/') {
            throw 'MPV distribution refused: component file is outside the player config layers.'
        }
        if (-not (Test-Path -LiteralPath (Resolve-BundledPath $bundledFile.Substring('mpv/config/'.Length)))) {
            throw "MPV distribution refused: missing component file: $bundledFile"
        }
    }
}
foreach ($license in $requiredLicenses) {
    $path = Resolve-BundledPath ('licenses/' + $license)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "MPV distribution refused: missing or empty license: $license"
    }
}

# 人工审核必须绑定全部实际发布字节；改脚本、许可证或二进制后，旧批准失效。
$actualFiles = @('runtime-manifest.json', 'components-manifest.json', 'THIRD_PARTY_NOTICES.md', 'SOURCE_CODE.txt')
$binaryRoot = if ($Layout -eq 'source') { Join-Path $root 'runtime' } else { $root }
$allowedDirectories = if ($Layout -eq 'source') { @() } else { @('portable_config', 'kumiplayer', 'licenses', 'sources') }
foreach ($directory in @(Get-ChildItem -LiteralPath $binaryRoot -Directory -Force)) {
    if ($directory.Name -notin $allowedDirectories -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'MPV distribution refused: unexpected directory or reparse point in the runtime.'
    }
}
$binaryFiles = @(Get-ChildItem -LiteralPath $binaryRoot -File -Force |
    Where-Object { $_.Name -notin @('README.md', 'runtime-manifest.json', 'components-manifest.json', 'distribution-manifest.json', 'THIRD_PARTY_NOTICES.md', 'SOURCE_CODE.txt') })
if (@($binaryFiles | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) {
    throw 'MPV distribution refused: runtime files must not be reparse points.'
}
$actualFiles += @($binaryFiles | ForEach-Object { $_.Name })
$declaredFiles = @($manifest.files | ForEach-Object { $_.path })
if (Compare-Object @($binaryFiles | ForEach-Object { $_.Name }) $declaredFiles) {
    throw 'MPV distribution refused: runtime file set differs from runtime-manifest.json.'
}
foreach ($entry in $manifest.files) {
    Assert-FileHash (Resolve-BundledPath $entry.path) $entry.sha256
}
foreach ($folder in @('portable_config', 'kumiplayer', 'licenses', 'sources')) {
    $directory = Resolve-BundledPath ($folder + '/')
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "MPV distribution refused: required distribution directory missing: $folder"
    }
    $entries = if ($folder -eq 'sources' -and $Layout -eq 'source') {
        @((Get-Item -LiteralPath $directory), (Get-Item -LiteralPath (Resolve-BundledPath $evidence.source_archive.path)))
    } else {
        @((Get-Item -LiteralPath $directory)) + @(Get-ChildItem -LiteralPath $directory -Recurse -Force)
    }
    if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) {
        throw 'MPV distribution refused: package materials must not contain reparse points.'
    }
    $actualFiles += @($entries | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
        $folder + '/' + $_.FullName.Substring($directory.TrimEnd('\').Length + 1).Replace('\', '/')
    })
}
$approvedFiles = @($evidence.approved_files | ForEach-Object { $_.path })
if ($approvedFiles.Count -eq 0 -or ($approvedFiles | Select-Object -Unique).Count -ne $approvedFiles.Count -or
    (Compare-Object $actualFiles $approvedFiles)) {
    throw 'MPV distribution refused: audited file inventory differs from actual distribution inputs.'
}
foreach ($entry in $evidence.approved_files) {
    Assert-FileHash (Resolve-BundledPath $entry.path) $entry.sha256
}
Write-Output "Verified MPV distribution materials ($($actualFiles.Count) audited files); legal review remains the publisher's responsibility."
