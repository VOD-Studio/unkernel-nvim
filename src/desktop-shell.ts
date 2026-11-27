// SPDX-License-Identifier: MIT
// Unified Clay-dark browser desktop shell combining the floating Neovim/Shell
// terminal window, wland Wayland app windows, top status bar, bottom dock,
// and Spotlight-style app launcher.

import type { AudioOutState, DisplayMode, InputState, KernelHandle } from "unkernel";
import type { InteractiveEvent, PointerPress, ViewWindow, WindowEntry } from "wland/client";
import {
  createDesktopIconElement,
  renderDesktopIcon,
  resolvePresetIcon,
  resolveWaylandAppIcon,
  type DesktopIconId,
} from "./desktop-icons.ts";
import {
  applyWindowResize,
  BROWSER_FULLSCREEN_STORAGE_KEY,
  buildDebianDesktopInstallCommand,
  clampWindowRect,
  computeCascadeRect,
  computeContextMenuPosition,
  computeDockMagnification,
  DESKTOP_APP_PRESETS,
  DESKTOP_MODE_STORAGE_KEY,
  DOCK_CLEARANCE,
  formatAudioButtonState,
  formatWaylandScale,
  parseLauncherCommand,
  parseStoredBoolean,
  parseWaylandScale,
  WAYLAND_LODPI_STORAGE_KEY,
  WAYLAND_SCALE_STORAGE_KEY,
  WIN_EDGE_BOTTOM,
  WIN_EDGE_LEFT,
  WIN_EDGE_RIGHT,
  WIN_EDGE_TOP,
  type DesktopBounds,
  type WindowRect,
} from "./desktop-state.ts";
import {
  DEFAULT_WALLPAPER_CONFIG,
  deleteCustomWallpaperBlob,
  formatWallpaperSummary,
  getNextWallpaperPresetId,
  getWallpaperPreset,
  loadCustomWallpaperBlob,
  parseWallpaperConfig,
  parseWallpaperUrl,
  resolveWallpaperStyles,
  saveCustomWallpaperBlob,
  serializeWallpaperConfig,
  validateWallpaperFile,
  WALLPAPER_FIT_OPTIONS,
  WALLPAPER_PRESETS,
  WALLPAPER_STORAGE_KEY,
  type WallpaperConfig,
  type WallpaperFit,
} from "./desktop-wallpaper.ts";
import { GuestDisplayWindow } from "./display-window.ts";
import { DISTROS } from "./distro.ts";
import { GuestPreviewPane } from "./guest-preview.ts";
import type { CanvasTerminal } from "./terminal.ts";
import { MAX_TERMINAL_SESSIONS, type SessionMode } from "./terminal-sessions.ts";
import type { VmManager } from "./vm-manager.ts";
import {
  createWaylandDropFilesHook,
  WaylandHostBridge,
  type WaylandBridgeStatus,
} from "./wayland-bridge.ts";

interface ManagedWaylandWindow {
  key: string;
  conn: number;
  surface: number;
  win: ViewWindow;
  frameEl: HTMLDivElement;
  titlebarEl: HTMLDivElement;
  iconEl: HTMLSpanElement;
  iconId: DesktopIconId;
  titleEl: HTMLSpanElement;
  badgeEl: HTMLSpanElement;
  bodyEl: HTMLDivElement;
  maxBtn: HTMLButtonElement;
  rect: WindowRect;
  restoreRect: WindowRect | null;
  maximized: boolean;
  fullscreen: boolean;
  minimized: boolean;
  decorated: boolean;
  zIndex: number;
}

interface ManagedPreviewWindow {
  key: string;
  pane: GuestPreviewPane;
  frameEl: HTMLDivElement;
  titlebarEl: HTMLDivElement;
  titleEl: HTMLSpanElement;
  badgeEl: HTMLSpanElement;
  bodyEl: HTMLDivElement;
  maxBtn: HTMLButtonElement;
  rect: WindowRect;
  restoreRect: WindowRect | null;
  maximized: boolean;
  minimized: boolean;
  zIndex: number;
}

