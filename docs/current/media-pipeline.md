# V4 媒体导入与识别管线

> 适用范围：现有系统的事实快照；不作为 3.0 的页面、组件、视觉或架构约束。源码及用户最新指令优先。

> 记录日期：2026-10-14
> 事实来源：backend/app/api/media_v4.py、backend/app/media_v4/sources/、parsing/、resolution/、revisions/service.py、jobs/、assets/、tracking/、projection/、backend/app/core/local_roots.py、backend/tests/（261 个测试文件）
> 定位：说明从"用户登记来源"到"媒体库出现可播放卡片"的真实执行链、各步负责文件、失败与阻塞语义、可恢复点。不回答播放器行为（见 playback-flow.md），不逐表解释结构（见 data-model.md）。

## 1. 四类输入来源的真实差异

来源入口只有一个：`POST /api/media_v4/sources/scan`（`backend/app/api/media_v4.py:881`），由请求体 `source` / `scan_mode` 分派。来源根模式 `source_mode` 由 `_ensure_root_container` 显式写入 `source_roots`，不再从第一条证据的排序反推（`schema_v4.py:1104` 的注释即说明该纪律）。

| 输入来源 | 请求标识 | `source_mode` | `ingest_method` | 播放定位符来源 | 关键差异与证据 |
| --- | --- | --- | --- | --- | --- |
| 本地目录 | `source=local` | `local` | `local_scan` | 真实本地绝对路径（`scan_local_directory` 产出） | 直接枚举磁盘；排除已配置网盘根（`_configured_cloud_roots`）；`api/media_v4.py:1094`、`scanner.py:613` |
| 115/百度 目录树 TXT（纯快照） | `source=tree` | `tree_snapshot` | `directory_tree` | 由 TXT 导出的本地绝对根 + 挂载映射生成，不触盘 | 只在用户上传新 TXT 时更新；`api/media_v4.py:959`、`scanner.py:470` |
| OpenList 远端路径（全量） | `source=openlist`，`scan_mode=full` | `openlist_full` | `openlist_scan` | `choose_mapping` 的 `effective_root`（挂载根 + 路由） | 需要已配置 OpenList 连接与本地挂载根，否则 409；`api/media_v4.py:1006`、`scanner.py:714` |
| TXT + OpenList 增量（混合基线） | `source=hybrid` | `tree_openlist` | `directory_tree` | TXT 基线 + OpenList 路由映射 | 用 TXT 建立大库基线，后续可走 OpenList 增量；`api/media_v4.py:900` 起 |

OpenList 增量（`scan_mode=incremental`）不是独立来源，而是 `openlist`/`hybrid` 的一种扫描姿态：`root_source_mode = existing_mode or "openlist_full"`，已有来源模式保持不变（`api/media_v4.py:1049`）。

本地来源登记在 `AppConfig.local_roots`，上限 24 条，`root_id` 由路径确定性推导（`backend/app/core/local_roots.py:19`、`local_roots.py:72`）；该记录只描述"用户登记过的位置"，不构成媒体事实，真正来源身份仍由扫描时的本地绝对播放路径决定（`local_roots.py:1`）。

## 2. 逐步流程

### 步骤 0：来源登记与扫描任务登记

- 输入：HTTP 请求（路径/TXT/OpenList 连接与远端根）。
- 输出：`source_roots` 行（`_ensure_root_container`，`api/media_v4.py:558`）+ `source_scans` 行 + `source_scan_requests` 行（可序列化请求）。
- 负责文件：`api/media_v4.py`、`media_v4/sources/source_scan_runner.py:128`（`register_source_scan`）、`media_v4/sources/mount_metadata.py`（挂载元数据）。
- 失败/阻塞语义（HTTP 409，均为范围或配置冲突）：
  - OpenList 目录未匹配已保存内容来源路由 → 409（`api/media_v4.py:1016`）。
  - 未配置本地挂载根 → 409（`api/media_v4.py:1010`、`api/media_v4.py:933`）。
  - 增量扫描缺少已确认基线 → 409（`api/media_v4.py:1024`）。
