# 重构基线：不可破坏的边界与可重设计范围

> 记录日期：2026-10-14
> 事实来源：`backend/app/`、`src/`、`src-tauri/`、`backend/tests/`、`tests/`、`docs/PROJECT.md`、`docs/项目现状与改进清单.md`
> 定位：回答「新前端重构时哪些东西必须原样保留、哪些可以推倒重来、还有哪些问题没查清、怎么验证没搞坏」。本文件不设计界面，也不裁定后端架构是否需要改动。

## 1. 一句话结论

本次重构的范围是 **`src/` 全部前端代码与前端交互结构**。Python 后端、SQLite 数据、Tauri 桌面壳、MPV 集成都不在重构范围内，而它们对新前端的约束是**刚性的**：新前端必须适配现有接口与数据结构，而不是反过来。

## 2. 不可破坏的边界（硬约束）

### 2.1 后端与数据

| 边界 | 内容 | 依据 |
|---|---|---|
| 唯一执行链 | `SourceEvidence → ParsedFacts → MediaGraph → confirmed revision → V4 jobs → SQLite → Library Projection` 是唯一链路，不存在第二套导入管线或隐藏 fallback | `docs/PROJECT.md` 第 5 节、`docs/current/system-overview.md` 第 7 节 |
| 不可变事实 | 来源证据、解析事实与 confirmed revision 不可被前端、刮削或投影反向改写 | `docs/PROJECT.md` 第 1 节 |
| 唯一权威 | 媒体事实唯一权威是 SQLite V4；前端只消费投影与接口，不持有媒体事实 | `docs/PROJECT.md` 第 1、9 节 |
| schema 版本 | 版本常量唯一来源是 `backend/app/media_v4/persistence/schema_v4.py` 的 `V4_SCHEMA_VERSION`；高于程序版本的库拒绝打开 | `docs/PROJECT.md` 第 9 节 |
| 用户数据保护 | 手动标题、手动图片、收藏、观看状态属于用户数据，普通重扫、增量与资料刷新不得覆盖 | `docs/PROJECT.md` 第 1 节 |
| 真实媒体零改动 | 不移动、不重命名、不删除用户真实影片；删除只退役受控媒体记录 | `docs/PROJECT.md` 第 1、6 节 |

### 2.2 HTTP 契约

- 端点前缀与语义固定：`/api/v4`、`/api/v4/tracking`、`/api/library`、`/api/playback`、`/api/openlist`、`/api/assets/artwork/{id}/{version}/{width}`、`/api/config`、`/api/integrations/bangumi`、`/api/tasks`、`/api/system`、`/api/error-log`、`/api/health`、`/api/heartbeat`、`/ws/*`（`docs/PROJECT.md` 第 4.3 节）。完整端点契约见 `docs/current/api-reference.md`。
- 鉴权不可绕过：业务请求必须带桌面壳生成的会话 Token；图片与 WebSocket 因浏览器限制使用受限查询参数（`backend/app/core/api_security.py`）。
- 前端必须先从桌面壳取得 Token，并等待已鉴权的 `/api/config` 成功后才渲染；冷启动最多重试 30 秒（`docs/PROJECT.md` 第 10 节）。
- `bundled` 模式关闭 `/docs`、`/redoc`、`/openapi.json`，因此新前端**不能依赖运行时 OpenAPI 文档**。

### 2.3 图片与资源 URL

- 普通展示只接受**带内容版本的本地 artwork URL**（`/api/assets/artwork/{id}/{version}/{width}`）。
- 前端 artwork URL 正则与后端 `RECIPE_VERSION` / `ROLE_WIDTHS` 必须保持一致；改配方必须跨层同步并加契约测试（`docs/项目现状与改进清单.md` OPT-11）。
- 旧远程图片代理、镜像图片读取与请求现场缩图接口已退役，**不得回退到上游地址**（`docs/PROJECT.md` 第 7 节）。

### 2.4 播放合同

| 边界 | 内容 |
|---|---|
| 只接受本地绝对路径 | 播放不接受来源定位符、HTTP、设备路径或播放列表包装文件；不生成 STRM |
| 内置 MPV | 只加载 KumiPlayer 自己的配置层，`--config-dir` 指向自有 portable_config 与 kumiplayer 两层，**不得传 `--no-config`** |
| 单一观察者 | 仅一个 JSON IPC 观察者写进度、历史与已看状态 |
| 进度身份 | 进度按原 Episode / Asset 身份保存；换片不复制旧进度 |

依据：`docs/PROJECT.md` 第 7 节、`mpv/README.md`、`docs/current/playback-flow.md`。

### 2.5 发布门槛与展示语义

