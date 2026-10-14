# 重构总结（重构前置）

> 记录日期：2026-10-14
> 事实来源：本目录全部分析文档 + `backend/app/`、`src/`、`src-tauri/`、`backend/tests/`、`tests/`、`docs/PROJECT.md`、`docs/项目现状与改进清单.md`
> 定位：回答「项目现在处于什么状态、前端有什么问题、后端已经能做什么、新前端要实现什么、重构时要注意什么」。这是本轮分析的总收口。

## 1. 项目真实状态

KumiPlayer 是一个**已在使用的 Windows 桌面媒体库与播放器**，不是原型或半成品。

| 维度 | 状态 |
|---|---|
| 后端 | V4 唯一执行链已完成并成为唯一实现：`SourceEvidence → ParsedFacts → MediaGraph → confirmed revision → V4 jobs → SQLite → Library Projection`；V3 执行链只剩 13 个空壳目录 |
| 数据库 | SQLite V4，`V4_SCHEMA_VERSION = 27`；逻辑合同 54 张必需表 + 17 个必需触发器；迁移在单事务内完成，失败回滚 |
| 接口 | 131 个端点，13 个路由器；前端实际消费其中约 60 个端点（含动态路径），另有约 20 个端点前端未消费 |
| 前端 | React 19 + TypeScript + Fluent UI v9 + Zustand 5 + Tailwind 4 + Vite 8，构建于 Tauri 2 / WebView2；10 个页面组件共 7025 行 |
| 图片 | 独立受管图片库（原图 + 按内容版本 / 配方 / 尺寸的 WebP 派生），有发布门槛：必需图就绪才发布卡片与详情 |
| 播放 | 内置干净 MPV + 自有配置两层，JSON IPC 单观察者写进度 / 历史 / 已看状态 |
| 测试 | 后端 `backend/tests` **2813 passed / 80 failed**（已知历史欠账，见第 5 节）；前端契约为 `tests/*.test.ts` + `tests/components`、`tests/lib` |
| CI | **无有效远端 CI**：`.github/` 被忽略、远端不含该目录；所有验证均为本地验证 |
| 实测缺口 | 真实挂载 + 真实 MPV 播放验收、三主题真实桌面视觉、干净 Windows 完整安装验收、真实 WebView2 滚动性能均未完成 |

## 2. 当前前端问题（可验证事实）

| 问题 | 量化 | 影响 |
|---|---|---|
| 超大单文件 | `src/pages/WorkDetailPage.tsx` 2357 行、`MediaManagementPage.tsx` 2137 行、`SettingsPage.tsx` 935 行；`src/` 内 >500 行文件 7 个 | 修改成本高，状态与视图耦合 |
| 历史主样式表 | `src/index.css` **13834 行**，占全部 CSS 约 87%；`src/styles/` 分层仅约 1217 行 | 样式无统一来源，主题适配难以验证 |
| 组件 / 页面级 CSS 散落 | 6 个组件与页面目录下的 CSS 共 532 行在分层体系之外 | 与分层入口并存，规则冲突风险 |
| 兼容层仍在生产链路 | `src/api/workDetailV4Compatibility.ts` 197 行，含永久 reject 的方法与 `appendEpisodes: false` 开关 | 死分支与真实能力混在一起 |
| 页面级懒加载不完整 | 4 / 9 个页面懒加载（`src/App.tsx:21-24` 为懒加载，`:12-16` 为静态） | 分类海报墙页为静态导入 |
| 类型与常量重复 | `SourceId` 在 `src/api/types.ts:4` 与 `src/stores/ui.ts:11` 各定义一次；`SortId` 同理且取值集合不同；`src/api/types.ts:26` 的 `PageId` 无引用 | 语义漂移风险 |
| 请求封装分叉 | `src/api/bangumi.ts:72`、`src/api/system.ts:15`、`src/api/errorLog.ts:55` 各自实现超时 / 头处理；硬编码 `37821` 两处 | 会话与超时策略不一致 |
| 端点重复 | 进度写入两个端点并存（`/api/playback/progress` 与 `/api/v4/playback/progress`） | 前端需决定唯一权威 |
| 图片宽度档逻辑分散 | `src/api/assets.ts:13`、`src/utils/artwork.ts:16`、`src/components/library/VirtualizedPosterGrid.tsx:22` 三处 | 与后端 `RECIPE_VERSION` 需跨层同步（OPT-11） |
| 主题映射不完整 | 3 个 UI 主题只映射 2 套 Fluent 主题：`cinema` 走 `cinemaTheme`，`fluent` 与 `mica` 均走 `webLightTheme`（`src/design/fluentTheme.ts:45`） | mica 与 fluent 无实际视觉差异 |
| 无消费方的模块 | `src/api/errorLog.ts`（62 行）无导入方；`src/api/library.ts:46` `rescanLibrary`、`:48` `getDiagnostics` 无调用方 | 后端能力闲置 |
| 导航模型非标准 | 不是 URL Router：`src/App.tsx:221-240` 用状态切换页面，搜索词非空即覆盖当前页 | 无法直接套用浏览器导航心智 |

