# KumiPlayer 2.0

KumiPlayer 是一款面向 Windows 的本地 / 网盘媒体库与 MPV 播放应用。它把本地目录、115 / 百度目录树 TXT 或 OpenList 远端路径转换成不可变来源证据，再由 V4 媒体图建立 Work、Season、Episode、Edition 与 Asset；**SQLite 是媒体事实的唯一权威，真实媒体的位置和文件名不会被移动、重命名或改写**。

> 项目仍在开发阶段。`release\KumiPlayer.exe` 是依赖当前源码目录的开发版；交给普通用户使用时应构建完整安装包。安装包的公开分发还受内置播放器许可证材料门控，详见下文“已知限制”。

## KumiPlayer 3.0 前端方向（2026-10-15）

- 上一次未完成前端重构及其 Design System、配色、原型、页面布局、P0—P7 路线图、工程蓝图和验收矩阵已废止，不作为施工或验收依据。
- 后续方向为 Electron + React + TypeScript；新前端不继承 Fluent UI、旧主题与旧视觉规范。优先采用成熟组件库，保持模块化、风格统一和组件可替换，避免巨型页面与全局 CSS。
- 目前仅完成仓库整理，不迁移 Electron、不选最终组件库、不设计页面、配色或导航。具体 UI/UX 交由后续专门设计 Skill。
- 当前 Tauri/Fluent 前端及其测试仍保护现有可运行应用；独立新前端不受其布局与主题断言约束。现有设置分类描述仅是当前实现事实，不锁定新前端信息架构。
- Python、SQLite V4、识别、刮削、来源与 MPV 能力及数据保护规则继续有效；源码与真实业务契约优先。事实入口为 README、docs/PROJECT.md 和 docs/current/README.md。

## 核心能力

| 场景 | KumiPlayer 可以做什么 |
|---|---|
| 导入媒体 | 扫描本地目录、解析 115 / 百度目录树 TXT、分页扫描 OpenList 远端目录，统一生成来源证据 |
| 识别整理 | 预览解析事实与媒体图，处理识别问题后确认，生成不可变 revision |
| 后台执行 | confirmed revision 驱动资料快照、独立图片准备与媒体库投影发布；任务持久化，重启后恢复 |
| 元数据 | 以 TMDB 为身份权威、AniList 作为别名恢复补充，结果保存为 SQLite 内不可变资料快照 |
| 浏览 | 首页推荐、分类、来源筛选、搜索、收藏、最近观看和虚拟化海报墙 |
| 作品详情 | 简介、演员、季度、剧集与多版本 Asset、关联作品和相关推荐 |
| 播放 | KumiPlayer 内置干净 MPV + 自有配置层（含弹幕），按 Asset 保存进度与本地观看状态 |
| Bangumi | 账号会话、登录验证、搜索、匹配、收藏与观看进度同步；不参与本地作品身份与编号 |
| 媒体维护 | 查看 V4 任务、诊断投影、按来源预览并执行受保护的删除，重置 V4 状态 |

## 支持的媒体来源

| 来源 | 接入方式 | 说明 |
|---|---|---|
| **本地** | 目录扫描 | 设置中可登记多个目录，导入时选其中一个或输入自定义路径；网盘挂载目录使用 TXT 或 OpenList |
| **115 网盘** | 目录树 TXT | 解析 115 导出的树形文本（UTF-8 / UTF-16 / GBK 自动探测），保留导出范围未知的快照 |
| **百度网盘** | 目录树 TXT | 解析百度导出的 `tree` 命令格式，与 115 规则互不通用 |
| **OpenList** | 服务器 API | 连接自建 OpenList 服务，单层目录分页扫描、完整性校验后原子提交；支持 115 / 百度 / 夸克等提供商路由 |
| **目录树 + OpenList 增量** | TXT 基线 + OpenList 增量 | 以 TXT 建立基线，后续用 OpenList 有界增量核对，避免重复扫描 |

网盘目录树可保存为媒体库预设：之后选择新版 TXT 更新同一来源，导出范围未知时保留未再次出现的基线条目。任意页面拖入单个目录树 TXT 会自动识别 115 或百度格式并进入导入流程；原始 TXT 只为复制到本地打开一次，不会被写回或改名。

