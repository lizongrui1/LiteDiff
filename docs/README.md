# LiteDiff 文档索引

本目录是 LiteDiff 的工程知识入口。代码、测试和产品规范冲突时，先停止实现并修正规范或代码，不能让两者继续分叉。

## 先读什么

1. [`AGENTS.md`](../AGENTS.md)：AI 编码代理和开发者必须遵守的工作流。
2. [`docs/sdd/constitution.md`](sdd/constitution.md)：项目不可随意破坏的原则。
3. [`docs/sdd/workflow.md`](sdd/workflow.md)：不同规模改动应走哪条 SDD 路径。
4. [`specs/product/litediff.md`](../specs/product/litediff.md)：当前产品行为和验收基线。
5. [`docs/analysis/project-overview.md`](analysis/project-overview.md)：架构、入口、构建和运行方式。

## 文档地图

| 路径 | 用途 |
|---|---|
| `docs/sdd/` | SDD 原则、工作流、质量门禁、安全与性能约束 |
| `docs/analysis/` | 当前系统分析、模块清单和风险清单 |
| `docs/plan/` | 本次 SDD 落地的任务拆分、依赖图和里程碑 |
| `docs/progress/` | 本次迁移的进度与决策记录 |
| `docs/adr/` | 已接受的架构决策 |
| `.codex/skills/litediff-sdd/` | 仓库内 AI 代理的 SDD 路由、边界和验证规则 |
| `specs/product/` | 长期维护的产品能力规范 |
| `specs/changes/` | 每次功能、修复、重构或高风险改动的变更规范 |
| `specs/_template/` | 新变更规范模板 |

## 历史文档

根目录的 `STEP1.md` 到 `STEP4.md` 记录了项目早期实现阶段。它们是历史材料，不是当前需求或接口的事实来源。当前行为以代码、测试和 `specs/product/` 为准。
