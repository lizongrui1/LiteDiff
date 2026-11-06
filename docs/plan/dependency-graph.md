# 依赖图

```mermaid
flowchart TD
    subgraph Phase1[Phase 1 基线]
        P11[P1.1 确认范围]
        P12[P1.2 架构盘点]
        P13[P1.3 风险评估]
        P11 --> P12 --> P13
    end

    subgraph Phase2[Phase 2 SDD 核心]
        P21[P2.1 Constitution]
        P22[P2.2 工作流]
        P23[P2.3 质量门禁]
        P24[P2.4 安全与性能不变量]
        P25[P2.5 ADR]
        P21 --> P22
        P22 --> P25
        P13 --> P24
    end

    subgraph Phase3[Phase 3 规范体系]
        P31[P3.1 specs 模板]
        P32[P3.2 产品基线规范]
        P33[P3.3 本次变更记录]
        P22 --> P31
        P13 --> P32
        P24 --> P32
        P31 --> P33
        P32 --> P33
    end

    subgraph Phase4[Phase 4 贡献者与 AI]
        P41[P4.1 AGENTS.md]
        P42[P4.2 CONTRIBUTING.md]
        P43[P4.3 PR 模板]
        P44[P4.4 项目 Skill]
        P45[P4.5 README 入口]
        P22 --> P41
        P31 --> P42
        P31 --> P43
        P41 --> P44
        P32 --> P44
        P41 --> P45
        P42 --> P45
    end

    subgraph Phase5[Phase 5 验证]
        P51[P5.1 前端门禁]
        P52[P5.2 Rust 门禁]
        P53[P5.3 验证脚本]
        P54[P5.4 文档与 Skill 校验]
        P55[P5.5 最终审查]
        P23 --> P51
        P23 --> P52
        P23 --> P53
        P44 --> P54
        P51 --> P55
        P52 --> P55
        P53 --> P55
        P54 --> P55
    end

    Phase1 --> Phase2 --> Phase3 --> Phase4 --> Phase5
```

## 关键路径

`确认范围 -> 架构盘点 -> 风险评估 -> 安全/性能不变量 -> 产品规范 -> 项目 Skill -> 全量验证`

## 可并行工作

- `docs/analysis/`、`docs/sdd/` 和 `specs/` 可以按不同写文件范围并行。
- 质量门禁脚本必须在 `docs/sdd/quality-gates.md` 定稿前完成并实际运行。
- README 和 PR 模板可以并行编写，但都依赖最终文档路径。
