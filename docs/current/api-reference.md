# 后端接口参考（重构前置）

> 记录日期：2026-10-14
> 事实来源：`backend/app/api/*.py`（路由定义与行号）、`backend/app/main.py`（路由器注册）、`src/api/*.ts`（前端调用位置与期望形状）
> 定位：回答「后端一共有哪些接口、每个接口做什么、谁在调用、前端拿到什么字段」。用于新前端的请求层与数据契约设计。**不回答界面如何呈现**。

## 1. 覆盖率声明（先读）

- 全部端点由脚本从 `backend/app/api/*.py` 提取：**131 个路由装饰器**（`grep -c '@router\.\(get\|post\|put\|patch\|delete\)'` 实测）。
- 第 4 节给出**全部 131 个端点的清单**（方法、路径、定义位置、前端调用位置）。
- 第 5 节给出**前端实际消费的核心端点契约**（请求 / 响应字段），字段依据 `src/api/*.ts` 的实际类型声明与调用代码。
- 第 6 节列出**前端未消费或仅内部使用的端点**。
- 没有为全部 131 个端点逐一展开响应字段：涉及大量内部 / 维护端点，展开会显著增加篇幅而设计价值有限。未展开的端点以清单 + 定义位置为准，需要时可直接读对应函数。

## 2. 通用约定

| 项 | 内容 | 依据 |
|---|---|---|
| Base URL | 开发模式走 Vite proxy（相对路径）；Tauri 生产页面直连 `http://127.0.0.1:37821` | `src/api/client.ts:6-9` |
| 鉴权 | 每个业务请求带 `X-KumiPlayer-Token`（桌面壳生成的 256-bit 随机会话 Token） | `src/api/client.ts:18-31`、`src/api/sessionToken.ts` |
| 例外鉴权方式 | 浏览器无法设置 Header 的场景（图片 GET、WebSocket）使用受限查询参数 | `docs/current/system-overview.md` 第 6 节 |
| 请求封装 | `authorizedFetch` 统一注入会话头；`requestJson` 带 `AbortController` 超时（默认 30000 ms，响应体读取期间保持超时） | `src/api/client.ts:18-60` |
| 内容类型 | 非 FormData 请求默认 `Content-Type: application/json` | `src/api/client.ts:49` |
| 错误形状 | 非 2xx 时先读 `body.detail` 作为消息，失败则回退 `HTTP <status>`；抛出 `ApiError`（含 `status`） | `src/api/client.ts:10-16`、`:55-60` |
| 范围冲突 | 来源范围冲突返回 **409**，且保持事务回滚 | `docs/PROJECT.md` 第 6 节 |
| 展示门槛 | 后台尚未发布时列表可能返回暂时空列表；`generation_id` / `updating` / `background_active` 用于区分「首次未发布 / 已发布空库 / 后台更新中」 | `docs/PROJECT.md` 第 7 节、`src/api/library.ts:11-20` |
| bundled 模式 | 关闭 `/docs`、`/redoc`、`/openapi.json`，因此**不能依赖运行时 OpenAPI 文档** | `docs/PROJECT.md` 第 4.3 节 |

## 3. 路由器总览

| 前缀 | 定义文件 | 端点数 | 主要消费方 |
|---|---|---|---|
| `/api/v4` | `backend/app/api/media_v4.py`（`main.py:181`） | 48 | 媒体管理页、详情页、`src/api/mediaV4.ts` |
| `/api/config` | `backend/app/api/config.py`（`main.py:177`） | 18 | 首次引导、设置页、`src/api/config.ts` |
| `/api/integrations/bangumi` | `backend/app/api/bangumi.py`（`main.py:178`） | 16 | 设置页 Bangumi 分类、详情页、`src/api/bangumi.ts` |
| `/api/openlist` | `backend/app/api/openlist_v4.py`（`main.py:186`） | 10 | 设置页 OpenList 分类、`src/api/openlist.ts` |
| `/api/library` | `backend/app/api/library_v4.py`（`main.py:175`） | 9 | 首页 / 分类 / 搜索 / 收藏 / 最近 / 详情、`src/api/library.ts` |
| `/api/playback` | `backend/app/api/playback_v4.py`（`main.py:183`） | 8 | 详情页播放、最近观看、`src/api/playback.ts` |
| `/api/error-log` | `backend/app/api/error_log.py`（`main.py:179`） | 7 | **前端无消费者**（`src/api/errorLog.ts` 无导入方） |
| `/api/v4/tracking` | `backend/app/api/tracking_v4.py`（`main.py:184`） | 5 | 分类页新番、`src/api/mediaV4.ts:704-714` |
| `/api/tasks` | `backend/app/api/tasks_v4.py`（`main.py:185`） | 4 | 导入与任务面板、`src/api/tasks.ts` |
| `/api/v4/work-customization` | `backend/app/api/work_customization_v4.py`（`main.py:182`） | 3 | 详情页自定义标签、`src/api/workCustomization.ts` |
| `/api/system` | `backend/app/api/system.py`（`main.py:187`） | 2 | 详情页「打开文件夹」、`src/api/system.ts` |
| `/api/assets` | `backend/app/api/assets.py`（`main.py:180`） | 1 | 所有图片展示 |
| `/api/health`、`/api/heartbeat`、`/ws/heartbeat` | `backend/app/api/heartbeat.py` | 3 | 启动就绪、连接状态 |

