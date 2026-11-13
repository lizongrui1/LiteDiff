# 0003：降低运行时内存占用与响应延迟

- Status: Done
- Risk: L2
- Owner: LiteDiff maintainers
- Created: 2026-11-13
- Change directory: `specs/changes/0003-lower-runtime-memory/`

## 1. 背景与问题

LiteDiff 的差分结果目前以“每行一个 JSON 对象”的形式跨 IPC 传给渲染进程：
`DiffResult.rows` 是 `AlignedRow` 数组，每个元素包含 `left`/`right`/`kind` 和
`left_inline`/`right_inline` 两个分段数组，而每个修改行的 `InlineSegment` 还携带
整段文本的 `String` 副本。在单文档上限（16 MiB / 200,000 行）附近，这会同时造成：

1. **IPC 负载大**：200k 行的 JSON 约 10–20 MB，Rust 侧序列化缓冲与渲染进程解析
   出的对象图同时存在。
2. **渲染进程常驻对象多**：200k 个行对象 + 400k 个（通常为空的）内联数组；每个
   修改行还把整行文本复制进分段对象。Svelte `$state` 的深度代理会为被访问的
   session/rows 再建立 Proxy 元数据。
3. **行文本重复**：`splitLines` 为两侧各生成约 200k 个字符串（含内容副本），并在
   session 生命周期内常驻。
4. **后端可避免的复制**：`CachedSession` 在每次 `diff()` 时克隆 `SourceText` 的
   行索引（每侧约 2.4 MB / 200k 行）。
5. **diff 瞬时峰值**：行级 interning 用 `HashMap<String, u32>` 保存每一唯一行的
   文本副本，大文件、低重复度输入会产生数十 MB 瞬时峰值。

这些都不是产品功能，但直接决定“打开大文件时占多少内存、卡多久”。

## 2. 目标

在**不改变任何用户可观察行为、不降低安全边界、不改变持久化格式**的前提下：

- 渲染进程中单次比较的 diff 数据常驻 JS 堆降低 ≥ 60%（以 `benchmarks.md` 的方法度量）。
- 同一 diff 的 IPC JSON 体积降低 ≥ 70%。
- 16 MiB / 200k 行 diff 的后端峰值内存（`maxrss`）降低 ≥ 25%。
- 常用路径响应不退化：diff、选项切换、滚动、搜索的复杂度不增加，时间证据记录在
  `verification.md`。
- 所有既有质量门禁保持通过，测试数量不少于基线。

## 3. 非目标

- 不改变 diff 语义：Myers 匹配、工作预算、`approximate` 退化、token 化规则、
  `ignore_*` 选项语义全部不变。
- 不改变持久化数据：历史 JSON、设置、sidecar 格式不变；无迁移。
- 不改变安全边界：路径授权、`documentId`、摘要、原子写、Git 参数与上限不变。
- 不改变 UI/渲染结果：行内容、着色、折叠、换行、搜索高亮、minimap 的可见结果不变。
- 不承诺降低 WebView/Chromium 自身基线内存（不可控）；只降低应用数据与 IPC 部分。
- 不在本轮重构 display list（`DisplayItem` 每行对象）；记录为后续机会。
- 不引入依赖、网络、遥测或新权限。

## 4. 需求与验收标准

