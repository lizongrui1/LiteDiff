# 0001：实施计划

- Status: Done
- Related spec: [`spec.md`](spec.md)

## 1. 方案概述

采用轻量、仓库原生 SDD，而不是安装外部 CLI：

1. 先用 `docs/analysis/` 固化架构、模块和风险基线。
2. 用 `docs/sdd/` 定义 constitution、分级工作流、质量门禁及安全/性能不变量。
3. 用 `specs/product/` 保存当前产品事实，用 `specs/changes/` 保存有边界的变更。
4. 用 `AGENTS.md`、`CONTRIBUTING.md`、PR 模板和项目 Skill 把人类与 AI 路由到同一事实来源。
5. 用跨平台验证脚本执行现有工具链，不以文档声明代替实际证据。

## 2. 影响范围

| 模块/文件 | 改动 | 风险 |
|---|---|---|
| `docs/` | 新增分析、SDD 制度、ADR、计划和进度 | 低 |
| `specs/` | 新增产品基线、模板和 0001 变更记录 | 中：若与代码漂移会误导后续开发 |
| `AGENTS.md` | 新增仓库级 AI 工作约束 | 中：错误路由会影响后续自动改动 |
| `CONTRIBUTING.md` | 新增本地开发、分级流程和验证说明 | 低 |
| `.github/pull_request_template.md` | 新增变更等级、规范链接和证据字段 | 低 |
| `.codex/skills/litediff-sdd/` | 新增仓库内项目 Skill | 中：需通过 schema 校验并避免扩大触发范围 |
| `scripts/verify.sh`、`scripts/verify.ps1` | 新增现有门禁的一键封装 | 低：不进入应用运行时 |
| `README.md`、`README.zh-CN.md` | 增加贡献入口并修正明显文档漂移 | 低：只影响文档 |

## 3. 接口与数据兼容性

- Rust/TypeScript IPC：不修改。
- 设置与历史格式：不修改。
- 文件系统、Git 和发布行为：不修改。
- 新脚本只调用仓库已有工具链；不写入受版本控制的构建产物。
- 项目 Skill 只引用仓库相对路径，不依赖个人全局目录。

## 4. 安全与隐私

- 新增不可信输入：无。验证脚本只接受本机环境变量和命令参数。
- 路径、能力或权限变化：无。
- 外部命令或网络访问：验证脚本调用本地 `cargo`、`npm` 和项目脚本；不主动访问网络。
- 对应 `SEC-NN`：全部保持；特别是不新增 renderer capability、文件写入路径、Git 子命令或持久化数据。
- 文档不得包含真实令牌、私钥、内部 URL 或用户数据。

## 5. 性能

- 不修改应用运行时，核心算法复杂度不变。
- 验证脚本串行运行全部门禁，优先保证证据完整而不是缩短本地等待时间。
- 对应 `PERF-NN`：全部保持。
- 文档中的预算数值必须与代码常量一致，避免后续按错误目标优化。

## 6. 测试策略

- 文档：检查相对链接、占位符、路径是否存在、产品规范与代码常量是否一致。
- Skill：运行 skill-creator 的 `quick_validate.py`。
- Shell：实际执行 `bash scripts/verify.sh`，并单独检查 `bash -n`。
- PowerShell：当前主机没有 `pwsh` 时做静态审查，并明确记录 `NOT RUN`。
- 应用：运行 `cargo fmt`、`cargo clippy`、`cargo test --workspace`、`npm test`、`npm run check`、`npm run build`。
- 差异：运行 `git diff --check`、`git status --short`、`git diff --stat`，确认本次没有运行时文件编辑。

## 7. 替代方案

| 方案 | 优点 | 未采用原因 |
|---|---|---|
| 直接使用 GitHub Spec Kit | 工具成熟、命令体系完整 | 对当前单仓库中小型项目偏重，并增加外部 CLI 依赖 |
| 只写 CONTRIBUTING | 成本最低 | 无法保存产品基线、风险证据和跨会话上下文 |
| 所有改动强制四份文档 | 一致性最高 | 小修复仪式成本过高，容易绕开流程 |
| 每个模块单独维护完整 spec | 模块边界清楚 | 当前产品规模小，容易产生重复和漂移 |

## 8. 发布与回滚

- 本次不发布应用版本。
- 失败恢复只需移除新增 SDD 文件并还原 README/PR 模板修改；不得回滚既有业务改动。
- 若验证暴露本次文档或脚本问题，只修复对应新增文件。
- 若验证暴露既有业务代码问题，单独记录并以新的可追踪变更处理，不夹带进本次迁移。