百度与115目录树导入从本地挂载盘选择原位置生成的 TXT，自动用 TXT 父目录定位本次导出范围：百度正文省略所选文件夹，直接拼接相对路径；115正文保留“根目录 → 所选文件夹”，只移除这一导出边界，再拼接其下路径。整盘、祖先目录、所选文件夹直接挂载及 UNC 路径使用同一规则，无需另选播放位置或访问视频样本。原 TXT 只为复制打开一次，后台解析本地归档并消费冻结映射；默认来源和 OpenList 设置不会覆盖该定位。夸克、显式映射与 TXT＋OpenList 混合来源保留各自合同。旧库错误路径需重新导入或重扫后确认新修订纠正。

OpenList 在线扫描先读取少量真实视频样本，比较连接根、提供商根与子目录挂载的有限候选，用本地文件属性验证对应位置。只有唯一可达映射才自动继续；多个可达映射需要选择，无样本、离线或无法验证时停止扫描，不生成待确认的媒体路径。确认前再次检查样本，手动设置播放位置作为最后兜底，仍需验证。此检查证明抽样路径可达，不代表每个视频均已解码验收。

已有错误路径通过重新扫描同一来源、审核并确认新修订纠正；原始来源证据保持不变，既有媒体身份与播放进度保留。播放器不在播放时自行猜测或裁剪目录层级。

## 核心工作流

```text
导入（本地目录 / 115·百度目录树 TXT / OpenList 分页扫描 / 目录树 + OpenList 增量）
  → 识别整理（作品 / 季度 / 剧集 / 电影 / 特别篇，识别问题需先处理）
  → 确认后写入 SQLite（包含最终本地绝对播放路径）
  → 后台资料快照与独立图片库（原图、展示尺寸、内容版本）
  → 媒体库发布（图片齐全后逐作品发布卡片与详情，前端增量刷新）
  → MPV 直播放（进度、历史与本地观看状态）
  → 新番追更（增量更新，可选启动更新与定时更新）
```

媒体管理页的三段式流程固定为 `source → review → execute`：选择来源并扫描、审核识别预览、确认后执行后台作业；离开页面后返回可恢复批次状态。确认前必须处理阻断识别问题；confirmed revision 只产生 V4 作业，任务输入固定为 revision / work / asset 身份，不会重新识别来源。

播放直接使用已保存的本地绝对媒体路径（网盘通过本地挂载），**不生成 STRM 包装文件**；镜像与 NFO 已不参与运行链。

## 容易错过的功能

### 重复启动与系统托盘

再次打开快捷方式会显示并唤起已有窗口，不另启动后端。关闭后立即重开时，应用先完成旧后端清理，再恢复窗口与后端。“设置 → 应用 → 窗口与托盘”分别提供“最小化到托盘”和“关闭窗口时收到托盘”，默认均关闭；窗口偏好由桌面壳保存到本机数据目录的 `window-preferences.json`。主题与作品墙布局归属“外观”，播放器设置归属“播放”，OpenList 是“媒体来源”之外的独立分类。

### 新番与增量更新

导入默认“已完结”，持续更新的动漫或电视剧可选择“新番”，并使用与已完结来源互不包含的独立文件夹。新番按正片季度处理，辅助视频仍排除；一两集也不会推成电影。已有已确认且资料齐全的作品、已知季度和无歧义集号才能自动追加并刮削，其他变化回到媒体管理检查预览，无变化不重复创建作业。启动更新与定时更新（默认关闭，间隔可设为关闭或 15–10080 分钟）在设置的媒体来源分类中管理；分类名称作为本机界面偏好保存，不改变媒体事实。纯 TXT 来源需要重新导出清单：刷新会提示选择新 TXT，不把旧归档当成网盘新事实。

### 作品详情与多版本

作品详情页读取后台发布的详情与版本，图片只读取独立本地缓存。季度编号、集号和版本关系由后端媒体图决定，前端不再自行合卡或重写编号；同一集的不同清晰度、压制组或来源会作为多个 Asset 保留，可选择 Asset 播放、标记本地观看状态，或按来源在资源管理器中定位当前媒体（只接受作品、剧集与 Asset 身份，不接受前端路径）。手动标题与手动图片覆盖优先于在线元数据，直到用户明确恢复。

### MPV 截图

- `F10`：无字幕、无顶部提示的纯净截图。
- `Alt+F10`：带字幕截图，并显示 MPV 原生截图路径提示。

截图保存到 `桌面\动漫截图\作品名 - SxxExx - 剧集标题\HH-MM-SS.mmm.jpg`，目录名来自刮削后的作品与剧集标题，文件名为视频内精确到毫秒的时间，不添加 `_01` 序号。

