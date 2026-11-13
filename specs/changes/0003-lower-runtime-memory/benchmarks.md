# 0003：降低运行时内存占用与响应延迟 — 基准测量

- Status: Baseline 与 after 均已测（after 基于 2026-11-13 未提交工作树；最终 PR 提交由 T-08 复跑）
- Created: 2026-11-13
- 关联：[spec.md](spec.md)、[plan.md](plan.md)、[tasks.md](tasks.md)

本文记录 0003 变更的基准工具、测量方法、**改动前 baseline**（commit `0ba51fa`）与**同一套工具
测得**的 after 数字，第 7 节给出验收对照。after 测量点是 `feat/lower-runtime-memory` 的主工作树：
0003 实现全部落地、core 测试全绿、尚未提交（HEAD 仍是 `0ba51fa`）。

## 1. 测量目标

| 指标 | 对应需求 | 验收目标 |
|---|---|---|
| 同一 diff 的 IPC JSON 字节数 | REQ-MEM-02 / AC-02 | 降低 ≥ 70% |
| 渲染进程常驻 JS 堆（JSON.parse + decode 后） | REQ-MEM-03 / AC-03 | 降低 ≥ 60% |
| 后端 diff + 序列化进程峰值内存（`maxrss`） | spec.md §2 | 降低 ≥ 25% |
| diff 耗时 | spec.md §2（不退化） | 记录并对比，不设硬阈值 |

## 2. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-13 |
| 机器 | Apple M3，16 GiB，macOS 15.8.1 (24H32)，arm64 |
| Rust | rustc 1.99.1 / cargo 1.99.1（`$HOME/.cargo/bin`） |
| Node | v26.0.0 |
| baseline commit | `0ba51fa`（`main`，0003 第一个提交之前） |
| baseline 工作区 | `target/bench-baseline`（`git worktree`，gitignore 内，保留供复测） |
| after 工作区 | 主 checkout `/Users/tal/Project/LiteDiff`（`feat/lower-runtime-memory`，0003 实现未提交） |
| after 范围 | T-02/T-03 全部实现；另含 core 峰值分配修正：`align::build` 按 `aligned_row_count()` 精确分配 rows、`ops_from_matches` 精确分配 ops（均属 0003 范围） |
| 网络/依赖 | 无网络；基准工具只用 std / Node 内建模块，不新增依赖 |

## 3. 合成输入

`crates/litediff-core/examples/mem_bench.rs` 用公式生成确定性文档（无随机数、无时钟）：

```text
let cached_value_{i} = compute_{i % 997}(cursor, 0x{i:x}) + compute_{(i * 7) % 991}(cursor, 0x{i ^ 0x5a5a:x});
```

- 每侧 200,000 行（产品文档上限），实际 16.31 MiB/侧（左 17,104,767 B，右 17,104,648 B）。
- 每行都含 `i`，因此几乎所有行唯一：line interner 每行保存一份条目，正是本变更要优化的压力来源。
- right 侧每 200 行有 1 行小修改（改行尾字面量，产生 token 级 changed 区间）；另有 1 处单行插入、
  2 处单行删除，覆盖 `Insert`/`Delete` 补位行。
- 实测统计：rows 200,001、hunks 2,000、modified 998、deleted 2、added 1、`approximate=false`。
- **修改密度注意**：若每 50 行就改 1 行（约 4,000 处编辑），20 万行 diff 会耗尽
  `MYERS_WORK_BUDGET = 25_000_000` 的工作预算并退化为 `approximate=true`（hunks=1，全部行按
  Modify 替换）。那不是本变更要比较的“同一个 diff”，因此默认 stride 取 200（约 1,000 处编辑），
  保证 `approximate=false`、基线可比。

## 4. 工具与方法

### 4.1 工具

| 文件 | 作用 |
|---|---|
| `crates/litediff-core/examples/mem_bench.rs` | 生成输入、调用 `litediff_core::diff`，手工写出 legacy（旧 `DiffResult`）与 compact（plan §2 `WireDiff`）两种 JSON |
| `scripts/bench-memory.sh` | build → 直接运行 example 二进制并抓 `maxrss`，每个 mode 重复 N 次取中位数，输出 markdown 表；随后调用 Node 堆基准 |
| `scripts/frontend-memory-bench.mjs` | `node --expose-gc`，在独立子进程解析 payload，GC 前后测保留堆（compact 再叠加 `decodeDiff`） |

### 4.2 `maxrss` 测量

