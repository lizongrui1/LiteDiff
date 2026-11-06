# SDD 工作流

## 1. 开始任何改动前

按顺序读取：

1. 根目录 `AGENTS.md`。
2. `docs/sdd/constitution.md`。
3. `specs/product/litediff.md`。
4. `specs/README.md`。
5. 当前相关的 `specs/changes/<id>/`。
6. `docs/analysis/risk-assessment.md` 中受影响的风险项。

如果已有 `docs/progress/MASTER.md`，先读取当前状态，不要假设上一次会话已经完成。

## 2. 变更分级

| 等级 | 典型改动 | 必需制品 | 额外要求 |
|---|---|---|---|
| L0 | 文案、注释、纯文档、无行为变化的格式化 | 无变更目录 | PR 说明为何无行为变化；运行受影响检查 |
| L1 | 单模块小修复、可复现 UI 缺陷、局部测试补充 | `spec.md`、`verification.md` | 需要根因和回归测试；可省略独立 plan/tasks |
| L2 | 新功能、跨文件重构、接口或数据模型变化、性能优化 | `spec.md`、`plan.md`、`tasks.md`、`verification.md` | 更新产品规范；记录兼容性 |
| L3 | 安全边界、文件写入、Git 执行、历史格式、发布、重大算法或架构变化 | L2 全部制品 + ADR | 必须有威胁/性能分析、回滚方案和跨平台验证 |

无法确定时按更高等级处理。多个 L1 改动组合成跨模块变更时升级为 L2。

## 3. 标准生命周期

### Step 1：Specify

在 `specs/changes/NNNN-slug/spec.md` 写明：

- 背景和问题。
- 用户或工程目标。
- 非目标。
- 验收标准。
- 约束、风险和受影响的不变量。

规范阶段不锁定实现细节，除非技术约束本身就是需求。

### Step 2：Clarify

在实现前消除：

- 含糊术语。
- 未定义边界和异常路径。
- 前后端契约歧义。
- 数据兼容和回滚未知项。

无法消除的问题写入 `Open Questions`，不得静默假设。

### Step 3：Plan

在 `plan.md` 记录：

- 方案和受影响模块。
- 替代方案及未采用原因。
- 安全、隐私、性能和兼容性影响。
- 测试策略。
- 回滚或失败恢复。

### Step 4：Tasks

在 `tasks.md` 拆成有顺序、可验证的任务。每项包含：

- 任务 ID。
- 依赖。
- 涉及文件或模块。
- 验收方式。

任务应足够小，使一次提交可以独立解释和回滚。

### Step 5：Implement

- 行为修复尽量先添加失败测试。
- 不修改与变更无关的未提交工作。
- 跨 IPC 改动同时更新 Rust、TypeScript 和契约测试。
- 触及安全或性能边界时，立即更新计划中的风险和验证项。

### Step 6：Verify

运行：

```bash
bash scripts/verify.sh
```

在 `verification.md` 记录命令、结果和未覆盖项。人工验证必须写明步骤、环境和预期结果。

### Step 7：Converge

实现和规范不一致时，在合并前完成其中一项：

- 修改代码使行为符合规范。
- 修改规范并把变化记录为有意决策。

同时更新：

- `specs/product/litediff.md`（行为变化时）。
- 受影响的架构或风险文档。
- 变更状态和最终验证结果。

### Step 8：PR

PR 必须链接变更目录，并填写：

- 变更等级。
- 验收标准。
- 验证证据。
- 安全、性能、兼容性影响。
- 回滚方案。

## 4. 新建变更

1. 查看 `specs/changes/` 中已有的最大编号。
2. 创建 `specs/changes/NNNN-short-slug/`。
3. 从 `specs/_template/` 复制所需文件。
4. 把 `{{ID}}`、`{{TITLE}}`、`{{DATE}}` 替换为真实值。
5. 将 `status` 设为 `draft`，完成评审后改为 `ready`。

## 5. 状态流转

```text
draft -> ready -> implementing -> verifying -> done
                       |              |
                       +-> blocked    +-> abandoned
```

| 状态 | 含义 |
|---|---|
| `draft` | 正在澄清需求和方案 |
| `ready` | 可以开始实现 |
| `implementing` | 正在编码 |
| `verifying` | 等待或正在执行验证 |
| `done` | 验收通过且规范已同步 |
| `blocked` | 有明确外部阻塞 |
| `abandoned` | 决定不做，记录原因 |

## 6. 紧急修复

若安全问题或数据损坏要求先止血：

1. 在 PR 描述中标记 `emergency`。
2. 只做最小修复，不夹带重构。
3. 合并前或紧随的同一发布周期内补齐变更规范和验证记录。
4. 在 `verification.md` 记录事故背景和后续防复发任务。

## 7. 完成定义

一个变更只有同时满足以下条件才算 `done`：

- 验收标准全部有证据。
- 行为变化已同步产品规范。
- 必需质量门禁通过。
- 风险和回滚方案已记录。
- 没有未解释的 `TODO`、占位符或断链。
- PR 评审意见已解决。
