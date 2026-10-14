# 后端架构（重构前置）

> 记录日期：2026-10-14
> 事实来源：`backend/app/`、`backend/pyproject.toml`、`backend/uv.lock`、`backend/app/main.py`、`backend/tests/`
> 定位：回答「后端用什么技术、由哪些模块组成、后台在做什么、并发与安全边界在哪里」。用于让前端设计理解"后台正在发生什么"。不评估后端是否需要重构。

## 1. 技术栈与依赖

| 项 | 内容 | 依据 |
|---|---|---|
| 语言 | Python `>=3.12` | `backend/pyproject.toml` `requires-python` |
| Web 框架 | FastAPI `>=0.104.0` | `backend/pyproject.toml` dependencies |
| ASGI 服务器 | uvicorn `>=0.24.0` | 同上 |
| 存储 | SQLite（标准库 `sqlite3`，`PRAGMA user_version` 迁移） | `backend/app/media_v4/persistence/database.py` |
| HTTP 客户端 | httpx `[http2,socks]>=0.25.0` | `backend/pyproject.toml` |
| 图片处理 | Pillow `>=10.2.0` | 同上 |
| WebSocket | websockets `>=12.0` | 同上 |
| 表单 | python-multipart `>=0.0.6` | 同上 |
| 开发依赖 | pytest `>=8.0`、ruff `>=0.8`、mypy `>=1.13` | `[project.optional-dependencies] dev` |
| 打包依赖 | pyinstaller `==6.22.3`（installer extra） | `[project.optional-dependencies] installer` |
| 依赖锁定 | `backend/uv.lock`（标准构建与 CI 走 `uv sync --locked`） | `docs/PROJECT.md` 第 11 节 |
| Lint 约束 | ruff：`line-length = 120`，`select = ["E","F","I","UP","B"]`，忽略 `E501` | `backend/pyproject.toml` `[tool.ruff]` |
| 类型检查 | mypy：`files = ["app"]`、`check_untyped_defs = false`、`ignore_missing_imports = true` | `backend/pyproject.toml` `[tool.mypy]` |
| 测试配置 | `testpaths = ["tests"]`、`pythonpath = ["."]`、`addopts = "-q"` | `backend/pyproject.toml` `[tool.pytest.ini_options]` |

版本号 `kumiplayer-backend` = `2.0.0`，与根 `package.json` 的版本基准一致（`scripts/check_versions.py` 校验）。

## 2. 进程入口与装配

| 入口 | 作用 |
|---|---|
| `backend/app/main.py` | FastAPI 应用装配：lifespan、中间件、路由器注册、前端静态托管 |
| `backend/desktop_backend.py` | 安装版冻结后端入口 |
| 桌面壳 | 生成会话 Token、注入运行身份环境变量、监管后端子进程（`src-tauri/src/supervisor.rs`） |

装配顺序（`backend/app/main.py`）：

1. `app = FastAPI(..., lifespan=lifespan, ...)`（`:147-150`）。
2. 中间件：Host 白名单与 CORS（`:156`）、`ApiSessionMiddleware`（`:168`）、第二个中间件（`:169`，顺序在注册时倒序生效）。
3. 13 个业务路由器按固定顺序注册（`:175-187`）：library、heartbeat、config、bangumi、error_log、assets、media_v4、work_customization、playback、tracking、tasks、openlist、system。
4. 前端静态资源挂载：`app.mount("/assets", StaticFiles(directory=<frontend dist>/assets))`（`:230`）。
5. `_BUNDLED_RUNTIME` 由 `KUMIPLAYER_RUNTIME_KIND == "bundled"` 计算（`:146`）；bundled 模式关闭 `/docs`、`/redoc`、`/openapi.json`。

## 3. lifespan：启动与关闭顺序

`lifespan`（`backend/app/main.py:63-146`）在启动时拉起全部后台工作者，关闭时按"用户可见状态优先"收口。

### 3.1 启动

| 顺序 | 动作 | 位置 |
|---|---|---|
| 1 | `initialize_runtime()` 初始化 V4 唯一媒体状态源 | `:68` |
| 2 | `ArtworkService(database).start()` 启动图片服务 | `:69-70` |
| 3 | 创建 `stop_jobs` 事件 | `:71` |
| 4 | V4 作业 worker（`run_v4_jobs` → `V4JobRunner.process_available`），空闲退避 0.25s → 上界 2s | `:73-89` |
| 5 | 媒体库投影刷新 worker（`ProjectionRefreshScheduler.tick`），每 1s | `:91-104` |
| 6 | 来源扫描 worker（`get_source_scan_runner`）`start()`：启动时先回收失联行，再串行领取 `queued` 扫描 | `:105-108` |
| 7 | 追更调度 worker（`OngoingScheduler.tick`），每 30s；首轮带 `startup=True` | `:109-125` |
| 8 | 心跳监控 `get_heartbeat_manager().start_monitor()` | `:126-127` |

