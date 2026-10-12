# KumiPlayer 2.0

KumiPlayer 是一款面向 Windows 的本地 / 网盘媒体库与 MPV 播放应用。它把本地目录、115 / 百度目录树 TXT 或 OpenList 路径转换为统一的 SourceEvidence，再由 V4 MediaGraph 建立 Work、Season、Episode、Edition 与 Asset；SQLite 是唯一媒体事实源，真实媒体的位置和文件名不会被移动或改写。

> 当前项目仍在开发阶段。`release\KumiPlayer.exe` 是依赖当前源码目录的开发版；交给普通用户使用时应构建完整安装包。

## 核心能力

| 场景 | KumiPlayer 可以做什么 |
|---|---|
| 导入媒体 | 扫描本地目录或目录树 TXT，统一生成 SourceEvidence |
| 识别整理 | 预览 ParsedFacts 与 MediaGraph，确认后生成不可变 revision |
| 后台执行 | confirmed revision 驱动资料快照和展示发布，独立后台准备本地图片资源 |
| 元数据 | 以 TMDB 为主、AniList 为补充，结果保存为 SQLite 资料快照，消费已确认身份与季集映射 |
| 浏览 | 首页推荐、分类、来源筛选、搜索、收藏、最近观看和虚拟化海报墙 |
| 作品详情 | 查看简介、演员、季度、剧集、关联作品和相关推荐 |
| 播放 | 使用 KumiPlayer 内置干净 MPV 与自有配置，按 Asset 保存进度和本地观看状态 |
| Bangumi | 保留本地账号会话、登录验证、用户信息和作品搜索 |
| 媒体维护 | 查看 V4 jobs、诊断投影、重新扫描并使用受保护的媒体状态重置 |

## 支持的媒体来源

| 来源 | 接入方式 | 说明 |
|---|---|---|
| **115 网盘** | 目录树 TXT | 解析 115 导出的树形文本（UTF-16 / UTF-8 / GBK 自动探测），保留导出范围未知的快照；新版未出现条目不能仅凭文本读完判为缺失 |
| **百度网盘** | 目录树 TXT | 解析百度导出的 `tree` 命令格式，与 115 规则互不通用 |
| **OpenList** | 服务器 API | 连接自建 OpenList 网盘服务，单层目录分页扫描、完整性校验后原子提交；支持 115 / 百度 / 夸克等提供商路由 |
| **本地** | 目录扫描 | 扫描选定的真实本地目录；网盘挂载目录使用 TXT 或 OpenList |

网盘目录树可保存为**媒体库预设**：之后选择新版目录树 TXT 更新同一来源，导出范围未知时保留未再次出现的基线条目。任意页面拖入目录树 TXT 也会自动识别 115 或百度格式，直接进入导入流程。

目录树导入默认复用“媒体来源”中的本地播放位置，分别确定 TXT 导出起点和实际挂载起点。已有对应规则与明确边界优先；文件名、保存位置和同名目录只提供候选，不能直接改变播放路径。证据不足时可做有预算的只读元数据验证，离线或访问失败仍能解析 TXT；剩余歧义在现有预览中确认一次。规则随来源保存，设置变化后重新核对，后台恢复消费已冻结映射。115 的格式外壳只裁一次，百度的真实目录和合法同名嵌套保留；旧库错误路径不会自动修复。

OpenList 导入后会生成**来源卡**（媒体库预设的一种）：一张卡代表一个网盘来源根的完整生命周期，显示识别单元数、需处理数和媒体库建立状态。作品资料有效，且海报、背景图与所有正片剧集预览图在本地准备齐全后，才发布到媒体库并显示已完成；电影无需剧集预览图，演员图片与 logo 不阻断发布。后台逐作品发布，前端增量刷新；任一失败阶段可精确重试（重复点击不会产生重复任务），待处理作品不阻塞其他已发布作品。
## 核心工作流

```text
导入（115 / 百度目录树 TXT、OpenList 分页扫描、本地目录）
  → 识别整理（作品 / 季度 / 剧集 / 电影 / 特别篇，低置信度人工确认）
  → 确认后写入 SQLite（包含最终本地绝对播放路径）
  → 后台资料快照与独立图片库（原图、展示尺寸、资源版本）
  → 已发布海报墙 / 详情 / 本地路径直播放（MPV，进度与观看状态）
  → Bangumi 同步与新番追更（增量更新）
```

## 容易错过的功能

### 重复启动与系统托盘

再次打开快捷方式会显示并唤起已有窗口，不另启动后端。关闭后立即重开时，应用先完成旧后端清理，再恢复窗口与后端。

