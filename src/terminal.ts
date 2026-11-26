// SPDX-License-Identifier: MIT
// Fullscreen WebGL2 Canvas terminal powered by @xterm/xterm v6 + @xterm/addon-webgl,
// styled with DefectingCat/clay.nvim's exact dark palette and paired with a
// 16ms / 256KiB time-sliced PTY output pump so heavy output never blocks input.

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Pty } from "unkernel";

/** Exact dark palette from https://github.com/DefectingCat/clay.nvim */
export const CLAY_DARK_PALETTE = {
  bg: "#121212",
  sidebar: "#101010",
  float: "#1a1a1a",
  cursorline: "#1e1e1e",
  selection: "#363636",
  border: "#2a2a2a",
  floatBorder: "#444444",
  fg: "#cccccc",
  bright: "#e6e6e6",
  secondary: "#aaaaaa",
  string: "#b0978e",
  muted: "#8e8e8e",
  subtle: "#686868",
  comment: "#7a7a7a",
  clay: "#d97757",
} as const;

const SLICE_MS = 16;
const SLICE_BYTES = 262_144;
const RESIZE_DEBOUNCE_MS = 32;
export const SHELL_SCROLLBACK_LINES = 1_000;

/** Unthrottled task boundary (MessageChannel is not throttled like setTimeout). */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

export interface CanvasTerminalOptions {
  container: HTMLElement;
  fontSize?: number;
  onToggleMenu?: () => void;
  onCycleSession?: (delta: 1 | -1) => void;
  onQuickToggleSession?: () => void;
  onFirstOutput?: () => void;
  onDropFiles?: (files: File[]) => void | Promise<void>;
}

interface TerminalPane {
  id: string;
  el: HTMLDivElement;
  term: Terminal;
  fitAddon: FitAddon;
  webgl: WebglAddon | null;
  pty: Pty | null;
  pumpAbort: AbortController | null;
  scrollback: number;
}

export class CanvasTerminal {
  webglActive = false;

  #container: HTMLElement;
  #panes = new Map<string, TerminalPane>();
  #activeId: string | null = null;
  #unclaimedId: string | null = null;
  #fontSize: number;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #onToggleMenu?: () => void;
  #onCycleSession?: (delta: 1 | -1) => void;
  #onQuickToggleSession?: () => void;
  #onFirstOutput?: () => void;
  #onDropFiles?: (files: File[]) => void | Promise<void>;
  #sawFirstOutput = false;
  #dragDepth = 0;

