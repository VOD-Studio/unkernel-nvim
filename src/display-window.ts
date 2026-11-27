// SPDX-License-Identifier: MIT
// Virtual display window for guest /dev/fb0, KMS / virtio-gpu scanout,
// evdev keyboard/mouse/tablet input, and live updateDisplaySize() resizing.

import {
  domButtonToLinux,
  domCodeToLinux,
  type DisplayFrame,
  type DisplayMode,
  type InputState,
  type KernelHandle,
} from "unkernel";
import { createDesktopIconElement } from "./desktop-icons.ts";
import {
  applyWindowResize,
  clampWindowRect,
  computeCascadeRect,
  DOCK_CLEARANCE,
  WIN_EDGE_BOTTOM,
  WIN_EDGE_LEFT,
  WIN_EDGE_RIGHT,
  WIN_EDGE_TOP,
  type DesktopBounds,
  type WindowRect,
} from "./desktop-state.ts";

export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
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

export function normalizeDisplayResize(width: number, height: number): { width: number; height: number } {
  const clampedW = Math.max(320, Math.min(2560, Math.floor(width)));
  const clampedH = Math.max(200, Math.min(1600, Math.floor(height)));
  return {
    width: Math.max(320, Math.floor(clampedW / 2) * 2),
    height: Math.max(200, Math.floor(clampedH / 2) * 2),
  };
}

export function mapClientPointToDisplay(
  clientX: number,
  clientY: number,
  rect: ClientRectLike,
  displayW: number,
  displayH: number,
): { nx: number; ny: number; inside: boolean } {
  if (rect.width <= 0 || rect.height <= 0 || displayW <= 0 || displayH <= 0) {
    return { nx: 0, ny: 0, inside: false };
  }
  const scale = Math.min(rect.width / displayW, rect.height / displayH);
  const fittedW = displayW * scale;
  const fittedH = displayH * scale;
  const offsetX = rect.left + (rect.width - fittedW) / 2;
  const offsetY = rect.top + (rect.height - fittedH) / 2;

  const rawX = (clientX - offsetX) / fittedW;
  const rawY = (clientY - offsetY) / fittedH;
  const inside = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
  return {
    nx: Math.max(0, Math.min(1, rawX)),
    ny: Math.max(0, Math.min(1, rawY)),
    inside,
  };
}

export function wheelDeltaToClicks(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const mag = Math.max(1, Math.min(5, Math.round(Math.abs(deltaY) / 100) || 1));
  return deltaY < 0 ? mag : -mag;
}

export function formatDisplayBadge(
  mode: DisplayMode | null,
  hasGpuScanout: boolean,
  input: InputState,
): string {
  const size = mode ? `${mode.width}×${mode.height}` : "待命";
  const driver = hasGpuScanout ? "GPU" : "fb0";
  const hints: string[] = [];
  if (input.keyboard) hints.push("kbd");
  if (input.tablet) hints.push("abs");
  else if (input.mouse) hints.push("rel");
  return hints.length > 0 ? `${size} · ${driver} · ${hints.join("+")}` : `${size} · ${driver}`;
}

export interface GuestDisplayWindowOptions {
  container: HTMLElement;
  getVm: () => KernelHandle | null;
  getBounds: () => DesktopBounds;
  isDesktopMode: () => boolean;
  isOverlayBlocking: () => boolean;
  startPointerDrag: (
    pointerId: number,
    onMove: (ev: PointerEvent) => void,
    onDone?: () => void,
  ) => void;
  onRequestDesktop: () => void;
  onFocus: () => void;
  onTitlebarContextMenu?: (e: MouseEvent) => void;
  onStateChange: () => void;
}

/**
 * Floating desktop window for guest /dev/fb0, KMS/virtio-gpu scanout,
 * and evdev keyboard/mouse/tablet input.
 */
export class GuestDisplayWindow {
  readonly #opts: GuestDisplayWindowOptions;
  readonly #frameEl: HTMLDivElement;
  readonly #titlebarEl: HTMLDivElement;
  readonly #titleEl: HTMLSpanElement;
  readonly #badgeEl: HTMLSpanElement;
  readonly #lockBtn: HTMLButtonElement;
  readonly #maxBtn: HTMLButtonElement;
  readonly #bodyEl: HTMLDivElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;

