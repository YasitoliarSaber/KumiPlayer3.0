# 页面需求（重构前置输入）

> 记录日期：2026-10-14
> 事实来源：`src/App.tsx`、`src/stores/ui.ts`、`src/pages/`、`src/components/`、`src/api/`、`backend/app/api/`
> 定位：回答「新前端需要哪些页面、每个页面要展示什么数据、要支持什么操作」。**不回答页面长什么样**：布局、信息层级、视觉风格、组件形态交由后续 OpenDesign 决定，本文件一个像素都不描述。

## 1. 使用方式

- 本文件只列**已被后端真实支持**的能力。任何在此出现的「需要展示的数据」都能在后端接口或 SQLite 投影中取到；数据来源标注以 `docs/current/api-reference.md`、`docs/current/data-model.md` 为准。
- 第 7 节列出**当前不存在、新前端不得凭空新增**的页面与功能，用于防止设计稿引入后端无法支撑的能力。
- 「现状实现」列只用于说明该需求今天的落点，**不是新前端要继承的结构**。

## 2. 全局外壳需求（不属于任何单个页面）

| 需求 | 需要的数据 / 能力 | 现状实现 |
|---|---|---|
| 页面导航 | 7 个主页面枚举：`home` / `favorites` / `recent` / `category` / `detail` / `manage` / `settings`；`search` 不是独立枚举，由搜索词非空时覆盖当前页 | `src/stores/ui.ts:4`、`src/App.tsx:221-240` |
| 前进 / 后退 | 页面历史栈 | `src/stores/ui.ts` 页面历史动作；`src/components/shell/DesktopTitleBar.tsx` |
| 全局搜索入口 | 搜索词状态；词非空即切换到搜索结果 | `src/App.tsx:240` |
| 窗口控制 | Tauri 窗口最小化 / 最大化 / 关闭 | `src/components/shell/DesktopTitleBar.tsx`（210 行） |
| 侧边栏入口 | 主页面入口 + 侧边栏显示模式（hidden / compact / expanded） | `src/components/shell/Sidebar.tsx`（231 行）、`src/stores/ui.ts:13` |
| 后端连接状态 | 健康轮询 + WebSocket 心跳 + 重连刷新 | `src/stores/connection.ts`（69 行）、`src/api/heartbeat.ts` |
| 启动占位 | 配置未就绪时的启动画面，配置就绪后移除引导 splash | `src/components/shell/StartupSplash.tsx`、`src/App.tsx:99-102` |
| 统一恢复页 | 后端启动失败或 React 未捕获异常时的重新加载 / 重启后端 / 打开日志 / 导出脱敏诊断 | `src/components/errors/`、`src/styles/recovery.css` |
| 主题与动效偏好 | appearance（fluent / cinema / mica）、style（gallery）、motion（reduced / standard / expressive） | `src/stores/ui.ts:7-9`、`src/design/fluentTheme.ts` |
| 拖入目录树 TXT | 桌面文件拖放事件 → 进入导入页并带上该路径 | `src/App.tsx:105-124`、`src/platform/fileDrop.ts` |
| 界面连接监测（应用设置） | 后端心跳、健康与重启 | `docs/PROJECT.md` 第 8 节；设置页 `application` 分类 |

## 3. 页面清单总表

| # | 页面 | 目的（一句话） | 现状组件 | 行数 |
|---|---|---|---|---|
| 1 | 首次引导 | 完成一次最小可用配置后进入软件 | `src/pages/FirstRunSetup.tsx` | 419 |
| 2 | 首页 | 浏览媒体库预览与推荐橱窗 | `src/pages/HomePage.tsx` | 354 |
| 3 | 分类 / 新番 | 按分类、来源与排序浏览海报墙，并触发新番导入 | `src/pages/CategoryPage.tsx` | 251 |
| 4 | 搜索 | 以关键词查找作品 | `src/pages/SearchPage.tsx` | 71 |
| 5 | 收藏 | 浏览已收藏作品 | `src/pages/FavoritesPage.tsx` | 69 |
| 6 | 最近观看 | 继续播放与查看播放历史 | `src/pages/RecentPage.tsx` | 163 |
| 7 | 作品详情 | 查看作品信息、季集与全部管理操作，并进入播放 | `src/pages/WorkDetailPage.tsx` | 2357 |
| 8 | 媒体管理 | 导入媒体、查看识别预览、确认 revision、跟踪任务与执行维护 | `src/pages/MediaManagementPage.tsx` | 2137 |
| 9 | 设置 | 七个分类的应用与凭据配置 | `src/pages/SettingsPage.tsx` | 935 |
| 10 | 播放调校 | 调节内置 MPV 与 Anime4K 参数 | `src/pages/PlayerTuningPage.tsx`（以嵌入方式出现在设置页播放分类内，`src/pages/SettingsPage.tsx:662`） | 269 |

