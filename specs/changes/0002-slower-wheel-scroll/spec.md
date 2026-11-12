# 0002：滚轮滚动改为“一格一行”并缓动

- Status: Implementing
- Risk: L2
- Owner: LiteDiff maintainers
- Created: 2026-11-12
- Change directory: `specs/changes/0002-slower-wheel-scroll/`

## 1. 背景与问题

分栏视图和统一视图的每一行只有 20 px（`--row-height`，随字号变化），而系统鼠标滚轮一格通常报告 40–60 px。原生滚动因此让一次滚轮“跳”两到三行。

用户可观察到的后果：表示“当前变更”的蓝色标记（gutter 尾部的 accent 竖条，见 `DiffPane.svelte` 的 `.row.active::before`）在滚动时按 hunk 跳转，一次滚轮就跨过两三个显示行，标记在视线落到它之前已经移走——“蓝色高亮一闪而过”。

这不是渲染缺陷，也不是标记算法缺陷：`nearestChange` 与 `anchorIndexForScroll` 已经保证标记单调跟随滚动。问题是滚动步长本身太粗。

## 2. 目标

- 一次滚轮事件最多滚动一行，读者能看清蓝色标记落到哪里。
- 每一步在数帧内缓动到位，而不是瞬时跳变，避免“闪一下”。
- 触控板细粒度增量（小于一行）、水平平移、翻页模式和缩放手势保持原生行为。
- 不引入新的用户设置、UI 文案或 locale 条目：这是一次默认手感的修正。

## 3. 非目标

- 不改变虚拟滚动的渲染窗口、折叠、换行、minimap 或标签页滚动恢复。
- 不改变键盘滚动（方向键、Page Up/Down、Home/End）和 minimap 点击/拖动。
- 不改变两个面板的滚动同步权威模型：偏移仍然由 `App.svelte` 持有并镜像到两侧。
- 不引入“平滑滚动”开关或速度滑块（本轮明确不加设置项）。

## 4. 需求与验收标准

| 需求 ID | 需求 | 验收 ID | 验收标准 |
|---|---|---|---|
| REQ-WHEEL-01 | 单个滚轮事件最多滚动一行，方向不变。 | AC-01 | `wheelStepPx(±40, 20)` 返回 `±20`；`±53`、`±120` 同样被压到一行；`wheelScroll.test.ts` 通过。 |
| REQ-WHEEL-02 | 小于一行的增量原样通过，方向不变。 | AC-02 | `wheelStepPx(4, 20) === 4`；触控板细粒度拖动不再被压缩。 |
| REQ-WHEEL-03 | 步长按行高计算，随字号/行高设置变化。 | AC-03 | `wheelStepPx(40, 30) === 30`；行高来自 `--row-height`，缺失或损坏时回退 20 px。 |
| REQ-WHEEL-04 | 不拦截缩放手势、翻页模式和以水平为主的平移。 | AC-04 | `ctrlKey`/`metaKey`、`deltaMode === 2`、`abs(deltaX) > abs(deltaY)` 时返回 `null`，事件交给浏览器。 |
| REQ-WHEEL-05 | 行模式（Firefox）按行高换算后再压到一行。 | AC-05 | `deltaMode === 1 && deltaY === 3` 时步长为一行。 |
| REQ-WHEEL-06 | 每一格在数帧内缓动到位，不反向、不越过目标。 | AC-06 | `easeToward` 单调收敛，约 11 帧内精确落点；缓动期间目标累加，连续滚轮不会合并成一步。 |
| REQ-WHEEL-07 | 外部改变偏移（跳转、切换标签、另一侧镜像）时放弃动画，不抢偏移。 | AC-07 | `scroll` 事件报告的偏移与本次动画写入值相差超过 1.5 px 时取消动画；代码审查 + 人工滚动/跳转检查。 |
| REQ-WHEEL-08 | 分栏与统一视图都使用同一实现，监听器必须非 passive。 | AC-08 | 两个组件都 `use:slowWheel`；`addEventListener("wheel", …, { passive: false })`，否则 `preventDefault` 无效、原生与缓动会叠加成双倍速。 |

## 5. 约束与不变量

- 相关产品规范条目：`REQ-VIEW-02`（滚动同步）、`REQ-VIEW-03`（虚拟滚动）、新增 `REQ-VIEW-11`。
- 相关安全不变量：无新增输入、路径、IPC 或持久化；不涉及 `SEC-NN`。
- 相关性能不变量：`PERF-05`（只渲染视口 + overscan）、`PERF-09`（确定性）。滚动路径不得扫描全文：本方案只读 `scrollHeight`/`clientHeight`/`--row-height` 与事件字段。
- 兼容性：无设置格式、历史格式或 IPC 变化；旧会话、旧标签页和旧设置原样可用。
- 平台：macOS WKWebView 与 Windows WebView2 都支持非 passive `wheel` 监听与 `scrollTop` 写入；Firefox 的行模式单独处理。

## 6. Open Questions

| ID | 问题 | Owner | 截止时间 |
|---|---|---|---|
| Q-01 | 一格一行是否会让长文件的长距离滚动偏慢？若用户反馈，考虑在持续快速滚动时提高上限（`MAX_STEP_ROWS` 为唯一常量）。 | LiteDiff maintainers | 下一轮反馈 |
