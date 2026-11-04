# LiteDiff — Step 2 交付说明

Tauri v2 应用外壳 + 分栏比对视图。按你的选择，**整份 `rows` 一次性走 IPC**。

```
LiteDiff/
├── crates/litediff-core/          # Step 1 引擎（新增 serde feature，默认仍零依赖）
├── crates/litediff-app/           # 新增：Tauri v2 后端
│   ├── src/lib.rs                 # AppState / Session / OptionsPatch / 文件 IO
│   ├── src/commands.rs            # 6 个 IPC 命令
│   ├── src/main.rs                # Builder + 命令注册
│   ├── tauri.conf.json
│   └── capabilities/default.json  # 只给 core:default，文件访问全走自己的命令
└── app/                           # 新增：Svelte 5 + TS 前端
    ├── src/App.svelte             # 唯一的状态持有者 + 唯一跟后端说话的地方
    ├── src/lib/DiffPane.svelte    # 虚拟滚动面板（双栏同步）
    ├── src/lib/CodeLine.svelte    # 单行：行号 + 行内色块 + 斜纹占位
    ├── src/lib/Minimap.svelte     # canvas 热力条
    ├── src/lib/UnifiedView.svelte # 内联视图
    ├── src/lib/viewport.ts        # 纯函数：折叠投影 / 窗口计算 / hunk 导航
    ├── src/lib/theme.ts           # 设计令牌（严格照配色规范）
    └── tests/viewport.test.ts     # 18 个单元测试
```

## 关键决策与理由

**IPC 只传一次，前端无状态**
后端返回 `Session { left, right, result, options, warnings }`，`result.rows` 是全量。前端因此不需要按视口请求、不需要处理请求乱序、滚动时永不等待后端。虚拟化完全在 DOM 侧完成。

**滚动同步只有一个权威**
两个面板都不自己滚。它们把 `scrollTop` 上报给 `App`，`App` 存一个数，再作为 prop 回灌给两个面板（面板内 `$effect` 镜像）。因为两栏行高、折叠列表完全一致，同一个像素值天然对齐——不需要比例换算，也不会互相触发形成回环。差异超过 0.5px 才写入，防抖掉自身事件。

**行高固定 = 精确虚拟化**
`metrics.rowHeight = 20`。视口算式因此不需要测量、不需要 reflow 循环。代价是长行不换行（横向滚动），这对代码比对是正确取舍。

**折叠是投影，不是删除**
`buildDisplay(hunks, threshold, expanded)` 把 hunk 列表投影成显示项；折叠条本身占一个显示项，上下各留 1 行上下文。导航、minimap、滚动全部在"显示索引"空间工作，折叠不碰 DOM 逻辑。

**Minimap 用 canvas 而不是 DOM**
2 万行若用 div 会有数千节点；canvas 重绘是一次 draw call。它按**源行**比例绘制，所以折叠时热力条不跳动——地图是地图，折叠是视图。

**词级与行级必须同一套大小写语义**
开发中发现并修掉的真 bug：行级判定 `beta` vs `BETA` 是 modify（有色块），但词级强制小写归一后判定"无变化"——结果是整行泛红却没有任何高亮，看起来像渲染坏了。现在 `tokenize(..., fold_case)` 直接跟随 `ignore_case`，两层永远一致。

## 视觉规范落地

| 规范要求 | 实现 |
|---|---|
| 行级删除 rgba(244,63,94,0.08)、新增 rgba(34,197,94,0.08) | `theme.ts` `delRow`/`insRow`，light |
| Dark 提升到 0.16 | `dark.delRow`/`insRow` |
| 字符级叠加实色块 2px 倒角（0.28 / 0.38） | `.pill { border-radius: 2px }` + `delPill`/`insPill` |
| 严禁 #FF0000 / #00FF00 | 全部色值走 rgba 令牌，代码里没有这两个字面量 |
| 缺失侧 45° 斜纹 | `repeating-linear-gradient(45deg, ...)` 3px/0.5px 细线 |
| 等宽字体 + 等宽数字 | `--font-mono` 优先 SF Mono/Menlo；行号 `tabular-nums` |
| SF Symbols 尺寸 | 图标为 14px 内联 SVG 描边，无图标字体 |
| 无紫青渐变 / 发光 / 超大圆角 | 圆角上限 6px；唯一渐变是工具栏 2px 进度条（表示"在算"） |

## 验证（实测）

```
cargo test                    51 + 19 + 1 + 5 = 76 passed
cargo clippy --all-targets    0 warnings
npm test                      18 passed
svelte-check                  0 errors, 0 warnings
npm run build                 57 KB JS / 8 KB CSS（gzip 21.6 / 2.2 KB）
cargo build --release         二进制 4.8 MB（目标 < 15 MB）
```

另外做了真实冒烟测试：启动 release 二进制，系统事件确认创建了 1 个标题为 "LiteDiff" 的窗口，进程稳定无报错；再用一个探针程序走「读两个真实文件 → AppState.diff() → serde_json 序列化」这条完整 IPC 链路，确认 `modify` 行的 `right_inline` 带 `changed: true` 且文本为 `BETA`。

18 个前端测试里有一条抓到了真 bug：`windowFor` 在文档变短后遇到旧的超大 `scrollTop` 时未 clamp 起点，会渲染到列表外。已修实现并保留该用例。

## 尚未做（Step 3 范围）

- **双栏同步是"同一像素值"，不是"内容对齐"**：当前两栏行完全等数等高，所以够用。若将来允许单栏换行（行高不同），需要改成按行索引对齐。
- **内联视图未虚拟化**：显示项翻倍，仍在 DOM 预算内，但 10 万行级需要合并进同一套窗口算式。
- **就地编辑 / `Cmd+S` 覆写 / "采纳更改"箭头**：后端 `save_file` 已就绪（原子写：临时文件 + rename），前端编辑器尚未接。这块和虚拟滚动冲突（需要真实 DOM 输入框），是 Step 2 里我唯一刻意留白的部分。
- **文件夹拖拽**：后端 `expand_directory` 已实现，前端只处理了单文件。
- **`Cmd+Shift+W` 当前切的是 `ignore_all_whitespace`**（忽略全部空白），而原始规格写的是"忽略首尾空白与换行符"。若你要求严格按字面（只 trim），我改一行即可——现在两个选项后端都支持。
