# LiteDiff — Step 1 交付说明

Tauri v2 架构下的 **Rust 后端核心比对引擎**。本步骤只做引擎与数据结构，不含 Tauri/IPC/前端渲染（Step 2 起）。

```
LiteDiff/
├── Cargo.toml                      # workspace，release 已开 LTO/单一 codegen unit/strip
└── crates/litediff-core/
    ├── src/
    │   ├── lib.rs                  # 公开入口 diff() / diff_sources()
    │   ├── source.rs               # 字节级行模型（CRLF 归一、尾换行不产生幻影行）
    │   ├── model.rs               # 数据结构：DiffOptions/LineOp/AlignedRow/Hunk/DiffStats
    │   ├── intern.rs               # 行 → u32 符号，跨双侧共享（忽略空白/大小写在此生效）
    │   ├── myers.rs                # 线性空间 Myers（中间蛇 + 前后缀剥离 + 迭代栈）
    │   ├── token.rs                # 词/字符级 diff → 高饱和色块所需的 char range
    │   └── align.rs                # edit script → 等高低栏行 + hunk 状态机
    └── tests/engine.rs             # 端到端验收测试
```

## 数据流（每层都是纯函数）

```
SourceText            字节 → 行区间（无内容拷贝）
  → intern            行 → u32（符号表双侧共享，忽略规则在此归一）
  → myers             符号序 → 升序匹配对
  → ops_from_matches  匹配对 → LineOp 编辑脚本（Equal/Delete/Insert）
  → align::build      脚本 → 带填充的等高行 + Hunk + Stats
  → token::diff_line  Modify 行 → InlineSegment（changed 标记）
```

## 关键设计决策

**为什么先 intern 成 `u32`**
Myers 的内层循环每步都要比较元素。比较 4 字节整数远快于 `HashMap` 查字符串，而且符号表双侧共享，天然表达"这两行相同"。

**Myers 用线性空间变体**
经典 Myers 需要保存全部 V 轨迹（O(D²) 内存）。这里用中间蛇双向搜索 + 显式工作栈，峰值内存 O(N+M)。前后缀先剥离，所以进入 `bisect` 的区域必然首尾不匹配，分割点必为内点 —— 这是迭代版能终止的前提。

**最优性由测试兜底**
`myers.rs` 内建一个 DP LCS 暴力解作为 oracle，断言"匹配数 == LCS 长度"，并对 40 组随机低字母表输入（重复符号最多的情况）逐一验证。这是唯一能证明编辑脚本最小的方法 —— 这类 bug 靠肉眼读代码看不出来。

**只保留 Myers**
Myers 是最主流的行级 diff 算法，也是 Git 与经典 diff 工具的默认选择。为保持界面和配置简洁，LiteDiff 不再暴露算法切换；行级对齐和行内高亮都使用 Myers。

**Token 级而不是字符级**
`foo_bar` → `foo_baz` 若按字符 diff 会只高亮 `r`/`z`。这里先按空白段 / 标识符 / 标点切词，标识符再在 camelCase 边界二次切分，`_` 作为独立分隔符。结果：只高亮 `bar`/`baz`。标识符按小写 intern，所以 `Foo` → `foo` 不算文本变更。

**填充行的语义**
一个删除段紧接一个插入段就是"替换"。`pair_block` 取 `min(del, ins)` 配成 `Modify` 行（供行内高亮），剩余用 `Delete`/`Insert` 行，缺失侧为 `None` —— 前端据此画 45° 斜纹占位。这保证每块左右行数严格相等，是 Step 3 严格同步滚动的前提。

**性能护栏**
`intra_line_max_tokens`（默认 2048）同时约束原始行长与词数；超限时 `diff_line` 返回 `None`，上层退化为整行高亮，避免压缩后的单行 bundle 卡死 UI。

## 视觉规范如何落到数据上

第二份规范里的配色要求由前端 CSS 变量实现，引擎只负责给出**语义**：

| 引擎输出 | 前端职责 |
|---|---|
| `RowKind::Equal/Modify/Delete/Insert` | 行级底色（8%/16% 透明度红绿） |
| `InlineSegment.changed == true` | 高饱和色块 + 2px 倒角 |
| `AlignedRow.left/right == None` | 45° 斜纹占位 |
| `Hunk { equal: false }` | Minimap 红/绿标线、`Cmd+]`/`Cmd+[` 跳转 |
| `Hunk { equal: true, row_len > 10 }` | 折叠条 |

## 验证

```bash
cargo test      # 50 单元 + 19 集成 + 1 doc = 70 passed
cargo clippy --all-targets   # 0 warnings
cargo build --release        # liblitediff_core.rlib ≈ 393 KB
```

覆盖：空文档、纯插入/纯删除、替换块配对与填充、CRLF 与 LF 等价、含 emoji/CJK 的 Unicode 行、忽略空白/忽略大小写、确定性、20k 行 + 50 处改动的性能（断言 < 5s，实测约 10ms）、hunk 平铺不重叠、`hunk_at_row` 二分查找、行内段拼接可无损还原原文。

## 尚未做（按约定等确认后进 Step 2）

- 未引入 `serde`：IPC 序列化留给 Step 2 加 feature flag，保持核心 crate 零依赖。
- 未做增量/分块：当前是整文件一次性 diff（20k 行 ~10ms，已够用）。若后续要支持超大文件流式比对，在 `diff_sources` 外再包一层按块调度即可，引擎接口不用改。
- 未做语法感知（如按语言分词）：`token.rs` 的 `is_word_char` 是唯一扩展点。