- 作品卡片与详情仅在必需图片（海报、背景图、当前正片每集预览图）本地全部展示尺寸就绪后才发布；**不得回到「缺图占位卡先入墙」**（`docs/PROJECT.md` 第 7 节，2026-10-10 用户确认）。
- 前端同步必须走有界 changes 游标 + 增量卡片，不能退化为轮询全量列表。
- `generation_id` 与 `updating` 必须被区分：首次未发布 / 已发布空库 / 后台更新中。

### 2.6 配置与本地数据兼容

- `data/config.json`、Windows Credential Manager、`data/` 各子目录的既有内容必须继续可读；`mirror_dir` 保留为可空的旧配置兼容项，不参与新导入 / 图片 / 播放（`docs/项目现状与改进清单.md` OPT-06）。
- 本机 UI 偏好（主题、动效、卡片密度等）现有持久化位置需迁移或兼容，不能静默丢弃用户设置。

## 3. 可以重新设计的部分

### 3.1 完全可重写

| 范围 | 现状规模 | 说明 |
|---|---|---|
| 样式体系 | `src/index.css` 13834 行 + `src/styles/` 约 1217 行 | 已是历史主样式表，项目自身规则也只允许渐进拆分（`docs/PROJECT.md` 第 12 节）；重构可直接建立新的样式基座 |
| 页面组件 | `src/pages/` 10 个文件、7025 行 | 详情页 2357 行、媒体管理页 2137 行、设置页 935 行，均为单体大文件 |
| 组件结构 | `src/components/` 31 个 tsx、4566 行，分 7 个目录 | 可重新划分层级与组合方式 |
| 状态管理 | `src/stores/` 6 个 store、1192 行 | 可替换或重新切分；需保留的能力见 3.2 |
| 页面调度方式 | `src/App.tsx` 274 行、状态驱动、非 URL Router | 可重新设计导航模型，但需保留 3.2 中的既有交互语义 |
| 兼容层 | `src/api/workDetailV4Compatibility.ts` 197 行 | 含 `appendEpisodes: false` 等能力开关；重构可直接以真实能力重建，无需保留该兼容层 |

### 3.2 可重设计但必须保留的行为语义

这些是用户已经在用的交互事实，重构可以换实现方式，不能丢失：

1. 搜索词非空即覆盖当前页面（`src/App.tsx:240`）。
2. 详情页打开时滚动位置重置到顶部，不从上一页继承（`docs/PROJECT.md` 第 8 节）。
3. 主滚动容器保持原生滚动，不拦截滚轮、不在主线程补间（同上）。
4. 海报墙滚动不提交网格级 React 更新；只渲染可见卡片（同上）。
5. 长任务离开页面不取消，可恢复继续（同上）。
6. 拖入目录树 TXT 直接进入导入流程（`src/App.tsx:105-124`）。
7. 空白处与海报禁用浏览器默认右键菜单，输入框保留系统编辑菜单（同上）。
8. 三套外观（fluent / cinema / mica）与三档动效（reduced / standard / expressive）由用户可切换（`src/stores/ui.ts:7-9`）。

### 3.3 明确不属于本次重构

- 后端模块划分、域层与 API 层的耦合（`docs/项目现状与改进清单.md` OPT-01、OPT-02 已判定保留）。
- 空壳 V3 目录清理（OPT-04 判定保留）。
- 打包与构建入口（`build_tauri.bat`、`build_installer.bat` 保持标准入口）。
- MPV 二进制与自有配置层。

## 4. 已知问题与未核实项（重构前必须知道）

### 4.1 已确认缺陷

`docs/项目现状与改进清单.md` 第七节记录的 7 项已确认缺陷（DEF-01 ~ DEF-07）在 2026-10-14 均已实施处置，其中 DEF-07 移除了播放调校的独立死入口，保留了设置页播放分类内嵌 `PlayerTuningPage` 的形态。该文件仍是这些条目当前状态的唯一入口。

### 4.2 未核实项（会直接影响重构判断）

| 编号 | 事项 | 为什么与重构相关 |
|---|---|---|
| TBC-03 | 源码模式下手动启动后端时业务接口不校验 Token（`backend/app/core/api_security.py:31-34`） | 新前端的请求层不能假设"一定已鉴权"，也不能把回环地址当作鉴权 |
| TBC-06 | 首次播放前本地路径挂载探测的真实延迟未测量 | 影响「点击播放到窗口出现」的反馈设计，但当前无测量证据，不得当作已知瓶颈 |
| TBC-09 | 后端 7 条 `/api/error-log` 路由完整，但前端无任何消费界面 | 新前端若计划做「错误日志 / 问题记录」界面，这是现成能力；否则需明确该接口仅供诊断 |
| TBC-11 | 9 个历史测试文件已删除，其中部分对应产品级约束 | 重构若改变详情页进度控件等行为，可能失去回归保护 |
| TBC-12 | 后端 `mypy` 与前端 `npm test` 未在最近一轮完整运行 | 重构前的基线验证需要先补齐 |