type ContextMenuItem =
  | { kind: "heading"; label: string }
  | { kind: "sep" }
  | {
      kind: "action";
      label: string;
      kbd?: string;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

interface DockAppNode {
  btn: HTMLButtonElement;
  iconWrap: HTMLSpanElement;
  badgeEl: HTMLSpanElement;
  iconId: DesktopIconId;
}

interface DockAppHandlers {
  onClick: () => void;
  onMiddleClick?: () => void;
  onContextMenu: () => ContextMenuItem[];
}

interface DockAppDescriptor {
  key: string;
  iconId: DesktopIconId;
  title: string;
  subtitle?: string;
  kbd?: string;
  badge?: string;
  active: boolean;
  minimized: boolean;
  onClick: () => void;
  onMiddleClick?: () => void;
  onContextMenu: () => ContextMenuItem[];
}

const RESIZE_EDGES: ReadonlyArray<{ className: string; edges: number }> = [
  { className: "n", edges: WIN_EDGE_TOP },
  { className: "s", edges: WIN_EDGE_BOTTOM },
  { className: "w", edges: WIN_EDGE_LEFT },
  { className: "e", edges: WIN_EDGE_RIGHT },
  { className: "nw", edges: WIN_EDGE_TOP | WIN_EDGE_LEFT },
  { className: "ne", edges: WIN_EDGE_TOP | WIN_EDGE_RIGHT },
  { className: "sw", edges: WIN_EDGE_BOTTOM | WIN_EDGE_LEFT },
  { className: "se", edges: WIN_EDGE_BOTTOM | WIN_EDGE_RIGHT },
];

export interface DesktopDisplayConfig {
  scale: number | null;
  effectiveScale: number;
  browserFullscreen: boolean;
  lodpi: boolean;
}

export interface DesktopShellOptions {
  vmManager: VmManager;
  terminal: CanvasTerminal;
  isModalOpen: () => boolean;
  onOpenModal: () => void;
  onOpenSession?: (mode: SessionMode) => Promise<void>;
  onOpenInstallInShell: (command: string) => Promise<void>;
  onDesktopModeChange?: (enabled: boolean) => void;
  onStateChange?: () => void;
  toast: (message: string, durationMs?: number) => void;
}

/**
 * Coordinates Desktop Mode, the floating terminal window, wland Wayland
 * windows, the top status bar, the bottom dock, and the app launcher.
 */
export class DesktopShell {
  readonly #vmManager: VmManager;
  readonly #terminal: CanvasTerminal;
  readonly #isModalOpen: () => boolean;
  readonly #onOpenModal: () => void;
  readonly #onOpenSession?: (mode: SessionMode) => Promise<void>;
  readonly #onOpenInstallInShell: (command: string) => Promise<void>;
  readonly #onDesktopModeChange?: (enabled: boolean) => void;
  readonly #onStateChange?: () => void;
  readonly #toast: (message: string, durationMs?: number) => void;

  readonly #topbarEl = document.getElementById("desktop-topbar")!;
  readonly #topbarTitleEl = document.getElementById("desktop-topbar-title")!;
  readonly #topbarMetaEl = document.getElementById("desktop-topbar-meta")!;
  readonly #topbarClockEl = document.getElementById("desktop-topbar-clock")!;
  readonly #topbarMuteBtn = document.getElementById("btn-desktop-mute") as HTMLButtonElement;
  readonly #stageEl = document.getElementById("desktop-stage")!;
  readonly #wlandLayerEl = document.getElementById("desktop-wland-layer")!;
  readonly #windowsLayerEl = document.getElementById("desktop-windows-layer")!;
  readonly #terminalWindowEl = document.getElementById("terminal-window")!;
  readonly #terminalBarEl = document.getElementById("terminal-win-bar")!;
  readonly #terminalWinIconEl = document.getElementById("terminal-win-icon")!;
  readonly #terminalTitleEl = document.getElementById("terminal-win-title")!;
  readonly #terminalTabsSlotEl = document.getElementById("terminal-win-tabs-slot")!;
  readonly #floatingHudEl = document.getElementById("floating-hud")!;
  readonly #sessionTabsEl = document.getElementById("session-tabs")!;
  readonly #dockEl = document.getElementById("desktop-dock")!;
  readonly #dockAppsEl = document.getElementById("desktop-dock-apps")!;
  readonly #dockTerminalBtn = document.getElementById("dock-btn-terminal") as HTMLButtonElement;
  readonly #dockTerminalIconEl = document.getElementById("dock-icon-terminal")!;
  readonly #dockTerminalBadgeEl = document.getElementById("dock-badge-terminal")!;
  readonly #dockLauncherBtn = document.getElementById("dock-btn-launcher") as HTMLButtonElement;
  readonly #dockPreviewBtn = document.getElementById("dock-btn-preview") as HTMLButtonElement;
  readonly #dockPreviewBadgeEl = document.getElementById("dock-badge-preview")!;
  readonly #dockSettingsBtn = document.getElementById("dock-btn-settings") as HTMLButtonElement;
  readonly #dockFullscreenBtn = document.getElementById("dock-btn-fullscreen") as HTMLButtonElement;
  readonly #dockTooltipEl = document.getElementById("desktop-dock-tooltip")!;
  readonly #contextMenuEl = document.getElementById("desktop-context-menu")!;
  readonly #wallpaperEl = document.getElementById("desktop-wallpaper")!;
  readonly #wallpaperScrimEl = document.getElementById("desktop-wallpaper-scrim")!;
  readonly #launcherBackdropEl = document.getElementById("desktop-launcher-backdrop")!;
  readonly #launcherFormEl = document.getElementById("desktop-launcher-form") as HTMLFormElement;
  readonly #launcherInputEl = document.getElementById("desktop-launcher-input") as HTMLInputElement;
  readonly #launcherGridEl = document.getElementById("desktop-launcher-grid")!;
  readonly #launcherLodpiEl = document.getElementById("launcher-lodpi-toggle") as HTMLInputElement;
  readonly #launcherInstallBtn = document.getElementById("btn-desktop-install-apps") as HTMLButtonElement;
  readonly #launcherDistroNoteEl = document.getElementById("desktop-launcher-note")!;
  readonly #wallpaperBackdropEl = document.getElementById("desktop-wallpaper-backdrop")!;
  readonly #wallpaperNoteEl = document.getElementById("desktop-wallpaper-note")!;
  readonly #wallpaperGridEl = document.getElementById("desktop-wallpaper-grid")!;
  readonly #wallpaperUploadBtn = document.getElementById("btn-wallpaper-upload") as HTMLButtonElement;
  readonly #wallpaperUseCustomBtn = document.getElementById("btn-wallpaper-use-custom") as HTMLButtonElement;
  readonly #wallpaperClearCustomBtn = document.getElementById("btn-wallpaper-clear-custom") as HTMLButtonElement;
  readonly #wallpaperFileInput = document.getElementById("desktop-wallpaper-file") as HTMLInputElement;
  readonly #wallpaperUrlFormEl = document.getElementById("desktop-wallpaper-url-form") as HTMLFormElement;
  readonly #wallpaperUrlInputEl = document.getElementById("desktop-wallpaper-url-input") as HTMLInputElement;
  readonly #wallpaperFitGroupEl = document.getElementById("desktop-wallpaper-fit-group")!;
  readonly #wallpaperDimInputEl = document.getElementById("desktop-wallpaper-dim") as HTMLInputElement;
  readonly #wallpaperDimValEl = document.getElementById("desktop-wallpaper-dim-val")!;
  readonly #wallpaperBlurInputEl = document.getElementById("desktop-wallpaper-blur") as HTMLInputElement;
  readonly #wallpaperBlurValEl = document.getElementById("desktop-wallpaper-blur-val")!;
  readonly #wallpaperResetBtn = document.getElementById("btn-wallpaper-reset") as HTMLButtonElement;
  readonly #desktopTogglePillBtn = document.getElementById("btn-enter-desktop") as HTMLButtonElement | null;

  readonly bridge: WaylandHostBridge;
  readonly #displayWindow: GuestDisplayWindow;
  readonly #isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

  #desktopMode = parseStoredBoolean(localStorage.getItem(DESKTOP_MODE_STORAGE_KEY), false);
  #waylandScale: number | null = parseWaylandScale(localStorage.getItem(WAYLAND_SCALE_STORAGE_KEY));
  #browserFullscreen = parseStoredBoolean(localStorage.getItem(BROWSER_FULLSCREEN_STORAGE_KEY), false);
  #waylandLodpi = parseStoredBoolean(localStorage.getItem(WAYLAND_LODPI_STORAGE_KEY), false);
  #wallpaperConfig: WallpaperConfig = parseWallpaperConfig(localStorage.getItem(WALLPAPER_STORAGE_KEY));
  #customWallpaperUrl: string | null = null;
  #customWallpaperName: string | undefined =
    this.#wallpaperConfig.source.kind === "custom" ? this.#wallpaperConfig.source.name : undefined;
  #launcherOpen = false;
  #wallpaperOpen = false;
  #launchingApp = false;
  #nextZ = 20;
  #terminalRect: WindowRect | null = null;
  #terminalRestoreRect: WindowRect | null = null;
  #terminalMaximized = false;
  #terminalMinimized = false;
  #terminalZ = 15;
  #terminalFitRaf = 0;
  #waylandWindows = new Map<string, ManagedWaylandWindow>();
  #previewWindows = new Map<string, ManagedPreviewWindow>();
  #nextPreviewSeq = 1;
  #lastFocusedTarget: "terminal" | "display" | string = "terminal";
  #lastAudioState: AudioOutState | "disabled" = "disabled";
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #lastTerminalIconId: DesktopIconId | null = null;
  #dockAppNodes = new Map<string, DockAppNode>();
  #dockAppHandlers = new Map<string, DockAppHandlers>();
  #hoveredDockBtn: HTMLButtonElement | null = null;
  #dockPointerX: number | null = null;
  #dockMagnifyRaf = 0;
  #contextMenuOpen = false;

  constructor(opts: DesktopShellOptions) {
    this.#vmManager = opts.vmManager;
    this.#terminal = opts.terminal;
    this.#isModalOpen = opts.isModalOpen;
    this.#onOpenModal = opts.onOpenModal;
    this.#onOpenSession = opts.onOpenSession;
    this.#onOpenInstallInShell = opts.onOpenInstallInShell;
    this.#onDesktopModeChange = opts.onDesktopModeChange;
    this.#onStateChange = opts.onStateChange;
    this.#toast = opts.toast;

    this.bridge = new WaylandHostBridge({
      container: this.#wlandLayerEl,
      decorations: "server",
      autoFocus: false,
      manageDisplay: false,
      shortcuts: { keys: true, drag: true },
      initialScale: this.#waylandScale,
      initialBrowserFullscreen: this.#browserFullscreen,
      dndFiles: createWaylandDropFilesHook({
        uploadFiles: (files, dir, signal) => this.#vmManager.writeGuestFiles(files, dir, signal),
        onStart: (count) => {
          this.#toast(count === 1 ? "正在将文件导入到桌面应用…" : `正在导入 ${count} 个文件到桌面应用…`);
        },
        onComplete: (paths) => {
          this.#toast(paths.length === 1 ? `已传递给应用: ${paths[0]}` : `已传递 ${paths.length} 个文件到 /tmp/drops`);
        },
        onError: (err) => {
          this.#toast(`拖拽导入失败: ${err instanceof Error ? err.message : String(err)}`, 5000);
        },
      }),
      mount: (win) => this.#mountWaylandWindow(win),
      unmount: (win) => this.#unmountWaylandWindow(win),
      interactive: (ev, press) => this.#handleWaylandInteractive(ev, press),
      onWindowsChange: () => this.#syncWaylandWindows(),
      onFocusChange: () => this.#syncWaylandFocus(),
      onStatusChange: () => {
        this.renderStatus();
        this.#onStateChange?.();
      },
      onGuestDial: () => {
        if (!this.#desktopMode) {
          this.setDesktopMode(true);
        }
      },
    });

    this.#displayWindow = new GuestDisplayWindow({
      container: this.#windowsLayerEl,
      getVm: () => this.#vmManager.vm,
      getBounds: () => this.#getBounds(),
      isDesktopMode: () => this.#desktopMode,
      isOverlayBlocking: () => this.#isModalOpen() || this.isOverlayOpen,
      startPointerDrag: (pointerId, onMove, onDone) => this.#startPointerDrag(pointerId, onMove, onDone),
      onRequestDesktop: () => {
        if (!this.#desktopMode) {
          this.setDesktopMode(true);
        }
      },
      onFocus: () => this.#focusDisplayWindow(),
      onTitlebarContextMenu: (e) => {
        this.#focusDisplayWindow();
        this.#openMenuAt(e.clientX, e.clientY, this.#buildDisplayContextMenuItems());
      },
      onStateChange: () => this.renderStatus(),
    });

    this.#initTerminalWindowChrome();
    this.#initTopbarAndDock();
    this.#initDesktopContextMenus();
    this.#initLauncher();
    this.#initWallpaperPicker();
    this.#initGlobalShortcuts();
    this.#applyWallpaper();
    void this.#hydrateCustomWallpaper();

    const ro = new ResizeObserver(() => {
      if (!this.#desktopMode) return;
      this.#clampAllWindowsToStage();
    });
    ro.observe(this.#stageEl);

    if (this.#desktopMode) {
      this.#applyDesktopModeClass(true);
    }
    this.renderStatus();
  }

  get isDesktopMode(): boolean {
    return this.#desktopMode;
  }

  get isLauncherOpen(): boolean {
    return this.#launcherOpen;
  }

  get isWallpaperOpen(): boolean {
    return this.#wallpaperOpen;
  }

  get isOverlayOpen(): boolean {
    return this.#launcherOpen || this.#wallpaperOpen;
  }

  getWallpaperSummary(): string {
    return formatWallpaperSummary(this.#wallpaperConfig);
  }

  get lastFocusedTarget(): "terminal" | string {
    return this.#lastFocusedTarget;
  }

  attachVm(vm: KernelHandle): void {
    this.bridge.attach(vm);
    this.#displayWindow.attachVm(vm);
    if (this.#desktopMode) {
      void this.bridge.ensureReady().catch((err) => {
        console.warn("[desktop] Failed to initialize wland:", err);
      });
    }
    this.renderStatus();
  }

  detachVm(): void {
    this.closeAllPreviews();
    this.#displayWindow.detachVm();
    this.bridge.detach();
    this.renderStatus();
  }

  setDesktopMode(enabled: boolean): void {
    if (this.#desktopMode === enabled) return;
    this.#desktopMode = enabled;
    localStorage.setItem(DESKTOP_MODE_STORAGE_KEY, enabled ? "1" : "0");
    if (!enabled) {
      this.closeLauncher();
      this.closeWallpaperPicker();
      this.closeContextMenu();
      this.#hideDockTooltip();
      this.blurInputs();
    }
    this.#applyDesktopModeClass(enabled);
    this.#displayWindow.syncVisibility();
    if (enabled && this.#vmManager.vm) {
      void this.bridge.ensureReady().catch((err) => {
        this.#toast(`Wayland 合成器启动失败: ${err instanceof Error ? err.message : String(err)}`, 5000);
      });
    }
    this.#onDesktopModeChange?.(enabled);
    this.renderStatus();
    this.#onStateChange?.();
  }

  toggleDesktopMode(): void {
    this.setDesktopMode(!this.#desktopMode);
  }

  openLauncher(): void {
    if (!this.#desktopMode) {
      this.setDesktopMode(true);
    }
    this.closeWallpaperPicker();
    this.blurInputs();
    this.#launcherOpen = true;
    this.#renderLauncherContent();
    this.#launcherBackdropEl.hidden = false;
    this.renderStatus();
    this.#launcherInputEl.focus();
    this.#launcherInputEl.select();
  }

  closeLauncher(): void {
    if (!this.#launcherOpen) return;
    this.#launcherOpen = false;
    this.#launcherBackdropEl.hidden = true;
    this.renderStatus();
    if (!this.#isModalOpen() && !this.#wallpaperOpen) {
      this.restoreFocus();
    }
  }

  toggleLauncher(): void {
    if (this.#launcherOpen) this.closeLauncher();
    else this.openLauncher();
  }

  openWallpaperPicker(): void {
    if (!this.#desktopMode) {
      this.setDesktopMode(true);
    }
    this.closeLauncher();
    this.blurInputs();
    this.#wallpaperOpen = true;
    this.#renderWallpaperPicker();
    this.#wallpaperBackdropEl.hidden = false;
    this.renderStatus();
    const activeSwatch =
      this.#wallpaperGridEl.querySelector<HTMLButtonElement>(".wallpaper-swatch.active") ??
      this.#wallpaperGridEl.querySelector<HTMLButtonElement>(".wallpaper-swatch") ??
      this.#wallpaperUploadBtn;
    activeSwatch.focus();
  }

  closeWallpaperPicker(): void {
    if (!this.#wallpaperOpen) return;
    this.#wallpaperOpen = false;
    this.#wallpaperBackdropEl.hidden = true;
    this.renderStatus();
    if (!this.#isModalOpen() && !this.#launcherOpen) {
      this.restoreFocus();
    }
  }

  cycleWallpaper(): void {
    const nextId = getNextWallpaperPresetId(this.#wallpaperConfig);
    this.#updateWallpaperConfig({
      ...this.#wallpaperConfig,
      source: { kind: "preset", presetId: nextId },
    });
    const preset = getWallpaperPreset(nextId);
    this.#toast(`已切换壁纸：${preset.name}`);
  }

  blurWayland(): void {
    this.bridge.wland?.input.blur();
  }

  blurInputs(): void {
    this.closeContextMenu();
    this.#hideDockTooltip();
    this.blurWayland();
    this.#displayWindow.setFocused(false);
  }

  closeContextMenu(): void {
    if (!this.#contextMenuOpen) return;
    this.#contextMenuOpen = false;
    this.#contextMenuEl.hidden = true;
    this.#contextMenuEl.replaceChildren();
  }

  closeDockMenu(): void {
    this.closeContextMenu();
  }

  restoreFocus(): void {
    if (!this.#desktopMode) {
      this.#terminal.focus();
      return;
    }
    if (this.#lastFocusedTarget === "terminal" && !this.#terminalMinimized) {
      this.#terminal.focus();
      return;
    }
    if (this.#lastFocusedTarget === "display" && this.#displayWindow.isOpen && !this.#displayWindow.isMinimized) {
      this.#focusDisplayWindow();
      return;
    }
    const previewWin = this.#previewWindows.get(this.#lastFocusedTarget);
    if (previewWin && !previewWin.minimized) {
      this.#focusPreviewWindow(previewWin);
      return;
    }
    const win = this.#waylandWindows.get(this.#lastFocusedTarget);
    if (win && !win.minimized) {
      this.bridge.wland?.input.focus(win.conn, win.surface);
      return;
    }
    if (!this.#terminalMinimized) {
      this.#terminal.focus();
    }
  }

  getBridgeStatus(): WaylandBridgeStatus {
    return this.bridge.getStatus();
  }

  getDisplayConfig(): DesktopDisplayConfig {
    const status = this.bridge.getStatus();
    return {
      scale: this.#waylandScale,
      effectiveScale: status.effectiveScale,
      browserFullscreen: this.#browserFullscreen,
      lodpi: this.#waylandLodpi,
    };
  }

  setWaylandScale(scale: number | null): void {
    this.#waylandScale = scale;
    if (scale === null) {
      localStorage.removeItem(WAYLAND_SCALE_STORAGE_KEY);
    } else {
      localStorage.setItem(WAYLAND_SCALE_STORAGE_KEY, String(scale));
    }
    this.bridge.setScale(scale);
    this.renderStatus();
    this.#onStateChange?.();
  }

  setBrowserFullscreen(enabled: boolean): boolean {
    this.#browserFullscreen = enabled;
    localStorage.setItem(BROWSER_FULLSCREEN_STORAGE_KEY, enabled ? "1" : "0");
    const immediate = this.bridge.setBrowserFullscreen(enabled);
    this.renderStatus();
    this.#onStateChange?.();
    return immediate;
  }

  setWaylandLodpi(enabled: boolean): void {
    this.#waylandLodpi = enabled;
    localStorage.setItem(WAYLAND_LODPI_STORAGE_KEY, enabled ? "1" : "0");
    if (this.#launcherOpen) {
      this.#launcherLodpiEl.checked = enabled;
    }
    this.#onStateChange?.();
  }

  handleDisplayMode(mode: DisplayMode | null): void {
    this.#displayWindow.handleDisplayMode(mode);
    this.renderStatus();
  }

  handleInputState(state: InputState): void {
    this.#displayWindow.handleInputState(state);
  }

  handleAudioStateChange(state: AudioOutState): void {
    this.renderStatus();
    if (state === "waiting" && this.#lastAudioState !== "waiting") {
      this.#toast("虚拟机正在播放音频，点击页面或顶栏「点击启用音频」开始播放");
    }
    this.#lastAudioState = state;
  }

  openPreview(opts?: { port?: number; path?: string; forceNew?: boolean }): void {
    if (!this.#desktopMode) {
      this.setDesktopMode(true);
    }
    const targetPort = opts?.port;
    const targetPath = opts?.path ?? "/";
    if (!opts?.forceNew) {
      if (targetPort !== undefined) {
        const existing = [...this.#previewWindows.values()].find((p) => p.pane.port === targetPort);
        if (existing) {
          existing.minimized = false;
          existing.pane.openAt(targetPort, targetPath);
          this.#focusPreviewWindow(existing);
          return;
        }
      }
      if (this.#previewWindows.size > 0) {
        const top = [...this.#previewWindows.values()].sort((a, b) => b.zIndex - a.zIndex)[0]!;
        top.minimized = false;
        this.#focusPreviewWindow(top);
        if (targetPort !== undefined) {
          top.pane.openAt(targetPort, targetPath);
        } else {
          top.pane.focusPort();
        }
        return;
      }
    }

    const managed = this.#createPreviewWindow(targetPort, targetPath);
    if (targetPort !== undefined) {
      managed.pane.openAt(targetPort, targetPath);
    } else {
      managed.pane.focusPort();
    }
  }

  closeAllPreviews(): void {
    for (const managed of [...this.#previewWindows.values()]) {
      this.#closePreviewWindow(managed);
    }
  }

  renderStatus(): void {
    const active = this.#vmManager.activeSession;
    this.#terminalTitleEl.textContent = active
      ? `${active.title} · ${active.cwd}`
      : "Neovim / Shell";

    const status = this.bridge.getStatus();
    const distroLabel = DISTROS[this.#vmManager.activeDistro].label;
    const gpuTag = this.#vmManager.activeGpuEnabled ? "GPU" : "SHM";
    const scaleTag = formatWaylandScale(status.scale, status.effectiveScale);
    const waylandTag =
      status.state === "connected"
        ? `Wayland (${status.windowCount})`
        : status.state === "loading"
          ? "Wayland 加载中…"
          : status.state === "ready"
            ? "Wayland 就绪"
            : status.state === "error"
              ? "Wayland 错误"
              : "Wayland 待命";
    this.#topbarMetaEl.textContent = `${distroLabel} · ${gpuTag} · ${scaleTag} · ${waylandTag}`;

    const audio = this.#vmManager.audioOut;
    this.#topbarMuteBtn.hidden = !audio;
    if (audio) {
      const muted = this.#vmManager.isAudioMuted();
      const view = formatAudioButtonState(audio.state, muted);
      this.#topbarMuteBtn.textContent = view.label;
      this.#topbarMuteBtn.title = view.title;
      this.#topbarMuteBtn.setAttribute("aria-pressed", String(view.pressed));
      this.#topbarMuteBtn.classList.toggle("topbar-btn-attention", view.attention);
    }

    if (this.#desktopTogglePillBtn) {
      this.#desktopTogglePillBtn.setAttribute("aria-pressed", String(this.#desktopMode));
    }

    const focusedWin = [...this.#waylandWindows.values()].find((w) =>
      this.bridge.wland?.input.focused(w.conn, w.surface),
    );
    const focusedPreview = this.#previewWindows.get(this.#lastFocusedTarget);
    if (focusedWin) {
      this.#topbarTitleEl.textContent = focusedWin.win.title || "Wayland 应用";
    } else if (this.#lastFocusedTarget === "display" && this.#displayWindow.isOpen && !this.#displayWindow.isMinimized) {
      this.#topbarTitleEl.textContent = this.#displayWindow.title;
    } else if (focusedPreview && !focusedPreview.minimized) {
      this.#topbarTitleEl.textContent = focusedPreview.pane.title;
    } else if (!this.#terminalMinimized) {
      this.#topbarTitleEl.textContent = active ? `${active.title} — ${active.cwd}` : "终端";
    } else {
      this.#topbarTitleEl.textContent = "桌面";
    }

    this.#renderDock();
  }

  #getBounds(): DesktopBounds {
    const w = this.#stageEl.clientWidth || window.innerWidth;
    const h = this.#stageEl.clientHeight || Math.max(240, window.innerHeight - 30);
    return { width: w, height: h };
  }

  #applyDesktopModeClass(enabled: boolean): void {
    document.body.classList.toggle("desktop-mode", enabled);
    this.#topbarEl.hidden = !enabled;
    this.#dockEl.hidden = !enabled;

    if (enabled) {
      this.#terminalTabsSlotEl.appendChild(this.#sessionTabsEl);
      if (!this.#terminalRect) {
        const bounds = this.#getBounds();
        const w = Math.max(420, Math.min(1040, Math.round(bounds.width * 0.78)));
        const h = Math.max(300, Math.min(720, Math.round((bounds.height - DOCK_CLEARANCE) * 0.84)));
        this.#terminalRect = clampWindowRect(
          {
            x: Math.max(16, Math.round((bounds.width - w) / 2)),
            y: Math.max(16, Math.round((bounds.height - DOCK_CLEARANCE - h) / 2)),
            width: w,
            height: h,
          },
          bounds,
        );
      }
      this.#applyTerminalWindowGeometry();
      this.#startClock();
      this.restoreFocus();
    } else {
      this.#stopClock();
      this.#floatingHudEl.prepend(this.#sessionTabsEl);
      this.#terminalWindowEl.style.left = "";
      this.#terminalWindowEl.style.top = "";
      this.#terminalWindowEl.style.width = "";
      this.#terminalWindowEl.style.height = "";
      this.#terminalWindowEl.style.zIndex = "";
      this.#terminalWindowEl.classList.remove("minimized", "maximized", "focused");
      this.#terminal.focus();
    }
    this.#scheduleTerminalFit();
  }

  #scheduleTerminalFit(): void {
    if (this.#terminalFitRaf) cancelAnimationFrame(this.#terminalFitRaf);
    this.#terminalFitRaf = requestAnimationFrame(() => {
      this.#terminalFitRaf = 0;
      this.#terminal.fit();
    });
  }

  #startClock(): void {
    const updateClock = () => {
      const now = new Date();
      this.#topbarClockEl.textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    };
    updateClock();
    this.#stopClock();
    this.#clockTimer = setInterval(updateClock, 15_000);
  }

  #stopClock(): void {
    if (this.#clockTimer !== null) {
      clearInterval(this.#clockTimer);
      this.#clockTimer = null;
    }
  }

  #raiseTerminalWindow(focus = true): void {
    this.#terminalMinimized = false;
    this.#terminalZ = ++this.#nextZ;
    this.#lastFocusedTarget = "terminal";
    if (focus) {
      this.blurInputs();
    }
    this.#syncAuxWindowFocus();
    this.#applyTerminalWindowGeometry();
    if (focus && !this.#isModalOpen() && !this.isOverlayOpen) {
      this.#terminal.focus();
    }
    this.renderStatus();
  }

  #toggleTerminalMinimize(): void {
    this.#terminalMinimized = !this.#terminalMinimized;
    if (!this.#terminalMinimized) {
      this.#raiseTerminalWindow(true);
    } else {
      this.#applyTerminalWindowGeometry();
      this.renderStatus();
    }
  }

  #toggleTerminalMaximize(): void {
    if (this.#terminalMinimized) {
      this.#terminalMinimized = false;
    }
    if (!this.#terminalMaximized) {
      this.#terminalRestoreRect = this.#terminalRect ? { ...this.#terminalRect } : null;
      this.#terminalMaximized = true;
    } else {
      this.#terminalMaximized = false;
      if (this.#terminalRestoreRect) {
        this.#terminalRect = clampWindowRect(this.#terminalRestoreRect, this.#getBounds());
      }
      this.#terminalRestoreRect = null;
    }
    this.#raiseTerminalWindow(true);
    this.#scheduleTerminalFit();
  }

  #applyTerminalWindowGeometry(): void {
    if (!this.#desktopMode) return;
    const el = this.#terminalWindowEl;
    el.classList.toggle("minimized", this.#terminalMinimized);
    el.classList.toggle("maximized", this.#terminalMaximized);
    el.classList.toggle("focused", this.#lastFocusedTarget === "terminal" && !this.#terminalMinimized);
    el.style.zIndex = String(this.#terminalZ);

    if (this.#terminalMaximized) {
      const bounds = this.#getBounds();
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = `${bounds.width}px`;
      el.style.height = `${Math.max(240, bounds.height - DOCK_CLEARANCE)}px`;
    } else if (this.#terminalRect) {
      el.style.left = `${this.#terminalRect.x}px`;
      el.style.top = `${this.#terminalRect.y}px`;
      el.style.width = `${this.#terminalRect.width}px`;
      el.style.height = `${this.#terminalRect.height}px`;
    }
  }

  #initTerminalWindowChrome(): void {
    this.#terminalWindowEl.addEventListener(
      "pointerdown",
      () => {
        if (!this.#desktopMode) return;
        this.#lastFocusedTarget = "terminal";
        this.#terminalZ = ++this.#nextZ;
        this.blurInputs();
        this.#syncAuxWindowFocus();
        this.#applyTerminalWindowGeometry();
        this.renderStatus();
      },
      true,
    );

    const minBtn = document.getElementById("btn-term-minimize") as HTMLButtonElement;
    const maxBtn = document.getElementById("btn-term-maximize") as HTMLButtonElement;
    const fsBtn = document.getElementById("btn-term-fullscreen") as HTMLButtonElement;

    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#toggleTerminalMinimize();
    });
    maxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#toggleTerminalMaximize();
    });
    fsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setDesktopMode(false);
    });

    this.#terminalBarEl.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.#toggleTerminalMaximize();
    });

    this.#terminalBarEl.addEventListener("contextmenu", (e) => {
      if (!this.#desktopMode) return;
      e.preventDefault();
      e.stopPropagation();
      this.#raiseTerminalWindow(false);
      this.blurInputs();
      this.#openMenuAt(e.clientX, e.clientY, this.#buildTerminalWindowContextMenuItems());
    });

    this.#terminalBarEl.addEventListener("pointerdown", (e) => {
      if (!this.#desktopMode || e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button")) return;
      if (this.#terminalMaximized) return;
      e.preventDefault();
      this.#raiseTerminalWindow(true);
      const startRect = this.#terminalRect ?? { x: 40, y: 40, width: 800, height: 500 };
      const startX = e.clientX;
      const startY = e.clientY;
      this.#startPointerDrag(e.pointerId, (mv) => {
        const bounds = this.#getBounds();
        this.#terminalRect = clampWindowRect(
          {
            ...startRect,
            x: startRect.x + (mv.clientX - startX),
            y: startRect.y + (mv.clientY - startY),
          },
          bounds,
        );
        this.#applyTerminalWindowGeometry();
      });
    });

    for (const spec of RESIZE_EDGES) {
      const handle = document.createElement("div");
      handle.className = `win-resize-handle win-resize-${spec.className}`;
      handle.addEventListener("pointerdown", (e) => {
        if (!this.#desktopMode || e.button !== 0 || this.#terminalMaximized) return;
        e.preventDefault();
        e.stopPropagation();
        this.#raiseTerminalWindow(true);
        const startRect = this.#terminalRect ?? { x: 40, y: 40, width: 800, height: 500 };
        const startX = e.clientX;
        const startY = e.clientY;
        this.#startPointerDrag(
          e.pointerId,
          (mv) => {
            this.#terminalRect = applyWindowResize(
              startRect,
              mv.clientX - startX,
              mv.clientY - startY,
              spec.edges,
              this.#getBounds(),
            );
            this.#applyTerminalWindowGeometry();
            this.#scheduleTerminalFit();
          },
          () => this.#scheduleTerminalFit(),
        );
      });
      this.#terminalWindowEl.appendChild(handle);
    }
  }

  #initTopbarAndDock(): void {
    document.getElementById("btn-exit-desktop")!.addEventListener("click", () => {
      this.setDesktopMode(false);
    });
    document.getElementById("btn-desktop-launcher")!.addEventListener("click", () => {
      this.toggleLauncher();
    });
    document.getElementById("btn-desktop-control")!.addEventListener("click", () => {
      this.blurInputs();
      this.#onOpenModal();
    });
    this.#topbarMuteBtn.addEventListener("click", () => {
      const audio = this.#vmManager.audioOut;
      if (!audio) return;
      const view = formatAudioButtonState(audio.state, this.#vmManager.isAudioMuted());
      if (view.action === "resume") {
        this.#vmManager.resumeAudio();
      } else {
        this.#vmManager.toggleAudioMute();
      }
      this.renderStatus();
    });

    // Render static icon tiles for pinned & tool Dock entries once
    renderDesktopIcon(document.getElementById("dock-icon-launcher")!, "launcher", "dock");
    renderDesktopIcon(document.getElementById("dock-icon-preview")!, "preview", "dock");
    renderDesktopIcon(document.getElementById("dock-icon-settings")!, "settings", "dock");
    renderDesktopIcon(document.getElementById("dock-icon-fullscreen")!, "fullscreen", "dock");

    const modPrefix = this.#isMac ? "⌘⇧" : "Ctrl+⇧+";
    this.#dockLauncherBtn.dataset.dockKbd = `${modPrefix}K`;
    this.#dockPreviewBtn.dataset.dockSub = "Shift+点击新建";
    this.#dockSettingsBtn.dataset.dockKbd = `${modPrefix}P`;
    this.#dockFullscreenBtn.dataset.dockKbd = `${modPrefix}D`;

    this.#dockTerminalBtn.addEventListener("click", () => {
      this.closeDockMenu();
      if (this.#terminalMinimized) {
        this.#raiseTerminalWindow(true);
      } else if (this.#lastFocusedTarget === "terminal") {
        this.#toggleTerminalMinimize();
      } else {
        this.#raiseTerminalWindow(true);
      }
    });
    this.#dockLauncherBtn.addEventListener("click", () => {
      this.closeDockMenu();
      this.toggleLauncher();
    });
    this.#dockPreviewBtn.addEventListener("click", (e) => {
      this.closeDockMenu();
      this.openPreview({ forceNew: e.shiftKey });
    });
    this.#dockSettingsBtn.addEventListener("click", () => {
      this.blurInputs();
      this.#onOpenModal();
    });
    this.#dockFullscreenBtn.addEventListener("click", () => {
      this.closeDockMenu();
      this.setDesktopMode(false);
    });

    // Delegated floating tooltip, proximity magnification, and context menu on Dock
    this.#dockEl.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (this.#contextMenuOpen) return;
      this.#dockPointerX = e.clientX;
      this.#scheduleDockMagnification();
    });
    this.#dockEl.addEventListener("pointerleave", () => {
      this.#dockPointerX = null;
      this.#resetDockMagnification();
      this.#hideDockTooltip();
    });
    this.#dockEl.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch" || this.#contextMenuOpen) return;
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-item");
      if (!btn) return;
      this.#showDockTooltip(btn);
    });
    this.#dockEl.addEventListener("focusin", (e) => {
      if (this.#contextMenuOpen) return;
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-item");
      if (!btn) return;
      this.#showDockTooltip(btn);
    });
    this.#dockEl.addEventListener("focusout", (e) => {
      const next = e.relatedTarget as Node | null;
      if (!next || !this.#dockEl.contains(next)) {
        this.#hideDockTooltip();
      }
    });
    this.#dockEl.addEventListener("scroll", () => {
      if (this.#hoveredDockBtn && !this.#dockTooltipEl.hidden) {
        this.#positionDockTooltip(this.#hoveredDockBtn);
      }
    });
    this.#dockEl.addEventListener("contextmenu", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-item");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const items = this.#buildDockContextMenuItems(btn);
      if (items.length === 0) return;
      this.#hideDockTooltip();
      this.#resetDockMagnification();
      this.#openMenuAnchored(btn, items);
    });

    window.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.#contextMenuOpen) return;
        const target = e.target as Node | null;
        if (target && this.#contextMenuEl.contains(target)) return;
        this.closeContextMenu();
      },
      true,
    );
    window.addEventListener("blur", () => {
      this.closeContextMenu();
      this.#hideDockTooltip();
      this.#resetDockMagnification();
    });
    window.addEventListener("resize", () => {
      this.closeContextMenu();
      this.#hideDockTooltip();
      this.#syncDockOverflowState();
    });

    this.#desktopTogglePillBtn?.addEventListener("click", () => {
      this.toggleDesktopMode();
    });
  }

  #initDesktopContextMenus(): void {
    this.#stageEl.addEventListener("contextmenu", (e) => {
      if (!this.#desktopMode || this.#isModalOpen() || this.isOverlayOpen) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".terminal-window, .desktop-win, .desktop-dock, .desktop-topbar")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.blurInputs();
      this.#openMenuAt(e.clientX, e.clientY, this.#buildDesktopContextMenuItems());
    });

    this.#topbarEl.addEventListener("contextmenu", (e) => {
      if (!this.#desktopMode || this.#isModalOpen() || this.isOverlayOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.blurInputs();
      this.#openMenuAt(e.clientX, e.clientY, this.#buildDesktopContextMenuItems());
    });
  }

  #initLauncher(): void {
    this.#launcherBackdropEl.addEventListener("mousedown", (e) => {
      if (e.target === this.#launcherBackdropEl) {
        this.closeLauncher();
      }
    });

    document.getElementById("btn-close-launcher")!.addEventListener("click", () => {
      this.closeLauncher();
    });

    this.#launcherFormEl.addEventListener("submit", (e) => {
      e.preventDefault();
      const parsed = parseLauncherCommand(this.#launcherInputEl.value);
      if (!parsed) return;
      void this.#launchCommand(parsed.file, parsed.args, this.#launcherLodpiEl.checked);
    });

    this.#launcherLodpiEl.checked = this.#waylandLodpi;
    this.#launcherLodpiEl.addEventListener("change", () => {
      this.setWaylandLodpi(this.#launcherLodpiEl.checked);
    });

    this.#launcherInstallBtn.addEventListener("click", () => {
      if (this.#vmManager.activeDistro !== "debian") {
        this.#toast("请先在控制中心将发行版切换为 Debian");
        return;
      }
      this.closeLauncher();
      this.#raiseTerminalWindow(true);
      void this.#onOpenInstallInShell(buildDebianDesktopInstallCommand());
    });
  }

  #renderLauncherContent(): void {
    const isDebian = this.#vmManager.activeDistro === "debian";
    const gpuOn = this.#vmManager.activeGpuEnabled;

    this.#launcherDistroNoteEl.textContent = isDebian
      ? gpuOn
        ? "Debian Wayland + VirtIO-GPU / WebGL2 / Vulkan 已启用"
        : "Debian Wayland 已就绪（共享内存渲染；可在控制中心开启 GPU 加速）"
      : "当前为 Alpine 发行版：Wayland 桌面应用需切换至 Debian（控制中心 → 虚拟机与诊断）";
    this.#launcherInstallBtn.disabled = !isDebian || this.#launchingApp;
    this.#launcherLodpiEl.checked = this.#waylandLodpi;

    this.#launcherGridEl.replaceChildren();
    for (const preset of DESKTOP_APP_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "launcher-card";
      btn.disabled = !isDebian || this.#launchingApp;

      const head = document.createElement("div");
      head.className = "launcher-card-head";

      const iconEl = createDesktopIconElement(resolvePresetIcon(preset), "card");
      const meta = document.createElement("div");
      meta.className = "launcher-card-meta";

      const title = document.createElement("span");
      title.className = "launcher-card-title";
      title.textContent = preset.name;

      const desc = document.createElement("span");
      desc.className = "launcher-card-desc";
      desc.textContent = preset.requiresGpu && !gpuOn
        ? `${preset.description}（建议开启 GPU 加速）`
        : preset.description;

      meta.append(title, desc);
      head.append(iconEl, meta);

      const cmd = document.createElement("code");
      cmd.className = "launcher-card-cmd";
      cmd.textContent = `${preset.lodpi ? "wland-lodpi" : "wland"} ${[preset.command, ...preset.args].join(" ")}`;

      btn.append(head, cmd);
      btn.addEventListener("click", () => {
        void this.#launchCommand(preset.command, preset.args, Boolean(preset.lodpi || this.#launcherLodpiEl.checked));
      });
      this.#launcherGridEl.appendChild(btn);
    }
  }

  async #launchCommand(command: string, args: readonly string[], lodpi = false): Promise<void> {
    if (this.#launchingApp) return;
    this.#launchingApp = true;
    this.#renderLauncherContent();
    try {
      await this.bridge.ensureReady();
      await this.#vmManager.launchWaylandApp(command, args, { lodpi });
      this.closeLauncher();
      this.#toast(`正在启动 ${command}${lodpi ? " (1× LoDPI)" : ""}…`);
    } catch (err) {
      this.#toast(err instanceof Error ? err.message : String(err), 5000);
    } finally {
      this.#launchingApp = false;
      if (this.#launcherOpen) this.#renderLauncherContent();
    }
  }

  #initGlobalShortcuts(): void {
    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.key === "D" || e.key === "d") && e.shiftKey && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleDesktopMode();
          return;
        }
        if (
          this.#desktopMode &&
          !this.#isModalOpen() &&
          (e.key === "K" || e.key === "k") &&
          e.shiftKey &&
          (e.ctrlKey || e.metaKey)
        ) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleLauncher();
          return;
        }
        if (this.#contextMenuOpen) {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeContextMenu();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
            const menuButtons = [
              ...this.#contextMenuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
            ];
            if (menuButtons.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              const activeIdx = menuButtons.indexOf(document.activeElement as HTMLButtonElement);
              let nextIdx = 0;
              if (e.key === "ArrowDown") {
                nextIdx = activeIdx >= 0 ? (activeIdx + 1) % menuButtons.length : 0;
              } else if (e.key === "ArrowUp") {
                nextIdx = activeIdx >= 0 ? (activeIdx - 1 + menuButtons.length) % menuButtons.length : menuButtons.length - 1;
              } else if (e.key === "End") {
                nextIdx = menuButtons.length - 1;
              }
              menuButtons[nextIdx]!.focus();
            }
            return;
          }
        }
        if (this.#wallpaperOpen && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.closeWallpaperPicker();
          return;
        }
        if (this.#launcherOpen && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.closeLauncher();
        }
      },
      true,
    );
  }

  #mountWaylandWindow(win: ViewWindow): void {
    if (!this.#desktopMode) {
      this.setDesktopMode(true);
    }

    const frameEl = document.createElement("div");
    frameEl.className = "desktop-win";
    frameEl.dataset.winKey = win.key;

    const titlebarEl = document.createElement("div");
    titlebarEl.className = "desktop-win-bar";

    const initialIconId = resolveWaylandAppIcon(win.appId, win.title);
    const iconEl = createDesktopIconElement(initialIconId, "titlebar");
    iconEl.classList.add("win-title-icon");

    const titleEl = document.createElement("span");
    titleEl.className = "desktop-win-title";
    titleEl.textContent = win.title || win.appId || "Wayland 应用";

    const badgeEl = document.createElement("span");
    badgeEl.className = "desktop-win-badge";
    badgeEl.textContent = win.appId || "wayland";

    const controlsEl = document.createElement("div");
    controlsEl.className = "win-controls";

    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "win-ctrl";
    minBtn.title = "最小化";
    minBtn.textContent = "—";

    const maxBtn = document.createElement("button");
    maxBtn.type = "button";
    maxBtn.className = "win-ctrl";
    maxBtn.title = "最大化";
    maxBtn.textContent = "□";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "win-ctrl win-ctrl-close";
    closeBtn.title = "关闭";
    closeBtn.textContent = "×";

    controlsEl.append(minBtn, maxBtn, closeBtn);
    titlebarEl.append(iconEl, titleEl, badgeEl, controlsEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "desktop-win-body";
    bodyEl.appendChild(win.element);

    frameEl.append(titlebarEl, bodyEl);

    const bounds = this.#getBounds();
    const initialW = Math.max(360, win.element.offsetWidth || 680);
    const initialH = Math.max(240, win.element.offsetHeight || 460);
    const rect = computeCascadeRect(this.#waylandWindows.size, bounds, initialW, initialH);

    const managed: ManagedWaylandWindow = {
      key: win.key,
      conn: win.conn,
      surface: win.surface,
      win,
      frameEl,
      titlebarEl,
      iconEl,
      iconId: initialIconId,
      titleEl,
      badgeEl,
      bodyEl,
      maxBtn,
      rect,
      restoreRect: null,
      maximized: win.maximized,
      fullscreen: win.fullscreen,
      minimized: win.minimized,
      decorated: win.decorated,
      zIndex: ++this.#nextZ,
    };

    for (const spec of RESIZE_EDGES) {
      const handle = document.createElement("div");
      handle.className = `win-resize-handle win-resize-${spec.className}`;
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || managed.maximized || managed.fullscreen) return;
        e.preventDefault();
        e.stopPropagation();
        this.#focusWaylandWindow(managed);
        const curSize = this.#currentWaylandContentSize(managed);
        const startRect: WindowRect = {
          x: managed.rect.x,
          y: managed.rect.y,
          width: curSize.width,
          height: curSize.height,
        };
        const startX = e.clientX;
        const startY = e.clientY;
        let pendingW = startRect.width;
        let pendingH = startRect.height;
        let queued = false;
        this.#startPointerDrag(
          e.pointerId,
          (mv) => {
            const next = applyWindowResize(
              startRect,
              mv.clientX - startX,
              mv.clientY - startY,
              spec.edges,
              this.#getBounds(),
              Math.max(160, managed.win.minW || 240),
              Math.max(120, managed.win.minH || 160),
              managed.win.maxW,
              managed.win.maxH,
            );
            managed.rect.x = next.x;
            managed.rect.y = next.y;
            pendingW = next.width;
            pendingH = next.height;
            this.#applyWaylandWindowPosition(managed);
            if (!queued) {
              queued = true;
              requestAnimationFrame(() => {
                queued = false;
                this.bridge.wland?.engine.requestResize(managed.conn, managed.surface, pendingW, pendingH);
              });
            }
          },
          () => {
            this.bridge.wland?.engine.requestResize(managed.conn, managed.surface, pendingW, pendingH);
          },
        );
      });
      frameEl.appendChild(handle);
    }

    frameEl.addEventListener(
      "pointerdown",
      () => {
        this.#focusWaylandWindow(managed);
      },
      true,
    );

    titlebarEl.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.bridge.wland?.wm.setMaximized(managed.conn, managed.surface, !managed.maximized);
    });

    titlebarEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#focusWaylandWindow(managed);
      this.closeContextMenu();
      this.#openMenuAt(e.clientX, e.clientY, this.#buildWaylandWindowContextMenuItems(managed));
    });

    titlebarEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      if (managed.maximized || managed.fullscreen) return;
      e.preventDefault();
      this.#focusWaylandWindow(managed);
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = managed.rect.x;
      const origY = managed.rect.y;
      this.#startPointerDrag(e.pointerId, (mv) => {
        const size = this.#currentWaylandContentSize(managed);
        const clamped = clampWindowRect(
          {
            x: origX + (mv.clientX - startX),
            y: origY + (mv.clientY - startY),
            width: size.width,
            height: size.height,
          },
          this.#getBounds(),
          120,
          80,
        );
        managed.rect.x = clamped.x;
        managed.rect.y = clamped.y;
        this.#applyWaylandWindowPosition(managed);
      });
    });

    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.bridge.wland?.wm.minimize(managed.conn, managed.surface);
    });
    maxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.bridge.wland?.wm.setMaximized(managed.conn, managed.surface, !managed.maximized);
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.bridge.wland?.engine.close(managed.conn, managed.surface);
    });

    this.#waylandWindows.set(win.key, managed);
    this.#windowsLayerEl.appendChild(frameEl);
    this.#syncWaylandWindowChrome(managed);
    this.#applyWaylandWindowPosition(managed);
    this.#focusWaylandWindow(managed);
    this.renderStatus();
  }

  #unmountWaylandWindow(win: ViewWindow): void {
    const managed = this.#waylandWindows.get(win.key);
    if (!managed) return;
    this.#waylandWindows.delete(win.key);
    win.element.remove();
    managed.frameEl.remove();
    if (this.#lastFocusedTarget === win.key) {
      this.#lastFocusedTarget = "terminal";
      if (this.#desktopMode && !this.#isModalOpen() && !this.isOverlayOpen) {
        this.restoreFocus();
      }
    }
    this.renderStatus();
  }

  #handleWaylandInteractive(ev: InteractiveEvent, press: PointerPress): boolean {
    const wl = this.bridge.wland;
    if (!wl) return false;
    const managed = this.#waylandWindows.get(`c${ev.conn}s${ev.surface}`);
    if (!managed || managed.fullscreen) return false;

    const grab = wl.input.grab(press.pointerId);
    if (!grab.active) return false;

    this.#focusWaylandWindow(managed);
    const startX = press.clientX;
    const startY = press.clientY;
    const curSize = this.#currentWaylandContentSize(managed);
    const startRect: WindowRect = {
      x: managed.rect.x,
      y: managed.rect.y,
      width: curSize.width,
      height: curSize.height,
    };

    if (ev.type === "move" || ev.type === "alt-drag") {
      this.#startPointerDrag(
        press.pointerId,
        (mv) => {
          const clamped = clampWindowRect(
            {
              x: startRect.x + (mv.clientX - startX),
              y: startRect.y + (mv.clientY - startY),
              width: startRect.width,
              height: startRect.height,
            },
            this.#getBounds(),
            120,
            80,
          );
          managed.rect.x = clamped.x;
          managed.rect.y = clamped.y;
          this.#applyWaylandWindowPosition(managed);
        },
        () => grab.end(),
      );
      return true;
    }

    if (ev.type === "resize") {
      let pendingW = startRect.width;
      let pendingH = startRect.height;
      let queued = false;
      this.#startPointerDrag(
        press.pointerId,
        (mv) => {
          const next = applyWindowResize(
            startRect,
            mv.clientX - startX,
            mv.clientY - startY,
            ev.edges,
            this.#getBounds(),
            Math.max(160, managed.win.minW || 240),
            Math.max(120, managed.win.minH || 160),
            managed.win.maxW,
            managed.win.maxH,
          );
          managed.rect.x = next.x;
          managed.rect.y = next.y;
          pendingW = next.width;
          pendingH = next.height;
          this.#applyWaylandWindowPosition(managed);
          if (!queued) {
            queued = true;
            requestAnimationFrame(() => {
              queued = false;
              wl.engine.requestResize(managed.conn, managed.surface, pendingW, pendingH);
            });
          }
        },
        () => {
          wl.engine.requestResize(managed.conn, managed.surface, pendingW, pendingH);
          grab.end();
        },
      );
      return true;
    }

    grab.end();
    return false;
  }

  #syncWaylandWindows(): void {
    const wl = this.bridge.wland;
    if (!wl) return;
    const entries = new Map<string, WindowEntry>();
    for (const entry of wl.windows()) {
      entries.set(entry.key, entry);
    }

    for (const [key, managed] of this.#waylandWindows) {
      const liveWin = wl.view.window(managed.conn, managed.surface);
      if (liveWin) {
        managed.win = liveWin;
      }
      const entry = entries.get(key);
      if (entry) {
        managed.maximized = entry.maximized;
        managed.fullscreen = entry.fullscreen;
        managed.minimized = entry.minimized;
        managed.decorated = entry.decorated;
      } else if (liveWin) {
        managed.maximized = liveWin.maximized;
        managed.fullscreen = liveWin.fullscreen;
        managed.minimized = liveWin.minimized;
        managed.decorated = liveWin.decorated;
      }
      this.#syncWaylandWindowChrome(managed);
      this.#applyWaylandWindowPosition(managed);
    }
    this.renderStatus();
  }

  #syncWaylandFocus(): void {
    const wl = this.bridge.wland;
    let anyWaylandFocused = false;
    for (const managed of this.#waylandWindows.values()) {
      const focused = Boolean(wl?.input.focused(managed.conn, managed.surface)) && !managed.minimized;
      managed.frameEl.classList.toggle("focused", focused);
      if (focused) {
        anyWaylandFocused = true;
        this.#lastFocusedTarget = managed.key;
      }
    }
    if (anyWaylandFocused) {
      this.#displayWindow.setFocused(false);
    }
    this.#syncAuxWindowFocus();
    this.renderStatus();
  }

  #syncAuxWindowFocus(): void {
    this.#terminalWindowEl.classList.toggle(
      "focused",
      this.#lastFocusedTarget === "terminal" && !this.#terminalMinimized,
    );
    for (const preview of this.#previewWindows.values()) {
      preview.frameEl.classList.toggle(
        "focused",
        this.#lastFocusedTarget === preview.key && !preview.minimized,
      );
    }
  }

  #focusDisplayWindow(): void {
    if (!this.#displayWindow.isOpen) return;
    this.blurWayland();
    this.#lastFocusedTarget = "display";
    this.#displayWindow.raise(++this.#nextZ);
    this.#displayWindow.setFocused(true);
    this.#syncAuxWindowFocus();
    this.renderStatus();
  }

  #createPreviewWindow(initialPort?: number, initialPath = "/"): ManagedPreviewWindow {
    const key = `preview-${this.#nextPreviewSeq++}`;
    const frameEl = document.createElement("div");
    frameEl.className = "desktop-win preview-win";
    frameEl.dataset.previewKey = key;

    const titlebarEl = document.createElement("div");
    titlebarEl.className = "desktop-win-bar";

    const titleIconEl = createDesktopIconElement("preview", "titlebar");
    titleIconEl.classList.add("win-title-icon");

    const titleEl = document.createElement("span");
    titleEl.className = "desktop-win-title";
    titleEl.textContent = initialPort !== undefined ? `预览 :${initialPort}` : "Guest 端口预览";

    const badgeEl = document.createElement("span");
    badgeEl.className = "desktop-win-badge";
    badgeEl.textContent = "preview";

    const controlsEl = document.createElement("div");
    controlsEl.className = "win-controls";

    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "win-ctrl";
    minBtn.title = "最小化";
    minBtn.textContent = "—";

    const maxBtn = document.createElement("button");
    maxBtn.type = "button";
    maxBtn.className = "win-ctrl";
    maxBtn.title = "最大化";
    maxBtn.textContent = "□";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "win-ctrl win-ctrl-close";
    closeBtn.title = "关闭";
    closeBtn.textContent = "×";

    controlsEl.append(minBtn, maxBtn, closeBtn);
    titlebarEl.append(titleIconEl, titleEl, badgeEl, controlsEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "desktop-win-body";
    frameEl.append(titlebarEl, bodyEl);

    const bounds = this.#getBounds();
    const rect = computeCascadeRect(this.#previewWindows.size + 1, bounds, 760, 540);
    const managed: ManagedPreviewWindow = {
      key,
      pane: null as unknown as GuestPreviewPane,
      frameEl,
      titlebarEl,
      titleEl,
      badgeEl,
      bodyEl,
      maxBtn,
      rect,
      restoreRect: null,
      maximized: false,
      minimized: false,
      zIndex: ++this.#nextZ,
    };

    const pane = new GuestPreviewPane({
      root: bodyEl,
      getVm: () => this.#vmManager.vm,
      showNewWindowButton: true,
      initialPort,
      initialPath,
      onNewWindow: () => {
        this.openPreview({ forceNew: true });
      },
      onTitleChange: (title) => {
        managed.titleEl.textContent = title;
        managed.badgeEl.textContent = managed.pane.port !== null ? `:${managed.pane.port}` : "preview";
        this.renderStatus();
      },
    });
    managed.pane = pane;

    for (const spec of RESIZE_EDGES) {
      const handle = document.createElement("div");
      handle.className = `win-resize-handle win-resize-${spec.className}`;
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || managed.maximized) return;
        e.preventDefault();
        e.stopPropagation();
        this.#focusPreviewWindow(managed);
        const startRect = { ...managed.rect };
        const startX = e.clientX;
        const startY = e.clientY;
        this.#startPointerDrag(e.pointerId, (mv) => {
          managed.rect = applyWindowResize(
            startRect,
            mv.clientX - startX,
            mv.clientY - startY,
            spec.edges,
            this.#getBounds(),
            360,
            260,
          );
          this.#applyPreviewWindowPosition(managed);
        });
      });
      frameEl.appendChild(handle);
    }

    frameEl.addEventListener(
      "pointerdown",
      () => {
        this.#focusPreviewWindow(managed);
      },
      true,
    );

    titlebarEl.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.#togglePreviewMaximize(managed);
    });

    titlebarEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#focusPreviewWindow(managed);
      this.#openMenuAt(e.clientX, e.clientY, this.#buildPreviewWindowContextMenuItems(managed));
    });

    titlebarEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      if (managed.maximized) return;
      e.preventDefault();
      this.#focusPreviewWindow(managed);
      const startRect = { ...managed.rect };
      const startX = e.clientX;
      const startY = e.clientY;
      this.#startPointerDrag(e.pointerId, (mv) => {
        managed.rect = clampWindowRect(
          {
            ...startRect,
            x: startRect.x + (mv.clientX - startX),
            y: startRect.y + (mv.clientY - startY),
          },
          this.#getBounds(),
        );
        this.#applyPreviewWindowPosition(managed);
      });
    });

    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      managed.minimized = true;
      this.#applyPreviewWindowPosition(managed);
      this.#syncAuxWindowFocus();
      this.renderStatus();
    });

    maxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#togglePreviewMaximize(managed);
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#closePreviewWindow(managed);
    });

    this.#previewWindows.set(key, managed);
    this.#windowsLayerEl.appendChild(frameEl);
    this.#applyPreviewWindowPosition(managed);
    this.#focusPreviewWindow(managed);
    return managed;
  }

  #togglePreviewMaximize(managed: ManagedPreviewWindow): void {
    managed.minimized = false;
    if (!managed.maximized) {
      managed.restoreRect = { ...managed.rect };
      managed.maximized = true;
    } else {
      managed.maximized = false;
      if (managed.restoreRect) {
        managed.rect = clampWindowRect(managed.restoreRect, this.#getBounds());
      }
      managed.restoreRect = null;
    }
    this.#focusPreviewWindow(managed);
  }

  #focusPreviewWindow(managed: ManagedPreviewWindow): void {
    this.blurInputs();
    managed.minimized = false;
    managed.zIndex = ++this.#nextZ;
    this.#lastFocusedTarget = managed.key;
    this.#applyPreviewWindowPosition(managed);
    this.#syncAuxWindowFocus();
    this.renderStatus();
  }

  #closePreviewWindow(managed: ManagedPreviewWindow): void {
    this.#previewWindows.delete(managed.key);
    managed.pane.dispose();
    managed.frameEl.remove();
    if (this.#lastFocusedTarget === managed.key) {
      this.#lastFocusedTarget = "terminal";
      if (this.#desktopMode && !this.#isModalOpen() && !this.isOverlayOpen) {
        this.restoreFocus();
      }
    }
    this.renderStatus();
  }

  #applyPreviewWindowPosition(managed: ManagedPreviewWindow): void {
    const el = managed.frameEl;
    el.style.zIndex = String(managed.zIndex);
    el.classList.toggle("minimized", managed.minimized);
    el.classList.toggle("maximized", managed.maximized);
    managed.maxBtn.textContent = managed.maximized ? "❐" : "□";
    if (managed.maximized) {
      const bounds = this.#getBounds();
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = `${bounds.width}px`;
      el.style.height = `${Math.max(240, bounds.height - DOCK_CLEARANCE)}px`;
    } else {
      el.style.left = `${managed.rect.x}px`;
      el.style.top = `${managed.rect.y}px`;
      el.style.width = `${managed.rect.width}px`;
      el.style.height = `${managed.rect.height}px`;
    }
  }

  #syncWaylandWindowChrome(managed: ManagedWaylandWindow): void {
    const { win } = managed;
    const nextIconId = resolveWaylandAppIcon(win.appId, win.title);
    if (nextIconId !== managed.iconId) {
      managed.iconId = nextIconId;
      renderDesktopIcon(managed.iconEl, nextIconId, "titlebar");
      managed.iconEl.classList.add("win-title-icon");
    }
    managed.titleEl.textContent = win.title || win.appId || "Wayland 应用";
    managed.badgeEl.textContent = win.appId || "wayland";
    managed.maxBtn.textContent = managed.maximized ? "❐" : "□";
    managed.frameEl.classList.toggle("decorated", managed.decorated);
    managed.frameEl.classList.toggle("csd", !managed.decorated);
    managed.frameEl.classList.toggle("maximized", managed.maximized);
    managed.frameEl.classList.toggle("fullscreen", managed.fullscreen);
    managed.frameEl.classList.toggle("minimized", managed.minimized);
  }

  #currentWaylandContentSize(managed: ManagedWaylandWindow): { width: number; height: number } {
    const w = managed.win.element.offsetWidth || managed.rect.width || 680;
    const h = managed.win.element.offsetHeight || managed.rect.height || 460;
    return { width: w, height: h };
  }

  #applyWaylandWindowPosition(managed: ManagedWaylandWindow): void {
    const el = managed.frameEl;
    el.style.zIndex = String(managed.zIndex);

    if (managed.fullscreen) {
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = "100%";
      el.style.height = "100%";
      this.bridge.wland?.engine.setWindowPosition(managed.conn, managed.surface, 0, 0);
      return;
    }

    if (managed.maximized) {
      const bounds = this.#getBounds();
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = `${bounds.width}px`;
      el.style.height = `${Math.max(240, bounds.height - DOCK_CLEARANCE)}px`;
      const bodyTop = managed.decorated ? managed.titlebarEl.offsetHeight || 28 : 0;
      this.bridge.wland?.engine.setWindowPosition(managed.conn, managed.surface, 0, bodyTop);
      return;
    }

    el.style.left = `${managed.rect.x}px`;
    el.style.top = `${managed.rect.y}px`;
    el.style.width = "";
    el.style.height = "";

    const bodyTop = managed.decorated ? managed.titlebarEl.offsetHeight || 28 : 0;
    this.bridge.wland?.engine.setWindowPosition(
      managed.conn,
      managed.surface,
      managed.rect.x,
      managed.rect.y + bodyTop,
    );
  }

  #focusWaylandWindow(managed: ManagedWaylandWindow): void {
    this.#displayWindow.setFocused(false);
    managed.zIndex = ++this.#nextZ;
    this.#lastFocusedTarget = managed.key;
    this.#applyWaylandWindowPosition(managed);
    if (!this.#isModalOpen() && !this.isOverlayOpen) {
      this.bridge.wland?.input.focus(managed.conn, managed.surface);
    }
    this.#syncWaylandFocus();
  }

  #clampAllWindowsToStage(): void {
    const bounds = this.#getBounds();
    if (this.#terminalRect) {
      this.#terminalRect = clampWindowRect(this.#terminalRect, bounds);
      this.#applyTerminalWindowGeometry();
    }
    this.#displayWindow.clampToBounds();
    for (const preview of this.#previewWindows.values()) {
      preview.rect = clampWindowRect(preview.rect, bounds, 360, 260);
      this.#applyPreviewWindowPosition(preview);
    }
    for (const managed of this.#waylandWindows.values()) {
      const size = this.#currentWaylandContentSize(managed);
      const clamped = clampWindowRect(
        {
          x: managed.rect.x,
          y: managed.rect.y,
          width: size.width,
          height: size.height,
        },
        bounds,
        120,
        80,
      );
      managed.rect.x = clamped.x;
      managed.rect.y = clamped.y;
      this.#applyWaylandWindowPosition(managed);
    }
    this.#scheduleTerminalFit();
  }

  #renderDock(): void {
    const activeSession = this.#vmManager.activeSession;
    const termIconId: DesktopIconId = activeSession?.mode === "shell" ? "terminal" : "neovim";
    if (termIconId !== this.#lastTerminalIconId) {
      this.#lastTerminalIconId = termIconId;
      renderDesktopIcon(this.#dockTerminalIconEl, termIconId, "dock");
      renderDesktopIcon(this.#terminalWinIconEl, termIconId, "titlebar");
      this.#terminalWinIconEl.classList.add("win-title-icon");
    }

    if (!this.#desktopMode) return;

    const sessionsCount = this.#vmManager.sessions.length;
    const termLabel = activeSession ? `${activeSession.title} · ${activeSession.cwd}` : "Neovim / 终端";
    this.#dockTerminalBtn.classList.toggle("active", this.#lastFocusedTarget === "terminal" && !this.#terminalMinimized);
    this.#dockTerminalBtn.classList.toggle("minimized", this.#terminalMinimized);
    this.#dockTerminalBtn.classList.add("running");
    this.#dockTerminalBtn.dataset.dockTooltip = termLabel;
    this.#dockTerminalBtn.dataset.dockSub = this.#terminalMinimized ? "已最小化" : "";
    this.#dockTerminalBtn.setAttribute("aria-label", termLabel);
    if (sessionsCount > 1) {
      this.#dockTerminalBadgeEl.textContent = String(sessionsCount);
      this.#dockTerminalBadgeEl.hidden = false;
    } else {
      this.#dockTerminalBadgeEl.hidden = true;
    }

    this.#dockLauncherBtn.classList.toggle("active", this.#launcherOpen);
    this.#dockLauncherBtn.setAttribute("aria-pressed", String(this.#launcherOpen));

    const previewCount = this.#previewWindows.size;
    this.#dockPreviewBtn.classList.toggle("running", previewCount > 0);
    if (previewCount > 1) {
      this.#dockPreviewBadgeEl.textContent = String(previewCount);
      this.#dockPreviewBadgeEl.hidden = false;
    } else {
      this.#dockPreviewBadgeEl.hidden = true;
    }

    const modalOpen = this.#isModalOpen();
    this.#dockSettingsBtn.classList.toggle("active", modalOpen);
    this.#dockSettingsBtn.setAttribute("aria-pressed", String(modalOpen));

    const descriptors: DockAppDescriptor[] = [];

    if (this.#displayWindow.isOpen) {
      const displayTitle = this.#displayWindow.title;
      descriptors.push({
        key: "display",
        iconId: "display",
        title: displayTitle,
        subtitle: this.#displayWindow.isMinimized ? "已最小化" : "虚拟帧缓冲 / GPU",
        active: this.#lastFocusedTarget === "display" && !this.#displayWindow.isMinimized,
        minimized: this.#displayWindow.isMinimized,
        onClick: () => {
          this.closeDockMenu();
          if (this.#displayWindow.isMinimized) {
            this.#displayWindow.restore(++this.#nextZ);
          } else if (this.#lastFocusedTarget === "display") {
            this.#displayWindow.minimize();
          } else {
            this.#focusDisplayWindow();
          }
        },
        onMiddleClick: () => this.#displayWindow.close(),
        onContextMenu: () => [
          { kind: "heading", label: displayTitle },
          {
            kind: "action",
            label: this.#displayWindow.isMinimized
              ? "还原窗口"
              : this.#lastFocusedTarget === "display"
                ? "最小化窗口"
                : "置顶显示",
            onSelect: () => {
              if (this.#displayWindow.isMinimized) {
                this.#displayWindow.restore(++this.#nextZ);
              } else if (this.#lastFocusedTarget === "display") {
                this.#displayWindow.minimize();
              } else {
                this.#focusDisplayWindow();
              }
            },
          },
          {
            kind: "action",
            label: "切换最大化",
            onSelect: () => this.#displayWindow.toggleMaximize(++this.#nextZ),
          },
          { kind: "sep" },
          {
            kind: "action",
            label: "隐藏显示器窗口",
            danger: true,
            onSelect: () => this.#displayWindow.close(),
          },
        ],
      });
    }

    for (const preview of this.#previewWindows.values()) {
      const portTag = preview.pane.port !== null ? `:${preview.pane.port}` : undefined;
      descriptors.push({
        key: preview.key,
        iconId: "preview",
        title: preview.pane.title,
        subtitle: preview.minimized ? "已最小化" : "Guest 端口预览",
        badge: portTag,
        active: this.#lastFocusedTarget === preview.key && !preview.minimized,
        minimized: preview.minimized,
        onClick: () => {
          this.closeDockMenu();
          if (preview.minimized) {
            this.#focusPreviewWindow(preview);
          } else if (this.#lastFocusedTarget === preview.key) {
            preview.minimized = true;
            this.#applyPreviewWindowPosition(preview);
            this.#syncAuxWindowFocus();
            this.renderStatus();
          } else {
            this.#focusPreviewWindow(preview);
          }
        },
        onMiddleClick: () => this.#closePreviewWindow(preview),
        onContextMenu: () => [
          { kind: "heading", label: preview.pane.title },
          {
            kind: "action",
            label: preview.minimized
              ? "还原窗口"
              : this.#lastFocusedTarget === preview.key
                ? "最小化窗口"
                : "置顶显示",
            onSelect: () => {
              if (preview.minimized) {
                this.#focusPreviewWindow(preview);
              } else if (this.#lastFocusedTarget === preview.key) {
                preview.minimized = true;
                this.#applyPreviewWindowPosition(preview);
                this.#syncAuxWindowFocus();
                this.renderStatus();
              } else {
                this.#focusPreviewWindow(preview);
              }
            },
          },
          {
            kind: "action",
            label: preview.maximized ? "还原大小" : "最大化窗口",
            onSelect: () => this.#togglePreviewMaximize(preview),
          },
          {
            kind: "action",
            label: "新建预览窗口",
            onSelect: () => this.openPreview({ forceNew: true }),
          },
          { kind: "sep" },
          {
            kind: "action",
            label: "关闭窗口",
            danger: true,
            onSelect: () => this.#closePreviewWindow(preview),
          },
        ],
      });
    }

    const wl = this.bridge.wland;
    const windows = wl ? wl.windows() : [];
    for (const win of windows) {
      const title = win.title || win.appId || "Wayland 应用";
      const iconId = resolveWaylandAppIcon(win.appId, win.title);
      descriptors.push({
        key: win.key,
        iconId,
        title,
        subtitle: win.minimized ? "已最小化" : win.appId || "Wayland",
        active: win.focused && !win.minimized,
        minimized: win.minimized,
        onClick: () => {
          this.closeDockMenu();
          const managed = this.#waylandWindows.get(win.key);
          if (win.minimized) {
            win.restore();
            if (managed) this.#focusWaylandWindow(managed);
          } else if (win.focused) {
            win.minimize();
          } else if (managed) {
            this.#focusWaylandWindow(managed);
          } else {
            win.raise();
          }
        },
        onMiddleClick: () => {
          win.close();
        },
        onContextMenu: () => [
          { kind: "heading", label: title },
          {
            kind: "action",
            label: win.minimized ? "还原窗口" : win.focused ? "最小化窗口" : "置顶显示",
            onSelect: () => {
              const managed = this.#waylandWindows.get(win.key);
              if (win.minimized) {
                win.restore();
                if (managed) this.#focusWaylandWindow(managed);
              } else if (win.focused) {
                win.minimize();
              } else if (managed) {
                this.#focusWaylandWindow(managed);
              } else {
                win.raise();
              }
            },
          },
          {
            kind: "action",
            label: win.maximized ? "还原大小" : "最大化窗口",
            onSelect: () => win.setMaximized(!win.maximized),
          },
          { kind: "sep" },
          {
            kind: "action",
            label: "关闭应用",
            danger: true,
            onSelect: () => win.close(),
          },
        ],
      });
    }

    const activeKeys = new Set<string>();
    for (let i = 0; i < descriptors.length; i += 1) {
      const desc = descriptors[i]!;
      activeKeys.add(desc.key);
      this.#dockAppHandlers.set(desc.key, {
        onClick: desc.onClick,
        onMiddleClick: desc.onMiddleClick,
        onContextMenu: desc.onContextMenu,
      });

      let node = this.#dockAppNodes.get(desc.key);
      if (!node) {
        node = this.#createDockAppNode(desc.key, desc.iconId);
        this.#dockAppNodes.set(desc.key, node);
      } else if (node.iconId !== desc.iconId) {
        node.iconId = desc.iconId;
        renderDesktopIcon(node.iconWrap, desc.iconId, "dock");
      }

      const { btn, badgeEl } = node;
      btn.classList.toggle("active", desc.active);
      btn.classList.toggle("minimized", desc.minimized);
      btn.classList.add("running");
      btn.dataset.dockTooltip = desc.title;
      btn.dataset.dockSub = desc.subtitle ?? "";
      btn.dataset.dockKbd = desc.kbd ?? "";
      btn.setAttribute("aria-label", desc.title);
      if (desc.badge) {
        badgeEl.textContent = desc.badge;
        badgeEl.hidden = false;
      } else {
        badgeEl.hidden = true;
      }

      if (this.#dockAppsEl.children[i] !== btn) {
        this.#dockAppsEl.insertBefore(btn, this.#dockAppsEl.children[i] ?? null);
      }
    }

    for (const [key, node] of this.#dockAppNodes) {
      if (!activeKeys.has(key)) {
        if (this.#hoveredDockBtn === node.btn) {
          this.#hideDockTooltip();
        }
        node.btn.remove();
        this.#dockAppNodes.delete(key);
        this.#dockAppHandlers.delete(key);
      }
    }

    const totalItems = 5 + descriptors.length;
    this.#dockEl.classList.toggle("compact", totalItems >= 10);
    this.#syncDockOverflowState();

    if (this.#hoveredDockBtn) {
      if (this.#hoveredDockBtn.isConnected && !this.#contextMenuOpen) {
        this.#showDockTooltip(this.#hoveredDockBtn);
      } else {
        this.#hideDockTooltip();
      }
    }
  }

  #createDockAppNode(key: string, iconId: DesktopIconId): DockAppNode {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dock-item dock-app-item dock-item-enter";
    btn.dataset.dockKey = key;

    const iconWrap = createDesktopIconElement(iconId, "dock");
    iconWrap.classList.add("dock-icon-wrap");

    const badgeEl = document.createElement("span");
    badgeEl.className = "dock-badge";
    badgeEl.hidden = true;

    const indicator = document.createElement("span");
    indicator.className = "dock-indicator";
    indicator.setAttribute("aria-hidden", "true");

    btn.append(iconWrap, badgeEl, indicator);
    btn.addEventListener("animationend", () => {
      btn.classList.remove("dock-item-enter");
    }, { once: true });
    btn.addEventListener("click", () => {
      this.#dockAppHandlers.get(key)?.onClick();
    });
    btn.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.#dockAppHandlers.get(key)?.onMiddleClick?.();
      }
    });

    return { btn, iconWrap, badgeEl, iconId };
  }

  #canMagnifyDock(): boolean {
    if (!this.#desktopMode || this.#contextMenuOpen || this.#dockEl.classList.contains("dock-overflow")) {
      return false;
    }
    return (
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  #scheduleDockMagnification(): void {
    if (this.#dockMagnifyRaf !== 0) return;
    this.#dockMagnifyRaf = requestAnimationFrame(() => {
      this.#dockMagnifyRaf = 0;
      if (!this.#canMagnifyDock() || this.#dockPointerX === null) {
        this.#resetDockMagnification();
        return;
      }
      const items = [...this.#dockEl.querySelectorAll<HTMLButtonElement>(".dock-item")];
      if (items.length === 0) return;
      const centers = items.map((item) => {
        const rect = item.getBoundingClientRect();
        return rect.left + rect.width / 2;
      });
      const scales = computeDockMagnification(centers, this.#dockPointerX, 1.24, 92);
      for (let i = 0; i < items.length; i += 1) {
        const scale = scales[i] ?? 1;
        items[i]!.style.setProperty("--dock-scale", String(scale));
      }
      if (this.#hoveredDockBtn && !this.#dockTooltipEl.hidden) {
        this.#positionDockTooltip(this.#hoveredDockBtn);
      }
    });
  }

  #resetDockMagnification(): void {
    if (this.#dockMagnifyRaf !== 0) {
      cancelAnimationFrame(this.#dockMagnifyRaf);
      this.#dockMagnifyRaf = 0;
    }
    for (const item of this.#dockEl.querySelectorAll<HTMLButtonElement>(".dock-item")) {
      item.style.removeProperty("--dock-scale");
    }
  }

  #syncDockOverflowState(): void {
    if (!this.#desktopMode) return;
    this.#dockEl.classList.remove("dock-overflow");
    const overflowing = this.#dockEl.scrollWidth > this.#dockEl.clientWidth + 2;
    this.#dockEl.classList.toggle("dock-overflow", overflowing);
    if (overflowing) {
      this.#resetDockMagnification();
    }
  }

  #showDockTooltip(btn: HTMLButtonElement): void {
    const labelText = btn.dataset.dockTooltip;
    if (!labelText || !this.#desktopMode || this.#contextMenuOpen) return;
    this.#hoveredDockBtn = btn;

    const labelEl = document.createElement("span");
    labelEl.className = "dock-tooltip-label";
    labelEl.textContent = labelText;

    const nodes: Node[] = [labelEl];
    const subText = btn.dataset.dockSub;
    if (subText) {
      const subEl = document.createElement("span");
      subEl.className = "dock-tooltip-sub";
      subEl.textContent = subText;
      nodes.push(subEl);
    }
    const kbdText = btn.dataset.dockKbd;
    if (kbdText) {
      const kbdEl = document.createElement("kbd");
      kbdEl.className = "dock-tooltip-kbd";
      kbdEl.textContent = kbdText;
      nodes.push(kbdEl);
    }

    this.#dockTooltipEl.replaceChildren(...nodes);
    this.#dockTooltipEl.hidden = false;
    this.#positionDockTooltip(btn);
  }

  #positionDockTooltip(btn: HTMLButtonElement): void {
    const btnRect = btn.getBoundingClientRect();
    const dockRect = this.#dockEl.getBoundingClientRect();
    const tipRect = this.#dockTooltipEl.getBoundingClientRect();
    const pad = 12;
    const center = btnRect.left + btnRect.width / 2;
    const left = Math.max(
      pad,
      Math.min(Math.round(center - tipRect.width / 2), window.innerWidth - tipRect.width - pad),
    );
    const top = Math.max(36, Math.round(dockRect.top - tipRect.height - 16));
    this.#dockTooltipEl.style.left = `${left}px`;
    this.#dockTooltipEl.style.top = `${top}px`;
  }

  #hideDockTooltip(): void {
    this.#hoveredDockBtn = null;
    this.#dockTooltipEl.hidden = true;
    this.#dockTooltipEl.replaceChildren();
  }

  #buildDockContextMenuItems(btn: HTMLButtonElement): ContextMenuItem[] {
    const dynamicKey = btn.dataset.dockKey;
    if (dynamicKey) {
      return this.#dockAppHandlers.get(dynamicKey)?.onContextMenu() ?? [];
    }

    const modPrefix = this.#isMac ? "⌘⇧" : "Ctrl+⇧+";
    switch (btn.id) {
      case "dock-btn-terminal": {
        const active = this.#vmManager.activeSession;
        const atLimit = this.#vmManager.sessions.length >= MAX_TERMINAL_SESSIONS;
        const items: ContextMenuItem[] = [
          { kind: "heading", label: active ? active.title : "Neovim / 终端" },
          {
            kind: "action",
            label: this.#terminalMinimized
              ? "还原窗口"
              : this.#lastFocusedTarget === "terminal"
                ? "最小化窗口"
                : "置顶显示",
            onSelect: () => {
              if (this.#terminalMinimized) this.#raiseTerminalWindow(true);
              else if (this.#lastFocusedTarget === "terminal") this.#toggleTerminalMinimize();
              else this.#raiseTerminalWindow(true);
            },
          },
          {
            kind: "action",
            label: this.#terminalMaximized ? "还原大小" : "最大化窗口",
            onSelect: () => this.#toggleTerminalMaximize(),
          },
        ];
        if (this.#onOpenSession) {
          const openSession = this.#onOpenSession;
          items.push(
            { kind: "sep" },
            {
              kind: "action",
              label: "新建 Neovim 会话",
              disabled: atLimit,
              onSelect: () => {
                this.#raiseTerminalWindow(true);
                void openSession("nvim").catch((err) => {
                  this.#toast(err instanceof Error ? err.message : String(err));
                });
              },
            },
            {
              kind: "action",
              label: "新建 Shell 会话",
              disabled: atLimit,
              onSelect: () => {
                this.#raiseTerminalWindow(true);
                void openSession("shell").catch((err) => {
                  this.#toast(err instanceof Error ? err.message : String(err));
                });
              },
            },
          );
        }
        items.push(
          { kind: "sep" },
          {
            kind: "action",
            label: "切换至全屏终端",
            kbd: `${modPrefix}D`,
            onSelect: () => this.setDesktopMode(false),
          },
        );
        return items;
      }
      case "dock-btn-launcher": {
        const isDebian = this.#vmManager.activeDistro === "debian";
        const items: ContextMenuItem[] = [
          { kind: "heading", label: "应用启动器" },
          {
            kind: "action",
            label: this.#launcherOpen ? "关闭应用启动器" : "打开应用启动器",
            kbd: `${modPrefix}K`,
            onSelect: () => this.toggleLauncher(),
          },
          { kind: "sep" },
        ];
        for (const preset of DESKTOP_APP_PRESETS) {
          items.push({
            kind: "action",
            label: `启动 ${preset.name}`,
            disabled: !isDebian || this.#launchingApp,
            onSelect: () => {
              void this.#launchCommand(preset.command, preset.args, Boolean(preset.lodpi || this.#waylandLodpi));
            },
          });
        }
        return items;
      }
      case "dock-btn-preview": {
        const items: ContextMenuItem[] = [
          { kind: "heading", label: "Guest 端口预览" },
          {
            kind: "action",
            label: "打开端口预览",
            onSelect: () => this.openPreview(),
          },
          {
            kind: "action",
            label: "新建预览窗口",
            onSelect: () => this.openPreview({ forceNew: true }),
          },
        ];
        if (this.#previewWindows.size > 0) {
          items.push(
            { kind: "sep" },
            {
              kind: "action",
              label: `关闭全部预览 (${this.#previewWindows.size})`,
              danger: true,
              onSelect: () => this.closeAllPreviews(),
            },
          );
        }
        return items;
      }
      case "dock-btn-settings":
        return [
          { kind: "heading", label: "控制中心与外观" },
          {
            kind: "action",
            label: "打开控制中心",
            kbd: `${modPrefix}P`,
            onSelect: () => {
              this.blurInputs();
              this.#onOpenModal();
            },
          },
          { kind: "sep" },
          {
            kind: "action",
            label: "更换壁纸…",
            onSelect: () => this.openWallpaperPicker(),
          },
          {
            kind: "action",
            label: "下一张壁纸",
            onSelect: () => this.cycleWallpaper(),
          },
        ];
      case "dock-btn-fullscreen":
        return [
          { kind: "heading", label: "视图模式" },
          {
            kind: "action",
            label: "返回全屏终端",
            kbd: `${modPrefix}D`,
            onSelect: () => this.setDesktopMode(false),
          },
        ];
      default:
        return [];
    }
  }

  #buildDesktopContextMenuItems(): ContextMenuItem[] {
    const modPrefix = this.#isMac ? "⌘⇧" : "Ctrl+⇧+";
    const atLimit = this.#vmManager.sessions.length >= MAX_TERMINAL_SESSIONS;
    const hasWindows =
      this.#displayWindow.isOpen || this.#previewWindows.size > 0 || this.#waylandWindows.size > 0 || true;
    const allMinimized = this.#areAllWindowsMinimized();

    const items: ContextMenuItem[] = [
      { kind: "heading", label: "unkernel desktop" },
      {
        kind: "action",
        label: "打开应用启动器",
        kbd: `${modPrefix}K`,
        onSelect: () => this.openLauncher(),
      },
    ];

    if (this.#onOpenSession) {
      const openSession = this.#onOpenSession;
      items.push(
        {
          kind: "action",
          label: "新建 Shell 终端",
          disabled: atLimit,
          onSelect: () => {
            this.#raiseTerminalWindow(true);
            void openSession("shell").catch((err) => {
              this.#toast(err instanceof Error ? err.message : String(err));
            });
          },
        },
        {
          kind: "action",
          label: "新建 Neovim 会话",
          disabled: atLimit,
          onSelect: () => {
            this.#raiseTerminalWindow(true);
            void openSession("nvim").catch((err) => {
              this.#toast(err instanceof Error ? err.message : String(err));
            });
          },
        },
      );
    }

    items.push(
      {
        kind: "action",
        label: "打开端口预览",
        onSelect: () => this.openPreview(),
      },
      { kind: "sep" },
      {
        kind: "action",
        label: "层叠整理窗口",
        disabled: !hasWindows,
        onSelect: () => this.#cascadeAllWindows(),
      },
      {
        kind: "action",
        label: allMinimized ? "还原全部窗口" : "显示桌面",
        onSelect: () => this.#toggleShowDesktop(),
      },
      { kind: "sep" },
      {
        kind: "action",
        label: "更换壁纸…",
        onSelect: () => this.openWallpaperPicker(),
      },
      {
        kind: "action",
        label: "下一张壁纸",
        onSelect: () => this.cycleWallpaper(),
      },
      { kind: "sep" },
      {
        kind: "action",
        label: "打开控制中心",
        kbd: `${modPrefix}P`,
        onSelect: () => {
          this.blurInputs();
          this.#onOpenModal();
        },
      },
      {
        kind: "action",
        label: "返回全屏终端",
        kbd: `${modPrefix}D`,
        onSelect: () => this.setDesktopMode(false),
      },
    );
    return items;
  }

  #buildTerminalWindowContextMenuItems(): ContextMenuItem[] {
    const modPrefix = this.#isMac ? "⌘⇧" : "Ctrl+⇧+";
    const active = this.#vmManager.activeSession;
    const atLimit = this.#vmManager.sessions.length >= MAX_TERMINAL_SESSIONS;
    const items: ContextMenuItem[] = [
      { kind: "heading", label: active ? active.title : "Neovim / 终端" },
      {
        kind: "action",
        label: this.#terminalMinimized ? "还原窗口" : "最小化窗口",
        onSelect: () => this.#toggleTerminalMinimize(),
      },
      {
        kind: "action",
        label: this.#terminalMaximized ? "还原大小" : "最大化窗口",
        onSelect: () => this.#toggleTerminalMaximize(),
      },
      {
        kind: "action",
        label: "居中窗口",
        onSelect: () => this.#centerTerminalWindow(),
      },
    ];
    if (this.#onOpenSession) {
      const openSession = this.#onOpenSession;
      items.push(
        { kind: "sep" },
        {
          kind: "action",
          label: "新建 Neovim 会话",
          disabled: atLimit,
          onSelect: () => {
            this.#raiseTerminalWindow(true);
            void openSession("nvim").catch((err) => {
              this.#toast(err instanceof Error ? err.message : String(err));
            });
          },
        },
        {
          kind: "action",
          label: "新建 Shell 会话",
          disabled: atLimit,
          onSelect: () => {
            this.#raiseTerminalWindow(true);
            void openSession("shell").catch((err) => {
              this.#toast(err instanceof Error ? err.message : String(err));
            });
          },
        },
      );
    }
    items.push(
      { kind: "sep" },
      {
        kind: "action",
        label: "切换至全屏终端",
        kbd: `${modPrefix}D`,
        onSelect: () => this.setDesktopMode(false),
      },
    );
    return items;
  }

  #buildWaylandWindowContextMenuItems(managed: ManagedWaylandWindow): ContextMenuItem[] {
    const title = managed.win.title || managed.win.appId || "Wayland 应用";
    return [
      { kind: "heading", label: title },
      {
        kind: "action",
        label: managed.minimized ? "还原窗口" : "最小化窗口",
        onSelect: () => {
          if (managed.minimized) {
            this.bridge.wland?.wm.restore(managed.conn, managed.surface);
            this.#focusWaylandWindow(managed);
          } else {
            this.bridge.wland?.wm.minimize(managed.conn, managed.surface);
          }
        },
      },
      {
        kind: "action",
        label: managed.maximized ? "还原大小" : "最大化窗口",
        onSelect: () => {
          this.bridge.wland?.wm.setMaximized(managed.conn, managed.surface, !managed.maximized);
        },
      },
      {
        kind: "action",
        label: "居中窗口",
        disabled: managed.fullscreen,
        onSelect: () => this.#centerWaylandWindow(managed),
      },
      { kind: "sep" },
      {
        kind: "action",
        label: "关闭应用",
        danger: true,
        onSelect: () => {
          this.bridge.wland?.engine.close(managed.conn, managed.surface);
        },
      },
    ];
  }

  #buildPreviewWindowContextMenuItems(managed: ManagedPreviewWindow): ContextMenuItem[] {
    return [
      { kind: "heading", label: managed.pane.title },
      {
        kind: "action",
        label: managed.minimized ? "还原窗口" : "最小化窗口",
        onSelect: () => {
          if (managed.minimized) {
            this.#focusPreviewWindow(managed);
          } else {
            managed.minimized = true;
            this.#applyPreviewWindowPosition(managed);
            this.#syncAuxWindowFocus();
            this.renderStatus();
          }
        },
      },
      {
        kind: "action",
        label: managed.maximized ? "还原大小" : "最大化窗口",
        onSelect: () => this.#togglePreviewMaximize(managed),
      },
      {
        kind: "action",
        label: "居中窗口",
        onSelect: () => this.#centerPreviewWindow(managed),
      },
      {
        kind: "action",
        label: "新建预览窗口",
        onSelect: () => this.openPreview({ forceNew: true }),
      },
      { kind: "sep" },
      {
        kind: "action",
        label: "关闭窗口",
        danger: true,
        onSelect: () => this.#closePreviewWindow(managed),
      },
    ];
  }

  #buildDisplayContextMenuItems(): ContextMenuItem[] {
    return [
      { kind: "heading", label: this.#displayWindow.title },
      {
        kind: "action",
        label: this.#displayWindow.isMinimized ? "还原窗口" : "最小化窗口",
        onSelect: () => {
          if (this.#displayWindow.isMinimized) {
            this.#displayWindow.restore(++this.#nextZ);
          } else {
            this.#displayWindow.minimize();
          }
        },
      },
      {
        kind: "action",
        label: this.#displayWindow.isMaximized ? "还原大小" : "最大化窗口",
        onSelect: () => this.#displayWindow.toggleMaximize(++this.#nextZ),
      },
      {
        kind: "action",
        label: "居中窗口",
        onSelect: () => {
          this.#focusDisplayWindow();
          this.#displayWindow.centerInBounds();
        },
      },
      { kind: "sep" },
      {
        kind: "action",
        label: "隐藏显示器窗口",
        danger: true,
        onSelect: () => this.#displayWindow.close(),
      },
    ];
  }

  #centerTerminalWindow(): void {
    this.#terminalMinimized = false;
    this.#terminalMaximized = false;
    this.#terminalRestoreRect = null;
    const bounds = this.#getBounds();
    const cur = this.#terminalRect ?? {
      x: 0,
      y: 0,
      width: Math.max(420, Math.min(1040, Math.round(bounds.width * 0.78))),
      height: Math.max(300, Math.min(720, Math.round((bounds.height - DOCK_CLEARANCE) * 0.84))),
    };
    const clamped = clampWindowRect(cur, bounds);
    this.#terminalRect = clampWindowRect(
      {
        x: Math.round((bounds.width - clamped.width) / 2),
        y: Math.round((bounds.height - DOCK_CLEARANCE - clamped.height) / 2),
        width: clamped.width,
        height: clamped.height,
      },
      bounds,
    );
    this.#raiseTerminalWindow(true);
    this.#scheduleTerminalFit();
  }

  #centerWaylandWindow(managed: ManagedWaylandWindow): void {
    if (managed.fullscreen) return;
    if (managed.minimized) {
      this.bridge.wland?.wm.restore(managed.conn, managed.surface);
    }
    if (managed.maximized) {
      this.bridge.wland?.wm.setMaximized(managed.conn, managed.surface, false);
    }
    const bounds = this.#getBounds();
    const size = this.#currentWaylandContentSize(managed);
    const clamped = clampWindowRect(
      {
        x: Math.round((bounds.width - size.width) / 2),
        y: Math.round((bounds.height - DOCK_CLEARANCE - size.height) / 2),
        width: size.width,
        height: size.height,
      },
      bounds,
      120,
      80,
    );
    managed.rect.x = clamped.x;
    managed.rect.y = clamped.y;
    this.#focusWaylandWindow(managed);
  }

  #centerPreviewWindow(managed: ManagedPreviewWindow): void {
    managed.minimized = false;
    managed.maximized = false;
    managed.restoreRect = null;
    const bounds = this.#getBounds();
    const clamped = clampWindowRect(managed.rect, bounds, 360, 260);
    managed.rect = clampWindowRect(
      {
        x: Math.round((bounds.width - clamped.width) / 2),
        y: Math.round((bounds.height - DOCK_CLEARANCE - clamped.height) / 2),
        width: clamped.width,
        height: clamped.height,
      },
      bounds,
      360,
      260,
    );
    this.#focusPreviewWindow(managed);
  }

  #areAllWindowsMinimized(): boolean {
    if (!this.#terminalMinimized) return false;
    if (this.#displayWindow.isOpen && !this.#displayWindow.isMinimized) return false;
    for (const preview of this.#previewWindows.values()) {
      if (!preview.minimized) return false;
    }
    for (const win of this.#waylandWindows.values()) {
      if (!win.minimized) return false;
    }
    return true;
  }

  #toggleShowDesktop(): void {
    if (this.#areAllWindowsMinimized()) {
      if (this.#displayWindow.isOpen) {
        this.#displayWindow.restore(++this.#nextZ);
      }
      for (const preview of this.#previewWindows.values()) {
        preview.minimized = false;
        preview.zIndex = ++this.#nextZ;
        this.#applyPreviewWindowPosition(preview);
      }
      for (const win of this.#waylandWindows.values()) {
        if (win.minimized) {
          this.bridge.wland?.wm.restore(win.conn, win.surface);
        }
        win.zIndex = ++this.#nextZ;
        this.#applyWaylandWindowPosition(win);
      }
      this.#raiseTerminalWindow(true);
      this.#scheduleTerminalFit();
      return;
    }

    this.#terminalMinimized = true;
    this.#applyTerminalWindowGeometry();
    if (this.#displayWindow.isOpen) {
      this.#displayWindow.minimize();
    }
    for (const preview of this.#previewWindows.values()) {
      preview.minimized = true;
      this.#applyPreviewWindowPosition(preview);
    }
    for (const win of this.#waylandWindows.values()) {
      if (!win.minimized) {
        this.bridge.wland?.wm.minimize(win.conn, win.surface);
      }
    }
    this.blurInputs();
    this.#syncAuxWindowFocus();
    this.renderStatus();
  }

  #cascadeAllWindows(): void {
    const bounds = this.#getBounds();
    let idx = 0;

    const termW = Math.max(420, Math.min(920, Math.round(bounds.width * 0.72)));
    const termH = Math.max(300, Math.min(640, Math.round((bounds.height - DOCK_CLEARANCE) * 0.78)));
    this.#terminalMinimized = false;
    this.#terminalMaximized = false;
    this.#terminalRestoreRect = null;
    this.#terminalRect = computeCascadeRect(idx++, bounds, termW, termH);
    this.#terminalZ = ++this.#nextZ;
    this.#applyTerminalWindowGeometry();

    if (this.#displayWindow.isOpen) {
      const rect = computeCascadeRect(idx++, bounds, 820, 520);
      this.#displayWindow.setWindowRect(rect);
      this.#displayWindow.raise(++this.#nextZ);
    }

    for (const preview of this.#previewWindows.values()) {
      preview.minimized = false;
      preview.maximized = false;
      preview.restoreRect = null;
      preview.rect = computeCascadeRect(idx++, bounds, 760, 540);
      preview.zIndex = ++this.#nextZ;
      this.#applyPreviewWindowPosition(preview);
    }

    for (const win of this.#waylandWindows.values()) {
      if (win.fullscreen) continue;
      if (win.minimized) {
        this.bridge.wland?.wm.restore(win.conn, win.surface);
      }
      if (win.maximized) {
        this.bridge.wland?.wm.setMaximized(win.conn, win.surface, false);
      }
      const size = this.#currentWaylandContentSize(win);
      const cascaded = computeCascadeRect(idx++, bounds, size.width, size.height);
      win.rect.x = cascaded.x;
      win.rect.y = cascaded.y;
      win.zIndex = ++this.#nextZ;
      this.#applyWaylandWindowPosition(win);
    }

    this.#raiseTerminalWindow(true);
    this.#scheduleTerminalFit();
    this.renderStatus();
  }

  #renderContextMenuItems(items: ContextMenuItem[]): void {
    this.#contextMenuEl.replaceChildren();
    for (const item of items) {
      if (item.kind === "sep") {
        const sep = document.createElement("div");
        sep.className = "dock-menu-sep";
        sep.setAttribute("role", "separator");
        this.#contextMenuEl.appendChild(sep);
        continue;
      }
      if (item.kind === "heading") {
        const heading = document.createElement("div");
        heading.className = "dock-menu-heading";
        heading.textContent = item.label;
        this.#contextMenuEl.appendChild(heading);
        continue;
      }

      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.role = "menuitem";
      menuBtn.className = `dock-menu-item${item.danger ? " danger" : ""}`;
      menuBtn.disabled = Boolean(item.disabled);

      if (item.checked) {
        const checkEl = document.createElement("span");
        checkEl.className = "context-menu-check";
        checkEl.setAttribute("aria-hidden", "true");
        checkEl.textContent = "✓";
        menuBtn.appendChild(checkEl);
      }

      const labelSpan = document.createElement("span");
      labelSpan.className = "dock-menu-item-label";
      labelSpan.textContent = item.label;
      menuBtn.appendChild(labelSpan);

      if (item.kbd) {
        const kbdEl = document.createElement("kbd");
        kbdEl.className = "dock-menu-kbd";
        kbdEl.textContent = item.kbd;
        menuBtn.appendChild(kbdEl);
      }

      menuBtn.addEventListener("click", () => {
        this.closeContextMenu();
        item.onSelect();
      });
      this.#contextMenuEl.appendChild(menuBtn);
    }
  }

  #openMenuAnchored(anchorBtn: HTMLButtonElement, items: ContextMenuItem[]): void {
    this.#renderContextMenuItems(items);
    this.#contextMenuOpen = true;
    this.#contextMenuEl.hidden = false;

    const btnRect = anchorBtn.getBoundingClientRect();
    const dockRect = this.#dockEl.getBoundingClientRect();
    const menuRect = this.#contextMenuEl.getBoundingClientRect();
    const pad = 12;
    const left = Math.max(
      pad,
      Math.min(
        Math.round(btnRect.left + btnRect.width / 2 - menuRect.width / 2),
        window.innerWidth - menuRect.width - pad,
      ),
    );
    const top = Math.max(36, Math.round(dockRect.top - menuRect.height - 10));
    this.#contextMenuEl.style.left = `${left}px`;
    this.#contextMenuEl.style.top = `${top}px`;
  }

  #openMenuAt(clientX: number, clientY: number, items: ContextMenuItem[]): void {
    if (items.length === 0) return;
    this.#renderContextMenuItems(items);
    this.#contextMenuOpen = true;
    this.#contextMenuEl.hidden = false;

    const menuRect = this.#contextMenuEl.getBoundingClientRect();
    const pos = computeContextMenuPosition(
      clientX,
      clientY,
      menuRect.width,
      menuRect.height,
      window.innerWidth,
      window.innerHeight,
    );
    this.#contextMenuEl.style.left = `${pos.left}px`;
    this.#contextMenuEl.style.top = `${pos.top}px`;
  }

  #initWallpaperPicker(): void {
    this.#wallpaperBackdropEl.addEventListener("mousedown", (e) => {
      if (e.target === this.#wallpaperBackdropEl) {
        this.closeWallpaperPicker();
      }
    });

    document.getElementById("btn-close-wallpaper")!.addEventListener("click", () => {
      this.closeWallpaperPicker();
    });

    this.#wallpaperUploadBtn.addEventListener("click", () => {
      this.#wallpaperFileInput.click();
    });

    this.#wallpaperFileInput.addEventListener("change", () => {
      const file = this.#wallpaperFileInput.files?.[0];
      this.#wallpaperFileInput.value = "";
      if (!file) return;
      void this.#handleWallpaperUpload(file);
    });

    this.#wallpaperUseCustomBtn.addEventListener("click", () => {
      if (!this.#customWallpaperUrl) return;
      const nextDim =
        this.#wallpaperConfig.source.kind === "preset" && this.#wallpaperConfig.dim === 0
          ? 0.2
          : this.#wallpaperConfig.dim;
      this.#updateWallpaperConfig({
        ...this.#wallpaperConfig,
        source: this.#customWallpaperName
          ? { kind: "custom", name: this.#customWallpaperName }
          : { kind: "custom" },
        dim: nextDim,
      });
    });

    this.#wallpaperClearCustomBtn.addEventListener("click", () => {
      void this.#clearCustomWallpaper();
    });

    this.#wallpaperUrlFormEl.addEventListener("submit", (e) => {
      e.preventDefault();
      const parsed = parseWallpaperUrl(this.#wallpaperUrlInputEl.value);
      if (!parsed) {
        this.#toast("请输入有效的 http(s) 图片地址或图片 Base64 数据链接");
        this.#wallpaperUrlInputEl.focus();
        return;
      }
      const nextDim =
        this.#wallpaperConfig.source.kind === "preset" && this.#wallpaperConfig.dim === 0
          ? 0.2
          : this.#wallpaperConfig.dim;
      this.#updateWallpaperConfig({
        ...this.#wallpaperConfig,
        source: { kind: "url", url: parsed },
        dim: nextDim,
      });
      this.#toast("已应用网络壁纸");
    });

    this.#wallpaperFitGroupEl.replaceChildren();
    for (const opt of WALLPAPER_FIT_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mini-btn";
      btn.dataset.wallpaperFit = opt.value;
      btn.textContent = opt.label;
      btn.addEventListener("click", () => {
        this.#updateWallpaperConfig({
          ...this.#wallpaperConfig,
          fit: opt.value,
        });
      });
      this.#wallpaperFitGroupEl.appendChild(btn);
    }

    this.#wallpaperDimInputEl.addEventListener("input", () => {
      const pct = Number(this.#wallpaperDimInputEl.value);
      if (!Number.isFinite(pct)) return;
      const dim = Math.max(0, Math.min(0.75, Math.round(pct) / 100));
      this.#updateWallpaperConfig({ ...this.#wallpaperConfig, dim });
    });

    this.#wallpaperBlurInputEl.addEventListener("input", () => {
      const blur = Number(this.#wallpaperBlurInputEl.value);
      if (!Number.isFinite(blur)) return;
      this.#updateWallpaperConfig({
        ...this.#wallpaperConfig,
        blur: Math.max(0, Math.min(24, Math.round(blur))),
      });
    });

    this.#wallpaperResetBtn.addEventListener("click", () => {
      this.#updateWallpaperConfig({ ...DEFAULT_WALLPAPER_CONFIG });
      this.#toast("已恢复默认壁纸");
    });
  }

  async #hydrateCustomWallpaper(): Promise<void> {
    const blob = await loadCustomWallpaperBlob();
    if (!blob) {
      if (this.#wallpaperConfig.source.kind === "custom") {
        this.#updateWallpaperConfig({
          ...this.#wallpaperConfig,
          source: { ...DEFAULT_WALLPAPER_CONFIG.source },
        });
      }
      return;
    }

    this.#setCustomWallpaperUrl(URL.createObjectURL(blob));
    this.#applyWallpaper();
    if (this.#wallpaperOpen) {
      this.#renderWallpaperPicker();
    }
  }

  #setCustomWallpaperUrl(nextUrl: string | null): void {
    if (this.#customWallpaperUrl && this.#customWallpaperUrl !== nextUrl) {
      URL.revokeObjectURL(this.#customWallpaperUrl);
    }
    this.#customWallpaperUrl = nextUrl;
  }

  async #handleWallpaperUpload(file: File): Promise<void> {
    const check = validateWallpaperFile(file);
    if (!check.ok) {
      this.#toast(check.error, 4000);
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    this.#setCustomWallpaperUrl(nextUrl);
    this.#customWallpaperName = file.name;

    const saved = await saveCustomWallpaperBlob(file);
    const nextDim =
      this.#wallpaperConfig.source.kind === "preset" && this.#wallpaperConfig.dim === 0
        ? 0.2
        : this.#wallpaperConfig.dim;
    this.#updateWallpaperConfig({
      ...this.#wallpaperConfig,
      source: { kind: "custom", name: file.name },
      dim: nextDim,
    });

    if (saved) {
      this.#toast(`已设置本地壁纸：${file.name}`);
    } else {
      this.#toast(`已设置壁纸：${file.name}（浏览器未保存 IndexedDB，刷新后将恢复默认）`, 4500);
    }
  }

  async #clearCustomWallpaper(): Promise<void> {
    await deleteCustomWallpaperBlob();
    this.#setCustomWallpaperUrl(null);
    this.#customWallpaperName = undefined;
    if (this.#wallpaperConfig.source.kind === "custom") {
      this.#updateWallpaperConfig({
        ...this.#wallpaperConfig,
        source: { ...DEFAULT_WALLPAPER_CONFIG.source },
      });
    } else {
      this.#applyWallpaper();
      if (this.#wallpaperOpen) {
        this.#renderWallpaperPicker();
      }
    }
    this.#toast("已清除本地壁纸图片");
  }

  #updateWallpaperConfig(next: WallpaperConfig): void {
    this.#wallpaperConfig = next;
    if (next.source.kind === "custom" && next.source.name) {
      this.#customWallpaperName = next.source.name;
    }
    try {
      localStorage.setItem(WALLPAPER_STORAGE_KEY, serializeWallpaperConfig(next));
    } catch {
      // Ignore storage quota errors for metadata
    }
    this.#applyWallpaper();
    if (this.#wallpaperOpen) {
      this.#renderWallpaperPicker();
    }
    this.#onStateChange?.();
  }

  #applyWallpaper(): void {
    const styles = resolveWallpaperStyles(this.#wallpaperConfig, this.#customWallpaperUrl);
    this.#wallpaperEl.style.backgroundColor = styles.backgroundColor;
    this.#wallpaperEl.style.backgroundImage = styles.backgroundImage;
    this.#wallpaperEl.style.backgroundSize = styles.backgroundSize;
    this.#wallpaperEl.style.backgroundRepeat = styles.backgroundRepeat;
    this.#wallpaperEl.style.backgroundPosition = styles.backgroundPosition;
    this.#wallpaperEl.style.setProperty("--wallpaper-blur", `${styles.blurPx}px`);
    this.#wallpaperScrimEl.style.setProperty("--wallpaper-dim", String(styles.dimOpacity));
  }

  #renderWallpaperPicker(): void {
    const cfg = this.#wallpaperConfig;
    this.#wallpaperNoteEl.textContent = `当前壁纸：${formatWallpaperSummary(cfg)}`;

    this.#wallpaperGridEl.replaceChildren();
    for (const preset of WALLPAPER_PRESETS) {
      const isSelected = cfg.source.kind === "preset" && cfg.source.presetId === preset.id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = `wallpaper-swatch${isSelected ? " active" : ""}`;
      card.setAttribute("aria-pressed", String(isSelected));
      card.title = preset.description;

      const preview = document.createElement("div");
      preview.className = "wallpaper-swatch-preview";
      preview.style.backgroundColor = preset.backgroundColor;
      preview.style.backgroundImage = preset.backgroundImage;
      preview.style.backgroundSize = preset.backgroundSize ?? "cover";
      preview.style.backgroundRepeat = preset.backgroundRepeat ?? "no-repeat";
      preview.style.backgroundPosition = preset.backgroundPosition ?? "center";

      const label = document.createElement("span");
      label.className = "wallpaper-swatch-label";
      label.textContent = preset.name;

      card.append(preview, label);
      card.addEventListener("click", () => {
        this.#updateWallpaperConfig({
          ...this.#wallpaperConfig,
          source: { kind: "preset", presetId: preset.id },
        });
      });
      this.#wallpaperGridEl.appendChild(card);
    }

    const hasCustomBlob = Boolean(this.#customWallpaperUrl);
    this.#wallpaperUseCustomBtn.hidden = !hasCustomBlob || cfg.source.kind === "custom";
    if (this.#customWallpaperName) {
      this.#wallpaperUseCustomBtn.textContent = `使用本地图片 (${this.#customWallpaperName})`;
    } else {
      this.#wallpaperUseCustomBtn.textContent = "使用已保存图片";
    }
    this.#wallpaperClearCustomBtn.hidden = !hasCustomBlob;

    if (document.activeElement !== this.#wallpaperUrlInputEl) {
      this.#wallpaperUrlInputEl.value = cfg.source.kind === "url" ? cfg.source.url : "";
    }

    for (const btn of this.#wallpaperFitGroupEl.querySelectorAll<HTMLButtonElement>("[data-wallpaper-fit]")) {
      const fit = btn.dataset.wallpaperFit as WallpaperFit;
      btn.setAttribute("aria-pressed", String(cfg.fit === fit));
    }

    const dimPct = Math.round(cfg.dim * 100);
    this.#wallpaperDimInputEl.value = String(dimPct);
    this.#wallpaperDimValEl.textContent = `${dimPct}%`;

    this.#wallpaperBlurInputEl.value = String(cfg.blur);
    this.#wallpaperBlurValEl.textContent = `${cfg.blur}px`;
  }

  #startPointerDrag(
    pointerId: number,
    onMove: (ev: PointerEvent) => void,
    onDone?: () => void,
  ): void {
    document.body.classList.add("window-dragging");
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      onMove(ev);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      onDone?.();
    };
    const cleanup = () => {
      document.body.classList.remove("window-dragging");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", cleanup);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", cleanup, { once: true });
  }
}
