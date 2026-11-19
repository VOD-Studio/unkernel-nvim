// SPDX-License-Identifier: MIT
// Application entry point: wires the fullscreen WebGL2 Canvas terminal,
// WorkerKernel VM manager, boot progress overlay, and modal control center.

import { ModalController } from "./modal.ts";
import "./style.css";
import { CanvasTerminal } from "./terminal.ts";
import { VmManager, type BootStatusUpdate } from "./vm-manager.ts";

const stageEl = document.getElementById("terminal-stage")!;
const bootOverlayEl = document.getElementById("boot-overlay")!;
const bootTitleEl = document.getElementById("boot-title")!;
const bootDetailEl = document.getElementById("boot-detail")!;
const bootBarFillEl = document.getElementById("boot-bar-fill")!;
const bootBadgeEl = document.getElementById("boot-mode-badge")!;
const pillBtn = document.getElementById("menu-pill") as HTMLButtonElement;
const pillLabelEl = document.getElementById("pill-label")!;
const pillKbdEl = document.getElementById("pill-kbd")!;
const modalBackdropEl = document.getElementById("modal-backdrop")!;
const modalDialogEl = document.getElementById("modal-dialog")!;
const toastContainerEl = document.getElementById("toast-container")!;

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
pillKbdEl.textContent = isMac ? "⌘⇧P" : "Ctrl+⇧+P";

function showToast(message: string, durationMs = 3200): void {
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
  terminal.focus();
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
  if (s.phase === "ready") {
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
  onSessionExit: (mode) => {
    pillLabelEl.textContent = `${mode} (exited)`;
    showToast(
      mode === "nvim"
        ? "Neovim 已退出，正在为您重新打开控制中心…"
        : "Shell 会话已结束，正在打开控制中心…",
    );
    modal?.open();
  },
});

modal = new ModalController({
  backdrop: modalBackdropEl,
  dialog: modalDialogEl,
  pill: pillBtn,
  vmManager,
  terminal,
  toast: showToast,
});

async function bootApp(): Promise<void> {
  try {
    bootBadgeEl.textContent = globalThis.crossOriginIsolated
      ? "riscv64 · SharedArrayBuffer"
      : "riscv64 · Worker";

    const size = terminal.getSize();
    await vmManager.boot(size.cols, size.rows);

    const pty = await vmManager.startSession("nvim", terminal.getSize(), "/workspace");
    pillLabelEl.textContent = "nvim";
    terminal.attachPty(pty);
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
    bootTitleEl.textContent = "启动失败";
    bootDetailEl.textContent = (err as Error)?.message ?? String(err);
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

