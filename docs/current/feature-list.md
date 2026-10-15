# KumiPlayer 功能清单（重构前置现状）

> 适用范围：现有系统的事实快照；不作为 3.0 的页面、组件、视觉或架构约束。源码及用户最新指令优先。

> 记录日期：2026-10-14
> 事实来源：`backend/app/api/`、`backend/app/media_v4/`、`backend/app/scrape/`、`backend/app/integrations/`、`src/`、`backend/tests/`、`tests/`
> 定位：按产品能力列出当前系统中**已确认存在**的功能，包括实现位置、数据来源、依赖接口与承载页面，并单列未接入与已退役能力。不描述未来计划、不评价设计、不推荐技术栈。本目录其余文档的分工见 `docs/current/README.md`，接口契约与真实流程细节分别由该目录的接口与流程文档承担，本文件不重复展开。

## 状态口径

| 状态 | 判定标准 |
|---|---|
| 已实现 | 后端路由或领域实现与前端调用链都存在，用户可实际触发 |
| 部分实现 | 端到端链路存在但只覆盖部分场景，或前端缺少入口/界面 |
| 未实现 | 只有能力开关、类型、标签或占位，无实际执行实现 |
| 已废弃 | 历史能力已退役，代码保留明确的拒绝、空壳或注释说明 |

能力表计数（第 1–16 节，共 141 项）：**已实现 131 项，部分实现 4 项，未实现 3 项，已废弃 3 项**。第 17 节单列 16 条未接入与退役边界（已退役 9 条、未接入 2 条、已废弃 1 条、未实现 1 条、部分实现 1 条、已实现但无界面入口 1 条、未确认 1 条）。

## 1. 媒体库浏览

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 首页推荐橱窗与分区预览 | 已实现 | `src/pages/HomePage.tsx:27`、`src/utils/homeShowcase.ts:57` | 前端对 `useLibraryStore.works` 二次筛选排序 | `GET /api/library`（`src/api/library.ts:39`） | HomePage |
| 分类浏览（新番/番剧/动画电影/剧集/电影） | 已实现 | `src/pages/CategoryPage.tsx:35`、`src/utils/libraryCategories.ts:12` | 前端按 `show_type`/`content_scope` 过滤 | `GET /api/library` | CategoryPage |
| 搜索（标题、原名、关联作品名） | 已实现 | `src/pages/SearchPage.tsx:9` | 前端小写包含匹配 + 观看历史加权 | 无独立搜索接口 | SearchPage，搜索词非空时覆盖当前页（`src/App.tsx:240`） |
| 收藏 | 已实现 | `src/pages/FavoritesPage.tsx:8`、`src/stores/library.ts:377` | `watch_status.favorite` | `PATCH /api/library/watch-status/{work_id}`（`backend/app/api/library_v4.py:328`） | FavoritesPage |
| 最近观看（继续播放入口） | 已实现 | `src/pages/RecentPage.tsx:8` | 播放历史 + 进度 | `GET /api/playback/history`（`backend/app/api/playback_v4.py:143`） | RecentPage |
| 侧栏分类计数 | 已实现 | `src/utils/libraryCategories.ts:20` | 前端统计 works | — | 侧边栏 |
| 排序（最近/标题/评分/年份/集数） | 已实现 | `src/utils/categorySort.ts:39` | 前端排序 | — | CategoryPage |
| 来源筛选（全部/115/百度/夸克/本地） | 已实现 | `src/utils/sourceFilter.ts:11`、`src/components/shell/DesktopTitleBar.tsx:11` | `source` / `provider_id` / `ingest_method` | — | 桌面标题栏 |
| 海报墙虚拟化（`@tanstack/react-virtual`） | 已实现 | `src/components/library/VirtualizedPosterGrid.tsx:32` | works | — | 分类/收藏/搜索 |
| 增量同步（可见 5s、不可见 30s 游标） | 已实现 | `src/App.tsx:120`、`src/stores/library.ts:250` | `change_sequence` 游标 | `GET /api/library/changes`（`backend/app/api/library_v4.py:238`）、`GET /api/library/cards`（`backend/app/api/library_v4.py:254`） | 全局 |
| 本地离线缓存（1.5 MB / 500 部 / 7 天） | 已实现 | `src/stores/library.ts:12`、`src/stores/library.ts:13`、`src/stores/library.ts:14`、`src/stores/library.ts:15` | localStorage | — | 全局 |
| 作品墙布局与卡片图模式（海报/剧照） | 已实现 | `src/components/settings/PosterWallSettingsPanel.tsx:42`、`src/stores/ui.ts:288` | `poster_size`、`series_card_image_mode` | `PATCH /api/config`（`src/api/config.ts:166`） | 设置 › 外观 |