### 4.3 后端测试现状（重要）

2026-10-14 实测 `uv run --project backend python -m pytest backend/tests` 结果为 **2813 passed / 80 failed**（约 11.5 分钟）。失败集中在 `test_v4_sqlite_runtime.py`、`test_v4_structure_collections.py`、`test_v4_verified_provider_numbering.py`、`test_v4_work_execution_detail.py` 等投影 / 详情 / 编号类文件，抽样错误为 `artwork.status` 期望 `not_required` 实际 `failed`，以及用例自身解包 `IndexError`。

- 已用 stash 基线对照确认：这四份文件的失败在**未包含当日改动的 HEAD 上同样存在**，与当日工作无关。
- 性质：图片发布策略与资料严格化改动留下的旧断言欠账，属独立历史问题。

**对重构的直接影响**：不能用"后端测试全绿"作为重构安全网；前端重构本身不依赖后端测试全绿，但任何触及后端契约的工作必须先处理这 80 项。

依据：`docs/项目现状与改进清单.md` 第八节「后端全量结果」。

### 4.4 尚未完成的验收

- 真实挂载 + 真实 MPV 播放验收（用户自行执行，见 `.context/验收提示词-TXT原位置定位-2026-10-14.md`）。
- 三主题与真实 Windows 桌面视觉未复验。
- 干净 Windows 完整安装验收未执行。
- 真实 WebView2 滚动性能未实测（`docs/PROJECT.md` 开头说明）。

## 5. 重构期验证入口

| 目的 | 命令 | 覆盖内容 |
|---|---|---|
| 前端契约测试 | `npm run test:contracts` | `tests/*.test.ts`，含 `api-session.test.ts`、`poster-card-contract.test.ts`、`settings-layout-contract.test.ts`、`media-management-ui-contract.test.ts` 等；这些是前端与后端/设计的**跨层合同**，重构后必须同步改写而不是删除 |
| 前端组件测试 | `npm run test:components` | `vitest` 运行 `tests/components/**`、`tests/lib/**` |
| 生产构建 | `npm run build` | `tsc -b && vite build`，验证类型与打包 |
| 版本一致性 | `npm run check:versions` | npm 锁、Python 项目与锁、Cargo、Tauri 配置的版本基准 |
| 后端定向 | `uv run --project backend python -m pytest backend/tests/<file>` | 只跑与改动相关文件，避免 11.5 分钟全量 |
| 桌面壳 | `cargo fmt --check`、`cargo test --locked`、`cargo clippy --locked --all-targets -- -D warnings`（在 `src-tauri/`） | 仅在触及桌面壳时执行 |

注意事项：

- `tests/` 不在 `tsc` 项目范围内，且仓库无 ESLint（`docs/项目现状与改进清单.md` OPT-10）。前端重构若引入 Lint，属于新增工程决策，需单独评估。
- 后端测试存在上文 4.3 的 80 项已知失败，定向验证时要先确认失败项与本轮改动无关。
- `.github/` 被忽略且远端不含该目录，当前**没有可用的远端 CI**（`docs/项目现状与改进清单.md` TBC-07）。所有验证都是本地验证，汇报时必须如实标注「未执行」项。

## 6. 高风险清单（重构时最容易踩的坑）

| 风险 | 触发条件 | 后果 |
|---|---|---|
| 破坏鉴权链 | 新前端直接 `fetch` 而不带会话 Header / 查询参数 | 所有业务接口 401，图片与 WebSocket 静默失败 |
| 绕过图片就绪门槛 | 新前端为了"先看见"渲染缺图卡片 | 与 2026-10-10 用户确认的发布策略冲突 |
| 把 URL 路由当成既定事实 | 直接引入 react-router 并假设后端有对应页面接口 | 后端不存在路由/页面接口，导航模型必须自建 |
| 重新解释媒体事实 | 前端基于某个接口返回值推断季集结构并缓存 | 与"前端不持有媒体事实"冲突，出现前端与 SQLite 不一致 |
| 丢失用户数据语义 | 重扫/刷新时用在线资料覆盖手动标题或封面 | 用户手动纠错被清空 |
| 假设网盘在线播放 | 为网盘路径提供直接播放入口 | 播放合同只接受本地挂载路径 |
| 依赖 `/docs` 与 OpenAPI | 在 bundled 模式下读取运行时接口文档 | bundled 模式已关闭这些端点 |
| 把历史文档当现行事实 | 依据 `docs/review/`、`docs/90_历史归档/` 施工 | 会恢复已退役的 V3 链路或已删除的能力 |