### 3.2 关闭（`finally`，`:129-146`）

1. `stop_jobs.set()` 通知所有 worker。
2. **先停播放会话**（`get_v4_playback_manager(database).stop`，超时 2.25s，线程预算 2.5s）——播放拥有最近一次用户可见状态，先持久化最近监控采样并请求 MPV 正常退出。
3. `_stop_background_tasks((job_worker, projection_worker, ongoing_worker))`。
4. `artwork_service.stop`（线程预算 0.35s）。
5. `source_scan_worker.stop`（0.35s / 超时 0.25s）。
6. `manager.stop_monitor`（0.25s）。

设计意图：不遗留 daemon 孤儿线程；每个 worker 的异常都被捕获并继续消费后续任务，不会因单次失败退出。

## 4. 模块划分

### 4.1 V4 媒体链（`backend/app/media_v4/`，102 个 `.py`）

| 子包 | 职责 |
|---|---|
| `domain/` | SourceRoot、SourceScan、SourceEvidence、ParsedFacts、Work/Season/Episode/Edition/Asset、ImportRevision 与 Job 合同 |
| `sources/` | 本地目录、目录树 TXT、OpenList 适配与扫描编排、编码读取、扫描校验、来源健康状态、增量预算 |
| `parsing/` | 只解析一次，产出不可变 ParsedFacts 与集号标题 |
| `resolution/` | 稳定作品身份、季度 / 集号映射、候选评分与多 Asset 收口 |
| `revisions/` | revision 草稿、确认、图写入与 outbox 的原子提交 |
| `jobs/` | 只消费 confirmed revision：资料快照、别名恢复、投影调度与显式维护 |
| `assets/` | 持久图片需求、受管原图与派生规格、租约重试、版本发布 |
| `projection/` | 从 SQLite authority 重建可删除的 Library generation 与来源卡聚合 |
| `persistence/` | V4 schema（`schema_v4.py` 1852 行）、仓储、身份生命周期与迁移 |
| `playback/` | 播放会话编排与进度 / 历史写入 |
| `tracking/` | 追更控制状态与基线 |
| `maintenance/` | 身份修复与受保护维护操作 |
| `customization/`、`diagnostics/` | 作品自定义标签、诊断 |

依据：`backend/app/media_v4/` 目录结构与 `docs/PROJECT.md` 第 4.1 节。

### 4.2 支撑模块

| 模块 | 文件数 | 职责 |
|---|---|---|
| `api/` | 14 | FastAPI 路由（`*_v4.py` 为当前媒体链路由） |
| `core/` | 14 | 配置、凭据、原子写、数据锁、路径、URL 守卫、错误日志、本地根、OpenList 连接、TMDB 图片修复 |
| `integrations/` | 9 | Bangumi 客户端；`openlist/` 子包（client / connection / cache / governor / providers / telemetry / models） |
| `scrape/` | 6 | TMDB / AniList Provider 客户端 |
| `recognition/` | 5 | 纯函数识别库（标题清洗、集号标题、已核验标题） |
| `playback/` | 4 | 内置 MPV 启动、JSON IPC 与运行时校验 |
| `system/` | 3 | 心跳与关机 |
| `maintenance/` | 1 | 受白名单约束的 V4 状态重置入口 |

### 4.3 空壳目录（13 个，不得恢复）

`catalog/`、`db/`、`import_pipeline/`、`import_plan/`、`jobs/`、`library/`、`media_presets/`、`mirror/`、`pipeline/`、`raw/`、`sources/`、`tasks/`、`tracking/`

实测（2026-10-14）：对每个目录执行 `find backend/app/<dir> -name "*.py" -not -path "*__pycache__*" | wc -l` 均为 **0**。它们是 V3 执行链的残留目录，`docs/PROJECT.md` 第 3 节明确不得恢复；`architecture residue` 回归测试禁止 V3 复活（`docs/项目现状与改进清单.md` OPT-04）。

## 5. 并发、锁与限流

