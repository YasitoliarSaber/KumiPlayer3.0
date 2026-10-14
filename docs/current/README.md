# docs/current —— 重构前置分析文档

本目录是 **2026-10-14 KumiPlayer 3.0 前端重构前置阶段**建立的分析文档集，记录**当前系统真实能力**，作为重构设计的唯一起点。

## 本目录的定位

- **只描述已存在的系统**，不记录未来计划、不推荐技术栈、不设计新页面。
- 内容来源于当前源码（`backend/app/`、`src/`、`src-tauri/`）、`backend/tests`、`tests/` 与构建脚本；**不以旧前端结构、旧文档或历史方案为依据**。
- 与 `docs/PROJECT.md` 的分工：`PROJECT.md` 是**规范性的现行架构说明**（定义系统应当如何运作、维护原则、边界合同），本目录是**面向重构的现状分析**（能力清单、接口契约、数据模型、流程步骤、可改与不可改边界）。两者冲突时以源码为准，并先修正文档。
- 当前前端（React 19 + Fluent UI + Zustand）在本目录中只作为**能力消费方**出现：用于说明后端能力被谁调用、哪些交互已实现，不作为新架构依据。

## 阅读顺序（给设计方）

1. [`rebuild-context.md`](rebuild-context.md) — 入口：交接边界、硬性要求、期望产出
2. [`system-overview.md`](system-overview.md) — 产品边界、运行形态、持久化、系统级不变量
3. [`page-requirements.md`](page-requirements.md) — 需要哪些页面、要什么数据、支持什么操作、哪些能力不存在
4. [`feature-list.md`](feature-list.md) — 功能地图与实现程度
5. [`user-flow.md`](user-flow.md) — 用户流程与每步的等待、失败与恢复
6. [`data-model.md`](data-model.md) — 数据实体、关系与前端需要的字段
7. [`api-reference.md`](api-reference.md) — 全部后端端点与请求 / 响应契约
8. [`media-pipeline.md`](media-pipeline.md) — 导入与识别流程的真实步骤
9. [`playback-flow.md`](playback-flow.md) — 播放链路
10. [`backend-architecture.md`](backend-architecture.md) — 后端模块与后台工作者
11. [`frontend-analysis.md`](frontend-analysis.md) — 现有前端结构与已知问题（历史包袱，不作设计参照）
12. [`refactor-baseline.md`](refactor-baseline.md) — 不可破坏的边界、可重设计范围、未核实问题、验证入口
13. [`rebuild-summary.md`](rebuild-summary.md) — 全局总结与重构注意事项

## 文档清单

| 文档 | 内容 |
|---|---|
| `rebuild-context.md` | 给设计方的入口说明：交接边界、禁止事项、项目现行 UI 研究规则、期望产出 |
| `system-overview.md` | 产品边界、运行形态、进程与后台工作线程、持久化落点、系统级不变量 |
| `page-requirements.md` | 逐页目的、所需数据、所需操作、跨页面能力、**不存在的能力清单** |
| `feature-list.md` | 按产品能力分类的**已确认存在**功能，含代码位置、数据来源、前端依赖面与状态 |
| `user-flow.md` | 新用户 / 日常 / 导入四条入口 / 追更 / 纠错 / 故障恢复的完整流程与状态覆盖要求 |
| `data-model.md` | SQLite V4 实体、字段用途、不可变事实与触发器、投影表、迁移机制 |
| `api-reference.md` | 全部 HTTP 端点清单与核心端点契约、错误语义、前端调用位置 |
| `media-pipeline.md` | 导入真实流程：来源登记 → 扫描 → 证据 → 解析 → 身份 → 确认 → 作业 → 投影 |
| `playback-flow.md` | 播放真实流程：点击 → 路径解析 → MPV 启动 → IPC 观察 → 进度 / 历史写入 |
| `backend-architecture.md` | 技术栈、模块职责、并发与锁、限流、错误与安全边界、空壳目录清单 |
| `frontend-analysis.md` | 现有前端技术栈、页面与组件结构、状态管理、API 调用方式、可确认的问题 |
| `refactor-baseline.md` | 不能破坏的边界、可以重新设计的部分、当前未知问题、重构期验证入口 |
| `rebuild-summary.md` | 项目真实状态、当前前端问题、后端已具备能力、新前端范围、重构注意事项 |

## 维护约定

- 新分析文档一律放入本目录；已确认失效的内容移入 `docs/90_历史归档/`，不留在 `docs/` 根目录。
- 涉及识别规则库时，唯一维护入口仍是 `docs/识别公共规则库与整体排查-2026-09-22.md`（按来源无关规则追加），本目录只做索引。
- 涉及识别专题的具体问题、证据与回归状态，唯一维护入口是 `docs/媒体结构识别问题与回归验证记录.md`。
- 持续任务恢复与待核实项清单在 `docs/项目现状与改进清单.md`，本目录不复制其条目。
- 文档级状态判定与版本控制边界记录在 `docs/DOCUMENT_CLEANUP_REPORT.md`。
- **版本控制提示**：`docs/**` 受 `.gitignore` 排除，本目录内容默认不进入 Git（只有 `docs/review/` 与两个样本 TXT 被显式放行）。若要交给外部设计方，见 `docs/DOCUMENT_CLEANUP_REPORT.md` 第 4 节，需用户决定是否追加放行规则；不得使用 `git add -f`。