10 个页面组件合计 7025 行；其中详情页与媒体管理页合计 4494 行，占 64%。

## 4. 逐页需求

### 4.1 首次引导（FirstRunSetup）

- **目的**：在一台新机器上完成「能用」所需的最小配置，并允许用户跳过。
- **需要展示**：当前配置快照（含 `setup_completed` / `setup_deferred`）、各配置项的当前值与是否已具备、MPV 运行时状态。
- **需要支持的操作**：保存配置；跳过（写入「稍后设置」并进入软件）；从设置页重新进入（`mode="reconfigure"`）。
- **状态语义**：未完成且未跳过的引导会覆盖主界面；用户在引导中点击任意导航或开始搜索即视为跳过，并异步通知后端。
- **依据**：`src/pages/FirstRunSetup.tsx`；`src/App.tsx:52-56`（`showSetup` 判定）、`src/App.tsx:165-170`（`mode` 传参）。

### 4.2 首页（HomePage）

- **目的**：作为进入软件后的落地页，展示媒体库预览与推荐橱窗。
- **需要展示**：媒体库预览卡片；推荐橱窗内容；空库与未发布状态下的占位表现。
- **需要支持的操作**：打开作品详情；跳转分类 / 继续浏览。
- **约束**：首页只消费已发布的媒体库投影；后台尚未发布时不应显示半成品卡片。
- **依据**：`src/pages/HomePage.tsx`；`docs/PROJECT.md` 第 7 节（发布门槛）、第 8 节。

### 4.3 分类 / 新番（CategoryPage）

- **目的**：按分类浏览海报墙，并作为新番（持续更新）内容的主入口。
- **需要展示**：
  - 分类维度：`anime_series` / `anime_movie` / `live_series` / `live_movie` / `seasonal`（`src/stores/ui.ts:5-6`）。
  - 来源筛选：all / pan115 / baidu / quark / local / openlist（`src/stores/ui.ts:11`）。
  - 排序：recent / title / titleDesc / rating / year / episodes 等 11 种（`src/stores/ui.ts:10`）。
  - 卡片密度与卡片图模式（poster / fanart，`src/stores/ui.ts:8,12`）。
  - 每个分类与来源的持久状态（作品数、待确认数等轻量摘要）。
- **需要支持的操作**：切换分类 / 来源 / 排序；调整卡片密度；打开详情；刷新分类状态；发起新番导入；接收被拖入的目录树 TXT 并转入导入流程。
- **约束**：进入或轮询分类页只读取轻量持久状态，**不得触发来源扫描或读取凭据**（`docs/PROJECT.md` 第 6 节）。
- **依据**：`src/pages/CategoryPage.tsx`、`src/components/library/VirtualizedPosterGrid.tsx`（291 行）、`src/components/library/PosterCard.tsx`。

### 4.4 搜索（SearchPage）

- **目的**：按关键词查找作品。
- **需要展示**：命中的作品卡片；无结果状态；搜索进行中状态。
- **需要支持的操作**：输入关键词（触发页面覆盖）、清空关键词回到原页面、打开详情。
- **依据**：`src/pages/SearchPage.tsx`、`src/App.tsx:240`。

### 4.5 收藏（FavoritesPage）

- **目的**：浏览用户已收藏的作品。
- **需要展示**：收藏作品卡片；空收藏状态。
- **需要支持的操作**：打开详情；取消收藏。
- **依据**：`src/pages/FavoritesPage.tsx`；`src/stores/library.ts`（收藏状态）。