“设置 → 应用 → 窗口与托盘”分别提供“最小化到托盘”和“关闭窗口时收到托盘”，默认均关闭，也可点击“立即收到托盘”。收到托盘后播放与后台任务继续运行；点击托盘图标或菜单“显示 KumiPlayer”恢复窗口，菜单“退出”彻底关闭应用。窗口偏好由桌面壳单独保存到本机数据目录的 `window-preferences.json`。“应用”分类也集中管理界面连接监测；主题与作品墙布局归属“外观”，播放器设置归属“播放”。

### 拖入目录树快速导入

除作品详情和设置界面外，可在 KumiPlayer 任意页面拖入单个 TXT 目录树。应用会把它送入“媒体管理 → 扫描来源 → 识别预览 → 确认 revision”流程；原始 TXT 只为复制到本地打开一次，不会被写回或改名；解析、归档和后台恢复消费本地副本，原位置只用于读取与显示。

### 本地路径与 OpenList 网盘路径导入

本地路径和目录树 TXT 都先扫描为 SourceEvidence，再生成可审核的 MediaGraph 预览；确认后创建可恢复的 V4 jobs，完成 SQLite 资料补充、独立图片准备与 Library Projection 发布。OpenList 负责远端目录浏览与来源定位，导入仍进入同一条 revision 链。

导入默认选择“已完结”，持续更新的动漫或电视剧可选择“新番”，并使用与已完结来源互不包含的独立文件夹。新番按正片季度处理，辅助视频仍排除；一两集也不会推成电影。新番分类的“刷新”复用本地扫描或 OpenList 增量扫描，纯 TXT 来源提示选择新导出的清单。已有已确认且资料齐全的作品、已知季度和无歧义集号才能自动追加并刮削，其他变化回到媒体管理检查预览；无变化不重复创建执行作业。启动更新、定时更新与分类名称在现有设置中管理，自动更新默认关闭；来源用途与观看状态分别保存。

- 可以离开媒体管理页面；返回时会恢复批次状态。
- 识别问题会保留在预览中供人工确认；追更的未知作品、季度或编号不自动发布。
- OpenList 是网盘连接与远端路径入口，与 115 / 百度目录树 TXT 共用同一套 SourceEvidence 合同。

### 作品详情与多版本

作品详情页读取后台发布的详情与版本；图片只读取独立本地缓存。季度编号、集号和版本关系由后端 MediaGraph 决定，前端不再自行合卡或重写编号；同一集的不同清晰度、压制组或来源会作为多个 Asset 保留。用户可以选择 Asset 播放、标记本地观看状态或打开可访问的来源目录。

### MPV 截图

- `F10`：无字幕、无顶部提示的纯净截图。
- `Alt+F10`：带字幕截图，并显示 MPV 原生截图路径提示。

截图自动保存到：

```text
桌面\动漫截图\作品名 - SxxExx - 剧集标题\HH-MM-SS.mmm.jpg
```

截图按刮削后的作品和剧集标题分目录，文件名是视频内精确到毫秒的时间，不添加 `_01` 序号。

更多操作见 [用户功能指南](docs/USER_GUIDE.md)。

## 快速开始

### 开发版 EXE

运行：

```text
release\KumiPlayer.exe
```

以下文件必须相邻：

```text
release\KumiPlayer.exe
release\WebView2Loader.dll
```

开发版会使用当前项目的 `backend/`、`data/`、`dist/` 和 `mpv/runtime/`，本机需要可用的 Python 后端环境。

### 普通用户安装版

运行安装包：

```text
release\KumiPlayer-Setup.exe
```

安装包包含冻结后的 Python 后端和桌面程序。用户无需安装 Python、Node.js 或 Rust；首次安装建议联网，以便系统缺少 WebView2 时下载微软官方运行时。

> **内置播放器与分发状态**：KumiPlayer 的播放器有两套来源，用户任选其一。**内置播放器**是项目文件夹里自带的那套干净 MPV（27 个运行文件）与 KumiPlayer 自有配置，计划随应用分发，不读取、不改写用户全局 MPV 配置。**外部整合包**是让用户自己指定播放路径：选择一个本机已有的 MPV 整合包目录或可执行文件，KumiPlayer 只驱动它、不改写它的配置与脚本，也**不随包分发**它。目前内置播放器的第三方许可证与发布材料尚未完成，**正式安装包构建会中止**；现有入口不会自动生成不含内置 MPV 的安装包。合规材料补齐并完成发布复核后，安装版才可携带内置播放器。

## 运行环境与本地配置