## 2. 作品详情

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 详情聚合读取（完整作品/季度/剧集/演员/操作） | 已实现 | `src/pages/WorkDetailPage.tsx:117` | 已发布详情投影 | `GET /api/library/works/{work_id}`（`src/api/library.ts:44`） | WorkDetailPage |
| 季度选择并记忆 | 已实现 | `src/components/media/DetailSeasonPicker.tsx:62`、`src/stores/ui.ts:276` | 详情 `seasons` | — | 详情 |
| 剧集列表与单集观看状态 | 已实现 | `src/pages/WorkDetailPage.tsx:420` | 进度 + 历史 | `GET /api/playback/progress`、`GET /api/playback/history` | 详情 |
| 主播放/继续播放按钮与进度显示 | 已实现 | `src/utils/playbackProgress.ts:17` | 进度 + 会话状态 | `GET /api/playback/status`（`backend/app/api/playback_v4.py:83`） | 详情 |
| 演员、相关推荐、标签展示 | 已实现 | `src/pages/WorkDetailPage.tsx:1596` | 详情投影 `cast`/`related_works`/`tags` | `GET /api/library/works/{work_id}` | 详情 |
| 背景图 / clearlogo 展示 | 已实现 | `src/utils/artwork.ts:12` | 已发布图片资源版本 | `GET /api/assets/artwork/{id}/{version}/{width}`（`backend/app/api/assets.py:12`） | 详情 |
| 额外视频提醒（特别篇/辅助视频） | 已实现 | `src/pages/SettingsPage.tsx:630`、`src/components/detail/WorkCustomizationTags.tsx:85` | 识别结果分类统计 | `GET /api/v4/work-customization/{work_id}/extra-videos`（`backend/app/api/work_customization_v4.py:93`） | 设置 › 媒体来源、详情 |
| 打开视频文件夹（按作品/剧集/Asset） | 已实现 | `src/pages/WorkDetailPage.tsx:1252` | 已保存本地路径 | `POST /api/system/open-folder`（`backend/app/api/system.py:40`） | 详情 |
| 删除作品（预览 + digest 确认） | 已实现 | `src/pages/WorkDetailPage.tsx:2031`、`src/api/workDetailV4Compatibility.ts:159` | 受管工件与引用计数 | `POST /api/v4/works/{work_id}/delete-preview`、`/delete-confirm`（`backend/app/api/media_v4.py:2318`、`backend/app/api/media_v4.py:2330`） | 详情 |
| 详情缓存与请求去重 | 已实现 | `src/stores/library.ts:393`、`src/stores/library.ts:57` | 内存 Map + 版本号 | — | 全局 |

## 3. 手动纠错（用户数据，不被重扫覆盖）

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 手动标题 | 已实现 | `src/api/workDetailV4Compatibility.ts:151` | `title_provenance='manual'` | `PATCH /api/v4/works/{work_id}/title`（`backend/app/api/media_v4.py:2126`） | 详情 › 更多操作 |
| 恢复在线标题 | 已实现 | `src/api/workDetailV4Compatibility.ts:155` | 已引用资料快照 | `DELETE /api/v4/works/{work_id}/title`（`backend/app/api/media_v4.py:2154`） | 详情 |
| 手动图片上传（poster/fanart/clearlogo） | 已实现 | `src/api/workDetailV4Compatibility.ts:181` | base64 上传进入受管图片库 | `POST /api/v4/works/{work_id}/artwork`（`backend/app/api/media_v4.py:2169`） | 详情 |
| 恢复自动图片 | 已实现 | `src/api/workDetailV4Compatibility.ts:192` | 资源绑定回退 | `DELETE /api/v4/works/{work_id}/artwork/{kind}`（`backend/app/api/media_v4.py:2242`） | 详情 |
| 收藏切换 | 已实现 | `src/stores/library.ts:377` | `watch_status.favorite` | `PATCH /api/library/watch-status/{work_id}` | 详情、收藏页 |
| 观看状态（在看/看过/搁置/抛弃 + 备注） | 已实现 | `backend/app/api/library_v4.py:328` | `watch_status` | 同上 | 详情 |
| 作品自定义标签（含预设色） | 已实现 | `src/components/detail/WorkCustomizationTags.tsx:123` | `v4` 自定义标签表 | `PUT /api/v4/work-customization/{work_id}`（`backend/app/api/work_customization_v4.py:62`） | 详情 |
| 剧集维度已看标记与批量标记 | 已实现 | `src/pages/WorkDetailPage.tsx:1218`、`src/pages/WorkDetailPage.tsx:1238` | 进度表 | `POST /api/playback/progress/mark`、`/progress/mark-through`（`backend/app/api/playback_v4.py:105`、`backend/app/api/playback_v4.py:114`） | 详情 |
| 追加剧集（手工追加单集） | 未实现 | `src/api/workDetailV4Compatibility.ts:9`（`appendEpisodes: false`）、`src/api/workDetailV4Compatibility.ts:143` | — | 无后端路由 | 详情菜单入口按开关隐藏 |

