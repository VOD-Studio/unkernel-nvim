# unkernel-nvim

基于 [unkernel](https://github.com/pithings/unkernel)（WebAssembly Linux 7.x 内核 + Alpine `riscv64` JIT）与 [DefectingCat/nvim](https://github.com/DefectingCat/nvim) 构建的全屏浏览器端 Neovim 工作区。无需后端服务器，在浏览器本地运行完整的 Linux 用户态、原生 Neovim 0.12、LSP 与 Tree-sitter 工具链。

---

## 核心特性

- **真实 Linux 内核与原生用户态**：基于 `unkernel` 在 Web Worker 中运行编译为 WebAssembly 的 Linux 内核，直接执行未经修改的 Alpine Linux 3.24 `riscv64` 二进制程序（`neovim`、`git`、`ripgrep`、`fd`、`lua-language-server`、`stylua`）。
- **开箱即用的预烘焙环境**：内置 [DefectingCat/nvim](https://github.com/DefectingCat/nvim) 配置、13 款核心插件（`clay.nvim`、`mini.nvim`、`nvim-treesitter`、`neogit`、`codediff.nvim`、`conform.nvim`、`gitsigns.nvim`、`grug-far.nvim` 等）以及 24 个 `riscv64` 原生编译的 Tree-sitter 解析器，构建期已完成 `vim.loader` 字节码预热。
- **二次启动零下载与 IndexedDB 持久化**：首次访问流式加载约 45 MiB 的压缩稀疏镜像（`nvim-data.kwsparse.gz`）；后续访问自动探测本地 IndexedDB Overlay 磁盘并跳过镜像下载（**0 B 网络传输**）。支持一键落盘同步、`.kwsparse.gz` 磁盘快照导入/导出与出厂重置。
- **本地目录直通挂载（9p over vsock）**：将浏览器 File System Access API（`showDirectoryPicker`）桥接为 `unkernel` 9p 文件系统，支持将宿主机本地项目目录直接挂载至 `/workspace/<name>` 进行实时读写。
- **WebGL2 终端与时间片流控**：采用 `@xterm/xterm` v6 + `@xterm/addon-webgl` 全屏渲染，深度适配 [clay.nvim](https://github.com/DefectingCat/clay.nvim) 暗色面板与 `Symbols Nerd Font Mono` 图标字体；内置 16 ms / 256 KiB 时间片 PTY 输出泵（基于 `MessageChannel`），确保高吞吐输出下键鼠输入依然零阻塞。

---

## 快速开始

仓库已预置构建好的稀疏磁盘镜像 `public/nvim-data.kwsparse.gz`，可直接启动开发服务器：

```bash
# 安装依赖
pnpm install

# 启动本地开发服务器 (默认开启 COOP/COEP SharedArrayBuffer 零延迟通道)
pnpm dev
```

浏览器访问 `http://localhost:5173` 即可进入全屏 Neovim 环境。

### 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` | 启动开发服务器（`http://localhost:5173`） |
| `pnpm build` | 执行 TypeScript 类型检查并构建生产产物至 `dist/` |
| `pnpm preview` | 预览生产环境构建产物（`http://localhost:4173`） |
| `pnpm prebake` | 重新构建 Alpine `riscv64` + Neovim 预烘焙磁盘镜像 |

> **提示**：执行 `pnpm prebake` 需要宿主机安装 **Node.js >= 24**（支持 `--experimental-wasm-jspi`）、`git`、`curl` 以及 **Zig**（用于通过 `zig cc` 将 `codediff.nvim` 的 `libvscode_diff.so` 与额外 Tree-sitter 解析器交叉编译至 `riscv64-linux-musl`）。

---

## 快捷键与控制中心

在终端内按下 **`⌘ + Shift + P`**（macOS）或 **`Ctrl + Shift + P`**（Windows / Linux），或点击右下角悬浮胶囊，即可呼出**控制中心**：

- **工作区与本地挂载**：挂载宿主机本地文件夹（Chromium 内核浏览器）、快速切换 `/workspace` 与 `~/.config/nvim`。
- **会话切换**：在 `Neovim` 与 `Alpine Shell (/bin/sh)` 之间无缝切换或重启会话。
- **显示调节**：实时调整 Canvas 终端字号（自动持久化至 `localStorage`）、隐藏/显示右下角胶囊按钮。
- **存储与备份**：手动触发 `sync` 落盘、导出当前系统与配置为 `.kwsparse.gz` 备份文件、导入已有备份或恢复出厂镜像。
- **网络与诊断**：查看 Worker 传输模式（`SharedArrayBuffer`）、WebGL2 状态、JIT 编译块数及磁盘占用，或配置可选的 Wisp WebSocket 代理以在虚拟机内联网。

### Neovim 常用快捷键（DefectingCat/nvim）

| 快捷键 | 功能 |
| :--- | :--- |
| `<Space>ff` | 查找文件 |
| `<Space>fg` | 全局文本搜索（Ripgrep） |
| `-` | 打开 `mini.files` 文件树浏览器 |
| `<Space>gg` | 打开 Neogit 面板 |
| `y` / `p` | 通过 OSC 52 与宿主机系统剪贴板无缝同步 |

---

## 目录结构

```text
unkernel-nvim/
├── index.html              # 全屏终端舞台、启动进度遮罩与控制中心容器
├── public/
│   ├── fonts/              # 预加载的 Symbols Nerd Font Mono 图标字体
│   └── nvim-data.kwsparse.gz # 预烘焙的 Alpine riscv64 + Neovim 稀疏磁盘镜像
├── scripts/
│   └── prebake.ts          # 构建期预烘焙脚本 (交叉编译 + 虚拟机无头预热 + 镜像导出)
├── src/
│   ├── main.ts             # 应用入口与生命周期编排
│   ├── vm-manager.ts       # WorkerKernel 管理、IndexedDB 零下载探测与快照导入导出
│   ├── terminal.ts         # WebGL2 终端封装、clay.nvim 配色与 16ms 时间片 PTY 输出泵
│   ├── fs-bridge.ts        # 浏览器 File System Access API 到 9p Fs 的读写桥接实现
│   ├── modal.ts            # 控制中心交互逻辑
│   └── style.css           # 极简暗色 UI 样式
└── vite.config.ts          # Vite 配置 (含 COOP/COEP 跨源隔离响应头)
```

---

## 许可证

MIT License