前缀来源：各文件的 `APIRouter(prefix=...)` 声明；注册顺序来源 `backend/app/main.py:175-187`。

## 4. 全量端点清单

定义位置列为 `backend/app/api/<文件>:<行号>`。

### 4.1 `/api/library`（`library_v4.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/` | 175 | `src/api/library.ts:40`（列表） |
| GET | `/changes` | 238 | `src/api/library.ts:33` |
| GET | `/cards` | 254 | `src/api/library.ts:34` |
| GET | `/works/{work_id}` | 259 | `src/api/library.ts:44`（详情） |
| GET | `/diagnostics` | 304 | `src/api/library.ts:48`（**当前无调用方**） |
| GET | `/watch-status` | 311 | 未确认（前端未见调用） |
| GET | `/watch-status/{work_id}` | 318 | `src/api/library.ts:51` |
| PATCH | `/watch-status/{work_id}` | 328 | `src/api/library.ts:53` |
| POST | `/rescan` | 370 | `src/api/library.ts:46`、`src/api/tasks.ts:32`（**当前无调用方**） |

### 4.2 `/api/playback`（`playback_v4.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| POST | `/play` | 61 | `src/api/playback.ts:29` |
| POST | `/stop` | 78 | `src/api/playback.ts:33` |
| GET | `/status` | 83 | `src/api/playback.ts:37` |
| POST | `/progress` | 88 | `src/api/playback.ts:60` |
| POST | `/progress/mark` | 105 | `src/api/playback.ts:63` |
| POST | `/progress/mark-through` | 114 | `src/api/playback.ts:66` |
| GET | `/progress` | 125 | `src/api/playback.ts:56` |
| GET | `/history` | 143 | `src/api/playback.ts:50` |

### 4.3 `/api/assets`（`assets.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/artwork/{resource_id}/{content_version}/{width}` | 12 | `src/api/assets.ts:13`（约束到四档宽度） |

### 4.4 `/api/v4`（`media_v4.py`，48 个）

| 方法 | 路径 | 行 |
|---|---|---|
| POST | `/artwork-cache/preview` | 78 |
| POST | `/artwork-cache/confirm` | 100 |
| POST | `/sources/scan` | 881 |
| POST | `/imports/preview` | 1142 |
| POST | `/imports/{revision_id}/confirm` | 1268 |
| POST | `/imports/{revision_id}/cancel` | 1316 |
| PATCH | `/imports/{revision_id}/evidence/{evidence_id}` | 1416 |
| GET | `/imports/{revision_id}` | 1432 |
| GET | `/revisions/{revision_id}/works/{work_id}/execution-detail` | 1448 |
| GET | `/sources/drafts` | 1493 |
| GET | `/imports/{revision_id}/evidence` | 1528 |
| GET | `/sources/libraries` | 1576 |
| GET | `/sources/libraries/{root_id}/diagnostics` | 1590 |
| GET | `/sources/scans/{scan_id}/directory-check` | 1601 |
| DELETE | `/sources/libraries/{root_id}` | 1612 |
| GET | `/sources/libraries/{root_id}/deletion-preview` | 1626 |
| POST | `/sources/libraries/{root_id}/deletion` | 1642 |
| PATCH | `/sources/libraries/{root_id}` | 1659 |
| POST | `/sources/scans` | 1954 |
| GET | `/sources/scans/{scan_id}` | 2071 |
| POST | `/sources/scans/{scan_id}/cancel` | 2103 |
| PATCH | `/works/{work_id}/title` | 2126 |
| DELETE | `/works/{work_id}/title` | 2154 |
| POST | `/works/{work_id}/artwork` | 2169 |
| DELETE | `/works/{work_id}/artwork/{kind}` | 2242 |
| GET | `/works/{work_id}/folder` | 2262 |
| POST | `/works/{work_id}/scrape` | 2292 |
| POST | `/works/{work_id}/delete-preview` | 2318 |
| POST | `/works/{work_id}/delete-confirm` | 2330 |
| GET | `/sources/openlist/status` | 2348 |
| GET | `/jobs` | 2385 |
| POST | `/jobs/{job_id}/run` | 2398 |
| POST | `/imports/{revision_id}/scrape` | 2414 |
| POST | `/library-maintenance/delete-preview` | 2425 |
| POST | `/library-maintenance/delete-confirm` | 2445 |
| POST | `/library-maintenance/delete-resume` | 2464 |
| GET | `/library` | 2480 |
| POST | `/playback/progress` | 2493 |
| GET | `/playback/progress/{episode_id}/{asset_id}` | 2511 |
| POST | `/tracking/state` | 2519 |
| GET | `/tracking/state/{work_id}/{provider}` | 2536 |
| POST | `/metadata/search` | 2562 |
| POST | `/metadata/artifacts/retry` | 2664 |
| POST | `/metadata/retry` | 2703 |
| POST | `/works/{work_id}/identity-repair-preview` | 2777 |
| POST | `/identity-repair/apply` | 2791 |
| POST | `/identity-repair/resume` | 2809 |
| POST | `/metadata/confirm` | 2823 |