- 可恢复点：`source_scan_requests.request_json` 保存重建 adapter 所需的非敏感参数；凭据绝不入库（`schema_v4.py:1332` 的 docstring）。

状态：已实现。

### 步骤 1：扫描（source → SourceEvidence）

- 输入：来源路径 / TXT 文本 / OpenList 列举结果。
- 输出：`SourceEvidence` 集合（含 `relative_path`、`entry_kind`、`size`、`mtime`、`fingerprint`、`source_locator`、`playback_locator`）。
- 负责文件：`media_v4/sources/scanner.py`（`scan_local_directory`、`scan_openlist_directory`、`build_directory_tree_evidence`、`read_directory_tree_text`）、`sources/adapters.py:15`（provider 映射）、`sources/incremental.py:282`（OpenList 增量）。
- durable 扫描执行器：`SourceScanRunner` 原子领取 queued 扫描、写心跳、安全点响应取消，并对旧心跳行做 stale recovery（`source_scan_runner.py:425`、`source_scan_runner.py:695`）。
- handler 分派按 `scan_kind`：`tree_snapshot`/`tree_baseline`、`local`、`openlist_full`、`openlist_incremental`（`sources/scan_handlers.py:141`、`:198`、`:233`、`:298`）。
- 失败/阻塞语义：
  - 目录树播放根无法确定 → 写 `tree_scan_validation.ok = 0` 并在确认阶段 fail-closed（见步骤 4）。
  - OpenList 单目录列举失败 → 记入 `missing_directories` 并计数，不静默当作已删除（`incremental.py:367`、`incremental.py:525`）。
  - 请求预算用尽 → `SourceScanDeferred`，任务释放执行线程，进度落库后续扫（`scan_handlers.py:88`、`source_scan_runner.py:60`）。
- 可恢复点：`source_scan_directories`（目录 frontier 与分页游标，`schema_v4.py:1388`）、`source_scans.stage/processed_count/total_count`、`v4_meta` 中扫描状态（`incremental.py:145`、`incremental.py:154`、`incremental.py:172`）。

状态：已实现。

### 步骤 2：Parsing（SourceEvidence → ParsedFacts）

- 输入：`SourceEvidence` + 来源根容器 `root_container` + 来源用途 `content_scope`。
- 输出：不可变 `ParsedFacts`。
- 负责文件：`media_v4/parsing/parser.py`（`V4Parser`；`normalize_batch_parsed_facts` 在 `parser.py:122`）、`parsing/evidence_policy.py:611`（`classify_content`）、`evidence_policy.py:840`（`arbitrate_title`）、`evidence_policy.py:369`（`parse_numbering`）、`parsing/structure.py`、`parsing/edition.py`、`parsing/release_identity.py`。
- 幂等：解析器版本 `V4Parser.VERSION = "v4-parser-18"`（`parser.py:351`）；增补解析知识必须提升版本，历史解析与 confirmed 不原位更新。
- 追更来源在此处被改写为 explicit regular：`parse_for_scope`（`tracking/ongoing.py:15`）。
- 失败语义：解析始终产出事实（含 `confidence`、`needs_review`、`reasons_json`），不抛异常阻断整批；不确定项以 `needs_review` 表达。

状态：已实现。

### 步骤 3：Resolver（ParsedFacts → MediaGraph）

