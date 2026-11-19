// SPDX-License-Identifier: MIT
// Minimalist Modal Control Center for unkernel-nvim.
// Provides local directory mounting (9p), workspace switching, session switching,
// font sizing, disk persistence/export/import/reset, and runtime diagnostics.

import { isDirectoryPickerSupported, pickHostDirectory } from "./fs-bridge.ts";
import {
  formatMemoryLabel,
  isPresetMemoryMiB,
  MEMORY_MAX_MIB,
  MEMORY_MIN_MIB,
  MEMORY_PRESETS_MIB,
  validateCustomMemoryInput,
  type MemoryConfigMiB,
} from "./memory-config.ts";
import type { CanvasTerminal } from "./terminal.ts";
import { getSameOriginWispUrl, type NetMode, type VmManager } from "./vm-manager.ts";

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface ModalControllerOptions {
  backdrop: HTMLElement;
  dialog: HTMLElement;
  pill: HTMLButtonElement;
  vmManager: VmManager;
  terminal: CanvasTerminal;
  toast: (msg: string) => void;
}

export class ModalController {
  #backdrop: HTMLElement;
  #dialog: HTMLElement;
  #pill: HTMLButtonElement;
  #vmManager: VmManager;
  #terminal: CanvasTerminal;
  #toast: (msg: string) => void;
  #open = false;
  #pillHidden = localStorage.getItem("unkernel-nvim.hidePill") === "1";
  #customMemoryOpen = false;

