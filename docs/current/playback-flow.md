# 播放流程（重构前置）

> 适用范围：现有系统的事实快照；不作为 3.0 的页面、组件、视觉或架构约束。源码及用户最新指令优先。

> 记录日期：2026-10-14
> 事实来源：`backend/app/api/playback_v4.py`、`backend/app/media_v4/playback/`、`backend/app/playback/`、`旧前端/src/api/playback.ts`、`mpv/README.md`、`docs/PROJECT.md`
> 定位：回答「从用户点击到 MPV 播放、再到进度与历史落库的完整链路」。用于新前端设计播放类交互时确认边界。不评估播放器实现是否需要重构。

## 1. 端到端链路

```text
详情页选择作品 / 剧集
  → 旧前端/src/api/playback.ts:29  POST /api/playback/play { work_id, episode_id, asset_id? }
  → backend/app/api/playback_v4.py:61  play()
  → V4PlaybackManager.play（media_v4/playback/session.py:76）
  → _resolve_asset（session.py:214）读取 Asset 身份与 playback_locator
  → validate_playback_locator（media_v4/path_validation.py:69）有界挂载探测
  → _build_playlist（session.py:454）构造受控播放列表
  → capture_session_binding（playback/store.py:89）为每个成员冻结会话绑定
  → 停止旧会话（session.py:119-120）
  → start_mpv（playback/mpv.py:55）
  → MPV 进程 + JSON IPC 观察者线程（session.py:706 _monitor）
  → 进度 / 历史 / 已看状态写入 SQLite
  → 可选：Bangumi 完成同步（session.py:499、:540）
```

## 2. 请求与解析

### 2.1 播放请求

| 端点 | 请求体 | 说明 |
|---|---|---|
| `POST /api/playback/play`（`playback_v4.py:61`） | `{ work_id: str, episode_id: str, asset_id: str = "" }`（Pydantic `PlayRequest`，`work_id`/`episode_id` 最小长度 1） | `asset_id` 为空时按最近确认的 revision 绑定回退解析 |

响应字段：`session_id`、`status`、`work_id`、`episode_id`、`asset_id`、`playback_locator`（`旧前端/src/api/playback.ts:22-29`）。

失败语义：`KeyError` → **404**「剧集或 Asset 不存在」（`playback_v4.py:65-68`）。

### 2.2 Asset 解析

- `_resolve_asset`（`session.py:214`）按 `work_id` / `episode_id` / `asset_id` 读取媒体图中的 Asset 身份。
- 无 `asset_id` 时的回退查询（`playback_v4.py:46-58`）只认**已确认且来源未退役**的绑定：
  ```sql
  SELECT rb.work_id FROM revision_bindings rb
    JOIN import_revisions ir ON ir.revision_id = rb.revision_id
    JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
   WHERE ir.status = 'confirmed' AND ... ORDER BY ir.confirmed_at DESC LIMIT 1
  ```
- Asset 没有 `playback_locator` 时抛 `ValueError("Asset 没有可播放定位符")`（`session.py:88-90`）。

### 2.3 路径校验

| 校验 | 位置 | 行为 |
|---|---|---|
| 单路径校验 | `media_v4/path_validation.py:69` | 有界挂载探测：最多 4 个并发探测、同路径复用；只接受**本地绝对路径**（含已挂载网盘） |
| 会话层去重 | `media_v4/playback/session.py:111-117` | 已校验路径在会话内跳过重复探测 |
| 播放列表成员 | `playback/mpv.py:83-95` | 仅做**语法**校验（`validate_playback_locator_syntax`），避免启动时逐集访问挂载盘 |
| 首项一致性 | `playback/mpv.py:88` | 播放列表首项必须等于选定的媒体路径，否则 `ValueError` |

## 3. 会话构造与旧会话停止

