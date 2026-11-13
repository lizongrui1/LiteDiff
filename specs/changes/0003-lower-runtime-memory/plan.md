# 0003：降低运行时内存占用与响应延迟 — 技术方案

- Status: Done
- Risk: L2
- Created: 2026-11-13

## 1. 方案总览

五个相互独立、可分别回滚的内存优化，共享同一个 IPC 契约：

1. **紧凑 diff 负载（Rust + TS）**：后端不再逐行发送 `AlignedRow`，只发送
   `hunks` + changed 区间；前端由 `hunks` 推导类型化行网格。
2. **行索引（TS）**：`splitLines` 的 `string[]` 改为 `LineIndex`（每行起始偏移的
   `Int32Array`），按需 `slice`。
3. **响应式边界（TS）**：`tabs` 改为 `$state.raw`，diff 数据不再被深度代理。
4. **后端快照共享（Rust）**：`CachedSession` 持有 `Arc<SourceText>`。
5. **interning 去掉行文本副本（Rust core）**：开放寻址哈希 + 代表行精确比较。

## 2. IPC 契约（v2）

`Session.result` / `SessionUpdate.result` 从 `DiffResult` 改为 `WireDiff`：

```jsonc
{
  "left_line_count": 200000,
  "right_line_count": 199999,
  "hunks": [ { "equal": true, "left_start": 0, "left_len": 10,
               "right_start": 0, "right_len": 10,
               "row_start": 0, "row_len": 10 }, ... ],
  "stats": { "added": 0, "deleted": 0, "modified": 3, "unchanged": 99999 },
  "approximate": false,
  "left_changed":  [row, start, end, ...],   // UTF-16 code unit offsets, 升序
  "right_changed": [row, start, end, ...]
}
```

- 字段名保持 snake_case，与既有 `Hunk`/`DiffStats` 的 TypeScript 类型一致。
- **行网格可由 hunks 唯一推导**：equal hunk 每行 `(left_start+i, right_start+i,
  Equal)`；change hunk 先 `paired = min(left_len, right_len)` 个 `Modify`，再
  `Delete` 补位，再 `Insert` 补位——与 `align::pair_block` 完全一致。因此
  `rows` 不入线。
- `left_changed`/`right_changed` 只包含 `kind == Modify` 行中 `changed == true` 的
  分段；每 3 个 u32 一组 `(row, start, end)`，按 `row`、`start` 升序。
- `intra_line` 关闭时数组为空（渲染层按原有规则回退到语法 token）。
- 推导规则在前端 `diffView.ts` 与 Rust `wire.rs` 中各有一份，双方测试用同一组
  fixture 断言“推导行网格 == 原 `DiffResult.rows`”。

## 3. Rust 侧

### 3.1 `crates/litediff-app/src/wire.rs`（新增）

- `pub struct WireDiff`，`Serialize`；由 `pub fn wire_diff(result: DiffResult) -> WireDiff`
  转换（消费 `DiffResult`，逐行提取 changed 区间后丢弃 `rows`）。
- `WireDiff::row_count()`（最后一个 hunk 的 `row_start + row_len`）与
  `WireDiff::is_identical()` 供 app 测试与内部判断；`stats`/`approximate` 原样保留。
- 单元测试：空 diff、纯删除、纯插入、Modify 配对 + 补位、changed 区间在非 BMP
  字符后的 UTF-16 偏移、`intra_line=false` 空数组。

### 3.2 `crates/litediff-app/src/lib.rs`

- `CachedSession.left_source/right_source: Arc<SourceText>`；`diff()` 快照只克隆
  `Arc`（`Side` 的 `Arc<str>` 本来已是共享）。
- `Session.result`/`SessionUpdate.result` 改为 `WireDiff`；`diff()` 末尾调用
  `wire_diff(result)`。
- 既有测试的 `result.rows.len()` 改为 `result.row_count()`；`result.is_identical()`
  改用 `WireDiff` 方法。

### 3.3 `crates/litediff-core/src/intern.rs`

- 去掉 `HashMap<String, u32>`。改为：
  - 行哈希（精确、确定性、固定种子，覆盖 `ignore_whitespace`/`ignore_all_whitespace`/
    `ignore_case` 的归一化语义；归一化比较不分配）。
  - `HashMap<u64, u32>`（哈希 → 首个 id）+ 每个 id 的代表行 `(side, line)` 与
    同哈希链 next；命中时用代表行与当前行做**精确归一化相等比较**，碰撞时沿链
    继续，全部不相等才分配新 id。
  - 返回的 `ids` 仍是每行一个 `u32`；`distinct` 不变。
- 复杂度不变（期望 O(N+M)），峰值内存从“每唯一行一份 String”降为“每唯一行
  8–12 字节 + 哈希表桶”。
- 测试：全部既有语义测试；新增重复行、碰撞链正确性（注入测试用哈希钩子或构造
  同哈希输入的测试入口）、两种运行结果一致、`ids` 与旧实现逐一相等（用参考
  `HashMap<String,u32>` 实现做差分测试）。

## 4. TypeScript 侧

### 4.1 `app/src/lib/diffView.ts`（新增）

