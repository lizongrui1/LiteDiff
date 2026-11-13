# 0003：验证记录

- Status: Done
- Related spec: [`spec.md`](spec.md)
- Verified at: 2026-11-13
- 分支：`feat/lower-runtime-memory`（基线 `main` = `0ba51fa`）
- 基准数据：[`benchmarks.md`](benchmarks.md)

## 1. 环境

- OS: macOS 15.8.1 (24H32)，Apple M3，16 GiB
- Architecture: arm64
- Rust: cargo 1.99.1（`$HOME/.cargo/bin`）
- Node/npm: Node v26.0.0 / npm 11.12.1
- Commit/worktree: `feat/lower-runtime-memory`，HEAD 仍为 `0ba51fa` + 本次未提交改动（提交后本记录以提交内容为准）
- 限制：无网络；本机 `LANG=zh_CN.UTF-8`，前端 `i18n.test.ts` 有一个既有的
  `navigator.languages` 环境依赖用例（见第 6 节），故前端门禁用 `LANG=en_US.UTF-8` 运行。
  `CARGO_HOME="$PWD/target/cargo-home"` 用于遵守本会话的文件沙箱。

## 2. 验收标准证据

| 验收 ID | 结果 | 证据 |
|---|---|---|
| AC-01 | PASS | `crates/litediff-app/src/wire.rs` 12 个单元测试：由 `hunks` 推导的行网格对 14 组 fixture 与原 `DiffResult.rows` 逐行相等（equal 行进位、Modify 配对、两侧补位、row_start 连续、Σrow_len == row_count）；前端 `app/tests/diffView.test.ts` 8 个测试锁定同一配对规则。另做了一次跨端手工核对：取 rust-app 实测的 Session JSON 样本（`"a\nb\n"` vs `"a\nc\n"`，`left_changed:[1,0,1]`），用 esbuild 打包的 `diffView.ts` 解码得到 rows `[0,1]/[0,1]`、span `0..1`，与预期一致。`benchmarks.md` §4.3/§6.1：legacy 与 compact payload 同 `serde_json` 序列化**逐字节相同**，且 after 与 baseline 的 payload 逐字节相同（diff 语义未变）。 |
| AC-02 | PASS | `benchmarks.md` §6.3：同一 diff 的 IPC JSON 16,721,094 B → 256,717 B，**-98.5%**（目标 ≥70%）。`lib.rs` 测试 `session_json_keeps_its_shape_but_carries_a_compact_result` 断言 `result` 不再含 `rows`、且 7 个 WireDiff 字段齐全；`wire.rs` 测试锁定 JSON 字段名与三元组布局。 |
| AC-03 | PASS | `benchmarks.md` §6.3：Node `--expose-gc`（`heapUsed + arrayBuffers`，compact 用最终版 `decodeDiff` 后丢弃 wire 对象）200,001 行保留堆 26.74 MiB → 1.93 MiB，**-92.8%**（目标 ≥60%）；其中 compact 的 1.74 MiB 是 `Int32Array`/`Uint8Array` 底层存储（9 B/行）。 |
| AC-04 | PASS | `app/tests/lines.test.ts` 8 个测试覆盖空文档、单行、尾换行、CRLF、孤立 `\r`、空行、Unicode/emoji、500 行生成文本，逐行与 `splitLines` 对照；越界/负索引返回空串。实现只保留每个行起始偏移的 `Int32Array`（200k 行约 0.8 MB），按需 `slice`，并带**单行**切片缓存避免超长单行重复分配。 |
| AC-05 | PASS | `App.svelte`：`tabs = $state.raw<Tab[]>(...)`、`expanded = $state.raw<Set<number>>(...)`。代码审查全部写路径都是整体替换：`commit`、`commitUpdate`、`openNewTab`、`stashActiveView`、`closeTab`、`moveTabTo`、`renameTab`（`tabs = ...`），以及 `restoreView`/`expandFold`/`collapseFold`/全部展开/折叠（`expanded = new Set(...)`）；无 `tab.session.* =` 或 `expanded.add/delete`。`tabs.test.ts` 39 个测试通过。 |
| AC-06 | PASS | `CachedSession.left_source/right_source: Arc<SourceText>`，`diff()` 快照只克隆 `Arc`；新增测试 `cached_sources_share_the_side_text_allocation` 用 `Arc::ptr_eq` 断言快照与缓存共享同一 `SourceText`。`cargo test --workspace` 全绿。 |
| AC-07 | PASS | `intern.rs` 重写后 19 个单元测试（+12）：与旧 `HashMap<String,u32>` 参考实现的差分测试（40 组确定性文档 × 6 种选项组合，含旧 `ignore_all_whitespace` 不叠加 `ignore_case` 的怪癖）、强制碰撞链（注入常量/截断哈希）、跨侧重复行、空行/CRLF/BOM/emoji/64 KiB 长行、连续两次运行一致、hash 与归一化相等一致、希腊 final-sigma 上下文规则。`approximate`/`stats`/ids 顺序/`distinct` 全部不变（engine 集成测试通过）。 |
| AC-08 | PASS | `Minimap.svelte` 的 `rowKinds` 改为 `Uint8Array`（`diff.kind`），删除 `rows.map(r => r.kind)`；`minimap.test.ts` 7 个测试通过，`npm run check` 0 error。 |
| AC-09 | PASS | `bash scripts/verify.sh` 全绿：fmt、clippy、Rust 167 tests、前端 373 tests、svelte-check 0/0、production build 成功（见第 3 节）。 |
| AC-10 | PARTIAL | 打包 `dist-macos/LiteDiff.app`（9.0 MB，ad-hoc 签名）可启动：进程存活、无崩溃（见第 4 节）。**未执行**真实窗口打开 16 MiB/200k 行文件后的滚动/折叠/换行/搜索/minimap/选项切换人工检查（无 GUI 自动化能力，且本机交互式窗口操作不可脚本化），替代证据为 200k 行 payload/decode 基准与全部自动化测试。 |