项目精简使用 `scripts/cleanup_workspace.ps1`，默认只列出历史测试副本、运行记录和可重建缓存。执行 `powershell -File scripts/cleanup_workspace.ps1 -Apply` 才删除所列内容；增加 `-ResetUserData` 会同时清空项目内媒体库、海报、导入记录、个人配置和 `.env`。脚本保护已跟踪文件、源码、当前测试、Git、依赖和 MPV；运行中的应用必须先正常关闭。Windows 凭据管理器不在文件清理范围内。空库首次启动仿真可运行 `uv run --project backend python -m pytest backend/tests/test_fresh_user_startup.py`，使用隔离数据目录且不读取系统凭据。

- 支持 Windows 10 / 11；普通用户使用完整安装包时，无需另外配置开发环境。
- 源码开发需要 Node.js 22、Python 3.12、Rust stable；播放器使用项目内置的干净 MPV，不读取或改写用户全局 MPV 配置。
- 个人配置仅保存在本机。源码版默认使用项目 `data/`，安装版默认使用 `%LOCALAPPDATA%\KumiPlayer\data`。
- 主题、媒体目录等非敏感设置保存在 `config.json`；TMDB、Bangumi 等凭据保存在 Windows Credential Manager，不再以明文写入配置文件。
- 旧版 `config.json` 中的明文凭据会在读取时自动迁移；只有系统凭据写入成功后才清空旧值，避免迁移失败造成数据丢失。
- 凭据不会显示在公开界面、脱敏诊断或错误信息中；不要把真实 Token 写入公开问题报告。

## 启动失败时的恢复

如果桌面安全会话初始化失败、React 页面崩溃或本地后端未能就绪，KumiPlayer 会显示恢复界面，而不是留下空白窗口。可以直接：

- 重新加载应用。
- 重启 KumiPlayer 本地后端。
- 打开日志目录。
- 导出已脱敏的诊断文本。

正常退出时，Tauri 会终止自己启动的后端进程；Windows Job Object 和心跳超时是额外兜底，避免后端长期残留。

## 首次启动

首次启动包含四步：

1. 查看运行方式和数据保护说明。
2. 自动检测 KumiPlayer 内置播放器，确认版本与完整性。
3. 选择媒体来源；网盘来源配置本地挂载路径。
4. 可选填写 TMDB API 读取访问令牌和 Bangumi 个人 Access Token。

TMDB 需要的是“API 读取访问令牌”，不是 32 位 API Key。以后可在“设置 → 应用与支持”重新打开引导，取消不会覆盖已有配置。

## 日常使用路径

### 建立媒体库

进入“媒体管理”：

```text
本地目录 / TXT：媒体管理 → 扫描来源 → 生成识别预览 → 确认 revision
确认后：confirmed revision → SQLite 资料快照 / 独立图片准备 → 已发布卡片与详情
```

- TXT 和本地扫描都使用同一个 SourceEvidence → ParsedFacts → MediaGraph 流程。
- 季度或集数不明确的项目会生成 review issue，必须在确认前处理。
- confirmed revision 只产生 V4 jobs；任务输入固定为 revision/work/asset 身份，不会重新识别来源。
- 目录树 TXT 与 OpenList 清单导入保存最终本地绝对播放路径。TXT 映射不确定时可选检查少量目录和文件元数据，不读取源视频、NFO、缩略图，不递归扫描挂载盘；已确认映射与后台恢复不重复探测。在线资料保存快照，图片来源交由独立后台准备。
- 自动刮削只按 Work 去重，并通过 provider mapping 保存外部 ID，不覆盖本地季度和集号。

### 播放和观看状态

- 详情页播放按钮把选定 Asset 的 playback locator 交给播放器；进度按 Episode + Asset 保存。
- 可以收藏作品、手动修改单集已看状态。
- 播放历史进入“最近观看”，收藏进入“我的收藏”。
- Bangumi 当前只负责账号会话、登录验证、用户信息和作品搜索，不参与本地 Work/Episode 身份写入。

## 数据安全

| 模式 | 数据目录 | 图片库与派生缓存 |
|---|---|---|
| 源码 / 开发 EXE | `<项目>\data` | `artwork/` 与 `cache/artwork_variants/` |
| 安装版 | `%LOCALAPPDATA%\KumiPlayer\data` | `artwork/` 与 `cache/artwork_variants/` |

KumiPlayer 不会主动移动或重命名真实媒体。构建、安装和升级不得覆盖现有 `data/`、镜像、NFO、图片、播放记录、快照或 Token。删除和清理功能必须先预览，再确认实际影响范围。

## 系统架构

KumiPlayer 是三层桌面应用，职责严格分离：

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

## 构建

### 新电脑的构建环境

下面这些工具用于从源码制作程序与安装包，**普通用户运行已生成的安装包无需安装它们**。

