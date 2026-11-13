# 0003：降低运行时内存占用与响应延迟 — 任务拆分

- Status: Ready
- Risk: L2
- Created: 2026-11-13

| 任务 ID | 任务 | 依赖 | 写作用域 | 验收方式 |
|---|---|---|---|---|
| T-01 | 基准工具：`crates/litediff-core/examples/mem_bench.rs`、`scripts/bench-memory.sh`、`scripts/frontend-memory-bench.mjs`；在 `0003` 基线 commit（`0ba51fa`）的独立 worktree 上测 baseline，记录 JSON 体积 / Rust 峰值 / JS 堆。 | - | `crates/litediff-core/examples/`、`scripts/`、`specs/changes/0003-lower-runtime-memory/benchmarks.md` | baseline 数字写入 `benchmarks.md`；工具可重复运行 |
| T-02 | 重写 `crates/litediff-core/src/intern.rs`：去行文本副本、精确碰撞比较、保持全部 `ignore_*` 语义与确定性。 | - | `crates/litediff-core/src/intern.rs` | `cargo test -p litediff-core`；新增差分/碰撞/确定性测试；bench 峰值下降 |
| T-03 | 新增 `crates/litediff-app/src/wire.rs`（`WireDiff` + `wire_diff`）；`lib.rs` 的 `Session`/`SessionUpdate` 改用 `WireDiff`，`CachedSession` 改 `Arc<SourceText>`；测试同步。 | - | `crates/litediff-app/src/{wire.rs,lib.rs}` | `cargo test -p litediff-app`；wire 单元测试覆盖配对补位、UTF-16 偏移、`intra_line=false` |
| T-04 | 前端 `diffView.ts`（`DiffTable`/`decodeDiff`/访问器）与 `lines.ts`（`LineIndex`）+ 单元测试。 | T-03 契约（可先按 `plan.md` §2 实现） | `app/src/lib/{diffView.ts,lines.ts}`、`app/tests/{diffView,lines}.test.ts` | `npm test` 新增测试通过 |
| T-05 | 前端迁移 `types.ts`、`App.svelte`、`DiffPane.svelte`、`UnifiedView.svelte`、`CodeLine.svelte`、`codeRender.ts`、`search.ts`、`viewport.ts`、`Minimap.svelte`、`tabs.ts`/`history.ts` 及测试 fixture。 | T-03、T-04 | `app/src/**`、`app/tests/**` | `npm test`、`npm run check`、`npm run build`；渲染结果人工/测试等价 |
| T-06 | `App.svelte` 的 `tabs` 改为 `$state.raw`；审查全部 tab 写路径仍是整体替换。 | T-05（同文件，需串行） | `app/src/App.svelte` | `tabs.test.ts` 通过；代码审查无嵌套直写 |
| T-07 | 文档同步：`docs/sdd/security-and-performance.md`（新增 `PERF-10`）、`specs/product/litediff.md`（性能预算补充）、本变更 `verification.md`。 | T-02–T-06 | `docs/**`、`specs/**` | 相对链接检查；规范与实现一致 |
| T-08 | 全量门禁 `bash scripts/verify.sh`、bench 复测、打包 `.app` 冒烟、PR。 | T-01–T-07 | 全仓库 | 全绿 + `verification.md` 每条 AC 证据 + PR 链接 |

## 并行与写作用域说明

- T-02（core）与 T-03（app）写作用域不重叠，可与 T-04（前端基础模块）并行。
- T-05 与 T-06 都写 `App.svelte`，必须由同一写者顺序完成；T-04 的模块先落地。
- T-01 与实现并行，但 baseline 必须在实现提交前完成（独立 worktree）。
- Lead 负责 T-05/T-06/T-07/T-08 与最终集成；T-02/T-03/T-04/T-01 可委派。

## 完成定义

- `verification.md` 中 AC-01–AC-10 均有证据；未执行项标 `NOT RUN` 并给出原因。
- `bash scripts/verify.sh` 通过；benchmarks 前/后对比数据完整。
- PR 描述包含目的、验证命令与结果、未执行项、性能/安全/兼容性风险、变更目录链接。
