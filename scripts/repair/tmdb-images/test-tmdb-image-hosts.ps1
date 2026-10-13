# 不需要 Pester/Python；仅在自动生成的临时目录模拟 hosts，绝不调用系统修复入口。
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'tmdb-image-hosts.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('kumi-hosts-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$count = 0
function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:count++
}
function Expect-Error([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed $Message
}
function New-Fixture([byte[]]$Bytes) {
    $folder = Join-Path $root ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($folder)
    $hosts = Join-Path $folder 'hosts'
    [IO.File]::WriteAllBytes($hosts, $Bytes)
    [pscustomobject]@{ Hosts = $hosts; Folder = $folder }
}
try {
    foreach ($ip in @('127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.1.1',
        '198.18.0.1','100.64.0.1','0.0.0.0','224.0.0.1','192.0.2.1','::1','1.2.3.999','127.1')) {
        Assert (-not (Test-PublicIPv4 $ip)) ('Unsafe candidate accepted: ' + $ip)
    }
    Assert (Test-PublicIPv4 '89.187.169.47') 'Public candidate rejected'
    $eol = [string][char]13 + [char]10
    $text = '# 中文备注' + $eol + '127.0.0.1 localhost' + $eol +
        '13.227.73.57 image.tmdb.org keep.example # shared' + $eol +
        '1.1.1.1 api.themoviedb.org image.tmdb.org.evil' + $eol
    $original = [Text.Encoding]::UTF8.GetBytes($text)
    $after = New-TmdbHostsBytes $original @('89.187.169.47','143.244.49.180')
    $decoded = [Text.Encoding]::UTF8.GetString($after)
    Assert ($decoded.Contains('# 中文备注' + $eol)) 'UTF-8 comment changed'
    Assert ($decoded.Contains('13.227.73.57  keep.example # shared' + $eol)) 'Shared alias lost'
    Assert ($decoded.Contains('1.1.1.1 api.themoviedb.org image.tmdb.org.evil' + $eol)) 'Unrelated domains changed'
    Assert ($decoded.Contains('89.187.169.47 image.tmdb.org' + $eol) -and
        $decoded.Contains('143.244.49.180 image.tmdb.org' + $eol)) 'Multiple verified addresses not retained'
    Assert (-not $decoded.Contains('13.227.73.57 image.tmdb.org')) 'Old target not removed'
    $bomInput = [byte[]](@(239,187,191) + [Text.Encoding]::UTF8.GetBytes('13.227.73.57 image.tmdb.org'))
    $bomOutput = New-TmdbHostsBytes $bomInput @('89.187.169.47')
    Assert ($bomOutput[0] -eq 239 -and $bomOutput[1] -eq 187 -and $bomOutput[2] -eq 191) 'BOM lost'
    $gbk = [Text.Encoding]::GetEncoding(936).GetBytes('# 中文' + $eol + '127.0.0.1 localhost')
    $gbkOutput = New-TmdbHostsBytes $gbk @('89.187.169.47')
    Assert ((Get-ByteHash $gbkOutput[0..($gbk.Length-1)]) -eq (Get-ByteHash $gbk)) 'GBK bytes changed'
    Expect-Error { New-TmdbHostsBytes ([Text.Encoding]::Unicode.GetBytes($text)) @('89.187.169.47') } 'UTF-16 should fail safely'
    Expect-Error { New-TmdbHostsBytes $original @('127.0.0.1') } 'Private address written'
    Expect-Error { New-TmdbHostsBytes $after @('89.187.169.47') } 'Unowned marker accepted'

    $f = New-Fixture $original
    $aclBefore = [IO.File]::GetAccessControl($f.Hosts).GetSecurityDescriptorSddlForm('All')
    Apply-TmdbHosts $f.Hosts $f.Folder @('89.187.169.47','143.244.49.180') { $true }
    $state = Read-RepairState $f.Folder
    Assert ($state.status -eq 'applied') 'Apply state not persisted'
    Assert ((Get-ByteHash (Get-OriginalRepairBytes $f.Folder $state)) -eq (Get-ByteHash $original)) 'Backup not exact'
    Assert ([IO.File]::GetAccessControl($f.Hosts).GetSecurityDescriptorSddlForm('All') -eq $aclBefore) 'ACL changed'
    Apply-TmdbHosts $f.Hosts $f.Folder @('185.93.1.251') { $true }
    $state = Read-RepairState $f.Folder
    Assert ((Get-ByteHash (Get-OriginalRepairBytes $f.Folder $state)) -eq (Get-ByteHash $original)) 'Repeated repair lost original'
    Restore-TmdbHosts $f.Hosts $f.Folder
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'Exact restore failed'
    Restore-TmdbHosts $f.Hosts $f.Folder
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'Idempotent restore failed'

    $f = New-Fixture $original
    Expect-Error { Apply-TmdbHosts $f.Hosts $f.Folder @('89.187.169.47') { $false } } 'Failed postcheck did not report failure'
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'Failed postcheck did not roll back'
    $f = New-Fixture $original
    Apply-TmdbHosts $f.Hosts $f.Folder @('89.187.169.47') { $true }
    $lastGood = [IO.File]::ReadAllBytes($f.Hosts)
    Expect-Error { Apply-TmdbHosts $f.Hosts $f.Folder @('185.93.1.251') { throw 'Simulated check exception' } } 'Exception not reported'
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $lastGood)) 'Previous repair lost after failure'
    Restore-TmdbHosts $f.Hosts $f.Folder
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'Restore after failed reapply lost original'

    $f = New-Fixture $original
    Apply-TmdbHosts $f.Hosts $f.Folder @('89.187.169.47') { $true }
    [IO.File]::AppendAllText($f.Hosts, '# another editor', [Text.Encoding]::UTF8)
    $concurrent = [IO.File]::ReadAllBytes($f.Hosts)
    Expect-Error { Restore-TmdbHosts $f.Hosts $f.Folder } 'Concurrent changes overwritten on restore'
    Expect-Error { Apply-TmdbHosts $f.Hosts $f.Folder @('185.93.1.251') { $true } } 'Concurrent changes overwritten on apply'
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $concurrent)) 'Concurrent content lost'
    Expect-Error { Set-GuardedBytes $f.Hosts (Get-ByteHash $original) $original $f.Folder } 'Stale hash accepted'

    # 模拟进程在 prepared 状态中断；恢复原始版本，不能遗失上一次修复的备份。
    $f = New-Fixture $original
    Apply-TmdbHosts $f.Hosts $f.Folder @('89.187.169.47') { $true }
    $state = Read-RepairState $f.Folder
    $state.status = 'prepared'
    $state.previous_hash = $state.applied_hash
    $state.applied_hash = Get-ByteHash (New-TmdbHostsBytes $original @('185.93.1.251'))
    Save-RepairState $f.Folder $state
    Restore-TmdbHosts $f.Hosts $f.Folder
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'Prepared recovery failed'
    $f = New-Fixture $original
    Apply-TmdbHosts $f.Hosts $f.Folder @('89.187.169.47') { $true }
    $state = Read-RepairState $f.Folder
    [IO.File]::WriteAllBytes((Join-Path $f.Folder $state.original_file), @(1,2,3))
    Expect-Error { Restore-TmdbHosts $f.Hosts $f.Folder } 'Corrupt backup restored'

    $link = Join-Path $root 'junction'
    $target = Join-Path $root 'target'
    [void][IO.Directory]::CreateDirectory($target)
    [void](New-Item -ItemType Junction -Path $link -Target $target)
    Expect-Error { Assert-PlainPath (Join-Path $link 'hosts') } 'Junction accepted'
    [IO.Directory]::Delete($link)

    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object Drawing.Bitmap(2,2)
    $memory = New-Object IO.MemoryStream
    $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
    $script:probeBytes = $memory.ToArray()
    $bitmap.Dispose()
    $memory.Dispose()
    $script:probeExit = 0
    $script:probeOutput = '200|image/png'
    function Invoke-RepairCurl([string]$CurlPath, [string[]]$CurlArguments, [int]$TimeoutSeconds = 10) {
        if ($CurlArguments -contains '--insecure' -or $CurlArguments -contains '-k') { throw 'TLS check disabled' }
        $outputIndex = [Array]::IndexOf($CurlArguments, '--output')
        if ($outputIndex -ge 0) { [IO.File]::WriteAllBytes($CurlArguments[$outputIndex + 1], $script:probeBytes) }
        [pscustomobject]@{ ExitCode = $script:probeExit; Output = $script:probeOutput }
    }
    Assert ((Test-TmdbImage 'mock' '89.187.169.47').Ok) 'Valid image probe rejected'
    $script:probeBytes = [Text.Encoding]::UTF8.GetBytes('<html>not a picture</html>')
    Assert (-not (Test-TmdbImage 'mock' '89.187.169.47').Ok) 'HTML accepted as image'
    $script:probeExit = 60
    Assert ((Test-TmdbImage 'mock' '89.187.169.47').Kind -eq 'certificate') 'Certificate failure not rejected'
    $script:probeExit = 28
    Assert (-not (Test-TmdbImage 'mock' '89.187.169.47').Ok) 'Timeout accepted'
    Assert (-not (Test-TmdbImage 'mock' '127.0.0.1').Ok) 'Fake/local IP reached probe'
    $f = New-Fixture $original
    $dummyCurl = Join-Path $f.Folder 'curl.exe'
    [IO.File]::WriteAllBytes($dummyCurl, @())
    function Test-TmdbImage { [pscustomobject]@{ Ok = $true } }
    Invoke-TmdbImageRepair $f.Hosts (Join-Path $f.Folder 'backups') $dummyCurl
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'Healthy path changed hosts'
    Assert (-not (Test-Path -LiteralPath (Join-Path $f.Folder 'backups'))) 'Healthy path created state'
    function Test-TmdbImage { [pscustomobject]@{ Ok = $false } }
    function Get-TmdbCandidates { @('89.187.169.47','143.244.49.180') }
    function Test-TmdbCandidates { @([pscustomobject]@{ Ip = '89.187.169.47'; Ok = $false },[pscustomobject]@{ Ip = '143.244.49.180'; Ok = $false }) }
    Expect-Error { Invoke-TmdbImageRepair $f.Hosts (Join-Path $f.Folder 'backups') $dummyCurl } 'All failed candidates accepted'
    Assert ((Get-ByteHash ([IO.File]::ReadAllBytes($f.Hosts))) -eq (Get-ByteHash $original)) 'All failed candidates changed hosts'
    Assert (-not (Test-Path -LiteralPath (Join-Path $f.Folder 'backups'))) 'All failed candidates created state'
    Write-Host ("PASS: {0} assertions; only temporary fixtures changed." -f $count)
} finally {
    # 只清理本次 Guid 临时根；先核对解析后的绝对路径，再执行单一 PowerShell 删除。
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedRoot) -notmatch '^kumi-hosts-test-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
