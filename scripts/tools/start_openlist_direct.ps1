[CmdletBinding()]
param(
    [string]$ExecutablePath = (Join-Path ${env:ProgramFiles(x86)} 'OpenList-Desktop\openlist-desktop.exe'),
    [switch]$Notify
)

$ErrorActionPreference = 'Stop'

function Show-LaunchMessage([string]$Message) {
    if ($Notify) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($Message, 'OpenList Desktop') | Out-Null
    }
    Write-Warning $Message
}

try {
    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw '未找到 OpenList Desktop，请检查安装位置。'
    }
    $resolvedExecutable = (Get-Item -LiteralPath $ExecutablePath).FullName
    $running = Get-CimInstance Win32_Process -Filter "Name = 'openlist-desktop.exe'" |
        Where-Object { $_.ExecutablePath -eq $resolvedExecutable }
    if ($running) {
        Show-LaunchMessage 'OpenList Desktop 已在运行。请从托盘正常退出 OpenList Desktop，再使用这个直连入口打开；仅重启核心不会清除已经继承的代理。'
        exit 1
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedExecutable
    $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($resolvedExecutable)
    $startInfo.UseShellExecute = $false
    # 仅调整这次子进程的环境；不修改系统、用户或当前 PowerShell 的代理设置。
    $proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')
    foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
        if ($proxyNames -contains $key.ToUpperInvariant()) {
            $startInfo.EnvironmentVariables.Remove($key)
        }
    }
    [System.Diagnostics.Process]::Start($startInfo) | Out-Null
}
catch {
    Show-LaunchMessage ('OpenList Desktop 启动失败：' + $_.Exception.Message)
    exit 1
}
