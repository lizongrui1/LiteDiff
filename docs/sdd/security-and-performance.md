# 安全与性能不变量

本文件列出改动时必须保持的边界。评审引用对应编号。

## 安全不变量

| ID | 不变量 | 当前实现位置 | 验证 |
|---|---|---|---|
| SEC-01 | Renderer 提供的路径不能直接读取或写入 | `AppState::require_approved_path` | `lib.rs` 授权测试 |
| SEC-02 | 显示路径不等于保存能力，可写文件必须有后端 `documentId` | `Side`、`prepare_side`、`register_document` | `an_unregistered_path_is_not_a_save_capability` |
| SEC-03 | 路径在授权和保存时 canonicalize，并拒绝符号链接 | `approve_path`、`read_bounded_bytes`、`replace_file_atomically` | symlink/路径逃逸测试 |
| SEC-04 | 保存前检查摘要，保存过程中再次检查，防止覆盖外部修改 | `save_current`、`replace_file_atomically` | external change / concurrent save tests |
| SEC-05 | lossy UTF-8 永久只读，保存保留原 BOM 和 Unix 权限 | `TextFile`、`replace_file_atomically` | lossy/BOM/permission tests |
| SEC-06 | 历史 ID 只能是安全文件名字符，sidecar 不能复活缺失正文 | `sanitize_id`、`history::list` | history safety tests |
| SEC-07 | Git 参数以 argv 传递，revision 先解析为 40 位 SHA | `git::run`、`resolve_rev` | 注入测试 |
| SEC-08 | Git 读取禁用 hooks、fsmonitor、external diff、签名展示和不必要全局配置 | `git_command` | fsmonitor/gpg/hook tests |
| SEC-09 | 分支切换不得强制执行，不得运行未受控 content filter | `switch_branch`、`reject_checkout_filters` | filter/dirty worktree tests |
| SEC-10 | Git 文件路径必须相对、不含 `..`，并留在仓库内 | `check_relative`、`worktree_path` | path escape tests |
| SEC-11 | 所有外部输出有上限，防止内存耗尽 | 文档 16 MiB、Git 32 MiB、stderr 1 MiB | limit tests |
| SEC-12 | Tauri renderer 只获得必要 capability，原生日志选择由后端发起 | capabilities、commands | 配置审查和手动冒烟 |

### 安全改动清单

- 新增 IPC 命令时，确认输入最小权限和输出上限。
- 新增文件写入时，先登记能力，再做 canonicalize、symlink 检查和摘要校验。
- 新增持久化时，定义 ID 规范、路径根、原子写和损坏隔离。
- 新增 Git 命令时，列出可能读取的仓库配置及禁用方式。
- 新增网络或遥测必须单独做隐私评审；默认拒绝。

## 性能不变量

| ID | 不变量 | 当前预算/位置 | 验证 |
|---|---|---|---|
| PERF-01 | 行级 Myers 峰值辅助内存为 `O(N+M)` | `myers.rs` 线性空间 bisect | engine tests |
| PERF-02 | 行级搜索有工作量上限，超限返回近似结果 | `MYERS_WORK_BUDGET = 25_000_000` | budget tests |
| PERF-03 | 词级 diff 和搜索有上限，超限退化 | 2,048 token/字符；50,000 hits | token/search tests |
| PERF-04 | 单文档大小和行数有界 | 16 MiB；200,000 行 | limit tests |
| PERF-05 | 分栏和统一视图只渲染视口与 overscan | `viewport.ts`、`DiffPane`、`UnifiedView` | render-perf/viewport tests |
| PERF-06 | 选项切换不重新传输两篇全文 | `SessionUpdate` | IPC 契约和手动检查 |
| PERF-07 | 大仓库文件树和提交列表有界 | 文件列表 20,000；提交 500 | clamp tests |
| PERF-08 | 历史条目超过 4 MiB 不截断，直接不保存 | `MAX_ENTRY_BYTES` | history tests |
| PERF-09 | 搜索和渲染结果必须确定性，避免重复计算导致漂移 | search/viewport 纯函数 | deterministic tests |
| PERF-10 | 单次比较的 IPC 负载不逐行传输对象或高亮文本：行网格由 `hunks` 在渲染进程用类型化数组推导，修改行只传 changed 的 UTF-16 区间 | `wire.rs`、`diffView.ts` | wire/diffView 测试、JSON 体积基准 |
| PERF-11 | 渲染进程不为整篇文档预生成每行字符串，也不保留分段文本副本 | `lines.ts`、`diffView.ts` | LineIndex 测试、JS 堆基准 |

### 性能改动清单

- 说明输入规模、时间复杂度、空间复杂度和退化触发条件。
- 热点算法优先使用纯函数和可重复测试。
- 不在滚动或输入事件中扫描全文。
- 新增缓存必须定义容量、失效条件和清理策略。
- 若需要改变预算，必须提供基准数据并更新产品规范。

## 变更冲突处理

当安全与性能目标冲突时：

1. 先保证数据安全和正确性。
2. 提供有界、确定性的退化方案。
3. 将退化显式告知用户或记录警告。
4. 用后续 L2/L3 变更优化，而不是放宽边界。