## 4. 导入系统

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 本地目录扫描 | 已实现 | `src/pages/MediaManagementPage.tsx:298`（`ImportKind='local'`） | 文件系统目录树 | `POST /api/v4/sources/scans`（`backend/app/api/media_v4.py:1954`） | 媒体管理 › 导入 |
| 目录树 TXT 导入（115/百度原位置导出） | 已实现 | `src/platform/folderPicker.ts:31`、`src/pages/MediaManagementPage.tsx:50` | TXT 正文 + 归档 | `POST /api/v4/sources/scans` | 媒体管理 › 导入 |
| OpenList 远端路径导入 | 已实现 | `src/components/media/OpenListFolderBrowser.tsx:36` | OpenList API 目录树 | `POST /api/openlist/browse`（`backend/app/api/openlist_v4.py:443`）、`POST /api/v4/sources/scans` | 媒体管理 › 导入 |
| TXT + OpenList 混合导入 | 已实现 | `src/pages/MediaManagementPage.tsx:50`（`ImportKind='hybrid'`） | TXT 条目 + OpenList 范围 | 同上 | 媒体管理 › 导入 |
| 来源库概览卡（状态/规模/进度/更新/重命名/移除） | 已实现 | `src/components/media/SourceLibraryCard.tsx:32`、`src/api/mediaV4.ts:617` | 来源卡聚合 | `GET /api/v4/sources/libraries`（`backend/app/api/media_v4.py:1576`）、`PATCH`（`backend/app/api/media_v4.py:1659`）、`DELETE`（`backend/app/api/media_v4.py:1612`） | 媒体管理 › 概览 |
| 来源内容范围（已完结 / 新番） | 已实现 | `src/api/mediaV4.ts:121`、`src/pages/MediaManagementPage.tsx:1370` | `source_roots.content_scope` | 随扫描与来源更新请求提交 | 媒体管理 › 导入 |
| TXT 文件拖放进入导入 | 已实现 | `src/App.tsx:96`、`src/stores/mediaWorkflow.ts:5` | Tauri 拖放事件 | — | 全局（详情/设置页除外） |
| 本地目录登记（最多 24 条，名称 24 码点） | 已实现 | `src/components/settings/LocalRootsPanel.tsx:14`、`src/api/localRoots.ts` | `config.local_roots` | `PATCH /api/config` | 设置 › 媒体来源 |
| 媒体库维护（按范围删除预览/确认/恢复） | 已实现 | `src/components/media/LibraryMaintenancePanel.tsx:84` | revision + 生成物 + 受控记录 | `POST /api/v4/library-maintenance/delete-preview`、`/delete-confirm`、`/delete-resume`（`backend/app/api/media_v4.py:2425`、`backend/app/api/media_v4.py:2445`、`backend/app/api/media_v4.py:2464`） | 媒体管理 › 维护 |
| 作品身份修复（预览/应用/恢复） | 已实现 | `src/api/mediaV4.ts:678` | 身份冲突记录 | `POST /api/v4/works/{work_id}/identity-repair-preview`、`/api/v4/identity-repair/apply`、`/resume`（`backend/app/api/media_v4.py:2777`、`2791`、`2809`） | 媒体管理 › 维护 |
| 来源目录连通性检查 | 已实现 | `src/pages/SettingsPage.tsx:357` | 配置目录可达性 | `POST /api/config/test/media-paths`（`backend/app/api/config.py:618`） | 设置 › 媒体来源 |
| 受管图片缓存回收（预览 + digest 确认） | 部分实现 | `backend/app/api/media_v4.py:78`、`backend/app/api/media_v4.py:100` | 图片 GC 计划 | 同上两个端点 | 无前端调用（`src/` 中无 `artwork-cache` 引用） |
| 诊断接口 `GET /api/library/diagnostics` | 部分实现 | `src/api/library.ts:48`、`backend/app/api/library_v4.py:304` | 持久摘要 | 同上 | 无界面入口（`getDiagnostics` 未被任何组件调用） |
| 媒体库重扫 `POST /api/library/rescan` | 部分实现 | `src/api/library.ts:46`、`backend/app/api/library_v4.py:370` | — | 同上 | 无界面入口（`rescanLibrary` 未被任何组件调用） |

## 5. 目录解析与识别

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 扫描证据采集（SourceEvidence） | 已实现 | `backend/app/media_v4/sources/`、`backend/app/api/media_v4.py:1954` | 目录树/清单文本 | `POST /api/v4/sources/scans` | 媒体管理 |
| 扫描进度、取消与恢复 | 已实现 | `backend/app/media_v4/sources/source_scan_runner.py:1`、`src/lib/scanProgress.ts:15` | SQLite 扫描行 + 心跳 | `GET /api/v4/sources/scans/{scan_id}`（`backend/app/api/media_v4.py:2071`）、`POST .../cancel`（`backend/app/api/media_v4.py:2103`） | 媒体管理 |
| TXT 解析事实（ParsedFacts，只解析一次） | 已实现 | `backend/app/media_v4/parsing/` | 归档 TXT 正文 | 随预览生成 | 媒体管理 |
| 标题清洗与集号标题判定（纯函数） | 已实现 | `backend/app/recognition/` | 文件名/目录名 | — | 后端内部 |
| MediaGraph 解析（Work/Season/Episode/Edition/Asset） | 已实现 | `backend/app/media_v4/resolution/` | ParsedFacts | `POST /api/v4/imports/preview`（`backend/app/api/media_v4.py:1142`） | 媒体管理 |
| 候选评分与多 Asset 收口 | 已实现 | `backend/app/media_v4/resolution/candidates.py:30` | 稳定身份签名 | — | 后端内部 |
| 特别篇/辅助视频准入门禁（SP/OVA/OAD、PV/OP/ED/NCOP 等） | 已实现 | `backend/tests/test_v4_special_exclusion_policy.py` | 类别判定 | — | 后端内部 |
| 识别摘要与人工修正（override，不改 ParsedFacts） | 已实现 | `src/components/media/V4RecognitionSummary.tsx:256` | `V4Preview` + issues | `PATCH /api/v4/imports/{revision_id}/evidence/{evidence_id}`（`backend/app/api/media_v4.py:1416`） | 媒体管理 › 导入 |
| 目录树路径预览与播放根校验 | 已实现 | `src/api/mediaV4.ts:758`（`V4TreePathPreview`） | TXT 原位置关系 | `POST /api/v4/sources/scans` | 媒体管理 |

## 6. 确认 revision 与预览

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 预览生成（draft revision） | 已实现 | `src/api/mediaV4.ts:599` | ParsedFacts + MediaGraph | `POST /api/v4/imports/preview` | 媒体管理 |
| 证据条目读取 | 已实现 | `src/api/mediaV4.ts:735` | `source_evidence` | `GET /api/v4/imports/{revision_id}/evidence`（`backend/app/api/media_v4.py:1528`） | 媒体管理 |
| 原子确认（revision + outbox + 作业） | 已实现 | `src/api/mediaV4.ts:602` | confirmed revision | `POST /api/v4/imports/{revision_id}/confirm`（`backend/app/api/media_v4.py:1268`） | 媒体管理 |
| 确认取消 | 已实现 | `src/api/mediaV4.ts:605` | — | `POST /api/v4/imports/{revision_id}/cancel`（`backend/app/api/media_v4.py:1316`） | 媒体管理 |
| 作业进度与执行详情 | 已实现 | `src/components/media/V4ExecutionProgress.tsx:458` | `V4ExecutionProgress` DTO | `GET /api/v4/imports/{revision_id}`（`backend/app/api/media_v4.py:1432`）、`GET /api/v4/revisions/{revision_id}/works/{work_id}/execution-detail`（`backend/app/api/media_v4.py:1448`） | 媒体管理 |
| 草稿来源列表 | 已实现 | `src/api/mediaV4.ts:666` | 未确认 revision | `GET /api/v4/sources/drafts`（`backend/app/api/media_v4.py:1493`） | 媒体管理 |

