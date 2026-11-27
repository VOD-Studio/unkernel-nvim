// SPDX-License-Identifier: MIT
// Application entry point: wires the fullscreen WebGL2 Canvas terminal,
// WorkerKernel VM manager, boot progress overlay, and modal control center.

import { DesktopShell } from "./desktop-shell.ts";
import { type DiskMode } from "./disk-config.ts";
import { DISTROS } from "./distro.ts";
import { pickHostDirectory } from "./fs-bridge.ts";
import { foregroundShellDirectory } from "./guest-file-transfer.ts";
import { GuestPreview } from "./guest-preview.ts";
import {
  createBrowserFilePicker,
  createHostCommands,
  shellQuoteArg,
  triggerBrowserDownload,
} from "./host-commands.ts";
import { ModalController } from "./modal.ts";
import { ResumeSessionError } from "./suspended-session.ts";
import { CanvasTerminal, SHELL_SCROLLBACK_LINES } from "./terminal.ts";
import {
  cycleSessionId,
  MAX_TERMINAL_SESSIONS,
  shouldReturnToShell,
  type SessionMode,
} from "./terminal-sessions.ts";
import { DiskLockError, VmManager, type BootStatusUpdate, type TerminalSession } from "./vm-manager.ts";

const stageEl = document.getElementById("terminal-stage")!;
const bootOverlayEl = document.getElementById("boot-overlay")!;
const bootTitleEl = document.getElementById("boot-title")!;
const bootDetailEl = document.getElementById("boot-detail")!;
const bootBarFillEl = document.getElementById("boot-bar-fill")!;
const bootBadgeEl = document.getElementById("boot-mode-badge")!;
const bootActionsEl = document.getElementById("boot-actions")!;
const snapshotBootButton = document.querySelector<HTMLButtonElement>("#btn-boot-snapshot")!;
const resumeButton = document.querySelector<HTMLButtonElement>("#btn-resume-session")!;
const discardButton = document.querySelector<HTMLButtonElement>("#btn-discard-session")!;
const sessionTabsEl = document.getElementById("session-tabs")!;
const pillBtn = document.getElementById("menu-pill") as HTMLButtonElement;
const pillLabelEl = document.getElementById("pill-label")!;
const pillKbdEl = document.getElementById("pill-kbd")!;
const modalBackdropEl = document.getElementById("modal-backdrop")!;
const modalDialogEl = document.getElementById("modal-dialog")!;
const modalFeedbackEl = document.getElementById("modal-feedback")!;
const toastContainerEl = document.getElementById("toast-container")!;

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
pillKbdEl.textContent = isMac ? "⌘⇧P" : "Ctrl+⇧+P";

let modalFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(message: string, durationMs = 3200): void {
  if (modal?.isOpen) {
    clearTimeout(modalFeedbackTimer);
    modalFeedbackEl.textContent = message;
    modalFeedbackTimer = setTimeout(() => {
      modalFeedbackEl.textContent = "";
    }, durationMs);
    return;
  }

  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  toastContainerEl.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, durationMs);
}

function hideBootOverlay(): void {
  if (bootOverlayEl.classList.contains("fade-out")) return;
  bootOverlayEl.classList.add("fade-out");
  if (!modal?.isOpen && !desktopShell?.isOverlayOpen) {
    if (desktopShell) desktopShell.restoreFocus();
    else terminal.focus();
  }
}

function updateBootOverlay(s: BootStatusUpdate): void {
  bootTitleEl.textContent = s.title;
  if (s.detail !== undefined) {
    bootDetailEl.textContent = s.detail;
  }
  if (s.progress !== undefined) {
    bootBarFillEl.classList.remove("indeterminate");
    bootBarFillEl.style.width = `${Math.max(5, Math.round(s.progress * 100))}%`;
  } else {
    bootBarFillEl.classList.add("indeterminate");
  }
  if (s.phase === "suspended") {
    modal?.close();
    desktopShell?.closeLauncher();
    desktopShell?.closeWallpaperPicker();
    desktopShell?.detachVm();
    preview.close();
    terminal.unmountAll();
    renderSessionHud();
    bootOverlayEl.classList.remove("fade-out");
    bootBarFillEl.classList.remove("indeterminate");
    bootBarFillEl.style.width = "100%";
    bootActionsEl.hidden = false;
    resumeButton.focus();
  } else if (s.phase === "ready") {
    // Fallback hide in case first output arrived during transition
    setTimeout(hideBootOverlay, 120);
  }
}

