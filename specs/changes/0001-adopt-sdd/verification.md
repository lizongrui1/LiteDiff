# 0001：验证记录

- Status: Done
- Related spec: [`spec.md`](spec.md)
- Verified at: 2026-11-06

## 1. 环境

- OS: macOS 15.8.1
- Architecture: arm64
- Rust: cargo 1.99.1 / rustc 1.99.1
- Node/npm: v26.0.0 / 11.12.1
- Commit/worktree: `main` @ `6703e18`，未提交工作树；保留既有安全/性能改动

## 2. 验收标准证据

| 验收 ID | 结果 | 证据 |
|---|---|---|
| AC-01 constitution、工作流、质量门禁和不变量 | PASS | 文件存在、互相链接，L0-L3 产物与 `SEC-01` 至 `SEC-12`、`PERF-01` 至 `PERF-09` 已定义 |
| AC-02 产品规范覆盖当前行为并映射测试 | PASS | `specs/product/litediff.md` 含 17 个章节，覆盖输入、保存、差分、视图、Git、历史、设置、安全、性能、限制和测试映射 |
| AC-03 模板和 0001 变更记录完整 | PASS | 四份模板和四份 0001 制品齐全；实际变更中无未替换模板变量 |
| AC-04 AGENTS、CONTRIBUTING、PR 模板和 Skill 连通 | PASS | 对应文件存在；Skill validator 输出 `Skill is valid!` |
| AC-05 双语 README 可找到开发规范 | PASS | 中英文 README 均链接 CONTRIBUTING、workflow、产品规范和 AGENTS |
| AC-06 一键验证脚本和前端门禁通过 | PASS | `bash scripts/verify.sh` 全流程通过；前端 330/330、check 0/0、build 成功；PowerShell 实跑另列为 NOT RUN |
| AC-07 Rust fmt、clippy、tests 通过 | PASS | fmt 无差异；clippy 无警告；138 个 Rust 测试通过 |
| AC-08 文档无断链、实际变更无占位符 | PASS | 68 个相对 Markdown 链接无断链；模板中的双花括号变量是预期占位符，实际变更文件无残留 |
| AC-09 差异只涉及文档、脚本、README、PR 模板和项目 Skill | PASS | 本次编辑路径限于 `docs/`、`specs/`、`AGENTS.md`、`CONTRIBUTING.md`、双语 README、PR 模板、验证脚本和 `.codex/skills/litediff-sdd/`；既有运行时改动保持未提交 |

## 3. 自动化检查

```text
Command: bash scripts/verify.sh
Result: PASS
Evidence: cargo fmt --check PASS; cargo clippy PASS; Rust 138 passed, 0 failed; frontend 330 passed, 0 failed; svelte-check 0 errors / 0 warnings; vite build 162 modules
Notes: 退出码 0

Command: bash -n scripts/verify.sh
Result: PASS
Evidence: 无语法错误

Command: python3 .../quick_validate.py .codex/skills/litediff-sdd
Result: PASS
Evidence: Skill is valid!

Command: Markdown relative-link check
Result: PASS
Evidence: Checked 68 relative links; no broken targets

Command: git diff --check
Result: PASS
Evidence: 无空白错误

Command: PATH="$HOME/.cargo/bin:$PATH" SKIP_DMG=1 ./scripts/package-macos.sh
Result: PASS
Evidence: release 构建成功；LiteDiff.app 组装并 ad-hoc 签名成功，大小 9.0 MB
Notes: 首次运行因当前 shell 的 PATH 缺少 Cargo 而失败；补充项目标准 Cargo 路径后通过

Command: GitHub Actions YAML parse + bash -n + secret-like scan
Result: PASS
Evidence: release.yml 解析为有效 YAML；Shell 脚本无语法错误；未发现私钥、常见令牌或本机绝对路径
```

## 4. 人工检查

| 场景 | 步骤 | 预期 | 实际 |
|---|---|---|---|
| 新人入口 | README -> CONTRIBUTING -> specs | 路径连续且命令可执行 | PASS：链接有效，命令与 package/Cargo 配置一致 |
| AI 入口 | AGENTS -> MASTER -> constitution -> product spec | 有明确读取顺序和分级规则 | PASS：顺序、L0-L3、安全边界和验证命令明确 |
| 变更入口 | specs README -> 模板 -> 0001 | 状态、等级、证据字段一致 | PASS：状态、编号、四份制品和证据字段一致 |

## 5. 安全与性能证据

- 安全不变量：本次不修改应用安全边界；最终差异审查确认没有 app 或 Rust 源码编辑。
- 性能预算：本次不修改运行时热点；产品规范数值与现有常量复核。
- 已知退化：无运行时退化。
- 发布链路：macOS release 打包通过；Windows 打包仍需在 Windows 主机执行。

## 6. 未执行项与残余风险

| 项目 | 原因 | 影响 | 后续动作 |
|---|---|---|---|
| Windows PowerShell 脚本实跑 | 当前主机没有 `pwsh` 或 Windows PowerShell | 可能存在平台执行差异 | 在 Windows 开发机或 PR CI 执行 `scripts/verify.ps1` |
| 真实窗口跨平台 E2E | 项目当前没有自动化 E2E | UI 交互仍需人工冒烟 | 作为后续独立变更 |

## 7. 结论

- 验收结论：PASS（Windows PowerShell 实跑为已记录的 NOT RUN）
- 产品规范已同步：Yes
- 可合并：Yes