  constructor(opts: CanvasTerminalOptions) {
    this.#container = opts.container;
    this.#onToggleMenu = opts.onToggleMenu;
    this.#onCycleSession = opts.onCycleSession;
    this.#onQuickToggleSession = opts.onQuickToggleSession;
    this.#onFirstOutput = opts.onFirstOutput;
    this.#onDropFiles = opts.onDropFiles;
    this.#fontSize = Number(localStorage.getItem("unkernel-nvim.fontSize")) || opts.fontSize || 15;

    const initialId = "__initial__";
    const initialPane = this.#createPane(initialId, 0, true);
    this.#panes.set(initialId, initialPane);
    this.#activeId = initialId;
    this.#unclaimedId = initialId;

    // Observe container resize with 32ms debounce to avoid flooding guest with SIGWINCH
    const ro = new ResizeObserver(() => {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => {
        this.fit();
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(this.#container);
    window.addEventListener("resize", () => {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => {
        this.fit();
      }, RESIZE_DEBOUNCE_MS);
    });

    this.#bindFileDrop();
  }

  get #activePane(): TerminalPane | null {
    if (this.#activeId) {
      return this.#panes.get(this.#activeId) ?? null;
    }
    return null;
  }

  get term(): Terminal {
    const active = this.#activePane;
    if (active) return active.term;
    const first = this.#panes.values().next().value;
    if (!first) throw new Error("No terminal pane mounted");
    return first.term;
  }

  #createPane(id: string, scrollback: number, active: boolean): TerminalPane {
    const el = document.createElement("div");
    el.className = active ? "terminal-pane active" : "terminal-pane";
    el.dataset.sessionId = id;
    this.#container.appendChild(el);

    const term = new Terminal({
      allowProposedApi: true,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback,
      macOptionIsMeta: true,
      fontSize: this.#fontSize,
      lineHeight: 1.18,
      fontFamily:
        '"Maple Mono Normal NF CN", "Maple Mono NF", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: CLAY_DARK_PALETTE.bg,
        foreground: CLAY_DARK_PALETTE.fg,
        cursor: CLAY_DARK_PALETTE.clay,
        cursorAccent: CLAY_DARK_PALETTE.bg,
        selectionBackground: CLAY_DARK_PALETTE.selection,
        scrollbarSliderBackground: CLAY_DARK_PALETTE.subtle,
        scrollbarSliderHoverBackground: CLAY_DARK_PALETTE.string,
        scrollbarSliderActiveBackground: CLAY_DARK_PALETTE.clay,
        // ANSI 0..15 mapped per clay.nvim terminal_keys.dark
        black: CLAY_DARK_PALETTE.sidebar,
        red: CLAY_DARK_PALETTE.clay,
        green: CLAY_DARK_PALETTE.bright,
        yellow: CLAY_DARK_PALETTE.secondary,
        blue: CLAY_DARK_PALETTE.secondary,
        magenta: CLAY_DARK_PALETTE.muted,
        cyan: CLAY_DARK_PALETTE.secondary,
        white: CLAY_DARK_PALETTE.fg,
        brightBlack: CLAY_DARK_PALETTE.comment,
        brightRed: CLAY_DARK_PALETTE.clay,
        brightGreen: CLAY_DARK_PALETTE.bright,
        brightYellow: CLAY_DARK_PALETTE.fg,
        brightBlue: CLAY_DARK_PALETTE.fg,
        brightMagenta: CLAY_DARK_PALETTE.secondary,
        brightCyan: CLAY_DARK_PALETTE.fg,
        brightWhite: CLAY_DARK_PALETTE.bright,
      },
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    const clipboardAddon = new ClipboardAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(clipboardAddon);
    term.unicode.activeVersion = "11";

    // Intercept host shortcuts before guest PTY receives them
    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== "keydown") return true;
      if (
        (ev.key === "P" || ev.key === "p") &&
        ev.shiftKey &&
        (ev.ctrlKey || ev.metaKey)
      ) {
        ev.preventDefault();
        this.#onToggleMenu?.();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey) {
        if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          this.#onCycleSession?.(-1);
          return false;
        }
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          this.#onCycleSession?.(1);
          return false;
        }
        if (ev.code === "Backslash") {
          ev.preventDefault();
          this.#onQuickToggleSession?.();
          return false;
        }
      }
      return true;
    });

    const pane: TerminalPane = {
      id,
      el,
      term,
      fitAddon,
      webgl: null,
      pty: null,
      pumpAbort: null,
      scrollback,
    };

    term.open(el);
    if (active) {
      this.#attachWebgl(pane);
    }
    try {
      fitAddon.fit();
    } catch {}

    // Forward user keystrokes and binary mouse/paste sequences to the pane's PTY
    term.onData((data) => {
      pane.pty?.write(data).catch(() => {});
    });
    term.onBinary((bin) => {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i) & 0xff;
      }
      pane.pty?.write(bytes).catch(() => {});
    });

    return pane;
  }

  #bindFileDrop(): void {
    const hasFiles = (ev: DragEvent): boolean =>
      Boolean(ev.dataTransfer?.types && Array.from(ev.dataTransfer.types).includes("Files"));

    this.#container.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      this.#dragDepth += 1;
      this.#container.classList.add("drop-active");
    });

    this.#container.addEventListener("dragover", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = "copy";
      }
    });

    this.#container.addEventListener("dragleave", (ev) => {
      if (!hasFiles(ev) && this.#dragDepth === 0) return;
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (this.#dragDepth === 0) {
        this.#container.classList.remove("drop-active");
      }
    });

    this.#container.addEventListener("drop", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      this.#dragDepth = 0;
      this.#container.classList.remove("drop-active");
      const files = Array.from(ev.dataTransfer?.files ?? []);
      if (files.length > 0) {
        void this.#onDropFiles?.(files);
      }
    });
  }

  #detachWebgl(pane: TerminalPane): void {
    if (!pane.webgl) return;
    try {
      pane.webgl.dispose();
    } catch {}
    pane.webgl = null;
    if (this.#activeId === pane.id) {
      this.webglActive = false;
    }
  }

  #attachWebgl(pane: TerminalPane): void {
    if (pane.webgl) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (pane.webgl === webgl) {
          pane.webgl = null;
        }
        try {
          webgl.dispose();
        } catch {}
        if (this.#activeId === pane.id) {
          this.webglActive = false;
          this.#attachWebgl(pane);
        }
      });
      pane.term.loadAddon(webgl);
      // Fix @xterm/addon-webgl initialization order & ResizeObserver canvas/gl.viewport desync on HiDPI:
      // 1) _initializeWebGLState calls handleResize before _glyphRenderer.value is assigned;
      // 2) _observerDisposable mutates canvas.width/height without updating gl.viewport or u_resolution.
      const renderer = (
        webgl as unknown as {
          _renderer?: {
            _observerDisposable?: { clear?: () => void };
            handleResize?: (cols: number, rows: number) => void;
          };
        }
      )._renderer;
      renderer?._observerDisposable?.clear?.();
      renderer?.handleResize?.(pane.term.cols, pane.term.rows);
      pane.webgl = webgl;
      this.webglActive = true;
    } catch (err) {
      console.warn("[terminal] WebGL2 renderer unavailable, falling back to default renderer:", err);
      pane.webgl = null;
      this.webglActive = false;
    }
  }

  getSize(): { cols: number; rows: number; xpixel: number; ypixel: number } {
    const pane = this.#activePane ?? this.#panes.values().next().value;
    return {
      cols: pane?.term.cols || 80,
      rows: pane?.term.rows || 24,
      xpixel: Math.min(0xffff, Math.round(this.#container.clientWidth)),
      ypixel: Math.min(0xffff, Math.round(this.#container.clientHeight)),
    };
  }

  #fitPane(pane: TerminalPane): void {
    try {
      pane.fitAddon.fit();
      const s = {
        cols: pane.term.cols || 80,
        rows: pane.term.rows || 24,
        xpixel: Math.min(0xffff, Math.round(this.#container.clientWidth)),
        ypixel: Math.min(0xffff, Math.round(this.#container.clientHeight)),
      };
      pane.pty?.resize(s.cols, s.rows, s.xpixel, s.ypixel);
    } catch {}
  }

  fit(): void {
    const pane = this.#activePane;
    if (pane) this.#fitPane(pane);
  }

  setFontSize(px: number): void {
    const clamped = Math.max(10, Math.min(28, Math.round(px)));
    this.#fontSize = clamped;
    localStorage.setItem("unkernel-nvim.fontSize", String(clamped));
    for (const pane of this.#panes.values()) {
      pane.term.options.fontSize = clamped;
      if (pane.id !== this.#activeId) {
        this.#fitPane(pane);
      }
    }
    this.fit();
  }

  getFontSize(): number {
    return this.#fontSize;
  }

  focus(): void {
    this.#activePane?.term.focus();
  }

  paste(text: string): void {
    this.#activePane?.term.paste(text);
  }

  mountSession(id: string, pty: Pty, scrollback = 0, opts: { activate?: boolean } = {}): void {
    let pane: TerminalPane | undefined;

    if (this.#unclaimedId) {
      const claimed = this.#panes.get(this.#unclaimedId);
      if (claimed) {
        this.#panes.delete(this.#unclaimedId);
        claimed.id = id;
        claimed.el.dataset.sessionId = id;
        this.#panes.set(id, claimed);
        if (this.#activeId === this.#unclaimedId) {
          this.#activeId = id;
        }
        pane = claimed;
      }
      this.#unclaimedId = null;
    } else {
      pane = this.#panes.get(id);
    }

    if (!pane) {
      pane = this.#createPane(id, scrollback, false);
      this.#panes.set(id, pane);
    }

    pane.pumpAbort?.abort();
    const abort = new AbortController();
    pane.pumpAbort = abort;
    pane.pty = pty;
    pane.scrollback = scrollback;
    pane.term.reset();
    pane.term.options.scrollback = scrollback;

    if (opts.activate ?? true) {
      this.activateSession(id, false);
    } else {
      this.#fitPane(pane);
    }

    void this.#pumpOutput(pane, pty, abort.signal);
  }

  activateSession(id: string, shouldFocus = true): void {
    const target = this.#panes.get(id);
    if (!target) return;

    const prev = this.#activePane;
    if (prev && prev !== target) {
      prev.el.classList.remove("active");
      this.#detachWebgl(prev);
    }

    this.#activeId = id;
    target.el.classList.add("active");
    this.#attachWebgl(target);
    this.#fitPane(target);
    if (shouldFocus) {
      target.term.focus();
    }
  }

  unmountSession(id: string): void {
    const pane = this.#panes.get(id);
    if (!pane) return;

    pane.pumpAbort?.abort();
    pane.pumpAbort = null;
    pane.pty = null;
    this.#detachWebgl(pane);
    pane.term.dispose();
    pane.el.remove();
    this.#panes.delete(id);

    if (this.#activeId === id) {
      this.#activeId = null;
      this.webglActive = false;
    }
  }

  unmountAll(): void {
    for (const id of [...this.#panes.keys()]) {
      this.unmountSession(id);
    }
    this.#unclaimedId = null;
  }

  attachPty(pty: Pty, scrollback = 0): void {
    const id = this.#activeId ?? "default";
    this.mountSession(id, pty, scrollback, { activate: true });
  }

  async #pumpOutput(pane: TerminalPane, pty: Pty, signal: AbortSignal): Promise<void> {
    const reader = pty.output.getReader();
    let sliceStart = performance.now();
    let sliceBytes = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) {
          if (signal.aborted) {
            await reader.cancel().catch(() => {});
          }
          return;
        }
        if (!this.#sawFirstOutput && value.byteLength > 0) {
          this.#sawFirstOutput = true;
          this.#onFirstOutput?.();
        }
        await new Promise<void>((resolve) => {
          pane.term.write(value, resolve);
        });
        sliceBytes += value.byteLength;
        if (sliceBytes >= SLICE_BYTES || performance.now() - sliceStart >= SLICE_MS) {
          await yieldTask();
          sliceStart = performance.now();
          sliceBytes = 0;
        }
      }
    } catch {
      // Session ended or failed
    }
  }
}