前端调用位置（动态路径由 `src/api/mediaV4.ts` 拼接）：`/sources/libraries` `:617`、`/sources/libraries/{id}` `:626`/`:662`、`/sources/libraries/{id}/diagnostics` `:620`、`/sources/libraries/{id}/deletion-preview` `:651`、`/sources/libraries/{id}/deletion` `:656`、`/sources/scans`（durable 扫描入口，`mediaV4.ts:758`）、`/sources/scans/{id}`（`:761`）、`/sources/scans/{id}` `:761`、`/sources/scans/{id}/cancel` `:764`、`/sources/scans/{id}/directory-check` `:623`、`/sources/openlist/status` `:738`、`/sources/drafts` `:666`、`/imports/preview` `:599`、`/imports/{id}` `:611`、`/imports/{id}/confirm` `:602`、`/imports/{id}/cancel` `:605`、`/imports/{id}/evidence` `:735`、`/imports/{id}/evidence/{eid}` `:608`、`/imports/{id}/scrape` `:767`、`/revisions/{id}/works/{wid}/execution-detail` `:614`、`/library` `:769`、`/library-maintenance/delete-preview` `:669`、`/library-maintenance/delete-confirm` `:672`、`/library-maintenance/delete-resume` `:675`、`/works/{id}/title` `:687`/`:690`、`/works/{id}/artwork` `:693`、`/works/{id}/artwork/{kind}` `:696`、`/works/{id}/folder` `:699`、`/works/{id}/scrape` `:702`、`/works/{id}/delete-preview` `:729`、`/works/{id}/delete-confirm` `:732`、`/works/{id}/identity-repair-preview` `:678`、`/identity-repair/apply` `:681`、`/identity-repair/resume` `:684`、`/metadata/search` `:717`、`/metadata/confirm` `:726`、`/metadata/retry` `:720`、`/metadata/artifacts/retry` `:723`、`/playback/progress` `:778`。

**未被前端消费的 `/api/v4` 端点**：`/artwork-cache/preview`、`/artwork-cache/confirm`、`/sources/scan`（`src/api/mediaV4.ts:586` 有封装但页面走 durable 扫描入口）、`/jobs`、`/jobs/{job_id}/run`、`/playback/progress/{episode_id}/{asset_id}`、`/tracking/state`、`/tracking/state/{work_id}/{provider}`。

### 4.5 `/api/v4/tracking`（`tracking_v4.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/works` | 51 | `src/api/mediaV4.ts:704`（**无消费组件**） |
| GET | `/sources` | 78 | `src/api/mediaV4.ts:706` |
| POST | `/scan-all` | 152 | `src/api/mediaV4.ts:708` |
| POST | `/{work_id}/scan` | 158 | `src/api/mediaV4.ts:711` |
| POST | `/scans/{scan_id}/cancel` | 167 | `src/api/mediaV4.ts:714` |

### 4.6 `/api/v4/work-customization`（`work_customization_v4.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/{work_id}` | 40 | `src/api/workCustomization.ts:30` |
| PUT | `/{work_id}` | 62 | `src/api/workCustomization.ts:30` |
| GET | `/{work_id}/extra-videos` | 93 | 未确认（前端未见调用） |

### 4.7 `/api/tasks`（`tasks_v4.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/` | 66 | `src/api/tasks.ts:20` |
| GET | `/{task_id}` | 81 | `src/api/tasks.ts:24` |
| POST | `/{task_id}/cancel` | 99 | `src/api/tasks.ts:27` |
| POST | `/{task_id}/retry` | 134 | `src/api/tasks.ts:30` |