## 7. 刮削与元数据

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| TMDB 候选搜索 | 已实现 | `src/api/workDetailV4Compatibility.ts:82` | TMDB 在线 | `POST /api/v4/metadata/search`（`backend/app/api/media_v4.py:2562`） | 详情 › 手动刮削 |
| 候选确认（作品范围 / 季度范围） | 已实现 | `src/api/workDetailV4Compatibility.ts:106` | 候选 + 季度映射 | `POST /api/v4/metadata/confirm`（`backend/app/api/media_v4.py:2823`） | 详情 |
| 单作品重跑刮削 | 已实现 | `src/api/workDetailV4Compatibility.ts:129` | 已引用快照 | `POST /api/v4/works/{work_id}/scrape`（`backend/app/api/media_v4.py:2292`） | 详情 |
| 资料重试（保留上次成功快照） | 已实现 | `src/api/mediaV4.ts:720` | metadata snapshot | `POST /api/v4/metadata/retry`（`backend/app/api/media_v4.py:2703`） | 媒体管理执行进度 |
| 工件（图片等）重试 | 已实现 | `src/api/mediaV4.ts:723` | 绑定与工件状态 | `POST /api/v4/metadata/artifacts/retry`（`backend/app/api/media_v4.py:2664`） | 媒体管理 |
| TMDB 客户端（限流、重试、超时、强绑定提示） | 已实现 | `backend/app/scrape/tmdb_client.py`、`backend/app/scrape/tmdb_hint.py` | TMDB API | — | 后端内部 |
| AniList 辅助（可选开关） | 已实现 | `backend/app/scrape/anilist_client.py:22`、`src/pages/SettingsPage.tsx:492` | AniList GraphQL | 随别名恢复作业调用 | 设置 › 元数据与图片 |
| 别名恢复（AniList / Bangumi / 联网名称核对） | 已实现 | `backend/app/media_v4/jobs/alias_recovery.py:16`、`backend/app/media_v4/jobs/alias_recovery.py:92` | 多 Provider | 由资料类作业按需触发 | 后端内部 |
| 联网名称核对（Tavily 搜索 + DeepSeek 提取，默认关闭） | 已实现 | `src/pages/SettingsPage.tsx:467` | 公开网页 + TMDB 复核 | `PATCH /api/config` | 设置 › 元数据与图片 |
| 保留版本（不采用未引用旧刮削结果） | 已实现 | `src/api/types.ts:61`（`metadata_source='retained'`） | 已有效引用快照 | — | 后端内部 |

## 8. 图片与图片缓存

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 受管原图库 | 已实现 | `backend/app/media_v4/assets/catalog.py:1`、`backend/app/media_v4/assets/service.py:1` | 下载或手工上传 | — | 后端内部 |
| 派生尺寸（WebP，`RECIPE_VERSION='webp-v1'`） | 已实现 | `backend/app/media_v4/assets/catalog.py:17`、`backend/app/media_v4/assets/catalog.py:18` | 内容摘要 + 配方 | — | 后端内部 |
| 按角色的宽度档（poster 256/384/512；fanart 512/768/1280；clearlogo 256/384/512） | 已实现 | `backend/app/media_v4/assets/catalog.py:18` | 同上 | — | 后端内部 |
| 发布门槛（必需展示尺寸就绪后才发布卡片与详情） | 已实现 | `backend/app/media_v4/assets/service.py:356`、`backend/app/media_v4/assets/service.py:365` | `required_artwork_status` | 投影发布 | 全局 |
| 图片 GET 只读已发布派生缓存（immutable + ETag） | 已实现 | `backend/app/api/assets.py:12`、`backend/app/api/assets.py:41` | 派生索引 | `GET /api/assets/artwork/{id}/{version}/{width}` | 全局 |
| 图片 URL 构造（只接受已发布路径，否则返回空） | 已实现 | `src/api/assets.ts:8`、`src/api/assets.ts:13` | 已发布资源路径 | — | 全局 |
| 手工上传图片排队准备派生 | 已实现 | `backend/app/api/media_v4.py:2169` | 上传内容 | 同上 | 详情 |
| 失败冷却 30 秒后可重试 | 已实现 | `src/components/library/posterImageLifecycle.ts:19` | 前端预算表 | — | 海报墙 |
| 旧库图片有界补齐队列（可见优先） | 已实现 | `backend/app/media_v4/assets/preparation.py` | 投影受信本地引用 | 由图片服务后台执行 | 后端内部 |
| 图片失败进度面板 + 一键修复（独立进程、UAC、备份/回滚） | 已实现 | `src/components/settings/TmdbImageConnectionPanel.tsx:8` | 诊断报告 | `POST /api/config/test/tmdb-images`（`backend/app/api/config.py:499`）、`/tmdb-images/repair`（`backend/app/api/config.py:504`） | 设置 › 元数据与图片 |
| 旧远程图片代理 | 已废弃 | `src/api/assets.ts:16`（非已发布路径一律返回空字符串） | — | 无对应路由 | — |
| 请求现场缩图 / thumbnail / prepare 路由 | 已废弃 | `backend/app/api/assets.py:1`（注释：文件路径、NFO、远程代理及准备端点均已退役） | — | 仅保留一个 GET | — |