## 3. 自动化检查

```text
Command: cargo fmt --all -- --check
Result: PASS
Evidence: 无格式差异（含 bench example 与新增 Rust 文件）
Notes: CARGO_HOME=target/cargo-home
```

```text
Command: cargo clippy --workspace --all-targets -- -D warnings
Result: PASS
Evidence: litediff-core + litediff-app 全部 target 通过，无 warning
Notes: 同上
```

```text
Command: cargo test --workspace
Result: PASS
Evidence: 88 (litediff-app) + 60 (core lib) + 18 (core integration engine) + 1 (doctest)
          = 167 passed / 0 failed；基线 138（74 app + 45 core + 18 engine + 1 doctest），+29
Notes: 新增 wire 12 + intern 12 + row 容量 2 + app 2 + op_count 2 等
```

```text
Command: cd app && npm test
Result: PASS
Evidence: 373 / 373 passed，0 failed（基线 0ba51fa 为 356；新增 diffView 8 + lines 8 + syntax 1 = 17）
Notes: 需 LANG=en_US.UTF-8；否则既有的 i18n 环境依赖用例失败（见第 6 节）
```

```text
Command: cd app && npm run check
Result: PASS
Evidence: svelte-check found 0 errors and 0 warnings
Notes: -
```

```text
Command: cd app && npm run build
Result: PASS
Evidence: 244.74 kB JS（gzip 80.64 kB）、46.54 kB CSS；基线为 253.35 kB JS（-8.6 kB）
Notes: 生产构建成功，无新增依赖
```

```text
Command: LANG=en_US.UTF-8 CARGO_HOME="$PWD/target/cargo-home" bash scripts/verify.sh
Result: PASS
Evidence: "All LiteDiff quality gates passed."
Notes: 7 个门禁步骤全部通过
```

```text
Command: bash scripts/bench-memory.sh /Users/tal/Project/LiteDiff --lines 200000 --out target/bench-out --reps 6
         && node --expose-gc scripts/frontend-memory-bench.mjs --dir target/bench-out
Result: PASS（指标，详见 benchmarks.md §6）
Evidence: JSON 16,721,094 B → 256,717 B (-98.5%)；渲染堆 26.74 → 1.93 MiB (-92.8%)；
          后端 maxrss 交错 n=6：112.0 → 67.2 MiB (-40.0%)；approximate=false、rows=200001、hunks=2000 不变
Notes: 主机有并行负载，maxrss 用同会话交错 n=6 中位数；diff_ms 噪声 ±60%，见第 6 节
```

## 4. 人工检查

| 场景 | 步骤 | 预期 | 实际 |
|---|---|---|---|
| 打包应用启动 | `open dist-macos/LiteDiff.app`，等待 6 s，`pgrep -fl LiteDiff` | 进程存活、无立即崩溃 | 进程 `/…/LiteDiff.app/Contents/MacOS/LiteDiff` 存活；`kill` 正常退出 |
| 大文件真实窗口 E2E | 打开 200k 行文件，滚动/折叠/换行/搜索/minimap/选项切换 | 全部正常、无卡死 | **NOT RUN**（无 GUI 自动化；见第 6 节） |
| 空闲内存前后对比 | 启动后读取进程 RSS | 记录 | **NOT RUN**（WebView 基线占主导，非本变更承诺；bench 为应用数据口径） |

## 5. 安全与性能证据

- **安全不变量（`SEC-01`–`SEC-12`）**：本变更不新增 renderer→后端输入、路径、Git 参数、文件写入或
  持久化格式；IPC 只改变后端→renderer 的输出形状，内容仍是用户已打开的两侧文档。历史 JSON、
  sidecar、设置与 `documentId` 语义未动（`history.rs`/`lib.rs` 保存路径测试全绿）。无新增依赖、
  网络、遥测或 capability。
