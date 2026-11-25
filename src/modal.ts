// SPDX-License-Identifier: MIT
// Minimalist Modal Control Center for unkernel-nvim.
// Provides local directory mounting (9p), workspace switching, session switching,
// font sizing, disk persistence/export/import/reset, and runtime diagnostics.

import { formatDiskGiB, GIB, MAX_DISK_GIB, parseDiskGiB } from "./disk-config.ts";
import { DISTROS, isDistro } from "./distro.ts";
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
import { type CanvasTerminal } from "./terminal.ts";
import { MAX_TERMINAL_SESSIONS, type SessionMode } from "./terminal-sessions.ts";
import { getSameOriginWispUrl, type NetMode, type VmManager } from "./vm-manager.ts";

const MODAL_TABS = ["workspace", "storage", "system"] as const;
type ModalTab = (typeof MODAL_TABS)[number];
type DiskAction = "storage" | "restart";

function escapeHtml(val: string): string {
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
  onOpenPreview: () => void;
  onOpenSession: (mode: SessionMode, opts?: { cwd?: string; replaceActive?: boolean }) => Promise<void>;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => Promise<void>;
  toast: (msg: string) => void;
}

export class ModalController {
  #backdrop: HTMLElement;
  #dialog: HTMLElement;
  #pill: HTMLButtonElement;
  #vmManager: VmManager;
  #terminal: CanvasTerminal;
  #toast: (msg: string) => void;
  #onOpenPreview: () => void;
  #onOpenSession: (mode: SessionMode, opts?: { cwd?: string; replaceActive?: boolean }) => Promise<void>;
  #onSelectSession: (id: string) => void;
  #onCloseSession: (id: string) => Promise<void>;
  #tab: ModalTab = "workspace";
  #open = false;
  #pillHidden = localStorage.getItem("unkernel-nvim.hidePill") === "1";
  #customMemoryOpen = false;
  #startingSession = false;
  #diskAction: DiskAction | null = null;