### 4.8 `/api/config`（`config.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/` | 165 | `src/api/config.ts:165` |
| PATCH | `/` | 173 | `src/api/config.ts:166` |
| GET | `/setup/status` | 334 | 未确认（首次引导走 GET `/` 的 `setup_*` 字段） |
| POST | `/test/mpv-path` | 351 | `src/api/config.ts:170`/`:172` |
| POST | `/setup/defer` | 359 | `src/api/config.ts:173` |
| POST | `/setup/player` | 431 | `src/api/config.ts:174` |
| POST | `/setup/sources` | 440 | `src/api/config.ts:175` |
| POST | `/setup/credentials/tmdb` | 447 | `src/api/config.ts:176` |
| POST | `/setup/complete` | 455 | `src/api/config.ts:177` |
| POST | `/test/tmdb-images` | 499 | `src/api/config.ts:179` |
| POST | `/tmdb-images/repair` | 504 | `src/api/config.ts:181` |
| GET | `/tmdb-images/repair/{job_id}` | 512 | `src/api/config.ts:183` |
| GET | `/mpv-runtime` | 520 | `src/api/config.ts:167` |
| POST | `/mpv-runtime/open-config` | 532 | `src/api/config.ts:168` |
| POST | `/test/mpv` | 563 | `src/api/config.ts:171` |
| POST | `/test/tmdb` | 569 | `src/api/config.ts:178` |
| POST | `/test/deepseek` | 586 | `src/api/config.ts:184` |
| POST | `/test/media-paths` | 618 | `src/api/config.ts:185` |

### 4.9 `/api/openlist`（`openlist_v4.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| GET | `/connections` | 123 | `src/api/openlist.ts:125` |
| POST | `/connections` | 128 | `src/api/openlist.ts:125` |
| POST | `/test-connection` | 299 | `src/api/openlist.ts:127` |
| POST | `/config` | 347 | `src/api/openlist.ts:129` |
| GET | `/browse` | 443 | `src/api/openlist.ts:132` |
| POST | `/prefetch` | 537 | `src/api/openlist.ts:135` |
| GET | `/routes` | 582 | `src/api/openlist.ts:139`、`:136` |
| POST | `/routes/discover` | 588 | `src/api/openlist.ts:137` |
| PUT | `/routes` | 630 | `src/api/openlist.ts:139` |
| GET | `/telemetry/today` | 677 | `src/api/openlist.ts:142` |

### 4.10 `/api/integrations/bangumi`（`bangumi.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| POST | `/token` | 167 | `src/api/bangumi.ts`（会话写入） |
| DELETE | `/token` | 199 | 退出登录 |
| GET | `/me` | 211 | 用户信息 |
| GET | `/session` | 220 | 本地会话恢复（启动时零远程请求） |
| POST | `/session/verify` | 247 | 超 TTL 的后台验证 |
| GET | `/avatar` | 299 | 头像图片（受限查询参数鉴权） |
| GET | `/subject-image` | 305 | 条目图片（受限查询参数鉴权） |
| POST | `/search` | 371 | 详情页候选搜索 |
| GET | `/matches/{work_id}` | 529 | 详情页当前匹配 |
| POST | `/matches/{work_id}` | 538 | 确认匹配 |
| DELETE | `/matches/{work_id}` | 551 | 取消匹配 |
| GET | `/episodes/{work_id}` | 562 | 分集同步状态 |
| PATCH | `/collections/{work_id}` | 593 | 收藏类型 |
| GET | `/collections/{work_id}` | 606 | 收藏查询 |
| PUT | `/episodes/{episode_id}/watched` | 675 | 单集已看 |
| POST | `/progress/{work_id}/sync` | 822 | 进度同步 |

### 4.11 `/api/system`（`system.py`）、`/api/error-log`（`error_log.py`）

| 方法 | 路径 | 行 | 前端调用位置 |
|---|---|---|---|
| POST | `/api/system/shutdown` | `system.py:20` | `src/api/system.ts:19` 封装，**界面未接入** |
| POST | `/api/system/open-folder` | `system.py:40` | `src/api/system.ts:15`，详情页使用 |
| GET | `/api/error-log/` | `error_log.py:28` | **无消费者** |
| GET | `/api/error-log/stats` | `error_log.py:35` | `src/api/errorLog.ts:28`（无导入方） |
| GET | `/api/error-log/export` | `error_log.py:41` | `src/api/errorLog.ts:51` 附近（无导入方） |
| POST | `/api/error-log/resolve` | `error_log.py:75` | `src/api/errorLog.ts:32`（无导入方） |
| POST | `/api/error-log/resolve-all` | `error_log.py:82` | `src/api/errorLog.ts:39`（无导入方） |
| DELETE | `/api/error-log/{error_id}` | `error_log.py:89` | `src/api/errorLog.ts:43`（无导入方） |
| POST | `/api/error-log/purge` | `error_log.py:96` | `src/api/errorLog.ts:51`（无导入方） |

