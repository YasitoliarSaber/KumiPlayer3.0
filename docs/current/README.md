# 现有系统事实索引

本目录保留 2026-10-14 基于源码和测试整理的能力快照。它描述当前 Tauri + React + Fluent 应用，不是 3.0 设计方案，也不约束未来页面、导航、配色或组件。源码、实际测试与用户最新指令优先；文中固定行号和历史测试统计应在使用前复核。

3.0 方向仅为 Electron + React + TypeScript、不继承 Fluent 与旧视觉、优先成熟模块化组件；尚未选库、设计或实施迁移。后续规划从实际能力与业务合同出发。

| 文档 | 保留用途 |
|---|---|
| [系统总览](system-overview.md) | 当前运行层与产品能力 |
| [功能清单](feature-list.md) | 已有功能及缺口，不冻结新页面范围 |
| [用户流程](user-flow.md) | 当前真实操作和业务边界 |
| [接口参考](api-reference.md) | 路由、客户端与能力线索，以 OpenAPI 为准 |
| [数据模型](data-model.md) | V4 权威数据及身份 |
| [后端架构](backend-architecture.md) | 领域与持久化职责 |
| [导入链路](media-pipeline.md) | 来源、解析、确认与作业 |
| [播放流程](playback-flow.md) | Asset、本地路径、MPV 与进度 |
| [前端现状](frontend-analysis.md) | 当前实现与技术债，不推荐新架构 |

旧重构交接、页面规划、蓝图、原型与设计输入已删除。清单与验证见 [仓库整理记录](../DOCUMENT_CLEANUP_REPORT.md)。本目录由现有 .gitignore 例外跟踪，其他本地开发文档保持原有边界，不强制提交。