### 弹幕

内置播放器的默认套件包含弹幕组件（`uosc_danmaku`），播放时按 `Ctrl+d` 搜索弹幕即可。第三方插件目录及其运行数据不进入版本控制。

## 快速开始

### 开发版（当前源码目录）

运行：

```text
release\KumiPlayer.exe
```

以下文件必须相邻：`release\KumiPlayer.exe` 与 `release\WebView2Loader.dll`。

开发版走“源码模式”：桌面壳按 PATH 顺序探测 `pythonw.exe` / `python.exe`，用找到的解释器运行 `backend\desktop_backend.py`，运行时读取项目 `backend\`、`data\` 与 `mpv\runtime\`。因此本机需要：

- Python 3.12，且**该 PATH 上的解释器已安装 `backend/pyproject.toml` 的运行依赖**（`fastapi`、`uvicorn`、`python-multipart`、`websockets`、`httpx[http2,socks]`、`pillow`）。项目内的 `backend\.venv` 不参与开发版启动，只用于命令行开发与测试。
- 内置 MPV 运行时目录 `mpv\runtime\` 完整（该目录按 `.gitignore` 不随 Git 分发，需从备份恢复）。
- 前端界面由 EXE 内嵌的构建产物提供；`dist\` 只在构建时使用。

也可以直接用 `dev.bat` 启动开发模式（`npm run tauri dev`，前端由 Vite dev server 提供，后端仍由桌面壳拉起）。`node_modules` 会在构建后被清理脚本删除，缺失时 `dev.bat` 会自动 `npm install`。

### 普通用户安装版

运行安装包：

```text
release\KumiPlayer-Setup.exe
```

安装包包含冻结后的 Python 后端与桌面程序，用户无需安装 Python、Node.js 或 Rust；首次安装建议联网，以便系统缺少 WebView2 时下载微软官方运行时。安装版数据默认位于 `%LOCALAPPDATA%\KumiPlayer\data`。

首次设置包含四步：查看运行方式与数据保护说明 → 选择播放器 → 选择媒体来源 → 可选填写 TMDB / Bangumi 凭据。右上角“稍后设置”可直接进入软件，下次启动保留该选择；未完成的配置不会被标记为已完成，可随时从“设置 → 应用 → 设置引导”重新检查。播放器检测成功即保存；媒体来源在点击“继续”时检查并保存；TMDB 与 Bangumi 各自“验证并保存”，不依赖最后一步是否完成。

TMDB 需要的是“API 读取访问令牌”，不是 32 位 API Key。

### TMDB 图片下载失败

在“设置 → 元数据与图片”检测图片连接；首次引导保存 TMDB 令牌后与导入图片失败时也会自动检测。连接异常时可点“一键修复图片连接”，允许 Windows 权限提示并等待完成；复检成功后自动重试当前有效的失败图片，不必重新导入，也可“恢复修复前设置”撤回。独立入口 [修复TMDB图片.cmd](scripts/repair/tmdb-images/修复TMDB图片.cmd) 与 [恢复原设置.cmd](scripts/repair/tmdb-images/恢复原设置.cmd) 保留，工具**只修改图片域名的 hosts**，也会影响其他软件访问同一域名。

## 运行环境与本地数据

| 内容 | 位置 | 性质 |
|---|---|---|
| 非敏感配置 | `<数据目录>\config.json` | 主题、目录、OpenList、播放器等用户设置 |
| API 凭据 | Windows Credential Manager | TMDB、Bangumi、OpenList 密码等敏感值 |
| 媒体与任务权威 | `<数据目录>\kumiplayer.db` | Work / Season / Episode / Asset、revision、jobs、进度、历史与追更状态；`PRAGMA user_version` 迁移，库版本高于程序时拒绝打开 |
| 来源输入归档 | `<数据目录>\source_inputs\` | 目录树 TXT 的只读归档 |
| OpenList 缓存与增量 | `<数据目录>\openlist_cache\`、`openlist_incremental\` | 连接器缓存与增量扫描状态（按需创建） |
| 独立图片库 | `<数据目录>\artwork\`、`cache\artwork_variants\` | 受管原图、手工上传与按内容版本和尺寸生成的 WebP 派生（按需创建） |
| MPV 状态 | `<数据目录>\mpv-state\` | 缓存、日志与 watch-later，与用户全局 MPV 隔离 |
| 日志 | `<数据目录>\logs\` | 运行与后端诊断日志 |

源码 / 开发版使用项目 `data\`；安装版使用 `%LOCALAPPDATA%\KumiPlayer\data`。旧版 `config.json` 中的明文凭据会在读取时迁移到系统凭据存储，只有写入成功后才清空旧值。

## 数据安全

KumiPlayer 不会主动移动或重命名真实媒体。构建、安装和升级不得覆盖现有 `data\`、图片、播放记录、资料快照或 Token；删除与清理功能必须先预览影响范围，再由用户确认。来源媒体（真实媒体、挂载盘目录）与用户自建快照属于绝对边界，不会传给递归删除。凭据不显示在公开界面、脱敏诊断或错误信息中；不要把真实 Token 写入公开问题报告。

启动失败时不会留下空白窗口：桌面安全会话初始化失败、React 崩溃或本地后端未就绪都会进入恢复界面，可直接重新加载应用、重启本地后端、打开日志目录或导出脱敏诊断。正常退出时 Tauri 会终止自己启动的后端进程，Windows Job Object 与心跳超时是额外兜底。

## 系统架构

```text
┌──────────────────────────┐  HTTP / WebSocket      ┌──────────────────────────────┐
│  React 前端（WebView2）    │  (127.0.0.1:37821)     │  Python FastAPI 后端           │
│  页面 / 海报墙 / 媒体管理   │ ─────────────────────► │  来源 / 识别 / 确认 / 资料 / 图片 │
│  Zustand 状态 + API 客户端 │ ◄───────────────────── │  媒体库 / 播放 / 追更 / 任务队列 │
└────────────┬─────────────┘   会话 Token + 心跳      └───────────────┬──────────────┘
             │ Tauri 2 / Rust 壳：启动后端、健康探活、重启、退出回收（Job Object）
             ▼                                                       ▼
      WebView2 / 窗口（无边框）                         SQLite + 独立图片库 + MPV 运行时