| 机制 | 实现 | 依据 |
|---|---|---|
| 全局数据写锁 | `DATA_WRITE_LOCK = threading.RLock()`，被 `api/config.py`、`api/bangumi.py`、`api/openlist_v4.py`、`core/atomic_json.py`、`core/config.py`、`core/error_log.py` 消费 | `backend/app/core/data_lock.py:5`、`grep -rln DATA_WRITE_LOCK backend/app` |
| 来源扫描串行 | 扫描 runner 串行领取 `queued` 扫描（一次扫描对应一个来源根） | `backend/app/main.py:105-108` 注释 |
| 投影构建锁 | 投影维护在后台用构建锁合并调度；在 SQLite 读事务内构建受影响卡片与详情，短写事务发布 | `docs/PROJECT.md` 第 7 节 |
| 作业 worker 退避 | 空闲 0.25s → 上界 2s | `backend/app/main.py:74-82` |
| 投影刷新节流 | 每 1s tick，合并受影响作品 | `backend/app/main.py:96-103` |
| 图片服务并发 | 后台下载并发 2、编码并发 1、每轮最多 64 | `docs/PROJECT.md` 开头（运行架构） |
| OpenList 缓存写节流 | `INDEX_WRITE_MIN_INTERVAL_SECONDS = 60.0` | `backend/app/integrations/openlist/cache.py:36`、`:205` |
| OpenList 风控与限速 | 失败分类明确区分 `rate_limit`(429)、`risk_control`、`auth`、`network`、`permission`、`not_found`；限速进入来源冷却 | `backend/app/integrations/openlist/models.py:65`、`client.py:418`、`connection.py:105` |
| 增量预算 | 滚动验证预算默认 12、上限 50；根目录必查，变化目录可继续入队 | `docs/PROJECT.md` 第 5 节、`backend/app/media_v4/sources/incremental.py` |

## 6. 安全边界

| 项 | 实现 |
|---|---|
| 会话 Token | 桌面壳每次启动生成 256-bit 随机 Token，经环境变量交给后端、经 Tauri command 交给前端；业务请求校验 `X-KumiPlayer-Token` |
| 中间件 | `ApiSessionMiddleware`（`backend/app/main.py:168`）；`TrustedHostMiddleware` 只接受 `127.0.0.1`、`localhost`、`testserver`；CORS 只放行 Tauri 与 Vite 开发源 |
| 免会话例外 | `/api/health` 公开；`core/api_security.py` 在未注入 `KUMIPLAYER_API_TOKEN` 时 `token_matches` 直接返回 `True`（手动绕过桌面壳的开发兼容，**不具备桌面会话鉴权保证**，见 TBC-03） |
| 出站 URL 校验 | `core/url_guard.py`；TMDB 图片在显式白名单入口允许代理 Fake-IP，其余私网 / 环回 / 混合解析拒绝 |
| 凭据存储 | Windows Credential Manager（`core/credential_store.py`），不进 `config.json` |
| 导入路径安全 | `media_v4/path_validation.py`、`path_validation` 的挂载探测（最多 4 个并发探测、同路径复用） |
| bundled 模式 | 关闭 OpenAPI / Swagger / Redoc |

## 7. 配置与持久化

- 配置读取入口：`backend/app/core/config.py`；数据目录解析：`core/paths.py`（`get_data_dir()`，可用 `KUMIPLAYER_DATA_DIR` 覆盖）。
- 持久化分工（`data/config.json`、Credential Manager、`data/kumiplayer.db`、`data/source_inputs/`、`data/openlist_cache/`、`data/openlist_incremental/`、`data/mpv-state/`、`data/artwork/`、`data/cache/artwork_variants/`、`data/logs/`、`data/bangumi_account.json`）见 `docs/current/system-overview.md` 第 5 节。
- 数据库结构见 `docs/current/data-model.md`。

## 8. 错误与日志

| 项 | 位置 |
|---|---|
| 运行日志 | `data/logs/` |
| 错误日志模块 | `backend/app/core/error_log.py`、`backend/app/api/error_log.py`（7 个端点，前端无消费者） |
| worker 异常策略 | 单个任务在自己的 handler 记录失败，worker 继续消费；投影 / 追更异常记 warning 后自动重试（`backend/app/main.py:83-85`、`:97-99`、`:115-117`） |
| 用户可见错误 | 前端过滤技术细节（SQLite / traceback / HTTP 状态）；后端经 `detail` 返回可读消息 |

## 9. 对前端的直接含义

1. **"后台正在做什么"是真实状态**：作业、投影刷新、扫描、追更、图片准备、心跳都是独立工作者，前端只能通过接口读取状态，不能假设"点一下立即完成"。
2. **进度模型是任务化的**：长任务 `TaskRecord` 与 revision 作业是两套并行概念（`/api/tasks` 与 `/api/v4/imports/{id}` 的 `jobs` + `progress`），新前端必须区分。
3. **列表读取是投影读取**：列表 / 详情只读已发布投影，构建过程不检查 NFO、原图或视频文件；普通 GET 不启动任何后台任务。
4. **凭据永不回显**：设置类界面只能显示"是否已配置"，不能读取明文。
5. **鉴权不可绕过**：所有业务请求必须携带会话 Token；图片与 WebSocket 走受限查询参数。