## 9. 播放系统

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 内置干净 MPV 播放（本地绝对路径） | 已实现 | `backend/app/api/playback_v4.py:61`、`backend/app/playback/` | 已保存 `playback_locator` | `POST /api/playback/play` | 详情 |
| 外部 MPV 整合包模式 | 已实现 | `src/api/config.ts:29`、`src/pages/FirstRunSetup.tsx:74` | `player_mode='external'` + `external_mpv_path` | `POST /api/config/test/mpv-path`（`backend/app/api/config.py:351`） | 设置 › 播放、首次引导 |
| 停止播放 / 播放状态 | 已实现 | `backend/app/api/playback_v4.py:78`、`backend/app/api/playback_v4.py:83` | 后端播放会话 | `POST /api/playback/stop`、`GET /api/playback/status` | 详情 |
| 自动连播下一集 | 已实现 | `src/pages/SettingsPage.tsx:669` | `auto_play_next_episode` | `PATCH /api/config` | 设置 › 播放 |
| Anime4K 永久默认模式与质量 | 已实现 | `src/pages/PlayerTuningPage.tsx:42` | `mpv_anime4k_mode`、`mpv_anime4k_quality` | `PATCH /api/config` | 设置 › 播放（内嵌） |
| MPV 运行时状态与配置目录打开 | 已实现 | `src/api/config.ts:167`、`src/api/config.ts:168` | 运行清单校验 | `GET /api/config/mpv-runtime`、`POST /api/config/mpv-runtime/open-config`（`backend/app/api/config.py:520`、`562`） | 设置 › 播放 |
| 视频文件拖放追加为当前作品剧集 | 未实现 | `src/pages/WorkDetailPage.tsx:1428`（拖放遮罩存在，但 `appendEpisodes` 为 `false`） | — | `previewEpisodes`/`commitEpisodes` 直接拒绝（`src/api/workDetailV4Compatibility.ts:143`） | 详情（入口不生效） |

## 10. 播放进度与历史

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 进度写入（JSON IPC 观察者） | 已实现 | `backend/app/media_v4/playback/`、`backend/app/api/playback_v4.py:88` | MPV JSON IPC | `POST /api/playback/progress` | 详情 |
| 历史读取（按作品或全局） | 已实现 | `backend/app/api/playback_v4.py:143`、`src/api/playback.ts:49` | 进度表 + 快照字段 | `GET /api/playback/history` | 详情、最近观看 |
| 已看标记 | 已实现 | `backend/app/api/playback_v4.py:105` | 进度表 | `POST /api/playback/progress/mark` | 详情 |
| 批量标记到指定集 | 已实现 | `backend/app/api/playback_v4.py:114` | 进度表 | `POST /api/playback/progress/mark-through` | 详情 |
| 会话进度与持久进度合并展示 | 已实现 | `src/utils/playbackProgress.ts:32` | 会话 + 历史 | `GET /api/playback/status` | 详情 |
| v4 进度写入端点（备用路径） | 已实现 | `src/api/mediaV4.ts:778` | — | `POST /api/v4/playback/progress`（`backend/app/api/media_v4.py:2493`） | 由详情播放流程调用 |

## 11. 追更调度

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 追更来源状态读取（只读，不触发扫描） | 已实现 | `src/pages/CategoryPage.tsx:61` | 追更控制表 | `GET /api/v4/tracking/sources`（`backend/app/api/tracking_v4.py:78`） | 分类 › 新番 |
| 追更作品状态读取 | 已实现 | `src/api/mediaV4.ts:704` | 追更控制表 | `GET /api/v4/tracking/works`（`backend/app/api/tracking_v4.py:51`） | 未发现直接消费组件 |
| 单作品扫描更新 | 已实现 | `src/api/workDetailV4Compatibility.ts:136` | 来源范围 | `POST /api/v4/tracking/{work_id}/scan`（`backend/app/api/tracking_v4.py:158`） | 详情 › 更多操作（`content_scope='ongoing'`） |
| 全部来源扫描 | 已实现 | `src/pages/CategoryPage.tsx:96` | 追更来源 | `POST /api/v4/tracking/scan-all`（`backend/app/api/tracking_v4.py:152`） | 分类 › 新番 |
| 扫描取消 | 已实现 | `src/api/mediaV4.ts:714` | — | `POST /api/v4/tracking/scans/{scan_id}/cancel`（`backend/app/api/tracking_v4.py:167`） | 分类 › 新番 |
| 追更控制状态写入（含 Provider 记录） | 已实现 | `src/api/mediaV4.ts:786` | 追更控制表 | `POST /api/v4/tracking/state`（`backend/app/api/media_v4.py:2519`） | 后端内部 |
| 定时/启动更新（默认关闭，15–10080 分钟） | 已实现 | `src/components/settings/OngoingUpdateSettingsPanel.tsx:17`、`backend/app/media_v4/tracking/scheduler.py:28` | `ongoing_update_*` 配置 | `PATCH /api/config` | 设置 › 媒体来源 |
| 追更分类名自定义（最多 24 码点） | 已实现 | `src/stores/ui.ts:59`、`src/stores/ui.ts:293` | 本机 `UiStore` 偏好 | — | 设置 › 媒体来源 |
| 后端每 30 秒调度检查 | 已实现 | `backend/app/main.py:110`、`backend/app/media_v4/tracking/scheduler.py:22` | `OngoingScheduler.tick` | — | 后端后台 |

