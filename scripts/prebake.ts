// SPDX-License-Identifier: MIT
// Build the Debian and Alpine aarch64 Neovim images using Bun's WebAssembly JSPI.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  bundledBoot,
  bundledKernelUrl,
  CowDisk,
  createKernel,
  fetchDistro,
  gzipBlob,
  nodeFs,
  readKwsparse,
  SparseBase,
} from "unkernel/node";
import { DISTROS, isDistro, type Distro } from "../src/distro.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

interface PluginSpec {
  name: string;
  url: string;
  branch?: string;
}

const PLUGINS: readonly PluginSpec[] = [
  { name: "clay.nvim", url: "https://github.com/DefectingCat/clay.nvim" },
  { name: "mini.nvim", url: "https://github.com/nvim-mini/mini.nvim" },
  { name: "friendly-snippets", url: "https://github.com/rafamadriz/friendly-snippets" },
  { name: "nvim-treesitter", url: "https://github.com/nvim-treesitter/nvim-treesitter", branch: "main" },
  { name: "nvim-lspconfig", url: "https://github.com/neovim/nvim-lspconfig" },
  { name: "mason.nvim", url: "https://github.com/mason-org/mason.nvim" },
  { name: "conform.nvim", url: "https://github.com/stevearc/conform.nvim" },
  { name: "gitsigns.nvim", url: "https://github.com/lewis6991/gitsigns.nvim" },
  { name: "plenary.nvim", url: "https://github.com/nvim-lua/plenary.nvim" },
  { name: "neogit", url: "https://github.com/NeogitOrg/neogit" },
  { name: "codediff.nvim", url: "https://github.com/esmuellert/codediff.nvim" },
  { name: "grug-far.nvim", url: "https://github.com/MagicDuck/grug-far.nvim" },
  { name: "md-render.nvim", url: "https://github.com/delphinus/md-render.nvim" },
];

interface ParserSpec {
  lang: string;
  url: string;
  rev: string;
  location?: string;
}

// The 9 parsers in DefectingCat/nvim's ensure_installed that are not in Alpine v3.24 apk.
const EXTRA_PARSERS: readonly ParserSpec[] = [
  { lang: "gosum", url: "https://github.com/tree-sitter-grammars/tree-sitter-go-sum", rev: "27816eb6b7315746ae9fcf711e4e1396dc1cf237" },
  { lang: "gowork", url: "https://github.com/omertuc/tree-sitter-go-work", rev: "949a8a470559543857a62102c84700d291fc984c" },
  { lang: "dockerfile", url: "https://github.com/camdencheek/tree-sitter-dockerfile", rev: "971acdd908568b4531b0ba28a445bf0bb720aba5" },
  { lang: "make", url: "https://github.com/tree-sitter-grammars/tree-sitter-make", rev: "70613f3d812cbabbd7f38d104d60a409c4008b43" },
  { lang: "git_config", url: "https://github.com/the-mikedavis/tree-sitter-git-config", rev: "3a61756a81a86291a0f48e3eeeaa0692b9981aa9" },
  { lang: "git_rebase", url: "https://github.com/the-mikedavis/tree-sitter-git-rebase", rev: "32686d6b72980b36f876ae2d07719c9c3ed154e2" },
  { lang: "gitattributes", url: "https://github.com/tree-sitter-grammars/tree-sitter-gitattributes", rev: "1b7af09d45b579f9f288453b95ad555f1f431645" },
  { lang: "gitcommit", url: "https://github.com/gbprod/tree-sitter-gitcommit", rev: "55a265cf763ec15d6e2d96bb206e3f5e30d82bae" },
  { lang: "gitignore", url: "https://github.com/shunsambongi/tree-sitter-gitignore", rev: "f4685bf11ac466dd278449bcfe5fd014e94aa504" },
];

