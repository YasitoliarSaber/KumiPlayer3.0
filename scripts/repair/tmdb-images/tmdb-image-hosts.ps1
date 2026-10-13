[CmdletBinding(DefaultParameterSetName = 'Apply')]
param(
    [Parameter(ParameterSetName = 'Restore')][switch]$Restore,
    [Parameter(ParameterSetName = 'Diagnose')][switch]$Diagnose,
    [switch]$NoPause,
    [switch]$Headless,
    [string]$CandidatesJson = ''
)

# Windows PowerShell 5.1：源文件采用 UTF-8 BOM，启动器为 UTF-8 无 BOM + CRLF。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:WindowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$env:PSModulePath = [IO.Path]::Combine($script:WindowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
$script:EmbeddedCandidatesJson = $CandidatesJson
$script:RepairOutcome = 10
$script:ImageDomain = 'image.tmdb.org'
$script:BeginMarker = '# BEGIN KumiPlayer TMDB image repair'
$script:EndMarker = '# END KumiPlayer TMDB image repair'
$script:SampleUrls = @(
    'https://image.tmdb.org/t/p/w500/1E5baAaEse26fej7uHcjOgEE2t2.jpg',
    'https://image.tmdb.org/t/p/w500/wwemzKWzjKYJFfCeiB57q3r4Bcm.png'
)

function Get-ByteHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw '检测到链接或重定向路径，已停止；没有修改系统设置。'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Test-PublicIPv4([string]$Value) {
    $ip = $null
    if ($Value -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or
        -not [Net.IPAddress]::TryParse($Value, [ref]$ip) -or
        $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $b = $ip.GetAddressBytes()
    if ($b[0] -in @(0, 10, 127) -or $b[0] -ge 224) { return $false }
    if ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) { return $false }
    if ($b[0] -eq 169 -and $b[1] -eq 254) { return $false }
    if ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) { return $false }
    if ($b[0] -eq 192 -and (($b[1] -eq 168) -or
        ($b[1] -eq 0 -and $b[2] -in @(0, 2)) -or ($b[1] -eq 88 -and $b[2] -eq 99))) { return $false }
    if ($b[0] -eq 198 -and ($b[1] -in @(18, 19) -or ($b[1] -eq 51 -and $b[2] -eq 100))) { return $false }
    if ($b[0] -eq 203 -and $b[1] -eq 0 -and $b[2] -eq 113) { return $false }
    return $true
}