let modal: ModalController | null = null;
let desktopShell: DesktopShell | null = null;
let togglingQuickSession = false;

function renderSessionHud(): void {
  const active = vmManager.activeSession;
  const snapshotSuffix = vmManager.isSnapshotMode ? " · 快照" : "";
  if (!active) {
    pillLabelEl.textContent = `空闲${snapshotSuffix}`;
  } else {
    pillLabelEl.textContent = active.exited ? `${active.title} (exited)${snapshotSuffix}` : `${active.title}${snapshotSuffix}`;
  }

  sessionTabsEl.replaceChildren();
  const sessions = vmManager.sessions;
  if (sessions.length === 0) return;

  for (const session of sessions) {
    const isActive = session.id === vmManager.activeSessionId;
    const tab = document.createElement("div");
    tab.className = `session-tab${isActive ? " active" : ""}${session.exited ? " exited" : ""}`;

    const btn = document.createElement("button");
    btn.className = "session-tab-btn";
    btn.type = "button";
    btn.role = "tab";
    btn.setAttribute("aria-selected", String(isActive));
    btn.title = `${session.title} · ${session.cwd}`;
    btn.textContent = session.exited ? `${session.title} (已结束)` : session.title;
    btn.addEventListener("click", () => switchToSession(session.id));

    const closeBtn = document.createElement("button");
    closeBtn.className = "session-tab-close";
    closeBtn.type = "button";
    closeBtn.title = `关闭 ${session.title}`;
    closeBtn.setAttribute("aria-label", `关闭 ${session.title}`);
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeSessionTab(session.id);
    });

    tab.append(btn, closeBtn);
    sessionTabsEl.appendChild(tab);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "session-tab-add";
  addBtn.type = "button";
  addBtn.title = "新建 Shell 标签";
  addBtn.setAttribute("aria-label", "新建 Shell 标签");
  addBtn.textContent = "+";
  addBtn.disabled = sessions.length >= MAX_TERMINAL_SESSIONS;
  addBtn.addEventListener("click", () => {
    void openNewSession("shell").catch((err) => {
      showToast(err instanceof Error ? err.message : String(err));
    });
  });
  sessionTabsEl.appendChild(addBtn);
}

function mountSession(session: TerminalSession, activate: boolean): void {
  if (!session.pty) return;
  terminal.mountSession(
    session.id,
    session.pty,
    session.mode === "shell" ? SHELL_SCROLLBACK_LINES : 0,
    { activate },
  );
}

function switchToSession(id: string): void {
  const session = vmManager.switchSession(id);
  if (!session) return;
  terminal.activateSession(session.id, !modal?.isOpen && !desktopShell?.isOverlayOpen);
  renderSessionHud();
  desktopShell?.renderStatus();
  if (modal?.isOpen) modal.render();
}

async function openNewSession(
  mode: SessionMode,
  opts?: { cwd?: string; replaceActive?: boolean; startup?: boolean; shellCommand?: string },
): Promise<void> {
  const replaceSessionId = opts?.replaceActive ? (vmManager.activeSessionId ?? undefined) : undefined;
  const session = await vmManager.openSession(mode, terminal.getSize(), opts?.cwd, {
    replaceSessionId,
    startup: opts?.startup,
  });
  const active = vmManager.activeSession === session;
  mountSession(session, active);
  renderSessionHud();
  desktopShell?.renderStatus();
  if (active && !modal?.isOpen && !desktopShell?.isOverlayOpen) terminal.focus();
  if (opts?.shellCommand) {
    if (!session.pty) throw new Error("安装用的 Shell 会话已结束");
    await session.pty.write(`${opts.shellCommand}\n`);
  }
}

async function closeSessionTab(id: string): Promise<void> {
  const res = await vmManager.closeSession(id);
  if (!res) return;
  terminal.unmountSession(id);
  if (res.nextActive) {
    terminal.activateSession(res.nextActive.id, !modal?.isOpen && !desktopShell?.isOverlayOpen);
  }
  renderSessionHud();
  desktopShell?.renderStatus();
  if (modal?.isOpen) modal.render();
}