const DEBIAN_PARSERS: readonly ParserSpec[] = [
  { lang: "javascript", url: "https://github.com/tree-sitter/tree-sitter-javascript", rev: "58404d8cf191d69f2674a8fd507bd5776f46cb11" },
  { lang: "typescript", url: "https://github.com/tree-sitter/tree-sitter-typescript", rev: "75b3874edb2dc714fb1fd77a32013d0f8699989f", location: "typescript" },
  { lang: "tsx", url: "https://github.com/tree-sitter/tree-sitter-typescript", rev: "75b3874edb2dc714fb1fd77a32013d0f8699989f", location: "tsx" },
  { lang: "jsdoc", url: "https://github.com/tree-sitter/tree-sitter-jsdoc", rev: "658d18dcdddb75c760363faa4963427a7c6b52db" },
  { lang: "json", url: "https://github.com/tree-sitter/tree-sitter-json", rev: "254c42a6476413b776221e03982ac8ae159eeb72" },
  { lang: "html", url: "https://github.com/tree-sitter/tree-sitter-html", rev: "73a3947324f6efddf9e17c0ea58d454843590cc0" },
  { lang: "css", url: "https://github.com/tree-sitter/tree-sitter-css", rev: "dda5cfc5722c429eaba1c910ca32c2c0c5bb1a3f" },
  { lang: "yaml", url: "https://github.com/tree-sitter-grammars/tree-sitter-yaml", rev: "a1c4812a73ec5e089de8e441fdea3a921e8d5079" },
  { lang: "kotlin", url: "https://github.com/fwcd/tree-sitter-kotlin", rev: "d6af96d2e23ef0a8ff5ab512864378cf08fba311" },
  { lang: "rust", url: "https://github.com/tree-sitter/tree-sitter-rust", rev: "77a3747266f4d621d0757825e6b11edcbf991ca5" },
  { lang: "toml", url: "https://github.com/tree-sitter-grammars/tree-sitter-toml", rev: "64b56832c2cffe41758f28e05c756a3a98d16f41" },
  { lang: "go", url: "https://github.com/tree-sitter/tree-sitter-go", rev: "2346a3ab1bb3857b48b29d779a1ef9799a248cd7" },
  { lang: "gomod", url: "https://github.com/camdencheek/tree-sitter-go-mod", rev: "2e886870578eeba1927a2dc4bd2e2b3f598c5f9a" },
  { lang: "markdown", url: "https://github.com/tree-sitter-grammars/tree-sitter-markdown", rev: "41ff24a6c775492c543b09228aeb98d1cd2b3a0f", location: "tree-sitter-markdown" },
  { lang: "markdown_inline", url: "https://github.com/tree-sitter-grammars/tree-sitter-markdown", rev: "41ff24a6c775492c543b09228aeb98d1cd2b3a0f", location: "tree-sitter-markdown-inline" },
  ...EXTRA_PARSERS,
];

function log(step: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${step}] ${msg}`);
}

function packageProxyConfig(): { env: Record<string, string>; hostLoopback: boolean } {
  const env: Record<string, string> = {};
  let hostLoopback = false;
  for (const key of ["http_proxy", "https_proxy", "no_proxy"]) {
    const value = process.env[key] ?? process.env[key.toUpperCase()];
    if (!value) continue;
    env[key] = value;
    if (key === "no_proxy") continue;

    const proxy = new URL(value.includes("://") ? value : `http://${value}`);
    if (proxy.hostname === "localhost" || proxy.hostname === "127.0.0.1") {
      proxy.hostname = "10.0.2.2";
      env[key] = proxy.href;
      hostLoopback = true;
    }
  }
  return { env, hostLoopback };
}

async function prepareHostAssets(stageDir: string): Promise<void> {
  const nvimCfgDir = path.join(stageDir, "nvim-config");
  const packDir = path.join(stageDir, "pack");
  mkdirSync(packDir, { recursive: true });

  log("host", "Cloning DefectingCat/nvim and 13 plugins in parallel...");
  await Promise.all([
    execFileAsync("git", ["clone", "--depth", "1", "https://github.com/DefectingCat/nvim.git", nvimCfgDir]),
    ...PLUGINS.map(async (p) => {
      const dst = path.join(packDir, p.name);
      const args = ["clone", "--depth", "1"];
      if (p.branch) args.push("--branch", p.branch);
      args.push(p.url, dst);
      await execFileAsync("git", args);
    }),
  ]);
}

