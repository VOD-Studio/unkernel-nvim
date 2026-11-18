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
  onFirstOutput?: () => void;
}

export class CanvasTerminal {
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  webglActive = false;

  #container: HTMLElement;
  #pty: Pty | null = null;
  #pumpAbort: AbortController | null = null;
  #encoder = new TextEncoder();
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #onToggleMenu?: () => void;
  #onFirstOutput?: () => void;
  #sawFirstOutput = false;

  constructor(opts: CanvasTerminalOptions) {
    this.#container = opts.container;
    this.#onToggleMenu = opts.onToggleMenu;
    this.#onFirstOutput = opts.onFirstOutput;

    const savedFontSize = Number(localStorage.getItem("unkernel-nvim.fontSize")) || opts.fontSize || 15;

    this.term = new Terminal({
      allowProposedApi: true,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 0, // Neovim runs in alternate screen buffer; 0 scrollback saves memory
      macOptionIsMeta: true,
      fontSize: savedFontSize,
      lineHeight: 1.18,
      fontFamily:
        '"Maple Mono Normal NF CN", "Maple Mono NF", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: CLAY_DARK_PALETTE.bg,
        foreground: CLAY_DARK_PALETTE.fg,
        cursor: CLAY_DARK_PALETTE.clay,
        cursorAccent: CLAY_DARK_PALETTE.bg,
        selectionBackground: CLAY_DARK_PALETTE.selection,
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

    this.fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    const clipboardAddon = new ClipboardAddon();

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(unicode11Addon);
    this.term.loadAddon(clipboardAddon);
    this.term.unicode.activeVersion = "11";

    // Intercept Ctrl+Shift+P / Cmd+Shift+P to toggle the host control modal
    this.term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (
        ev.type === "keydown" &&
        (ev.key === "P" || ev.key === "p") &&
        ev.shiftKey &&
        (ev.ctrlKey || ev.metaKey)
      ) {
        ev.preventDefault();
        this.#onToggleMenu?.();
        return false;
      }
      return true;
    });

    this.term.open(this.#container);
    this.#enableWebgl();
    this.fit();

    // Forward user keystrokes and binary mouse/paste sequences to the active PTY
    this.term.onData((data) => {
      this.#pty?.write(data).catch(() => {});
    });
    this.term.onBinary((bin) => {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i) & 0xff;
      }
      this.#pty?.write(bytes).catch(() => {});
    });

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
  }

  #enableWebgl(): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        this.webglActive = false;
        this.#enableWebgl();
      });
      this.term.loadAddon(webgl);
      this.webglActive = true;
    } catch (err) {
      console.warn("[terminal] WebGL2 renderer unavailable, falling back to default renderer:", err);
      this.webglActive = false;
    }
  }

  getSize(): { cols: number; rows: number; xpixel: number; ypixel: number } {
    return {
      cols: this.term.cols || 80,
      rows: this.term.rows || 24,
      xpixel: Math.min(0xffff, Math.round(this.#container.clientWidth)),
      ypixel: Math.min(0xffff, Math.round(this.#container.clientHeight)),
    };
  }

  fit(): void {
    try {
      this.fitAddon.fit();
      const s = this.getSize();
      this.#pty?.resize(s.cols, s.rows, s.xpixel, s.ypixel);
    } catch {}
  }

  setFontSize(px: number): void {
    const clamped = Math.max(10, Math.min(28, Math.round(px)));
    this.term.options.fontSize = clamped;
    localStorage.setItem("unkernel-nvim.fontSize", String(clamped));
    this.fit();
  }

  getFontSize(): number {
    return this.term.options.fontSize ?? 15;
  }

  focus(): void {
    this.term.focus();
  }

  sendText(text: string): void {
    this.#pty?.write(this.#encoder.encode(text)).catch(() => {});
  }

  attachPty(pty: Pty): void {
    this.#pumpAbort?.abort();
    const abort = new AbortController();
    this.#pumpAbort = abort;
    this.#pty = pty;

    this.term.reset();
    this.fit();

    void this.#pumpOutput(pty, abort.signal);
  }

  async #pumpOutput(pty: Pty, signal: AbortSignal): Promise<void> {
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
          this.term.write(value, resolve);
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
