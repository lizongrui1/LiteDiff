# SDD 迁移总进度

## 任务

将 LiteDiff 转换为轻量、可执行、适合 AI 和多人协作的 Spec-Driven Development 规范，不改变现有业务行为，不回滚未提交改动。

## 当前状态

| 阶段 | 状态 | 详细进度 |
|---|---|---|
| Phase 1：基线与边界 | 已完成 | [phase-1-baseline.md](./phase-1-baseline.md) |
| Phase 2：SDD 核心制度 | 已完成 | [phase-2-sdd-core.md](./phase-2-sdd-core.md) |
| Phase 3：规范体系 | 已完成 | [phase-3-specs.md](./phase-3-specs.md) |
| Phase 4：贡献者与 AI 集成 | 已完成 | [phase-4-integration.md](./phase-4-integration.md) |
| Phase 5：验证与交付 | 已完成 | [phase-5-validation.md](./phase-5-validation.md) |

## 依赖文档

- [项目概览](../analysis/project-overview.md)
- [模块清单](../analysis/module-inventory.md)
- [风险清单](../analysis/risk-assessment.md)
- [任务拆分](../plan/task-breakdown.md)
- [依赖图](../plan/dependency-graph.md)
- [里程碑](../plan/milestones.md)

## 决策记录

- 采用轻量、仓库原生 SDD；不绑定 GitHub Spec Kit CLI。
- 保持 Rust/Tauri + Svelte 技术栈和现有验证命令。
- 允许小型修复走轻量路径；跨模块、安全、性能和发布改动走完整路径。

## 验证基线

- macOS 15.8.1 arm64，Rust/Cargo 1.99.1，Node 26.0.0，npm 11.12.1。
- `bash scripts/verify.sh` 通过：fmt、clippy、Rust tests、前端 tests、类型检查和生产构建全部成功。
- Rust：138 个测试通过（74 app + 45 core + 18 engine + 1 doctest）。
- 前端：330/330 测试通过，`svelte-check` 为 0 error / 0 warning。
- macOS `.app` 打包冒烟通过，release 二进制构建成功，产出 9.0 MB 应用包。
- Skill validator、`bash -n`、`git diff --check` 和 68 个 Markdown 相对链接检查通过。
- 敏感信息、私钥文件名和本机绝对路径扫描无命中；GitHub Actions YAML 与 Shell 脚本语法检查通过。
- 当前主机没有 PowerShell，`scripts/verify.ps1` 仅完成静态审查，实跑标记为 `NOT RUN`。

完整证据见 [`specs/changes/0001-adopt-sdd/verification.md`](../../specs/changes/0001-adopt-sdd/verification.md)。

## 后续建议

1. 用本流程完成一次真实 L1 bugfix 和一次 L2 功能开发，观察模板成本。
2. 为 PR 增加持续 CI，使质量门禁不只依赖发布工作流和本地脚本。
3. 在 Windows 开发机实际执行 `scripts/verify.ps1`。
4. 将真实窗口 E2E 和性能阈值基准作为独立 L2/L3 变更规划。
