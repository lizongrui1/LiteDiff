# 0001：任务清单

- Status: Done
- Related plan: [`plan.md`](plan.md)

| 任务 ID | 任务 | 依赖 | 文件/模块 | 验收方式 | 状态 |
|---|---|---|---|---|---|
| T-01 | 盘点架构、模块、入口、测试和风险 | 无 | `docs/analysis/` | 概览、清单、风险表完成 | DONE |
| T-02 | 定义 constitution 与 L0-L3 工作流 | T-01 | `docs/sdd/constitution.md`、`workflow.md` | 条款和产物表可执行 | DONE |
| T-03 | 固化质量门禁及安全/性能不变量 | T-01、T-02 | `docs/sdd/quality-gates.md`、`security-and-performance.md` | 数值与代码一致 | DONE |
| T-04 | 记录采用轻量 SDD 的 ADR | T-02 | `docs/adr/0001-adopt-lightweight-sdd.md` | 背景、替代方案、后果完整 | DONE |
| T-05 | 建立 specs 索引、模板和状态规则 | T-02 | `specs/README.md`、`specs/_template/` | 新变更可直接复制 | DONE |
| T-06 | 编写当前产品基线 | T-01、T-03 | `specs/product/litediff.md` | 覆盖产品、安全、性能、限制和测试映射 | DONE |
| T-07 | 编写本次变更记录 | T-05、T-06 | `specs/changes/0001-adopt-sdd/` | 四份制品完整且无占位符 | DONE |
| T-08 | 编写仓库级 AI 指令 | T-02、T-06 | `AGENTS.md` | 读取顺序、分级、边界和验证明确 | DONE |
| T-09 | 编写贡献者指南 | T-05、T-06 | `CONTRIBUTING.md` | 新人可完成安装、开发、验证和 PR | DONE |
| T-10 | 增加 PR 模板 | T-05 | `.github/pull_request_template.md` | 强制声明等级、规范、证据和风险 | DONE |
| T-11 | 创建并校验项目 Skill | T-08、T-06 | `.codex/skills/litediff-sdd/` | quick validator 通过 | DONE |
| T-12 | 从双语 README 链接开发规范 | T-08、T-09 | `README.md`、`README.zh-CN.md` | 两种语言都能找到入口 | DONE |
| T-13 | 编写跨平台验证脚本 | T-03 | `scripts/verify.sh`、`scripts/verify.ps1` | 覆盖六项门禁；Shell 实跑，PowerShell 记录状态 | DONE |
| T-14 | 执行前后端验证并记录证据 | T-07、T-11、T-13 | `verification.md` | 每条 AC 有 PASS/FAIL/NOT RUN | DONE |
| T-15 | 检查链接、占位符、差异和进度 | T-14 | `docs/progress/`、最终差异 | 无断链、无残留，差异范围可控 | DONE |
