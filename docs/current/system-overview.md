# 系统总览（重构前置现状）

> 适用范围：现有系统的事实快照；不作为 3.0 的页面、组件、视觉或架构约束。源码及用户最新指令优先。

记录日期：2026-10-14。事实来源：当前源码与测试（`backend/app/`、`src/`、`src-tauri/`、`backend/tests`、`tests/`）。
本文只描述**已存在的系统**；规范性合同与维护原则见 `docs/PROJECT.md`。

## 1. 产品边界

KumiPlayer 是 Windows 桌面应用，面向**本地与网盘媒体库**：把用户已有的本地目录、网盘目录树（TXT 导出）或 OpenList 远端路径转成可浏览、可刮削、可播放的媒体库，并用内置干净 MPV 播放。

- 不移动、不重命名、不删除用户的真实影片文件；网盘内容通过本地挂载路径播放。
- 不读取源视频、缩略图或 NFO 来决定结构；目录树/清单文本本身就是结构证据。
- 媒体事实的唯一权威是 SQLite V4；前端、刮削与投影都是消费方。

## 2. 三层运行架构

```text
Tauri 桌面壳（src-tauri/，Rust）
  ├─ 计算运行根身份、生成会话 Token、管理后端子进程与 Job Object
  ├─ WebView2 承载 React 19 + TypeScript 前端（src/，Vite 构建）
  └─ 通过 HTTP(127.0.0.1:37821) + WebSocket 与 Python 后端通信
Python 后端（backend/app/，FastAPI + SQLite）
  └─ 唯一执行链：SourceEvidence → ParsedFacts → MediaGraph → confirmed revision → V4 jobs → SQLite → Library Projection
React 前端
  └─ 只消费后端投影与接口；不持有媒体事实
```

依据：`src-tauri/src/supervisor.rs`（`BACKEND_PORT = 37821`，进程与恢复路径）、`backend/app/core/config.py:67`（`server_port`）、`backend/app/main.py`（路由注册与中间件）。

## 3. 运行形态

| 形态 | 入口 | 前端资源 | 后端进程 | 数据目录 |
|---|---|---|---|---|
| 源码 / 开发版 | `dev.bat`（`npm run tauri dev`，Vite 于 `127.0.0.1:1420`）、`build_tauri.bat` 产出的 `release/KumiPlayer.exe` | 开发版 EXE 内嵌构建产物；dev 由 Vite 提供 | 桌面壳探测 PATH 上的 `pythonw.exe` / `python.exe`，以源码模式启动 | 项目 `data/` |
| 安装版 | `release/KumiPlayer-Setup.exe` | 内嵌 | `<安装目录>\runtime\backend\KumiPlayerBackend.exe` | `%LOCALAPPDATA%\KumiPlayer\data` |

- 数据目录解析：`backend/app/core/paths.py:89`（`get_data_dir()`，可用 `KUMIPLAYER_DATA_DIR` 覆盖）；安装版走 `get_default_data_dir()`。
- 运行身份：`KUMIPLAYER_RUNTIME_KIND`（`source` / `bundled`）、`KUMIPLAYER_RUNTIME_ID`、`KUMIPLAYER_INSTANCE_ID`，由桌面壳注入（`backend/app/main.py` 的 `/api/health` 返回）。
- bundled 模式下 `main.py` 关闭 `/docs`、`/redoc`、`/openapi.json`。

## 4. 进程内的后台工作线程

FastAPI `lifespan`（`backend/app/main.py`）在启动时拉起全部后台工作者，关闭时按用户可见状态优先的顺序收口：