- 输入：准入条目集合 + 身份上下文（既有 confirmed 绑定、候选）。
- 输出：`ResolvedMediaGraph`（Work/Season/Episode/Edition/Asset + issues）。
- 负责文件：`media_v4/resolution/resolver.py`（`MediaResolver.resolve`；准入判定 `resolver.py:698`）、`resolution/identity_contract.py`（identity key 与规范名唯一实现）、`resolution/candidates.py:527`（`plan_work_candidates`）、`resolution/ranker.py:374`（`auto_adopt`）。
- 集合级预计算只吃准入条目；冲突不拦整批（强标题不同拆 Work、编号不明拆 Episode），只有内部不变量违背才抛错（`resolver.py:1` 的 docstring）。
- 幂等键：`resolver_version` 默认 `"v4-resolver-1"`（`revisions/service.py:1730`）。
- 失败/阻塞语义：多解、歧义候选写入 `revision_issues`，由确认阶段阻断（见步骤 4）。

状态：已实现。

### 步骤 4：draft revision 预览

- 输入：已持久化的扫描证据（`_completed_scan_evidence`）或目录树验证记录；**preview 不接受前端回传的 entries**。
- 输出：`import_revisions(status='draft')` + 图预览 JSON。
- 负责文件：`api/media_v4.py:1142`（`preview`）、`revisions/service.py:1725`（`create_draft`）、`projection/library.py`（不改事实，仅在确认后重投影）。
- 失败/阻塞语义（全部 409，fail-closed）：
  - 已有 draft 但传入的 root_id/scan_id 不一致 → 409（`api/media_v4.py:1152`）。
  - 扫描未完成（状态不在 `completed`/`validated`）→ 409（`api/media_v4.py:1176`）。
  - 空来源未显式确认 → 409（`api/media_v4.py:1188`）。
  - 目录树证据与当前请求根不一致 → 409（`api/media_v4.py:1209`）。
- 可恢复点：draft revision 持久化于 SQLite，重新打开预览时直接读 `load_draft_graph`，不重新联网（`api/media_v4.py:1154`、`revisions/service.py:2792`）。

状态：已实现。

### 步骤 5：ResolverOverride（人工修正）

- 输入：`PATCH /imports/{revision_id}/evidence/{evidence_id}` + `changes`。
- 输出：新的 draft 图预览。
- 负责文件：`api/media_v4.py:1416`、`revisions/service.py:2846`（`apply_override`）；允许字段白名单 `_OVERRIDE_FIELDS`（`service.py:1291`）。
- 阻塞语义：非 draft revision 写入被触发器拒绝（`schema_v4.py:624`）；未知字段或非法值 → 409。
- 可恢复点：`revision_overrides` 持久化，仅 draft 可写。

状态：已实现。

### 步骤 6：confirmed revision

- 输入：draft revision id。
- 输出：`import_revisions.status='confirmed'`，并同事务入队 jobs。
- 负责文件：`api/media_v4.py:1268`（`confirm`）、`revisions/service.py:3048`（`confirm`）、`service.py:3033`（`validate_playback_paths`）、`service.py:3073`（`_enqueue_execution_jobs`）。
- 前置门控：
  - `_require_tree_validation`：目录树来源必须存在且通过验证记录，TXT 定位关系或来源设置变化 → 409（`api/media_v4.py:1351`）。
  - 播放定位符只做语法校验，不触盘（`service.py:3038`）。
  - `RevisionBlockedError`（存在未解决 review issue）→ 409（`revisions/service.py:1278`）。
- 入队：每个 work 一条 `scrape_work`，最后一条 `refresh_projection`，`idempotency_key` 保证重复确认不重复建任务（`service.py:3073`）。
- 可恢复点：`import_revisions.graph_digest`；确认后清理目录树验证记录属于非权威清理，失败不让接口报错（`api/media_v4.py:1305`）。
- 幂等：已 confirmed 的 revision 再次 confirm 直接返回成功（`api/media_v4.py:1278`）。

状态：已实现。

### 步骤 7：V4 jobs（刮削 → metadata_snapshot → artwork 需求）

