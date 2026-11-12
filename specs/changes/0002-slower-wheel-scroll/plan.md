# 0002：实施计划

- Status: Implementing
- Related spec: [`spec.md`](spec.md)

## 1. 方案概述

新增 `app/src/lib/wheelScroll.ts`，导出一个 Svelte action `slowWheel`：在滚动容器上以非 passive 方式监听 `wheel`，把一次事件的步长压到“最多一行”，然后把目标偏移在 `requestAnimationFrame` 里按指数缓动追上去。容器本身仍拥有自己的 `scrollTop`，仍照常触发 `scroll` 事件，父组件仍从这一事件镜像两个面板——单权威模型不变。

选择 action 而不是在 `App.svelte` 里集中处理：`wheel` 只发生在指针下的那个滚动容器上，把监听器挂在容器上就不需要“哪个面板被滚动”的路由；`DiffPane` 与 `UnifiedView` 各加一行 `use:slowWheel`，`App.svelte` 完全不需要改动。

## 2. 影响范围

| 模块/文件 | 改动 | 风险 |
|---|---|---|
| `app/src/lib/wheelScroll.ts` | 新增纯函数（步长、clamp、缓动、行高解析）与 action | 中：`preventDefault` 会接管原生滚动 |
| `app/src/lib/DiffPane.svelte` | 挂 `use:slowWheel` | 低 |
| `app/src/lib/UnifiedView.svelte` | 挂 `use:slowWheel` | 低 |
| `app/tests/wheelScroll.test.ts` | 新增纯函数测试与接线断言 | 低 |
| `specs/product/litediff.md` | 新增 `REQ-VIEW-11` | 低 |

不涉及 Rust、IPC、设置、历史或 locale。

步长按“每个事件最多一行”而不是“乘以 0.5”：OS 报告的单位不可移植，而设备差异已经被实测描述过——macOS 上滚轮事件的 `deltaY` 通常大于 20 px 且数值重复，触控板的增量更小且连续（见 W3C uievents issue #337 的讨论与采样函数）。以一行作为上限，滚轮被压到一行，小于一行的触控板增量原样通过，不需要做不可靠的设备探测。

## 3. 接口与数据兼容性
- Rust/TypeScript IPC：无变化。
- 设置或历史格式：无变化，不需要迁移。
- 文件系统与 Git 行为：无变化。
- 向后兼容：旧标签页保存的 `scrollTop` 原样恢复；本改动只影响用户滚动时每一步的距离。

## 4. 安全与隐私

- 新增不可信输入：无。只读取 `WheelEvent` 的字段与 DOM 尺寸。
- 路径、能力或权限变化：无。
- 外部命令或网络访问：无。
- 对应 `SEC-NN`：无（不触碰安全边界）。

## 5. 性能

- 预期复杂度：每个 `wheel` 事件 O(1)；动画每帧 O(1) 次 `scrollTop` 写入，约 11 帧收敛。不扫描文档，不读全文。
- 上限与退化路径：`scrollHeight - clientHeight` 为 0 时直接放行；行高缺失时回退 20 px；外部滚动立即取消动画。
- 对应 `PERF-NN`：`PERF-05`（虚拟窗口不变）、`PERF-09`（确定性：缓动是纯函数）。
- 需要的证据：`npm test`、`npm run check`、`npm run build`，以及真实窗口滚动检查。

## 6. 测试策略

- 单元测试：`wheelStepPx`、`wheelDeltaPx`、`clampOffset`、`easeToward`、`rowHeightPx` 的边界与方向。
- 接线测试：两个视图都 `use:slowWheel`；监听器必须 `{ passive: false }`。
- 前端测试：`cd app && npm test`。
- 人工验证：真实窗口中滚轮一格、连续滚动、触控板、水平平移、⌘] 跳转与标签切换。

## 7. 替代方案

| 方案 | 优点 | 未采用原因 |
|---|---|---|
| 全局把 `deltaY` 乘以 0.5 | 改动最小 | 触控板同样被减速；OS 单位不可移植，0.5 在不同平台效果不同 |
| 设置里加“滚动速度”滑块 | 用户可自调 | 本轮明确不加设置项；会牵动七种 locale、产品规范与设置测试 |
| 只让蓝色标记“停留”或加过渡 | 不动滚动 | 用户要的是滚动变慢；滚动距离不变时标记仍会在每次滚轮后立刻移走 |
| CSS `scroll-behavior: smooth` + 手动 `scrollTop` | 少写 rAF | 每次赋值都会重启 UA 的定时动画，连续滚轮会发黏；也无法压低 OS 步长 |

## 8. 发布与回滚

- 发布顺序：一次性前端改动，无需迁移或开关。
- 失败恢复：若滚轮手感不佳或出现跳跃，回滚三个前端文件即可；`MAX_STEP_ROWS` 是唯一的手感常量。
- 用户数据回滚：无（不写任何持久化数据）。
- 监控或人工确认信号：滚轮在顶部/底部边界不抖动；⌘] 跳转不被动画拽回；两个面板保持同一位移。