| 需求 ID | 需求 | 验收 ID | 验收标准 |
|---|---|---|---|
| REQ-MEM-01 | diff 结果不再逐行传输对象：行网格由 `hunks` 推导，修改行只传 changed 区间的 UTF-16 偏移，不再传分段文本。 | AC-01 | Rust `wire` 测试：对多组输入，由 `WireDiff` 推导的行网格与 `DiffResult.rows` 逐行相等（left/right/kind）；前端 `diffView.test.ts` 覆盖同一规则（含配对补位）。 |
| REQ-MEM-02 | 后端 session payload 不再包含 `rows`/内联分段；两端契约同一提交更新。 | AC-02 | `benchmarks.md` 显示同一 diff 的 JSON 体积下降 ≥ 70%；`cargo test -p litediff-app` 覆盖新 payload。 |
| REQ-MEM-03 | 渲染进程用类型化数组保存行网格（`Int32Array`/`Uint8Array`），不保留每行对象、空内联数组或分段文本副本。 | AC-03 | Node bench：200k 行 diff 的常驻堆（解析 + decode 后）比旧格式下降 ≥ 60%。 |
| REQ-MEM-04 | 行文本按需切片：不再为两侧预生成整文件字符串数组。 | AC-04 | `LineIndex` 测试覆盖空文档、尾换行、CRLF、孤立 `\r`、越界；实现只保留每行起始偏移（`Int32Array`），不复制文本。 |
| REQ-MEM-05 | 标签页 session 不做深度响应式代理；所有写路径保持整体替换。 | AC-05 | `tabs` 为 `$state.raw`；`tabs.test.ts` 与前端测试通过；代码审查无 `tab.session.* =` 直接修改。 |
| REQ-MEM-06 | 后端 diff 快照共享 `SourceText`（`Arc`），不复制行索引。 | AC-06 | app 既有测试通过；代码审查确认 `CachedSession` 持有 `Arc<SourceText>`，`diff()` 只克隆 `Arc`。 |
| REQ-MEM-07 | 行级 interning 不再为每一唯一行保存 `String` 副本，且保持精确相等、确定性与全部 `ignore_*` 语义。 | AC-07 | intern 既有测试全部通过；新增精确碰撞/重复行/确定性测试；bench 显示大输入峰值内存下降。 |
| REQ-MEM-08 | minimap 不再从行对象 `map` 出 200k 个 kind 字符串。 | AC-08 | minimap 接收类型化 kinds；`minimap.test.ts` 通过。 |
| REQ-MEM-09 | 行为不变。 | AC-09 | `bash scripts/verify.sh` 全绿；Rust 测试数与前端测试数 ≥ 基线；`svelte-check` 0 error / 0 warning。 |
| REQ-MEM-10 | 大文件端到端可用。 | AC-10 | 打包 app 打开 16 MiB / 200k 行文件，diff、滚动、折叠、换行、搜索、minimap、选项切换正常；无法执行时在 `verification.md` 标记 `NOT RUN` 并说明原因与替代证据。 |

## 5. 约束与不变量

- **安全**：本变更不新增 renderer→后端输入、路径、Git 参数或持久化写入；不涉及
  `SEC-01`–`SEC-12`。IPC 仅改变后端→renderer 的输出形状，仍只含用户已打开的内容。
- **性能**：保持 `PERF-01`（Myers O(N+M)）、`PERF-02`（工作预算）、`PERF-03`
  （token/搜索上限）、`PERF-04`（文档上限）、`PERF-05`（只渲染视口）、
  `PERF-06`（SessionUpdate 不重传正文）。新增预算见 `plan.md` 与
  `docs/sdd/security-and-performance.md` 的 `PERF-10`。
- **确定性**：interning 与行网格推导必须对相同输入产生相同输出；`approximate`
  必须原样传递，不能被新格式掩盖。
- **兼容性**：IPC 是内部契约，Rust 与 TypeScript 在同一提交同步；磁盘格式不变，
  旧历史、旧设置、旧标签页数据不变。
- **平台**：纯内存/序列化变化，无平台差异；`Int32Array`/`Uint8Array`/JSON 数字在
  macOS WKWebView 与 Windows WebView2 的 JS 引擎上均按 IEEE-754/整数语义工作。

## 6. Open Questions

| ID | 问题 | 结论 |
|---|---|---|
| Q-01 | 是否需要为 IPC 保留一段旧 `rows` 兼容期？ | 不需要：仓库内唯一消费者是 `app/src`，Rust 与 TS 同步为一个提交。 |
| Q-02 | 是否顺手把 `DisplayItem` 改成结构数组？ | 本轮不做：收益小于跨组件改动风险，记录为后续机会。 |
| Q-03 | changed 区间用 char 还是 UTF-16 offset？ | UTF-16 code unit：渲染进程用 JS `String#slice` 直接切片，含非 BMP 字符时也一致。 |