async function prepareCodeDiff(stageDir: string, distro: Distro): Promise<void> {
  const target = distro === "debian" ? "aarch64-linux-gnu" : "aarch64-linux-musl";
  const codediffDir = path.join(stageDir, "pack", "codediff.nvim");
  const vsdiffDir = path.join(codediffDir, "libvscode-diff");
  if (existsSync(vsdiffDir)) {
    log("host", `Cross-compiling codediff.nvim libvscode_diff.so (${target})...`);
    const verFile = path.join(codediffDir, "VERSION");
    const version = existsSync(verFile) ? readFileSync(verFile, "utf8").trim() : "0.1.0";
    const verHeaderIn = readFileSync(path.join(vsdiffDir, "include", "version.h.in"), "utf8");
    mkdirSync(path.join(vsdiffDir, "build", "include"), { recursive: true });
    writeFileSync(
      path.join(vsdiffDir, "build", "include", "version.h"),
      verHeaderIn.replace(/@PROJECT_VERSION@/g, version),
    );
    const sources = [
      "default_lines_diff_computer.c",
      "src/char_level.c",
      "src/line_level.c",
      "src/myers.c",
      "src/optimize.c",
      "src/sequence.c",
      "src/range_mapping.c",
      "src/string_hash_map.c",
      "src/utils.c",
      "src/print_utils.c",
      "src/utf8_utils.c",
      "src/compute_moved_lines.c",
      "vendor/utf8proc.c",
    ];
    const outDir = path.join(stageDir, distro, "codediff");
    mkdirSync(outDir, { recursive: true });
    const soOut = path.join(outDir, "libvscode_diff.so");
    await execFileAsync(
      "zig",
      [
        "cc",
        "-target",
        target,
        "-std=c11",
        "-O2",
        "-DNDEBUG",
        "-DUTF8PROC_STATIC",
        "-D_POSIX_C_SOURCE=199309L",
        "-Iinclude",
        "-Ibuild/include",
        "-Ivendor",
        "-fPIC",
        "-shared",
        "-s",
        "-lm",
        "-o",
        soOut,
        ...sources,
      ],
      { cwd: vsdiffDir },
    );
    copyFileSync(soOut, path.join(outDir, `libvscode_diff_${version}.so`));
  }
}