- `scripts/bench-memory.sh` 先 `cargo build --release -p litediff-core --example mem_bench`，
  然后 **直接执行** `target/bench-target/release/examples/mem_bench`，由
  `/usr/bin/time -l` 记录该进程的 `maximum resident set size`（macOS，字节；Linux 用 `-v`，KiB）。
  这样做保证 `maxrss` 属于基准进程本身，不包含 cargo 进程。
- 每个 mode 重复 6 次，表中为**中位数**，另给观测范围。`maxrss` 会受进程分配器
  “realloc 就地扩展 vs 拷到新块”影响，单次抖动可达约 ±8 MiB（见 4.5），因此 before/after
  必须用同一协议、并在同一次会话内交替测量后比较。
- JSON 缓冲分配模式（`--json-alloc`）：
  - `grow`（默认，贴近真实后端）：与 `serde_json::to_string` 一样从很小的缓冲开始倍增。
    Tauri 2.12.5 的 `impl<T: Serialize> IpcResponse for T` 就是
    `serde_json::to_string(&self)`，所以旧 payload 的真实序列化会有“最后几次 realloc 时新旧缓冲
    同时存在、最终容量最多 2× payload”的峰值行为。
  - `exact`（敏感性对照）：先用计数 writer 量出精确长度再一次性分配，排除分配器增长带来的噪声，
    用于区分“算法内存”和“序列化缓冲”。

### 4.3 JSON 体积与格式保真

- legacy JSON 的字段、顺序、`null` 补位、`kind` 小写与 `serde` 派生完全一致；compact JSON 与
  `crates/litediff-app/src/wire.rs` 的 `WireDiff` 序列化完全一致（changed 三元组用
  `InlineSegment.text.encode_utf16().count()` 累加，与 `wire.rs::collect_changed` 同算法）。
- 已用一个**不入库**的临时校验程序（`/tmp/litediff-bench-check`，依赖
  `litediff-core(features=["serde"])` + `serde_json`）对比：对 20 / 137 / 2,000 行三种输入，
  `mem_bench` 手写的 legacy JSON 与 `serde_json::to_string(&DiffResult)`、compact JSON 与
  `serde_json::to_string(&WireDiff)` **逐字节相同**（`cmp` 通过）。因此 compact 字节数即 0003
  实现后真实 IPC payload 的字节数（数值/布尔型 payload 不涉及转义差异；合成行文本均为 ASCII）。

### 4.4 渲染进程堆测量

- 每个 payload 在**独立 Node 子进程**中测量，互不污染：先 `GC ×2`，记录 `memoryUsage()` 基线，
  再 `JSON.parse`；compact 路径再调用真实 `app/src/lib/diffView.ts` 的 `decodeDiff(wire)`，
  然后丢弃 wire 对象（渲染进程只保留 `DiffTable`），再 `GC ×2` 后取保留增量。
- 统计口径为 `heapUsed + arrayBuffers` 的增量：`Int32Array`/`Uint8Array` 的底层存储不在 V8
  `heapUsed` 里，只看 `heapUsed` 会低估 compact 表的真实常驻内存。
- JSON 文本本身在测基线前已读入并持有，因此“IPC 字符串”这一瞬态不计入保留堆（符合“打开会话后
  常驻”的口径）。
- 本次 baseline 测量时主仓库工作区已有 0003 的实现（`app/src/lib/diffView.ts` 可 import，
  纯 type-only import，Node 类型擦除可直接加载），因此 compact 数字是**解析 + 真实 decode**
  后的结果；payload 文件仍由 `0ba51fa` 的 worktree 生成。after 复测会使用最终版 decoder 重跑。

### 4.5 重复与抖动

- `maxrss`：每个 mode 6 次取中位数。legacy 的序列化缓冲在部分运行里能被分配器就地扩展，
  峰值因此出现双峰（约 96–107.6 MiB vs 113–116 MiB）；表中同时给范围。
- `diff_ms`：同一 diff 在两种 mode 中重复；机器被其他构建占用时单次可漂移到 ±40%。
  表中为中位数，只用于“不退化”的 sanity check，不做严格跨分支对比。
- before/after 对比协议：after 测量完成后，把 baseline worktree 二进制与 after 主 checkout
  二进制**交错**各跑 6 次（4 种配置 × 6 次，交替执行，见 6.2），取中位数再算降幅。单独一次会话里
  baseline legacy 的 `maxrss` 中位数会在 107.6–112.0 MiB 之间漂移，因此 **AC 判定以 6.2 的交错
  批次为准**；5.1 / 6.1 的同会话数字用于复现命令与量级复核（5.4 给出 baseline 原始值）。

## 5. Baseline 结果（commit `0ba51fa`）

命令（详见第 8 节）：

