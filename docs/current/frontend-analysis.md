# 前端现状分析（重构前置）

> 适用范围：现有系统的事实快照；不作为 3.0 的页面、组件、视觉或架构约束。源码及用户最新指令优先。

> 记录日期：2026-10-14
> 事实来源：`package.json`、`vite.config.ts`、`tsconfig.json`、`src/`、`src-tauri/Cargo.toml`、`tests/`
> 定位：记录当前前端（React 19 + Fluent UI + Zustand）的技术栈、真实结构、调用方式与可确认的技术债，作为重构起点。不设计新界面、不推荐组件库、不评价视觉方案；页面能力范围见 `docs/current/feature-list.md`，后端事实见 `docs/current/system-overview.md`。

## 1. 技术栈与版本

来源：`package.json`、`src-tauri/Cargo.toml`。

| 类别 | 依赖 | 版本 | 证据 |
|---|---|---|---|
| UI 框架 | react / react-dom | ^19.2.7 | `package.json:21`、`package.json:22` |
| 组件库 | @fluentui/react-components | ^9.74.3 | `package.json:16` |
| 图标 | lucide-react | ^1.21.0 | `package.json:20` |
| 虚拟化 | @tanstack/react-virtual | ^3.14.13 | `package.json:17` |
| 状态 | zustand | ^5.0.14 | `package.json:23` |
| 桌面桥 | @tauri-apps/api / @tauri-apps/plugin-dialog | ^2.5.0 / ^2.7.1 | `package.json:18`、`package.json:19` |
| 桌面壳 | tauri (Rust) | `version = "2"`，features `tray-icon` | `src-tauri/Cargo.toml:16` |
| 构建 | vite | ^8.1.0 | `package.json:37` |
| 插件 | @vitejs/plugin-react ^6.0.2、@tailwindcss/vite ^4.3.1 | — | `package.json:33`、`package.json:26` |
| 样式 | tailwindcss | ^4.3.1 | `package.json:35` |
| 语言 | typescript | ~6.0.2 | `package.json:36` |
| 测试 | vitest ^4.1.10、jsdom ^29.1.1、@testing-library/react ^16.3.2 | — | `package.json:38`、`package.json:34`、`package.json:29` |

- Tailwind 通过 Vite 插件接入，无独立 `tailwind.config` 文件；样式入口为 `src/index.css:1` 的 `@import "tailwindcss";`。
- 构建产物供给 Tauri：`vite.config.ts` 未覆盖 `build.outDir`，Tauri 侧指向 `../dist`（`vite.config.ts:43`–`44` 注释）。
- 开发代理把 `/api` 与 `/ws` 转发到 `127.0.0.1:37821`（`vite.config.ts:49`–`58`）。
- TypeScript 严格模式开启（`tsconfig.json:13`），但 `noUnusedLocals` 为 `false`（`tsconfig.json:14`）。

## 2. 应用结构与页面调度

### 2.1 真实页面状态机（非 URL Router）

前端不是 URL Router 应用，没有路由库依赖（`package.json` 的 dependencies 中无 router 包）。页面由 Zustand 单一状态字段驱动：

- 页面枚举：`src/stores/ui.ts:4`（`AppPage = 'home' | 'favorites' | 'recent' | 'category' | 'detail' | 'manage' | 'settings'`）。
- 渲染分派：`src/App.tsx:220` 起的 `switch (page)`，`case` 分支至 `src/App.tsx:237`。
- 搜索覆盖：`src/App.tsx:240`（`const visiblePage = query.trim() ? 'search' : page`），搜索词非空时覆盖当前页面，不改变 `page` 字段。
- 页面切换动画容器：`src/App.tsx:261`（`key={visiblePage}` 的 `.app-page-transition`）。
- 导航历史：`src/stores/ui.ts:162`（`navigate`）、`src/stores/ui.ts:249`（`goBack`）、`src/stores/ui.ts:262`（`goForward`）；历史上限 `MAX_NAVIGATION_HISTORY = 50`（`src/stores/ui.ts:57`）。
- 分类滚动位置恢复：`src/stores/ui.ts:18`、`src/stores/ui.ts:325`（`consumeCategoryScrollRestore` 读取后即清空）。

