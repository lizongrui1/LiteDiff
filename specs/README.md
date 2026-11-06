# LiteDiff 规范目录

本目录保存 LiteDiff 的产品基线和逐次变更规范。规范不是实现完成后的说明书，而是实现前用于消除歧义、实现中用于约束范围、合并前用于证明完成的工程契约。

## 1. 事实来源与优先级

发生冲突时按以下顺序处理：

1. [`docs/sdd/constitution.md`](../docs/sdd/constitution.md) 中的项目准则。
2. [`docs/sdd/security-and-performance.md`](../docs/sdd/security-and-performance.md) 中的安全与性能不变量。
3. 本目录中状态为 `Accepted` 的产品规范。
4. 当前变更目录中已评审的 `spec.md` 与 `plan.md`。
5. 代码、测试和用户界面。

如果代码或测试与已接受规范冲突，不得静默选择其中一方。应在当前变更中修正代码，或通过显式评审更新规范并记录兼容性影响。

`draft` 或 `implementing` 状态的变更规范描述的是“计划中的行为”，不能当作已经发布的产品事实。

## 2. 目录结构

```text
specs/
|-- README.md
|-- product/
|   `-- litediff.md              # 长期产品基线
|-- _template/                   # 新变更模板
|   |-- spec.md
|   |-- plan.md
|   |-- tasks.md
|   `-- verification.md
`-- changes/
    `-- NNNN-short-slug/         # 一次变更的全部制品
```

## 3. 产品规范与变更规范

### 产品规范

[`product/litediff.md`](product/litediff.md) 只描述当前已经接受的产品行为、限制、安全边界和性能预算。它必须始终与已交付代码和测试一致。

以下变化必须在同一个变更中更新产品规范：

- 用户可观察的行为或默认值。
- 输入范围、结果上限或退化策略。
- 文件、Git、历史记录或设置的数据格式。
- 安全边界、隐私承诺或平台支持。
- 已记录限制的移除或新增。

### 变更规范

`changes/NNNN-short-slug/` 描述一次有边界的改动。编号使用四位十进制数字并单调递增；slug 使用小写英文和连字符，例如 `0012-stream-large-diffs`。

一次变更至少包含：

| 文件 | 用途 | 必需等级 |
|---|---|---|
| `spec.md` | 问题、目标、非目标、验收标准和约束 | L1-L3 |
| `plan.md` | 技术方案、影响面、风险、兼容与回滚 | L2-L3 |
| `tasks.md` | 有依赖关系的可验证任务 | L2-L3 |
| `verification.md` | 实际执行过的验证、证据和残余风险 | L1-L3 |

L0 改动不建立变更目录，但 PR 必须说明为什么没有行为变化以及检查了哪些内容。分级规则见 [`docs/sdd/workflow.md`](../docs/sdd/workflow.md)。

## 4. 状态

规范文件头部的 `Status` 使用以下值：

| 状态 | 含义 |
|---|---|
| `Draft` | 正在澄清需求，尚不能作为实现依据 |
| `Ready` | 已评审，可以开始实现 |
| `Implementing` | 正在实现，允许按计划调整 |
| `Verifying` | 实现完成，正在补齐验证证据 |
| `Accepted` | 产品规范已生效 |
| `Done` | 变更已验收，产品规范和验证记录已同步 |
| `Blocked` | 被明确的外部条件阻塞 |
| `Abandoned` | 决定不做，保留原因供以后参考 |

## 5. 创建变更

1. 查看 `specs/changes/` 中最大的编号，并加一。
2. 创建 `specs/changes/NNNN-short-slug/`。
3. 从 `_template/` 复制当前等级需要的文件。
4. 把 `{{ID}}`、`{{TITLE}}`、`{{DATE}}` 替换为真实值。
5. 在 `spec.md` 声明 `L0`、`L1`、`L2` 或 `L3`，无法判断时取更高等级。
6. 先完成 `Draft`，经确认后改为 `Ready`；不要在验收标准仍含糊时直接编码。

## 6. 编号规则

- 需求使用 `REQ-<DOMAIN>-NN`，例如 `REQ-DIFF-03`。
- 验收标准使用 `AC-NN`，每条都必须可观察或可自动验证。
- 任务使用 `T-NN`，并在 `tasks.md` 中声明依赖。
- 风险和未决问题分别使用 `RISK-NN`、`Q-NN`。
- 已发布需求 ID 不复用；删除需求时标记 `Retired` 并说明替代项。

## 7. 完成定义

一个变更只有满足以下条件才能标记为 `Done`：

- `spec.md` 中的每条验收标准都在 `verification.md` 有证据。
- 产品行为变化已同步到 `product/litediff.md`。
- 必要的自动化、人工、安全和性能验证已执行。
- 未执行的检查明确标记为 `NOT RUN`，并给出原因和后续动作。
- 没有未解释的占位符、断链或与当前代码冲突的描述。
- PR 已关联对应变更目录；L0 已在 PR 中说明豁免原因。

## 8. 模板

- [`_template/spec.md`](_template/spec.md)
- [`_template/plan.md`](_template/plan.md)
- [`_template/tasks.md`](_template/tasks.md)
- [`_template/verification.md`](_template/verification.md)

本次建立 SDD 体系自身的记录见 [`changes/0001-adopt-sdd/spec.md`](changes/0001-adopt-sdd/spec.md)。