```bash
bash scripts/bench-memory.sh target/bench-baseline \
  --out target/bench-baseline/target/bench-out --reps 6
```

### 5.1 Rust 后端（`grow`，真实序列化行为；中位数，n=6）

| mode | JSON bytes | JSON MiB | diff ms | JSON 构建 ms | maxrss MiB | maxrss 观测范围 |
|---|---:|---:|---:|---:|---:|---:|
| legacy | 16,721,094 | 15.95 | 64.0 | 16.3 | 107.6 | 107.6 – 112.9 |
| compact | 256,717 | 0.24 | 64.9 | 0.6 | 96.4 | 96.4 – 96.6 |

- **JSON 体积**：16,721,094 B → 256,717 B，**-98.5%**（AC-02 目标 ≥70%）。
- **同代码 payload-only 效果**：legacy → compact 的 `maxrss` 差 107.6 → 96.4 MiB（-10.5%）；
  这部分全部来自旧 payload 的序列化缓冲（见 5.2）。diff 本身的峰值由源文本 + 行网格主导。
- `diff_ms` 两种 mode 相同 work（差 0.9 ms 属于噪声）；`JSON 构建 ms` 是序列化开销，
  legacy 约 16 ms、compact 约 0.6 ms。

> 第 5 节是 baseline 单独会话的测量，用于复现命令与量级；before/after 的正式对比以 6.2 的
> 交错批次为准（原因见 4.5）。

### 5.2 分配敏感性（`--json-alloc exact`；中位数，n=3）

| mode | JSON bytes | diff ms | maxrss MiB |
|---|---:|---:|---:|
| legacy | 16,721,094 | 64.9 | 96.4 |
| compact | 256,717 | 64.3 | 96.4 |

两种 payload 在“精确容量、无增长拷贝”下 `maxrss` 相同，说明：

1. 进程峰值主体是源文本（32.6 MiB 文本 + 行索引）、行网格（约 14.4 MiB）与 interner，
   不是 payload 内容本身；
2. legacy baseline 多出的约 11.2 MiB 峰值来自 `serde_json` 式增长缓冲（16.7 MB payload
   最终容量可达 32 MiB，最后一次 realloc 新旧缓冲共存）。这也是 0003 移除逐行 payload 后
   **一定会消失**的一部分真实峰值。

### 5.3 渲染进程保留堆（Node v26，`--expose-gc`，真实 `decodeDiff`）

| payload | JSON bytes | JSON MiB | heapUsed MiB | ArrayBuffer MiB | 保留合计 MiB | rows | parse ms | decode ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy | 16,721,094 | 15.95 | 26.74 | 0.00 | **26.74** | 200,001 | 38.7 | n/a |
| compact | 256,717 | 0.24 | 0.19 | 1.74 | **1.93** | 200,001 | 0.3 | 4.9 |

- **保留堆**：26.74 MiB → 1.93 MiB，**-92.8%**（AC-03 目标 ≥60%）。
- compact 侧 1.93 MiB 中 1.74 MiB 是 `Int32Array`/`Uint8Array` 底层存储（9 B/行 × 200,001 行），
  hunk/对象图只剩约 0.19 MiB；legacy 侧 26.74 MiB 基本是“每行一个对象 + 两个空数组”的对象图。
- parse 时间 38.7 ms → 0.3 ms（decode 另 4.9 ms，一次 O(rows) 循环）。

### 5.4 原始重复数据（供复核）

`maxrss` 单位 MiB，`diff_ms` 单位 ms，每个 mode 6 次：

| mode | maxrss（6 次） | diff_ms（6 次） |
|---|---|---|
| legacy (grow) | 112.9, 107.6, 108.2, 107.6, 107.6, 107.6 | 67.4, 64.9, 63.9, 63.1, 64.1, 63.8 |
| compact (grow) | 96.4, 96.4, 96.5, 96.4, 96.4, 96.4 | 63.8, 67.5, 65.8, 65.5, 62.8, 64.3 |
| legacy (exact) | 96.4, 96.4, 97.2 | 64.7, 64.9, 66.8 |
| compact (exact) | 96.5, 96.4, 96.4 | 65.6, 64.3, 62.6 |

## 6. After 结果（`feat/lower-runtime-memory` 工作树）

### 6.1 after 单独会话（脚本口径；`grow`，中位数，n=6）

命令：

```bash
bash scripts/bench-memory.sh /Users/tal/Project/LiteDiff --lines 200000 \
  --out target/bench-out --reps 6
node --expose-gc scripts/frontend-memory-bench.mjs --dir target/bench-out
```

