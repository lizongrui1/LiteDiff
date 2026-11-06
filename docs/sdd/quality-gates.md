# 质量门禁

## 1. 前置条件

- Rust 1.75+ 和 Cargo 可用。
- Node 18+ 和 npm 可用。
- 已执行 `cd app && npm ci`。
- macOS/Windows 打包验证需要对应平台工具链。

## 2. 一键验证

macOS / Linux / Git Bash：

```bash
bash scripts/verify.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

脚本依次执行：

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets -- -D warnings`
3. `cargo test --workspace`
4. `cd app && npm test`
5. `npm run check`
6. `npm run build`

## 3. 按变更等级的最低门禁

| 等级 | Rust | 前端 | 打包 | 额外验证 |
|---|---|---|---|---|
| L0 | 受影响 crate 的格式检查 | 受影响的 `check`/测试 | 不要求 | 文档链接检查 |
| L1 | 受影响模块测试 | 相关测试 | 不要求 | 回归场景 |
| L2 | 完整 Rust 门禁 | 完整前端门禁 | 视平台影响 | 手动集成或性能证据 |
| L3 | 完整 Rust 门禁 | 完整前端门禁 | 至少目标平台冒烟 | 威胁/性能分析、跨平台计划、回滚演练 |

完整发布验证仍按 `.github/workflows/release.yml` 执行。

## 4. 必须通过的评审问题

### 行为

- 变更规范中的每条验收标准是否有证据？
- 行为变化是否同步到 `specs/product/litediff.md`？
- 是否引入与当前产品非目标冲突的能力？

### 安全和隐私

- 是否新增了来自 renderer 的路径、命令、revision 或持久化数据？
- 是否保持“路径不等于保存能力”？
- 是否新增 Git 子命令、文件格式、网络请求或外部程序？
- 新增数据是否仍只保存在本机，并可被用户清理？

### 性能

- 是否新增无界循环、无界缓存、无界搜索结果或全文档重复传输？
- 是否改变 Myers、token diff、搜索、折叠或虚拟滚动的复杂度？
- 退化路径是否确定、可解释并有用户可见警告？

### 兼容性

- IPC 两侧类型是否同时更新？
- 历史 JSON、设置或持久化格式是否向后兼容？
- macOS 和 Windows 的路径、权限、行结尾差异是否考虑？

### 界面

- 七种语言是否同步？
- 键盘操作、焦点、对比度和红绿色弱模式是否保持？
- 布局修改是否在桌面窗口和最小窗口尺寸下验证？

## 5. 安全门禁

任何触及以下区域的改动必须引用 [`security-and-performance.md`](security-and-performance.md) 中的相关编号：

- 文件选择、拖放、路径规范化。
- `documentId`、文档注册和保存。
- 符号链接、BOM、lossy UTF-8、摘要冲突。
- Git 命令、仓库配置、分支切换。
- 历史记录 ID、文件写入和清理。
- Tauri capabilities、CSP 和插件权限。

如果无法证明安全不变量仍成立，变更不能合并。

## 6. 性能门禁

性能敏感改动至少提供以下一种证据：

- 现有性能测试仍通过。
- 新增确定性复杂度测试。
- 本地基准前后对比。
- 明确说明为何复杂度不变。

以下内容不能作为充分证据：

- 只在一个小样例上“感觉更快”。
- 关闭功能来掩盖退化。
- 没有上限的“通常不会发生”。

## 7. 验证记录格式

```text
Environment: macOS 15 / Apple Silicon / Rust x.y / Node x.y
Command: cargo test --workspace
Result: PASS
Evidence: 138 passed, 0 failed
Notes: -
```

未执行：

```text
Command: Windows packaging
Result: NOT RUN
Reason: no Windows host in this environment
Follow-up: run before release acceptance
```

## 8. 失败处理

- 格式或类型错误：修复后重跑全部门禁。
- 偶发测试失败：记录种子、输入和失败位置；不得直接重跑掩盖。
- 安全测试失败：停止合并，按 S1 风险处理。
- 性能测试失败：确认是否为环境噪声；必要时提供多次运行数据。
- 无法解决的已知限制：写入产品规范的 Known Limitations 和变更规范的风险项。