function Invoke-RepairCurl([string]$CurlPath, [string[]]$CurlArguments, [int]$TimeoutSeconds = 10) {
    # 直接启动固定 curl，不经 shell，不继承用户 curlrc；stdout/stderr 同时读取避免阻塞。
    $quoted = foreach ($arg in $CurlArguments) {
        if ($arg.Contains('"') -or $arg.Contains([string][char]10) -or $arg.Contains([string][char]13)) {
            throw '请求参数无效。'
        }
        '"' + $arg + '"'
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $CurlPath
    $info.Arguments = $quoted -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return [pscustomobject]@{ ExitCode = 28; Output = '' }
        }
        [void]$stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function New-RepairTemporaryDirectory {
    $path = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('kumi-tmdb-' + [guid]::NewGuid().ToString('N')))
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($identity)
    foreach ($sid in @($identity, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [void][IO.Directory]::CreateDirectory($path, $acl)
    Assert-PlainPath $path
    return $path
}

function Test-TmdbImage([string]$CurlPath, [string]$Ip = '', [string[]]$Urls = $script:SampleUrls) {
    if ($Ip -and -not (Test-PublicIPv4 $Ip)) {
        return [pscustomobject]@{ Ip = $Ip; Ok = $false; Seconds = 0; Kind = 'invalid_ip' }
    }
    $temporaryDirectory = New-RepairTemporaryDirectory
    $temporary = [IO.Path]::Combine($temporaryDirectory, 'probe.img')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $kind = 'network'
    try {
        foreach ($url in $Urls) {
            $curlArgs = @('--disable', '--noproxy', '*', '--silent', '--fail', '--proto', '=https',
                '--connect-timeout', '3', '--max-time', '6', '--max-filesize', '1048576',
                '--output', $temporary, '--write-out', '%{http_code}|%{content_type}')
            if ($Ip) { $curlArgs += @('--resolve', ('image.tmdb.org:443:' + $Ip)) }
            $result = Invoke-RepairCurl $CurlPath ($curlArgs + @($url))
            if ($result.Output -match '^404\|') { $kind = 'sample_missing'; continue }
            if ($result.ExitCode -ne 0) {
                $kind = if ($result.ExitCode -eq 60) { 'certificate' } else { 'network' }
                break
            }
            if ($result.Output -notmatch '^200\|image/(jpeg|png)(;|$)' -or
                -not (Test-Path -LiteralPath $temporary) -or
                (Get-Item -LiteralPath $temporary).Length -gt 1048576) { $kind = 'invalid_image'; break }
            Add-Type -AssemblyName System.Drawing
            $stream = [IO.File]::OpenRead($temporary)
            $image = $null
            $bitmap = $null
            try {
                $image = [Drawing.Image]::FromStream($stream, $false, $true)
                if ($image.Width -lt 1 -or $image.Height -lt 1 -or
                    [long]$image.Width * $image.Height -gt 40000000) { throw 'Invalid size' }
                $bitmap = New-Object Drawing.Bitmap($image)
                [void]$bitmap.GetPixel(0, 0)
                return [pscustomobject]@{ Ip = $Ip; Ok = $true; Seconds = $timer.Elapsed.TotalSeconds; Kind = 'ready' }
            } catch { $kind = 'invalid_image' }
            finally {
                if ($bitmap) { $bitmap.Dispose() }
                if ($image) { $image.Dispose() }
                $stream.Dispose()
            }
            break
        }
    } catch { $kind = 'network' }
    finally {
        $timer.Stop()
        if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
        [IO.Directory]::Delete($temporaryDirectory, $false)
    }
    return [pscustomobject]@{ Ip = $Ip; Ok = $false; Seconds = $timer.Elapsed.TotalSeconds; Kind = $kind }
}

function Get-TmdbCandidates([string]$CurlPath, [string]$SeedPath) {
    $ips = New-Object 'Collections.Generic.List[string]'
    $json = if ($script:EmbeddedCandidatesJson) { $script:EmbeddedCandidatesJson } else { [IO.File]::ReadAllText($SeedPath, [Text.Encoding]::UTF8) }
    if ($json.Length -gt 65536) { throw '候选清单过大。' }
    $seed = $json | ConvertFrom-Json
    if ($seed.domain -ne $script:ImageDomain -or @($seed.candidates).Count -gt 64) { throw '候选清单格式无效。' }
    foreach ($item in $seed.candidates) { if (Test-PublicIPv4 $item.ip) { $ips.Add($item.ip) } }
    # 只对本次查询指定服务器，不修改网卡 DNS；失败不会删除历史候选。
    foreach ($server in @('223.5.5.5', '119.29.29.29', '1.1.1.1', '8.8.8.8')) {
        try {
            $answers = @(Resolve-DnsName -Name $script:ImageDomain -Type A -Server $server -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop)
            foreach ($answer in $answers) {
                if ($answer.Type -eq 'A' -and (Test-PublicIPv4 $answer.IPAddress)) { $ips.Add($answer.IPAddress) }
            }
        } catch {}
    }
    foreach ($endpoint in @('https://cloudflare-dns.com/dns-query?name=image.tmdb.org&type=A',
        'https://dns.google/resolve?name=image.tmdb.org&type=A')) {
        try {
            $response = Invoke-RepairCurl $CurlPath @('--disable', '--noproxy', '*', '--silent', '--fail',
                '--proto', '=https', '--connect-timeout', '3', '--max-time', '6',
                '--header', 'accept: application/dns-json', $endpoint)
            if ($response.ExitCode -ne 0 -or $response.Output.Length -gt 65536) { continue }
            $dns = $response.Output | ConvertFrom-Json
            if ($dns.Status -ne 0) { continue }
            foreach ($answer in $dns.Answer) {
                if ($answer.type -eq 1 -and (Test-PublicIPv4 $answer.data)) { $ips.Add($answer.data) }
            }
        } catch {}
    }
    return @($ips | Select-Object -Unique | Select-Object -First 32)
}

function Test-TmdbCandidates([string]$CurlPath, [string[]]$Candidates) {
    $pool = [RunspaceFactory]::CreateRunspacePool(1, 4)
    $pool.Open()
    $jobs = New-Object Collections.ArrayList
    $results = New-Object Collections.ArrayList
    $definitions = 'Set-StrictMode -Version Latest; $ErrorActionPreference = "Stop";'
    foreach ($name in @('Assert-PlainPath', 'New-RepairTemporaryDirectory', 'Test-PublicIPv4', 'Invoke-RepairCurl', 'Test-TmdbImage')) {
        $definitions += 'function ' + $name + ' {' + (Get-Item ('function:' + $name)).Definition + '};'
    }
    try {
        foreach ($candidate in $Candidates) {
            $worker = [PowerShell]::Create()
            $worker.RunspacePool = $pool
            [void]$worker.AddScript('param($curlPath,$ip,$urls);' + $definitions +
                '$a=Test-TmdbImage $curlPath $ip $urls; if($a.Ok){$b=Test-TmdbImage $curlPath $ip $urls; if(-not $b.Ok){$a=$b}}; $a')
            [void]$worker.AddArgument($CurlPath).AddArgument($candidate).AddArgument($script:SampleUrls)
            [void]$jobs.Add([pscustomobject]@{ Worker = $worker; Handle = $worker.BeginInvoke(); Collected = $false })
        }
        while (@($jobs | Where-Object { -not $_.Collected }).Count -gt 0) {
            foreach ($job in $jobs) {
                if (-not $job.Collected -and $job.Handle.IsCompleted) {
                    try { foreach ($item in $job.Worker.EndInvoke($job.Handle)) { [void]$results.Add($item) } }
                    catch {}
                    $job.Collected = $true
                }
            }
            $done = @($jobs | Where-Object { $_.Collected }).Count
            Write-Progress -Activity '正在本机验证多个图片地址' -Status "$done / $($Candidates.Count)" -PercentComplete ([int](100 * $done / [Math]::Max(1, $Candidates.Count)))
            if ($done -lt $Candidates.Count) { Start-Sleep -Milliseconds 100 }
        }
    } finally {
        Write-Progress -Activity '正在本机验证多个图片地址' -Completed
        foreach ($job in $jobs) { $job.Worker.Dispose() }
        $pool.Dispose()
    }
    return @($results)
}

function New-TmdbHostsBytes([byte[]]$Original, [string[]]$Ips) {
    if ($Original.Length -gt 1048576 -or $Original -contains 0) { throw 'hosts 格式无法安全处理，已停止。' }
    foreach ($ip in $Ips) { if (-not (Test-PublicIPv4 $ip)) { throw '拒绝写入非公网地址。' } }
    if ($Ips.Count -eq 0 -or $Ips.Count -gt 32) { throw '有效地址数量异常。' }
    # Latin-1 仅用作字节一一映射，避免重编码已有中文/GBK/UTF-8 内容。
    $encoding = [Text.Encoding]::GetEncoding(28591)
    $hasBom = $Original.Length -ge 3 -and $Original[0] -eq 239 -and $Original[1] -eq 187 -and $Original[2] -eq 191
    $text = if ($hasBom) { $encoding.GetString($Original, 3, $Original.Length - 3) } else { $encoding.GetString($Original) }
    if ($text.Contains($script:BeginMarker) -or $text.Contains($script:EndMarker)) { throw '发现旧修复区块但缺少有效恢复记录，请先恢复原设置。' }
    $eol = if ($text.Contains(([string][char]13 + [char]10))) { [string][char]13 + [char]10 } else { [string][char]10 }
    $builder = New-Object Text.StringBuilder
    foreach ($match in [regex]::Matches($text, '[^\r\n]+(?:\r\n|\n|\r|$)|(?:\r\n|\n|\r)')) {
        $line = $match.Value
        $ending = [regex]::Match($line, '(\r\n|\n|\r)$').Value
        $body = $line.Substring(0, $line.Length - $ending.Length)
        $parts = $body.Split(@([char]'#'), 2)
        $code = $parts[0]
        $comment = if ($parts.Count -gt 1) { '#' + $parts[1] } else { '' }
        if ($code -match '(?i)(?<=\s)image\.tmdb\.org\.?(?=\s|$)') {
            $code = [regex]::Replace($code, '(?i)(?<=\s)image\.tmdb\.org\.?(?=\s|$)', '')
            if (@([regex]::Matches($code, '\S+')).Count -lt 2) { $code = '' }
        }
        [void]$builder.Append($code + $comment + $ending)
    }
    if ($builder.Length -gt 0 -and $builder[$builder.Length - 1] -ne [char]10 -and $builder[$builder.Length - 1] -ne [char]13) { [void]$builder.Append($eol) }
    [void]$builder.Append($script:BeginMarker + $eol)
    foreach ($ip in ($Ips | Select-Object -Unique)) { [void]$builder.Append($ip + ' ' + $script:ImageDomain + $eol) }
    [void]$builder.Append($script:EndMarker + $eol)
    $result = $encoding.GetBytes($builder.ToString())
    if ($hasBom) { $result = [byte[]](@(239, 187, 191) + $result) }
    return ,$result
}

function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Set-GuardedBytes([string]$Path, [string]$ExpectedHash, [byte[]]$Bytes, [string]$BackupDirectory) {
    Assert-PlainPath $Path
    Assert-PlainPath $BackupDirectory
    if ((Get-ByteHash ([IO.File]::ReadAllBytes($Path))) -ne $ExpectedHash) { throw '文件已被其他程序修改，已停止，避免覆盖别人的设置。' }
    $temporary = [IO.Path]::Combine([IO.Path]::GetDirectoryName($Path), ('.kumi-tmdb-' + [guid]::NewGuid().ToString('N') + '.tmp'))
    $captured = [IO.Path]::Combine($BackupDirectory, ('replace-' + [guid]::NewGuid().ToString('N') + '.bak'))
    try {
        Write-NewBytes $temporary $Bytes
        [IO.File]::SetAccessControl($temporary, [IO.File]::GetAccessControl($Path))
        # File.Replace 保留目标元数据；捕获被替换的实际版本，覆盖窗口内有并发修改则撤回。
        if ((Get-ByteHash ([IO.File]::ReadAllBytes($Path))) -ne $ExpectedHash) { throw '文件在写入前发生变化，已停止。' }
        [IO.File]::Replace($temporary, $Path, $captured, $false)
        $previous = [IO.File]::ReadAllBytes($captured)
        if ((Get-ByteHash $previous) -ne $ExpectedHash) {
            if ((Get-ByteHash ([IO.File]::ReadAllBytes($Path))) -eq (Get-ByteHash $Bytes)) {
                Set-GuardedBytes $Path (Get-ByteHash $Bytes) $previous $BackupDirectory
            }
            throw '检测到并发修改，已保留恢复备份并停止。'
        }
        if ((Get-ByteHash ([IO.File]::ReadAllBytes($Path))) -ne (Get-ByteHash $Bytes)) { throw '写入后文件被修改，恢复备份已保留。' }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Save-RepairState([string]$Directory, $State) {
    $path = [IO.Path]::Combine($Directory, 'state.json')
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($State | ConvertTo-Json -Depth 5))
    if (Test-Path -LiteralPath $path) { Set-GuardedBytes $path (Get-ByteHash ([IO.File]::ReadAllBytes($path))) $bytes $Directory }
    else { Write-NewBytes $path $bytes }
}

function Initialize-RepairDirectory([string]$Directory) {
    Assert-PlainPath $Directory
    if (-not (Test-Path -LiteralPath $Directory)) {
        [void][IO.Directory]::CreateDirectory($Directory)
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
            $identity = New-Object Security.Principal.SecurityIdentifier($sid)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
        [IO.Directory]::SetAccessControl($Directory, $acl)
    }
    $acl = [IO.Directory]::GetAccessControl($Directory)
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) {
        throw '恢复目录所有者或继承权限异常，已停止。'
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and
            $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw '恢复目录权限异常，已停止。' }
    }
}

function Read-RepairState([string]$Directory) {
    $path = [IO.Path]::Combine($Directory, 'state.json')
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    Assert-PlainPath $path
    if ((Get-Item -LiteralPath $path).Length -gt 65536) { throw '恢复记录无效。' }
    $state = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($state.version -ne 1 -or $state.original_hash -notmatch '^[a-f0-9]{64}$' -or
        $state.applied_hash -notmatch '^[a-f0-9]{64}$' -or $state.previous_hash -notmatch '^[a-f0-9]{64}$') {
        throw '恢复记录校验失败。'
    }
    return $state
}

function Get-OriginalRepairBytes([string]$Directory, $State) {
    if ($State.original_file -notmatch '^original-[a-f0-9]{32}\.bak$') { throw '恢复记录中的备份名称无效。' }
    $path = [IO.Path]::Combine($Directory, $State.original_file)
    Assert-PlainPath $path
    $bytes = [IO.File]::ReadAllBytes($path)
    if ((Get-ByteHash $bytes) -ne $State.original_hash) { throw '恢复备份校验失败，已停止。' }
    return ,$bytes
}

function Restore-TmdbHosts([string]$HostsPath, [string]$Directory) {
    $state = Read-RepairState $Directory
    if (-not $state) { Write-Host '没有本工具的修复记录，无需恢复。'; return }
    $original = Get-OriginalRepairBytes $Directory $state
    $hash = Get-ByteHash ([IO.File]::ReadAllBytes($HostsPath))
    if ($hash -eq $state.original_hash) { Write-Host '已经是修复前的原设置。'; return }
    if ($hash -ne $state.applied_hash -and -not ($state.status -eq 'prepared' -and $hash -eq $state.previous_hash)) {
        throw 'hosts 在修复后被其他程序修改；本工具不会覆盖这些修改，请按备份核对目标条目。'
    }
    Set-GuardedBytes $HostsPath $hash $original $Directory
    $state.status = 'restored'
    Save-RepairState $Directory $state
    $script:RepairOutcome = 0
    Write-Host '已恢复修复前的 hosts，其他网络设置保持原样。' -ForegroundColor Green
}

function Apply-TmdbHosts([string]$HostsPath, [string]$Directory, [string[]]$Ips, [scriptblock]$Verify) {
    Assert-PlainPath $HostsPath
    $current = [IO.File]::ReadAllBytes($HostsPath)
    $currentHash = Get-ByteHash $current
    $oldState = Read-RepairState $Directory
    $original = $current
    if ($oldState -and ($currentHash -eq $oldState.applied_hash -or
        ($oldState.status -eq 'prepared' -and $currentHash -eq $oldState.previous_hash))) { $original = Get-OriginalRepairBytes $Directory $oldState }
    elseif ($oldState -and $currentHash -ne $oldState.original_hash) { throw 'hosts 有修复后的其他改动，已停止，避免覆盖。' }
    $proposed = New-TmdbHostsBytes $original $Ips
    $backupName = 'original-' + [guid]::NewGuid().ToString('N') + '.bak'
    Write-NewBytes ([IO.Path]::Combine($Directory, $backupName)) $original
    $state = [pscustomobject]@{
        version = 1; status = 'prepared'; original_file = $backupName
        original_hash = Get-ByteHash $original; applied_hash = Get-ByteHash $proposed
        previous_hash = $currentHash; ips = $Ips; created_at = [DateTime]::UtcNow.ToString('o')
    }
    Save-RepairState $Directory $state
    try {
        Set-GuardedBytes $HostsPath $currentHash $proposed $Directory
        if (-not (& $Verify)) { throw '写入后真实图片测试未通过。' }
        $state.status = 'applied'
        Save-RepairState $Directory $state
    } catch {
        $failure = $_
        if ((Get-ByteHash ([IO.File]::ReadAllBytes($HostsPath))) -eq $state.applied_hash) {
            Set-GuardedBytes $HostsPath $state.applied_hash $current $Directory
            if ($oldState) { Save-RepairState $Directory $oldState }
            else { $state.status = 'rolled_back'; Save-RepairState $Directory $state }
        }
        throw $failure
    }
}

function Invoke-TmdbImageRepair(
    [string]$HostsPath = [IO.Path]::Combine($script:WindowsDirectory, 'System32', 'drivers', 'etc', 'hosts'),
    [string]$Directory = [IO.Path]::Combine($script:WindowsDirectory, 'System32', 'drivers', 'etc', 'KumiPlayer-TMDB-backups'),
    [string]$CurlPath = [IO.Path]::Combine($script:WindowsDirectory, 'System32', 'curl.exe')
) {
    if (-not (Test-Path -LiteralPath $curlPath)) { throw 'Windows curl 不可用，请先更新 Windows；没有修改任何网络设置。' }
    Assert-PlainPath $hostsPath
    Write-Host 'KumiPlayer：一键恢复 TMDB 图片连接' -ForegroundColor Cyan
    Write-Host '仅处理 image.tmdb.org；不修改网卡 DNS、系统代理、路由或防火墙。'
    if ($Restore) {
        Initialize-RepairDirectory $directory
        Restore-TmdbHosts $hostsPath $directory
        [void](Invoke-RepairCurl ([IO.Path]::Combine($script:WindowsDirectory, 'System32', 'ipconfig.exe')) @('/flushdns'))
        return
    }
    Write-Host '正在检查当前图片连接…'
    if ((Test-TmdbImage $curlPath).Ok) {
        Write-Host '当前系统直连图片正常，没有修改 hosts。' -ForegroundColor Green
        Write-Host '软件仍无法下载时，请检查“设置 → 刮削 → 网络访问”的代理和图片任务状态。'
        return
    }
    Write-Host '正在获取多个候选地址并进行本机测试，通常需要一到两分钟…'
    $candidatePath = if ($script:EmbeddedCandidatesJson) { '' } else { [IO.Path]::Combine($PSScriptRoot, 'candidates.json') }
    $candidates = @(Get-TmdbCandidates $curlPath $candidatePath)
    Write-Host ("已取得 {0} 个候选；其他电脑的测试结果不会影响本机选择。" -f $candidates.Count)
    $results = @(Test-TmdbCandidates $curlPath $candidates)
    $good = @($results | Where-Object { $_.Ok } | Sort-Object Seconds | Select-Object -ExpandProperty Ip -Unique)
    if ($good.Count -eq 0) { throw '本机暂无通过 HTTPS 图片校验的地址，未修改 hosts。请检查代理或稍后重试；候选清单仍全部保留。' }
    Write-Host ("本机验证通过 {0} 个地址，将全部用于图片域名。" -f $good.Count) -ForegroundColor Green
    if ($Diagnose) { Write-Host '只读检测结束，没有修改 hosts。'; return }
    Initialize-RepairDirectory $directory
    try {
        Apply-TmdbHosts $hostsPath $directory $good {
            [void](Invoke-RepairCurl ([IO.Path]::Combine($script:WindowsDirectory, 'System32', 'ipconfig.exe')) @('/flushdns'))
            $resolved = @([Net.Dns]::GetHostAddresses('image.tmdb.org') | ForEach-Object { $_.ToString() })
            if (@($resolved | Where-Object { $_ -in $good }).Count -eq 0) { return $false }
            return (Test-TmdbImage $curlPath).Ok
        }
    } catch {
        # 回滚后同步清除本次解析缓存，避免继续使用已经撤回的映射。
        [void](Invoke-RepairCurl ([IO.Path]::Combine($script:WindowsDirectory, 'System32', 'ipconfig.exe')) @('/flushdns'))
        throw
    }
    $script:RepairOutcome = 0
    Write-Host '图片连接已恢复，原设置已备份。' -ForegroundColor Green
    Write-Host '请正常重启 KumiPlayer，在媒体管理点击“重新下载媒体图片”。'
    Write-Host '如需撤回，双击同目录的“恢复原设置.cmd”。'
    Write-Host 'hosts 会影响其他软件访问同一个图片域名；全部修复仅限这一域名。'
}

# 点源仅导出函数供临时夹具验证；绝不运行系统修复。
if ($MyInvocation.InvocationName -eq '.') { return }
$exitCode = 0
$repairMutex = $null
$lockTaken = $false
try {
    if (-not $Diagnose) {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Host '系统将请求管理员权限，用于备份和修改图片域名的 hosts。'
            $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
            if ($Restore) { $arguments += ' -Restore' }
            if ($NoPause) { $arguments += ' -NoPause' }
            if ($Headless) { $arguments += ' -Headless' }
            $child = Start-Process -FilePath ([IO.Path]::Combine($script:WindowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) -ArgumentList $arguments -Verb RunAs -WindowStyle Normal -Wait -PassThru
            exit $child.ExitCode
        }
        $repairMutex = New-Object Threading.Mutex($false, 'Global\KumiPlayerTmdbImageHostsRepair')
        try { $lockTaken = $repairMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $lockTaken = $true }
        if (-not $lockTaken) { throw '已有图片修复或恢复操作正在运行，请等待它结束。' }
    }
    Invoke-TmdbImageRepair
} catch {
    $exitCode = 1
    Write-Host ('未完成：' + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host '没有重置整个网络。若写入后的检测失败，脚本会尝试撤回本次修改。'
} finally {
    if ($lockTaken) { $repairMutex.ReleaseMutex() }
    if ($repairMutex) { $repairMutex.Dispose() }
}
if (-not $NoPause -and -not $Headless) { [void](Read-Host '按回车关闭') }
if ($Headless -and $exitCode -eq 0) { exit $script:RepairOutcome }
exit $exitCode
