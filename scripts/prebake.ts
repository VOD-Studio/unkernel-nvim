// SPDX-License-Identifier: MIT
// Build-time prebake script for unkernel-nvim.
// Runs on Node >= 24 (--experimental-wasm-jspi):
// 1. Clones DefectingCat/nvim + all 13 vim.pack plugins on the host in parallel;
// 2. Cross-compiles codediff.nvim's libvscode_diff.so and the 9 non-apk Treesitter
//    parsers to riscv64-linux-musl using host `zig cc`;
// 3. Boots unkernel with the bundled 4 GiB kwdata disk, installs Alpine riscv64
//    neovim + git + ripgrep + lua-language-server + stylua + prebuilt tree-sitter-*
//    packages, copies the prebuilt artifacts in, runs `nvim --headless` to generate
//    `nvim-pack-lock.json` and `vim.loader` bytecode cache, and powers off cleanly;
// 4. Exports the resulting disk as `public/nvim-data.kwsparse.gz`.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  bundledBoot,
  bundledKernelUrl,
  CowDisk,
  createKernel,
  directBackend,
  gzipBlob,
  nodeFs,
  readKwsparse,
  SparseBase,
} from "unkernel/node";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "public", "nvim-data.kwsparse.gz");

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

function log(step: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${step}] ${msg}`);
}

async function prepareHostAssets(stageDir: string): Promise<void> {
  const nvimCfgDir = path.join(stageDir, "nvim-config");
  const packDir = path.join(stageDir, "pack");
  const parsersDir = path.join(stageDir, "parsers");
  const parserSrcDir = path.join(stageDir, "parser-src");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(parsersDir, { recursive: true });
  mkdirSync(parserSrcDir, { recursive: true });

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

  // Cross-compile codediff.nvim's libvscode_diff.so for riscv64-linux-musl using zig cc
  const codediffDir = path.join(packDir, "codediff.nvim");
  const vsdiffDir = path.join(codediffDir, "libvscode-diff");
  if (existsSync(vsdiffDir)) {
    log("host", "Cross-compiling codediff.nvim libvscode_diff.so (riscv64-linux-musl)...");
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
    const soOut = path.join(codediffDir, "libvscode_diff.so");
    await execFileAsync(
      "zig",
      [
        "cc",
        "-target",
        "riscv64-linux-musl",
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
    writeFileSync(path.join(codediffDir, `libvscode_diff_${version}.so`), readFileSync(soOut));
  }

  // Download and cross-compile the 9 extra Treesitter parsers in parallel
  log("host", `Cross-compiling ${EXTRA_PARSERS.length} additional Treesitter parsers with zig cc...`);
  await Promise.all(
    EXTRA_PARSERS.map(async ({ lang, url, rev }) => {
      const work = path.join(parserSrcDir, lang);
      mkdirSync(work, { recursive: true });
      const tarUrl = `${url}/archive/${rev}.tar.gz`;
      await execFileAsync("sh", [
        "-c",
        `curl -fsSL "${tarUrl}" | tar -xzf - --strip-components=1 -C "${work}"`,
      ]);
      const srcDir = path.join(work, "src");
      const files = [path.join(srcDir, "parser.c")];
      if (existsSync(path.join(srcDir, "scanner.c"))) {
        files.push(path.join(srcDir, "scanner.c"));
      }
      const outSo = path.join(parsersDir, `${lang}.so`);
      await execFileAsync("zig", [
        "cc",
        "-target",
        "riscv64-linux-musl",
        "-O2",
        "-shared",
        "-fPIC",
        "-s",
        `-I${srcDir}`,
        "-o",
        outSo,
        ...files,
      ]);
    }),
  );
  log("host", `Built parsers: ${readdirSync(parsersDir).join(", ")}`);
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const stageDir = mkdtempSync(path.join(tmpdir(), "unkernel-nvim-prebake-"));

  try {
    await prepareHostAssets(stageDir);

    log("vm", "Loading bundled unkernel-alpine.wasm and kwdata template...");
    const wasmBytes = readFileSync(fileURLToPath(bundledKernelUrl));
    const module = await WebAssembly.compile(wasmBytes);
    const bootInfo = bundledBoot(module);
    if (!bootInfo.datadisk) {
      throw new Error("Bundled kernel has no unkernel.datadisk section");
    }

    const base = SparseBase.fromKwsparse(await readKwsparse(bootInfo.datadisk));
    const disk = new CowDisk(base);

    log("vm", "Booting Alpine riscv64 VM...");
    const vm = await createKernel({
      kernel: module,
      memoryMiB: 1024,
      jit: true,
      net: directBackend(),
      disks: [disk],
      mounts: {
        "/mnt/host": { fs: nodeFs(stageDir), readOnly: true },
      },
      log: (m) => log("kernel-host", m),
    });

    const runSh = async (label: string, script: string): Promise<string> => {
      log("guest", `Running step: ${label}...`);
      const res = await vm.exec("/bin/sh", ["-e", "-c", script]);
      if (res.stdout.trim()) {
        for (const line of res.stdout.trim().split("\n")) {
          log(label, line);
        }
      }
      if (res.exitCode !== 0) {
        console.error(res.stderr);
        throw new Error(`Step "${label}" failed with exit code ${res.exitCode}: ${res.stderr}`);
      }
      return res.stdout;
    };

    await runSh(
      "apk-install",
      `
      /etc/kw-apk-enable
      apk update -q
      apk add -q --no-cache \\
        neovim \\
        git \\
        ripgrep \\
        fd \\
        curl \\
        tar \\
        unzip \\
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
      nvim --version | head -n 2
      lua-language-server --version
      stylua --version
      rg --version | head -n 1
      `,
    );

    await runSh(
      "install-config-and-parsers",
      `
      mkdir -p /root/.config /root/.local/share/nvim/site/pack/core/opt /usr/lib/tree-sitter
      rm -rf /root/.config/nvim
      cp -a /mnt/host/nvim-config /root/.config/nvim
      cp -a /mnt/host/pack/* /root/.local/share/nvim/site/pack/core/opt/
      cp -a /mnt/host/parsers/*.so /usr/lib/tree-sitter/
      chmod 755 /usr/lib/tree-sitter/*.so

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
-- Enables OSC 52 clipboard and system-installed riscv64 LSP servers (e.g. lua_ls)
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

      # Install PUC-Rio Lua 5.1 compatibility shim for vim.loader, debug.traceback & coxpcall on riscv64
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
      # Initialize vim.pack lockfile & bytecode cache (run twice to verify cached load)
      nvim --headless \\
        --cmd "lua vim.fn.confirm = function() return 1 end" \\
        -c "lua require('plugins.lsp').setup(); require('plugins.pick').load_pick()" \\
        -c "qa!"
      nvim --headless \\
        -c "lua print('verified_init_ms=' .. string.format('%.2f', (_G.nvim_init_done - _G.nvim_start_time)/1e6))" \\
        -c "qa!"

      # Verify that 0 parsers are missing from ensure_installed
      nvim --headless -c 'lua
        local ensure = {
          "javascript", "typescript", "tsx", "jsdoc", "json", "html", "css", "yaml", "kotlin",
          "rust", "toml", "go", "gomod", "gosum", "gowork", "dockerfile", "make",
          "git_config", "git_rebase", "gitattributes", "gitcommit", "gitignore",
          "markdown", "markdown_inline"
        }
        local missing = {}
        for _, lang in ipairs(ensure) do
          if #vim.api.nvim_get_runtime_file("parser/" .. lang .. ".so", false) == 0 then
            table.insert(missing, lang)
          end
        end
        print("Missing parsers count: " .. #missing)
        if #missing > 0 then
          error("Missing parsers: " .. table.concat(missing, ", "))
        end
      ' -c "qa!"
      `,
    );

    await runSh(
      "workspace-and-cleanup",
      `
      mkdir -p /workspace
      cat > /workspace/welcome.lua << 'EOF'
-- Welcome to unkernel-nvim (Alpine Linux riscv64 + Neovim 0.12 + DefectingCat/nvim)
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
      rm -rf /var/cache/apk/* /tmp/* /var/tmp/*
      sync
      `,
    );

    log("vm", "Syncing filesystems and powering off guest cleanly...");
    await vm.sync({ timeout: 10000 });
    vm.write("poweroff\n");
    const exit = await vm.exited;
    log("vm", `Guest exited: kind=${exit.kind} code=${exit.code}`);

    log("export", "Exporting and compressing kwsparse image...");
    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const { blocks, parts } = await disk.exportParts();
    const blob = await gzipBlob(parts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    writeFileSync(OUT_FILE, bytes);

    const mb = (bytes.byteLength / 1048576).toFixed(2);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    log("done", `Wrote ${OUT_FILE} (${blocks} blocks, ${mb} MiB gzipped) in ${elapsed}s`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