- 输入：confirmed revision 的 outbox 行。
- 输出：`scrape_bindings`、`metadata_snapshots`、`revision_metadata_refs`、`artifact_references`、`artwork_resources`/`artwork_bindings`。
- 负责文件：`jobs/runner.py:54`（`process_job`）、`jobs/runner.py:215`（`process_available`）、`jobs/scrape.py:541`（`V4ScrapeService.process`）、`jobs/metadata.py:1082`（默认元数据提供者）、`jobs/completeness.py:56`（资料完整性）、`persistence/metadata_lifecycle.py:129`（`publish_snapshot`）。
- 本机能执行的任务类型只有 `scrape_work`、`recover_work_aliases`、`refresh_projection`、`delete_source_library`（`jobs/runner.py:39`）；历史 `materialize_mirror`/`cleanup_superseded_artifacts` 不迁移为假成功（`runner.py:59`）。
- 只有 confirmed revision 的排队任务可执行，且前置步骤必须成功（`runner.py:89`、`runner.py:91`）。
- 成功发布时：先 `publish_snapshot` 落不可变资料快照，再 `enqueue_metadata` 登记图片需求（`jobs/scrape.py:880`）。资料未就绪时保留旧快照，标记 `refresh_status='failed'`（`jobs/scrape.py:888`）。
- 失败语义：刮削失败也是终态；`artifact_only_failure` 把"只缺图片"的历史失败只读归一为资料 ready，仍需过图片门槛（`projection/library.py:391`、`jobs/completeness.py:32`）。

状态：已实现。

### 步骤 8：SQLite → Library Projection

- 输入：confirmed 事实 + 已发布资料快照 + 已发布图片。
- 输出：`library_generations`/`library_cards`/`library_details`/`library_changes`（原子发布）。
- 负责文件：`projection/library.py:222`（`_rebuild`）、`projection/library.py:201`（`refresh_if_needed`）、`projection/refresh.py:17`（`ProjectionRefreshScheduler.tick`）、`projection/changes.py`。
- 发布必须同时满足：`metadata_state == 'ready'` 且 `required_artwork_status(...)['status'] == 'ready'`（`projection/library.py:428`）。
- 只在发布阶段持写锁；文件摘要检查用 WAL 读快照（`projection/library.py:118` 注释）。
- 可丢弃性：发布时 `DELETE FROM library_generations WHERE generation_id != ?` 级联清理旧代次（`projection/library.py:569`）。

状态：已实现。

## 3. 准入门禁：特别篇/辅助视频、正片集号、未知类型

| 规则 | 行为 | 证据 |
| --- | --- | --- |
| OP/ED/PV/CM/MENU 等辅助内容 | `is_importable=False`、`is_auxiliary=True`，不生成媒体实体 | `parsing/evidence_policy.py:663` |
| 小数集、第零集、OVA/OAD/SP 标记、整段发行目录 | 归 `attached_special`，`is_importable=False`，不生成 Work/Episode/Asset | `evidence_policy.py:702` 起 |
| 明确附属关系（SP/S00/特典目录） | 排除；若文件同时写有集号，记 `CLASSIFICATION_CONFLICT` 但仍按附属关系排除 | `evidence_policy.py:744` |
| 显式电影证据 / 剧场版 / 映画 / 电影目录 | 归 `movie`，`is_importable=True`，media_type=movie | `evidence_policy.py:770` |
| 独立作品/外传（无特别篇标记） | 保留为独立可播放 Work | `evidence_policy.py:794` |
| 有明确集号或**显式**季号 | 归 `regular` 正片，media_type=tv；识别器父目录启发式给的非显式季号不足以单独升级为 tv | `evidence_policy.py:811` |
| 仅有 OVA/OAD 发行形式、无类型证据 | 保留 `unknown`、可播放、不自动归父 | `evidence_policy.py:831` |
| 完全无类型证据 | 保留 `unknown`、可播放 | `evidence_policy.py:845` |

准入集合判定在 Resolver 侧收口：`_is_admitted` 过滤 `is_importable=False`、`is_auxiliary`、`special_candidate`、`group_type == "special"` 及显式排除类别；兼容升级前的 `content_class == 'unknown'` 不构成排除依据（`resolution/resolver.py:698`）。

