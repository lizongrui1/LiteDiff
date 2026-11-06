# 里程碑

| 里程碑 | 条件 | 交付物 |
|---|---|---|
| M1 基线明确 | 架构、模块、风险、约束已记录 | `docs/analysis/*` |
| M2 制度可执行 | 原则、工作流、安全/性能边界和验证命令已定义 | `docs/sdd/*`、ADR、验证脚本 |
| M3 变更可追踪 | 产品基线、模板和本次变更记录可用于实际开发 | `specs/product/*`、`specs/_template/*`、`specs/changes/0001-adopt-sdd/*` |
| M4 新人可上手 | 贡献流程、PR 模板、README 和项目 Skill 已连通 | `AGENTS.md`、`CONTRIBUTING.md`、`.github/pull_request_template.md`、`.codex/skills/litediff-sdd/` |
| M5 可交付 | 前端和 Rust 全部门禁通过，文档链接和 Skill 校验通过 | 验证记录和最终差异审查 |

## M5 验收证据

- `npm test`：全部通过。
- `npm run check`：无错误。
- `npm run build`：成功。
- `cargo fmt --all -- --check`：无差异。
- `cargo clippy --workspace --all-targets -- -D warnings`：无警告。
- `cargo test --workspace`：全部通过。
- `scripts/verify.sh`：在对应平台可执行。
- skill validator：通过。