## 5. 核心端点契约（前端重建必需）

### 5.1 媒体库读取

**`GET /api/library`**（`library_v4.py:175`，可选 `?source=`）

响应（`src/api/library.ts:11-20`）：

| 字段 | 类型 | 用途 |
|---|---|---|
| `works` | `LibraryCard[]` | 卡片数组，字段见 5.1.1 |
| `summary` | `{ work_count, episode_count }` | 统计 |
| `generated_at` | string | 生成时间 |
| `generation_id` | string | 代数；用于识别「首次未发布 / 已重建」 |
| `updating` | boolean | 后台是否正在更新 |
| `background_active` | boolean? | 后台活动（影响轮询节奏） |
| `change_sequence` | number | 同快照的变更游标起点 |
| `digest` | string | 快照摘要 |

**`GET /api/library/changes?after=<seq>&limit=<n>`**（`library_v4.py:238`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `changes[].sequence` | number | 变更序号 |
| `changes[].kind` | `work_upsert` \| `work_remove` \| `artwork` \| `watch` \| `reset` | 变更种类 |
| `changes[].work_id` | string | 受影响作品 |
| `next_sequence` | number | 下次起点 |
| `has_more` | boolean | 还有更多 |
| `reset_required` | boolean | 游标失效，需要全量同步 |
| `generation_id` / `updating` / `background_active` | — | 与列表同义 |

**`GET /api/library/cards?work_ids=a,b,c`** → `{ works: LibraryCard[] }`（`library_v4.py:254`）

#### 5.1.1 `LibraryCard` / `WorkIndex` 字段（`src/api/types.ts:44-113`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `work_id` | string | 作品标识 |
| `title` / `original_title` | string | 标题 / 原始标题 |
| `title_provenance` | `manual` \| `nfo` \| `online` \| `local` | 标题来源（`nfo` 为历史取值） |
| `year` / `rating` / `plot` / `genres` / `studios` / `tags` | — | 资料字段 |
| `show_type` | `anime_series` \| `anime_movie` \| `live_series` \| `live_movie` \| `''` | 内容类型 |
| `media_type` | `tv` \| `movie` \| `unknown` \| `''` | 媒体类型 |
| `card_type` | `main_series` \| `standalone` | 卡片类型 |
| `content_scope` | `completed` \| `ongoing` | 来源声明的内容范围（与观看状态分开） |
| `metadata_state` | `ready` \| `not_required` \| `waiting_metadata` \| `waiting_review` \| `source_unavailable` \| `failed` | 资料状态 |
| `metadata_source` | `current` \| `retained` \| `local` | 资料来源 |
| `refresh_status` | `pending` \| `not_requested` \| `succeeded` \| `partial` \| `failed` \| `cancelled` | 刷新状态 |
| `episode_mapping_status` | `not_applicable` \| `complete` \| `partial` \| `unmapped` | 集号映射状态 |
| `mapped_count` / `total_count` | number | 已映射 / 总数 |
| `episode_count` / `asset_count` / `main_episode_count` / `season_count` / `special_season_count` | number | 计数（`main_episode_count` 与 `total` 语义不同，见 OPT-12） |
| `latest_episode_number` | number? | 最新集号（新番用） |
| `artwork` | `Partial<Record<'poster'\|'fanart'\|'clearlogo', ArtworkResource>>` | 已发布图片资源 |
| `poster_path` / `fanart_path` / `clearlogo_path` / `local_*_path` | string | 本地图片路径 |
| `artwork_provenance` | `Record<'poster'\|'fanart'\|'clearlogo', string>` | 图片来源 |
| `seasons` | `SeasonIndex[]` | 季度 |
| `episodes` | `EpisodeIndex[]` | 剧集 |
| `related_works` | `RelatedWork[]` | 关联作品 |
| `cast` | `{ name, role, profile_path }[]` | 演员 |
| `certification` / `certification_country` | string | 分级 |
| `source` / `sources` / `provider_id` / `ingest_method` / `source_route_id` | — | 来源信息（内容来源 / 导入方式 / 路由） |
| `watch_status` | `{ work_id, status, note, favorite, updated_at }` | 观看状态与收藏 |
| `last_played` | string \| null | 最近播放 |
| `source_locations` | `Record<string, string[]>` | 来源位置 |

- `ArtworkResource`：`{ resource_id, content_version, state: 'ready', variants: Record<string, string> }`（`src/api/types.ts:120-125`）。
- 详情端点 `GET /api/library/works/{work_id}` 返回 `WorkDetail = WorkIndex & { studios: string[]; tags: string[] }`；**列表卡片不承诺 `cast` / 完整资料字段**（`src/api/types.ts:114-115` 注释）。