| 依赖 | 要求与用途 |
|---|---|
| Git | 源码版本管理；从网盘恢复时保留 `.git`，不要覆盖已有修改 |
| Node.js + npm | 推荐 Node.js 22，至少 22.12；构建 React 前端与运行 Tauri CLI |
| Python | Python 3.12，安装时启用 Add to PATH；Windows 商店的 `python` 占位入口不可用于构建 |
| uv | 按 `backend/uv.lock` 恢复项目 Python 环境 |
| PyInstaller | 安装包后端冻结工具，由 `installer` extra 锁定安装，不能只安装后端业务依赖 |
| Rust | stable，当前 Windows 构建使用 `x86_64-pc-windows-gnu` 工具链，包含 cargo / rustc |
| GCC / MinGW-w64 | 完整的 Windows GNU 编译器与库，例如 WinLibs POSIX/UCRT；将其 `mingw64/bin` 加入 PATH。只有 LLVM-MinGW 不足以提供当前 Rust 所需的 `libgcc` / `libgcc_eh` |
| 内置 MPV 文件 | 保留 `mpv/runtime`、配置与运行时清单；仅下载 Git 源码不会包含被忽略的播放器二进制 |

官方入口：[Python](https://www.python.org/downloads/windows/)、[Node.js](https://nodejs.org/)、[uv](https://docs.astral.sh/uv/getting-started/installation/)、[Rust](https://rust-lang.github.io/rustup/installation/)、[WinLibs](https://winlibs.com/)。NSIS 打包工具由 Tauri 构建流程下载；最终安装缺少 WebView2 时，安装包会下载微软官方运行时。

安装工具后重新打开终端，再在项目根目录执行：

```powershell
uv sync --project backend --locked --extra dev --extra installer --python 3.12
npm ci
```

从网盘备份恢复的 `backend/.venv` 不能直接当作新电脑的可用环境；它可能指向旧电脑的 Python。先将旧环境移到备份位置，再执行上面的恢复命令。`.cargo/config.toml` 中的旧电脑绝对编译器路径也必须改为本机可用的编译器；当前配置可通过 PATH 解析 `x86_64-w64-mingw32-gcc.exe`。不要删除 `data`、个人配置或 MPV 源文件来解决构建环境问题。

本次恢复使用 Python 3.12.10、Node.js 22.23.3 / npm 10.9.9、uv 0.13.0、Rust 1.99.0 GNU、WinLibs GCC 16.2.0 POSIX/UCRT 和 PyInstaller 6.22.3；这是本机恢复记录，不要求所有用户逐项固定到这些补丁版本。

### 标准构建入口

开发 EXE：

```bat
build_tauri.bat
```

完整安装包：

```bat
build_installer.bat
```

当前双击默认构建仅供本机安装自测的完整包，包含内置 MPV，安装内容附带 `LOCAL_TEST_ONLY.txt`；这不代表公开发布审核已完成。公开发布使用 `build_installer.bat --public-release`，仍须通过对应源码与许可证材料检查。后端打包依赖使用 `uv sync --project backend --locked --extra dev --extra installer --python 3.12` 恢复，入口自动激活项目环境。

两种构建都会检查 `37821` 端口和 KumiPlayer 运行状态。开发 EXE 构建执行 TypeScript、Vite、Rust/Tauri 和桌面产物验证；安装包额外检查冻结后端、内置 MPV 运行时、许可证发布门，以及 NSIS 内容。

## 验证

```bash
npm test
npm run build
npm run check:versions
uv sync --project backend --locked --extra dev
uv run --project backend python -m pytest backend/tests

cd src-tauri
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

## 文档

现行文档（以当前源码为事实来源）：

- [用户功能指南](docs/USER_GUIDE.md)
- [现行架构](docs/PROJECT.md)
- [项目目录结构](docs/PROJECT_STRUCTURE.md)
- [长期项目记忆](docs/PROJECT_MEMORY.md)
- [配置与数据目录](docs/01_项目基准/KumiPlayer_配置与数据目录.md)
- [视觉风格与主题规范](docs/01_项目基准/KumiPlayer_视觉风格与主题规范_2026-07-08.md)
- [UI 组件接入与性能策略](docs/01_项目基准/KumiPlayer_UI组件接入与性能策略_2026-07-09.md)
- [视频文件命名与识别边界](docs/01_项目基准/视频文件命名与目录组织模式.md)
- [115 目录树解析说明](docs/01_项目基准/115目录树解析说明.md)
- [Windows 分发说明](docs/DISTRIBUTION.md)
- [第三方许可与声明](docs/THIRD_PARTY_NOTICES.md)

历史交接资料（V4 施工文档、本地规划 AI 施工文档、已完成的审核报告与实现计划）已于 2026-09-15 清理删除；`docs/90_历史归档/` 只保留明确标注的历史归档，不参与施工。

不要把真实 Token、Key、网盘路径或个人媒体目录写入公开文档、日志和问题报告。