### 2.2 启动与配置门控

- 入口：`src/main.tsx:20`（`bootstrap`）先等 `initializeDesktopApiSession()`，再挂载 `RendererProvider` + `AppErrorBoundary` + `App`。
- 会话令牌获取：`src/api/desktopSession.ts:13`（Tauri `invoke('get_api_token')`），非 Tauri 环境回退到 `VITE_API_TOKEN`（`src/api/desktopSession.ts:9`）。
- 后端就绪等待：`src/api/backendReadiness.ts:3`（固定 `http://127.0.0.1:37821/api/config`）、`backendReadiness.ts:4`–`7`（120 次 × 250 ms，30 s 超时）。
- 配置门控：`src/App.tsx:53`（`showSetup`）、`src/App.tsx:54`（`mainAvailable`）；配置读取失败不阻断首页（`src/App.tsx:210`）。
- 主题属性写入：`src/App.tsx:85`–`87`（`data-style` / `data-motion` / `data-theme` 三个根属性）。
- 启动闪屏：`index.html` 内嵌 `#kumi-boot-splash` 与 `style[data-kumi-boot-styles]`；配置就绪后移除（`src/App.tsx:81`）。

### 2.3 桌面标题栏与侧边栏

| 部位 | 组件 | 职责 | 行数 |
|---|---|---|---|
| 外壳 | `src/components/shell/AppShell.tsx` | 骨架、侧栏宽度 CSS 变量、`.app-main` 滚动容器、可选滚动诊断采样 | 76 |
| 标题栏 | `src/components/shell/DesktopTitleBar.tsx` | 前进/后退、搜索框、来源筛选、刷新、窗口最小化/最大化/关闭、侧栏显隐 | 210 |
| 侧边栏 | `src/components/shell/Sidebar.tsx` | 主入口（首页/收藏/最近观看）+ 分类入口（新番/番剧/动画电影/剧集/电影）+ 媒体管理/设置、Bangumi 头像 | 231 |
| 闪屏 | `src/components/shell/StartupSplash.tsx` | 配置就绪前的占位 | 12 |
| 连接状态 | `src/stores/connection.ts` | 健康轮询（30 s）与心跳指示 | 69 |

- 侧栏导航项定义：`src/components/shell/Sidebar.tsx:25`（主入口）、`src/components/shell/Sidebar.tsx:31`（分类入口，`category: 'seasonal'` 等）。
- 侧栏三态：`hidden / compact / expanded`，宽度 0 / 56 / 276（`src/stores/ui.ts:24`–`28`）。
- 桌面标题栏来源下拉明确不含 OpenList（`src/components/shell/DesktopTitleBar.tsx:9`–`10` 注释），列表定义于 `src/components/shell/DesktopTitleBar.tsx:11`–`16`。
- 全局交互拦截：`src/platform/desktopInteractions.ts:2`（禁用空白处与海报的浏览器右键菜单）。

## 3. `src/pages/` 页面清单