以上均为代码可验证事实。**本轮不做主观评价，也不给视觉方案**——视觉与结构方案由设计方决定。

## 3. 后端已具备的能力（新前端可直接消费）

| 能力域 | 主要内容 |
|---|---|
| 媒体库读取 | 列表、增量变更游标（5 秒 / 不可见 30 秒）、批量卡片、单作品详情、观看状态与收藏 |
| 导入 | 四入口（本地目录 / 目录树 TXT / OpenList / 混合）、durable 扫描、草稿预览、人工覆盖 evidence、确认 revision、执行明细、取消 |
| 来源管理 | 来源卡列表、诊断报告、目录检查、重命名、删除预览 / 确认 / 恢复 |
| 识别与解析 | 不可变 ParsedFacts、集号标题、特别篇与辅助视频门禁、未知类型保留 `unknown`/`null` |
| 刮削与元数据 | 候选搜索、确认绑定（作品级 / 季度级）、重试、工件补齐、手动标题与封面（用户数据） |
| 图片 | 受管图片库、发布门槛、按尺寸读取派生资源、批量准备、失败冷却与重试 |
| 播放 | 启动 / 停止 / 状态、进度写入与已看标记、历史与继续播放、Bangumi 完成同步 |
| 追更 | 追更来源与作品状态、单作品扫描、全量扫描、取消失败语义 |
| 任务 | 任务列表 / 详情 / 取消 / 重试（长任务与页面生命周期解耦） |
| 设置 | 配置读写、首次引导分步写入、MPV 运行时与打开配置、各服务连接测试、TMDB 图片诊断与修复 |
| 集成 | OpenList 连接 / 路由 / 浏览 / 预取 / 遥测；Bangumi 账号 / 搜索 / 匹配 / 收藏 / 进度 |
| 系统 | 打开视频文件夹（ID-only）、桌面辅助关机、健康检查、心跳 WebSocket |
| 诊断 | 错误日志统计 / 导出 / 处理 / 清理（**7 个端点，前端目前零消费**）、媒体库诊断摘要 |

依据：`docs/current/api-reference.md`、`feature-list.md`。

## 4. 新前端需要实现的范围

| 范围 | 说明 |
|---|---|
| 信息架构与导航 | 替代现有「状态驱动 7 页面 + 搜索覆盖」模型，需自建导航（后端无 URL 路由语义） |
| 10 个页面 | 首次引导、首页、分类 / 新番、搜索、收藏、最近观看、作品详情、媒体管理（总览 / 导入 / 维护）、设置（7 分类）、播放调校 |
| 全部流程态 | 导入四入口、识别预览、确认执行、追更、刮削与纠错、故障恢复 |
| Design System | 控件全状态（默认 / 悬停 / 按下 / 聚焦 / 禁用 / 加载 / 错误 / 空）、三主题、三档动效（`reduced` 必须无动画降级） |
| 组件库 | 至少覆盖海报卡、海报墙网格（虚拟化）、季集选择器、任务进度、来源卡、设置表单、对话框、空 / 错误状态、恢复页 |
| 请求层 | 统一的会话 Token 注入、超时、错误映射；决定是否接入未消费能力（错误日志界面等） |
| 性能约束 | 海报墙规模可达上千，需虚拟化 + 图片预算 + 原生滚动，不做网格级重渲染 |
| 无障碍 | 键盘可达、焦点可见、语义化控件 |