  #vm: KernelHandle | null = null;
  #prevGpuOnFrame: (() => void) | undefined;
  #mode: DisplayMode | null = null;
  #input: InputState = { keyboard: false, mouse: false, tablet: false };
  #hasGpuScanout = false;
  #open = false;
  #minimized = false;
  #maximized = false;
  #focused = false;
  #zIndex = 25;
  #rect: WindowRect | null = null;
  #restoreRect: WindowRect | null = null;
  #rafId = 0;
  #forceRedraw = false;
  #pixelBuf: Uint8ClampedArray | null = null;
  #imageData: ImageData | null = null;
  #resizeTimer: ReturnType<typeof setTimeout> | null = null;
  #lastClientX: number | null = null;
  #lastClientY: number | null = null;
  #pendingSize: { width: number; height: number } | null = null;

  constructor(opts: GuestDisplayWindowOptions) {
    this.#opts = opts;

    this.#frameEl = document.createElement("div");
    this.#frameEl.className = "desktop-win display-win";
    this.#frameEl.hidden = true;

    this.#titlebarEl = document.createElement("div");
    this.#titlebarEl.className = "desktop-win-bar";

    this.#titleEl = document.createElement("span");
    this.#titleEl.className = "desktop-win-title";
    this.#titleEl.textContent = "虚拟显示器";

    this.#badgeEl = document.createElement("span");
    this.#badgeEl.className = "desktop-win-badge";
    this.#badgeEl.textContent = "fb0";

    const controlsEl = document.createElement("div");
    controlsEl.className = "win-controls";

    this.#lockBtn = document.createElement("button");
    this.#lockBtn.type = "button";
    this.#lockBtn.className = "win-ctrl";
    this.#lockBtn.title = "锁定鼠标指针 (Esc 释放)";
    this.#lockBtn.textContent = "🔒";
    this.#lockBtn.hidden = true;

    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "win-ctrl";
    minBtn.title = "最小化";
    minBtn.textContent = "—";

    this.#maxBtn = document.createElement("button");
    this.#maxBtn.type = "button";
    this.#maxBtn.className = "win-ctrl";
    this.#maxBtn.title = "最大化";
    this.#maxBtn.textContent = "□";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "win-ctrl win-ctrl-close";
    closeBtn.title = "隐藏显示器窗口";
    closeBtn.textContent = "×";

    const titleIconEl = createDesktopIconElement("display", "titlebar");
    titleIconEl.classList.add("win-title-icon");

    controlsEl.append(this.#lockBtn, minBtn, this.#maxBtn, closeBtn);
    this.#titlebarEl.append(titleIconEl, this.#titleEl, this.#badgeEl, controlsEl);

    this.#bodyEl = document.createElement("div");
    this.#bodyEl.className = "desktop-win-body display-win-body";

    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "display-win-canvas";
    this.#canvas.tabIndex = 0;
    this.#canvas.width = 1280;
    this.#canvas.height = 720;
    this.#ctx = this.#canvas.getContext("2d");

    this.#bodyEl.appendChild(this.#canvas);
    this.#frameEl.append(this.#titlebarEl, this.#bodyEl);

    this.#bindWindowChrome(minBtn, closeBtn);
    this.#bindInputEvents();

    opts.container.appendChild(this.#frameEl);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get isMinimized(): boolean {
    return this.#minimized;
  }

  get isFocused(): boolean {
    return this.#focused;
  }

  get isMaximized(): boolean {
    return this.#maximized;
  }

  get title(): string {
    return this.#mode ? `虚拟显示器 · ${this.#mode.width}×${this.#mode.height}` : "虚拟显示器";
  }

  attachVm(vm: KernelHandle): void {
    this.detachVm();
    this.#vm = vm;
    const gpu = vm.gl?.gpu;
    if (gpu) {
      this.#prevGpuOnFrame = gpu.onFrame;
      gpu.onFrame = () => {
        this.#prevGpuOnFrame?.();
        this.#forceRedraw = true;
        if (this.#open && !this.#minimized) {
          this.#scheduleLoop();
        }
      };
    }
    void vm.exited.then(() => {
      if (this.#vm === vm) {
        this.detachVm();
      }
    });
  }

  detachVm(): void {
    if (this.#vm?.gl?.gpu && this.#vm.gl.gpu.onFrame !== this.#prevGpuOnFrame) {
      this.#vm.gl.gpu.onFrame = this.#prevGpuOnFrame;
    }
    this.#prevGpuOnFrame = undefined;
    this.#vm = null;
    this.#mode = null;
    this.#hasGpuScanout = false;
    this.#input = { keyboard: false, mouse: false, tablet: false };
    this.#open = false;
    this.#minimized = false;
    this.#focused = false;
    this.#stopLoop();
    this.#clearResizeTimer();
    this.#exitPointerLock();
    this.#frameEl.hidden = true;
    this.#opts.onStateChange();
  }

  handleDisplayMode(mode: DisplayMode | null): void {
    this.#mode = mode;
    if (!mode) {
      this.#hasGpuScanout = false;
      this.#open = false;
      this.#minimized = false;
      this.#focused = false;
      this.#stopLoop();
      this.releaseInput();
      this.#exitPointerLock();
      this.#frameEl.hidden = true;
      this.#updateChrome();
      this.#opts.onStateChange();
      return;
    }

    if (!this.#opts.isDesktopMode()) {
      this.#opts.onRequestDesktop();
    }

    const wasOpen = this.#open;
    this.#open = true;
    this.#minimized = false;
    this.#forceRedraw = true;
    this.#frameEl.hidden = false;

    if (!this.#rect) {
      const bounds = this.#opts.getBounds();
      const titleH = this.#titlebarEl.offsetHeight || 30;
      const prefW = Math.min(Math.max(480, mode.width), Math.max(480, bounds.width - 48));
      const prefH = Math.min(Math.max(320, mode.height + titleH), Math.max(320, bounds.height - 96));
      this.#rect = computeCascadeRect(1, bounds, prefW, prefH);
    }

    if (this.#canvas.width !== mode.width || this.#canvas.height !== mode.height) {
      this.#canvas.width = mode.width;
      this.#canvas.height = mode.height;
    }

    this.#applyGeometry();
    this.#updateChrome();
    this.#scheduleLoop();
    if (!wasOpen) {
      this.#opts.onFocus();
    }
    this.#opts.onStateChange();
  }

  handleInputState(state: InputState): void {
    this.#input = state;
    if (!state.mouse && document.pointerLockElement === this.#canvas) {
      this.#exitPointerLock();
    }
    if (!state.keyboard && !state.mouse && !state.tablet) {
      this.#lastClientX = null;
      this.#lastClientY = null;
    }
    this.#updateChrome();
  }

  setFocused(focused: boolean): void {
    if (this.#focused === focused) return;
    this.#focused = focused;
    this.#frameEl.classList.toggle("focused", focused && this.#open && !this.#minimized);
    if (focused && this.#open && !this.#minimized && !this.#opts.isOverlayBlocking()) {
      this.#canvas.focus({ preventScroll: true });
    } else if (!focused) {
      this.releaseInput();
      this.#exitPointerLock();
    }
  }

  raise(zIndex: number): void {
    this.#zIndex = zIndex;
    this.#minimized = false;
    this.#frameEl.hidden = !this.#open;
    this.#applyGeometry();
    this.#scheduleLoop();
  }

  minimize(): void {
    if (!this.#open || this.#minimized) return;
    this.#minimized = true;
    this.#focused = false;
    this.#stopLoop();
    this.releaseInput();
    this.#exitPointerLock();
    this.#applyGeometry();
    this.#opts.onStateChange();
  }

  restore(zIndex: number): void {
    if (!this.#open) return;
    this.#minimized = false;
    this.#zIndex = zIndex;
    this.#forceRedraw = true;
    this.#applyGeometry();
    this.#scheduleLoop();
    this.#opts.onFocus();
    this.#opts.onStateChange();
  }

  toggleMaximize(zIndex: number): void {
    if (!this.#open) return;
    this.#minimized = false;
    this.#zIndex = zIndex;
    if (!this.#maximized) {
      this.#restoreRect = this.#rect ? { ...this.#rect } : null;
      this.#maximized = true;
    } else {
      this.#maximized = false;
      if (this.#restoreRect) {
        this.#rect = clampWindowRect(this.#restoreRect, this.#opts.getBounds());
      }
      this.#restoreRect = null;
    }
    this.#applyGeometry();
    this.#updateChrome();
    this.#pushCurrentBodyDisplaySize(true);
    this.#opts.onFocus();
    this.#opts.onStateChange();
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#minimized = false;
    this.#focused = false;
    this.#stopLoop();
    this.#clearResizeTimer();
    this.releaseInput();
    this.#exitPointerLock();
    this.#frameEl.hidden = true;
    this.#opts.onStateChange();
  }

  clampToBounds(): void {
    if (!this.#rect) return;
    this.#rect = clampWindowRect(this.#rect, this.#opts.getBounds());
    this.#applyGeometry();
  }

  centerInBounds(): void {
    if (!this.#open) return;
    this.#minimized = false;
    this.#maximized = false;
    this.#restoreRect = null;
    const bounds = this.#opts.getBounds();
    const cur = this.#rect ?? computeCascadeRect(0, bounds, 820, 540);
    const clamped = clampWindowRect(cur, bounds);
    this.#rect = clampWindowRect(
      {
        x: Math.round((bounds.width - clamped.width) / 2),
        y: Math.round((bounds.height - DOCK_CLEARANCE - clamped.height) / 2),
        width: clamped.width,
        height: clamped.height,
      },
      bounds,
    );
    this.#applyGeometry();
    this.#updateChrome();
    this.#pushCurrentBodyDisplaySize(true);
    this.#opts.onStateChange();
  }

  setWindowRect(rect: WindowRect): void {
    if (!this.#open) return;
    this.#minimized = false;
    this.#maximized = false;
    this.#restoreRect = null;
    this.#rect = clampWindowRect(rect, this.#opts.getBounds());
    this.#applyGeometry();
    this.#updateChrome();
    this.#pushCurrentBodyDisplaySize(true);
    this.#opts.onStateChange();
  }

  syncVisibility(): void {
    if (this.#open && !this.#minimized && this.#opts.isDesktopMode() && document.visibilityState === "visible") {
      this.#forceRedraw = true;
      this.#scheduleLoop();
    } else {
      this.#stopLoop();
      if (document.visibilityState !== "visible" || !this.#opts.isDesktopMode()) {
        this.releaseInput();
      }
    }
  }

  releaseInput(): void {
    this.#lastClientX = null;
    this.#lastClientY = null;
    this.#opts.getVm()?.evdev?.releaseAll();
  }

  #bindWindowChrome(minBtn: HTMLButtonElement, closeBtn: HTMLButtonElement): void {
    this.#frameEl.addEventListener(
      "pointerdown",
      () => {
        this.#opts.onFocus();
      },
      true,
    );

    this.#lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#opts.onFocus();
      if (document.pointerLockElement === this.#canvas) {
        this.#exitPointerLock();
      } else {
        this.#canvas.requestPointerLock?.();
      }
    });

    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.minimize();
    });

    this.#maxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMaximize(this.#zIndex + 1);
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });

    this.#titlebarEl.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.toggleMaximize(this.#zIndex + 1);
    });

    this.#titlebarEl.addEventListener("contextmenu", (e) => {
      if (!this.#opts.onTitlebarContextMenu) return;
      e.preventDefault();
      e.stopPropagation();
      this.#opts.onTitlebarContextMenu(e);
    });

    this.#titlebarEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      if (this.#maximized) return;
      e.preventDefault();
      this.#opts.onFocus();
      const startRect = this.#rect ?? { x: 40, y: 40, width: 800, height: 520 };
      const startX = e.clientX;
      const startY = e.clientY;
      this.#opts.startPointerDrag(e.pointerId, (mv) => {
        this.#rect = clampWindowRect(
          {
            ...startRect,
            x: startRect.x + (mv.clientX - startX),
            y: startRect.y + (mv.clientY - startY),
          },
          this.#opts.getBounds(),
        );
        this.#applyGeometry();
      });
    });

    for (const spec of RESIZE_EDGES) {
      const handle = document.createElement("div");
      handle.className = `win-resize-handle win-resize-${spec.className}`;
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || this.#maximized) return;
        e.preventDefault();
        e.stopPropagation();
        this.#opts.onFocus();
        const startRect = this.#rect ?? { x: 40, y: 40, width: 800, height: 520 };
        const startX = e.clientX;
        const startY = e.clientY;
        this.#opts.startPointerDrag(
          e.pointerId,
          (mv) => {
            this.#rect = applyWindowResize(
              startRect,
              mv.clientX - startX,
              mv.clientY - startY,
              spec.edges,
              this.#opts.getBounds(),
            );
            this.#applyGeometry();
            this.#pushCurrentBodyDisplaySize(false);
          },
          () => {
            this.#pushCurrentBodyDisplaySize(true);
          },
        );
      });
      this.#frameEl.appendChild(handle);
    }
  }

  #bindInputEvents(): void {
    this.#canvas.addEventListener("contextmenu", (e) => {
      const evdev = this.#opts.getVm()?.evdev;
      if (evdev?.mouseOpen || evdev?.tabletOpen) {
        e.preventDefault();
      }
    });

    this.#canvas.addEventListener("blur", () => {
      this.releaseInput();
    });

    this.#canvas.addEventListener("keydown", (e) => {
      if (!this.#focused || this.#opts.isOverlayBlocking()) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ["P", "p", "D", "d", "K", "k"].includes(e.key)) {
        return;
      }
      const evdev = this.#opts.getVm()?.evdev;
      if (!evdev?.keyboardOpen) return;
      const code = domCodeToLinux(e.code);
      if (code === undefined) return;
      e.preventDefault();
      evdev.key(code, true);
    });

    this.#canvas.addEventListener("keyup", (e) => {
      const evdev = this.#opts.getVm()?.evdev;
      if (!evdev?.keyboardOpen) return;
      const code = domCodeToLinux(e.code);
      if (code === undefined) return;
      e.preventDefault();
      evdev.key(code, false);
    });

    this.#canvas.addEventListener("pointerdown", (e) => {
      this.#opts.onFocus();
      this.#canvas.focus({ preventScroll: true });
      const evdev = this.#opts.getVm()?.evdev;
      if (!evdev) return;
      const btn = domButtonToLinux(e.button);
      if (evdev.tabletOpen) {
        const pt = mapClientPointToDisplay(
          e.clientX,
          e.clientY,
          this.#canvas.getBoundingClientRect(),
          this.#canvas.width,
          this.#canvas.height,
        );
        evdev.moveTo(pt.nx, pt.ny);
        if (btn !== undefined) evdev.tabletButton(btn, true);
      } else if (evdev.mouseOpen) {
        this.#lastClientX = e.clientX;
        this.#lastClientY = e.clientY;
        if (btn !== undefined) evdev.button(btn, true);
      }
    });

    this.#canvas.addEventListener("pointerup", (e) => {
      const evdev = this.#opts.getVm()?.evdev;
      if (!evdev) return;
      const btn = domButtonToLinux(e.button);
      if (btn === undefined) return;
      if (evdev.tabletOpen) {
        evdev.tabletButton(btn, false);
      } else if (evdev.mouseOpen) {
        evdev.button(btn, false);
      }
    });

    this.#canvas.addEventListener("pointermove", (e) => {
      const evdev = this.#opts.getVm()?.evdev;
      if (!evdev) return;
      if (evdev.tabletOpen) {
        const pt = mapClientPointToDisplay(
          e.clientX,
          e.clientY,
          this.#canvas.getBoundingClientRect(),
          this.#canvas.width,
          this.#canvas.height,
        );
        evdev.moveTo(pt.nx, pt.ny);
      } else if (evdev.mouseOpen && (this.#focused || document.pointerLockElement === this.#canvas)) {
        if (document.pointerLockElement === this.#canvas) {
          const dx = Math.round(e.movementX);
          const dy = Math.round(e.movementY);
          if (dx !== 0 || dy !== 0) evdev.move(dx, dy);
        } else {
          if (this.#lastClientX !== null && this.#lastClientY !== null) {
            const dx = Math.round(e.clientX - this.#lastClientX);
            const dy = Math.round(e.clientY - this.#lastClientY);
            if (dx !== 0 || dy !== 0) evdev.move(dx, dy);
          }
          this.#lastClientX = e.clientX;
          this.#lastClientY = e.clientY;
        }
      }
    });

    this.#canvas.addEventListener("pointerleave", () => {
      this.#lastClientX = null;
      this.#lastClientY = null;
    });

    this.#canvas.addEventListener(
      "wheel",
      (e) => {
        const evdev = this.#opts.getVm()?.evdev;
        if (!evdev || (!evdev.tabletOpen && !evdev.mouseOpen)) return;
        const clicks = wheelDeltaToClicks(e.deltaY);
        if (clicks === 0) return;
        e.preventDefault();
        if (evdev.tabletOpen) evdev.tabletWheel(clicks);
        else evdev.wheel(clicks);
      },
      { passive: false },
    );

    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.#canvas;
      this.#lockBtn.setAttribute("aria-pressed", String(locked));
    });
  }

  #exitPointerLock(): void {
    if (document.pointerLockElement === this.#canvas) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }
  }

  #pushCurrentBodyDisplaySize(immediate: boolean): void {
    const bodyW = this.#bodyEl.clientWidth || (this.#rect?.width ?? 800);
    const bodyH = this.#bodyEl.clientHeight || Math.max(200, (this.#rect?.height ?? 520) - 30);
    const next = normalizeDisplayResize(bodyW, bodyH);
    this.#pendingSize = next;
    if (immediate) {
      this.#clearResizeTimer();
      this.#flushPendingDisplaySize();
      return;
    }
    if (this.#resizeTimer !== null) return;
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      this.#flushPendingDisplaySize();
    }, 180);
  }

  #flushPendingDisplaySize(): void {
    const next = this.#pendingSize;
    this.#pendingSize = null;
    if (!next) return;
    this.#opts.getVm()?.updateDisplaySize(next);
  }

  #clearResizeTimer(): void {
    if (this.#resizeTimer !== null) {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = null;
    }
    this.#pendingSize = null;
  }

  #applyGeometry(): void {
    const el = this.#frameEl;
    el.style.zIndex = String(this.#zIndex);
    el.classList.toggle("minimized", this.#minimized);
    el.classList.toggle("maximized", this.#maximized);
    el.classList.toggle("focused", this.#focused && this.#open && !this.#minimized);

    if (this.#maximized) {
      const bounds = this.#opts.getBounds();
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = `${bounds.width}px`;
      el.style.height = `${Math.max(240, bounds.height - DOCK_CLEARANCE)}px`;
    } else if (this.#rect) {
      el.style.left = `${this.#rect.x}px`;
      el.style.top = `${this.#rect.y}px`;
      el.style.width = `${this.#rect.width}px`;
      el.style.height = `${this.#rect.height}px`;
    }
  }

  #updateChrome(): void {
    this.#titleEl.textContent = this.title;
    this.#badgeEl.textContent = formatDisplayBadge(this.#mode, this.#hasGpuScanout, this.#input);
    this.#maxBtn.textContent = this.#maximized ? "❐" : "□";
    this.#lockBtn.hidden = !(this.#input.mouse && !this.#input.tablet);
  }

  #scheduleLoop(): void {
    if (this.#rafId !== 0) return;
    if (!this.#open || this.#minimized || !this.#opts.isDesktopMode() || document.visibilityState !== "visible") {
      return;
    }
    const tick = () => {
      this.#rafId = 0;
      if (!this.#open || this.#minimized || !this.#opts.isDesktopMode() || document.visibilityState !== "visible") {
        return;
      }
      this.#drawFrame();
      this.#rafId = requestAnimationFrame(tick);
    };
    this.#rafId = requestAnimationFrame(tick);
  }

  #stopLoop(): void {
    if (this.#rafId !== 0) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
  }

  #ensureBuffer(width: number, height: number): Uint8ClampedArray {
    const needed = width * height * 4;
    if (!this.#pixelBuf || this.#pixelBuf.length !== needed) {
      this.#pixelBuf = new Uint8ClampedArray(needed);
    }
    return this.#pixelBuf;
  }

  #drawFrame(): void {
    const vm = this.#opts.getVm();
    const ctx = this.#ctx;
    if (!vm || !ctx) return;

    const gpu = vm.gl?.gpu;
    const scanout = gpu?.scanout ?? null;
    if (gpu && scanout && scanout.width > 0 && scanout.height > 0) {
      if (this.#canvas.width !== scanout.width || this.#canvas.height !== scanout.height) {
        this.#canvas.width = scanout.width;
        this.#canvas.height = scanout.height;
      }
      const drew = gpu.drawFrame(ctx, this.#forceRedraw);
      if (drew !== null) {
        this.#forceRedraw = false;
        if (!this.#hasGpuScanout) {
          this.#hasGpuScanout = true;
          this.#updateChrome();
        }
        return;
      }
    }

    if (this.#hasGpuScanout) {
      this.#hasGpuScanout = false;
      this.#updateChrome();
    }

    const mode = this.#mode;
    const out = mode ? this.#ensureBuffer(mode.width, mode.height) : undefined;
    const frame: DisplayFrame | null = vm.frame(out);
    if (!frame || frame.width <= 0 || frame.height <= 0) return;

    if (this.#canvas.width !== frame.width || this.#canvas.height !== frame.height) {
      this.#canvas.width = frame.width;
      this.#canvas.height = frame.height;
    }
    if (!this.#imageData || this.#imageData.width !== frame.width || this.#imageData.height !== frame.height) {
      this.#imageData = ctx.createImageData(frame.width, frame.height);
    }
    if (frame.data.buffer !== this.#imageData.data.buffer) {
      this.#imageData.data.set(frame.data);
    }
    ctx.putImageData(this.#imageData, 0, 0);
  }
}