async function prepareCodeDiffWatcher(stageDir: string): Promise<void> {
  const watcherInstaller = path.join(
    stageDir,
    "pack",
    "codediff.nvim",
    "lua",
    "codediff",
    "core",
    "installer",
    "watcher.lua",
  );
  if (!existsSync(watcherInstaller)) return;

  const src = readFileSync(watcherInstaller, "utf8");
  const versionMatch = src.match(/local\s+VERSION\s*=\s*"([^"]+)"/);
  if (!versionMatch?.[1]) {
    throw new Error(`Could not parse codediff-watcher VERSION from ${watcherInstaller}`);
  }
  const version = versionMatch[1];
  const baseUrl = `https://github.com/esmuellert/codediff/releases/download/v${version}`;
  const archiveName = `codediff-watcher-${version}-linux-arm64.tar.gz`;

  log("host", `Downloading codediff-watcher v${version} (linux-arm64)...`);
  const { stdout: sums } = await execFileAsync("curl", [
    "-fsSL",
    "--retry",
    "3",
    "--retry-all-errors",
    "--connect-timeout",
    "15",
    "--max-time",
    "60",
    `${baseUrl}/SHA256SUMS`,
  ]);
  const sumLine = sums
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${archiveName}`));
  const sha256 = sumLine?.trim().split(/\s+/)[0];
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error(`Could not find SHA-256 checksum for ${archiveName} in ${baseUrl}/SHA256SUMS`);
  }

  const outDir = path.join(stageDir, "codediff-watcher");
  await downloadArchive(`${baseUrl}/${archiveName}`, outDir, 0, sha256.toLowerCase());
  const extracted = path.join(outDir, "codediff-watcher");
  if (!existsSync(extracted)) {
    throw new Error(`Expected ${extracted} after extracting ${archiveName}`);
  }
  renameSync(extracted, path.join(outDir, `codediff-watcher_${version}`));
}

async function prepareParsers(stageDir: string, distros: Distro[]): Promise<void> {
  const parserSrcDir = path.join(stageDir, "parser-src");
  mkdirSync(parserSrcDir);
  const sources = new Map<string, Promise<string>>();
  await Promise.all(distros.flatMap((distro) => {
    const target = distro === "debian" ? "aarch64-linux-gnu" : "aarch64-linux-musl";
    const parsers = distro === "debian" ? DEBIAN_PARSERS : EXTRA_PARSERS;
    const parsersDir = path.join(stageDir, distro, "parsers");
    mkdirSync(parsersDir, { recursive: true });
    return parsers.map(async ({ lang, url, rev, location }) => {
      const tarUrl = `${url.replace("https://github.com/", "https://codeload.github.com/")}/tar.gz/${rev}`;
      let source = sources.get(tarUrl);
      if (!source) {
        const dir = mkdtempSync(path.join(parserSrcDir, "source-"));
        source = downloadArchive(tarUrl, dir, 1).then(() => dir);
        sources.set(tarUrl, source);
      }
      const srcDir = path.join(await source, location ?? "", "src");
      const files = [path.join(srcDir, "parser.c")];
      if (existsSync(path.join(srcDir, "scanner.c"))) {
        files.push(path.join(srcDir, "scanner.c"));
      }
      const outSo = path.join(parsersDir, `${lang}.so`);
      await execFileAsync("zig", [
        "cc",
        "-target",
        target,
        "-O2",
        "-shared",
        "-fPIC",
        "-s",
        `-I${srcDir}`,
        "-o",
        outSo,
        ...files,
      ]);
    });
  }));
}

async function downloadArchive(url: string, dir: string, strip = 0, sha256?: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, ".download");
  await execFileAsync("curl", [
    "-fsSL", "--retry", "3", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "120", "-o", archive, url,
  ]);
  if (sha256 && createHash("sha256").update(readFileSync(archive)).digest("hex") !== sha256) {
    throw new Error(`Checksum mismatch for ${url}`);
  }
  if (url.endsWith(".zip")) {
    await execFileAsync("unzip", ["-qo", archive, "-d", dir]);
  } else {
    await execFileAsync("tar", ["-xzf", archive, `--strip-components=${strip}`, "-C", dir]);
  }
  rmSync(archive);
}

async function prepareDebianTools(stageDir: string): Promise<void> {
  const dir = path.join(stageDir, "debian");
  await Promise.all([
    downloadArchive("https://github.com/neovim/neovim/releases/download/v0.12.2/nvim-linux-arm64.tar.gz",
      path.join(dir, "neovim"), 1, "f697d4e4582b6e4b5c3c26e76e06ce26efa08ba1768e03fd2733fcc422bb0490"),
    downloadArchive("https://github.com/LuaLS/lua-language-server/releases/download/3.19.2/lua-language-server-3.19.2-linux-arm64.tar.gz",
      path.join(dir, "lua-language-server"), 0, "17b8e401a874440adeb649e5024c364f2bb9d15156c74a40e56d1ae9a1b2e4f2"),
    downloadArchive("https://github.com/JohnnyMorganz/StyLua/releases/download/v2.6.0/stylua-linux-aarch64.zip",
      path.join(dir, "stylua"), 0, "8e67539e5fdf7a81cd03cf592b0df18d3bb96ee17a5ea5d9bf67b86387b903b0"),
  ]);
}

async function bakeDistro(stageDir: string, distro: Distro, distroPath: string, module: WebAssembly.Module): Promise<void> {
  const t0 = performance.now();
  const { label, image, template } = DISTROS[distro];
  const outFile = path.join(PUBLIC, path.basename(template));
  const imageFile = path.join(PUBLIC, path.basename(image));
  const alpine = distro === "alpine";
  const bootInfo = bundledBoot(module);
  if (!bootInfo.datadisk) {
    throw new Error("Bundled kernel has no unkernel.datadisk section");
  }

  const base = SparseBase.fromKwsparse(await readKwsparse(bootInfo.datadisk));
  const disk = new CowDisk(base);
  const proxy = packageProxyConfig();
  log("vm", `Booting ${label} aarch64 VM...`);
  const vm = await createKernel({
    kernel: module,
    distro: distroPath,
    memoryMiB: 1024,
    jit: true,
    net: { kind: "net", backend: { kind: "direct" }, hostLoopback: proxy.hostLoopback },
    disks: [disk],
    mounts: {
      "/mnt/host": { fs: nodeFs(stageDir), readOnly: true },
    },
    log: (m) => log("kernel-host", m),
  });

  try {
    const runSh = async (label: string, script: string, env?: Record<string, string>): Promise<string> => {
      log("guest", `Running step: ${label}...`);
      const res = await vm.exec("/bin/sh", ["-e", "-c", script], { user: "root", env });
      if (res.stdout.trim()) {
        for (const line of res.stdout.trim().split("\n")) {
          log(label, line);
        }
      }
      if (res.stderr.trim()) console.error(res.stderr.trimEnd());
      if (res.exitCode !== 0) {
        throw new Error(`Step "${label}" failed with exit code ${res.exitCode}: ${res.stderr}`);
      }
      return res.stdout;
    };

    await runSh(
      `${distro}-install`,
      alpine ? `
      /etc/kw-apk-enable
      apk add -q --no-cache --timeout 30 \\
        neovim \\
        fish \\
        git \\
        ripgrep \\
        fd \\
        curl \\
        tar \\
        unzip \\
        gcompat \\
        lua-language-server \\
        stylua \\
        tree-sitter-javascript \\
        tree-sitter-typescript \\
        tree-sitter-jsdoc \\
        tree-sitter-json \\
        tree-sitter-html \\
        tree-sitter-css \\
        tree-sitter-yaml \\
        tree-sitter-kotlin \\
        tree-sitter-rust \\
        tree-sitter-toml \\
        tree-sitter-go \\
        tree-sitter-go-mod \\
        tree-sitter-markdown \\
        tree-sitter-bash \\
        tree-sitter-python \\
        tree-sitter-cpp \\
        tree-sitter-regex \\
        tree-sitter-comment
      ` : `
      export DEBIAN_FRONTEND=noninteractive
      sed -i 's|^URIs: http:|URIs: https:|' /etc/apt/sources.list.d/debian.sources
      install_tools() {
        apt-get install -y -qq --no-install-recommends -o Acquire::https::Timeout=30 git ripgrep fd-find fish
      }
      # The upstream image already ships signed package lists.
      if ! install_tools; then
        apt-get update -qq -o APT::Update::Error-Mode=any -o Acquire::https::Timeout=30
        install_tools
      fi
      mkdir -p /opt /usr/local/bin
      cp -a /mnt/host/debian/neovim /mnt/host/debian/lua-language-server /opt/
      chown -R root:root /opt/neovim /opt/lua-language-server
      ln -s /opt/neovim/bin/nvim /usr/bin/nvim
      ln -s /opt/lua-language-server/bin/lua-language-server /usr/local/bin/lua-language-server
      ln -s /usr/bin/fdfind /usr/local/bin/fd
      install -m 755 /mnt/host/debian/stylua/stylua /usr/local/bin/stylua
      `,
      proxy.env,
    );

    await runSh(
      "configure-shell",
      `
      fish_bin=$(command -v fish)
      [ -n "$fish_bin" ]
      [ -x /usr/bin/fish ] || ln -sf "$fish_bin" /usr/bin/fish
      grep -qx '/usr/bin/fish' /etc/shells 2>/dev/null || echo '/usr/bin/fish' >> /etc/shells
      sed -i 's|^\\(root:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:\\).*|\\1/usr/bin/fish|' /etc/passwd
      mkdir -p /etc/fish/conf.d
      cat > /etc/fish/conf.d/kw-env.fish << 'EOF'