投影侧另有一道只读门：`VISIBLE_BINDING_SQL` 只允许 `episode_kind` 非 special/auxiliary 且季非 special 的绑定进入展示；历史 legacy 特别篇成员"消失于投影与详情"而不删除事实（`projection/presentation.py:34`）。

未知季/集的处理：`seasons.local_season_number` 允许 NULL（未分季），`identity_key` 非空的季受 `v4_season_identity_kind_guard_*` 触发器约束（未分季必须真的 NULL，正片季号必须 > 0，`schema_v4.py:1730`）；详情层 `numbering_status` 直接由 `local_episode_number is None` 决定（`projection/details.py:164`）。

测试证据：`backend/tests/test_v4_special_exclusion_policy.py`（特别篇排除与正片保留）、`test_v4_special_classification_boundaries.py`、`test_v4_selected_specials.py`、`test_v4_technical_numbering_boundaries.py`、`test_v4_import_numbering_status.py`、`test_v4_recognition_gating.py`。

## 4. 增量更新与追更

### 4.1 OpenList/TXT 增量合并规则

- 基线是**上一份 confirmed revision 的完整证据集合**，不是内存检查点（`sources/incremental.py:1` 的 docstring）。
- 检查点（`source_scan_directories` + `v4_meta` 状态）只决定下一轮优先核对哪些远端目录，可删除可重建（`incremental.py:145`、`incremental.py:189`）。
- 删除保护：只有 `listing_complete` 时才把"远端消失的目录/文件"当作删除；不完整列举下保留基线条目（`incremental.py:419`、`incremental.py:461`）。
- 硬上限：`verification_budget`、`max_entries=20_000`、`max_depth=32`（`incremental.py:292`）。

### 4.2 追更（ongoing）来源

- `content_scope` 是来源的显式用途，只有 `ongoing`/`completed`（`tracking/ongoing.py:66`）。已确认导入的来源不能直接改分类；追更必须使用独立文件夹，且不能与已完结来源互相包含（`tracking/ongoing.py:69`、`ongoing.py:100`）。
- 手动/启动/定时触发统一走 `refresh_all_sources`（`tracking/refresh.py:82`），受 `_refresh_lock` 串行化；已有 queued/running/blocked/needs_confirmation/needs_new_txt 的来源直接跳过，不重复登记（`refresh.py:95`）。
- `tree_snapshot` 来源不能自动追更，必须上传新 TXT（`refresh.py:99`）。
- 定时调度由 `OngoingScheduler.tick` 决定（interval/daily/weekly），用 `v4_meta` 的 `ongoing_last_scheduled_at`/`ongoing_calendar_slot` 防重复（`tracking/scheduler.py:22`）。

### 4.3 追更合并的保护条件

`assess_update`（`tracking/ongoing.py:113`）只在以下全部成立时返回 `append`（自动追加、无需人工确认）：

- 来源 `content_scope == 'ongoing'`、无 `revision_overrides`、存在上一份 confirmed revision（`ongoing.py:117`）。
- 旧文件槽位是当前槽位的子集（不允许已有文件消失）。
- 每个保留路径的解析事实在 `work_title/year/media_type/group_type/season_candidate/episode_candidate/episode_range/content_class/is_importable` 上完全一致；`size/mtime/fingerprint/raw_file_id` 在双方都非空时必须一致。
- 新增条目必须是可导入的 tv 正片、`needs_review=False`、`episode_candidate > 0`、无 `episode_range`、在旧绑定中恰好归属 1 个 work、集号未被占用。
- 该 work 必须已有恰好 1 条 `provider='tmdb'` 且 `status='confirmed'` 的绑定，`provider_bindings` 中恰好 1 条同 provider_id 的 tv 身份，`provider_id` 为纯数字且 `metadata_state == 'ready'`。

