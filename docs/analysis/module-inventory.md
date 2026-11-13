# 模块清单

风险等级表示“修改时最可能引入回归的难度”，不是代码质量评价。

## 1. Rust 差分引擎

| 模块 | 责任 | 主要依赖 | 风险 | 关键验证 |
|---|---|---|---|---|
| `crates/litediff-core/src/lib.rs` | 公开差分入口、工作预算、模块编排 | 全部 core 子模块 | 高 | `tests/engine.rs`、workspace tests |
| `source.rs` | UTF-8 文档切片、CRLF/LF 行模型 | 标准库 | 中 | 空文档、尾换行、CRLF、Unicode |
| `model.rs` | `DiffOptions`、行操作、对齐行、hunk、统计和 IPC 序列化模型 | `serde` 可选 | 高 | 模型测试、前后端类型对照 |
| `intern.rs` | 按空白和大小写选项把行归一化为 `u32` 符号 | `HashMap` | 中 | 空白、大小写、符号计数 |
| `myers.rs` | 线性空间 Myers + 中间蛇 + 工作预算 | 标准库 | 极高 | DP LCS oracle、随机重复符号、预算退化 |
| `align.rs` | 编辑脚本 -> 等高分栏行、hunk 和统计 | `model`、`token` | 高 | 配对、补位、重建右侧文本 |
| `token.rs` | 行内 token 化、Myers token diff、字符区间高亮 | `myers` | 高 | 标识符、驼峰、Unicode、上限退化 |
| `tests/engine.rs` | 引擎端到端不变量与最优性验证 | 公共 API | 高 | 集成测试 |

## 2. Tauri 后端

| 模块 | 责任 | 主要依赖 | 风险 | 关键验证 |
|---|---|---|---|---|
| `crates/litediff-app/src/main.rs` | 应用启动和命令注册 | Tauri | 中 | 打包冒烟、启动冒烟 |
| `crates/litediff-app/src/lib.rs` | `AppState`、会话缓存、路径授权、文档令牌、文件读取、原子保存 | 文件系统、Sha2、core | 极高 | 路径授权、BOM、lossy、摘要冲突、权限、symlink |
| `crates/litediff-app/src/wire.rs` | 紧凑 diff IPC 负载：`DiffResult` → `WireDiff`（hunks + changed UTF-16 三元组，行网格不入线） | core、Serde | 高 | `wire.rs` 单元测试、payload 逐字节基准 |
| `commands.rs` | IPC 命令适配层，把阻塞工作移入 blocking pool | `lib.rs`、Git、历史 | 高 | 命令契约、状态边界 |
| `git.rs` | Git 仓库、文件、提交、分支、blob 和受限切换 | 系统 `git` | 极高 | 路径逃逸、参数注入、hooks/filter/gpg/fsmonitor |
| `history.rs` | 比较历史 JSON、sidecar、原子写、清理和保留策略 | 文件系统、Serde | 高 | 并发 ID、损坏隔离、旧格式兼容、路径安全 |
| `tauri.conf.json` | 窗口、CSP、bundle 和平台配置 | Tauri | 高 | 打包和 CSP 冒烟 |
| `capabilities/default.json` | 渲染进程能力白名单 | Tauri ACL | 高 | 仅允许自定义后端命令 |

## 3. Svelte 前端核心