#### 5.1.2 观看状态

- `GET /api/library/watch-status/{work_id}`、`PATCH /api/library/watch-status/{work_id}`（body：`{ status, note, favorite }`）→ `LocalWatchStatus`：`{ work_id, status: ''|'watching'|'watched'|'on_hold'|'dropped', note, favorite, updated_at }`（`src/api/library.ts:22-34`）。
- 后端 `/watch-status` 列表会过滤 `provider='local'`，不把 Bangumi 状态当本地观看状态（`docs/项目现状与改进清单.md` DEF-05）。

### 5.2 图片

**`GET /api/assets/artwork/{resource_id}/{content_version}/{width}`**（`assets.py:12`）

- 只读取**已发布的本地派生资源**；旧镜像、remote、thumbnail/prepare 路由已退役。
- 前端只接受固定宽度档，非该形式路径一律返回空字符串（`src/api/assets.ts:10-16`）。
- 前端 artwork 正则与后端 `RECIPE_VERSION` / `ROLE_WIDTHS` 必须保持一致（OPT-11）。
- 鉴权：图片 GET 走受限查询参数（浏览器无法设置 Header）。

### 5.3 播放与进度

| 端点 | 请求 | 响应 | 前端 |
|---|---|---|---|
| `POST /api/playback/play` | `{ work_id, episode_id, asset_id? }` | `{ session_id, status, work_id, episode_id, asset_id, playback_locator }` | `src/api/playback.ts:29` |
| `POST /api/playback/stop` | — | `{ status, session_id? }` | `:33` |
| `GET /api/playback/status` | — | `{ status, session: PlaybackSession \| null }`；`PlaybackSession = { session_id, work_id, episode_id, asset_id, playback_locator, status }` | `:37` |
| `POST /api/playback/progress` | `{ work_id, episode_id, asset_id?, position, duration, completed? }` | `PlaybackHistoryItem` | `:60` |
| `POST /api/playback/progress/mark` | `{ work_id, episode_id, asset_id?, completed }` | `PlaybackHistoryItem` | `:63` |
| `POST /api/playback/progress/mark-through` | `{ work_id, episode_id }` | `{ work_id, episode_ids }` | `:66` |
| `GET /api/playback/progress?work_id=` | — | `{ items: PlaybackHistoryItem[] }` | `:56` |
| `GET /api/playback/history?limit=&work_id=` | — | `{ items: PlaybackHistoryItem[] }` | `:50` |

`PlaybackHistoryItem`（`src/api/types.ts:157-172`）：`work_id`、`episode_id`、`asset_id`、`position`、`duration`、`completed`、`updated_at`；历史读模型额外补充 `episode_title`、`season_number`、`episode_number`、`thumb_path`、`played_at`、`season_snapshot`、`episode_snapshot`、`title_snapshot`。

注意：V4 另有一组 `/api/v4/playback/progress*`（`media_v4.py:2493`、`:2511`）与 `/api/library` 同库；前端 `src/api/mediaV4.ts:778` 与 `src/api/playback.ts:60` 两个进度写入端点并存，属已知技术债（见 `frontend-analysis.md` 第 9 节）。

### 5.4 导入与扫描（`/api/v4`）

| 端点 | 请求（关键） | 响应（关键字段） |
|---|---|---|
| `POST /imports/preview` `:1142` | `src/api/mediaV4.ts:588-599` 的扫描/来源参数 | `V4Preview`：`status`（`draft`/`confirmed`）、`works: V4ResolvedWork[]`、`episodes: V4ResolvedEpisode[]`、`issues: V4ReviewIssue[]` |
| `POST /imports/{revision_id}/confirm` `:1268` | — | `{ revision_id, status, jobs: V4Job[] }` |
| `POST /imports/{revision_id}/cancel` `:1316` | — | `{ revision_id, running, cancelled }` |
| `PATCH /imports/{revision_id}/evidence/{evidence_id}` `:1416` | `{ changes: Record<string, unknown> }` | `V4Preview`（人工覆盖，不修改 ParsedFacts） |
| `GET /imports/{revision_id}` `:1432` | — | `{ revision_id, status, jobs, progress: V4ExecutionProgress }` |
| `GET /revisions/{revision_id}/works/{work_id}/execution-detail?episode_offset=` `:1448` | — | `V4WorkExecutionDetail`（作品级作业明细） |
| `POST /sources/scans` `:1954` / `GET /sources/scans/{scan_id}?include_entries=` `:2071` / `POST .../cancel` `:2103` | POST 请求为扫描参数；POST 响应 `{ scan_id, root_id, scan_mode, source_mode?, status, evidence_count?, effective_playback_root?, path_validation? }`（`src/api/mediaV4.ts:758`）；GET 响应含 `status`、`stage`、`stage_label`、`processed_count`、`total_count`、`discovered_count?`、`current_directory?`、`directories_completed?`、`directories_pending?`、`resumable?`、`progress?`、`heartbeat_at?`、`cancel_requested?`、`entries: V4SourceEvidence[]`（`src/api/mediaV4.ts:761`） | 扫描状态与目录条目 |
| `GET /sources/libraries` `:1576` | — | `{ cards: V4SourceLibraryCard[] }`（来源卡） |
| `GET /sources/libraries/{root_id}/diagnostics` `:1590` | — | `V4SourceDiagnosticsReport` |
| `GET /sources/scans/{scan_id}/directory-check` `:1601` | — | `V4SourceDirectoryCheck` |
| `DELETE /sources/libraries/{root_id}` `:1612` | — | `{ root_id, hidden }`（隐藏卡片） |
| `GET /sources/libraries/{root_id}/deletion-preview` `:1626` / `POST .../deletion` `:1642` | — | 预览 + `{ root_id, job_id, status }` |
| `PATCH /sources/libraries/{root_id}` `:1659` | 显示名 | `{ root_id, display_name }` |
| `GET /sources/drafts` `:1493` | — | `{ drafts: V4DraftSummary[] }` |
| `GET /sources/openlist/status?remote_root=&connection_id=` `:2348` | — | 映射可用状态 |
| `POST /sources/scan` `:881` | 同步入口 | **页面未使用**（页面走 durable 入口） |