任一不成立 → `review`，交回预览由用户确认。`unchanged` 时把 draft 置为 `superseded`，且收口前再复核一次，避免吞掉并发人工修改（`ongoing.py:190`）。

测试证据：`test_v4_ongoing_flow.py`、`test_v4_ongoing_import.py`、`test_v4_ongoing_refresh.py`、`test_v4_ongoing_scheduler.py`、`test_v4_openlist_incremental.py`、`test_v4_openlist_frontier_resume.py`、`test_v4_retired_source_baseline.py`。

## 5. 图片与刮削：租约、重试、派生尺寸、发布门槛

- 服务：`ArtworkService`（`assets/service.py:54`）后台 daemon，每轮处理上限 64 条、最多 2 个并发下载线程（`assets/service.py:111`、`assets/service.py:120`）。
- 租约：`_claim` 只在写事务内认领，`state='running'` 且 `lease_until < now` 的行先被回收为 pending，再逐条发新 `lease_token` 与 `lease_until = now + 120`（`assets/service.py:142`）。
- 重试：失败按 `attempts` 退避，上限 5 次后转 `failed`；退避 `min(3600, 30 * 2**attempts)`；本地手工图源非法直接 `failed` 并标 `error_kind='invalid_manual_source'`（`assets/service.py:317`）。
- 下载安全：只接受 `image.tmdb.org`、拒绝查询串/片段/路径跳转、限制 25MB、校验图片签名与像素上限（`assets/service.py:212`、`assets/catalog.py:17`）。
- 派生尺寸：按角色宽度表生成 webp，`RECIPE_VERSION='webp-v1'`，尺寸写入 `artwork_variants`（`assets/catalog.py:17`、`assets/catalog.py:18`、`assets/service.py:271`）。
- 发布：`_publish` 要求所有 live binding 的角色宽度齐全；尺寸缺失则候选退回 pending，先不发布（`assets/service.py:328`、`assets/service.py:344`）。
- 发布门槛（卡片可见）：`required_artwork_status` 只把海报、背景图、当前正片预览图算作必需；演员图、推荐图、clearlogo 不阻断；电影不要求剧集预览图（`assets/status.py:6`、`assets/status.py:51`）。同时 `metadata_state` 必须是 `ready`（`projection/library.py:428`）。

测试证据：`test_v4_artwork_publication_gate.py`、`test_v4_required_episode_artwork.py`、`test_v4_artwork_scheduling.py`、`test_v4_artwork_download_safety.py`、`test_v4_thumbnails_pipeline`（`test_thumbnail_pipeline.py`）、`test_v4_artifact_only_failure.py`、`test_v4_snapshot_resource_independence.py`。

## 6. 未确认项

- 未确认：`resolve_local_path` 在 OpenList 路由映射中的完整分支（大小写、UNC、多路由优先级）本次未逐行核对，只确认它是播放定位符的唯一生成入口（`sources/scanner.py:714` 附近、`integrations/openlist/providers.py`）。
- 未确认：`_configured_cloud_roots` 与 `_configured_tree_roots` 对新旧配置键的兼容范围（`api/media_v4.py:402`、`api/media_v4.py:417`）未逐行验证。
- 未确认：`jobs/runner.py` 的 `recover_stale_jobs` 对"长期无心跳但进程仍活"的任务是否只有 120 秒一档（`runner.py:525` 签名已确认，阈值语义未逐行确认）。
- 未确认：`media_collections` 与合集成员的产生路径（`revision_collection_members` 的写入方）在本次核对中未定位到具体写入函数。
- 未确认：`source_health` 的冷却阈值与 `openlist_telemetry` 的实际消费点（表结构与索引已确认，写入方未逐行核对）。
- 未确认：`_adopt_manual_page` 的 `artwork_manual_adoption_cursor` 在超大库上的分页完成判定（`~complete`）已确认，但历史库首次迁移的实际耗时未测量。