- 播放列表由 `_build_playlist`（`session.py:454`）构造；每个成员通过 `V4PlaybackStore.capture_session_binding`（`store.py:89`）冻结 `(episode_id, asset_id)` 绑定，用于防止晚到的进度写回错误身份。
- 起始位置从已保存进度读取：`V4PlaybackStore.get_progress`（`store.py:139`）；已看完（`completed`）则从 0 开始。
- **停止旧会话的时机**：`session.py:119-120` 注释明确——"新请求通过路径和身份检查后才结束旧会话，坏映射不能打断正在播放的媒体"。
- 会话名：`session_id = f"sess_{uuid4().hex[:16]}"`，IPC 服务名由 `make_ipc_server_name(session_id)` 派生（`session.py:98-99`）。
- `media_path_validated=True` 传入 `start_mpv`，避免重复探测（`session.py:121-129`）。
- 激活记录：`V4PlaybackStore.record_activation`（`store.py:77`）。
- 监控线程：`threading.Thread(target=self._monitor, daemon=True)`（`session.py:141`）。

## 4. MPV 启动与配置注入契约

`start_mpv`（`backend/app/playback/mpv.py:55`）按播放模式分支，模式由配置决定（`mpv.py:66-70`）：

| 模式 | 行为 |
|---|---|
| `internal`（默认） | 使用内置干净 MPV + 自有配置与脚本：`--config-dir=<get_mpv_config_dir()>`，再 `--include=<自有层强制配置>` |
| `external` | 用户自备整合包，**零注入**：不传 `--config-dir` / `--include` / `--script` / `--script-opts`，只追加本次会话必需参数（IPC、起点、标题、受控播放列表、窗口行为），仅阻止自动回退到非首选语言字幕 |

`internal` 模式的参数构造（`backend/app/playback/mpv_runtime.py:452-498`）：

1. `--config-dir=<config_dir>`：MPV 官方语义下指定配置目录会忽略全局、用户与 `MPV_HOME` 配置。
2. `--include=<kumiplayer 自有层强制配置>`（`KUMIPLAYER_FORCED_CONFIG`，若存在）：自有层在整合包 `mpv.conf` 之后追加解析。
3. 可写状态隔离到数据目录：`cache/`、`watch_later/`、`thumbfast/` 防御性创建（`mpv_runtime.py:487-492`）。
4. `_ensure_scripts_present()` 校验必需脚本存在（`mpv_runtime.py:125`）。

约束（`docs/PROJECT.md` 第 7 节、`mpv/README.md`）：

- 配置两层：默认套件配置源 `mpv/config/portable_config`（可被整合包替换），不可替换的自有层 `mpv/config/kumiplayer`；安装版对应 `runtime/mpv/portable_config` 与 `runtime/mpv/kumiplayer`。
- **不得传 `--no-config`**。
- 不读取或改写用户外部 MPV 的配置。
- 截图目录与剧集标题由 KumiPlayer 的 `media-title` 驱动。
- `external` 模式下 `_build_kumiplayer_script_args` 使用自有层路径（`docs/项目现状与改进清单.md` OPT-05）。

窗口行为：`_focus_mpv_window_async`、`_strip_dwm_border`、`_allow_foreground_activation` 等（`mpv.py:308-447`）；`_build_window_title` / `_clean_display_title` 生成窗口标题（`mpv.py:173-180`）。

## 5. IPC 观察与状态写入

| 组件 | 位置 | 作用 |
|---|---|---|
| IPC 服务端实现 | `backend/app/playback/mpv_ipc.py`（457 行） | JSON IPC 通道 |
| 监控循环 | `media_v4/playback/session.py:706` `_monitor` | 单个观察者按采样写进度 |
| 事件到播放列表位置 | `session.py:45` `_resolve_event_playlist_position` | 解析 IPC 事件对应的播放列表位置 |
| 进度检查点 | `session.py:635` `_checkpoint_progress` | 写进度 |
| 强制检查点 | `session.py:681` `_force_checkpoint` | 停止前落盘最近采样 |
| 进度与历史写入 | `media_v4/playback/store.py:28` `save_progress`、`:102` `save_session_progress`、`:150` `_append_history_event` | 进度写 `playback_progress`，历史追加事件 |
| 绑定校验 | `store.py:201` `_assert_confirmed_binding` | 只接受已确认绑定，防止晚到写入串身份 |

标题来源：`_snapshot_titles`（`session.py:322`）读数据库中**签名一致**的已引用资料快照；`_playback_work_title`（`:365`）与 `_playback_episode_title`（`:413`）在资料缺失时回退到本地标题。**不访问 NFO 或图片**。

## 6. 已看状态与完成同步

