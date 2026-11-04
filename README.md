<div align="center">

<img src="crates/litediff-app/icons/icon.png" alt="LiteDiff app icon" width="128" height="128" />

# LiteDiff

**本地文本 / 代码差异比对工具**

纯 Rust 比对引擎 · Tauri v2 原生窗口 · 无 Electron

[![Rust](https://img.shields.io/badge/Rust-1.75%2B-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![macOS](https://img.shields.io/badge/macOS-11%2B-000000?logo=apple&logoColor=white)](#系统要求)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)](#系统要求)

</div>

---

## 下载

从 [Releases](../../releases) 获取安装包。每个版本提供四个文件：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS（Apple Silicon） | `LiteDiff-*-macos-arm64.dmg` | 打开后拖入「应用程序」 |
| macOS（Intel） | `LiteDiff-*-macos-x64.dmg` | 同上 |
| Windows 10/11 (x64) | `LiteDiff-*-windows-x64.exe` | 安装程序，**无需管理员权限** |
| Windows 便携版 | `LiteDiff-*-windows-x64.zip` | 解压即用，无需安装 |

安装说明：

- **macOS** —— 安装包已做 ad-hoc 签名，但**没有经过 Apple 公证**（公证需要付费开发者账号）。首次启动若提示「无法验证开发者」，到 *系统设置 → 隐私与安全性 → 仍要打开*；或执行：
  ```bash
  xattr -dr com.apple.quarantine /Applications/LiteDiff.app
  ```
- **Windows** —— 直接运行 `.exe`。安装到当前用户目录，不弹 UAC。若系统缺少 WebView2，安装程序会自动下载。

**校验下载**：每个版本附带 `SHA256SUMS.txt`。

```bash
shasum -a 256 -c SHA256SUMS.txt    # macOS
certutil -hashfile <文件名> SHA256  # Windows
```

---

## 特性

**比对引擎**（纯 Rust，零第三方依赖）

- 线性空间 Myers（中间蛇 + 前后缀剥离），峰值内存 O(N+M)，最优性由 DP LCS oracle 验证
- Patience 算法（唯一行锚点 + LIS），大重构下读数更稳
- 词级行内高亮：`foo_bar` → `foo_baz` 只高亮 `bar`/`baz`，不按字符切碎
- 支持忽略首尾空白 / 全部空白 / 大小写；CRLF 与 LF 等价

**界面**

- 界面支持 7 种语言：简体中文 / English / 繁體中文 / 日本語 / Español / Deutsch / Français，可跟随系统
- 左右分栏 ⇄ 行内统一双视图
- 固定行高虚拟滚动，3000+ 行只渲染视口附近约 20–40 行
- 双栏垂直与水平滚动严格同步
- 长未变动区块自动折叠，可单独展开 / 重新折叠 / 一键全开全收
- 折叠条显示隐藏的行号区间；行号列按位数自适应
- Minimap 热力条：canvas 绘制，支持点击、拖动、键盘导航
- 变更三级标识：行背景 → 行首 3px 标记条 → 词级色块

**交互**

- 首页两侧直接粘贴内容（`⌘V`），也可拖入文件到某一侧
- `⌘N` 或「重新输入」回到粘贴界面
- `⌘S` 原子写回磁盘
- 深色 / 浅色 / 跟随系统
- 设置面板（<kbd>⌘</kbd><kbd>,</kbd>）：强调色、红绿色弱配色、着色强度、字号与行距、行号 / 缩略图开关、折叠阈值、首尾空白与大小写

**Git 历史**

- 打开任意本地仓库，按路径筛选文件
- 对比「工作区」与任意历史提交，或两个历史提交之间
- 与历史版本比对时，⌘S 不会写回（历史内容只读）
  - 通过系统 `git` 命令读取，只调用 `rev-parse` / `log` / `show` / `ls-files`，不会修改仓库

**对比历史**

- 每次比对自动存到本机，重新打开软件后可以在历史里把当时的对比恢复成一个标签页
- 按天分组（今天 / 昨天 / 日期），可以单条删除，也可以一次性清空
- 保留策略在设置里可调：按天数、按条数，各自填 0 表示不限制
- 只写在本机的应用数据目录，不上传；单条超过 4 MB 的比对不记录（截断会让它变成另一次对比）

## 快捷键

| 按键 | 功能 |
|---|---|
| <kbd>⌘</kbd><kbd>]</kbd> / <kbd>⌘</kbd><kbd>[</kbd> | 下一个 / 上一个差异 |
| <kbd>⌘</kbd><kbd>D</kbd> | 切换左右 / 行内视图 |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>W</kbd> | 忽略首尾空白与换行符 |
| <kbd>⌘</kbd><kbd>⌥</kbd><kbd>E</kbd> | 展开 / 折叠全部未变动区块 |
| <kbd>⌘</kbd><kbd>S</kbd> | 保存 |
| <kbd>⌘</kbd><kbd>T</kbd> / <kbd>⌘</kbd><kbd>N</kbd> | 新建标签页（回到粘贴界面，已有对比保留） |
| <kbd>⌘</kbd><kbd>W</kbd> | 关闭当前标签页 |
| <kbd>⌘</kbd><kbd>,</kbd> | 打开 / 关闭设置 |
  | <kbd>⌘</kbd><kbd>G</kbd> | 打开 / 关闭 Git 历史 |
  | <kbd>⌘</kbd><kbd>Y</kbd> | 打开 / 关闭对比历史 |
## 从源码构建

需要 Rust 1.75+ 与 Node 18+。

```bash
# 依赖
cd app && npm install && cd ..

# 测试
cargo test                # Rust
cd app && npm test        # 前端

# 打包 macOS：产出 .app 与 .dmg
./scripts/package-macos.sh
SKIP_DMG=1 ./scripts/package-macos.sh   # 只要 .app，本地迭代更快

# 打包 Windows：产出 NSIS 安装包与便携 zip（在 Windows 上执行）
powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
```

发布由 [.github/workflows/release.yml](.github/workflows/release.yml) 完成：推送 `v*` 标签后，在 macOS（arm64 与 x64）和 Windows 上分别构建，产物挂到一个**草稿** release 上，附 `SHA256SUMS.txt`，由人工确认后发布。

开发模式需两个终端：`cd app && npm run dev` 与 `cargo run -p litediff-app`。

## 系统要求

- **macOS 11+**（Big Sur 及以上），Apple Silicon 与 Intel 均提供原生构建，安装包约 2.3 MB
- **Windows 10 / 11 (x64)**，需要 WebView2（Win11 与较新的 Win10 已内置，缺失时安装程序自动下载）

## 架构

```
Svelte 5 前端 ──IPC（一次传全量 Session）── Tauri v2 后端 ── litediff-core
```

**三个关键决策**

- **IPC 一次传全量**：前端无状态，滚动永不等待后端；虚拟化纯在 DOM 侧
- **滚动单一权威**：面板只上报 `scrollTop`，`App` 存一个数回灌两栏，同像素天然对齐
- **折叠是投影**：`buildDisplay()` 把 hunk 投影成显示项。注意显示索引与源行索引是两套坐标系，跳转必须投影

## 测试

```bash
cargo test      # 102 个
npm test        # 173 个（在 app/ 下）
```

Rust 侧核心是**最优性验证**：内置 DP LCS 暴力解作为 oracle，断言「匹配数 == LCS 长度」，并对 40 组随机低字母表输入逐一核对。开发中它抓出过两次中间蛇重叠判定的错误。

## 已知限制

| 限制 | 原因 |
|---|---|
| 就地编辑 | 与虚拟滚动冲突：需要可聚焦输入元素，而虚拟滚动会回收 DOM |
| 「采纳更改」箭头 | 依赖就地编辑的缓冲区模型 |
| 行内视图折叠 | 分栏视图有，行内视图未接 |
| 大文件 | 整文件一次性比对，未做分块流式 |