### 4.6 最近观看（RecentPage）

- **目的**：继续播放，并查看播放历史。
- **需要展示**：播放历史条目（作品、剧集、进度、最近时间）；「继续进入」入口。
- **需要支持的操作**：从历史条目继续播放；打开作品详情；清理历史（若后端支持，以接口为准）。
- **依据**：`src/pages/RecentPage.tsx`、`src/pages/RecentPage.css`、`src/api/playback.ts`。

### 4.7 作品详情（WorkDetailPage）

功能面最广的页面，需求按能力块拆分。

| 能力块 | 需要展示的数据 | 需要支持的操作 |
|---|---|---|
| 基础信息 | 标题、原始标题、年份、类型、评分、简介、海报与背景图、来源与导入方式 | 播放（作品级入口） |
| 季与集 | 季度列表、每季剧集列表、集号与标题、每集是否有可用播放路径、观看状态 | 选择剧集播放、切换季度、跳转到某集 |
| 播放进度 | 上次观看位置与已看状态 | 继续播放、标记已看 / 未看 |
| 手动纠错（用户数据） | 当前生效的手动标题、手动封面、收藏状态 | 修改标题、上传 / 更换封面、恢复为在线资料、切换收藏 |
| 刮削 | 匹配候选列表（含各候选的标题、年份、来源、评分）、当前绑定、快照更新时间 | 手动搜索候选、确认绑定、刷新资料 |
| Bangumi 集成 | 账号状态、匹配结果、收藏类型、同步进度 | 匹配、收藏、同步进度 |
| 关联作品 | 演员、相关推荐（若已发布） | 跳转相关作品 |
| 管理操作 | 删除预览（将退役哪些受控记录、共享图片与用户覆盖如何处理） | 预览删除、确认删除（源媒体永不删除）、打开视频文件夹（按作品 / 剧集 / 可选 Asset 身份） |
| 追加剧集 | — | **当前不可用**：能力开关 `appendEpisodes: false`，入口隐藏，后端无对应路由 |

- **依据**：`src/pages/WorkDetailPage.tsx`；`src/components/detail/WorkCustomizationTags.tsx`（303 行）、`src/components/media/DetailSeasonPicker.tsx`；`src/api/workDetailV4Compatibility.ts:5-9`（能力开关）、`src/api/workCustomization.ts`、`src/api/bangumi.ts`、`docs/PROJECT.md` 第 6 节。
- **约束**：手动标题、手动封面、收藏与观看状态属于用户数据，任何重扫、增量更新与资料刷新都不得覆盖（`docs/current/refactor-baseline.md`）。

### 4.8 媒体管理（MediaManagementPage）

三个页面模式共存于同一组件：`overview`（媒体库）/ `import`（导入媒体）/ `maintenance`（媒体库维护）——`src/pages/MediaManagementPage.tsx:1536-1538`。

#### 4.8.1 总览模式

- **需要展示**：已导入来源卡列表（每个来源的名称、内容来源与导入方式、范围、范围用途、健康状态、作品数 / 待确认数、最近扫描时间）；空库状态。
- **需要支持的操作**：新建导入；进入某个来源继续处理；移除来源（需明确确认，且只退役 SQLite 记录）；进入维护模式。

#### 4.8.2 导入模式（四入口）

| 入口 | 需要用户提供 | 导入后得到 |
|---|---|---|
| 本地目录 | 本地根目录（最多 24 条已登记来源，单次导入对应一个来源根） | 扫描结果与识别预览 |
| 目录树 TXT（115 / 百度） | 一次导出得到的 TXT 文件（原位置导出合同） | 目录结构与播放路径定位 |
| OpenList 远端路径 | 连接、远端根目录与内容路由 | 远端目录扫描 |
| TXT + OpenList 混合 | 两者都提供 | 以 TXT 为条目来源、OpenList 为可达性来源 |