| mode | JSON bytes | JSON MiB | diff ms | JSON 构建 ms | maxrss MiB | maxrss 观测范围 |
|---|---:|---:|---:|---:|---:|---:|
| legacy | 16,721,094 | 15.95 | 74.5 | 16.9 | 83.2 | 82.9 – 88.1 |
| compact | 256,717 | 0.24 | 66.7 | 0.6 | 66.8 | 66.8 – 67.7 |

- **payload 与 baseline 逐字节相同**：`cmp` 确认 after 的 `diff-legacy.json` / `diff-compact.json`
  与 baseline worktree 产出的对应文件完全一致（diff 语义未变，行网格/hunks/stats/changed 区间不变）。
- compact `maxrss` 比 baseline compact（96.4 MiB，5.1）低约 29.6 MiB：T-02 interner 去行文本副本
  + `align::build`/`ops_from_matches` 的精确容量分配共同作用。
- 渲染进程保留堆（after payload + 最终版 `diffView.ts` decode）：
  legacy parse 26.74 MiB → compact parse+decode 1.93 MiB（**-92.8%**），与 5.3 一致。

### 6.2 before/after 交错批次（AC 判定口径；每配置 n=6，交替执行）

| 配置 | JSON bytes | maxrss MiB（中位数） | 观测范围 | diff ms（中位数，噪声大） |
|---|---:|---:|---:|---:|
| baseline legacy（旧代码 + 旧 payload） | 16,721,094 | **112.0** | 110.7 – 116.1 | 95.4 |
| baseline compact（旧代码 + 新 payload 形状） | 256,717 | 99.4 | 97.2 – 102.6 | 107.8 |
| after legacy（新代码 + 旧 payload 形状） | 16,721,094 | 85.9 | 85.5 – 88.1 | 83.9 |
| after compact（新代码 + 新 payload） | 256,717 | **67.2** | 67.0 – 67.7 | 73.2 |

拆解（交错批次）：

- payload 形状单独效果（旧代码）：112.0 → 99.4 MiB，**-11.2%**（旧 payload 的序列化增长缓冲）。
- core 改动单独效果（新 payload）：99.4 → 67.2 MiB，**-32.5%**（interner 去副本 + rows/ops 精确
  容量；peak 从“diff 阶段 + 序列化阶段”整体下移）。
- 合起来：112.0 → 67.2 MiB，**-40.0%**。

> `diff_ms` 在这台并行跑着其他构建/测试的机器上单次抖动可达 ±60%（baseline compact 观测到
> 71–183 ms），表中中位数不足以判定前后差异；算法复杂度未变（只是省掉多余 `Vec::with_capacity`
> 预留），需要在空闲机器上单独复测才能给出时间结论。见第 9 节。

### 6.3 前/后汇总

| 指标 | baseline（legacy, `0ba51fa`） | after（compact, 实现） | 变化 | 目标 |
|---|---:|---:|---:|---:|
| IPC JSON 字节 | 16,721,094 | 256,717 | **-98.5%** | ≥70% |
| JSON MiB | 15.95 | 0.24 | -98.5% | — |
| 渲染进程保留堆 MiB（parse+decode） | 26.74 | 1.93 | **-92.8%** | ≥60% |
| 后端 `maxrss` MiB（交错 n=6） | 112.0 | 67.2 | **-40.0%** | ≥25% |
| diff ms（中位数 n=6） | 95.4（噪声大） | 73.2（噪声大） | 不可判定 | 不退化 |

## 7. 验收对照

| 验收项 | 目标 | 证据 | 状态 |
|---|---|---|---|
| AC-02 IPC JSON 体积 | 降低 ≥70% | 16,721,094 B → 256,717 B，**-98.5%**；compact JSON 与真实 `WireDiff` 序列化逐字节相同（4.3），after 实测 payload 与 baseline 逐字节相同（6.1） | ✅ 满足 |
| AC-03 渲染进程堆（parse+decode） | 降低 ≥60% | 26.74 MiB → 1.93 MiB，**-92.8%**；after 用最终版 `app/src/lib/diffView.ts` 的 `decodeDiff` 实测（6.1） | ✅ 满足 |
| spec §2 后端 `maxrss` | 降低 ≥25% | 同一 diff、交错批次 n=6：baseline legacy **112.0 MiB** → after compact **67.2 MiB**，**-40.0%**（6.2） | ✅ 满足 |
| spec §2 diff 耗时 | 不退化 | 并行负载下噪声 ±60%，无法给出可靠结论；实现未改变算法复杂度，`diff_ms` 中位数在噪声范围内（6.2）。建议空闲机器复测并记入 `verification.md` | ⚠️ 待空闲复测 |

## 8. 复现命令

