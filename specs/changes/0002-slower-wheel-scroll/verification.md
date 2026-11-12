# 0002：验证记录

- Status: Implementing
- Related spec: [`spec.md`](spec.md)
- Verified at: 2026-11-12

## 1. 环境

- OS: macOS 15.8.1 (arm64)
- Architecture: arm64
- Rust: cargo 1.99.1 (5f94df478 2026-08-27)
- Node/npm: Node v26.0.0 / npm 11.12.1
- Commit/worktree: `b52e662` + 本次未提交改动

## 2. 验收标准证据

| 验收 ID | 结果 | 证据 |
|---|---|---|
| AC-01 | PASS | `wheelScroll.test.ts`：`a 40px notch moves one row, not two`、`a notch wider than a row is capped…`（40/53/120/300 均压到一行，方向保持） |
| AC-02 | PASS | `trackpad-sized deltas pass through untouched`（0.5/4/11.75/19.9 原样返回） |
| AC-03 | PASS | `the cap follows the row height…`（行高 30/12 时上限随行高）、`row height is parsed…`、`a missing or corrupt row height falls back…` |
| AC-04 | PASS | `pinch-zoom and browser gestures…`、`page-mode deltas…`、`a mostly horizontal pan stays native`、`a vertical wheel with a little sideways noise is still ours` |
| AC-05 | PASS | `line-mode deltas are converted through the row height before capping` |
| AC-06 | PASS | `the ease always moves towards the target and never past it`、`the ease settles in a handful of frames…`、`a distance under the snap threshold lands immediately` |
| AC-07 | PARTIAL | 取消逻辑在 `wheelScroll.ts` 的 `onScroll`（外部位移超过 1.5 px 即 `cancelAnimationFrame`），但只有静态审查；真实窗口的 ⌘] 跳转、标签切换未人工执行（见第 4 节） |
| AC-08 | PASS | `both scrolling views use the eased wheel action`、`the wheel listener stays non-passive…` |

## 3. 自动化检查

```text
Command: cd app && npm test
Result: 355 passed / 1 failed (356 total)
Evidence: 新增 .tmp-test/wheelScroll.test.mjs 26/26 通过；唯一失败为
          i18n.test.ts「detection falls back to English when nothing matches」，
          该用例把 detectLocale(undefined) 与 "en" 比较，而本机 Node 的
          navigator.languages 为 ["zh-CN"]，属与本改动无关的既有环境依赖用例。
Notes: 只运行 npm test 会因该用例失败；wheelScroll 相关用例全绿。
```

```text
Command: cd app && node --test .tmp-test/wheelScroll.test.mjs
Result: 26 passed / 0 failed
Evidence: 步长、方向、行高回退、手势放行、clamp、缓动收敛、接线与非 passive 断言，
          以及用假节点和手动帧时钟驱动的 action 测试（累加、边界、外部取消、销毁）
Notes: 无
```

```text
Command: cd app && npm run check
Result: svelte-check found 0 errors and 0 warnings
Evidence: action 类型与两个组件的接线通过类型检查
Notes: 无
```

```text
Command: cd app && npm run build
Result: ✓ built in 2.86s（243.68 kB JS / 46.54 kB CSS）
Evidence: 生产构建通过
Notes: 无
```

```text
Command: bash scripts/verify.sh
Result: PARTIAL — cargo fmt 通过；cargo clippy 在沙箱内无法运行
Evidence:
  ==> cargo fmt            (通过)
  ==> cargo clippy         error: failed to create directory
      `/Users/tal/.cargo/registry/cache/index.crates.io-...`
      Caused by: Operation not permitted (os error 1)
Notes: clippy 需要写入 workspace 之外的 Cargo 注册表缓存，本会话的文件沙箱拒绝；
       这是环境限制，不是编译或 lint 失败。Rust 侧零改动（git status 仅前端文件）。
       前端四道门禁已逐一单独执行并通过。
```

## 4. 人工检查

| 场景 | 步骤 | 预期 | 实际 |
|---|---|---|---|
| 分栏视图滚轮一格 | 真实窗口内滚动一格 | 只走一行，蓝色标记跟随且可见 | NOT RUN |
| 连续快速滚动 | 连续滚轮 10 格 | 目标累加、不抖动、不回到原点 | NOT RUN |
| ⌘] / ⌘[ 跳转 | 滚动过程中触发跳转 | 跳转不被动画拽回 | NOT RUN |
| 切换标签 / 恢复滚动位置 | 切走再切回 | 恢复位置不被旧动画覆盖 | NOT RUN |
| 触控板平移 | 两指上下/左右 | 小增量与水平平移保持原生 | NOT RUN |
| 统一视图 | 同样滚动 | 与分栏一致 | NOT RUN |

本机无法可靠产生物理滚轮/触控板输入，故人工项如实标记 `NOT RUN`，不以自动化结果代替。

## 5. 安全与性能证据

- 安全不变量：无新增输入、IPC、路径或持久化；不涉及 `SEC-NN`。
- 性能预算：每个 wheel 事件 O(1)，动画每帧 O(1) 次 `scrollTop` 写入、约 11 帧收敛；不读取或扫描文档内容。`PERF-05` 的虚拟窗口与 `PERF-09` 的确定性不受影响。
- 已知退化：每个事件最多一行，长距离滚动的吞吐低于原生；`MAX_STEP_ROWS` 是唯一手感常量，可在后续反馈中调整。大于一行的触控板快速甩动也会被压到一行。

## 6. 未执行项与残余风险

| 项目 | 原因 | 影响 | 后续动作 |
|---|---|---|---|
| 真实窗口人工滚动 | 本机没有可编程的物理滚轮输入 | AC-07 只能判 PARTIAL | 合并前由维护者按第 4 节表格逐项检查 |
| `cargo clippy` / `cargo test` | 沙箱拒绝写入 `~/.cargo/registry`，clippy 在解析依赖时中断 | Rust 零改动，前端门禁已单独全跑 | 在可写 Cargo 缓存的环境重跑 `bash scripts/verify.sh` |
| Windows WebView2 | 当前主机为 macOS | 步长按行高计算，与平台无关，风险低 | 发布前在 Windows 冒烟 |
| `i18n.test.ts` 既有失败 | 用例依赖宿主 `navigator.languages` | 与本改动无关，但会挡住“全绿”结论 | 后续单独修正该用例 |

## 7. 结论

- 验收结论：PARTIAL（自动化证据完整；真实窗口滚动与整链 clippy 未执行）
- 产品规范已同步：Yes（`REQ-VIEW-11`）
- 可合并：No（待人工滚动检查与可写 Cargo 缓存环境下的整链门禁）