| 文件 | 行数 | 职责 | 调度方式 |
|---|---|---|---|
| `WorkDetailPage.tsx` | 2357 | 海报/简介、主播放与继续播放、季度切换、剧集列表、手动刮削、Bangumi 面板、改标题、换图片、删除作品、额外视频标签 | 懒加载（`src/App.tsx:21`），`key={selectedWorkId}`（`src/App.tsx:230`） |
| `MediaManagementPage.tsx` | 2137 | 三视图状态机 `overview / import / maintenance`（`MediaManagementPage.tsx:50`）；四入口导入、识别预览、确认 revision、执行进度、来源卡、维护 | 懒加载（`src/App.tsx:23`） |
| `SettingsPage.tsx` | 935 | 七分类设置面板（`application/appearance/sources/openlist/scrape/player/bangumi`）；分类定义 `SettingsPage.tsx:41`、`SettingsPage.tsx:44` | 懒加载（`src/App.tsx:22`） |
| `FirstRunSetup.tsx` | 419 | 四步引导（欢迎/播放器/媒体来源/完成设置，`FirstRunSetup.tsx:19`），支持 `first-run` 与 `reconfigure` 两种模式 | 懒加载（`src/App.tsx:24`） |
| `HomePage.tsx` | 354 | 推荐橱窗（自动轮播 + 手动切换）、分类分区预览、空库引导 | 静态导入（`src/App.tsx:9`） |
| `PlayerTuningPage.tsx` | 269 | 播放器模式（内置/外部）、Anime4K 模式与质量；`embedded` 模式内嵌于设置 | 静态导入，仅由 `SettingsPage` 以 `embedded` 使用（`SettingsPage.tsx:662`） |
| `CategoryPage.tsx` | 251 | 分类海报墙、排序菜单、密度、来源筛选、新番更新状态与扫描触发 | 静态导入（`src/App.tsx:12`） |
| `RecentPage.tsx` | 163 | 继续播放入口（非历史日志），附 `RecentPage.css` | 静态导入（`src/App.tsx:11`） |
| `SearchPage.tsx` | 71 | 搜索词非空时的覆盖页面，前端文本匹配 + 历史加权排序 | 静态导入（`src/App.tsx:13`，由 `visiblePage` 判定） |
| `FavoritesPage.tsx` | 69 | 收藏作品海报墙，含导出函数 `selectFavoriteWorks`（`FavoritesPage.tsx:61`） | 静态导入（`src/App.tsx:10`） |

- 页面级懒加载只覆盖 4 个页面（`src/App.tsx:21`–`24`）；其余 5 个页面静态导入（`src/App.tsx:9`–`13`）。
- 页面组件行数合计约 4630 行；两个页面（详情、媒体管理）合计 4494 行，占页面总量约 97%。
- `RecentPage.css` 与组件同目录（162 行），是 `src/pages/` 下唯一的页面级 CSS 文件。

## 4. 组件结构 `src/components/`

按目录统计（含同目录 CSS 与说明文件）：

| 目录 | 文件数 | 关键文件与职责 |
|---|---|---|
| `shell/` | 4 | `AppShell.tsx`(76)、`DesktopTitleBar.tsx`(210)、`Sidebar.tsx`(231)、`StartupSplash.tsx`(12) |
| `library/` | 9 | `VirtualizedPosterGrid.tsx`(291) 海报墙虚拟化；`PosterCard.tsx`(162) 卡片；`PosterImage.tsx`(18)、`posterImageLifecycle.ts`(257) 图片生命周期与预算；`posterGridMetrics.ts`(79)、`posterPresentation.ts`(55)；`RecentWatchCard.tsx`(75) |
| `media/` | 9 | `V4ExecutionProgress.tsx`(622) 执行进度；`V4RecognitionSummary.tsx`(316) 识别摘要与修正；`LibraryMaintenancePanel.tsx`(253) 维护预览；`OpenListFolderBrowser.tsx`(176) 远端目录浏览；`DetailSeasonPicker.tsx`(125)；`SourceLibraryCard.tsx`(80) 来源卡；`MediaProviderIcon.tsx`(39) |
| `settings/` | 10 | `OpenListSettingsPanel.tsx`(457)、`PosterWallSettingsPanel.tsx`(175)、`OpenListSourceRoutes.tsx`(169)、`TmdbImageConnectionPanel.tsx`(120)、`OngoingUpdateSettingsPanel.tsx`(115)、`LocalRootsPanel.tsx`(95)、`WindowSettingsPanel.tsx`(73)、`FolderPathInput.tsx`(57)、`OpenListConnectionPicker.tsx`(21) |
| `detail/` | 2 | `WorkCustomizationTags.tsx`(303) 自定义标签与额外视频分类 |
| `ui/` | 5 | `SettingsPrimitives.tsx`(72) 共享设置组合（`SettingsSection`/`SettingsField`/`SettingsFeedback`）；`DecodedImage.tsx`(38)；`ActionToast.tsx`(37)；`loading-state.tsx`(21)；`README.md` 组合模板说明 |
| `errors/` | 2 | `RecoveryView.tsx`(89)、`AppErrorBoundary.tsx`(38) |

