# 0001：采用轻量、仓库原生 SDD

- Status: Done
- Risk: L2
- Owner: LiteDiff maintainers
- Created: 2026-11-06
- Change directory: `specs/changes/0001-adopt-sdd/`

## 1. 背景与问题

LiteDiff 已具备差分引擎、Tauri 安全边界、虚拟滚动、Git 比较和较完整的前端测试，但缺少统一的产品基线、变更分级、验证证据和跨会话协作入口。现有 `STEP*.md` 只能说明早期实现过程，README 也不能承担接口、安全与性能约束的单一事实来源。

当前工作树同时包含尚未提交的安全与性能改进。建立开发规范时必须保留这些改动，不能为了整理文档而回滚、重写或重新格式化无关代码。

## 2. 目标

- 建立适用于小型桌面项目、人类开发者和 AI 编码代理的轻量 SDD 流程。
- 用 L0-L3 将流程强度与风险匹配，避免每个文案修复都被迫生成一整套文档。
- 为当前产品行为、限制、安全和性能预算提供唯一长期基线。
- 提供可直接复制的变更模板、贡献指南、PR 模板和项目级 AI Skill。
- 提供 macOS/Linux/Git Bash 与 Windows 的一键验证脚本。
- 记录本次迁移的证据、未执行项和后续改进点。

## 3. 非目标

- 不引入 GitHub Spec Kit、外部服务或新的运行时依赖。
- 不改变 LiteDiff 的用户功能、IPC、算法、设置格式或发布行为。
- 不重构现有业务代码，不拆分大组件，不顺手修复未纳入本次范围的缺陷。
- 不提交、推送、创建 PR 或发布版本。
- 不声称尚未自动化的真实窗口 E2E 和跨平台人工验证已经完成。

## 4. 需求与验收标准

| 需求 ID | 需求 | 验收标准 |
|---|---|---|
| REQ-SDD-01 | 建立项目 constitution、分级工作流、质量门禁和安全/性能不变量。 | L0-L3 的产物和验证要求明确，可直接用于 PR 评审。 |
| REQ-SDD-02 | 建立长期产品规范和逐次变更规范。 | 产品规范覆盖输入、保存、差分、视图、Git、历史、设置、安全、性能和限制；每个领域能映射到测试。 |
| REQ-SDD-03 | 提供可复制的 spec/plan/tasks/verification 模板。 | 新变更可复制模板并声明状态、等级、验收和证据。 |
| REQ-SDD-04 | 为本次迁移保存完整变更记录。 | `spec.md`、`plan.md`、`tasks.md`、`verification.md` 均存在且相互链接。 |
| REQ-SDD-05 | 建立人类贡献者和 AI 代理入口。 | 根目录存在 `AGENTS.md`、`CONTRIBUTING.md`、PR 模板和项目 Skill；中英文 README 均可找到入口。 |
| REQ-SDD-06 | 提供一键质量门禁。 | `scripts/verify.sh` 和 `scripts/verify.ps1` 覆盖 fmt、clippy、Rust tests、前端 tests、类型检查和构建。 |
| REQ-SDD-07 | 不改变运行时行为。 | 本次新增或修改的文件只限于 SDD 文档、README、PR 模板、验证脚本和项目 Skill。 |
| REQ-SDD-08 | 保持现有工作树安全。 | 不删除、回滚或重新格式化既有未提交改动；最终差异审查能区分既有业务改动与本次新增规范。 |
| REQ-SDD-09 | 文档和 Skill 可用。 | 新增 Markdown 相对链接无断链；实际变更无未替换占位符；项目 Skill 通过官方 quick validator。 |

### 验收标准映射

| 验收 ID | 对应需求 | 验收标准 |
|---|---|---|
| AC-01 | REQ-SDD-01 | constitution、工作流、质量门禁和安全/性能不变量完整且互相链接。 |
| AC-02 | REQ-SDD-02 | 产品规范覆盖当前产品行为、限制、安全、性能与测试映射。 |
| AC-03 | REQ-SDD-03、REQ-SDD-04 | 模板齐全，0001 四份变更制品完整且无未替换变量。 |
| AC-04 | REQ-SDD-05 | AGENTS、CONTRIBUTING、PR 模板和项目 Skill 形成连续入口，Skill validator 通过。 |
| AC-05 | REQ-SDD-05 | 中英文 README 都能定位开发规范。 |
| AC-06 | REQ-SDD-06 | `scripts/verify.sh` 覆盖并实际通过六项质量门禁。 |
| AC-07 | REQ-SDD-06 | Rust fmt、clippy 和 workspace tests 全部通过。 |
| AC-08 | REQ-SDD-09 | 文档相对链接无断链，实际变更无残留占位符。 |
| AC-09 | REQ-SDD-07、REQ-SDD-08 | 最终编辑范围只涉及文档、README、PR 模板、验证脚本和项目 Skill，既有运行时改动未被回滚。 |

## 5. 约束与不变量

- 相关产品规范：[`specs/product/litediff.md`](../../product/litediff.md)。
- 安全不变量：`SEC-01` 至 `SEC-12` 不因工具或流程文档变化而放宽。
- 性能不变量：`PERF-01` 至 `PERF-09` 不因验证脚本或 README 调整而改变。
- 平台：验证脚本要能表达 macOS/Linux 与 Windows 两条路径；当前主机只能实际执行其中一条。
- 工作树：禁止 `git reset --hard`、`git checkout --`、自动格式化全仓库等可能覆盖用户改动的命令。
- 依赖：不新增 npm、Cargo 或系统运行时依赖。

## 6. Open Questions

None。后续是否接入 PR 级 CI 或增量性能基准属于独立变更，不在本次范围内。
