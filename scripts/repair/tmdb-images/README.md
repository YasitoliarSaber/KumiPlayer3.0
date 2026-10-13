# TMDB 图片一键修复

适用于 Windows 10 / 11。无需安装 Python、Node.js 或额外软件。

软件内也可使用：打开“设置 → 元数据与图片”，检测失败时点击“一键修复图片连接”，允许 Windows 权限提示后等待完成。首次引导和导入图片失败时也有同一入口。复检成功会自动重试当前有效的失败图片；“恢复修复前设置”可撤回。独立入口仍按以下步骤使用。

1. 双击 **修复TMDB图片.cmd**，在 Windows 权限提示中选择“是”。
2. 等待完成。成功后正常重启 KumiPlayer，在媒体管理点击 **重新下载媒体图片**。

如需撤回，双击 **恢复原设置.cmd**。请将本目录的文件放在一起，不单独拷走启动器。

工具会在你的电脑上测试多个地址，将通过 HTTPS 和真实图片校验的地址一起写入 image.tmdb.org 的 hosts 区块。地址清单来自公开资料，并在运行时补充实时 DNS 结果；其他电脑的失败结果不会剔除你的候选。

只处理这个图片域名；不修改网卡 DNS、系统代理、路由、防火墙或媒体库。hosts 同时会影响其他软件访问同一个域名。修改前保存受保护的原始备份；复测失败撤回本次修改，其他程序改过 hosts 时停止恢复，避免覆盖它们的改动。

备份位于 %SystemRoot%\System32\drivers\etc\KumiPlayer-TMDB-backups，仅管理员和系统可写。不要公开分享备份，它可能包含原 hosts 中的私人信息。

全部地址测试失败时不会写入。该工具处理图片连接；不会自动修复错误令牌、不可用代理、缺失图片或存储故障，也不会强制结束 KumiPlayer。

给开发者：运行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File tmdb-image-hosts.ps1 -Diagnose -NoPause 只读检测；test-tmdb-image-hosts.ps1 只对临时夹具进行回归。启动器的 ExecutionPolicy Bypass 仅作用于这次 PowerShell 进程，不修改系统保存的执行策略，不绕过组织策略。

依据：[微软 hosts 编辑器](https://learn.microsoft.com/en-us/windows/powertoys/hosts-file-editor)、[curl 地址覆盖](https://curl.se/docs/manpage.html#--resolve)、[Cloudflare DNS](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)。历史候选的逐条来源在 candidates.json，不保证永久有效，每次在本机重新验证。