const terminal = new CanvasTerminal({
  container: stageEl,
  onToggleMenu: () => modal?.toggle(),
  onCycleSession: (delta) => {
    const nextId = cycleSessionId(vmManager.sessions, vmManager.activeSessionId, delta);
    if (nextId && nextId !== vmManager.activeSessionId) {
      switchToSession(nextId);
    }
  },
  onQuickToggleSession: () => {
    if (togglingQuickSession || !vmManager.vm) return;
    const targetMode: SessionMode = vmManager.currentMode === "nvim" ? "shell" : "nvim";
    const existing = vmManager.sessions.find((s) => s.mode === targetMode && !s.exited);
    if (existing) {
      switchToSession(existing.id);
      return;
    }
    togglingQuickSession = true;
    void openNewSession(targetMode)
      .catch((err) => {
        showToast(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        togglingQuickSession = false;
      });
  },
  onFirstOutput: () => {
    hideBootOverlay();
  },
  onDropFiles: async (files) => {
    const vm = vmManager.vm;
    const session = vmManager.activeSession;
    if (!vm || !session?.pty || session.exited) {
      showToast("虚拟机尚未就绪");
      return;
    }
    try {
      const shellDir = session.mode === "shell" ? await foregroundShellDirectory(vm, session.pty.pid) : null;
      const targetDir = shellDir ?? session.cwd;
      if (vmManager.vm !== vm) return;
      const paths = await vmManager.writeGuestFiles(files, targetDir);
      showToast(
        paths.length === 1
          ? `已导入 ${paths[0]}`
          : `已导入 ${paths.length} 个文件到 ${targetDir}`,
      );
      if (vmManager.activeSession !== session || session.exited || modal?.isOpen) return;
      if (session.mode === "shell" && !shellDir) terminal.paste(`${paths.map(shellQuoteArg).join(" ")} `);
      terminal.focus();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 5000);
    }
  },
});