  constructor(opts: ModalControllerOptions) {
    this.#backdrop = opts.backdrop;
    this.#dialog = opts.dialog;
    this.#pill = opts.pill;
    this.#vmManager = opts.vmManager;
    this.#terminal = opts.terminal;
    this.#toast = opts.toast;
    this.#onOpenPreview = opts.onOpenPreview;
    this.#onOpenSession = opts.onOpenSession;
    this.#onSelectSession = opts.onSelectSession;
    this.#onCloseSession = opts.onCloseSession;

    if (this.#pillHidden) {
      this.#pill.classList.add("hidden-pill");
    }

    this.#pill.addEventListener("click", () => this.toggle());
    this.#backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.#backdrop) {
        this.close();
      }
    });

    this.#dialog.querySelector("#btn-close-modal")!.addEventListener("click", () => this.close());
    this.#dialog.querySelector("#btn-apply-restart")!.addEventListener("click", () => {
      void this.#restart();
    });
    for (const tab of MODAL_TABS) {
      const button = this.#tabButton(tab);
      button.addEventListener("click", () => this.#selectTab(tab));
      button.addEventListener("keydown", (e) => this.#onTabKey(e, tab));
    }

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
        if (!this.#open) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        } else if (e.key === "Tab") {
          this.#keepFocusInDialog(e);
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

  open(tab: ModalTab = this.#tab): void {
    if (!this.#vmManager.vm) return;
    this.#open = true;
    this.render();
    this.#backdrop.classList.remove("hidden");
    this.#selectTab(tab);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#customMemoryOpen = false;
    this.#backdrop.classList.add("hidden");
    this.#dialog.querySelector("#modal-feedback")!.textContent = "";
    this.#terminal.focus();
  }

  render(): void {
    const modeTag = this.#vmManager.isSnapshotMode ? " · 内存快照（临时）" : "";
    this.#dialog.querySelector(".modal-subtitle")!.textContent =
      `${DISTROS[this.#vmManager.activeDistro].label} aarch64 · DefectingCat/nvim${modeTag}`;
    this.#renderWorkspace();
    this.#renderStorage();
    this.#renderSystem();
  }

  #tabButton(tab: ModalTab): HTMLButtonElement {
    return this.#dialog.querySelector<HTMLButtonElement>(`#modal-tab-${tab}`)!;
  }

  #panel(tab: ModalTab): HTMLElement {
    return this.#dialog.querySelector<HTMLElement>(`#modal-panel-${tab}`)!;
  }

  #selectTab(tab: ModalTab): void {
    this.#tab = tab;
    for (const candidate of MODAL_TABS) {
      const selected = candidate === tab;
      const button = this.#tabButton(candidate);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      this.#panel(candidate).hidden = !selected;
    }
    this.#tabButton(tab).focus();
  }

  #onTabKey(e: KeyboardEvent, tab: ModalTab): void {
    const index = MODAL_TABS.indexOf(tab);
    const last = MODAL_TABS.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    this.#selectTab(MODAL_TABS[next]);
  }

  #keepFocusInDialog(e: KeyboardEvent): void {
    const focusable = [...this.#dialog.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']",
    )].filter((el) => el.tabIndex >= 0 && !el.closest("[hidden]"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (!this.#dialog.contains(active) || active === (e.shiftKey ? first : last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  #renderWorkspace(): void {
    const panel = this.#panel("workspace");
    const pickerSupported = isDirectoryPickerSupported();
    const mounts = [...this.#vmManager.mountedFolders.values()];
    const { activeSession, activeSessionId, currentCwd, currentMode, sessions } = this.#vmManager;
    const distro = DISTROS[this.#vmManager.activeDistro].label;
    const atLimit = sessions.length >= MAX_TERMINAL_SESSIONS;
    panel.innerHTML = `
      <div class="modal-section">
        <h3 class="modal-section-title">本地目录与常用路径</h3>
        <div class="modal-grid">
          <button class="modal-btn primary" id="btn-mount-dir" type="button" ${pickerSupported ? "" : "disabled"}>
            <span>挂载本地文件夹…</span>
            <span class="modal-btn-desc">${pickerSupported ? "直接读写宿主机目录 (/workspace/*)" : "需 Chrome / Edge 浏览器"}</span>
          </button>
          <button class="modal-btn" id="btn-open-workspace" type="button">
            <span>打开 /workspace</span>
            <span class="modal-btn-desc">在工作区启动 Neovim</span>
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
                    <span class="mount-item-path">${escapeHtml(m.guestPath)}</span>
                    <div class="mount-item-actions">
                      <button class="mini-btn" data-open-mount="${escapeHtml(m.guestPath)}" type="button">在 Neovim 中打开</button>
                      <button class="mini-btn" data-unmount="${escapeHtml(m.guestPath)}" type="button">卸载</button>
                    </div>
                  </div>`,
                  )
                  .join("")}
              </div>`
            : ""
        }
      </div>

      <div class="modal-section">
        <h3 class="modal-section-title">会话与终端 (${sessions.length}/${MAX_TERMINAL_SESSIONS})</h3>
        ${
          sessions.length > 0
            ? `<div class="mount-list">
                ${sessions
                  .map((s) => {
                    const isActive = s.id === activeSessionId;
                    const statusLabel = s.exited
                      ? `已退出${typeof s.exitCode === "number" ? ` (${s.exitCode})` : ""}`
                      : isActive
                        ? "当前活跃"
                        : "后台运行";
                    return `
                  <div class="mount-item">
                    <span class="mount-item-path">${escapeHtml(s.title)} · <code>${escapeHtml(s.cwd)}</code> · <span class="row-hint">${escapeHtml(statusLabel)}</span></span>
                    <div class="mount-item-actions">
                      <button class="mini-btn ${isActive ? "active" : ""}" data-select-session="${escapeHtml(s.id)}" type="button" ${isActive ? "disabled" : ""}>${isActive ? "当前" : "切换"}</button>
                      <button class="mini-btn" data-close-session="${escapeHtml(s.id)}" type="button">关闭</button>
                    </div>
                  </div>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
        <div class="modal-grid">
          <button class="modal-btn" id="btn-new-nvim" type="button" ${atLimit ? "disabled" : ""}>
            <span>新建 Neovim 标签</span>
            <span class="modal-btn-desc">工作目录 <code>${escapeHtml(currentCwd)}</code></span>
          </button>
          <button class="modal-btn" id="btn-new-shell" type="button" ${atLimit ? "disabled" : ""}>
            <span>新建 ${distro} Shell 标签</span>
            <span class="modal-btn-desc">后台并存，不中断当前 Neovim</span>
          </button>
          <button class="modal-btn" id="btn-restart-session" type="button">
            <span>${activeSession ? `重启当前 ${escapeHtml(activeSession.title)}` : "启动 Neovim"}</span>
            <span class="modal-btn-desc">${currentMode === "nvim" ? "在当前目录重建 Neovim" : `在当前目录重建 ${escapeHtml(this.#vmManager.shellName)}`}</span>
          </button>
          <button class="modal-btn" id="btn-open-preview" type="button">
            <span>Guest 端口预览</span>
            <span class="modal-btn-desc">打开虚拟机内的网页与开发服务器</span>
          </button>
        </div>
        <div class="row-bar">
          <span class="row-label">终端快捷键</span>
          <div class="row-controls">
            <kbd>Ctrl+⇧+←/→</kbd>
            <span class="row-hint">切换标签</span>
            <kbd>Ctrl+⇧+\\</kbd>
            <span class="row-hint">快速切 Shell</span>
          </div>
        </div>
        <div class="row-bar">
          <span class="row-label">终端字号</span>
          <div class="row-controls">
            <button class="mini-btn" id="btn-font-dec" type="button" aria-label="减小字号">−</button>
            <span id="label-font-size">${this.#terminal.getFontSize()} px</span>
            <button class="mini-btn" id="btn-font-inc" type="button" aria-label="增大字号">+</button>
          </div>
        </div>
        <div class="row-bar">
          <span class="row-label" id="label-menu-pill">右上角快捷入口</span>
          <div class="row-controls">
            <kbd>${this.#pill.querySelector("kbd")?.textContent ?? "Ctrl+⇧+P"}</kbd>
            <button class="mini-btn" id="btn-toggle-pill" type="button" role="switch" aria-labelledby="label-menu-pill" aria-checked="${!this.#pillHidden}">
              ${this.#pillHidden ? "隐藏" : "显示"}
            </button>
          </div>
        </div>
      </div>
    `;
    this.#bindWorkspaceEvents(panel);
  }

  #renderStorage(): void {
    const panel = this.#panel("storage");
    const distro = DISTROS[this.#vmManager.activeDistro].label;
    const { diskSize, targetDiskSize, isSnapshotMode, diskNotice, lastDiskError } = this.#vmManager;
    panel.innerHTML = `
      ${
        lastDiskError
          ? `<div class="row-bar modal-danger" role="alert">
              <div class="row-label-group">
                <span class="row-label">磁盘持久化警告${lastDiskError.isQuota ? "（存储配额已满）" : ""}</span>
                <span class="row-hint">${escapeHtml(lastDiskError.message)}</span>
              </div>
            </div>`
          : ""
      }
      ${
        isSnapshotMode
          ? `<div class="row-bar modal-notice" role="status">
              <div class="row-label-group">
                <span class="row-label">当前处于内存快照模式（临时副本）</span>
                <span class="row-hint">${escapeHtml(diskNotice ? `内核说明：${diskNotice}。` : "")}所有文件修改仅保留在浏览器内存中，不会写回 IndexedDB，仍可导出 .kwsparse.gz 备份。</span>
              </div>
            </div>`
          : ""
      }
      <div class="modal-section">
        <h3 class="modal-section-title">${distro} ${isSnapshotMode ? "内存快照磁盘" : "持久化磁盘"}</h3>
        <form class="row-bar" id="form-disk-size">
          <div class="row-label-group">
            <label class="row-label" for="input-disk-gib">数据盘容量</label>
            <span class="row-hint" id="disk-size-hint">当前 ${formatDiskGiB(diskSize)}${!isSnapshotMode && diskSize < targetDiskSize ? ` · 下次启动 ${formatDiskGiB(targetDiskSize)}` : isSnapshotMode ? " · 内存副本不可扩容" : " · 按实际写入占用浏览器存储"}</span>
          </div>
          <div class="row-controls row-input-controls">
            <input class="text-input" id="input-disk-gib" aria-describedby="disk-size-hint" type="number" inputmode="numeric"
              min="${Math.ceil(diskSize / GIB)}" max="${MAX_DISK_GIB}" step="1" value="${Math.ceil(targetDiskSize / GIB)}" required />
            <span class="row-unit">GiB</span>
            <button class="mini-btn" id="btn-save-disk-size" type="submit">保存容量</button>
          </div>
        </form>
        <div class="modal-grid">
          <button class="modal-btn" id="btn-sync-disk" type="button">
            <span>立即同步落盘 (Sync)</span>
            <span class="modal-btn-desc">${isSnapshotMode ? "内存快照模式不写入 IndexedDB" : "将文件修改刷新到 IndexedDB"}</span>
          </button>
          <button class="modal-btn" id="btn-export-disk" type="button">
            <span>导出磁盘备份 (.kwsparse.gz)</span>
            <span class="modal-btn-desc">下载当前完整系统与配置状态</span>
          </button>
          <button class="modal-btn" id="btn-import-disk" type="button">
            <span>导入磁盘备份…</span>
            <span class="modal-btn-desc">从 ${distro} 的 .kwsparse.gz 备份恢复</span>
          </button>
          <button class="modal-btn" id="btn-suspend-session" type="button">
            <span>挂起会话</span>
            <span class="modal-btn-desc">${isSnapshotMode ? "内存快照模式不支持挂起" : "保存虚拟机内存与终端，稍后恢复"}</span>
          </button>
        </div>
        <input type="file" id="input-import-disk" accept=".gz,.kwsparse" hidden />
      </div>
      <div class="row-bar modal-danger">
        <div class="row-label-group">
          <span class="row-label">恢复出厂镜像</span>
          <span class="row-hint">${isSnapshotMode ? "请关闭其他标签页并以持久化模式启动后再重置。" : "清空浏览器内的磁盘改动，还原初始系统。"}</span>
        </div>
        <button class="mini-btn" id="btn-reset-disk" type="button">恢复出厂镜像…</button>
      </div>
    `;
    this.#bindStorageEvents(panel);
    this.#updateStorageButtons();
  }

  #renderSystem(): void {
    const panel = this.#panel("system");
    const diag = this.#vmManager.getStats();
    const jit = diag.stats?.jit;
    const diskMiB = ((diag.diskBlocks * 4096) / 1048576).toFixed(1);
    const { cpuCount, cpuLimit, cpuBlocker } = this.#vmManager;
    const { activeDistro, distro } = this.#vmManager;
    const cpuLabel = diag.cpus === null ? "—" : `${diag.cpus} 核`;
    let cpuHint = `此设备最多 ${cpuLimit} 核`;
    if (cpuBlocker) {
      cpuHint = diag.crossOriginIsolated ? "当前浏览器环境仅支持单核" : "多核需要跨源隔离";
    } else if (cpuLimit === 1) {
      cpuHint = "浏览器仅提供 1 个逻辑处理器";
    } else if (this.#vmManager.hasPendingCpuChange()) {
      cpuHint = `下次启动使用 ${cpuCount} 核`;
    } else if (diag.cpus !== null && diag.cpus !== cpuCount) {
      cpuHint = `配置 ${cpuCount} 核，实际在线 ${diag.cpus} 核`;
    }
    const effectiveMem = this.#vmManager.getEffectiveMemoryConfig();
    const autoMem = this.#vmManager.getAutoMemoryInfo();
    const isAutoMem = effectiveMem === null;
    const isCustomMem = effectiveMem !== null && !isPresetMemoryMiB(effectiveMem);
    const showCustomMemRow = this.#customMemoryOpen || isCustomMem;
    const customMemInputVal = effectiveMem ?? (diag.memoryMiB || autoMem.mib);

    let memoryHint: string;
    if (this.#vmManager.hasPendingMemoryChange()) {
      const target = formatMemoryLabel(effectiveMem, autoMem.mib);
      memoryHint = `当前 ${diag.memoryMiB} MiB → 下次启动 ${target}`;
    } else if (this.#vmManager.hasUrlMemoryOverride()) {
      memoryHint = `URL 参数 ?mem 临时覆盖（当前 ${diag.memoryMiB} MiB）`;
    } else if (diag.memoryFallback) {
      memoryHint = `目标 ${diag.memoryRequestedMiB} MiB 分配失败，已回退至 ${diag.memoryMiB} MiB`;
    } else if (isAutoMem) {
      memoryHint = `自动策略（当前 ${diag.memoryMiB} MiB）`;
    } else {
      memoryHint = `已分配 ${diag.memoryMiB} MiB`;
    }

    panel.innerHTML = `
      <div class="modal-section">
        <h3 class="modal-section-title">运行时性能与诊断</h3>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-key">Worker 传输通道</div>
            <div class="stat-val">${diag.transport === "shared" ? "SharedArrayBuffer" : escapeHtml(diag.transport)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">Canvas 渲染器</div>
            <div class="stat-val">${this.#terminal.webglActive ? "WebGL2 GPU" : "Canvas Fallback"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">虚拟机 CPU / 内存</div>
            <div class="stat-val"><span id="stat-cpus">${cpuLabel}</span> · ${diag.memoryMiB} MiB${diag.memoryFallback ? " · 回退" : ""}</div>
            <div class="stat-detail">${jit ? `${jit.compiled} 块已编译` : "JIT 已启用"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">持久化存储占用</div>
            <div class="stat-val" id="stat-disk-size">${diskMiB} MiB</div>
            <div class="stat-detail" id="stat-disk-blocks">${diag.diskBlocks} 块</div>
          </div>
        </div>
      </div>
      <div class="modal-section">
        <h3 class="modal-section-title">虚拟机配置</h3>
        <div class="row-bar">
          <div class="row-label-group">
            <label class="row-label" for="select-distro">Linux 发行版</label>
            <span class="row-hint" id="distro-hint">当前 ${DISTROS[activeDistro].label} · 两个发行版各自保存磁盘</span>
          </div>
          <div class="row-controls">
            <select class="text-input" id="select-distro" aria-describedby="distro-hint">
              ${Object.entries(DISTROS).map(([value, { label }]) =>
                `<option value="${value}" ${value === distro ? "selected" : ""}>${label}</option>`
              ).join("")}
            </select>
          </div>
        </div>
        <div class="row-bar">
          <div class="row-label-group">
            <label class="row-label" for="select-vcpus">虚拟 CPU 核数</label>
            <span class="row-hint" id="cpu-hint">${cpuHint}</span>
          </div>
          <div class="row-controls">
            <select class="text-input" id="select-vcpus" aria-describedby="cpu-hint" ${cpuLimit === 1 ? "disabled" : ""}>
              ${Array.from({ length: cpuLimit }, (_, i) => {
                const cpus = i + 1;
                return `<option value="${cpus}" ${cpus === cpuCount ? "selected" : ""}>${cpus} 核</option>`;
              }).join("")}
            </select>
          </div>
        </div>
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label">虚拟机内存配额</span>
            <span class="row-hint">${memoryHint}</span>
          </div>
          <div class="row-controls" role="group" aria-label="内存配额">
            <button class="mini-btn" aria-pressed="${isAutoMem && !this.#customMemoryOpen}" data-mem-preset="auto" type="button">自动</button>
            ${MEMORY_PRESETS_MIB.map((mib) => {
              const label = mib >= 1024 ? `${mib / 1024}G` : `${mib}M`;
              const active = effectiveMem === mib && !this.#customMemoryOpen;
              return `<button class="mini-btn" aria-pressed="${active}" data-mem-preset="${mib}" type="button">${label}</button>`;
            }).join("")}
            <button class="mini-btn" aria-expanded="${showCustomMemRow}" id="btn-mem-custom" type="button">自定义</button>
          </div>
        </div>
        ${
          showCustomMemRow
            ? `<div class="row-bar">
                <label class="row-label" for="input-memory-mib">自定义内存 (${MEMORY_MIN_MIB}–${MEMORY_MAX_MIB} MiB)</label>
                <div class="row-controls row-input-controls">
                  <input
                    class="text-input"
                    id="input-memory-mib"
                    type="number"
                    inputmode="numeric"
                    min="${MEMORY_MIN_MIB}"
                    max="${MEMORY_MAX_MIB}"
                    step="64"
                    placeholder="例如 1536"
                    value="${customMemInputVal}"
                  />
                  <span class="row-unit">MiB</span>
                  <button class="mini-btn" id="btn-save-memory" type="button">保存</button>
                </div>
              </div>`
            : ""
        }
        <div class="row-bar">
          <span class="row-label">虚拟机联网模式 (Wisp)</span>
          <div class="row-controls" role="group" aria-label="联网模式">
            <button class="mini-btn" aria-pressed="${this.#vmManager.netMode === "builtin"}" data-net-mode="builtin" type="button">内置代理 (/wisp)</button>
            <button class="mini-btn" aria-pressed="${this.#vmManager.netMode === "custom"}" data-net-mode="custom" type="button">自定义</button>
            <button class="mini-btn" aria-pressed="${this.#vmManager.netMode === "off"}" data-net-mode="off" type="button">离线</button>
          </div>
        </div>
        ${
          this.#vmManager.netMode === "builtin"
            ? `<div class="row-bar">
                <span class="row-label">同源代理地址</span>
                <span class="stat-val">${escapeHtml(getSameOriginWispUrl())}</span>
              </div>`
            : this.#vmManager.netMode === "custom"
              ? `<div class="row-bar">
                  <label class="row-label" for="input-wisp-url">自定义 Wisp 地址</label>
                  <div class="row-controls row-input-controls">
                    <input
                      class="text-input"
                      id="input-wisp-url"
                      type="text"
                      placeholder="wss://your-wisp-proxy/"
                      value="${escapeHtml(this.#vmManager.wispUrl)}"
                    />
                    <button class="mini-btn" id="btn-save-wisp" type="button">保存</button>
                  </div>
                </div>`
              : ""
        }
      </div>
    `;

    this.#bindSystemEvents(panel);
    this.#renderRestart();
  }

  #bindWorkspaceEvents(panel: HTMLElement): void {
    const q = (sel: string) => panel.querySelector<HTMLButtonElement>(sel)!;

    q("#btn-mount-dir").addEventListener("click", async () => {
      const button = q("#btn-mount-dir");
      button.disabled = true;
      try {
        const dirFs = await pickHostDirectory();
        this.#toast(`正在挂载本地目录 ${dirFs.name}…`);
        const mounted = await this.#vmManager.mountHostDirectory(dirFs);
        this.#renderWorkspace();
        this.#toast(`已挂载 ${mounted.guestPath}`);
        await this.#switchSession("nvim", mounted.guestPath);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        this.#toast(`挂载失败: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        button.disabled = false;
      }
    });

    q("#btn-open-workspace").addEventListener("click", () => {
      void this.#switchSession("nvim", "/workspace", Boolean(this.#vmManager.activeSession?.exited));
    });

    q("#btn-open-nvim-config").addEventListener("click", () => {
      void this.#switchSession("nvim", "/root/.config/nvim", Boolean(this.#vmManager.activeSession?.exited));
    });

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-open-mount]")) {
      btn.addEventListener("click", () => {
        void this.#switchSession("nvim", btn.dataset.openMount!, Boolean(this.#vmManager.activeSession?.exited));
      });
    }

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-select-session]")) {
      btn.addEventListener("click", () => {
        this.#onSelectSession(btn.dataset.selectSession!);
        this.close();
      });
    }

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-close-session]")) {
      btn.addEventListener("click", async () => {
        if (this.#startingSession || this.#diskAction) return;
        await this.#onCloseSession(btn.dataset.closeSession!);
        if (this.#open) this.#renderWorkspace();
      });
    }

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-unmount]")) {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.unmount!;
        const entry = this.#vmManager.mountedFolders.get(path);
        if (!entry) return;
        await entry.mount.unmount().catch(() => {});
        this.#vmManager.mountedFolders.delete(path);
        this.#toast(`已卸载 ${path}`);
        const hadFocus = panel.contains(document.activeElement);
        this.#renderWorkspace();
        if (hadFocus) q("#btn-open-workspace").focus();
      });
    }

    q("#btn-new-nvim").addEventListener("click", () => {
      void this.#switchSession("nvim", undefined, false);
    });

    q("#btn-new-shell").addEventListener("click", () => {
      void this.#switchSession("shell", undefined, false);
    });

    q("#btn-restart-session").addEventListener("click", () => {
      const active = this.#vmManager.activeSession;
      void this.#switchSession(active?.mode ?? "nvim", active?.cwd, Boolean(active));
    });

    q("#btn-open-preview").addEventListener("click", () => {
      if (this.#diskAction) return;
      this.close();
      this.#onOpenPreview();
    });

    const fontLabel = panel.querySelector("#label-font-size")!;
    const resizeFont = (delta: number) => {
      this.#terminal.setFontSize(this.#terminal.getFontSize() + delta);
      fontLabel.textContent = `${this.#terminal.getFontSize()} px`;
    };
    q("#btn-font-dec").addEventListener("click", () => resizeFont(-1));
    q("#btn-font-inc").addEventListener("click", () => resizeFont(1));

    const pillToggle = q("#btn-toggle-pill");
    pillToggle.addEventListener("click", () => {
      this.#pillHidden = !this.#pillHidden;
      localStorage.setItem("unkernel-nvim.hidePill", this.#pillHidden ? "1" : "0");
      this.#pill.classList.toggle("hidden-pill", this.#pillHidden);
      pillToggle.setAttribute("aria-checked", String(!this.#pillHidden));
      pillToggle.textContent = this.#pillHidden ? "隐藏" : "显示";
    });
  }

  #bindStorageEvents(panel: HTMLElement): void {
    const q = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel)!;
    const run = (action: () => Promise<void>) => () => void this.#runDiskAction("storage", action);

    q<HTMLFormElement>("#form-disk-size").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = q<HTMLInputElement>("#input-disk-gib");
      const gib = parseDiskGiB(input.value);
      if (gib === undefined || !this.#vmManager.setDiskSize(gib)) {
        this.#toast("请输入不小于当前容量的整数 GiB");
        input.focus();
        return;
      }
      this.#renderStorage();
      this.#renderRestart();
      q("#btn-save-disk-size").focus();
    });

    q("#btn-sync-disk").addEventListener("click", run(async () => {
      this.#toast("正在同步文件系统到 IndexedDB…");
      const ok = await this.#vmManager.syncDisk();
      this.#toast(ok ? "已落盘保存至 IndexedDB" : "磁盘同步失败，请重试");
      const { diskBlocks } = this.#vmManager.getStats();
      this.#panel("system").querySelector("#stat-disk-size")!.textContent = `${((diskBlocks * 4096) / 1048576).toFixed(1)} MiB`;
      this.#panel("system").querySelector("#stat-disk-blocks")!.textContent = `${diskBlocks} 块`;
      this.#renderStorage();
    }));

    q("#btn-export-disk").addEventListener("click", run(async () => {
      try {
        this.#toast("正在导出压缩磁盘镜像…");
        const res = await this.#vmManager.exportDiskImage();
        const mb = (res.bytes / 1048576).toFixed(1);
        this.#toast(`已导出 ${res.name} (${mb} MiB)`);
      } catch (err) {
        this.#toast(`导出失败: ${(err as Error)?.message ?? String(err)}`);
      }
    }));

    q("#btn-suspend-session").addEventListener("click", run(async () => {
      if (this.#startingSession) {
        this.#toast("请等待终端启动后再挂起");
        return;
      }
      this.#toast("正在保存虚拟机内存与终端…");
      try {
        await this.#vmManager.suspendSession();
      } catch (err) {
        this.#toast(`挂起失败：${(err as Error)?.message ?? String(err)}`);
      }
    }));

    const fileInput = q<HTMLInputElement>("#input-import-disk");
    q("#btn-import-disk").addEventListener("click", () => {
      fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      fileInput.value = "";
      await this.#runDiskAction("storage", async () => {
        try {
          this.#toast(`正在导入镜像 ${file.name}…`);
          await this.#vmManager.importDiskImage(file);
        } catch (err) {
          this.#toast(`导入失败: ${(err as Error)?.message ?? String(err)}`);
        }
      });
    });

    q("#btn-reset-disk").addEventListener("click", run(async () => {
      if (!confirm("确定要清空本地 IndexedDB 修改并恢复至初始预烘焙镜像吗？")) return;
      try {
        this.#toast("正在重置持久化磁盘…");
        await this.#vmManager.resetToFactoryDisk();
      } catch (err) {
        this.#toast(`恢复出厂镜像失败: ${(err as Error)?.message ?? String(err)}`);
      }
    }));
  }

  #bindSystemEvents(panel: HTMLElement): void {
    const q = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel);

    const distroSelect = q<HTMLSelectElement>("#select-distro")!;
    distroSelect.addEventListener("change", () => {
      if (!isDistro(distroSelect.value)) return;
      this.#vmManager.setDistro(distroSelect.value);
      this.#renderRestart();
    });

    const cpuSelect = q<HTMLSelectElement>("#select-vcpus")!;
    cpuSelect.addEventListener("change", () => {
      this.#vmManager.setCpuCount(Number(cpuSelect.value));
      this.#renderSystem();
      q("#select-vcpus")?.focus();
    });

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-mem-preset]")) {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.memPreset;
        if (!raw) return;
        const next: MemoryConfigMiB = raw === "auto" ? null : Number(raw);
        if (next !== null && !Number.isFinite(next)) return;
        this.#setMemoryConfig(next);
        q(`[data-mem-preset="${raw}"]`)?.focus();
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
      this.#renderSystem();
      if (this.#customMemoryOpen) {
        const input = q<HTMLInputElement>("#input-memory-mib");
        input?.focus();
        input?.select();
      } else {
        q("#btn-mem-custom")?.focus();
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
      this.#setMemoryConfig(res.mib);
      (q("#btn-save-memory") ?? q(`[data-mem-preset="${res.mib}"]`))?.focus();
    };

    q("#btn-save-memory")?.addEventListener("click", saveCustomMemory);
    q<HTMLInputElement>("#input-memory-mib")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveCustomMemory();
      }
    });

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-net-mode]")) {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.netMode as NetMode;
        if (mode !== "builtin" && mode !== "custom" && mode !== "off") return;
        this.#vmManager.setNetworkConfig(mode);
        this.#renderSystem();
        (q("#input-wisp-url") ?? q(`[data-net-mode="${mode}"]`))?.focus();
      });
    }

    const wispInput = q<HTMLInputElement>("#input-wisp-url");
    if (wispInput) {
      const saveWisp = () => {
        wispInput.value = wispInput.value.trim();
        this.#vmManager.setNetworkConfig("custom", wispInput.value);
        this.#renderRestart();
        this.#toast("已保存自定义 Wisp 地址");
      };
      q("#btn-save-wisp")?.addEventListener("click", saveWisp);
      wispInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        saveWisp();
      });
    }
  }

  #setMemoryConfig(next: MemoryConfigMiB): void {
    this.#customMemoryOpen = next !== null && !isPresetMemoryMiB(next);
    this.#vmManager.setMemoryConfig(next);
    this.#renderSystem();
    this.#toast(`已保存内存配额 ${formatMemoryLabel(next, this.#vmManager.getAutoMemoryInfo().mib)}`);
  }

  #renderRestart(): void {
    const banner = this.#dialog.querySelector<HTMLElement>("#modal-restart")!;
    const message = banner.querySelector("#modal-restart-message")!;
    const button = banner.querySelector<HTMLButtonElement>("#btn-apply-restart")!;
    const restarting = this.#diskAction === "restart";
    banner.hidden = !restarting && !this.#vmManager.hasPendingRestartChanges();
    if (banner.hidden) {
      message.textContent = "";
      return;
    }
    const settings = [
      this.#vmManager.hasPendingDistroChange() ? "发行版" : null,
      this.#vmManager.hasPendingCpuChange() ? "CPU 核数" : null,
      this.#vmManager.hasPendingMemoryChange() ? "内存配额" : null,
      this.#vmManager.hasPendingNetworkChange() ? "Wisp 网络" : null,
      this.#vmManager.hasPendingDiskSizeChange() ? "数据盘容量" : null,
    ].filter(Boolean).join("、");
    message.textContent = restarting
      ? (this.#vmManager.isSnapshotMode ? "正在重新加载…" : "正在同步持久化磁盘…")
      : `${settings}将在重启后生效`;
    button.disabled = this.#diskAction !== null;
    button.textContent = restarting
      ? "正在重启…"
      : (this.#vmManager.isSnapshotMode ? "重新加载" : "同步并重启");
  }

  #updateStorageButtons(): void {
    const busyOrNoVm = this.#diskAction !== null || !this.#vmManager.vm;
    const snapshotMode = this.#vmManager.isSnapshotMode;
    for (const control of this.#panel("storage").querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) {
      const keepInSnapshot = control.id === "btn-export-disk";
      control.disabled = busyOrNoVm || (snapshotMode && !keepInSnapshot);
    }
  }

  async #runDiskAction(kind: DiskAction, action: () => Promise<void>): Promise<void> {
    if (this.#diskAction) return;
    this.#diskAction = kind;
    this.#updateStorageButtons();
    this.#renderRestart();
    try {
      await action();
    } finally {
      this.#diskAction = null;
      this.#updateStorageButtons();
      this.#renderRestart();
    }
  }

  #restart(): Promise<void> {
    return this.#runDiskAction("restart", async () => {
      try {
        await this.#vmManager.syncAndReload();
      } catch (err) {
        this.#toast(`重启失败: ${(err as Error)?.message ?? String(err)}`);
      }
    });
  }

  async #switchSession(mode: SessionMode, dir?: string, replaceActive = false): Promise<void> {
    if (this.#startingSession || this.#diskAction) return;
    this.#startingSession = true;
    try {
      await this.#onOpenSession(mode, { cwd: dir, replaceActive });
      this.close();
    } catch (err) {
      this.#toast(`启动${mode === "nvim" ? " Neovim" : " Shell"}失败: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      this.#startingSession = false;
    }
  }
}
