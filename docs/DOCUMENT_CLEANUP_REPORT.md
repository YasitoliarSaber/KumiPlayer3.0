# 仓库整理记录（2026-10-15）

## 基线与范围

- 分支 `codex/backend-v4`，清理前 HEAD `fc4b7ed2ee004e15d8ff404b0f3b82e7b01983a1`。
- 初始 `git status --short` 只有 `?? App.jsx`。先保守暂留，完整核对正文后确认它是废弃蓝图的评估页，与本任务直接相关，追加清单后按用户授权删除；无其他用户改动。
- 当前入口为 `index.html` 的 `/旧前端/src/main.tsx`，后者导入 `旧前端/src/App.tsx`；tsconfig 仅包含 src。旧蓝图声明未实施，Git 历史没有新前端工程落地提交。所有受跟踪测试、源码、脚本和本地 CI 均无对 frontend-design、design-input、DESIGN.md 的运行依赖。
- 仅清理无用的前端规划和开发约束。不修改 Python、SQLite schema、识别、MPV、数据、配置、凭据、缓存及依赖，不执行 Electron 迁移。

## A 类删除清单（删除前登记）

以下逐项结合正文、Git 跟踪状态、实际入口与引用检查确认。文档之间的互引不构成运行依赖；现行入口同步更新。删除前路径、SHA-256 和状态已在本地审计清单记录，执行时逐项校验。已提交文件可从 Git 历史恢复，本地文件按用户授权直接删除，不再复制一套归档。

| 文件 | 来源 | 删除依据与引用关系 |
|---|---|---|
| `docs/frontend-design/DESIGN_IMPLEMENTATION_MATRIX.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/DESIGN_SYSTEM.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/FRONTEND_ARCHITECTURE_V2.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/IA.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/KumiPlayer_Design_Sources/DESIGN_SYSTEM_V1_0_ORIGINAL.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/KumiPlayer_Design_Sources/DESIGN_SYSTEM_V1_1_MERGED_FOR_REVIEW.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/KumiPlayer_Design_Sources/DESIGN_SYSTEM_V1_1_REVISIONS.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/KumiPlayer_Design_Sources/PROTOTYPE_SPEC_ORIGINAL.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/KumiPlayer_Design_Sources/README.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/PROTOTYPE_REVIEW.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/PROTOTYPE_SPEC.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/README.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/frontend-design/sources/FRONTEND_ARCHITECTURE_V1.md` | 本地忽略文件，无 Git 历史 | 未实施的设计系统、原型、蓝图及 P0—P7 规划；正文声明未实施，运行与测试入口均不消费 |
| `docs/design-input/backend-capability-summary.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/design-constraints.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/feature-map.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/page-requirements.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/product-overview.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/README.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/rebuild-baseline.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/design-input/user-flow.md` | 已提交（fc4b7ed） | fc4b7ed 新增的重复设计输入；含旧视觉参考和交接流程，业务事实由 current 与源码保留 |
| `docs/current/page-requirements.md` | 已提交（fc4b7ed） | fc4b7ed 的旧重构交接、总结、页面规划与阶段验收口径；不属于运行合同 |
| `docs/current/rebuild-context.md` | 已提交（fc4b7ed） | fc4b7ed 的旧重构交接、总结、页面规划与阶段验收口径；不属于运行合同 |
| `docs/current/rebuild-summary.md` | 已提交（fc4b7ed） | fc4b7ed 的旧重构交接、总结、页面规划与阶段验收口径；不属于运行合同 |
| `docs/current/refactor-baseline.md` | 已提交（fc4b7ed） | fc4b7ed 的旧重构交接、总结、页面规划与阶段验收口径；不属于运行合同 |
| `.context/winui-on-web-reference-2026-08-12.md` | 本地忽略文件，无 Git 历史 | 本地旧配色、Fluent/WinUI 强制规则和视觉参考；已被用户 2026-10-15 指令废止，无运行消费者 |
| `DESIGN.md` | 本地忽略文件，无 Git 历史 | 本地旧配色、Fluent/WinUI 强制规则和视觉参考；已被用户 2026-10-15 指令废止，无运行消费者 |
| `docs/01_项目基准/KumiPlayer_UI组件接入与性能策略_2026-07-09.md` | 本地忽略文件，无 Git 历史 | 本地旧配色、Fluent/WinUI 强制规则和视觉参考；已被用户 2026-10-15 指令废止，无运行消费者 |
| `docs/01_项目基准/KumiPlayer_视觉风格与主题规范_2026-07-08.md` | 本地忽略文件，无 Git 历史 | 本地旧配色、Fluent/WinUI 强制规则和视觉参考；已被用户 2026-10-15 指令废止，无运行消费者 |
| `docs/assets/KumiPlayer_UI设计参考_awesome-design-md.pdf` | 本地忽略文件，无 Git 历史 | 本地旧配色、Fluent/WinUI 强制规则和视觉参考；已被用户 2026-10-15 指令废止，无运行消费者 |
| `UI参考设计规范.md` | 本地忽略文件，无 Git 历史 | 本地旧配色、Fluent/WinUI 强制规则和视觉参考；已被用户 2026-10-15 指令废止，无运行消费者 |

| `App.jsx` | 本地未提交文件，无 Git 历史 | 旧 DS v1.1、蓝图 v2、P0—P7、Fluent/Tauri 规划的评估页；未被当前入口、编译或测试引用，正文用途确认后删除 |

## B 类归档