- 组件文件合计 41 个，其中 `.tsx` 26 个、`.css`/`.md` 15 个。
- 共享组合入口文档为 `src/components/ui/README.md`，它是当前唯一的组件复用约定文件。
- 关键共享组件：`VirtualizedPosterGrid`（分类/收藏/搜索三处复用）、`DecodedImage`（侧栏头像、设置、首页橱窗、详情）、`SettingsPrimitives`（设置页与播放调校）、`SourceLibraryCard`（来源卡）。

## 5. 状态管理 `src/stores/`

6 个 Zustand store，全部为 `create<T>()` 单例，无 Provider 依赖。

| Store | 行数 | 职责与关键 state | 关键 action | 持久化 |
|---|---|---|---|---|
| `ui.ts` | 380 | 页面、分类、`selectedWorkId`、`manageView`、`settingsSection`、导航历史、侧栏三态、搜索词、排序、来源、主题/外观/动效、分类名、详情标签预设、季度选择、`categoryScrollRestore` | `goHome`/`goCategory`/`goDetail`/`goManageView`/`goSettings*`、`goBack`/`goForward`、`toggleSidebar`、`setPosterWallLayout` | `persist`，键 `kumiplayer-ui`，`version: 4`（`src/stores/ui.ts:333`、`src/stores/ui.ts:335`）；`partialize` 只存偏好（`src/stores/ui.ts:350`–`364`） |
| `library.ts` | 513 | `works`、`history`、`loading`/`updating`/`backgroundActive`、`generationId`、`changeSequence`、`selectedWorkDetail` | `loadLibrary`、`syncChanges`、`openWorkDetail`、`getWorkDetail`/`refreshWork`/`invalidateWork`、`refreshHistory`、`updateWorkWatchStatus` | 无 `persist`；自管 localStorage 缓存（`library.ts:12`–`15`：键 `kumiplayer-library-cache-required-artwork-v5`、7 天、1.5 MB、500 部） |
| `bangumi.ts` | 202 | 会话视图（凭据状态、认证状态、连通性、时间戳、错误码）、`firstConnectionRevision` | `restoreSession`、`verifySession`、`setToken`、`clearToken` | 无；TTL 常量 `SESSION_VERIFY_TTL_MS = 6h`（`bangumi.ts:7`） |
| `connection.ts` | 69 | `backendOnline`、`heartbeatStatus`、`checking` | `checkHealth`、`startHeartbeat`/`stopHeartbeat`、`startHealthPolling`（30 s）/`stopHealthPolling` | 无 |
| `mediaWorkflow.ts` | 17 | `pendingDroppedTreePath`（拖放 TXT 的跨页交接） | `queueDroppedTreePath`、`consumeDroppedTreePath` | 无 |
| `openlistProbeSession.ts` | 11 | `paused`（本次运行内暂停自动探测） | `pause` | 无；另导出模块级 `Map`（`automaticProbeAttempts`、`automaticProbeFailures`）与间隔常量 20 s（`openlistProbeSession.ts:9`–`11`） |

- 模块级（非 store）可变状态集中在 `src/stores/library.ts:54`–`61`：`detailCache`、`detailRequests`、`detailVersions`、`changeRequest`、`pendingDetailRefreshId`、`detailNavigationRequest`、`libraryLoadRequest`、`libraryCacheGeneration`。
- 偏好落点分两处：本机 UI 偏好经 `persist` 写入 localStorage；其余配置（海报尺寸、卡片图模式、主题、分类名）同时由 `configApi.patchConfig` 写入后端 `data/config.json`（`src/App.tsx:200`–`208`、`src/pages/SettingsPage.tsx`）。
- 后端权威数据（媒体库、进度、追更）不进 store 持久化，只做内存缓存。

## 6. API 调用方式

### 6.1 请求封装

