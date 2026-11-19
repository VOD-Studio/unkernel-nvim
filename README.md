# unkernel-nvim

基于 [unkernel](https://github.com/pithings/unkernel)（WebAssembly Linux 7.x 内核 + Alpine `riscv64` JIT）、[DefectingCat/nvim](https://github.com/DefectingCat/nvim) 与 **Bun 1.4** 原生后端构建的全屏浏览器端 Neovim 工作区。在浏览器本地运行完整的 Linux 用户态、原生 Neovim 0.12、LSP 与 Tree-sitter 工具链，并内置零外部依赖的自建 Wisp 联网后端与公网免登录安全防护。

---

## 核心特性

- **真实 Linux 内核与原生用户态**：基于 `unkernel` 在 Web Worker 中运行编译为 WebAssembly 的 Linux 内核，直接执行未经修改的 Alpine Linux 3.24 `riscv64` 二进制程序（`neovim`、`git`、`ripgrep`、`fd`、`lua-language-server`、`stylua`）。
- **开箱即用的预烘焙环境**：内置 [DefectingCat/nvim](https://github.com/DefectingCat/nvim) 配置、13 款核心插件（`clay.nvim`、`mini.nvim`、`nvim-treesitter`、`neogit`、`codediff.nvim`、`conform.nvim`、`gitsigns.nvim`、`grug-far.nvim` 等）以及 24 个 `riscv64` 原生编译的 Tree-sitter 解析器，构建期已完成 `vim.loader` 字节码预热。
- **二次启动零下载与 IndexedDB 持久化**：首次访问流式加载约 45 MiB 的压缩稀疏镜像（`nvim-data.kwsparse.gz`）；后续访问自动探测本地 IndexedDB Overlay 磁盘并跳过镜像下载（**0 B 网络传输**）。支持一键落盘同步、`.kwsparse.gz` 磁盘快照导入/导出与出厂重置。
- **自建 Bun Wisp 后端与公网纵深防御**：基于 Bun 原生 `Bun.serve({ websocket })` 提供同源 `/wisp` 代理，无需前端登录即可在虚拟机内使用 `curl`、`git`、`apk` 和 `:PackUpdate`。同时支持**单进程内置模式**与**网关 + 独立认证 Wisp 分离模式**（仅服务端持有的 `WISP_AUTH_TOKEN` 环境变量认证）。
- **本地目录直通挂载（9p over vsock）**：将浏览器 File System Access API（`showDirectoryPicker`）桥接为 `unkernel` 9p 文件系统，支持将宿主机本地项目目录直接挂载至 `/workspace/<name>` 进行实时读写。
- **WebGL2 终端与时间片流控**：采用 `@xterm/xterm` v6 + `@xterm/addon-webgl` 全屏渲染，深度适配 [clay.nvim](https://github.com/DefectingCat/clay.nvim) 暗色面板与 `Symbols Nerd Font Mono` 图标字体；内置 16 ms / 256 KiB 时间片 PTY 输出泵（基于 `MessageChannel`），确保高吞吐输出下键鼠输入依然零阻塞。

---

## 快速开始（本地开发）

仓库已预置构建好的稀疏磁盘镜像 `public/nvim-data.kwsparse.gz`，安装 **Bun >= 1.4** 后可直接启动：

```bash
# 安装依赖
bun install

# 启动本地开发服务器 (内置同源 /wisp 代理 + COOP/COEP SharedArrayBuffer 零延迟通道)
bun run dev
```

浏览器访问 `http://localhost:5173` 即可进入全屏 Neovim 环境，默认自动通过同源 `/wisp` 联网。

### 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `bun run dev` | 启动 Vite 开发服务器（`http://localhost:5173`，内置 `/wisp` 隧道） |
| `bun run build` | 执行 TypeScript 类型检查并构建前端产物至 `dist/` |
| `bun run preview` | 预览生产环境构建产物（`http://localhost:4173`，内置 `/wisp` 隧道） |
| `bun run start` | 启动 Bun 生产一体化服务器（托管 `dist/` + `/wisp` 内置引擎或认证网关） |
| `bun run wisp` | 启动独立认证 Wisp 服务（默认强制校验 `WISP_AUTH_TOKEN`） |
| `bun test` | 运行安全原语、网关认证、SSRF 防护与 Wisp 端到端测试 |
| `bun run prebake` | 重新构建 Alpine `riscv64` + Neovim 预烘焙磁盘镜像 |

> **提示**：执行 `bun run prebake` 需要宿主机安装 **Bun >= 1.4**（内置 WebAssembly JSPI 支持）、`git`、`curl` 以及 **Zig**（用于通过 `zig cc` 将 `codediff.nvim` 的 `libvscode_diff.so` 与额外 Tree-sitter 解析器交叉编译至 `riscv64-linux-musl`）。

---

## 公网部署与自建 Wisp 安全架构（无需登录）

前端代码**不包含任何密钥**。公网免登录场景采用分层纵深防御：

```text
[公网浏览器 (无登录)]
   │  1) 访问 / 自动获发短效 HttpOnly; SameSite=Strict HMAC 会话 Cookie
   │  2) 连接 wss://<域名>/wisp（自动校验 Origin + Cookie + 按 IP 速率/并发限流）
   ▼
[应用服务器 server/index.ts (对外端口)]
   │  3) 仅从服务端环境变量读取 WISP_AUTH_TOKEN，注入 Authorization: Bearer <token>
   ▼  (Docker 内部网络 / 私网，不暴露公网端口)
[独立 Wisp 服务 server/wisp-server.ts]
   │  4) 恒定时间校验 Bearer Token
   │  5) 域名白名单 + 端口白名单 + 反 SSRF (DNS 解析全记录校验，直连已校验 IP 防 DNS Rebinding)
   ▼
[公网目标 (GitHub / Alpine 镜像源等)]
```

### 部署方式 A：Docker Compose 双服务隔离部署（推荐公网使用）

`wisp` 容器仅监听在 Docker 内部隔离网络（不映射宿主机端口），且强制校验服务端 `WISP_AUTH_TOKEN`：

```bash
# 1. 生成配置并填入强密钥
cp .env.example .env
# 编辑 .env，将 WISP_AUTH_TOKEN 替换为 `openssl rand -hex 32` 生成的随机值

# 2. 启动独立认证 Wisp + 应用网关服务 (默认监听 127.0.0.1:3000)
docker compose up -d --build
```

### 部署方式 B：单进程一体化部署（简单轻量）

如果不拆分独立 Wisp 进程，留空 `WISP_UPSTREAM_URL` 即可在同一 Bun 进程内运行静态站点与 Wisp 引擎：

```bash
bun install
bun run build
NODE_ENV=production TRUST_PROXY=true PORT=3000 bun run start
```

### 关键环境变量（完整列表见 `.env.example`）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | 设为 `production` 时默认开启面向 Neovim/Alpine 的公网安全域名白名单 |
| `PORT` / `WISP_PORT` | `3000` / `6680` | 应用服务器端口 / 独立 Wisp 服务端口 |
| `TRUST_PROXY` | `false` | 位于 Nginx / Caddy / Cloudflare 后时设为 `true` |
| `WISP_UPSTREAM_URL` | *(空)* | 填入独立 Wisp 地址（如 `ws://wisp:6680/wisp`）即启用网关认证转发模式 |
| `WISP_AUTH_TOKEN` | *(空)* | **仅服务端持有**的 Bearer 认证密钥；独立运行 `bun run wisp` 时强制要求 |
| `SESSION_SECRET` | *(启动随机)* | 无感短效 `HttpOnly` 会话 Cookie 的 HMAC 签名密钥 |
| `WISP_ALLOWED_ORIGINS` | *(同源)* | 逗号分隔的额外允许 Origin 白名单 |
| `WISP_ALLOWED_HOSTS` | 生产白名单 / 开发 `*` | 出口目标域名白名单，支持 `*.githubusercontent.com` 通配符或 `*` |
| `WISP_ALLOWED_PORTS` | `80,443` | 出口目标端口白名单（设为 `*` 仍默认屏蔽 `25/465/587` 邮件端口） |
| `WISP_ALLOW_PRIVATE` | `false` | 是否允许访问内网/回环/云元数据 IP（**公网务必保持 `false`**） |
| `WISP_OUTBOUND_PROXY` | *(空)* | 可选：服务器出网需走上游 HTTP CONNECT 代理时填入（如 `http://127.0.0.1:7890`） |

### HTTPS 反向代理示例（必须 HTTPS 以启用 SharedArrayBuffer 与本地目录挂载）

**Caddy**（自动申请 HTTPS 证书并原生透传 WebSocket）：
```caddyfile
nvim.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**：
```nginx
server {
    listen 443 ssl http2;
    server_name nvim.example.com;

    location /wisp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## 快捷键与控制中心

在终端内按下 **`⌘ + Shift + P`**（macOS）或 **`Ctrl + Shift + P`**（Windows / Linux），或点击右上角悬浮胶囊，即可呼出**控制中心**：

- **工作区与本地挂载**：挂载宿主机本地文件夹（Chromium 内核浏览器）、快速切换 `/workspace` 与 `~/.config/nvim`。
- **会话切换**：在 `Neovim` 与 `Alpine Shell (/bin/sh)` 之间无缝切换或重启会话。
- **显示调节**：实时调整 Canvas 终端字号（自动持久化至 `localStorage`）、隐藏/显示悬浮胶囊按钮。
- **存储与备份**：手动触发 `sync` 落盘、导出当前系统与配置为 `.kwsparse.gz` 备份文件、导入已有备份或恢复出厂镜像。
- **网络与诊断**：查看 Worker 传输模式（`SharedArrayBuffer`）、WebGL2 状态、JIT 编译块数及磁盘占用，并在**内置同源代理 (`/wisp`)**、**自定义 Wisp 地址**与**离线模式**之间一键切换。

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
├── index.html               # 全屏终端舞台、启动进度遮罩与控制中心容器
├── .env.example             # 服务端环境变量配置模板
├── Dockerfile               # Bun 1.4.4 生产镜像（同时支持应用服务与独立 Wisp 服务）
├── docker-compose.yml       # 公网推荐双服务编排（应用网关 + 内部网络认证 Wisp）
├── public/
│   ├── fonts/               # 预加载的 Symbols Nerd Font Mono 图标字体
│   └── nvim-data.kwsparse.gz # 预烘焙的 Alpine riscv64 + Neovim 稀疏磁盘镜像
├── server/
│   ├── config.ts            # 环境变量解析与安全默认策略
│   ├── security.ts          # Bearer Token 校验、无感 HMAC Cookie、Origin、反 SSRF、限流
│   ├── wisp-core.ts         # Bun 原生 Wisp v1 协议引擎（0-RTT 缓冲 + 双向背压 + 出口代理）
│   ├── wisp-gateway.ts      # 认证网关转发器（服务端自动注入 Bearer WISP_AUTH_TOKEN）
│   ├── wisp-server.ts       # 独立认证 Wisp 服务入口 (`bun run wisp`)
│   ├── index.ts             # 生产一体化服务器入口 (`bun run start`)
│   └── wisp.test.ts         # 安全原语与端到端集成测试 (`bun test`)
├── scripts/
│   └── prebake.ts           # 构建期预烘焙脚本 (交叉编译 + 虚拟机无头预热 + 镜像导出)
├── src/
│   ├── main.ts              # 应用入口与生命周期编排
│   ├── vm-manager.ts        # WorkerKernel 管理、IndexedDB 零下载探测与网络模式配置
│   ├── terminal.ts          # WebGL2 终端封装、clay.nvim 配色与 16ms 时间片 PTY 输出泵
│   ├── fs-bridge.ts         # 浏览器 File System Access API 到 9p Fs 的读写桥接实现
│   ├── modal.ts             # 控制中心交互逻辑
│   └── style.css            # 极简暗色 UI 样式
└── vite.config.ts           # Vite 配置 (COOP/COEP 响应头 + 开发期同源 /wisp 隧道插件)
```

---

## 许可证

MIT License