| 工作者 | 代码位置 | 周期 / 行为 |
|---|---|---|
| V4 作业 worker | `V4JobRunner.process_available`（`backend/app/media_v4/jobs/runner.py`） | 空闲退避 0.25s → 上界 2s；只消费 confirmed revision 的 queued 作业 |
| 媒体库投影刷新 | `ProjectionRefreshScheduler.tick`（`backend/app/media_v4/projection/refresh.py`） | 每 1s 合并调度；只发布受影响的卡片与详情 |
| 来源扫描 worker | `get_source_scan_runner(...)`（`backend/app/media_v4/sources/source_scan_runner.py`） | 串行领取 `queued` 扫描；启动时先回收失联行 |
| 追更调度 | `OngoingScheduler.tick`（`backend/app/media_v4/tracking/scheduler.py`） | 每 30s；按来源范围决定是否触发增量更新 |
| 心跳监控 | `get_heartbeat_manager().start_monitor()`（`backend/app/system/heartbeat.py`） | 桌面壳失联兜底；前端 `/ws/heartbeat` |
| 图片服务 | `ArtworkService.start()`（`backend/app/media_v4/assets/service.py`） | 受管原图与派生尺寸的租约、重试与发布 |

关闭顺序（`main.py` 的 `finally`）：先停播放会话（保留最近一次用户可见状态）→ 停作业/投影/追更 worker → 停图片服务 → 停扫描 worker → 停心跳监控。

## 5. 持久化落点

| 内容 | 位置 | 性质 |
|---|---|---|
| 非敏感用户配置 | `data/config.json` | 主题、目录、OpenList、播放等 |
| API 凭据 | Windows Credential Manager（`backend/app/core/credential_store.py`） | TMDB、Bangumi、OpenList 密码等 |
| 媒体与任务权威 | `data/kumiplayer.db`（SQLite，`PRAGMA user_version` 迁移） | Work/Season/Episode/Asset、revision、jobs、进度、历史、追更控制 |
| 来源输入归档 | `data/source_inputs/` | 目录树 TXT 的只读归档与来源证据输入 |
| OpenList 缓存与增量 | `data/openlist_cache/`、`data/openlist_incremental/` | 连接器缓存与增量状态 |
| MPV 状态 | `data/mpv-state/` | 缓存、日志与 watch-later |
| 独立图片库 | `data/artwork/`、`data/cache/artwork_variants/` | 受管原图、手工上传、按内容/配方/尺寸的 WebP 派生 |
| 日志 | `data/logs/` | 运行日志与错误日志 |
| Bangumi 会话 | `data/bangumi_account.json` | 本地账号状态（不含明文令牌） |

字段清单见 `docs/01_项目基准/KumiPlayer_配置与数据目录.md`；表结构见 `docs/current/data-model.md`。

## 6. 安全与访问边界

- 前端与后端之间的每个业务请求都带桌面壳生成的一次性会话 Token（`X-KumiPlayer-Token`）；浏览器无法设置 Header 的场景（图片、WebSocket）使用受限查询参数。实现见 `backend/app/core/api_security.py`。
- `TrustedHostMiddleware` 只接受 `127.0.0.1`、`localhost`、`testserver`；CORS 只放行 Tauri 与 Vite 开发源（`backend/app/main.py`）。
- 手工绕过桌面壳启动后端且未设置 `KUMIPLAYER_API_TOKEN` 时走免会话开发兼容；**该模式不具备桌面会话鉴权保证**，不能作为公开服务部署。
- 出站 URL 校验在 `backend/app/core/url_guard.py`；TMDB 图片在显式白名单入口允许代理 Fake-IP，其余私网/环回/混合解析仍拒绝。

## 7. 系统级不变量

1. **单链**：`SourceEvidence → ParsedFacts → MediaGraph → confirmed revision → V4 jobs → SQLite → Library Projection` 是唯一执行链；不存在第二套导入管线或隐藏 fallback。
2. **不可变事实**：`source_evidence`、`parsed_facts`、confirmed revision 的绑定由数据库触发器保护，不可被前端、刮削或投影改写（`backend/app/media_v4/persistence/schema_v4.py`）。
3. **投影可弃**：Library Projection 是可删除、可重建的展示层，不是来源文件真相。
4. **只消费 confirmed revision**：作业、刮削、图片、投影都不重新识别来源。
5. **不触碰真实媒体**：所有删除/清理都限于应用自身产物与受控记录，且必须先预览再确认。
6. **不恢复 V3**：`backend/app/` 下的 `catalog/ db/ import_pipeline/ import_plan/ jobs/ library/ media_presets/ mirror/ pipeline/ raw/ sources/ tasks/ tracking/` 是空目录残留（`docs/项目现状与改进清单.md` 有记录），不得恢复为执行链。