# unkernel environment integration for fish
fish_add_path --global --path --move --prepend /run/kw/bin "$HOME/.local/bin"
fish_add_path --global --path --append /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin /usr/lib/kw/bin
if not set -q LANG
    set -gx LANG C.UTF-8
end
if contains -- "$TERM" linux vt102 ""
    set -gx TERM xterm-256color
end
EOF
      `,
    );

    await runSh(
      "verify-tools",
      `
      export HOME=/root
      nvim --version | head -n 2
      fish --version
      fish_err=$(fish -l -c 'command -v nvim fd rg stylua lua-language-server >/dev/null' 2>&1)
      if [ -n "$fish_err" ]; then
        echo "Unexpected fish stderr: $fish_err" >&2
        exit 1
      fi
      lua-language-server --version
      stylua --version
      rg --version | head -n 1
      fd --version
      `,
    );

    await runSh(
      "install-config-and-parsers",
      `
      site=/root/.local/share/nvim/site
      mkdir -p /root/.config "$site/pack/core/opt" "$site/parser"
      rm -rf /root/.config/nvim
      cp -a /mnt/host/nvim-config /root/.config/nvim
      cp -a /mnt/host/pack/* "$site/pack/core/opt/"
      cp -a /mnt/host/${distro}/parsers/*.so "$site/parser/"
      chmod 755 "$site/parser/"*.so
      if [ -d /mnt/host/${distro}/codediff ]; then
        cp -a /mnt/host/${distro}/codediff/*.so "$site/pack/core/opt/codediff.nvim/"
      fi
      if [ -d /mnt/host/codediff-watcher ]; then
        cp -a /mnt/host/codediff-watcher/codediff-watcher_* "$site/pack/core/opt/codediff.nvim/"
        chmod 755 "$site/pack/core/opt/codediff.nvim/"codediff-watcher_*
      fi
      # The host's Git checkouts carry host UIDs over 9p.
      chown -R root:root /root/.config/nvim "$site"

      # Ensure go_mod.so / gomod.so alias both exist
      if [ -e /usr/lib/tree-sitter/go_mod.so ] && [ ! -e /usr/lib/tree-sitter/gomod.so ]; then
        ln -sf go_mod.so /usr/lib/tree-sitter/gomod.so
      fi
      if [ -e /usr/lib/tree-sitter/gomod.so ] && [ ! -e /usr/lib/tree-sitter/go_mod.so ]; then
        ln -sf gomod.so /usr/lib/tree-sitter/go_mod.so
      fi

      # Add host integration plugin (auto-enable system lua_ls + osc52 clipboard)
      mkdir -p /root/.config/nvim/plugin
      cat > /root/.config/nvim/plugin/zz-unkernel-host.lua << 'EOF'
-- Auto-generated unkernel browser integration bridge.
-- Enables OSC 52 clipboard and system-installed aarch64 LSP servers (e.g. lua_ls)
-- without modifying tracked files in DefectingCat/nvim.
vim.g.clipboard = "osc52"

vim.api.nvim_create_autocmd("FileType", {
  once = true,
  pattern = "*",
  callback = function()
    vim.schedule(function()
      if vim.fn.executable("lua-language-server") == 1 then
        pcall(vim.lsp.enable, { "lua_ls" })
      end
      if vim.fn.executable("rust-analyzer") == 1 then
        pcall(vim.lsp.enable, { "rust_analyzer" })
      end
    end)
  end,
})
EOF

      # Keep git status inside /root/.config/nvim completely clean
      mkdir -p /root/.config/nvim/.git/info
      cat >> /root/.config/nvim/.git/info/exclude << 'EOF'
/plugin/zz-unkernel-host.lua
/nvim-pack-lock.json
EOF

      # Keep PUC-Rio Lua 5.1 compatibility shim as a safe no-op when LuaJIT is active
      mkdir -p /etc/xdg/nvim /usr/share/nvim
      cat > /usr/share/nvim/sysinit.vim << 'EOF'
lua << EOLUA
if not jit then
  local raw_load = _G.load
  _G.load = function(ld, src, _mode, env)
    if type(ld) == "string" then
      local fn, err = loadstring(ld, src)
      if fn and env then setfenv(fn, env) end
      return fn, err
    end
    return raw_load(ld, src)
  end

  local raw_traceback = debug.traceback
  debug.traceback = function(co, msg, lvl)
    if type(co) == "thread" then
      if lvl == nil then return raw_traceback(co, tostring(msg or "")) end
      return raw_traceback(co, tostring(msg or ""), lvl)
    end
    if co == nil and msg == nil and lvl == nil then return raw_traceback() end
    if msg == nil then return raw_traceback(co ~= nil and tostring(co) or "") end
    return raw_traceback(tostring(co or ""), lvl or msg)
  end

  local ok_coxp, coxp = pcall(require, "coxpcall")
  if ok_coxp and coxp then
    _G.pcall = coxp.pcall
    _G.xpcall = coxp.xpcall
    coroutine.running = coxp.running
  end
end
EOLUA
EOF
      cp /usr/share/nvim/sysinit.vim /etc/xdg/nvim/sysinit.vim
      `,
    );

    await runSh(
      "nvim-warmup",
      `
      export HOME=/root
      export SHELL=/usr/bin/fish
      # Initialize vim.pack lockfile & bytecode cache (run twice to verify cached load)
      nvim --headless \\
        --cmd "lua vim.fn.confirm = function() return 1 end" \\
        -c "lua require('plugins.lsp').setup(); require('plugins.pick').load_pick()" \\
        -c "lua if not _G.nvim_init_done or vim.v.errmsg ~= '' then vim.cmd.cquit() end" \\
        -c "qa!"
      nvim --headless \\
        -c "lua if not _G.nvim_init_done or vim.v.errmsg ~= '' then vim.cmd.cquit() else print('verified_init_ms=' .. string.format('%.2f', (_G.nvim_init_done - _G.nvim_start_time)/1e6)) end" \\
        -c "qa!"

      # Verify that 0 parsers are missing from ensure_installed and prebaked codediff-watcher reports ready
      CODEDIFF_WATCHER_NO_AUTO_INSTALL=1 nvim --headless -c 'lua
        local ensure = {
          "javascript", "typescript", "tsx", "jsdoc", "json", "html", "css", "yaml", "kotlin",
          "rust", "toml", "go", "gomod", "gosum", "gowork", "dockerfile", "make",
          "git_config", "git_rebase", "gitattributes", "gitcommit", "gitignore",
          "markdown", "markdown_inline"
        }
        local missing = {}
        for _, lang in ipairs(ensure) do
          local ok, loaded = pcall(vim.treesitter.language.add, lang)
          if not ok or not loaded then
            table.insert(missing, lang)
          end
        end
        print("Missing parsers count: " .. #missing)
        if #missing > 0 then
          vim.api.nvim_err_writeln("Missing parsers: " .. table.concat(missing, ", "))
          vim.cmd.cquit()
        end

        vim.cmd.packadd("codediff.nvim")
        local done, ready_msg, err_msg = false, nil, nil
        local unsub = require("codediff.core.watcher").subscribe("/root/.config/nvim", {
          on_ready = function(msg)
            ready_msg = msg
            done = true
          end,
          on_error = function(err)
            err_msg = err
            done = true
          end,
        })
        vim.wait(5000, function() return done end, 50)
        unsub()
        if not ready_msg then
          vim.api.nvim_err_writeln("codediff-watcher failed: " .. tostring(err_msg or "timeout"))
          vim.cmd.cquit()
        end
        print("Verified codediff-watcher: v" .. tostring(ready_msg.binary_version))
      ' -c "qa!"
      `,
    );

    await runSh(
      "workspace-and-cleanup",
      `
      mkdir -p /workspace
      cat > /workspace/welcome.lua << 'EOF'
-- Welcome to unkernel-nvim (${label} aarch64 + Neovim 0.12 + DefectingCat/nvim)
-- Press <Space>ff to find files, - to open mini.files, or Ctrl+Shift+P for the host menu.

local function greet(name)
    local info = vim.uv.os_uname()
    return string.format("Hello, %s! Running on %s %s (%s)", name, info.sysname, info.release, info.machine)
end

print(greet("Neovim"))
EOF
      cd /workspace
      git init -q
      git config user.name "unkernel"
      git config user.email "unkernel@local"
      git add welcome.lua
      git commit -q -m "chore: initial workspace"

      # Clean caches to minimize kwsparse image size
      ${alpine ? "" : "apt-get clean"}
      rm -rf /var/cache/apk/* /tmp/* /var/tmp/*
      sync
      `,
    );

    log("vm", "Syncing filesystems and powering off guest cleanly...");
    if (!(await vm.sync({ timeout: 10_000 }))) throw new Error("Guest disk sync did not complete");
    void vm.exec("/usr/local/sbin/poweroff", [], { user: "root" }).catch(() => {});
    const exit = await vm.exited;
    log("vm", `Guest exited: kind=${exit.kind} code=${exit.code}`);

    log("export", "Exporting and compressing kwsparse image...");
    mkdirSync(PUBLIC, { recursive: true });
    const { blocks, parts } = await disk.exportParts();
    const blob = await gzipBlob(parts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stagedImage = `${imageFile}.${process.pid}.tmp`;
    const stagedDisk = `${outFile}.${process.pid}.tmp`;
    try {
      copyFileSync(distroPath, stagedImage);
      writeFileSync(stagedDisk, bytes);
      renameSync(stagedImage, imageFile);
      renameSync(stagedDisk, outFile);
    } finally {
      rmSync(stagedImage, { force: true });
      rmSync(stagedDisk, { force: true });
    }

    const mb = (bytes.byteLength / 1048576).toFixed(2);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    log("done", `Wrote ${outFile} (${blocks} blocks, ${mb} MiB gzipped) in ${elapsed}s`);
  } finally {
    await vm.stop().catch(() => {});
  }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  if (requested.length > 1 || (requested.length === 1 && !isDistro(requested[0]!))) {
    throw new Error("Usage: bun run prebake [debian|alpine]");
  }
  const chosen = requested[0] ?? null;
  const distros: Distro[] = isDistro(chosen) ? [chosen] : ["debian", "alpine"];
  const stageDir = mkdtempSync(path.join(tmpdir(), "unkernel-nvim-prebake-"));
  try {
    const [images, module] = await Promise.all([
      Promise.all(distros.map((distro) => fetchDistro(distro))),
      WebAssembly.compile(readFileSync(fileURLToPath(bundledKernelUrl))),
      prepareHostAssets(stageDir).then(async () => {
        await Promise.all([
          prepareCodeDiffWatcher(stageDir),
          ...distros.map((distro) => prepareCodeDiff(stageDir, distro)),
        ]);
      }),
      prepareParsers(stageDir, distros),
      distros.includes("debian") ? prepareDebianTools(stageDir) : undefined,
    ]);
    for (const [i, distro] of distros.entries()) {
      await bakeDistro(stageDir, distro, images[i]!, module);
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