- 基础封装：`src/api/client.ts:38` 的 `requestJson<T>`。统一注入 `AbortController` 超时（默认 30 s）、`Content-Type: application/json`（`FormData` 除外）、非 JSON 响应判定为 502（`client.ts:68`）、`TypeError` 映射为 503（`client.ts:76`）、超时映射为 408（`client.ts:73`）。
- 方法集合：`src/api/client.ts:85` 的 `api.get/post/patch/put/delete/form`。
- 错误类型：`src/api/client.ts:11` 的 `ApiError`（携带 `status`），后端 `detail` 直接作为 message（`client.ts:60`）。
- 地址基准：`src/api/client.ts:7`–`9`：DEV 走 Vite 代理（`''`），生产直连 `http://127.0.0.1:37821`。

### 6.2 会话 Token 注入

- 令牌持有：`src/api/sessionToken.ts:1` 模块级变量；`apiSessionHeaders()` 返回 `X-KumiPlayer-Token`（`sessionToken.ts:11`）。
- 注入点：`src/api/client.ts:21` 的 `authorizedFetch` 在所有请求上合并会话头。
- 受限场景改用查询参数：`withApiSessionToken`（`sessionToken.ts:17`）被图片（`src/api/assets.ts:14`）、Bangumi 图片代理（`src/api/bangumi.ts:17`、`19`）、WebSocket（`src/api/heartbeat.ts:10`、`14`）使用。
- 令牌来源：Tauri command `get_api_token`（`src/api/desktopSession.ts:13`），失败即抛“桌面安全会话初始化失败”。

### 6.3 各 api 模块与后端前缀的对应关系

| 前端模块 | 行数 | 后端前缀 | 备注 |
|---|---|---|---|
| `client.ts` | 114 | — | 通用封装与 `API_BASE` |
| `library.ts` | 62 | `/api/library` | changes / cards / works/{id} / watch-status / diagnostics / rescan |
| `mediaV4.ts` | 787 | `/api/v4` | 扫描、预览、确认、作业、来源卡、元数据、维护、追更、作品改写、v4 播放与追更状态写入 |
| `playback.ts` | 67 | `/api/playback` | play / stop / status / progress / history / mark / mark-through |
| `config.ts` | 204 | `/api/config` | 配置读写、首次引导、MPV 运行时、TMDB 图片诊断与修复 |
| `openlist.ts` | 143 | `/api/openlist` | 连接、测试、浏览、预取、路由、遥测 |
| `bangumi.ts` | 204 | `/api/integrations/bangumi` | 自带 `BASE_PATH` 与独立 `fetchJson`（`bangumi.ts:4`、`bangumi.ts:72`） |
| `tasks.ts` | 33 | `/api/tasks`（并含 `/api/library/rescan`） | `tasks.ts:32` 额外封装了重扫端点 |
| `system.ts` | 31 | `/api/system` | 自带 `BASE_PATH` 与独立 `fetchJson`（`system.ts:3`、`system.ts:15`） |
| `errorLog.ts` | 62 | `/api/error-log` | 已实现但无组件导入 |
| `assets.ts` | 18 | `/api/assets` | 只做 URL 构造，不发请求 |
| `health.ts` | 7 | `/api/health` | — |
| `heartbeat.ts` | 124 | `/ws/heartbeat` | `HeartbeatClient` 类，含重连 |
| `workCustomization.ts` | 36 | `/api/v4/work-customization` | 标签与额外视频 |
| `workDetailV4Compatibility.ts` | 197 | （复用 mediaV4） | 兼容层，见第 9 节 |
| `types.ts` | 212 | — | 跨模块共享类型 |
| `localRoots.ts` / `openlistConnections.ts` | 18 / 12 | — | 纯函数适配旧单值配置 |
| `desktopSession.ts` / `backendReadiness.ts` / `sessionToken.ts` | 17 / 66 / 21 | — | 会话与就绪判定 |