```

- **前端**（React 19 + TypeScript + Fluent UI + Vite）：只通过本机 HTTP API 与后端通信，不直接接触文件系统；虚拟化海报墙、无 URL Router（页面状态由 Zustand 驱动）。
- **桌面壳**（Tauri 2 / Rust）：窗口与 WebView2、后端进程监管（每次启动生成随机会话 Token 注入后端、身份校验探活、退出时回收整棵进程树）；不承载业务逻辑。
- **后端**（Python 3.12 + FastAPI + SQLite）：全部领域逻辑——来源解析、识别确认、资料快照、独立图片、展示投影、播放、持久任务队列；长任务写入 SQLite 队列，崩溃或重启后自动恢复。

接口面以源码开发模式的 OpenAPI（`/docs`）为准确认；本地 HTTP 与 WebSocket 除 `/api/health` 外都要求桌面壳注入的会话 Token。

## 构建

下面这些工具用于从源码制作程序与安装包，**普通用户运行已生成的安装包无需安装它们**。

| 依赖 | 要求与用途 |
|---|---|
| Git | 源码版本管理；从网盘恢复时保留 `.git`，不要覆盖已有修改 |
| Node.js + npm | 推荐 Node.js 22；构建 React 前端与运行 Tauri CLI |
| Python | Python 3.12，安装时启用 Add to PATH；商店的 `python` 占位入口不可用于构建 |
| uv | 按 `backend/uv.lock` 恢复项目 Python 环境 |
| PyInstaller | 安装包后端冻结工具，由 `installer` extra 锁定安装 |
| Rust | stable，当前 Windows 构建使用 `x86_64-pc-windows-gnu` 工具链 |
| GCC / MinGW-w64 | 完整的 Windows GNU 编译器与库（例如 WinLibs POSIX/UCRT），将 `mingw64/bin` 加入 PATH |
| 内置 MPV 文件 | 保留 `mpv/runtime\`、配置与运行时清单；仅下载 Git 源码不包含被忽略的播放器二进制 |

官方入口：[Python](https://www.python.org/downloads/windows/)、[Node.js](https://nodejs.org/)、[uv](https://docs.astral.sh/uv/getting-started/installation/)、[Rust](https://rust-lang.github.io/rustup/installation/)、[WinLibs](https://winlibs.com/)。NSIS 打包工具由 Tauri 构建流程下载。

标准构建入口：

```bat
build_tauri.bat        :: 开发 EXE → release\KumiPlayer.exe + WebView2Loader.dll
build_installer.bat    :: 完整安装包 → release\KumiPlayer-Setup.exe
```

两个入口都会先运行 `scripts\ensure_kumiplayer_runtime_stopped.ps1` 预检：检测到 KumiPlayer 仍在运行即中止本次构建，需先正常关闭应用。开发 EXE 构建执行 TypeScript 检查、Tauri 构建与桌面产物验证；安装包额外检查冻结后端、内置 MPV 运行时与 NSIS 内容。默认 `build_installer.bat` 是带 `LOCAL_TEST_ONLY.txt` 标记的本机安装自测；公开发布使用 `build_installer.bat --public-release`，仍须通过内置 MPV 的许可证材料检查。

## 验证

```bash
npm ci                 # 构建后 node_modules 会被清理，运行前端命令前先恢复依赖
npm test               # 契约测试（node --test）+ 组件测试（vitest）
npm run build          # tsc -b && vite build
npm run check:versions # 各层版本一致性