  constructor(opts: ModalControllerOptions) {
    this.#backdrop = opts.backdrop;
    this.#dialog = opts.dialog;
    this.#pill = opts.pill;
    this.#vmManager = opts.vmManager;
    this.#terminal = opts.terminal;
    this.#toast = opts.toast;

    if (this.#pillHidden) {
      this.#pill.classList.add("hidden-pill");
    }

    this.#pill.addEventListener("click", () => this.toggle());
    this.#backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.#backdrop) {
        this.close();
      }
    });

    window.addEventListener(
      "keydown",
      (e) => {
        if (
          (e.key === "P" || e.key === "p") &&
          e.shiftKey &&
          (e.ctrlKey || e.metaKey)
        ) {
          e.preventDefault();
          e.stopPropagation();
          this.toggle();
          return;
        }
        if (e.key === "Escape" && this.#open) {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  open(): void {
    this.#open = true;
    this.render();
    this.#backdrop.classList.remove("hidden");
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#customMemoryOpen = false;
    this.#backdrop.classList.add("hidden");
    this.#terminal.focus();
  }

  render(): void {
    const diag = this.#vmManager.getStats();
    const jit = diag.stats?.jit;
    const diskMiB = ((diag.diskBlocks * 4096) / 1048576).toFixed(1);
    const pickerSupported = isDirectoryPickerSupported();
    const mounts = [...this.#vmManager.mountedFolders.values()];

    const effectiveMem = this.#vmManager.getEffectiveMemoryConfig();
    const autoMem = this.#vmManager.getAutoMemoryInfo();
    const isAutoMem = effectiveMem === null;
    const isCustomMem = effectiveMem !== null && !isPresetMemoryMiB(effectiveMem);
    const showCustomMemRow = this.#customMemoryOpen || isCustomMem;
    const pendingMemChange = this.#vmManager.hasPendingMemoryChange();
    const targetMemLabel = formatMemoryLabel(effectiveMem, autoMem.mib);
    const customMemInputVal =
      effectiveMem !== null ? String(effectiveMem) : String(diag.memoryMiB || autoMem.mib);

    let memoryHint: string;
    if (pendingMemChange) {
      memoryHint = `当前 ${diag.memoryMiB} MiB → 下次启动 ${targetMemLabel}`;
    } else if (this.#vmManager.hasUrlMemoryOverride()) {
      memoryHint = `URL 参数 ?mem 临时覆盖（当前 ${diag.memoryMiB} MiB）`;
    } else if (diag.memoryFallback) {
      memoryHint = `目标 ${diag.memoryRequestedMiB} MiB 分配失败，已自动回退至 ${diag.memoryMiB} MiB`;
    } else if (isAutoMem) {
      memoryHint = `自动策略（当前 ${diag.memoryMiB} MiB，修改需重启生效）`;
    } else {
      memoryHint = `已分配 ${diag.memoryMiB} MiB（上限 4 GiB，修改需重启生效）`;
    }

    const memStatText = diag.memoryFallback
      ? `${diag.memoryMiB} MiB (回退) · ${jit ? `${jit.compiled} 块已编译` : "启用"}`
      : `${diag.memoryMiB} MiB · ${jit ? `${jit.compiled} 块已编译` : "启用"}`;

    this.#dialog.innerHTML = `
      <div class="modal-header">
        <div class="modal-title-group">
          <h2 class="modal-title" id="modal-title">unkernel · Neovim 控制中心</h2>
          <span class="modal-subtitle">Alpine 3.24 riscv64 · DefectingCat/nvim</span>
        </div>
        <button class="modal-close" id="btn-close-modal" type="button">ESC 关闭</button>
      </div>

      <div class="modal-section">
        <h3 class="modal-section-title">工作区与本地目录挂载 (9p over vsock)</h3>
        <div class="modal-grid">
          <button class="modal-btn primary" id="btn-mount-dir" type="button" ${pickerSupported ? "" : "disabled"}>
            <span>挂载本地文件夹…</span>
            <span class="modal-btn-desc">${pickerSupported ? "直接读写宿主机目录 (/workspace/*)" : "需 Chrome / Edge 浏览器"}</span>
          </button>
          <button class="modal-btn" id="btn-open-workspace" type="button">
            <span>打开 /workspace</span>
            <span class="modal-btn-desc">进入默认工作区</span>
          </button>
          <button class="modal-btn" id="btn-open-nvim-config" type="button">
            <span>打开 ~/.config/nvim</span>
            <span class="modal-btn-desc">浏览或编辑 DefectingCat/nvim</span>
          </button>
        </div>
        ${
          mounts.length > 0
            ? `<div class="mount-list">
                ${mounts
                  .map(
                    (m) => `
                  <div class="mount-item">
                    <span class="mount-item-path">${m.guestPath}</span>
                    <div class="mount-item-actions">
                      <button class="mini-btn" data-open-mount="${m.guestPath}" type="button">在 Neovim 中打开</button>
                      <button class="mini-btn" data-unmount="${m.guestPath}" type="button">卸载</button>
                    </div>
                  </div>`,
                  )
                  .join("")}
              </div>`
            : ""
        }
      </div>

      <div class="modal-section">
        <h3 class="modal-section-title">会话与终端画布</h3>
        <div class="modal-grid">
          <button class="modal-btn" id="btn-restart-nvim" type="button">
            <span>重启 Neovim 会话</span>
            <span class="modal-btn-desc">在 ${this.#vmManager.currentCwd} 启动 nvim</span>
          </button>
          <button class="modal-btn" id="btn-switch-shell" type="button">
            <span>切换到 Alpine Shell</span>
            <span class="modal-btn-desc">打开 /bin/sh 终端命令行</span>
          </button>
        </div>
        <div class="row-bar">
          <span class="row-label">Canvas 终端字号 (Maple Mono / Nerd Font)</span>
          <div class="row-controls">
            <button class="mini-btn" id="btn-font-dec" type="button">−</button>
            <span id="label-font-size">${this.#terminal.getFontSize()} px</span>
            <button class="mini-btn" id="btn-font-inc" type="button">+</button>
          </div>
        </div>
        <div class="row-bar">
          <span class="row-label">右上角悬浮快捷胶囊</span>
          <div class="row-controls">
            <button class="mini-btn" id="btn-toggle-pill" type="button">
              ${this.#pillHidden ? "当前隐藏 (点击显示)" : "当前显示 (点击隐藏)"}
            </button>
          </div>
        </div>
      </div>

      <div class="modal-section">
        <h3 class="modal-section-title">持久化存储 (IndexedDB) 与备份</h3>
        <div class="modal-grid">
          <button class="modal-btn" id="btn-sync-disk" type="button">
            <span>立即同步落盘 (Sync)</span>
            <span class="modal-btn-desc">将文件修改刷新到 IndexedDB</span>
          </button>
          <button class="modal-btn" id="btn-export-disk" type="button">
            <span>导出磁盘备份 (.kwsparse.gz)</span>
            <span class="modal-btn-desc">下载当前完整系统与配置状态</span>
          </button>
          <button class="modal-btn" id="btn-import-disk" type="button">
            <span>导入磁盘备份…</span>
            <span class="modal-btn-desc">从 .kwsparse.gz 恢复并刷新</span>
          </button>
          <button class="modal-btn danger" id="btn-reset-disk" type="button">
            <span>恢复出厂预烘焙镜像</span>
            <span class="modal-btn-desc">清空本地改动，还原初始状态</span>
          </button>
        </div>
        <input type="file" id="input-import-disk" accept=".gz,.kwsparse" style="display:none" />
      </div>

      <div class="modal-section">
        <h3 class="modal-section-title">运行时性能与诊断</h3>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-key">Worker 传输通道</div>
            <div class="stat-val">${diag.transport === "shared" ? "SharedArrayBuffer (0延迟)" : diag.transport}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">Canvas 渲染器</div>
            <div class="stat-val">${this.#terminal.webglActive ? "WebGL2 GPU" : "Canvas Fallback"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">虚拟机内存 / JIT</div>
            <div class="stat-val">${memStatText}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">持久化存储占用</div>
            <div class="stat-val">${diskMiB} MiB (${diag.diskBlocks} 块)</div>
          </div>
        </div>
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label">虚拟机内存配额</span>
            <span class="row-hint">${memoryHint}</span>
          </div>
          <div class="row-controls">
            <button class="mini-btn ${isAutoMem && !this.#customMemoryOpen ? "active" : ""}" data-mem-preset="auto" type="button">自动</button>
            ${MEMORY_PRESETS_MIB.map((mib) => {
              const label = mib >= 1024 ? `${mib / 1024}G` : `${mib}M`;
              const active = effectiveMem === mib && !this.#customMemoryOpen;
              return `<button class="mini-btn ${active ? "active" : ""}" data-mem-preset="${mib}" type="button">${label}</button>`;
            }).join("")}
            <button class="mini-btn ${showCustomMemRow ? "active" : ""}" id="btn-mem-custom" type="button">自定义</button>
          </div>
        </div>
        ${
          showCustomMemRow
            ? `<div class="row-bar">
                <span class="row-label">自定义内存 (${MEMORY_MIN_MIB}–${MEMORY_MAX_MIB} MiB)</span>
                <div class="row-controls" style="flex:1; max-width: 240px;">
                  <input
                    class="text-input"
                    id="input-memory-mib"
                    type="number"
                    inputmode="numeric"
                    min="${MEMORY_MIN_MIB}"
                    max="${MEMORY_MAX_MIB}"
                    step="64"
                    placeholder="例如 1536"
                    value="${escapeAttr(customMemInputVal)}"
                  />
                  <span class="row-unit">MiB</span>
                  <button class="mini-btn" id="btn-save-memory" type="button">保存</button>
                </div>
              </div>`
            : ""
        }
        ${
          pendingMemChange
            ? `<div class="row-bar row-bar-accent">
                <span class="row-label">内存已改为 ${targetMemLabel}，同步落盘并重启后生效</span>
                <div class="row-controls">
                  <button class="mini-btn active" id="btn-apply-memory-restart" type="button">同步并重启</button>
                </div>
              </div>`
            : ""
        }
        <div class="row-bar">
          <span class="row-label">虚拟机联网模式 (Wisp)</span>
          <div class="row-controls">
            <button class="mini-btn ${this.#vmManager.netMode === "builtin" ? "active" : ""}" data-net-mode="builtin" type="button">内置代理 (/wisp)</button>
            <button class="mini-btn ${this.#vmManager.netMode === "custom" ? "active" : ""}" data-net-mode="custom" type="button">自定义</button>
            <button class="mini-btn ${this.#vmManager.netMode === "off" ? "active" : ""}" data-net-mode="off" type="button">离线</button>
          </div>
        </div>
        ${
          this.#vmManager.netMode === "builtin"
            ? `<div class="row-bar">
                <span class="row-label">当前代理通道 (免登录同源转发)</span>
                <div class="row-controls">
                  <span class="stat-val">${escapeAttr(getSameOriginWispUrl())}</span>
                </div>
              </div>`
            : this.#vmManager.netMode === "custom"
              ? `<div class="row-bar">
                  <span class="row-label">自定义 Wisp 地址</span>
                  <div class="row-controls" style="flex:1; max-width: 340px;">
                    <input
                      class="text-input"
                      id="input-wisp-url"
                      type="text"
                      placeholder="wss://your-wisp-proxy/"
                      value="${escapeAttr(this.#vmManager.wispUrl)}"
                    />
                    <button class="mini-btn" id="btn-save-wisp" type="button">保存</button>
                  </div>
                </div>`
              : ""
        }
      </div>
    `;

    this.#bindEvents();
  }

  #bindEvents(): void {
    const q = <T extends HTMLElement>(sel: string) => this.#dialog.querySelector<T>(sel);

    q("#btn-close-modal")?.addEventListener("click", () => this.close());

    q("#btn-mount-dir")?.addEventListener("click", async () => {
      try {
        const dirFs = await pickHostDirectory();
        this.#toast(`正在挂载本地目录 ${dirFs.name}…`);
        const mounted = await this.#vmManager.mountHostDirectory(dirFs);
        const pty = await this.#vmManager.startSession(
          "nvim",
          this.#terminal.getSize(),
          mounted.guestPath,
        );
        this.#terminal.attachPty(pty);
        this.#toast(`已挂载并打开 ${mounted.guestPath}`);
        this.close();
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        this.#toast(`挂载失败: ${(err as Error)?.message ?? String(err)}`);
      }
    });

    q("#btn-open-workspace")?.addEventListener("click", async () => {
      await this.#switchDir("/workspace");
    });

    q("#btn-open-nvim-config")?.addEventListener("click", async () => {
      await this.#switchDir("/root/.config/nvim");
    });

    for (const btn of this.#dialog.querySelectorAll<HTMLButtonElement>("[data-open-mount]")) {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.openMount!;
        await this.#switchDir(path);
      });
    }

    for (const btn of this.#dialog.querySelectorAll<HTMLButtonElement>("[data-unmount]")) {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.unmount!;
        const entry = this.#vmManager.mountedFolders.get(path);
        if (!entry) return;
        await entry.mount.unmount().catch(() => {});
        this.#vmManager.mountedFolders.delete(path);
        this.#toast(`已卸载 ${path}`);
        this.render();
      });
    }

    q("#btn-restart-nvim")?.addEventListener("click", async () => {
      const pty = await this.#vmManager.startSession("nvim", this.#terminal.getSize());
      this.#terminal.attachPty(pty);
      this.close();
    });

    q("#btn-switch-shell")?.addEventListener("click", async () => {
      const pty = await this.#vmManager.startSession("shell", this.#terminal.getSize());
      this.#terminal.attachPty(pty);
      this.close();
    });

    q("#btn-font-dec")?.addEventListener("click", () => {
      this.#terminal.setFontSize(this.#terminal.getFontSize() - 1);
      const lbl = q("#label-font-size");
      if (lbl) lbl.textContent = `${this.#terminal.getFontSize()} px`;
    });

    q("#btn-font-inc")?.addEventListener("click", () => {
      this.#terminal.setFontSize(this.#terminal.getFontSize() + 1);
      const lbl = q("#label-font-size");
      if (lbl) lbl.textContent = `${this.#terminal.getFontSize()} px`;
    });

    q("#btn-toggle-pill")?.addEventListener("click", () => {
      this.#pillHidden = !this.#pillHidden;
      localStorage.setItem("unkernel-nvim.hidePill", this.#pillHidden ? "1" : "0");
      this.#pill.classList.toggle("hidden-pill", this.#pillHidden);
      this.render();
    });

    q("#btn-sync-disk")?.addEventListener("click", async () => {
      this.#toast("正在同步文件系统到 IndexedDB…");
      const ok = await this.#vmManager.syncDisk();
      this.#toast(ok ? "已落盘保存至 IndexedDB" : "同步完成");
      this.render();
    });

    q("#btn-export-disk")?.addEventListener("click", async () => {
      try {
        this.#toast("正在导出压缩磁盘镜像…");
        const res = await this.#vmManager.exportDiskImage();
        const mb = (res.bytes / 1048576).toFixed(1);
        this.#toast(`已导出 ${res.name} (${mb} MiB)`);
      } catch (err) {
        this.#toast(`导出失败: ${(err as Error)?.message ?? String(err)}`);
      }
    });

    const fileInput = q<HTMLInputElement>("#input-import-disk");
    q("#btn-import-disk")?.addEventListener("click", () => {
      fileInput?.click();
    });
    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        this.#toast(`正在导入镜像 ${file.name}…`);
        await this.#vmManager.importDiskImage(file);
      } catch (err) {
        this.#toast(`导入失败: ${(err as Error)?.message ?? String(err)}`);
      }
    });

    q("#btn-reset-disk")?.addEventListener("click", async () => {
      if (!confirm("确定要清空本地 IndexedDB 修改并恢复至初始预烘焙镜像吗？")) return;
      this.#toast("正在重置持久化磁盘…");
      await this.#vmManager.resetToFactoryDisk();
    });

    for (const btn of this.#dialog.querySelectorAll<HTMLButtonElement>("[data-mem-preset]")) {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.memPreset;
        if (!raw) return;
        const next: MemoryConfigMiB = raw === "auto" ? null : Number(raw);
        if (next !== null && !Number.isFinite(next)) return;
        this.#customMemoryOpen = false;
        this.#vmManager.setMemoryConfig(next);
        this.render();
        const label = formatMemoryLabel(next, this.#vmManager.getAutoMemoryInfo().mib);
        if (this.#vmManager.hasPendingMemoryChange()) {
          this.#toast(`已设为 ${label}，点击「同步并重启」或刷新页面后生效`);
        } else {
          this.#toast(`已设为 ${label}（与当前运行内存一致）`);
        }
      });
    }

    q("#btn-mem-custom")?.addEventListener("click", () => {
      const effectiveMem = this.#vmManager.getEffectiveMemoryConfig();
      const isCustom = effectiveMem !== null && !isPresetMemoryMiB(effectiveMem);
      if (isCustom) {
        const input = q<HTMLInputElement>("#input-memory-mib");
        input?.focus();
        input?.select();
        return;
      }
      this.#customMemoryOpen = !this.#customMemoryOpen;
      this.render();
      if (this.#customMemoryOpen) {
        const input = q<HTMLInputElement>("#input-memory-mib");
        input?.focus();
        input?.select();
      }
    });

    const saveCustomMemory = () => {
      const input = q<HTMLInputElement>("#input-memory-mib");
      const res = validateCustomMemoryInput(input?.value ?? "");
      if (!res.ok) {
        this.#toast(res.error);
        input?.focus();
        return;
      }
      this.#customMemoryOpen = !isPresetMemoryMiB(res.mib);
      this.#vmManager.setMemoryConfig(res.mib);
      this.render();
      const label = formatMemoryLabel(res.mib);
      if (this.#vmManager.hasPendingMemoryChange()) {
        this.#toast(`已设为 ${label}，点击「同步并重启」或刷新页面后生效`);
      } else {
        this.#toast(`已设为 ${label}（与当前运行内存一致）`);
      }
    };

    q("#btn-save-memory")?.addEventListener("click", saveCustomMemory);
    q<HTMLInputElement>("#input-memory-mib")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveCustomMemory();
      }
    });

    q<HTMLButtonElement>("#btn-apply-memory-restart")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "同步重启中…";
      this.#toast("正在同步持久化磁盘并重启虚拟机…");
      await this.#vmManager.syncAndReload();
    });

    for (const btn of this.#dialog.querySelectorAll<HTMLButtonElement>("[data-net-mode]")) {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.netMode as NetMode;
        if (mode !== "builtin" && mode !== "custom" && mode !== "off") return;
        this.#vmManager.setNetworkConfig(mode);
        this.render();
        const label = mode === "builtin" ? "内置同源代理 (/wisp)" : mode === "custom" ? "自定义 Wisp 代理" : "离线模式";
        this.#toast(`已切换至${label}，刷新页面后生效`);
      });
    }

    q("#btn-save-wisp")?.addEventListener("click", () => {
      const input = q<HTMLInputElement>("#input-wisp-url");
      const val = input?.value.trim() ?? "";
      this.#vmManager.setNetworkConfig("custom", val);
      this.#toast("已保存自定义 Wisp 代理地址，刷新页面后生效");
    });
  }

  async #switchDir(dir: string): Promise<void> {
    try {
      const pty = await this.#vmManager.startSession("nvim", this.#terminal.getSize(), dir);
      this.#terminal.attachPty(pty);
      this.close();
    } catch (err) {
      this.#toast(`切换工作区失败: ${(err as Error)?.message ?? String(err)}`);
    }
  }
}