本次无新增归档。旧设计材料已失效且没有独立于源码的保留价值，直接删除。既有 `docs/90_历史归档/` 属其他时期的后端、识别、工具与协作记录，已有历史标识，保留；其中原有旧重构入口链接改为退役说明。

## C 类保留

- `docs/current/` 中接口、后端架构、数据模型、功能清单、前端现状、导入链、播放链、系统总览、真实用户流程共 9 篇事实快照；索引明确其不约束新前端设计，最终以源码为准。
- `docs/PROJECT.md`、`PROJECT_MEMORY.md`、分发/许可证、配置与数据目录、命名/解析/识别规则、运行架构与图片性能基线及真实 TXT 样本保留。
- 90 个前端测试文件、257 个后端测试文件全部保留；Rust 内联测试及其入口保留。`package.json` 的 Node 契约、Vitest 的组件/lib 收集、pytest 与 Cargo 入口不变。
- `p001/p005/p006` 等测试检查候选身份、不可变事实、删除 TTL/并发/越界保护、播放历史与追更，并非前端 P0—P7 计划。`media-management-p005-rework` 仍测试删除预览、阻止态、错误脱敏及当前来源卡。
- 主题、配色、Fluent、CSP nonce、启动首帧、布局和性能测试当前仍有真实源码目标；保留以保护现有应用，不把这些断言套用到未来独立前端。
- 静态相对导入扫描从 main.tsx 到达 114 个 TS/TSX/CSS 文件；未到达的是类型声明和 errorLog 客户端，没有发现可直接判定属于未完成重构的 src 原型模块。

## D 类保留待裁决

| 文件 | 引用与疑点 | 处置 |
|---|---|---|
| `旧前端/src/api/errorLog.ts` | 未在当前 UI 导入，但对接真实 `/api/error-log` 后端，后端有 `test_error_log_api.py` | 不能确认属于旧前端重构，保留，不需要阻塞本次清理 |
| `.context/` 其他预览、性能实验、后端基线及 output/generated-images | 主要服务已投入使用的页面修复或其他任务，不能证明来自本次废弃规划 | 不作泛化清空；含旧指令的交接文档标注已退役 |

## 开发指导更新

更新 AGENTS、README、PROJECT、PROJECT_MEMORY、目录索引、UI 组件入口，以及 .agents/.claude 两份 guardrails，撤销固定 WinUI/Fluent、配色与原型布局约束。未来方向仅为 Electron + React + TypeScript、成熟可替换组件、无 Fluent 继承；本次不选库、不设计页面。现有 Tauri/Fluent 是当前运行事实，不能在迁移前删除。

## 验证

清理前：前端构建通过；Node 契约 125 项（124 通过、1 失败）；Vitest 60 文件/521 项（516 通过、5 失败）；四组后端合同 47 项通过。

已有失败：来源卡源码断言仍在大页面寻找已抽到 SourceLibraryCard 的按钮；组件测试找不到“未定位作品”和“确认删除媒体库”；设置组件 3 项在并发执行时超时。均在删除前发生，保留测试，不归咎于本次清理，也不为通过而删除。

| 检查 | 清理前 | 清理后 |
|---|---|---|
| `npm run test:contracts` | 124 通过、1 失败（125 项） | 124 通过、同一项失败 |
| `npm run test:components` 默认并发 | 516 通过、5 失败（521 项） | 510 通过、11 项超时（521 项） |
| 上述两轮失败涉及的 8 个组件测试文件，`--maxWorkers=2` | 未单独执行 | 182/182 通过；无修改测试、超时阈值或配置 |
| `npm run build` | 通过 | 通过 |
| pytest 四组合同：schema、import schema、identity boundary、tree mapping | 47/47 通过 | 47/47 通过 |
| 现行文档 Markdown 链接、删除清单和改动范围检查 | 删除前已登记 | 无断链；清单 32 项全部移除；无运行源码或测试改动 |

默认并发组件测试存在不稳定性：清理前两项找不到节点、三项超时，清理后全量是十一项超时；涉及八个文件降低并发后全部通过。不能把收窄复核冒充默认全量通过，也没有在本次修复其并发/时序稳定性。Node 契约的既有失败继续保留，没有为全绿删除断言。

`npm test` 在契约失败后会短路，故组件测试前后分别显式运行。执行的窄后端命令为 `uv run --project backend python -m pytest backend/tests/test_v4_schema_contract.py backend/tests/test_v4_import_contract_schema.py backend/tests/test_v4_identity_boundary_contracts.py backend/tests/test_v4_tree_mapping_contract.py -q --tb=short`。历史资料提及的“80 个后端失败”未在本次全量重跑，不能当成本次实测结论。未执行完整后端/Rust、真实桌面/网盘/MPV 验收或 EXE 打包。

## 收尾结论与版本控制

共删除 32 个文件：12 个已提交文档、19 个本地忽略资料、1 个未提交评估原型。未新增归档，业务源码、依赖、数据与全部测试保留。当前有效入口已撤销旧视觉、旧蓝图与旧路线图；保留的现状资料和历史档案均明确适用范围。无待用户裁决且阻碍本轮清理的内容；errorLog 客户端及其他任务实验保守保留，不认定为本次废弃重构。

适合进入 Electron 新前端架构规划；这不代表现有全部测试已绿或产品完成运行验收。后续施工应独立处理既有契约断言失配与组件测试稳定性。

README、事实索引、清理记录及受跟踪文件变更进入本地提交；AGENTS、PROJECT、PROJECT_MEMORY、PROJECT_STRUCTURE、两份 guardrails 和历史交接更新按原规则仅保存在本地，不强制提交。本次不推送远端。