`V4ExecutionProgress`（`src/api/mediaV4.ts:514-521`）：`status: 'idle'|'running'|'failed'|'cancelled'|'queued'|'succeeded'|'needs_attention'`、`total`、`queued`、`running`、`succeeded`、`failed`、`cancelled`。

### 5.5 元数据与刮削

| 端点 | 请求 | 响应 |
|---|---|---|
| `POST /metadata/search` `:2562` | `{ work_id, query?, media_type?, year? }` | `{ work_id, candidates: [{ candidate_id, provider_id, media_type, title, original_title, year, aliases }] }` |
| `POST /metadata/confirm` `:2823` | `{ work_id, candidate_id, scope?: 'work'\|'season', season_number? }` | `{ work_id, candidate_id, provider, provider_id, status: 'accepted', job_ids, scope, season_number, episode_mapping_status, mapped_count, total_count, refresh_status, reason_codes }` |
| `POST /metadata/retry` `:2703` | `{ work_id }` | `{ work_id, revision_id, job_id, status, metadata_recovery_action }` |
| `POST /metadata/artifacts/retry` `:2664` | `{ work_id }` | `{ work_id, revision_id, binding_status, metadata_state, artifact_state, artifact_reasons }` |
| `POST /works/{work_id}/scrape` `:2292` | — | `{ work_id, job_id, status }` |
| `POST /imports/{revision_id}/scrape` `:2414` | — | 批量入队 |
| `GET /jobs` `:2385` / `POST /jobs/{job_id}/run` `:2398` | — | 作业列表与手动执行（未接入前端） |

### 5.6 详情页管理与维护

| 端点 | 请求 | 响应 |
|---|---|---|
| `PATCH /works/{work_id}/title` `:2126` | `{ title }` | `{ work_id, title }` |
| `DELETE /works/{work_id}/title` `:2154` | — | `{ work_id, restored }` |
| `POST /works/{work_id}/artwork` `:2169` | `{ kind, data_base64 }` | `{ path }` |
| `DELETE /works/{work_id}/artwork/{kind}` `:2242` | — | `{ work_id, restored }` |
| `GET /works/{work_id}/folder` `:2262` | — | `{ folder, exists }` |
| `POST /works/{work_id}/delete-preview` `:2318` / `POST .../delete-confirm` `:2330` | — | 删除预览与确认（源媒体永不删除） |
| `POST /library-maintenance/delete-preview` `:2425` | `{ scope, operation_kind?, revision_id? }` | `V4MaintenancePreview` |
| `POST /library-maintenance/delete-confirm` `:2445` | `{ preview_id, scope, digest }` | `V4MaintenanceResult` |
| `POST /library-maintenance/delete-resume` `:2464` | `{ preview_id }` | `V4MaintenanceResult` |
| `POST /works/{work_id}/identity-repair-preview` `:2777` / `POST /identity-repair/apply` `:2791` / `POST /identity-repair/resume` `:2809` | `{ preview_id, digest }` / `{ operation_id }` | `V4IdentityRepairPreview` / `V4IdentityRepairResult` |

### 5.7 任务（`/api/tasks`）