```bash
# 0) 依赖：cargo 在 PATH（否则 export PATH="$HOME/.cargo/bin:$PATH"）；node 可用；无网络

# 1) baseline（独立 worktree，避免被工作区改动污染；已存在时复用）
git worktree add target/bench-baseline 0ba51fa
cp crates/litediff-core/examples/mem_bench.rs \
   target/bench-baseline/crates/litediff-core/examples/
bash scripts/bench-memory.sh target/bench-baseline \
  --out target/bench-baseline/target/bench-out --reps 6

# 2) baseline 的渲染进程堆（主 repo 执行；读 baseline 产出的 JSON 绝对路径，
#    decode 用主 repo 当前 diffView.ts；不触碰 baseline worktree 的 node_modules）
node --expose-gc scripts/frontend-memory-bench.mjs \
  --dir target/bench-baseline/target/bench-out

# 3) after（实现完成后，主 checkout）
bash scripts/bench-memory.sh --out target/bench-out --reps 6
node --expose-gc scripts/frontend-memory-bench.mjs --dir target/bench-out

# 4) 灵敏度：只看算法内存、排除序列化缓冲增长
bash scripts/bench-memory.sh target/bench-baseline --out /tmp/bench-exact \
  --reps 3 --json-alloc exact

# 4b) before/after 交错对比（6.2 的方法；每次交替跑 baseline-legacy 与 after-compact）
OLD=target/bench-baseline/target/bench-target/release/examples/mem_bench
NEW=target/bench-target/release/examples/mem_bench
for rep in 1 2 3 4 5 6; do
  /usr/bin/time -l "$OLD" --lines 200000 --mode legacy  --out /tmp/bench-ba >/dev/null 2>/tmp/ba.time
  /usr/bin/time -l "$NEW" --lines 200000 --mode compact --out /tmp/bench-ba >/dev/null 2>/tmp/af.time
done

# 5) 单个 mode 手工复跑（payload 与 stdout 指标；脚本把二进制放在 CARGO_TARGET_DIR）
CARGO_TARGET_DIR=target/bench-target cargo build --release -p litediff-core --example mem_bench
./target/bench-target/release/examples/mem_bench --help
```

单次运行 stdout 形如（供脚本解析，也是本文数字的来源）：

```text
mode=legacy lines=200000 left_bytes=17104767 right_bytes=17104648 rows=200001 hunks=2000 \
  modified=998 deleted=2 added=1 approximate=false generation_ms=40.9 diff_ms=69.8 \
  json_alloc=grow build_ms=16.2 json_bytes=16721094 json_mib=15.95 json_path=.../diff-legacy.json
```

## 9. 已知限制与观察

1. **`maxrss` 有分配器/机器状态抖动**：旧 payload 的峰值取决于 16.7 MB 序列化缓冲最后一次
   realloc 是就地扩展还是拷到新块，单个会话内观测到 107.6–112.9 MiB 的两簇；机器并行负载还会让
   整批数字整体漂移数 MiB。本文用“同一次会话内 baseline/after 交错、各 n=6、取中位数”控制该漂移
   （5.4 给出 baseline 原始重复值，6.1 给出 after 的观测范围）。after compact 的峰值很稳定
   （67.0–67.7 MiB）。
2. **JSON 构建耗时**：legacy 约 16 ms，compact 约 0.6 ms（都在 diff 的 ~65 ms 之外）；after 的
   序列化本身也更快，但该收益不计入 `diff_ms`。
3. **与真实 app 的差异**：example 用 `SourceText` + `diff_sources` 模拟“会话持有两侧文本”的内存
   形态，但不包含 Tauri/WebView 自身内存，也不包含 baseline `CachedSession` 每次 `diff()` 复制
   行索引的 2.4 MB/侧（REQ-MEM-06）。后者收益在 app 级测试/人工验证中体现，不计入本文数字，属
   保守口径。
4. **payload 不变性**：after 与 baseline 的 legacy/compact JSON 均逐字节相同（同一输入、
   `--modify-every 200`、`approximate=false`、rows 200,001、hunks 2,000），可用于回归检查：
   今后任何 0003 相关改动若改变这些字节，说明 diff 语义或 payload 契约被破坏。
5. **after 的测量点**：`feat/lower-runtime-memory` 主工作树（未提交）。若最终 PR 又改动了
   core 内存路径，应用同一脚本与 6.2 协议复测；脚本只读 `git rev-parse HEAD` 作记录，不要求
   干净工作树。
6. **baseline worktree 保留**：`target/bench-baseline`（commit `0ba51fa`）在 `.gitignore` 内，
   未提交任何基准数据；保留供 T-08 复测/回归使用。
