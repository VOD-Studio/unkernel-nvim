# unkernel-nvim

基于 [unkernel](https://github.com/pithings/unkernel)（WebAssembly Linux 7.x 内核 + `aarch64` JIT）、[DefectingCat/nvim](https://github.com/DefectingCat/nvim) 与 **Bun 1.4** 原生后端构建的全屏浏览器端 Neovim 工作区。在浏览器本地运行 Debian 或 Alpine、Neovim 0.12、LSP 与 Tree-sitter 工具链，并提供自建 Wisp 联网后端。

---

## 核心特性

- **Debian 和 Alpine 用户态**：在 Web Worker 中运行编译为 WebAssembly 的 Linux 内核，执行 `aarch64` 版 `neovim`、`fish`、`git`、`ripgrep`、`fd`、`lua-language-server` 和 `stylua`。首次打开默认进入 Debian，两个发行版默认 Shell 均为 `fish`。
- **开箱即用的预烘焙环境**：内置 [DefectingCat/nvim](https://github.com/DefectingCat/nvim) 配置、13 款核心插件（`clay.nvim`、`mini.nvim`、`nvim-treesitter`、`neogit`、`codediff.nvim`、`conform.nvim`、`gitsigns.nvim`、`grug-far.nvim` 等）以及 24 个 `aarch64` 原生编译的 Tree-sitter 解析器，构建期已完成 `vim.loader` 字节码预热。
- **IndexedDB 持久化**：首次启动时同时编译 Wasm 内核、加载当前发行版的稀疏数据盘模板。后续启动若已存在持久化磁盘，会跳过模板下载。支持落盘同步、`.kwsparse.gz` 备份导入和导出，以及出厂重置。
- **自建 Bun Wisp 后端与公网纵深防御**：同源 `/wisp` 代理支持虚拟机内的 `curl`、`git`、Debian `apt`、Alpine `apk` 和 `:PackUpdate`。同时支持**单进程内置模式**与**网关 + 独立认证 Wisp 分离模式**（仅服务端持有 `WISP_AUTH_TOKEN`）。
- **本地目录直通挂载（9p over vsock）**：将浏览器 File System Access API（`showDirectoryPicker`）桥接为 `unkernel` 9p 文件系统，支持将宿主机本地项目目录直接挂载至 `/workspace/<name>` 进行实时读写。
- **WebGL2 终端与时间片流控**：采用 `@xterm/xterm` v6 + `@xterm/addon-webgl` 全屏渲染，深度适配 [clay.nvim](https://github.com/DefectingCat/clay.nvim) 暗色面板与 `Symbols Nerd Font Mono` 图标字体；内置 16 ms / 256 KiB 时间片 PTY 输出泵（基于 `MessageChannel`），确保高吞吐输出下键鼠输入依然零阻塞。

---

## 快速开始（本地开发）

安装 **Bun >= 1.4** 后，先生成发行版和 Neovim 数据盘，再启动开发服务器。

```bash
# 安装依赖
bun install
bun run prebake

# 启动本地开发服务器 (内置同源 /wisp 代理 + COOP/COEP SharedArrayBuffer 零延迟通道)
bun run dev
```

浏览器访问 `http://localhost:5173` 即可进入全屏 Neovim 环境，默认自动通过同源 `/wisp` 联网。

### 切换发行版

打开控制中心的 **虚拟机与诊断 → Linux 发行版**，选择 Debian 或 Alpine，再点击 **同步并重启**。当前浏览器会记住选择。两种发行版各有自己的数据盘，原有 Alpine `v2` 磁盘可以在切回 Alpine 后继续使用。本地目录可分别挂载到两个发行版。

### 虚拟机多核

打开控制中心的 **虚拟机与诊断**，选择 **虚拟 CPU 核数**，再点击 **同步并重启**。设置保存在当前浏览器，诊断面板会显示实际在线的核数。默认使用 1 核，可选上限为浏览器报告的逻辑处理器数量，最多 16 核。

多核（SMP）为实验功能，需要跨源隔离和 `Atomics.waitAsync`。项目已设置 COOP / COEP 响应头，请通过 HTTPS 或 `localhost` 访问。多核模式暂不支持内存快照，文件可通过存储面板同步至 IndexedDB 或导出磁盘备份。

### 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `bun run dev` | 启动 Vite 开发服务器（`http://localhost:5173`，内置 `/wisp` 隧道） |
| `bun run build` | 执行 TypeScript 类型检查并构建前端产物至 `dist/` |
| `bun run preview` | 预览生产环境构建产物（`http://localhost:4173`，内置 `/wisp` 隧道） |
| `bun run start` | 启动 Bun 生产一体化服务器（托管 `dist/` + `/wisp` 内置引擎或认证网关） |
| `bun run wisp` | 启动独立认证 Wisp 服务（默认强制校验 `WISP_AUTH_TOKEN`） |
| `bun test` | 运行安全原语、网关认证、SSRF 防护与 Wisp 端到端测试 |
| `bun run prebake [debian\|alpine]` | 在 `public/` 生成两个发行版的镜像和数据盘。指定发行版时只生成该发行版 |

> 预烘焙需要宿主机安装 **Bun >= 1.4**、`git`、`curl`、`tar`、`unzip` 和 **Zig**。Debian 的原生插件和解析器面向 glibc 编译，Alpine 使用 musl。

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
bun install --frozen-lockfile
bun run prebake
docker compose up -d --build
```

也可以从 GHCR 拉取已发布的镜像。将 `.env` 中的 `UNKERNEL_NVIM_IMAGE` 设为发布说明中提供的完整版本或摘要，例如 `ghcr.io/vod-studio/unkernel-nvim:0.1.0`。两个服务都使用这个镜像，部署机只需 Docker Compose。 [GitHub Releases](https://github.com/VOD-Studio/unkernel-nvim/releases)

```bash
docker compose pull
docker compose up -d --no-build --pull never
```

反向代理可以把应用挂载在 `/unkernel-nvim/` 一类的子路径，入口 URL 以 `/` 结尾。代理应去掉路径前缀后转发到 Bun，并允许同一路径下的 Wisp WebSocket 升级。`deploy/rua/` 提供 `projects.rua.plus` 使用的 Podman Compose 补充配置和 systemd 单元。虚拟机文件由构建放在 `releases/v<版本号>/`，可按版本在 CDN 缓存。

### 部署方式 B：单进程一体化部署（简单轻量）

如果不拆分独立 Wisp 进程，留空 `WISP_UPSTREAM_URL` 即可在同一 Bun 进程内运行静态站点与 Wisp 引擎：

```bash
bun install
bun run prebake
bun run build
NODE_ENV=production TRUST_PROXY=true PORT=3000 bun run start
```

### 版本与发布

`package.json` 保存项目版本号。`0.x` 阶段的兼容性修复升补丁版本，新增功能或破坏性变更升次版本。涉及环境变量、Compose 配置或磁盘备份格式的变更，应在发布说明中附上迁移步骤。

PR 和 `main` 上的提交会运行 `Test and build` 检查。首次运行后，在仓库规则中将它设为 `main` 的必需状态检查，并限制 `v*` 标签的更新和删除。发布时先确认目标提交已在 `main` 上通过 CI，再推送与 `package.json` 一致的版本标签。首次发布使用 `v0.1.0`。

```bash
git fetch origin main
git tag -a v0.1.0 origin/main -m "Release v0.1.0"
git push origin refs/tags/v0.1.0
```

发布工作流会预烘焙 Debian 和 Alpine，构建 `linux/amd64` 镜像，用 Compose 验证两个服务和四个虚拟机资源，再推送镜像并创建 GitHub Release。Release 会记录镜像摘要以便部署和回滚。首次推送后，将 GHCR 包设为公开即可匿名拉取。同一版本的工作流可重跑，已推送的镜像会按摘要复用。需要修复已发布版本时，发布新版本。

### 关键环境变量（完整列表见 `.env.example`）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `UNKERNEL_NVIM_IMAGE` | *(空)* | Compose 使用的发布镜像，支持完整版本标签和摘要 |
| `NODE_ENV` | `development` | 设为 `production` 时默认启用 Neovim 和发行版软件源的公网域名白名单 |
| `PORT` / `WISP_PORT` | `3000` / `6680` | 应用服务器端口 / 独立 Wisp 服务端口 |
| `TRUST_PROXY` | `false` | 位于 Nginx / Caddy / Cloudflare 后时设为 `true` |
| `WISP_UPSTREAM_URL` | *(空)* | 填入独立 Wisp 地址（如 `ws://wisp:6680/wisp`）即启用网关认证转发模式 |
| `WISP_AUTH_TOKEN` | *(空)* | **仅服务端持有**的 Bearer 认证密钥；独立运行 `bun run wisp` 时强制要求 |
| `SESSION_SECRET` | *(启动随机)* | 无感短效 `HttpOnly` 会话 Cookie 的 HMAC 签名密钥 |
| `WISP_ALLOWED_ORIGINS` | *(同源)* | 逗号分隔的额外允许 Origin 白名单 |
| `WISP_ALLOWED_HOSTS` | 生产白名单 / 开发 `*` | 出口目标域名白名单，支持 `*.githubusercontent.com` 通配符或 `*` |
| `WISP_ALLOWED_PORTS` | `80,443` | 出口目标端口白名单（设为 `*` 仍默认屏蔽 `25/465/587` 邮件端口） |
| `WISP_ALLOW_PRIVATE` | `false` | 是否允许访问内网/回环/云元数据 IP（**公网务必保持 `false`**） |
| `WISP_OUTBOUND_PROXY` | *(自动读取环境代理)* | 可选：显式指定上游 HTTP CONNECT 代理（如 `http://127.0.0.1:7890`）；留空时默认读取 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`（仅 `http/https`）与 `NO_PROXY` |
| `WISP_USE_ENV_PROXY` | `true` | 是否允许从环境变量自动读取代理与 `NO_PROXY`；设为 `false` 可强制直连 |
| `WISP_NO_PROXY` | *(读取 `NO_PROXY`)* | 逗号分隔的直连目标列表，匹配后绕过上游代理 |

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

在终端内按下 **`⌘ + Shift + P`**（macOS）或 **`Ctrl + Shift + P`**（Windows / Linux），或点击右上角悬浮胶囊，即可打开**控制中心**。焦点在标签栏时可用左右方向键切换标签页，按 `Esc` 返回终端。

- **工作区与会话**：在 Chromium 浏览器中挂载本地文件夹，打开 `/workspace` 或 `~/.config/nvim`，切换或重启 Neovim 和当前发行版的 Shell，也可调整终端字号和悬浮快捷入口。
- **存储与备份**：手动同步磁盘，导入或导出 `.kwsparse.gz` 备份，或确认后恢复出厂镜像。
- **虚拟机与诊断**：切换发行版、调整核数、内存配额和 Wisp 网络，查看实际在线核数、Worker 传输模式、WebGL2 和 JIT。内存支持自动、预设档位、自定义 `128–4096 MiB` 和临时 URL 参数 `?mem=2G`。配置变更后可点击「同步并重启」应用。

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
│   ├── debian.erofs         # Debian aarch64 只读根镜像，由 prebake 生成
│   ├── alpine.erofs         # Alpine aarch64 只读根镜像，由 prebake 生成
│   ├── nvim-data-debian.kwsparse.gz # Debian 的 Neovim 数据盘模板
│   └── nvim-data.kwsparse.gz        # Alpine 的 Neovim 数据盘模板
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
│   ├── distro.ts            # 发行版与磁盘配置
│   ├── memory-config.ts     # 虚拟机内存配额解析、校验与阶梯回退策略
│   ├── vm-manager.ts        # WorkerKernel 管理、IndexedDB 零下载探测、内存与网络配置
│   ├── terminal.ts          # WebGL2 终端封装、clay.nvim 配色与 16ms 时间片 PTY 输出泵
│   ├── fs-bridge.ts         # 浏览器 File System Access API 到 9p Fs 的读写桥接实现
│   ├── modal.ts             # 控制中心交互逻辑
│   └── style.css            # 极简暗色 UI 样式
└── vite.config.ts           # Vite 配置 (COOP/COEP 响应头 + 开发期同源 /wisp 隧道插件)
```

---

## 许可证

MIT License