- `DiffTable`：`{ length, hunks, stats, approximate, left: Int32Array,
  right: Int32Array, kind: Uint8Array, changedLeft: Int32Array,
  changedRight: Int32Array }`（`-1` 表示补位侧）。
- `decodeDiff(wire): DiffTable`：按 §2 规则推导行网格，一次 O(rows) 循环。
- 访问器：`leftAt`/`rightAt`/`kindAt`/`changedRangesAt(table, side, row)`（二分
  查找 triples）。`KIND_EQUAL/MODIFY/DELETE/INSERT` 常量。
- 单元测试：hunk 推导与 `align::pair_block` 一致；补位；changed 区间查找；空 diff。

### 4.2 `app/src/lib/lines.ts`（新增）

- `LineIndex`：`{ length, text(i) }`；由一次扫描构建 `Int32Array` 行起始偏移；
  `text(i)` 现算行尾（排除 `\r\n` 的 `\r`），不复制整文件。
- 语义与既有 `splitLines` 完全一致，测试覆盖空文档、尾换行、CRLF、孤立 `\r`。
- `splitLines` 保留给测试/兼容，内部不再用于 session 行缓存。

### 4.3 消费方改动

- `App.svelte`：`diff = decodeDiff(session.result)`；`rows` 语义替换为 `DiffTable`；
  `leftLines`/`rightLines` 改为 `LineIndex`；`rowKinds` 直接传 `diff.kind`。
- `DiffPane.svelte` / `UnifiedView.svelte`：用访问器取 left/right/kind/changed；
  wrapped 切片改为对 changed 区间取交集并平移到切片坐标。
- `CodeLine.svelte` + `codeRender.ts`：`segments: InlineSegment[]` → 
  `changed: ReadonlyArray<{start,end}>`；有 changed 时用 changed 区间着色并忽略
  语法 token（保持现有“修改行让位于字符级 diff”行为），否则用 token。
- `search.ts`：`findSearchHits(table, leftIndex, rightIndex, ...)`。
- `viewport.ts`：`buildUnifiedDisplay`/`unifiedIndexForRow` 接受 `kindAt` 访问器。
- `Minimap.svelte`：`rowKinds: Uint8Array`。
- `tabs.ts`/`history.ts` 类型跟随；测试 fixture 更新。
- `App.svelte`：`let tabs = $state.raw<Tab[]>(...)`；既有写路径已经全部是整体
  替换（`tabs = ...`），只需审查确认，不改行为。

## 5. 兼容性与回滚

- IPC 为内部契约，Rust/TS 同提交更新；无外部消费者、无磁盘格式变化、无迁移。
- 每个优化点都独立：若前端新契约出现回归，可仅在 `wire.rs`/`diffView.ts` 中
  回退到“后端也发 rows”的旧形状，其余四项（行索引、raw state、Arc、intern）可
  单独保留。
- 回滚方式：`git revert` 单个 squash 提交即可恢复旧行为和旧 payload。

## 6. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| RISK-01 | 前端行网格推导与 `align::pair_block` 不一致，导致错行/串行 | Rust 与前端各有一组同一 fixture 的测试；`row_count`/`row_start` 断言 hunk 连续覆盖。 |
| RISK-02 | changed 区间 UTF-16 偏移与换行切片坐标错误，造成高亮错位 | 非 BMP + 换行切片测试；`changedRangesAt` 做区间交集并夹取。 |
| RISK-03 | interning 哈希碰撞导致错误判等 | 代表行精确比较 + 碰撞链测试；差分测试对照参考实现。 |
| RISK-04 | `$state.raw` 后某处依赖深度响应式导致 UI 不更新 | 全部 tab 写路径已是整体替换；`tabs.test.ts` + 手动切换/编辑/选项切换；若发现遗漏，改为显式版本号/整体替换。 |
| RISK-05 | 大文件下推导/切片带来的 CPU 回退 | bench 记录 diff、decode、搜索耗时；`decodeDiff` 一次 O(rows) 纯循环。 |

## 7. 验证策略

- Rust：`cargo fmt`、`cargo clippy -D warnings`、`cargo test --workspace`；
  新增 wire/intern 测试；`crates/litediff-core/examples/mem_bench.rs` 测峰值。
- 前端：`npm test`（新增 diffView/lines 测试）、`npm run check`、`npm run build`。
- 内存/性能基准：`scripts/bench-memory.sh`（Rust `maxrss` + JSON 体积）与
  `scripts/frontend-memory-bench.mjs`（Node `--expose-gc` 堆），结果写入
  `benchmarks.md`，前/后对比。
- 端到端：打包 `dist-macos/LiteDiff.app`，手动打开大文件（AC-10），无法执行则
  `NOT RUN` + 说明。

## 8. 依赖与顺序

1. T-01 基准工具与 baseline（可在实现前、独立 worktree 上完成）。
2. T-02 Rust core interning（与前端无耦合）。
3. T-03 Rust app wire + Arc 快照（定义 IPC v2）。
4. T-04 前端 diffView/lines 基础模块与测试。
5. T-05 前端组件迁移（依赖 T-03 契约与 T-04）。
6. T-06 raw state（独立）。
7. T-07 文档/规范同步。
8. T-08 全量门禁、benchmark 复测、打包。