- 类型定义集中在 `src/api/types.ts`（212 行）；V4 专用 DTO 定义在 `src/api/mediaV4.ts` 内部（如 `V4Preview`、`V4ExecutionProgress`、`V4SourceLibraryCard`）。
- 三个模块走自己的 `fetch` 封装而非 `authorizedFetch`：`bangumi.ts:72`、`system.ts:15`、`errorLog.ts:55`（后者直连 `fetch` 并手工拼 URL）。

## 7. 图片与性能实现

| 机制 | 实现位置 | 关键参数 |
|---|---|---|
| 海报墙虚拟化 | `src/components/library/VirtualizedPosterGrid.tsx:145` | `useVirtualizer` 行虚拟化，`overscan: 3`（`VirtualizedPosterGrid.tsx:20`）；滚动元素固定为外层 `.app-main`（`VirtualizedPosterGrid.tsx:69`） |
| 焦点行保持 | `VirtualizedPosterGrid.tsx:57` | 自定义 `rangeExtractor` 额外固定当前焦点行（`VirtualizedPosterGrid.tsx:60`） |
| 网格度量 | `VirtualizedPosterGrid.tsx:73`、`src/components/library/posterGridMetrics.ts` | 列数、列宽、行高、间距在 `useLayoutEffect` 内测量 |
| 图片请求预算 | `src/components/library/posterImageLifecycle.ts:19` | 并发 6、预取 2、失败冷却 30 s、单图超时 30 s |
| 三级 IntersectionObserver | `posterImageLifecycle.ts:167` | 三个 observer，`rootMargin` 分别为 `0px`、`0.5h/1h`、`2h`，对应可见 / 预取 / 驻留 |
| 离开范围移除 src | `posterImageLifecycle.ts:141` | `clearImageSource` 仅移除 `src` 属性并记录诊断（`posterImageLifecycle.ts:132` 调用） |
| 原生懒加载禁用 | `posterImageLifecycle.ts:130`、`DecodedImage.tsx:34` | 统一 `loading="eager"`，由自己的观察器控制加载时机 |
| 分批解码 + 状态回调 | `src/components/ui/DecodedImage.tsx:12` | `data-image-state` 驱动 `is-ready`/`is-pending` 样式 |
| 图片 URL 形式 | `src/api/assets.ts:13` | 只接受 `/api/assets/artwork/{64位hex}/{digest}-webp-v1/{256\|384\|512\|768\|1280}` |
| 宽度档选择 | `src/utils/artwork.ts:12` | 按角色默认目标宽（fanart 1280、clearlogo 512、poster 384），取 ≥目标的最小已发布档 |
| 卡片宽度档 | `VirtualizedPosterGrid.tsx:23` | 按 `devicePixelRatio` 计算后取 256/384/512 或 512/768/1280 |
| 滚动诊断 | `src/utils/scrollDiagnostics.ts:131`、`src/utils/scrollDiagnostics.ts:219` | 默认关闭，环形缓冲 + 快照注册（`posterImageLifecycle.ts:139` 注册 `imageBudget`） |
| `DecodedImage` 使用范围 | `src/components/shell/Sidebar.tsx`、`src/pages/HomePage.tsx`、`src/pages/WorkDetailPage.tsx`、`src/pages/SettingsPage.tsx` | 分类海报墙不走 `DecodedImage`，改用 `PosterImage` + `posterImageLifecycle`（`src/components/library/PosterImage.tsx:4`） |

## 8. 样式体系