| 能力 | 实现 | 说明 |
|---|---|---|
| 手动已看 / 未看 | `media_v4/playback/watch_state.py:58` `mark_watch_state`（支持 `through=True` 标记到某集为止） | 经 `/api/playback/progress/mark` 与 `/progress/mark-through` 暴露 |
| 保护手动未看 | `watch_state.py:33` `preserve_manual_unwatched` | 自动同步不得覆盖用户手工标记的未看 |
| 清除手动状态 | `watch_state.py:44` `clear_manual_watch_state` | — |
| Bangumi 完成同步 | `session.py:499` `_schedule_completion_sync`、`:540` `_sync_completed_episode` | 播完后按需同步；前端可见同步状态 |

## 7. 停止与生命周期

| 场景 | 行为 |
|---|---|
| `POST /api/playback/stop`（`playback_v4.py:78`） | `V4PlaybackManager.stop(timeout=2.25)`：先落盘最近采样，再请求 MPV 正常退出（`session.py:144`） |
| 应用关闭 | lifespan `finally` 中**最先**停播放会话（`backend/app/main.py:130-137`），线程预算 2.5s、超时 2.25s |
| 进程退出收尾 | `session.py:831` `_finish_quitting_process` |
| 状态查询 | `GET /api/playback/status`（`playback_v4.py:83`）→ `V4PlaybackManager.status`（`session.py:205`），返回 `{ status, session }` |

## 8. 进度读模型

| 端点 | 响应 | 前端 |
|---|---|---|
| `GET /api/playback/progress?work_id=`（`playback_v4.py:125`） | `{ items: PlaybackHistoryItem[] }` | `旧前端/src/api/playback.ts:56` |
| `GET /api/playback/history?limit=&work_id=`（`:143`） | `{ items: PlaybackHistoryItem[] }` | `旧前端/src/api/playback.ts:50` |
| `GET /api/v4/playback/progress/{episode_id}/{asset_id}`（`media_v4.py:2511`） | 单集进度 | 前端零引用 |

`PlaybackHistoryItem` 字段：`work_id`、`episode_id`、`asset_id`、`position`、`duration`、`completed`、`updated_at`，另含历史读模型的 `episode_title`、`season_number`、`episode_number`、`thumb_path`、`played_at`、`season_snapshot`、`episode_snapshot`、`title_snapshot`（`旧前端/src/api/types.ts:157-172`）。

另外 `/api/v4/playback/progress`（`media_v4.py:2493`）与 `/api/playback/progress` 并存，属已知重复端点（`frontend-analysis.md` 第 9 节）。

## 9. 播放链路对前端的硬性约束

1. **只播本地路径**：前端只能提交作品 / 剧集 / Asset 身份，不能提交 URL、网盘直链、设备路径或播放列表包装文件；网盘内容必须先有本地挂载路径。
2. **不生成 STRM**：播放直接把本地文件与受控队列交给 MPV。
3. **进度身份不可自造**：进度写入必须带 `work_id` + `episode_id`（+ 可选 `asset_id`），并遵循已确认绑定；前端不得自行拼接身份。
4. **等待期间不要重复请求**：路径校验 + 挂载探测发生在后端；前端应表达"正在启动播放"而不是轮询探测进度。
5. **停止是显式的**：`/api/playback/stop` 会落盘进度；前端不应假设关闭页面即停止。
6. **自动连播不在前端实现**：受控播放列表由后端构造，前端不需要也不应该构建播放队列。
7. **外部 MPV 模式差异**：`external` 模式下 KumiPlayer 不注入任何配置与脚本，界面文案不得承诺"KumiPlayer 快捷键 / 脚本"在该模式下可用。

## 10. 未确认项

- **首次播放的真实延迟**：`docs/项目现状与改进清单.md` TBC-06 记录"播放前对本地路径挂载探测的行为边界已确认，但真实网盘挂载下的首次点击到窗口出现延迟未测量"。本文件不将其列为已知瓶颈。
- **`external` 模式下 AniList / 联网核对开关的运行时差异**：设置与播放调校均可配置，未确认运行时行为差异。
- **IPC 事件的完整字段集**：未逐一核对 `mpv_ipc.py` 的全部事件类型。
- **`thumbfast` / 截图目录的最终落点**：`mpv_runtime.py:526-531` 提到 `mpv_path` 注入项与整合包替换后的语义，未逐项验证替换后的实际行为。
