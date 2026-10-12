# KumiPlayer 启动、构建与排错

## 启动

当前源码目录测试：

```text
release\KumiPlayer.exe
```

`release\WebView2Loader.dll` 必须与 EXE 相邻。桌面壳会自动启动源码后端，不需要手工先开 FastAPI。

普通用户：

```text
release\KumiPlayer-Setup.exe
```

安装后从开始菜单或安装目录启动。

## 构建

开发 EXE：

```bat
build_tauri.bat
```

完整安装包：

```bat
build_installer.bat
```

默认后端端口为 37821。构建入口会先检查运行中程序和残留后端；不要手工结束无法确认身份的端口占用进程。

安装包入口随后汇总检查本机的 Python 3.12、后端模块与 PyInstaller、Node.js/npm、Rust 和内置 MPV 文件，未通过时保留错误窗口，不开始编译。入口会自动激活 `backend/.venv`。自动化调用可设置 `KUMIPLAYER_BUILD_NO_PAUSE=1`，失败仍返回非零退出码。

从备份恢复源码不会恢复开发环境：Windows 商店的 `python` 占位入口不是真实 Python；备份中的 `backend/.venv` 和 `.cargo/config.toml` 可能仍引用旧电脑的绝对路径。重新安装构建工具后，从 `backend/uv.lock` 恢复环境，在同一 Python 环境安装 PyInstaller，并激活该环境再运行安装包入口。前端依赖残缺时，入口会用 `npm ci` 从锁文件恢复。

双击 `build_installer.bat` 默认生成本机安装自测包，仍使用标准输出 `release/KumiPlayer-Setup.exe`，安装内容附带 `runtime/mpv/LOCAL_TEST_ONLY.txt`。该模式核对播放器文件清单、哈希和配置，不将未完成的公开发布审核伪装为已完成。`build_installer.bat --public-release` 保留公开发布检查；具体材料状态见 `mpv/distribution-manifest.json`。普通用户只需运行已生成的安装包。

恢复后端构建环境：先安装 Python 3.12 与 uv，再执行 `uv sync --project backend --locked --extra dev --extra installer --python 3.12`。PyInstaller 与其依赖已由 `installer` extra 锁定，不需另外向系统 Python 手工安装模块。

## 脚本目录

```text
scripts/
├─ ensure_kumiplayer_runtime_stopped.ps1  构建前运行时预检
├─ check_installer_prerequisites.ps1      安装包构建环境与发布材料预检
├─ build_backend_sidecar.ps1              冻结 Python 后端
├─ stage_mpv_runtime.ps1                  暂存 KumiPlayer MPV 配置与白名单工具
├─ stage_tauri_runtime.ps1                暂存 WebView2Loader
├─ verify_tauri_build.ps1                 验证开发 EXE
├─ verify_installer_bundle.ps1            验证安装包内容
├─ cleanup_build_cache.ps1                清理可重建缓存
├─ check_versions.py                      校验关键依赖版本一致性（npm run check:versions）
├─ tools/                                 只读审计和导出工具
└─ repair/                                已确认样本的定向修复工具
```

## 数据和日志

| 模式 | 数据目录 |
|---|---|
| 源码 / 开发 EXE | `<项目>\data` |
| 安装版 | `%LOCALAPPDATA%\KumiPlayer\data` |

运行日志和错误记录位于对应数据目录的 `logs/`。不要在日志或文档中粘贴完整 Token、Key 和个人媒体路径。

## 常见问题

### 应用提示端口被占用

先关闭所有 KumiPlayer 窗口，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure_kumiplayer_runtime_stopped.ps1
```

脚本只会处理身份明确且父进程已经消失的 KumiPlayer 孤儿后端；其他监听会保持不动并阻止继续。

如果 KumiPlayer 窗口已经正常关闭，但构建仍提示同一个 `KumiPlayer.exe` PID 正在运行，说明桌面壳没有随最后一个窗口退出。先在任务管理器中确认该 PID 确实属于当前工作区且已经没有窗口，再结束这一条残留的 KumiPlayer 进程并重新构建；不要结束身份不明的监听进程，也不要跳过构建预检。

### 开发 EXE 缺少后端环境

确认 Python 可以导入：

```text
fastapi
uvicorn
httpx
python-multipart
websockets
```

普通用户不要配置这些依赖，应改用完整安装包。

### 缺少 WebView2Loader.dll

开发 EXE 需要相邻的 `release\WebView2Loader.dll`。重新运行 `build_tauri.bat`，不要从 `src-tauri/target` 单独复制旧 EXE。

### 前端资源过旧或空白

```bash
npm run build
```

随后重新构建开发 EXE。普通用户遇到持续问题时应重新安装完整安装包。

### 后端启动超时

桌面壳最多等待约 30 秒。检查：

- 37821 是否被占用。
- 开发模式 Python 依赖是否完整。
- 安装目录中的 `runtime/backend/KumiPlayerBackend.exe` 是否存在。
- 安全软件是否拦截本地后端。

## 安全边界

- 审计工具默认只读。
- `repair/` 只能用于已确认的具体样本。
- 不删除 `data/`、用户镜像、真实媒体和 `release/`。
- 不把源码模式数据复制到安装包。
- 不把 `mpv.exe`、`mpv.com` 或第三方 MPV 组合包复制到安装包；普通用户在首次启动时选择外部播放器。