| 层 | 文件 | 行数 | 说明 |
|---|---|---|---|
| Cascade Layer 声明 | `src/styles/layers.css` | 1 | `@layer theme, base, foundation, components, utilities, shell, pages, recovery, overrides;` |
| 基础令牌层 | `src/styles/foundation.css` | 211 | 字体、颜色、圆角、间距等语义变量 |
| 历史主样式表 | `src/index.css` | 13834 | 2917 条类选择器、3016 个规则块；首行引入 Tailwind |
| 恢复与任务 | `src/styles/recovery.css`(108)、`src/styles/task-surfaces.css`(40) | 148 | 错误恢复界面与任务表面 |
| 设置相关 | `settings-media-sources.css`(322)、`settings-navigation.css`(144)、`settings-primitives.css`(56) | 522 | 设置页分区样式 |
| 其他页面/组件样式 | `media-import-controls.css`(150)、`first-run-refinement.css`(101)、`player-tuning.css`(28)、`home-showcase.css`(21)、`folder-path-input.css`(15)、`action-toast.css`(12)、`openlist-connection-picker.css`(8) | 335 | — |
| 组件内联导入样式 | `src/components/detail/work-customization-tags.css`(207)、`src/components/library/PosterCard.css`(31)、`VirtualizedPosterGrid.css`(19)、`src/components/media/V4RecognitionSummary.css`(90)、`src/components/settings/PosterWallSettingsPanel.css`(23)、`src/pages/RecentPage.css`(162) | 532 | 分散在组件/页面目录 |
| Fluent 主题映射 | `src/design/fluentTheme.ts` | 46 | `cinemaTheme` 深色覆盖 + `webLightTheme`；`mica`/`fluent` 同走浅色主题（`fluentTheme.ts:45`） |
| 动态控件渲染器 | `src/design/fluentTheme.ts:4` | — | 从 `style[data-kumi-boot-styles]` 继承 nonce（`src/main.tsx:18`） |

- CSS 总规模约 15 900 行，其中 `src/index.css` 占 87%。
- `src/styles/` 只有 15 个文件、1217 行，说明“新样式进分层、旧样式留在 index.css”的迁移仍在初期。
- Tailwind 与手写 CSS 混用：`src/index.css:1` 引入 Tailwind 后，13 个 `.tsx` 文件使用 Tailwind 工具类，例如 `src/components/shell/AppShell.tsx:63`（`flex min-h-screen`）、`AppShell.tsx:72`（`px-4 pb-5 2xl:px-6`）、`src/components/shell/Sidebar.tsx:83`（`fixed left-0 top-0 z-40 flex h-full flex-col`）、`src/pages/WorkDetailPage.tsx:1446`（`flex items-center gap-2 text-sm`）、`WorkDetailPage.tsx:1595`（`space-y-7`）。
- 主题实现双轨：根属性 `data-theme`/`data-style`/`data-motion`（`src/App.tsx:92`）驱动 `index.css` 选择器，`FluentProvider` 主题由 `design/fluentTheme.ts` 提供。

## 9. 可确认的问题与技术债

以下每条只陈述代码中可验证的事实，不包含主观评价。