const vmManager = new VmManager({
  onStatus: updateBootOverlay,
  onNotice: showToast,
  onDisplayChange: (mode) => desktopShell?.handleDisplayMode(mode),
  onInputChange: (state) => desktopShell?.handleInputState(state),
  onAudioStateChange: (state) => desktopShell?.handleAudioStateChange(state),
  onSessionsChange: () => {
    renderSessionHud();
    desktopShell?.renderStatus();
    if (modal?.isOpen) modal.render();
  },
  onSessionExit: async (session, end) => {
    let message = session.mode === "nvim" ? `${session.title} 已退出` : `${session.title} 会话已结束`;
    if (shouldReturnToShell(session, end)) {
      try {
        const shell = await vmManager.openSession("shell", terminal.getSize(), session.cwd, {
          replaceSessionId: session.id,
        });
        mountSession(shell, vmManager.activeSession === shell);
        return;
      } catch (err) {
        if (!vmManager.sessions.includes(session)) return;
        message = `启动 Shell 失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    showToast(message);
    if (vmManager.activeSession === session && vmManager.sessions.length === 1) {
      modal?.open("workspace");
    }
  },
});

const preview = new GuestPreview(() => vmManager.vm, () => desktopShell?.restoreFocus() ?? terminal.focus());

desktopShell = new DesktopShell({
  vmManager,
  terminal,
  isModalOpen: () => Boolean(modal?.isOpen),
  onOpenModal: () => modal?.open(),
  onOpenSession: (mode) => openNewSession(mode),
  onOpenInstallInShell: (shellCommand) => openNewSession("shell", { cwd: "/workspace", shellCommand }),
  onDesktopModeChange: (enabled) => {
    if (enabled && preview.isOpen) {
      const port = preview.currentPort;
      const path = preview.currentPath;
      preview.close();
      desktopShell?.openPreview(port !== null ? { port, path } : undefined);
    }
  },
  onStateChange: () => {
    if (modal?.isOpen) modal.render();
  },
  toast: showToast,
});

const updateVisibility = () => vmManager.updatePageVisibility();
document.addEventListener("visibilitychange", updateVisibility);
window.addEventListener("pagehide", () => vmManager.updatePageVisibility(true));
window.addEventListener("pageshow", updateVisibility);

vmManager.setCommands(
  createHostCommands({
    readClipboard: async () => {
      if (!navigator.clipboard?.readText) {
        throw new Error("当前浏览器环境不支持读取剪贴板");
      }
      return navigator.clipboard.readText();
    },
    writeClipboard: async (text) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error("当前浏览器环境不支持写入剪贴板");
      }
      await navigator.clipboard.writeText(text);
    },
    openPreview: () => {
      if (desktopShell?.isDesktopMode) desktopShell.openPreview();
      else preview.open();
    },
    closePreview: () => {
      preview.close();
      desktopShell?.closeAllPreviews();
    },
    navigatePreview: (port, path) => {
      if (desktopShell?.isDesktopMode) desktopShell.openPreview({ port, path });
      else preview.openAt(port, path);
    },
    openUrl: (url) => Boolean(window.open(url, "_blank", "noopener,noreferrer")),
    readGuestFile: (guestPath, signal) => vmManager.readGuestFile(guestPath, signal),
    readDownload: (guestPath, signal) => vmManager.readDownload(guestPath, signal),
    writeGuestFile: (guestPath, bytes, signal) => vmManager.writeGuestFile(guestPath, bytes, signal),
    writeGuestFiles: (files, targetDir, signal) => vmManager.writeGuestFiles(files, targetDir, signal),
    triggerDownload: triggerBrowserDownload,
    pickUploadFiles: createBrowserFilePicker,
    mountDirectory: async () => {
      const dirFs = await pickHostDirectory();
      const entry = await vmManager.mountHostDirectory(dirFs);
      if (modal?.isOpen) modal.render();
      showToast(`已挂载本地目录至 ${entry.guestPath}`);
      return entry.guestPath;
    },
    listMounts: () => [...vmManager.mountedFolders.keys()],
    setDesktopMode: (enabled) => desktopShell?.setDesktopMode(enabled),
    toggleDesktopMode: () => desktopShell?.toggleDesktopMode(),
    openLauncher: () => desktopShell?.openLauncher(),
    getDesktopStatus: () => {
      const st = desktopShell?.getBridgeStatus();
      return {
        desktopMode: desktopShell?.isDesktopMode ?? false,
        waylandState: st?.state ?? "idle",
        windowCount: st?.windowCount ?? 0,
      };
    },
    notify: showToast,
  }),
);

snapshotBootButton.addEventListener("click", () => {
  snapshotBootButton.disabled = true;
  void bootApp("snapshot");
});
resumeButton.addEventListener("click", () => location.reload());
discardButton.addEventListener("click", async () => {
  if (!confirm("确定放弃挂起的会话并启动新会话吗？已落盘的文件会保留。")) return;
  discardButton.disabled = true;
  try {
    await vmManager.discardSuspendedSession();
  } catch (err) {
    bootDetailEl.textContent = err instanceof Error ? err.message : String(err);
    discardButton.disabled = false;
  }
});

modal = new ModalController({
  backdrop: modalBackdropEl,
  dialog: modalDialogEl,
  pill: pillBtn,
  vmManager,
  terminal,
  onOpenPreview: () => {
    if (desktopShell?.isDesktopMode) desktopShell.openPreview();
    else preview.open();
  },
  onOpenSession: openNewSession,
  onSelectSession: switchToSession,
  onCloseSession: closeSessionTab,
  isDesktopMode: () => desktopShell?.isDesktopMode ?? false,
  onToggleDesktop: () => desktopShell?.toggleDesktopMode(),
  onOpenLauncher: () => desktopShell?.openLauncher(),
  getWaylandStatus: () => desktopShell?.getBridgeStatus(),
  getDesktopDisplayConfig: () => desktopShell!.getDisplayConfig(),
  onSetWaylandScale: (scale) => desktopShell?.setWaylandScale(scale),
  onSetBrowserFullscreen: (enabled) => desktopShell?.setBrowserFullscreen(enabled) ?? true,
  onSetWaylandLodpi: (enabled) => desktopShell?.setWaylandLodpi(enabled),
  getWallpaperSummary: () => desktopShell?.getWallpaperSummary() ?? "赤陶余烬",
  onOpenWallpaperPicker: () => desktopShell?.openWallpaperPicker(),
  onCycleWallpaper: () => desktopShell?.cycleWallpaper(),
  onBeforeOpen: () => {
    desktopShell?.blurInputs();
    queueMicrotask(() => desktopShell?.renderStatus());
  },
  onAfterClose: () => {
    desktopShell?.restoreFocus();
    desktopShell?.renderStatus();
  },
  toast: showToast,
});

async function bootApp(diskMode?: DiskMode): Promise<void> {
  bootOverlayEl.classList.remove("fade-out");
  bootBarFillEl.classList.add("indeterminate");
  bootBarFillEl.style.width = "";
  bootBarFillEl.style.backgroundColor = "";
  bootActionsEl.hidden = true;
  snapshotBootButton.hidden = true;
  snapshotBootButton.disabled = false;
  discardButton.hidden = true;
  resumeButton.textContent = "恢复会话";
  resumeButton.classList.add("active");

  try {
    bootDetailEl.textContent = `${DISTROS[vmManager.distro].label} · DefectingCat/nvim`;
    bootBadgeEl.textContent = globalThis.crossOriginIsolated
      ? "aarch64 · SharedArrayBuffer"
      : "aarch64 · Worker";

    const size = terminal.getSize();
    const restored = await vmManager.boot(size.cols, size.rows, size, { diskMode });
    if (vmManager.vm) {
      desktopShell?.attachVm(vmManager.vm);
    }
    if (vmManager.isSnapshotMode) {
      bootBadgeEl.textContent = `${bootBadgeEl.textContent} · 内存快照`;
    }
    if (restored.length > 0) {
      for (const session of restored) {
        mountSession(session, session.id === vmManager.activeSessionId);
      }
      if (vmManager.activeSessionId) {
        terminal.activateSession(vmManager.activeSessionId, true);
      }
      renderSessionHud();
    } else {
      await openNewSession("nvim", { cwd: "/workspace", startup: true });
    }
    if (vmManager.isSnapshotMode) {
      const notice = vmManager.diskNotice;
      showToast(
        notice
          ? `已进入内存快照模式（临时副本，不写回 IndexedDB：${notice}）`
          : "已进入内存快照模式（临时副本，更改不会写回 IndexedDB）",
        6000,
      );
    }
    if (vmManager.didMemoryFallback()) {
      const diag = vmManager.getStats();
      showToast(
        `浏览器未能分配 ${diag.memoryRequestedMiB} MiB 内存，已自动回退至 ${diag.memoryMiB} MiB`,
        6000,
      );
    }
  } catch (err) {
    bootBarFillEl.classList.remove("indeterminate");
    bootBarFillEl.style.width = "100%";
    bootBarFillEl.style.backgroundColor = "#c95646";
    if (err instanceof DiskLockError) {
      bootTitleEl.textContent = "持久化磁盘已在其他标签页打开";
      bootDetailEl.textContent =
        "另一标签页正独占写入 IndexedDB 磁盘。你可以启动基于当前磁盘拷贝的内存快照副本（仅当前标签页有效，不写回 IndexedDB），或关闭其他标签页后重试。";
      bootActionsEl.hidden = false;
      snapshotBootButton.hidden = false;
      resumeButton.textContent = "重试持久化启动";
      resumeButton.classList.remove("active");
      discardButton.hidden = true;
      snapshotBootButton.focus();
      console.warn(err);
      return;
    }
    bootTitleEl.textContent = err instanceof ResumeSessionError ? "恢复会话失败" : "启动失败";
    bootDetailEl.textContent = (err as Error)?.message ?? String(err);
    if (err instanceof ResumeSessionError) {
      bootActionsEl.hidden = false;
      resumeButton.textContent = "重试恢复";
      discardButton.hidden = false;
      resumeButton.focus();
    }
    console.error(err);
  }
}

void bootApp();

// Expose debug handle for automated E2E tests and browser DevTools
(globalThis as Record<string, unknown>).__unkernelNvim = {
  vmManager,
  terminal,
  modal,
  desktopShell,
  waylandBridge: desktopShell.bridge,
};

