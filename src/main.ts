// SPDX-License-Identifier: MIT
// Application entry point: wires the fullscreen WebGL2 Canvas terminal,
// WorkerKernel VM manager, boot progress overlay, and modal control center.

import { DISTROS } from "./distro.ts";
import { GuestPreview } from "./guest-preview.ts";
import { ModalController } from "./modal.ts";
import { ResumeSessionError } from "./suspended-session.ts";
import { CanvasTerminal, SHELL_SCROLLBACK_LINES } from "./terminal.ts";
import { VmManager, type BootStatusUpdate } from "./vm-manager.ts";

const stageEl = document.getElementById("terminal-stage")!;
const bootOverlayEl = document.getElementById("boot-overlay")!;
const bootTitleEl = document.getElementById("boot-title")!;
const bootDetailEl = document.getElementById("boot-detail")!;
const bootBarFillEl = document.getElementById("boot-bar-fill")!;
const bootBadgeEl = document.getElementById("boot-mode-badge")!;
const bootActionsEl = document.getElementById("boot-actions")!;
const resumeButton = document.querySelector<HTMLButtonElement>("#btn-resume-session")!;
const discardButton = document.querySelector<HTMLButtonElement>("#btn-discard-session")!;
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
  if (!modal?.isOpen) terminal.focus();
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
    preview.close();
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

const terminal = new CanvasTerminal({
  container: stageEl,
  onToggleMenu: () => modal?.toggle(),
  onFirstOutput: () => {
    hideBootOverlay();
  },
});

const vmManager = new VmManager({
  onStatus: updateBootOverlay,
  onNotice: showToast,
  onSessionExit: (mode) => {
    pillLabelEl.textContent = `${mode} (exited)`;
    modal?.open("workspace");
    showToast(
      mode === "nvim"
        ? "Neovim 已退出"
        : "Shell 会话已结束",
    );
  },
});

const preview = new GuestPreview(() => vmManager.vm, () => terminal.focus());

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
  onOpenPreview: () => preview.open(),
  toast: showToast,
  onSessionChange: (mode) => {
    pillLabelEl.textContent = mode === "nvim" ? "nvim" : vmManager.shellName;
  },
});

async function bootApp(): Promise<void> {
  try {
    bootDetailEl.textContent = `${DISTROS[vmManager.distro].label} · DefectingCat/nvim`;
    bootBadgeEl.textContent = globalThis.crossOriginIsolated
      ? "aarch64 · SharedArrayBuffer"
      : "aarch64 · Worker";

    const size = terminal.getSize();
    const restored = await vmManager.boot(size.cols, size.rows, size);
    const pty = restored ?? await vmManager.startSession("nvim", terminal.getSize(), "/workspace");
    const shell = vmManager.currentMode === "shell";
    pillLabelEl.textContent = shell ? vmManager.shellName : "nvim";
    terminal.attachPty(pty, shell ? SHELL_SCROLLBACK_LINES : 0);
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
};

