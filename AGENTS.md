# LiteDiff AI 开发指令

本文件适用于整个仓库。更具体的子目录 `AGENTS.md` 可以补充规则，但不能放宽这里的安全、数据和验证要求。

## 开始工作前

按顺序读取：

1. [`docs/progress/MASTER.md`](docs/progress/MASTER.md)，确认跨会话进度和未完成项。
2. [`docs/sdd/constitution.md`](docs/sdd/constitution.md)。
3. [`docs/sdd/workflow.md`](docs/sdd/workflow.md)。
4. [`specs/product/litediff.md`](specs/product/litediff.md)。
5. [`specs/README.md`](specs/README.md)。
6. 与任务相关的 `specs/changes/<id>/`。
7. [`docs/analysis/risk-assessment.md`](docs/analysis/risk-assessment.md) 中受影响的风险。

不要假设上一次会话已完成或工作树是干净的。开始编辑前检查 `git status --short`，并保留所有与当前任务无关的未提交改动。

## 分级与产物

先按 [`docs/sdd/workflow.md`](docs/sdd/workflow.md) 给请求定级：

- `L0`：纯文档、注释、无行为变化的格式化。无需变更目录，但最终说明为什么无行为变化。
- `L1`：单模块小修复。创建 `spec.md` 和 `verification.md`。
- `L2`：功能、跨文件重构、接口或性能变化。创建完整四份制品并更新产品规范。
- `L3`：安全边界、文件写入、Git 执行、历史格式、发布、重大算法或架构。在 L2 基础上增加 ADR、威胁/回滚分析和跨平台计划。

无法确定时按更高等级处理。用户要求“直接改”不能成为跳过 L2/L3 安全与验证的理由。

## 不可违反的边界

- 不执行 `git reset --hard`、`git checkout --` 或任何会丢弃用户改动的命令。
- 不修改与请求无关的文件，不用全仓库格式化掩盖真实差异。
- 不提交、推送、创建 PR、打标签或发布，除非用户明确要求。
- Rust 与 TypeScript IPC 必须在同一改动中同步，并强调 camelCase/serde 映射。
- 渲染进程输入视为不可信；路径、Git revision、历史 ID 和 IPC 数据必须由后端验证。
- 不允许路径、显示标签或历史恢复内容自行获得保存能力。
- 不执行仓库控制的 hook、filter、fsmonitor、pager、external diff 或签名程序。
- 不引入网络、遥测、上传、外部服务或新的默认权限，除非有明确需求和隐私/安全评审。
- 不把近似、截断、lossy 或预算耗尽结果伪装成精确结果。
- 新增或修改 UI 文案时必须同步七种 locale；新增行为必须同步产品规范。

## 实现顺序

### L1

1. 复现问题并写清根因。
2. 先补失败测试，再改最小范围代码。
3. 运行相关测试和受影响的完整门禁。
4. 在 `verification.md` 记录实际命令与结果。

### L2 / L3

1. 完成 `spec.md`：目标、非目标、验收标准、约束、未决问题。
2. 完成 `plan.md`：方案、影响面、兼容性、安全、性能、测试和回滚。
3. 拆 `tasks.md`，每项有依赖和验证方式。
4. 先写或更新测试，再实现。
5. 同步产品规范、类型、测试和 locale。
6. 执行 [`scripts/verify.sh`](scripts/verify.sh)；Windows 使用 [`scripts/verify.ps1`](scripts/verify.ps1)。
7. 在 `verification.md` 给出每条 AC 的证据；未执行项写 `NOT RUN`，不能写成通过。

## 安全与性能改动

涉及以下区域时必须引用 [`docs/sdd/security-and-performance.md`](docs/sdd/security-and-performance.md) 的 `SEC-NN` / `PERF-NN`：

- 文件选择、拖放、路径规范化、保存和权限。
- `documentId`、文档注册、摘要与原子替换。
- Git 子命令、revision、分支切换和仓库配置。
- 历史 ID、JSON 格式、清理和持久化。
- Tauri capability、CSP、插件和外部程序。
- Myers、token diff、搜索、折叠、换行和虚拟滚动。

如果无法证明不变量仍成立，停止实现并报告冲突，不要用放宽限制来“修复”测试。

## 验证与完成

完整门禁：

```bash
bash scripts/verify.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

完成回复必须包含：

- 改动目的和主要文件。
- 实际执行的测试及其结果。
- 未执行的检查、原因和影响。
- 安全、性能、兼容性或迁移风险。
- 若属于 L1-L3，给出对应 `specs/changes/<id>/verification.md` 路径。

如果任务跨多个阶段，完成每个阶段后立即更新 [`docs/progress/MASTER.md`](docs/progress/MASTER.md) 和对应 phase 文件。

## 事实来源

代码和测试用于发现事实，规范用于确认意图。发现冲突时停止并修正其中一方；不要静默把现状当作目标，也不要把计划中的能力描述成已实现。

早期 `STEP*.md` 是历史材料，不是当前需求来源。