- **流程阶段**：选择来源 → 扫描中（进度与日志）→ 识别预览（草稿 revision：作品、季集、无法定级项、冲突项）→ 确认导入（原子提交）→ 执行中（作业与图片准备）→ 结果摘要与失败项。
- **需要展示**：扫描进度、来源证据摘要、识别统计（可导入 / 待处理 / 排除）、每个待处理项的原因、草稿 revision 明细、确认后的作业与图片准备进度、失败与可重试项。
- **需要支持的操作**：开始 / 重新开始导入、查看进度与上次导入、对草稿做人工覆盖（ResolverOverride，不修改解析事实）、确认导入、取消任务、重试失败项、离开页面后从来源卡恢复继续。
- **约束**：未确认的 revision 不得进入资料处理或正式展示；低置信度、冲突与路径不可达必须先处理；离线、超时、无样本不得冒充验证成功（`docs/current/media-pipeline.md`）。
- **依据**：`src/pages/MediaManagementPage.tsx`、`src/components/media/V4RecognitionSummary.tsx`（316 行）、`src/components/media/V4ExecutionProgress.tsx`（622 行）、`src/components/media/OpenListFolderBrowser.tsx`、`src/api/mediaV4.ts`（787 行）。

#### 4.8.3 维护模式

- **需要展示**：媒体库规模与持久摘要（作品 / 季 / 集 / 图片 / 任务）、可执行的维护动作及其影响范围。
- **需要支持的操作**：触发受控维护动作（以 `/api/v4` 维护类端点为准）、查看诊断摘要。
- **约束**：诊断只读持久摘要，不触发重建；维护动作不得删除源媒体。
- **依据**：`src/components/media/LibraryMaintenancePanel.tsx`（253 行）、`docs/PROJECT.md` 第 7 节。

### 4.9 设置（SettingsPage）

七个分类，需求见下表。

| 分类 | 需要展示 | 需要支持的操作 |
|---|---|---|
| `application` 应用 | 窗口与托盘行为、界面连接监测状态、后端运行身份（source / bundled） | 修改应用级开关、重启后端、打开日志、导出脱敏诊断 |
| `appearance` 外观 | 主题模式、风格、动效、海报墙外观与卡片密度 | 修改外观偏好（持久化到本机 UiStore 与配置） |
| `sources` 媒体来源 | 已登记本地根目录（最多 24 条，名称上限 24 码点）、内容范围（已完结 / 新番）、启动更新与定时更新开关与间隔（关闭或 15–10080 分钟） | 增删改本地根、设置名称与内容范围、配置更新策略 |
| `openlist` OpenList | 连接配置与测试、远端根目录、内容路由（来源与路径映射） | 新建 / 测试连接、编辑路由、浏览远端目录 |
| `scrape` 刮削 | TMDB（及 AniList）凭据状态、连接测试、图片检测与修复入口 | 保存凭据、测试连接、执行图片诊断与恢复 |
| `player` 播放器 | 内置 MPV 运行时状态、MPV 参数、Anime4K 参数 | 调节参数、保存、运行播放器测试（`PlayerTuningPage` 以 embedded 方式嵌入） |
| `bangumi` Bangumi | 账号登录状态、当前用户、同步偏好 | 登录 / 退出、刷新会话、配置同步 |

- **依据**：`src/pages/SettingsPage.tsx`、`src/components/settings/OpenListSettingsPanel.tsx`（457 行）、`src/components/settings/OpenListSourceRoutes.tsx`、`src/components/settings/PosterWallSettingsPanel.tsx`、`src/components/settings/TmdbImageConnectionPanel.tsx`、`src/api/config.ts`、`src/api/localRoots.ts`、`src/api/openlist.ts`、`src/api/bangumi.ts`。
- **约束**：凭据（TMDB / Bangumi / OpenList 密码）存 Windows Credential Manager，不进 `config.json`，也不得在界面回显明文（`docs/current/system-overview.md` 第 5、6 节）。

### 4.10 播放调校（PlayerTuningPage）

- **目的**：在不离开设置的前提下调节内置 MPV 与 Anime4K 参数并验证。
- **需要展示**：当前配置值、MPV 运行时状态、外部占用状态（播放中时不并发调节）。
- **需要支持的操作**：修改参数、保存配置、运行播放器测试；参数改动对之后播放的新视频生效。
- **依据**：`src/pages/PlayerTuningPage.tsx`、`src/pages/SettingsPage.tsx:662`、`docs/PROJECT.md` 第 12 节。