## 12. 任务系统

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 任务列表（可按 source 过滤） | 已实现 | `src/pages/SettingsPage.tsx:285` | `TaskRecord` | `GET /api/tasks`（`backend/app/api/tasks_v4.py:66`） | 设置 › 应用 |
| 单任务读取 | 已实现 | `src/pages/WorkDetailPage.tsx:990` | `TaskRecord` | `GET /api/tasks/{task_id}`（`backend/app/api/tasks_v4.py:81`） | 详情 |
| 任务取消 | 已实现 | `src/api/tasks.ts:27` | `TaskRecord` | `POST /api/tasks/{task_id}/cancel`（`backend/app/api/tasks_v4.py:99`） | 设置 › 应用 |
| 任务重试 | 已实现 | `src/pages/MediaManagementPage.tsx:1245` | `TaskRecord` | `POST /api/tasks/{task_id}/retry`（`backend/app/api/tasks_v4.py:134`） | 媒体管理 |
| 长任务跨页面存活（关闭弹窗/切页不取消） | 已实现 | `src/pages/MediaManagementPage.tsx:381` | 后端 `TaskRecord` | — | 全局 |

## 13. 设置系统（七个分类）

设置页分类定义于 `src/pages/SettingsPage.tsx:41` 与 `src/pages/SettingsPage.tsx:44`；分类 ID 与 `src/stores/ui.ts:15` 的 `SettingsSectionId` 一致。

| 分类 | 状态 | 主要内容 | 实现位置 |
|---|---|---|---|
| `application` 应用 | 已实现 | 窗口偏好、托盘（`WindowSettingsPanel`）、界面连接监测开关 | `src/pages/SettingsPage.tsx:374`、`src/components/settings/WindowSettingsPanel.tsx:7`、`src/pages/SettingsPage.tsx:386` |
| `appearance` 外观 | 已实现 | 三主题（雾蓝云母/深邃影院/纯白）、作品墙布局与卡片图模式 | `src/pages/SettingsPage.tsx:396`、`src/components/settings/PosterWallSettingsPanel.tsx:42` |
| `sources` 媒体来源 | 已实现 | 本地目录登记、额外视频提醒、来源维护与目录检查、新番更新与分类名 | `src/pages/SettingsPage.tsx:605`、`src/components/settings/LocalRootsPanel.tsx:14`、`src/components/settings/OngoingUpdateSettingsPanel.tsx:17` |
| `openlist` WebDAV 目录 | 已实现 | 多连接管理、连接测试、远端根与本地挂载、提供商路由、预取上限、缓存 TTL、今日请求遥测 | `src/pages/SettingsPage.tsx:501`、`src/components/settings/OpenListSettingsPanel.tsx:145`、`src/components/settings/OpenListSourceRoutes.tsx:37` |
| `scrape` 元数据与图片 | 已实现 | TMDB 令牌、图片诊断与修复、网络代理、联网名称核对（Tavily + DeepSeek）、TMDB/AniList 高级参数 | `src/pages/SettingsPage.tsx:437`、`src/components/settings/TmdbImageConnectionPanel.tsx:8` |
| `player` 播放 | 已实现 | 内嵌 `PlayerTuningPage`（播放器模式、Anime4K）、自动播放下一集 | `src/pages/SettingsPage.tsx:659`、`src/pages/PlayerTuningPage.tsx:42` |
| `bangumi` 账户与同步 | 已实现 | 账户身份卡、Token 保存/登出、会话状态、连接测试 | `src/pages/SettingsPage.tsx:669`、`src/api/bangumi.ts:75` |

## 14. Bangumi 集成（页面能力）

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 账户连接与登出（Access Token 存 Credential Manager） | 已实现 | `src/api/bangumi.ts:76`、`backend/app/api/bangumi.py:167` | `data/bangumi_account.json` + 凭据库 | `POST/DELETE /api/integrations/bangumi/token` | 设置 › 账户与同步 |
| 本地会话恢复 + 后台验证（TTL 6 小时） | 已实现 | `src/stores/bangumi.ts:7`、`src/App.tsx:183` | 本地会话记录 | `GET /session`（`backend/app/api/bangumi.py:220`）、`POST /session/verify`（`backend/app/api/bangumi.py:247`） | 全局启动 |
| 番剧搜索与绑定/解绑 | 已实现 | `src/pages/WorkDetailPage.tsx:1337`、`src/pages/WorkDetailPage.tsx:1378` | Bangumi 条目 | `POST /search`、`GET/POST/DELETE /matches/{work_id}`（`backend/app/api/bangumi.py:371`、`538`、`551`） | 详情 › Bangumi 面板 |
| 收藏状态设置 | 已实现 | `src/pages/WorkDetailPage.tsx:1407` | Bangumi 收藏 | `PATCH /collections/{work_id}`（`backend/app/api/bangumi.py:593`） | 详情 |
| 分集列表与单集已看同步 | 已实现 | `src/pages/WorkDetailPage.tsx:543`、`backend/app/api/bangumi.py:675` | Bangumi 剧集 | `GET /episodes/{work_id}`、`PUT /episodes/{episode_id}/watched` | 详情 |
| 进度同步 | 已实现 | `src/pages/WorkDetailPage.tsx:817` | 本地进度 | `POST /progress/{work_id}/sync`（`backend/app/api/bangumi.py:822`） | 详情 |
| 头像与封面图受限代理 | 已实现 | `src/api/bangumi.ts:15` | Bangumi 图片 | `GET /avatar`、`GET /subject-image`（`backend/app/api/bangumi.py:299`、`305`） | 侧栏、设置、详情 |
| 离线状态保留（认证失败不阻塞界面） | 已实现 | `src/stores/bangumi.ts:24` | 本地会话 | — | 全局 |