| 问题 | 证据 | 量化 |
|---|---|---|
| 存在超大规模单文件 | `src/index.css`、`src/pages/WorkDetailPage.tsx`、`src/pages/MediaManagementPage.tsx`、`src/pages/SettingsPage.tsx`、`src/api/mediaV4.ts`、`src/components/media/V4ExecutionProgress.tsx`、`src/stores/library.ts` | 13834 / 2357 / 2137 / 935 / 787 / 622 / 513 行；`src/` 内超过 500 行的文件共 7 个 |
| 页面级懒加载不完整 | `src/App.tsx:21`–`24`（懒加载 4 个）对比 `src/App.tsx:9`–`13`（静态导入 5 个页面，含分类海报墙页面与搜索页） | 4 / 9 个页面懒加载 |
| 兼容层仍在生产链路 | `src/api/workDetailV4Compatibility.ts`（197 行），2 个方法永久 reject（`src/api/workDetailV4Compatibility.ts:143`、`src/api/workDetailV4Compatibility.ts:148`），1 个能力开关为 `false`（`src/api/workDetailV4Compatibility.ts:9`） | 197 行 |
| 静态导入页面直接携带重依赖 | `src/pages/CategoryPage.tsx:9`（直接导入 `mediaV4Api`）、`src/pages/CategoryPage.tsx:11`（直接导入 `VirtualizedPosterGrid`） | — |
| 同一概念的类型重复定义 | `src/api/types.ts:4` 与 `src/stores/ui.ts:11` 各定义 `SourceId`；`src/api/types.ts:32` 与 `src/stores/ui.ts:10` 各定义 `SortId`（取值集合不同） | 2 组重复 |
| 无使用方的类型 | `src/api/types.ts:26` 的 `PageId` 无任何引用 | 1 个类型 |
| 无使用方的 API 模块 | `src/api/errorLog.ts`（62 行）无导入方；`src/api/library.ts:46`（`rescanLibrary`）与 `src/api/library.ts:48`（`getDiagnostics`）无调用方 | 1 个模块 + 2 个方法 |
| 已退役能力仍留在客户端 | `src/api/assets.ts:10` 的 `_options`（`kind`/`thumbnailWidth`/`cacheOnly`）未被读取；`src/components/media/LibraryMaintenancePanel.tsx:44` 仍保留 `materialize_mirror: '生成镜像'` 标签 | 2 处 |
| 硬编码地址重复 | `src/api/client.ts:9` 与 `src/api/backendReadiness.ts:3` 各自硬编码 `http://127.0.0.1:37821` | 2 处 |
| 请求封装分叉 | 除 `authorizedFetch` 外，`src/api/bangumi.ts:72`、`src/api/system.ts:15`、`src/api/errorLog.ts:55` 各自实现超时/头处理 | 3 处 |
| 进度写入端点并存 | `src/api/playback.ts:60`（`/api/playback/progress`）与 `src/api/mediaV4.ts:778`（`/api/v4/playback/progress`）同时存在 | 2 个端点 |
| 图片宽度档逻辑分散在三处 | `src/api/assets.ts:13`（正则校验档位）、`src/utils/artwork.ts:16`（角色默认目标宽）、`src/components/library/VirtualizedPosterGrid.tsx:22`（按 DPR 取档） | 3 处 |
| 样式分散在组件/页面目录 | `src/components/detail/work-customization-tags.css`、`src/components/library/PosterCard.css`、`src/components/library/VirtualizedPosterGrid.css`、`src/components/media/V4RecognitionSummary.css`、`src/components/settings/PosterWallSettingsPanel.css`、`src/pages/RecentPage.css` | 6 个共 532 行 |
| `src/pages/` 下存在页面级 CSS | `src/pages/RecentPage.css`（162 行） | 1 个 |
| 主题映射只实现两套配色 | `src/design/fluentTheme.ts:45`：`cinema` 走 `cinemaTheme`，`fluent` 与 `mica` 均走 `webLightTheme` | 3 个 UI 主题 → 2 套 Fluent 主题 |
| 组件组合约定只有说明文档 | `src/components/ui/README.md` 仅说明当前共享组件；不再作为新前端模板，无对应 lint 或测试约束 | — |

## 10. 未确认项

- **`src/pages/PlayerTuningPage.tsx` 是否有除 `SettingsPage` 之外的调用方**：`SettingsPage.tsx:661` 以 `embedded` 传入；未发现独立导航入口，但未确认 Tauri 侧或测试是否存在其他调用。原因：本次未检索 `src-tauri/` 的 WebView 注入脚本与 `tests/components/` 全部用例。
- **`dist/` 与 `release/` 中的构建产物是否与当前源码一致**：未比对，故不据此判断产物行为。
- **`index.css` 中 13834 行的分类占比**：只统计了总行数、类选择器数与规则块数，未按功能分区统计，无法给出“哪些区块可安全移除”。
- **`data-theme` 三主题在 `index.css` 中的选择器覆盖完整度**：只确认 `data-theme` 属性写入与 `cineamaTheme` 映射存在，未逐条核对三个主题下每个页面的实际取值。
- **`src/components/library/posterImageLifecycle.ts` 的预算参数是否在运行中被调整**：构造默认值 6/2/30s/30s（`posterImageLifecycle.ts:19`），`PosterImageLifecycle` 构造函数接受自定义预算（`posterImageLifecycle.ts:159`），未确认是否存在注入自定义预算的调用点。
- **`tests/` 下的前端契约测试覆盖范围**：`tests/` 根目录共有 30 个 `.test.ts`，另有 `tests/components/`、`tests/lib/` 两个目录；未逐一核对哪些断言覆盖页面结构与样式，故不给出覆盖率结论。