- `GET /api/tasks?` → 任务列表；`GET /api/tasks/{task_id}`；`POST /{task_id}/cancel`；`POST /{task_id}/retry`（`src/api/tasks.ts:20-30`）。
- `TaskRecord`（`src/api/types.ts:196-208`）：`task_id`、`task_type`、`source`、`status: 'pending'|'running'|'succeeded'|'failed'|'cancelled'`、`progress`、`message`、`created_at`、`started_at`、`finished_at`、`error`、`result`。
- 长任务属于后端 TaskRecord；关闭弹窗或切换页面不取消任务（`docs/PROJECT.md` 第 8 节）。

### 5.8 设置、OpenList、Bangumi

- `/api/config`：`GET /` 返回 `PublicConfig`（含 `setup_completed`、`setup_deferred`、`series_card_image_mode`、`poster_size`、来源列表、播放与 OpenList 配置等，见 `src/api/config.ts` 与 `src/App.tsx:170-184` 的实际消费字段）；`PATCH /` 保存；`/setup/*` 首次引导分步写入；`/test/*` 连接测试；`/tmdb-images/repair` 图片修复作业。
- `/api/openlist`：连接（`GET/POST /connections`）、测试（`POST /test-connection`）、写入配置（`POST /config`）、浏览（`GET /browse`）、预取（`POST /prefetch`）、路由（`GET/PUT /routes`、`POST /routes/discover`）、遥测（`GET /telemetry/today`）。
- `/api/integrations/bangumi`：账号（`token`/`me`/`session`/`session/verify`）、图片（`avatar`/`subject-image`，受限查询参数鉴权）、搜索与匹配（`search`/`matches/*`）、收藏（`collections/*`）、分集已看与进度同步（`episodes/*`、`progress/{work_id}/sync`）。
- 凭据（TMDB / Bangumi / OpenList 密码）存 Windows Credential Manager，不进 `config.json`，接口不得回显明文。

### 5.9 系统与健康

| 端点 | 说明 |
|---|---|
| `POST /api/system/open-folder`（`system.py:40`） | ID-only：按作品 / 剧集及可选 Asset 身份读取已保存本地路径 |
| `POST /api/system/shutdown`（`system.py:20`） | 桌面辅助关机；界面未接入 |
| `GET /api/health` | 公开（唯一免会话端点），返回运行身份 `runtime_kind` / `runtime_id` / `instance_id` |
| `/api/heartbeat`、`/ws/heartbeat`（`heartbeat.py:16`） | 心跳与断连兜底 |

## 6. 前端未消费或内部使用的端点（新前端可自行决定是否接入）

| 端点组 | 现状 | 说明 |
|---|---|---|
| `/api/error-log/*`（7 个） | 后端完整、前端零消费 | 若新前端计划做「问题记录 / 日志」界面，这是现成能力；否则仅供诊断 |
| `/api/v4/artwork-cache/preview`、`/confirm` | 前端零引用 | 图片缓存预览 / 确认（`media_v4.py:78`、`:100`） |
| `/api/v4/jobs`、`/jobs/{job_id}/run` | 前端零引用 | 作业查询与手动执行 |
| `/api/v4/sources/scan` | 有封装无页面调用 | 同步扫描入口；与 durable 扫描入口并存（TBC-04） |
| `/api/v4/playback/progress*` | 与 `/api/playback/progress` 并存 | 进度写入端点重复（技术债） |
| `/api/v4/tracking/state*` | 前端零引用 | 追更状态读写 |
| `/api/v4/tracking/works` | 有封装无消费组件 | `src/api/mediaV4.ts:704` |
| `/api/library/diagnostics`、`/api/library/rescan` | 有封装无调用方 | `src/api/library.ts:46`、`:48` |
| `/api/library/watch-status`（列表） | 前端未见调用 | 单作品版本在用 |
| `/api/v4/work-customization/{work_id}/extra-videos` | 前端未见调用 | 附加视频清单 |
| `/api/config/setup/status` | 前端未见调用 | 首次引导用 `GET /api/config` 的 `setup_*` 字段 |

## 7. 未确认项

- **各端点完整请求 / 响应模型**：本节字段来自前端类型声明与调用代码；后端 Pydantic 模型可能含前端未使用的额外字段，未逐一比对。需要精确契约时读对应函数签名。
- **`/api/v4/sources/scan` 与 durable 扫描入口的实际差异**：前端不可见，未确认是否语义等价（见 TBC-04）。
- **`/api/health` 之外是否还有免会话端点**：只确认 `api_security.py` 的豁免逻辑与 `/api/health` 的公开性，未穷举所有豁免路径。
- **`/api/config` `PublicConfig` 的完整字段**：仅核对前端实际消费字段（`setup_*`、`series_card_image_mode`、`poster_size` 等），未展开全部字段。
- **WebSocket `/ws/heartbeat` 的消息格式**：未在本次核对范围内。