## 15. 诊断与错误日志

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| TMDB 图片连通性诊断与独立修复作业 | 已实现 | `src/components/settings/TmdbImageConnectionPanel.tsx:8` | 诊断报告 + 修复作业 | `POST /api/config/test/tmdb-images`、`/tmdb-images/repair`、`GET /tmdb-images/repair/{job_id}`（`backend/app/api/config.py:499`、`504`、`512`） | 设置 › 元数据与图片 |
| 来源库诊断与目录核对 | 已实现 | `src/api/mediaV4.ts:620`、`src/api/mediaV4.ts:623` | 来源扫描记录 | `GET /api/v4/sources/libraries/{root_id}/diagnostics`（`backend/app/api/media_v4.py:1590`）、`GET /api/v4/sources/scans/{scan_id}/directory-check`（`backend/app/api/media_v4.py:1601`） | 媒体管理 |
| 健康检查与 WebSocket 心跳 | 已实现 | `src/stores/connection.ts:11`、`src/api/heartbeat.ts:10` | 30 秒轮询 + `/ws/heartbeat` | `GET /api/health`（`backend/app/api/health.py`）、`/ws/heartbeat`（`backend/app/api/heartbeat.py`） | 全局 |
| 会话令牌缺失/失效的恢复界面 | 已实现 | `src/components/errors/RecoveryView.tsx:17`、`src/platform/desktopRecovery.ts:10` | Tauri command | 重启后端 / 打开日志 / 导出脱敏诊断 | 启动失败与全局异常 |
| React 渲染异常边界 | 已实现 | `src/components/errors/AppErrorBoundary.tsx:13` | `info.componentStack` | — | 全局 |
| 滚动与图片预算诊断（默认关闭，仅内存环形缓冲） | 已实现 | `src/utils/scrollDiagnostics.ts:131`、`src/utils/scrollDiagnostics.ts:219` | 运行时采样 | — | 全局（开发诊断） |
| OpenList 今日请求遥测 | 已实现 | `src/components/settings/OpenListSettingsPanel.tsx:438` | 连接器计数 | `GET /api/openlist/telemetry/today`（`backend/app/api/openlist_v4.py:677`） | 设置 › WebDAV 目录 |
| 错误日志 API 客户端（列表/统计/导出/解决/清理） | 部分实现 | `src/api/errorLog.ts:23`、`backend/app/api/error_log.py:28` | 错误日志表 | `GET /api/error-log`、`/stats`、`/export`、`POST /resolve`、`/resolve-all`、`/purge`、`DELETE /{error_id}` | 无界面：`src/api/errorLog.ts` 未被任何组件导入 |
| 错误日志独立浏览页面 | 未实现 | — | — | 后端接口已存在 | 无页面组件 |

## 16. 首次引导

| 功能 | 状态 | 实现位置 | 数据来源 | 依赖接口 | 当前页面 |
|---|---|---|---|---|---|
| 四步引导（欢迎 / 播放器 / 媒体来源 / 完成设置） | 已实现 | `src/pages/FirstRunSetup.tsx:19`、`src/pages/FirstRunSetup.tsx:27` | 引导表单 | `POST /api/config/setup/*`（`backend/app/api/config.py:359`–`455`） | FirstRunSetup |
| 播放器模式与 MPV 校验 | 已实现 | `src/pages/FirstRunSetup.tsx:74` | `POST /api/config/test/mpv` | `backend/app/api/config.py:563` | 首步引导 |
| 媒体来源目录选择与校验 | 已实现 | `src/pages/FirstRunSetup.tsx:168` | `POST /api/config/setup/sources` | `backend/app/api/config.py:440` | 引导 |
| 可选凭据（TMDB / Bangumi） | 已实现 | `src/pages/FirstRunSetup.tsx:195` | `POST /api/config/setup/credentials/tmdb` | `backend/app/api/config.py:447` | 引导 |
| 「稍后设置」推迟引导 | 已实现 | `src/App.tsx:56` | `setup_deferred` | `POST /api/config/setup/defer`（`backend/app/api/config.py:359`） | 全局 |
| 从设置重新进入引导（重新配置） | 已实现 | `src/App.tsx:234` | `mode='reconfigure'` | 同上 | 设置 › 应用 |
| 启动闪屏（配置就绪前） | 已实现 | `src/components/shell/StartupSplash.tsx:3`、`index.html`（`#kumi-boot-splash`） | 内嵌样式 | — | 全局 |
| 引导要求配置镜像目录 | 已废弃 | `src/pages/FirstRunSetup.tsx:19`（步骤中无镜像目录） | — | 无对应步骤 | — |

## 17. 未接入与已退役能力清单