| 模块 | 责任 | 主要依赖 | 风险 | 关键验证 |
|---|---|---|---|---|
| `app/src/App.svelte` | 唯一状态协调层：会话、标签、滚动、编辑、搜索、面板、设置 | 全部前端模块 | 极高 | tabs、viewport、search、layout、history |
| `app/src/lib/ipc.ts` | 唯一 IPC 封装和开发 mock | Tauri API、types | 高 | 类型检查、手动集成 |
| `app/src/lib/types.ts` | Rust IPC 的 TypeScript 镜像 | 无 | 高 | `npm run check`、契约评审 |
| `app/src/lib/diffView.ts` | 紧凑 diff 解码：由 hunks 推导类型化行网格，提供行/kind/changed 访问器 | types | 高 | `diffView.test.ts`、payload 基准 |
| `app/src/lib/lines.ts` | 行索引（起始偏移 `Int32Array`）与按需行切片，替代整篇 `splitLines` | 无 | 高 | `lines.test.ts` |
| `app/src/lib/viewport.ts` | 折叠投影、显示坐标、滚动窗口、换行和 minimap 坐标 | types | 极高 | `viewport.test.ts`、`render-perf.test.ts` |
| `app/src/lib/search.ts` | 字面量搜索、命中上限、按行分组和换行切片 | types、viewport | 高 | `search.test.ts` |
| `app/src/lib/syntax.ts` | 轻量多语言词法高亮和跨行状态 | 无 | 高 | `syntax.test.ts` |
| `app/src/lib/theme.ts` | 调色板、变更着色、CSS 变量 | settings | 中 | theme/diffTint/settings tests |
| `app/src/lib/settings.ts` | 设置校验、限幅、持久化和默认值 | theme | 中 | `settings.test.ts` |
| `app/src/lib/tabs.ts` | 标签创建、命名、关闭和排序 | types | 中 | `tabs.test.ts` |
| `app/src/lib/history.ts` | 前端历史类型、记录判定、时间分组 | types | 中 | `history.test.ts` |
| `app/src/lib/git.ts` | Git 文件过滤、模糊匹配、树投影 | types | 中 | `git.test.ts`、`gitTree.test.ts` |
| `app/src/lib/gitSession.ts` | Git 面板跨挂载状态 | types | 中 | `gitTree.test.ts` |
| `app/src/lib/autoHide.ts` | 浮层自动隐藏状态机 | 无 | 低 | `autoHide.test.ts` |
| `app/src/lib/codeRender.ts` | 文本、changed 区间、语法和搜索切片合并渲染 | diffView、syntax、search | 高 | search/syntax tests |
| `app/src/lib/themeCycle.ts` | 主题循环和标签 | settings、i18n | 低 | `themeCycle.test.ts` |
| `app/src/lib/i18n.ts` | 消息键、7 语言解析和占位符 | locales | 中 | `i18n.test.ts` |
| `app/src/lib/i18nStore.ts` | Svelte i18n store | i18n | 低 | `i18n.test.ts` |
| `app/src/lib/locales/*.ts` | 七种语言文案 | i18n 键 | 中 | 全键、占位符测试 |
| `app/src/lib/Minimap.svelte` | Canvas minimap、拖拽和导航 | viewport | 高 | `minimap.test.ts` |
| `app/src/lib/DiffPane.svelte` | 分栏虚拟滚动和行渲染 | CodeLine、viewport | 高 | viewport/layout tests |
| `app/src/lib/UnifiedView.svelte` | 统一视图虚拟滚动和换行 | CodeLine、viewport | 高 | viewport tests |
| `app/src/lib/CodeLine.svelte` | gutter、文本、语法、diff、搜索合成 | codeRender、theme | 中 | syntax/search tests |
| `app/src/lib/Toolbar.svelte` | 视图和功能控制 | types、theme | 中 | hover/theme UI tests |
| `app/src/lib/TabStrip.svelte` | 标签激活、关闭、重命名和拖拽 | tabs | 中 | `tabs.test.ts` |
| `app/src/lib/EmptyState.svelte` | 首屏粘贴、拖放和文件选择 | ipc、types | 中 | 手动集成 |
| `app/src/lib/EditPane.svelte` | 整文档编辑和草稿提交 | types | 中 | 手动集成 |
| `app/src/lib/SearchBar.svelte` | 查找栏交互 | search | 低 | search tests、手动手动 |
| `app/src/lib/SettingsPanel.svelte` | 设置侧栏 | settings、theme、i18n | 高 | settings/settingsLayout tests |
| `app/src/lib/GitPanel.svelte` | Git 仓库、文件、提交、分支和比较交互 | ipc、git、gitSession | 极高 | git/gitTree tests、手动集成 |
| `app/src/lib/HistoryPanel.svelte` | 历史列表、恢复和清理 | history | 中 | history tests、手动集成 |
| `app/src/lib/SameBanner.svelte` | 相同内容提示 | 无 | 低 | 手动集成 |

## 4. 测试与基础设施

| 路径 | 责任 | 风险 |
|---|---|---|
| `app/tests/*.test.ts` | 前端纯逻辑和少量源码布局契约测试 | 中 |
| `crates/litediff-core/examples/mem_bench.rs` | 200k 行合成 diff、legacy/compact payload 与内存基准 | 低 |
| `scripts/bench-memory.sh` | Rust `maxrss`/payload/耗时基准驱动（baseline/after 交错） | 低 |
| `scripts/frontend-memory-bench.mjs` | Node `--expose-gc` 渲染进程保留堆基准 | 低 |
| `app/run-tests.mjs` | 极简测试 runner | 低 |
| `scripts/package-macos.sh` | macOS 打包、签名和 DMG | 高 |
| `scripts/package-windows.ps1` | Windows NSIS 与便携 zip | 高 |
| `.github/workflows/release.yml` | 三平台发布和草稿 release | 极高 |

## 5. 高风险耦合点

| 耦合点 | 涉及文件 | 修改要求 |
|---|---|---|
| Rust/TypeScript IPC 字段 | `model.rs`、`lib.rs`、`wire.rs`、`commands.rs`、`types.ts`、`diffView.ts` | 同一次改动同时更新两侧，并验证 camelCase 映射与紧凑 payload 契约 |
| 保存能力 | `AppState`、`Side`、`ipc.ts`、`App.svelte` | 必须保持“路径不等于能力”的模型 |
| Git 执行面 | `git.rs`、`commands.rs`、`GitPanel.svelte` | 任何新 Git 命令都要评估 hook/filter/外部程序风险 |
| 坐标转换 | `viewport.ts`、`search.ts`、`App.svelte` | 明确源行、显示项、统一行和折叠坐标 |
| 历史格式 | `history.rs`、`history.ts` | 必须保留向后兼容或提供迁移 |
| 七语言消息 | `locales/*.ts`、`i18n.ts` | 同步增加键并运行全语言测试 |
