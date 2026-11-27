// SPDX-License-Identifier: MIT
// Minimalist Modal Control Center for unkernel-nvim.
// Provides local directory mounting (9p), workspace switching, session switching,
// font sizing, disk persistence/export/import/reset, and runtime diagnostics.

import { formatDiskGiB, GIB, MAX_DISK_GIB, parseDiskGiB } from "./disk-config.ts";
import { formatByteSize } from "./diagnostics.ts";
import { formatWaylandScale, WAYLAND_SCALE_PRESETS } from "./desktop-state.ts";
import type { DesktopDisplayConfig } from "./desktop-shell.ts";
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
import { formatFetchRoutesText, parseFetchRoutesText } from "./net-routes.ts";
import { type CanvasTerminal } from "./terminal.ts";
import { MAX_TERMINAL_SESSIONS, type SessionMode } from "./terminal-sessions.ts";
import { getSameOriginWispUrl, type NetMode, type VmManager } from "./vm-manager.ts";
import type { WaylandBridgeStatus } from "./wayland-bridge.ts";

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
  isDesktopMode?: () => boolean;
  onToggleDesktop?: () => void;
  onOpenLauncher?: () => void;
  getWaylandStatus?: () => WaylandBridgeStatus | undefined;
  getDesktopDisplayConfig?: () => DesktopDisplayConfig;
  onSetWaylandScale?: (scale: number | null) => void;
  onSetBrowserFullscreen?: (enabled: boolean) => boolean;
  onSetWaylandLodpi?: (enabled: boolean) => void;
  getWallpaperSummary?: () => string;
  onOpenWallpaperPicker?: () => void;
  onCycleWallpaper?: () => void;
  onBeforeOpen?: () => void;
  onAfterClose?: () => void;
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
  #isDesktopMode?: () => boolean;
  #onToggleDesktop?: () => void;
  #onOpenLauncher?: () => void;
  #getWaylandStatus?: () => WaylandBridgeStatus | undefined;
  #getDesktopDisplayConfig?: () => DesktopDisplayConfig;
  #onSetWaylandScale?: (scale: number | null) => void;
  #onSetBrowserFullscreen?: (enabled: boolean) => boolean;
  #onSetWaylandLodpi?: (enabled: boolean) => void;
  #getWallpaperSummary?: () => string;
  #onOpenWallpaperPicker?: () => void;
  #onCycleWallpaper?: () => void;
  #onBeforeOpen?: () => void;
  #onAfterClose?: () => void;
  #tab: ModalTab = "workspace";
  #open = false;
  #pillHidden = localStorage.getItem("unkernel-nvim.hidePill") === "1";
  #customMemoryOpen = false;
  #startingSession = false;
  #diskAction: DiskAction | null = null;
  #logsImportantOnly = false;
  #overlayOutput = "";
  #overlayPendingRestart = false;
  #systemStatsTimer: ReturnType<typeof setInterval> | null = null;

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
    this.#isDesktopMode = opts.isDesktopMode;
    this.#onToggleDesktop = opts.onToggleDesktop;
    this.#onOpenLauncher = opts.onOpenLauncher;
    this.#getWaylandStatus = opts.getWaylandStatus;
    this.#getDesktopDisplayConfig = opts.getDesktopDisplayConfig;
    this.#onSetWaylandScale = opts.onSetWaylandScale;
    this.#onSetBrowserFullscreen = opts.onSetBrowserFullscreen;
    this.#onSetWaylandLodpi = opts.onSetWaylandLodpi;
    this.#getWallpaperSummary = opts.getWallpaperSummary;
    this.#onOpenWallpaperPicker = opts.onOpenWallpaperPicker;
    this.#onCycleWallpaper = opts.onCycleWallpaper;
    this.#onBeforeOpen = opts.onBeforeOpen;
    this.#onAfterClose = opts.onAfterClose;

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
    this.#onBeforeOpen?.();
    this.#open = true;
    this.render();
    this.#backdrop.classList.remove("hidden");
    this.#selectTab(tab);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#customMemoryOpen = false;
    this.#stopSystemStatsTimer();
    this.#backdrop.classList.add("hidden");
    this.#dialog.querySelector("#modal-feedback")!.textContent = "";
    if (this.#onAfterClose) this.#onAfterClose();
    else this.#terminal.focus();
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
    if (tab === "system" && this.#open) {
      this.#startSystemStatsTimer();
    } else {
      this.#stopSystemStatsTimer();
    }
    for (const candidate of MODAL_TABS) {
      const selected = candidate === tab;
      const button = this.#tabButton(candidate);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      this.#panel(candidate).hidden = !selected;
    }
    this.#tabButton(tab).focus();
  }

  #startSystemStatsTimer(): void {
    this.#stopSystemStatsTimer();
    this.#systemStatsTimer = setInterval(() => {
      if (!this.#open || this.#tab !== "system") return;
      this.#refreshLiveSystemStats();
    }, 1500);
  }

  #stopSystemStatsTimer(): void {
    if (this.#systemStatsTimer !== null) {
      clearInterval(this.#systemStatsTimer);
      this.#systemStatsTimer = null;
    }
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
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']",
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
          <button class="modal-btn ${this.#isDesktopMode?.() ? "primary" : ""}" id="btn-toggle-desktop" type="button">
            <span>${this.#isDesktopMode?.() ? "返回全屏终端" : "进入桌面环境 (Wayland)"}</span>
            <span class="modal-btn-desc">浮动终端窗口 + wland Linux GUI 应用</span>
          </button>
          <button class="modal-btn" id="btn-open-launcher" type="button">
            <span>Wayland 应用启动器</span>
            <span class="modal-btn-desc">运行或一键安装 foot / pcmanfm / X11 应用</span>
          </button>
        </div>
        <div class="row-bar">
          <span class="row-label">终端快捷键</span>
          <div class="row-controls">
            <kbd>Ctrl+⇧+←/→</kbd>
            <span class="row-hint">切换标签</span>
            <kbd>Ctrl+⇧+\\</kbd>
            <span class="row-hint">切 Shell</span>
            <kbd>Ctrl+⇧+D</kbd>
            <span class="row-hint">切桌面</span>
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
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label">桌面壁纸</span>
            <span class="row-hint">当前：${escapeHtml(this.#getWallpaperSummary?.() ?? "赤陶余烬")}</span>
          </div>
          <div class="row-controls">
            <button class="mini-btn" id="btn-cycle-wallpaper" type="button">下一张</button>
            <button class="mini-btn active" id="btn-open-wallpaper" type="button">更换壁纸…</button>
          </div>
        </div>
      </div>
    `;
    this.#bindWorkspaceEvents(panel);
  }

  #renderStorage(): void {
    const panel = this.#panel("storage");
    const distro = DISTROS[this.#vmManager.activeDistro].label;
    const { diskSize, targetDiskSize, isSnapshotMode, diskNotice, lastDiskError, autoSuspendEnabled } = this.#vmManager;
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
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label" id="label-auto-suspend">切到后台时自动挂起</span>
            <span class="row-hint" id="hint-auto-suspend">${isSnapshotMode ? "仅持久化磁盘支持自动挂起。" : "关闭可让后台构建继续运行。挂载本地目录时仅同步磁盘。"}</span>
          </div>
          <button class="mini-btn" id="btn-auto-suspend" type="button" role="switch"
            aria-labelledby="label-auto-suspend" aria-describedby="hint-auto-suspend" aria-checked="${autoSuspendEnabled}">
            ${autoSuspendEnabled ? "开启" : "关闭"}
          </button>
        </div>
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
    const block = diag.stats?.block;
    const net = diag.stats?.net;
    const kwBase = this.#vmManager.kwBaseInfo;
    const logs = this.#vmManager.getKernelLogs();
    const importantLogCount = logs.filter((entry) => entry.important).length;
    const visibleLogs = this.#logsImportantOnly ? logs.filter((entry) => entry.important) : logs;
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

    const blockValue = block
      ? `读 ${formatByteSize(block.bytesRead)} / 写 ${formatByteSize(block.bytesWritten)}`
      : "—";
    const blockDetail = block
      ? `${block.reads} 读 · ${block.writes} 写 · ${block.flushes} 刷盘`
      : "暂无 I/O 统计";
    const activeRouteCount = this.#vmManager.getActiveFetchRouteCount();
    const netValue = net ? `收 ${net.rx} 帧 / 发 ${net.tx} 帧` : "离线";
    const netDetail = net
      ? `TCP ${net.tcpOpened} · DNS ${net.dns}${activeRouteCount > 0 ? ` · ${activeRouteCount} 条直连路由` : ""}`
      : "未启用网络";
    const wasiValue = `${diag.wasi.runs} 次运行 · ${diag.wasi.cachedModules} 缓存`;
    const wasiDetail = diag.wasi.active
      ? (diag.wasi.shared ? "共享内存 Worker" : "标准 Worker")
      : "未启用";
    const shmValue = diag.shm.enabled
      ? (diag.shm.inPlace ? "零拷贝 (in-place)" : "Worker 通道")
      : "未启用";
    const shmDetail = diag.shm.enabled
      ? `读 ${formatByteSize(diag.shm.bytesRead)} / 写 ${formatByteSize(diag.shm.bytesWritten)}`
      : "需要跨源隔离或 kwshm";
    const waylandStatus = this.#getWaylandStatus?.();
    const waylandValue = waylandStatus
      ? (waylandStatus.state === "connected"
          ? `已连接 (${waylandStatus.windowCount} 窗口)`
          : waylandStatus.state === "loading"
            ? "正在加载 wland…"
            : waylandStatus.state === "ready"
              ? "已就绪 (待应用)"
              : waylandStatus.state === "unsupported"
                ? "不支持 (无 kwshm)"
                : waylandStatus.state === "error"
                  ? "错误"
                  : "按需待命")
      : "—";
    const waylandDetail = waylandStatus?.error
      ? waylandStatus.error
      : `SHM ${waylandStatus?.shmMode ?? "none"} · ${formatWaylandScale(waylandStatus?.scale ?? null, waylandStatus?.effectiveScale)}${waylandStatus?.gpuDmabuf ? " · virgl dmabuf" : ""}${waylandStatus?.vkExternal ? " · vk" : ""}`;
    const gpuValue = diag.gpu.enabled
      ? (diag.gpu.glState === "ready" ? "WebGL2 / Vulkan 就绪" : `已启用 (GL: ${diag.gpu.glState})`)
      : "基础显示器与音频 (未启用 3D GPU)";
    const gpuDetail = diag.gpu.enabled
      ? `${diag.gpu.glRenderer ?? "GL 按需加载"}${diag.gpu.soundState !== "disabled" ? ` · 音频 ${diag.gpu.soundState}` : ""}`
      : `/dev/fb0 已就绪${diag.gpu.soundState !== "disabled" ? ` · 音频 ${diag.gpu.soundState}` : ""} · 开启 GPU 可加速 3D`;
    const displayCfg = this.#getDesktopDisplayConfig?.() ?? {
      scale: waylandStatus?.scale ?? null,
      effectiveScale: waylandStatus?.effectiveScale ?? 1,
      browserFullscreen: waylandStatus?.browserFullscreen ?? false,
      lodpi: false,
    };

    panel.innerHTML = `
      ${
        kwBase?.safeMode
          ? `<div class="row-bar modal-danger" role="alert">
              <div class="row-label-group">
                <span class="row-label">系统已进入 Safe Mode（安全模式）</span>
                <span class="row-hint">${escapeHtml(kwBase.why || "Overlay 异常回退，持久化修改暂未挂载。")}</span>
              </div>
              <div class="row-controls">
                <button class="mini-btn" id="btn-safe-overlay-status" type="button">查看 status</button>
                <button class="mini-btn" id="btn-safe-overlay-discard" type="button" ${this.#vmManager.isSnapshotMode ? "disabled" : ""}>重置 Overlay (discard)</button>
              </div>
            </div>`
          : ""
      }
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
            <div class="stat-detail" id="stat-jit">${jit ? `${jit.compiled} 块已编译` : "JIT 已启用"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">${this.#vmManager.isSnapshotMode ? "内存快照占用" : "持久化存储占用"}</div>
            <div class="stat-val" id="stat-disk-size">${diskMiB} MiB</div>
            <div class="stat-detail" id="stat-disk-blocks">${diag.diskBlocks} 块</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">块设备 I/O (Block)</div>
            <div class="stat-val" id="stat-block-io">${escapeHtml(blockValue)}</div>
            <div class="stat-detail" id="stat-block-ops">${escapeHtml(blockDetail)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">网络统计 (Net)</div>
            <div class="stat-val" id="stat-net-io">${escapeHtml(netValue)}</div>
            <div class="stat-detail" id="stat-net-ops">${escapeHtml(netDetail)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">WASI 宿主加速</div>
            <div class="stat-val" id="stat-wasi-runs">${escapeHtml(wasiValue)}</div>
            <div class="stat-detail" id="stat-wasi-mode">${escapeHtml(wasiDetail)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">共享内存 (SHM)</div>
            <div class="stat-val" id="stat-shm-mode">${escapeHtml(shmValue)}</div>
            <div class="stat-detail" id="stat-shm-io">${escapeHtml(shmDetail)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">Wayland 桌面 (wland)</div>
            <div class="stat-val" id="stat-wayland-state">${escapeHtml(waylandValue)}</div>
            <div class="stat-detail" id="stat-wayland-detail">${escapeHtml(waylandDetail)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-key">GPU 与音频设备</div>
            <div class="stat-val" id="stat-gpu-state">${escapeHtml(gpuValue)}</div>
            <div class="stat-detail" id="stat-gpu-detail">${escapeHtml(gpuDetail)}</div>
          </div>
        </div>
      </div>
      <div class="modal-section">
        <h3 class="modal-section-title">Overlay 与安全模式 (kw-overlay)</h3>
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label">根文件系统状态</span>
            <span class="row-hint">${
              kwBase
                ? `distro=${escapeHtml(kwBase.name || activeDistro)} · upper=${escapeHtml(kwBase.upper || "none")}${kwBase.why ? ` · ${escapeHtml(kwBase.why)}` : ""}`
                : "正在读取 /run/kw-base…"
            }</span>
          </div>
          <div class="row-controls">
            <button class="mini-btn" id="btn-overlay-status" type="button">kw-overlay status</button>
            <button class="mini-btn" id="btn-overlay-discard" type="button" ${this.#vmManager.isSnapshotMode ? "disabled" : ""}>重置 Overlay</button>
          </div>
        </div>
        ${
          this.#overlayOutput
            ? `<pre class="diag-output" id="overlay-output">${escapeHtml(this.#overlayOutput)}</pre>`
            : ""
        }
      </div>
      <div class="modal-section">
        <h3 class="modal-section-title">内核日志 (ConsoleRouter · ${logs.length} 条 / ${importantLogCount} 条警告)</h3>
        <div class="row-bar">
          <span class="row-label">内核与启动输出</span>
          <div class="row-controls">
            <button class="mini-btn" id="btn-logs-filter" aria-pressed="${this.#logsImportantOnly}" type="button">${this.#logsImportantOnly ? "仅警告" : "全部"}</button>
            <button class="mini-btn" id="btn-logs-refresh" type="button">刷新</button>
            <button class="mini-btn" id="btn-logs-copy" type="button" ${visibleLogs.length === 0 ? "disabled" : ""}>复制日志</button>
            <button class="mini-btn" id="btn-logs-clear" type="button" ${logs.length === 0 ? "disabled" : ""}>清空</button>
          </div>
        </div>
        <div class="kernel-log-view" id="kernel-log-view" role="log" aria-live="off">${
          visibleLogs.length > 0
            ? visibleLogs
                .map(
                  (entry) =>
                    `<div class="kernel-log-line${entry.important ? " important" : ""}">${escapeHtml(entry.line)}</div>`,
                )
                .join("")
            : `<div class="kernel-log-empty">${this.#logsImportantOnly ? "暂无重要内核警告" : "暂无内核日志记录"}</div>`
        }</div>
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
            <span class="row-label" id="label-gpu-accel">3D 图形硬件加速 (virtio-gpu / WebGL2 / Vulkan)</span>
            <span class="row-hint" id="hint-gpu-accel">${distro === "debian" ? "基础虚拟显示器 (/dev/fb0) 与 ALSA 音频默认可用；开启后额外提供 virtio-gpu (WebGL2) 与 Vulkan (WebGPU)。" : "仅 Debian 发行版支持 virtio-gpu 与 Vulkan 硬件加速。"}</span>
          </div>
          <button class="mini-btn" id="btn-toggle-gpu" type="button" role="switch"
            aria-labelledby="label-gpu-accel" aria-describedby="hint-gpu-accel"
            aria-checked="${this.#vmManager.gpuEnabled}" ${distro !== "debian" ? "disabled" : ""}>
            ${this.#vmManager.gpuEnabled ? "开启" : "关闭"}
          </button>
        </div>
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label">桌面缩放 (Wayland Scale)</span>
            <span class="row-hint">实时调整 Wayland 应用缩放倍率（当前 ${escapeHtml(formatWaylandScale(displayCfg.scale, displayCfg.effectiveScale))}）</span>
          </div>
          <div class="row-controls" role="group" aria-label="桌面缩放">
            <button class="mini-btn" aria-pressed="${displayCfg.scale === null}" data-wayland-scale="auto" type="button">自动</button>
            ${WAYLAND_SCALE_PRESETS.map((s) =>
              `<button class="mini-btn" aria-pressed="${displayCfg.scale === s}" data-wayland-scale="${s}" type="button">${s}×</button>`
            ).join("")}
          </div>
        </div>
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label" id="label-browser-fs">全屏窗口联动浏览器全屏 (browserFullscreen)</span>
            <span class="row-hint">Wayland 应用进入全屏状态时同步触发浏览器全屏</span>
          </div>
          <button class="mini-btn" id="btn-toggle-browser-fs" type="button" role="switch"
            aria-labelledby="label-browser-fs" aria-checked="${displayCfg.browserFullscreen}">
            ${displayCfg.browserFullscreen ? "开启" : "关闭"}
          </button>
        </div>
        <div class="row-bar">
          <div class="row-label-group">
            <span class="row-label" id="label-wayland-lodpi">默认 1× LoDPI 兼容模式 (X11 / SDL)</span>
            <span class="row-hint">通过 <code>wayland-0-lodpi</code> 启动应用，避免老旧 X11/SDL 程序在 HiDPI 屏幕下过小或发虚</span>
          </div>
          <button class="mini-btn" id="btn-toggle-wayland-lodpi" type="button" role="switch"
            aria-labelledby="label-wayland-lodpi" aria-checked="${displayCfg.lodpi}">
            ${displayCfg.lodpi ? "开启" : "关闭"}
          </button>
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
        ${
          this.#vmManager.netMode !== "off"
            ? `<div class="row-bar row-bar-column">
                <div class="row-label-group">
                  <label class="row-label" for="input-fetch-routes">直连 HTTP 路由 (fetchRoutes)</label>
                  <span class="row-hint">纯 HTTP 域名直接走浏览器 fetch() 绕过 Wisp（每行 <code>域名 = 目标基础 URL</code>，目标需支持 CORS 或为同源路径如 <code>/mirror</code>）</span>
                </div>
                <textarea
                  class="text-input routes-textarea"
                  id="input-fetch-routes"
                  rows="3"
                  spellcheck="false"
                  placeholder="mirror.local = https://mirrors.example.com/alpine&#10;static.local = /mirror"
                >${escapeHtml(formatFetchRoutesText(this.#vmManager.fetchRoutes))}</textarea>
                <div class="routes-actions">
                  <button class="mini-btn" id="btn-clear-routes" type="button">清空</button>
                  <button class="mini-btn" id="btn-save-routes" type="button">保存路由</button>
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

    q("#btn-toggle-desktop")?.addEventListener("click", () => {
      if (this.#diskAction) return;
      this.close();
      this.#onToggleDesktop?.();
    });

    q("#btn-open-launcher")?.addEventListener("click", () => {
      if (this.#diskAction) return;
      this.close();
      this.#onOpenLauncher?.();
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

    q("#btn-cycle-wallpaper")?.addEventListener("click", () => {
      this.#onCycleWallpaper?.();
      this.#renderWorkspace();
      panel.querySelector<HTMLButtonElement>("#btn-cycle-wallpaper")?.focus();
    });

    q("#btn-open-wallpaper")?.addEventListener("click", () => {
      if (this.#diskAction) return;
      this.close();
      this.#onOpenWallpaperPicker?.();
    });
  }

  #bindStorageEvents(panel: HTMLElement): void {
    const q = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel)!;
    const run = (action: () => Promise<void>) => () => void this.#runDiskAction("storage", action);

    const autoSuspend = q<HTMLButtonElement>("#btn-auto-suspend");
    autoSuspend.addEventListener("click", () => {
      const enabled = !this.#vmManager.autoSuspendEnabled;
      this.#vmManager.setAutoSuspendEnabled(enabled);
      autoSuspend.setAttribute("aria-checked", String(enabled));
      autoSuspend.textContent = enabled ? "开启" : "关闭";
    });

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
      this.#renderSystem();
      q<HTMLSelectElement>("#select-distro")?.focus();
    });

    q<HTMLButtonElement>("#btn-toggle-gpu")?.addEventListener("click", () => {
      const next = !this.#vmManager.gpuEnabled;
      this.#vmManager.setGpuEnabled(next);
      this.#renderSystem();
      q<HTMLButtonElement>("#btn-toggle-gpu")?.focus();
    });

    for (const btn of panel.querySelectorAll<HTMLButtonElement>("[data-wayland-scale]")) {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.waylandScale;
        const next = !raw || raw === "auto" ? null : Number(raw);
        if (next !== null && !Number.isFinite(next)) return;
        this.#onSetWaylandScale?.(next);
        this.#renderSystem();
        q<HTMLButtonElement>(`[data-wayland-scale="${raw}"]`)?.focus();
      });
    }

    q<HTMLButtonElement>("#btn-toggle-browser-fs")?.addEventListener("click", () => {
      const current = this.#getDesktopDisplayConfig?.().browserFullscreen ?? false;
      const next = !current;
      const immediate = this.#onSetBrowserFullscreen?.(next) ?? true;
      this.#renderSystem();
      if (!immediate) {
        this.#toast("已保存全屏联动设置，将在下次启动 Wayland 合成器时生效");
      }
      q<HTMLButtonElement>("#btn-toggle-browser-fs")?.focus();
    });

    q<HTMLButtonElement>("#btn-toggle-wayland-lodpi")?.addEventListener("click", () => {
      const current = this.#getDesktopDisplayConfig?.().lodpi ?? false;
      this.#onSetWaylandLodpi?.(!current);
      this.#renderSystem();
      q<HTMLButtonElement>("#btn-toggle-wayland-lodpi")?.focus();
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

    const routesInput = q<HTMLTextAreaElement>("#input-fetch-routes");
    if (routesInput) {
      q("#btn-save-routes")?.addEventListener("click", () => {
        const parsed = parseFetchRoutesText(routesInput.value);
        if (!parsed.ok) {
          this.#toast(parsed.error);
          routesInput.focus();
          return;
        }
        this.#vmManager.setFetchRoutes(parsed.routes);
        routesInput.value = formatFetchRoutesText(parsed.routes);
        this.#renderRestart();
        const count = Object.keys(parsed.routes).length;
        this.#toast(count > 0 ? `已保存 ${count} 条直连 HTTP 路由` : "已清空直连 HTTP 路由");
      });
      q("#btn-clear-routes")?.addEventListener("click", () => {
        this.#vmManager.setFetchRoutes({});
        routesInput.value = "";
        this.#renderRestart();
        this.#toast("已清空直连 HTTP 路由");
        routesInput.focus();
      });
    }

    const showOverlayStatus = async () => {
      try {
        this.#toast("正在查询 kw-overlay status…");
        this.#overlayOutput = await this.#vmManager.runKwOverlayStatus();
        await this.#vmManager.refreshKwBase();
        this.#renderSystem();
      } catch (err) {
        this.#toast(`查询失败: ${(err as Error)?.message ?? String(err)}`);
      }
    };

    const runOverlayDiscard = async () => {
      if (!confirm("确定重置当前发行版的 Overlay 改动？旧修改将被归档并从基础镜像重新启动。")) return;
      try {
        this.#toast("正在执行 kw-overlay discard…");
        this.#overlayOutput = await this.#vmManager.runKwOverlayDiscard();
        this.#overlayPendingRestart = true;
        await this.#vmManager.refreshKwBase();
        this.#renderSystem();
        this.#toast("已重置 Overlay，请同步并重启生效");
      } catch (err) {
        this.#toast(`重置失败: ${(err as Error)?.message ?? String(err)}`);
      }
    };

    q<HTMLButtonElement>("#btn-overlay-status")?.addEventListener("click", () => void showOverlayStatus());
    q<HTMLButtonElement>("#btn-safe-overlay-status")?.addEventListener("click", () => void showOverlayStatus());
    q<HTMLButtonElement>("#btn-overlay-discard")?.addEventListener("click", () => void runOverlayDiscard());
    q<HTMLButtonElement>("#btn-safe-overlay-discard")?.addEventListener("click", () => void runOverlayDiscard());

    q<HTMLButtonElement>("#btn-logs-filter")?.addEventListener("click", () => {
      this.#logsImportantOnly = !this.#logsImportantOnly;
      this.#renderSystem();
      q<HTMLButtonElement>("#btn-logs-filter")?.focus();
    });
    q<HTMLButtonElement>("#btn-logs-refresh")?.addEventListener("click", () => {
      this.#renderSystem();
      q<HTMLButtonElement>("#btn-logs-refresh")?.focus();
    });
    q<HTMLButtonElement>("#btn-logs-copy")?.addEventListener("click", async () => {
      const text = this.#vmManager.formatKernelLogs(this.#logsImportantOnly);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.#toast("已复制内核日志到剪贴板");
      } catch {
        this.#toast("无法写入剪贴板，请手动选中复制");
      }
    });
    q<HTMLButtonElement>("#btn-logs-clear")?.addEventListener("click", () => {
      this.#vmManager.clearKernelLogs();
      this.#renderSystem();
      q<HTMLButtonElement>("#btn-logs-clear")?.focus();
    });
  }

  #refreshLiveSystemStats(): void {
    const panel = this.#panel("system");
    const diag = this.#vmManager.getStats();
    const jit = diag.stats?.jit;
    const block = diag.stats?.block;
    const net = diag.stats?.net;
    const setText = (sel: string, val: string) => {
      const el = panel.querySelector(sel);
      if (el) el.textContent = val;
    };
    setText("#stat-cpus", diag.cpus === null ? "—" : `${diag.cpus} 核`);
    setText("#stat-jit", jit ? `${jit.compiled} 块已编译` : "JIT 已启用");
    setText("#stat-disk-size", `${((diag.diskBlocks * 4096) / 1048576).toFixed(1)} MiB`);
    setText("#stat-disk-blocks", `${diag.diskBlocks} 块`);
    setText(
      "#stat-block-io",
      block ? `读 ${formatByteSize(block.bytesRead)} / 写 ${formatByteSize(block.bytesWritten)}` : "—",
    );
    setText(
      "#stat-block-ops",
      block ? `${block.reads} 读 · ${block.writes} 写 · ${block.flushes} 刷盘` : "暂无 I/O 统计",
    );
    const activeRouteCount = this.#vmManager.getActiveFetchRouteCount();
    setText("#stat-net-io", net ? `收 ${net.rx} 帧 / 发 ${net.tx} 帧` : "离线");
    setText(
      "#stat-net-ops",
      net
        ? `TCP ${net.tcpOpened} · DNS ${net.dns}${activeRouteCount > 0 ? ` · ${activeRouteCount} 条直连路由` : ""}`
        : "未启用网络",
    );
    setText("#stat-wasi-runs", `${diag.wasi.runs} 次运行 · ${diag.wasi.cachedModules} 缓存`);
    setText(
      "#stat-wasi-mode",
      diag.wasi.active ? (diag.wasi.shared ? "共享内存 Worker" : "标准 Worker") : "未启用",
    );
    setText(
      "#stat-shm-mode",
      diag.shm.enabled ? (diag.shm.inPlace ? "零拷贝 (in-place)" : "Worker 通道") : "未启用",
    );
    setText(
      "#stat-shm-io",
      diag.shm.enabled
        ? `读 ${formatByteSize(diag.shm.bytesRead)} / 写 ${formatByteSize(diag.shm.bytesWritten)}`
        : "需要跨源隔离或 kwshm",
    );
    const waylandStatus = this.#getWaylandStatus?.();
    setText(
      "#stat-wayland-state",
      waylandStatus
        ? (waylandStatus.state === "connected"
            ? `已连接 (${waylandStatus.windowCount} 窗口)`
            : waylandStatus.state === "loading"
              ? "正在加载 wland…"
              : waylandStatus.state === "ready"
                ? "已就绪 (待应用)"
                : waylandStatus.state === "unsupported"
                  ? "不支持 (无 kwshm)"
                  : waylandStatus.state === "error"
                    ? "错误"
                    : "按需待命")
        : "—",
    );
    setText(
      "#stat-wayland-detail",
      waylandStatus?.error
        ? waylandStatus.error
        : `SHM ${waylandStatus?.shmMode ?? "none"} · ${formatWaylandScale(waylandStatus?.scale ?? null, waylandStatus?.effectiveScale)}${waylandStatus?.gpuDmabuf ? " · virgl dmabuf" : ""}${waylandStatus?.vkExternal ? " · vk" : ""}`,
    );
    setText(
      "#stat-gpu-state",
      diag.gpu.enabled
        ? (diag.gpu.glState === "ready" ? "WebGL2 / Vulkan 就绪" : `已启用 (GL: ${diag.gpu.glState})`)
        : "基础显示器与音频 (未启用 3D GPU)",
    );
    setText(
      "#stat-gpu-detail",
      diag.gpu.enabled
        ? `${diag.gpu.glRenderer ?? "GL 按需加载"}${diag.gpu.soundState !== "disabled" ? ` · 音频 ${diag.gpu.soundState}` : ""}`
        : `/dev/fb0 已就绪${diag.gpu.soundState !== "disabled" ? ` · 音频 ${diag.gpu.soundState}` : ""} · 开启 GPU 可加速 3D`,
    );
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
    banner.hidden = !restarting && !this.#overlayPendingRestart && !this.#vmManager.hasPendingRestartChanges();
    if (banner.hidden) {
      message.textContent = "";
      return;
    }
    const settings = [
      this.#vmManager.hasPendingDistroChange() ? "发行版" : null,
      this.#vmManager.hasPendingGpuChange() ? "图形与音频加速" : null,
      this.#vmManager.hasPendingCpuChange() ? "CPU 核数" : null,
      this.#vmManager.hasPendingMemoryChange() ? "内存配额" : null,
      this.#vmManager.hasPendingNetworkChange() ? "Wisp 网络" : null,
      this.#vmManager.hasPendingDiskSizeChange() ? "数据盘容量" : null,
      this.#overlayPendingRestart ? "Overlay 重置" : null,
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