uv sync --project backend --locked --extra dev
uv run --project backend python -m pytest backend/tests

cd src-tauri
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

以上命令验证的是源码行为与离线回归；**通过测试不等于已在干净 Windows 环境完成安装版验收**，也不代表真实网盘、真实播放器与三主题桌面视觉已经验证。

## 已知限制

- **内置播放器公开分发未解锁**：`mpv/runtime-manifest.json` 的 `distribution_status` 仍为 `development-only`，对应源码闭包与部分许可证材料未齐，公开发布门控会拦截携带内置 MPV 的安装包；本机自测安装包带明确标记。用户也可以改用自备的外部 MPV 整合包（KumiPlayer 只驱动它，不改写其配置）。
- **手工追加剧集尚未接入 V4**：详情页的“追加剧集”入口按能力开关隐藏，后端没有对应路由；恢复时必须按 V4 数据流重新设计。
- **Bangumi 只做同步**：提供账号会话、搜索、匹配、收藏与观看进度同步，不参与本地作品身份与集号写入；作品身份始终由 TMDB 裁决，AniList 仅用于别名恢复。
- **未完成的验收**：干净 Windows 的完整安装、升级/卸载保留数据、真实网盘与真实 MPV 启动、WebView2 滚动性能与三主题视觉验收仍待执行。
- **平台范围**：当前安装链面向 Windows 10 / 11 x64；ARM64 原生、32 位与离线新机安装不在已验证范围内。

## 文档

随源码公开（GitHub 可见）：

- [`README.md`](README.md)：入口文档（本文件）
- [`mpv/README.md`](mpv/README.md)：内置 MPV 的分层、注入契约、源码↔安装包映射与许可证材料现状（MPV 相关唯一事实来源）
- [`scripts/README.md`](scripts/README.md)：构建、验证、只读审计与修复脚本说明
- [`src/components/ui/README.md`](src/components/ui/README.md)：当前前端共享组件说明（不作为 3.0 设计规范）
- [`项目经验教训/项目建设与性能优化规范.md`](项目经验教训/项目建设与性能优化规范.md)：开发与性能优化的实施规范
- [`docs/review/`](docs/review/)：对外审阅用的根因与合规分析文档
- [`docs/current/README.md`](docs/current/README.md)：现有系统事实快照，不约束新前端设计
- [`docs/DOCUMENT_CLEANUP_REPORT.md`](docs/DOCUMENT_CLEANUP_REPORT.md)：本轮清理清单、保留边界与验证结果

本地开发资料（`.gitignore` 排除，只在本地工作副本中可读，GitHub 读者无法访问）：

- `docs/PROJECT.md`：现行总体架构；`docs/PROJECT_MEMORY.md`：长期项目记忆（含较多历史条目，冲突时以源码为准）
- `docs/USER_GUIDE.md`：用户功能指南（部分内容尚未同步到 V4）；`docs/PROJECT_STRUCTURE.md`：目录结构
- `docs/DISTRIBUTION.md`：Windows 分发说明与安装版兼容性矩阵；`docs/THIRD_PARTY_NOTICES.md`：第三方声明
- `docs/01_项目基准/`：配置与数据目录、目录树解析、命名与运行架构等业务基线
- `docs/项目现状与改进清单.md`：已过时内容、已确认缺陷、待核实项与优化建议的维护清单
- `docs/90_历史归档/`：明确标注的历史归档，不参与施工

不要把真实 Token、Key、网盘路径或个人媒体目录写入公开文档、日志和问题报告。