| 能力 | 状态 | 证据 |
|---|---|---|
| 追加剧集（手工追加单集） | 未接入 | `src/api/workDetailV4Compatibility.ts:9` 能力开关 `appendEpisodes: false`；`src/api/workDetailV4Compatibility.ts:143`、`src/api/workDetailV4Compatibility.ts:148` 调用直接 reject“追加剧集尚未接入 V4 数据流”；`src/pages/WorkDetailPage.tsx:1573` 菜单项按开关条件渲染；后端无对应路由（`backend/app/api/media_v4.py` 无 append 端点） |
| 镜像物化作业（`materialize_mirror`） | 已退役 | `backend/app/media_v4/jobs/runner.py:59`：命中该类型直接 `mark_cancelled`；`backend/app/media_v4/jobs/runner.py:345`：后台收口待清理的 `legacy_types`；`src/components/media/LibraryMaintenancePanel.tsx:44` 仍保留标签 `materialize_mirror: '生成镜像'` |
| 受管工件清理作业（`cleanup_superseded_artifacts`） | 已退役 | 同 `backend/app/media_v4/jobs/runner.py:59` 与 `backend/app/media_v4/jobs/runner.py:345` |
| 旧 `scrape_work` / `recover_work_aliases` 作业（非 `sqlite-artwork-v1` 策略） | 已退役 | `backend/app/media_v4/jobs/runner.py:67`、`backend/app/media_v4/jobs/runner.py:349` 判定 `runtime_policy != 'sqlite-artwork-v1'` 时取消，不伪造成功 |
| STRM 生成（`.strm` 路径） | 已退役 | `backend/app/media_v4/jobs/artifact_paths.py:9`、`artifact_paths.py:200`、`artifact_paths.py:217` 仍保留 `mirror_relative_path` / `.strm` 路径推导，但调用它的物化链已在 `runner.py:59` 取消 |
| NFO 工件（`.nfo`） | 已退役 | `backend/app/media_v4/jobs/artifact_paths.py:231`、`artifact_paths.py:239` 保留 NFO 路径推导；`backend/app/api/assets.py:1` 明确“NFO 已退役”；前端不再消费：`src/api/types.ts:53` 的 `title_provenance='nfo'` 仅为类型联合中的历史取值 |
| 旧远程图片代理 | 已退役 | `backend/app/api/assets.py:1`（远程代理已退役）；`src/api/assets.ts:16` 对非 `/api/assets/artwork/...` 路径一律返回空字符串；`src/utils/artwork.ts:20` 注释“浏览请求不回退原图或远程下载” |
| 请求现场缩图 / `thumbnailWidth` / `cacheOnly` 参数 | 已退役 | `src/api/assets.ts:10` 形参命名为 `_options` 且函数体不读取；`src/api/assets.ts:13` 只接受固定四档宽度的已发布路径 |
| 来源镜像目录（`mirror_dir`） | 已退役 | `src/api/config.ts:33` 字段仍存在；`src/pages/FirstRunSetup.tsx:19` 引导不再要求配置；`backend/app/media_v4/jobs/runner.py:162` 仅在清理旧任务时读取 `load_config().mirror_dir` |
| V3 执行链目录（`catalog/`、`import_plan/`、`import_pipeline/`、`mirror/`、`raw/`、`sources/`、`tasks/`、`tracking/`、`library/`、`media_presets/`、`jobs/`、`db/`、`pipeline/`） | 已废弃 | 均为空目录（`find backend/app/<dir> -type f` 计数为 0）；`docs/PROJECT.md` 第 3 节明确不得恢复 |
| 旧镜像、remote、thumbnail/prepare 路由 | 已退役 | `backend/app/main.py:180` 只注册 `assets_router`；该路由文件只有一个 GET 端点（`backend/app/api/assets.py:12`） |
| 图片缓存 GC 端点 | 未接入前端 | `backend/app/api/media_v4.py:78`、`backend/app/api/media_v4.py:100` 已实现；`src/` 中无 `artwork-cache` 字符串 |
| 错误日志浏览界面 | 未实现 | `src/api/errorLog.ts` 存在但无导入方；无 `src/pages/ErrorLog*.tsx` |
| 独立“播放调校”生产导航入口 | 未确认 | `src/pages/PlayerTuningPage.tsx` 以 `embedded` 形式内嵌于设置播放分类（`src/pages/SettingsPage.tsx:662`），侧栏与标题栏导航项中没有独立入口；不排除存在未发现的其他调用方 |
| `GET /api/v4/tracking/works` 的前端消费 | 部分实现 | 客户端封装在 `src/api/mediaV4.ts:704`，未在 `src/` 其他位置被调用 | |
| `POST /api/system/shutdown` | 已实现但非用户界面入口 | `backend/app/api/system.py:20`；`src/api/system.ts:19` 只封装 `openFolder` 与 `shutdown`，界面仅调用 `openFolder`（`src/pages/WorkDetailPage.tsx:1252`） |

## 18. 未确认项

- **`/api/v4/artwork-cache/*` 是否有其他调用方**：仅在 `backend/app/api/media_v4.py` 发现定义，前端无引用；未确认是否存在脚本或测试直接调用。原因：本次只检索 `src/` 与 `backend/app/api/`，未全量扫描 `scripts/` 与 `backend/tests/`。
- **外部 MPV 模式下 AniList/联网核对是否可用**：`src/pages/PlayerTuningPage.tsx` 与 `src/pages/SettingsPage.tsx` 均可配置，但未确认这些开关在 `player_mode='external'` 时的运行时差异。
- **`title_provenance='nfo'` 是否仍可能被写入**：`src/api/types.ts:53` 保留该取值，未在 `backend/app/media_v4/` 中确认写入路径是否已全部移除；只能确认 NFO 工件与读取路径已退役。
- **搜索是否覆盖 Provider 在线搜索**：`src/pages/SearchPage.tsx` 只对本地 `works` 做文本匹配，未发现调用线上搜索端点的前端代码；不排除后端另有入口。
- **硬件解码 / 转码参数界面**：`src/pages/PlayerTuningPage.tsx` 只暴露播放器模式与 Anime4K 模式、质量；未在 `src/` 中发现独立的硬解或转码参数入口。原因：本次只按页面与设置分类检索，未确认 MPV 自有配置层（`mpv/config/kumiplayer`）中是否含由界面写入的其他参数。
- **图片派生宽度的实际生成完成度**：`backend/app/media_v4/assets/catalog.py:18` 定义了 6 类角色的宽度档，但未逐条验证所有角色在所有作品上确实产出全档位；发布门槛只约束“必需图”角色。