- **性能不变量**：
  - `PERF-01`（Myers O(N+M) 辅助内存）与 `PERF-02`（25,000,000 工作预算）不变：`myers.rs` 未改，
    `approximate` 原样透传并有测试。
  - `PERF-03`（token/搜索上限）、`PERF-04`（16 MiB/200k 行）、`PERF-05`（只渲染视口）、
    `PERF-06`（`SessionUpdate` 不重传正文）、`PERF-07`（Git 上限）不变。
  - 新增并在 `docs/sdd/security-and-performance.md` 记录：`PERF-10`（IPC 不逐行传对象/高亮文本，
    行网格由 hunks 推导）、`PERF-11`（不预生成整篇每行字符串、不保留分段文本副本）。
  - 复杂度：`decodeDiff` 一次 O(rows)（200k 行实测 4.9 ms）；`LineIndex` 构建 O(text)、
    `text(i)` O(行长度) 且带单行缓存；搜索/渲染路径未增加全文扫描。行网格/`ops` 的预分配改为
    精确容量（`aligned_row_count`/`op_count`），不改变算法复杂度。
  - 确定性：同一输入 after 的 legacy/compact payload 与 baseline **逐字节相同**（bench §6.1），
    engine 确定性测试通过。
- **已知退化**：
  - `ignore_case` 下含希腊 `Σ` 的行在 intern 时回退到 `str::to_lowercase`（每行一次小分配），
    以保持与旧键完全等价的上下文相关小写规则；仅影响希腊文。
  - 前端 `DisplayItem` 仍按行生成普通对象（见 plan 非目标），大文件折叠场景下仍有对象开销；
    本轮以 diff 数据/行文本/IPC 为主，未宣称消除该项。

## 6. 未执行项与残余风险

| 项目 | 原因 | 影响 | 后续动作 |
|---|---|---|---|
| 真实窗口大文件 E2E（AC-10） | 本会话无 GUI 自动化，交互窗口无法脚本化驱动 | 无法证明滚轮/折叠/换行/搜索在 200k 行真实窗口下的手感 | 在桌面环境人工打开 16 MiB 文件逐项检查；或引入窗口 E2E（独立 L2/L3 变更） |
| `diff_ms` 前后对比 | 主机并行构建/测试，单次抖动 ±60%（baseline compact 71–183 ms） | 未给出“更快”的硬结论 | 空闲机器按 `benchmarks.md` §8 4b 协议复测；算法复杂度未变，仅删除了多余预留 |
| Windows `scripts/verify.ps1` | 无 Windows 主机（与基线一致） | Windows 门禁未实跑 | Windows 开发机执行 |
| 空闲 RSS 对比 | WebView/Chromium 基线占主导，非本次优化目标 | 无 | 如需可按进程 RSS 单独测量 |
| DMG 打包 | 按 AGENTS 交付流程使用 `SKIP_DMG=1` 只产出 `.app` | 无 DMG 产物 | 需要时去掉 `SKIP_DMG` 重跑 |
| 既有 i18n 环境依赖用例 | `detectLocale(undefined)` 依赖 `navigator.languages`；本机 `zh_CN` 使其期望值不成立（0002 验证已记录同一问题） | 仅本机 `LANG=zh_CN` 时 `npm test` 该 1 例失败，与本变更无关 | 另开 L1 修正该测试的环境假设（不在 0003 范围） |

残余风险：

| ID | 风险 | 缓解/现状 |
|---|---|---|
| RISK-01 | 前端行网格推导与 `align::pair_block` 不一致 | Rust/TS 双侧测试 + payload 与 baseline 逐字节相同；`row_count`/`row_start` 连续断言 |
| RISK-02 | changed 区间 UTF-16 偏移或换行切片坐标错误 | `wire.rs` 用 😀 断言 `(0,2,3)`；`diffView.test.ts` 覆盖裁剪/相对偏移；`codeRender` 对越界区间做 clamp |
| RISK-03 | interning 哈希碰撞导致错误判等 | 代表行精确归一化比较 + 碰撞链注入测试 + 40×6 差分对照；碰撞只影响性能 |
| RISK-04 | `$state.raw` 后遗漏某处深度响应式写路径 | 全部写路径已审查为整体替换；`tabs.test.ts` 通过；组件注释说明该约束 |
| RISK-05 | 200k 行 `decodeDiff` 的 4.9 ms 与 `LineIndex` 扫描带来的首帧成本 | 一次性 O(rows)/O(text)；远低于旧 `splitLines` 的字符串分配与 26.74 MiB 对象图；`LineIndex` 单行缓存兜底超长单行 |
| RISK-06 | 基准为合成输入，真实仓库/文件分布不同 | `benchmarks.md` §9 记录口径与保守项；payload 体积与行数关系由契约保证（随 hunks/changed 而非 rows） |

## 7. 结论

- 验收结论：AC-01–AC-09 PASS；AC-10 PARTIAL（打包应用可启动，真实窗口大文件检查 NOT RUN）。
- 产品规范已同步：Yes（`specs/product/litediff.md` 新增 `REQ-PERF-09`，版本 1.1）。
- 安全/性能文档已同步：Yes（`docs/sdd/security-and-performance.md` 新增 `PERF-10`/`PERF-11`）。
- 可合并：Yes（自动化门禁全绿；AC-10 的人工项列入合并后/桌面环境检查）。