**不包含**：后端、数据库、Tauri 桌面壳、MPV 集成、打包流程。

## 5. 重构注意事项（按风险排序）

### 5.1 必须先知道的两件事

1. **后端测试不是全绿**。2026-10-14 实测 `pytest backend/tests` 为 2813 passed / 80 failed，集中在 `test_v4_sqlite_runtime.py`、`test_v4_structure_collections.py`、`test_v4_verified_provider_numbering.py`、`test_v4_work_execution_detail.py` 等投影 / 详情 / 编号类文件；已用 stash 基线对照确认与当日工作无关，是图片发布策略与资料严格化留下的旧断言欠账。**不能把"后端测试通过"当重构安全网**。
2. **本资料集不进入 Git**。`docs/**` 受 `.gitignore:100`、`:143` 排除（只有 `docs/review/` 与两个样本 TXT 被显式放行），且项目规则禁止 `git add -f`。若要把资料交给外部设计方，需用户决定是否追加放行规则，详见 `docs/DOCUMENT_CLEANUP_REPORT.md` 第 4 节。

### 5.2 不可破坏的边界（详见 `refactor-baseline.md`）

- 媒体事实唯一权威是 SQLite V4；前端不持有、不推断媒体事实。
- 用户数据（手动标题、手动封面、收藏、观看状态）优先于在线资料。
- 卡片与详情只在必需图片就绪后发布；不回到"缺图占位卡先入墙"。
- 播放只接受已保存的本地绝对路径；不生成 STRM；网盘经本地挂载。
- 会话 Token 不可绕过；图片与 WebSocket 用受限查询参数。
- 图片 URL 配方（`RECIPE_VERSION` / `ROLE_WIDTHS`）与前端正则必须一致。

### 5.3 容易踩的坑

| 坑 | 后果 |
|---|---|
| 引入 URL Router 并假设后端有页面接口 | 后端不存在对应语义，导航必须自建 |
| 直接 `fetch` 而不带会话 Header | 全部业务接口 401，图片与 WebSocket 静默失败 |
| 为了"先看见"渲染缺图卡片 | 与 2026-10-10 确认的发布策略冲突 |
| 依据 `docs/review/`、`docs/90_历史归档/` 施工 | 会恢复已退役的 V3 链路或已删除能力 |
| 为"追加剧集"等不存在能力留入口 | 后端无路由，调用直接 reject |
| 依赖 `/docs` 或 OpenAPI | bundled 模式已关闭这些端点 |

### 5.4 验证节奏建议

- 前端改动的最小验证：`npm run test:contracts` + `npm run test:components` + `npm run build`。
- `tests/*.test.ts` 中的契约测试（`api-session`、`poster-card-contract`、`settings-layout-contract`、`media-management-ui-contract` 等）是**跨层合同**：重构后应同步改写，而不是删除。
- 后端定向验证用 `uv run --project backend python -m pytest backend/tests/<file>`，避免 11.5 分钟全量；并先确认失败项与 5.1 的已知欠账无关。
- 仓库无 ESLint，`tests/` 不在 `tsc` 项目内（OPT-10）；引入 Lint 属新增工程决策。

### 5.5 资料维护

- 事实来源顺序不变：当前源码与测试 > `docs/PROJECT.md` / `docs/PROJECT_MEMORY.md` > 其他文档；冲突时以代码为准并回写本目录。
- 持续任务与待核实项以 `docs/项目现状与改进清单.md` 为准，本目录不复制其条目。
- 识别规则以 `docs/识别公共规则库与整体排查-2026-09-22.md` 为追加入口，识别专题问题与回归以 `docs/媒体结构识别问题与回归验证记录.md` 为入口。
- 文档级状态与版本控制边界见 `docs/DOCUMENT_CLEANUP_REPORT.md`。

## 6. 下一步

按 `rebuild-context.md` 的阅读顺序把整套资料交给设计方，进入 Design System、页面原型与组件规范阶段。**本轮不开始前端重构**；任何需要后端配合的设计诉求应走"提案"路径单独列出，不与主设计混在一起。