## 5. 跨页面能力（所有页面共享的需求）

| 能力 | 需求描述 | 依据 |
|---|---|---|
| 媒体库增量同步 | 每 5 秒（窗口不可见 30 秒，后台任务进行中 1 秒）读取有界 changes 游标，只刷新受影响卡片与当前详情；游标过期或显式 reset 才全量同步；失败不推进游标 | `src/App.tsx:126-176`、`src/stores/library.ts`、`src/api/library.ts` |
| 图片就绪门槛 | 卡片与详情仅在必需图片（海报、背景、当前正片每集预览）本地尺寸齐备后发布；缺图不得显示占位卡入墙 | `docs/PROJECT.md` 第 7 节 |
| 图片请求预算 | 前端并发图片请求 6、预取 2；可见优先、邻近驻留、失败冷却；分类页仅加载本地图片 | `docs/PROJECT.md` 第 8 节 |
| 长任务模型 | 长任务属于后端 TaskRecord；关闭弹窗或切换页面不取消任务，可离开后恢复 | `docs/PROJECT.md` 第 8 节、`src/api/tasks.ts` |
| 会话与鉴权 | 每个业务请求携带桌面壳生成的会话 Token；前端必须先从桌面壳取得 Token 再渲染与请求 | `src/api/client.ts:6-31`、`src/api/sessionToken.ts`、`src/api/desktopSession.ts` |
| 错误呈现 | 用户可见错误需要可读文案，技术细节（SQLite、traceback、HTTP 状态）不直接暴露给用户 | `src/pages/MediaManagementPage.tsx:114`（技术信息过滤）、`src/components/errors/` |

## 6. 数据量级与交互约束（设计输入）

| 约束 | 内容 | 依据 |
|---|---|---|
| 海报墙规模 | 媒体库卡片数量可达成百上千，列表必须支持虚拟化与只渲染可见卡片 | `src/components/library/VirtualizedPosterGrid.tsx`、`src/stores/library.ts` |
| 图片解码 | 分类页使用浏览器异步解码，不经过显式解码与状态更新流程 | `docs/PROJECT.md` 第 8 节 |
| 滚动 | 主滚动容器保持 WebView 原生滚动，不拦截滚轮、不在主线程补间位置 | `docs/PROJECT.md` 第 8 节 |
| 剧集横向拖动 | 拖动直接更新滚动容器位置，不把每步写入 React state | `docs/PROJECT.md` 第 8 节 |
| 右键菜单 | 空白处与海报默认菜单被禁用；输入框与可编辑区域保留系统编辑菜单 | `docs/PROJECT.md` 第 8 节 |
| 页面级懒加载 | 详情、设置、媒体管理、首次引导为懒加载页面 | `src/App.tsx:21-24` |

## 7. 不存在的能力（新前端不得新增）

以下内容在当前后端与数据模型中**没有**对应实现；新前端不得出现入口或交互。

| 不存在的能力 | 证据 |
|---|---|
| 手工追加剧集 | `src/api/workDetailV4Compatibility.ts:9` `appendEpisodes: false`；调用返回「追加剧集尚未接入 V4 数据流」，后端无对应路由 |
| 镜像 / STRM / NFO 作为运行依赖 | `docs/PROJECT.md` 第 1、5 节；旧镜像只供显式预览的历史维护 |
| 旧远程图片代理与请求现场缩图 | 已退役；普通展示只接受带内容版本的本地 artwork URL |
| URL 路由与浏览器前进后退语义 | `src/App.tsx:240`：前端不是 URL Router 应用，页面由状态驱动 |
| 用户账号体系与多用户 | 单机单用户桌面应用，无登录页 |
| 网盘在线播放 | 播放只接受已保存本地绝对媒体路径，网盘经本地挂载 |
| 内置字幕 / 弹幕 / 转码功能页 | 已核实不存在：`src/` 与 `backend/app/` 中检索 `danmaku` / `弹幕` 均无命中（2026-10-14 实测），`subtitle` 命中项全部是海报卡片与设置项副标题的 CSS 类名，与字幕功能无关 |
