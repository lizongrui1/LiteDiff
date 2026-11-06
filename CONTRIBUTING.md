# 参与 LiteDiff 开发

LiteDiff 使用轻量、仓库原生的 Spec-Driven Development（SDD）。目标不是增加文档负担，而是让每次改动在开始前说明意图，在合并前留下可复查的证据。

## 1. 开始前阅读

1. [`AGENTS.md`](AGENTS.md)：仓库级工作边界，人类开发者和 AI 代理都应遵守。
2. [`docs/sdd/constitution.md`](docs/sdd/constitution.md)：不可破坏的项目原则。
3. [`docs/sdd/workflow.md`](docs/sdd/workflow.md)：L0-L3 分级和状态流转。
4. [`specs/product/litediff.md`](specs/product/litediff.md)：当前产品行为基线。
5. [`docs/analysis/project-overview.md`](docs/analysis/project-overview.md)：架构和模块入口。

## 2. 环境准备

要求：

- Rust 1.75+
- Node.js 18+ 与 npm
- macOS 11+ 或 Windows 10/11 x64
- Windows 打包需要 NSIS/WebView2 相关工具链

安装前端依赖：

```bash
cd app
npm ci
cd ..
```

如果 Cargo 不在 `PATH`，常见位置是：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

开发模式使用两个终端：

```bash
# 终端 1
cd app
npm run dev

# 终端 2，从仓库根目录
cargo run -p litediff-app
```

## 3. 改动分级

| 等级 | 示例 | 需要的记录 |
|---|---|---|
| L0 | 文案、注释、纯文档、无行为变化的格式化 | PR 说明无行为变化 |
| L1 | 单模块 bugfix、局部测试 | `spec.md`、`verification.md` |
| L2 | 新功能、跨文件重构、IPC/性能变化 | 完整四份变更制品 + 产品规范 |
| L3 | 安全、文件保存、Git、历史格式、发布、重大算法 | L2 + ADR + 威胁/回滚/跨平台计划 |

无法判断时按更高等级处理。详细规则见 [`docs/sdd/workflow.md`](docs/sdd/workflow.md)。

## 4. 建立变更

1. 找出 `specs/changes/` 当前最大编号并加一。
2. 创建 `specs/changes/NNNN-short-slug/`。
3. 从 [`specs/_template/`](specs/_template/) 复制所需文件。
4. 写清问题、目标、非目标、验收标准、安全和性能影响。
5. 将状态从 `Draft` 推进到 `Ready` 后再编码。
6. 实现时保持任务状态和验证记录更新。

一个变更应该可以独立解释、验证和回滚。重构与行为变化尽量分开。

## 5. 编码约定

- 先阅读相关模块的现有设计，不引入与项目约束冲突的新抽象。
- 行为修复优先添加失败测试。
- Rust 代码遵守 `cargo fmt` 与 `cargo clippy -D warnings`。
- TypeScript 必须通过 `svelte-check`，公共纯逻辑优先放到可测试的 `app/src/lib/` 模块。
- IPC 两侧同时修改：Rust serde 结构、`app/src/lib/types.ts` 和 `app/src/lib/ipc.ts`。
- 新增 UI 文案同步 [`app/src/lib/locales/`](app/src/lib/locales/) 的七种语言。
- 文件、Git、历史和安全边界改动必须引用 `SEC-NN`，性能敏感改动必须引用 `PERF-NN`。
- 不提交 `dist/`、`.tmp-test/`、`target/`、安装包、密钥或用户数据。

## 6. 验证

完整门禁：

```bash
bash scripts/verify.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

脚本依次执行：

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets -- -D warnings`
3. `cargo test --workspace`
4. `npm test`
5. `npm run check`
6. `npm run build`

如果某平台或工具不可用，在 PR 和 `verification.md` 标记 `NOT RUN`，说明原因和合并前后续动作。不得把未执行写成通过。

## 7. 分支、提交与 PR

- 分支建议使用 `codex/<short-description>`、`feat/<short-description>` 或 `fix/<short-description>`。
- 提交保持单一意图，不混入无关格式化或重构。
- PR 使用仓库模板，链接变更目录和对应验收证据。
- L0 必须解释为什么无行为变化。
- L2/L3 必须说明兼容性、安全、性能、回滚和跨平台影响。
- 不强制推送或改写他人分支；不要提交他人的未完成改动。

## 8. 评审重点

评审首先检查：

1. 行为是否符合 [`specs/product/litediff.md`](specs/product/litediff.md)。
2. 验收标准是否有真实证据。
3. 是否破坏安全、数据完整性或隐私边界。
4. 是否引入无界工作、无界缓存或复杂度退化。
5. IPC、持久化格式和七语言是否同步。
6. 是否混入无关改动或缺少回滚路径。

发现规范与代码冲突时，停止合并并明确决定修改哪一方；不要让两者继续漂移。
