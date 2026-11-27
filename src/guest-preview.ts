// SPDX-License-Identifier: MIT

import type { KernelHandle } from "unkernel";
import { GuestPreviewRelay, type PreviewMessage } from "./guest-preview-relay.ts";

const LAST_PORT = "unkernel-nvim.previewPort";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function previewBase(): Promise<URL> {
  if (!window.isSecureContext) throw new Error("端口预览需要 HTTPS 或本地回环地址");
  const app = new URL(".", location.href);
  let configured = import.meta.env.VITE_GUEST_PREVIEW_URL as string | undefined;
  if (!configured && !LOCAL_HOSTS.has(app.hostname) && !app.hostname.endsWith(".localhost")) {
    const response = await fetch(new URL("guest-preview-config.json", app), { cache: "no-store" });
    if (response.ok) configured = (await response.json() as { url?: string }).url;
  }
  if (!configured && (LOCAL_HOSTS.has(app.hostname) || app.hostname.endsWith(".localhost"))) {
    app.hostname = "unkernel-preview.localhost";
    return app;
  }
  if (!configured) throw new Error("请在应用服务端设置 GUEST_PREVIEW_URL，指向独立预览站点");
  const preview = new URL(configured);
  if (preview.hostname === app.hostname || (preview.protocol !== "https:" &&
      !(app.protocol === "http:" && preview.protocol === "http:" &&
        (LOCAL_HOSTS.has(preview.hostname) || preview.hostname.endsWith(".localhost"))))) {
    throw new Error("预览站点需要使用独立主机名和 HTTPS");
  }
  if (preview.username || preview.password || preview.search || preview.hash) {
    throw new Error("预览站点地址应为站点目录 URL，不含凭据、查询或片段");
  }
  if (!preview.pathname.endsWith("/")) preview.pathname += "/";
  return preview;
}

export interface GuestPreviewPaneOptions {
  root: HTMLElement;
  getVm: () => KernelHandle | null;
  showCloseButton?: boolean;
  showNewWindowButton?: boolean;
  initialPort?: number;
  initialPath?: string;
  onClose?: () => void;
  onNewWindow?: () => void;
  onTitleChange?: (title: string) => void;
}

/**
 * Self-contained Guest port preview toolbar + status bar + isolated iframe relay,
 * usable both in the fullscreen split-pane and inside floating desktop windows.
 */
export class GuestPreviewPane {
  readonly #form: HTMLFormElement;
  readonly #port: HTMLInputElement;
  readonly #path: HTMLInputElement;
  readonly #status: HTMLElement;
  readonly #frameArea: HTMLElement;
  readonly #getVm: () => KernelHandle | null;
  readonly #onTitleChange?: (title: string) => void;

  #connection: AbortController | null = null;
  #relay: GuestPreviewRelay | null = null;
  #activePort: number | null = null;
  #activePath = "/";

  constructor(opts: GuestPreviewPaneOptions) {
    this.#getVm = opts.getVm;
    this.#onTitleChange = opts.onTitleChange;

    const existingForm = opts.root.querySelector<HTMLFormElement>("form.guest-preview-toolbar");
    if (existingForm) {
      this.#form = existingForm;
      this.#port = existingForm.querySelector<HTMLInputElement>("#guest-preview-port")!;
      this.#path = existingForm.querySelector<HTMLInputElement>("#guest-preview-path")!;
      this.#status = opts.root.querySelector<HTMLElement>(".guest-preview-status")!;
      this.#frameArea = opts.root.querySelector<HTMLElement>(".guest-preview-frame-area")!;
      existingForm.querySelector("#btn-close-preview")?.addEventListener("click", () => {
        opts.onClose?.();
      });
    } else {
      opts.root.replaceChildren();
      this.#form = document.createElement("form");
      this.#form.className = "guest-preview-toolbar";

      const label = document.createElement("label");
      label.textContent = "端口";

      this.#port = document.createElement("input");
      this.#port.className = "text-input";
      this.#port.type = "number";
      this.#port.min = "1";
      this.#port.max = "65535";
      this.#port.step = "1";
      this.#port.inputMode = "numeric";
      this.#port.required = true;
      this.#port.setAttribute("aria-label", "端口");

      this.#path = document.createElement("input");
      this.#path.className = "text-input";
      this.#path.type = "text";
      this.#path.value = opts.initialPath || "/";
      this.#path.spellcheck = false;
      this.#path.setAttribute("aria-label", "路径");

      const loadBtn = document.createElement("button");
      loadBtn.className = "mini-btn active";
      loadBtn.type = "submit";
      loadBtn.textContent = "打开";

      this.#form.append(label, this.#port, this.#path, loadBtn);

      if (opts.showNewWindowButton) {
        const newBtn = document.createElement("button");
        newBtn.className = "mini-btn";
        newBtn.type = "button";
        newBtn.title = "新建预览窗口";
        newBtn.textContent = "+";
        newBtn.addEventListener("click", () => opts.onNewWindow?.());
        this.#form.appendChild(newBtn);
      }

      if (opts.showCloseButton) {
        const closeBtn = document.createElement("button");
        closeBtn.className = "mini-btn";
        closeBtn.type = "button";
        closeBtn.textContent = "关闭";
        closeBtn.addEventListener("click", () => opts.onClose?.());
        this.#form.appendChild(closeBtn);
      }

      this.#status = document.createElement("div");
      this.#status.className = "guest-preview-status";
      this.#status.setAttribute("role", "status");
      this.#status.textContent = "运行 guest Web 服务后，输入其端口。";

      this.#frameArea = document.createElement("div");
      this.#frameArea.className = "guest-preview-frame-area";

      opts.root.append(this.#form, this.#status, this.#frameArea);
    }

    const defaultPort = opts.initialPort !== undefined
      ? String(opts.initialPort)
      : localStorage.getItem(LAST_PORT) || "5173";
    this.#port.value = defaultPort;
    if (opts.initialPath) {
      this.#path.value = opts.initialPath;
    }

    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#navigate();
    });
  }

  get port(): number | null {
    return this.#activePort;
  }

  get path(): string {
    return this.#activePath;
  }

  get title(): string {
    return this.#activePort !== null ? `预览 :${this.#activePort}` : "Guest 端口预览";
  }

  focusPort(): void {
    this.#port.focus();
    this.#port.select();
  }

  openAt(port: number, path = "/"): void {
    this.#port.value = String(port);
    this.#path.value = path || "/";
    void this.#navigate();
  }

  reset(): void {
    this.#disconnect();
    this.#activePort = null;
    this.#activePath = "/";
    this.#status.textContent = "运行 guest Web 服务后，输入其端口。";
    this.#onTitleChange?.(this.title);
  }

  dispose(): void {
    this.#disconnect();
  }

  #disconnect(): void {
    this.#relay?.close();
    this.#relay = null;
    this.#connection?.abort();
    this.#connection = null;
    this.#frameArea.replaceChildren();
  }

  async #navigate(): Promise<void> {
    const vm = this.#getVm();
    if (!vm) {
      this.#status.textContent = "虚拟机已停止，请先恢复或启动虚拟机。";
      return;
    }
    const port = this.#port.valueAsNumber;
    const path = this.#path.value.trim() || "/";
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith("/") || path.startsWith("//")) {
      this.#status.textContent = "请输入 1–65535 的端口及以 / 开头的路径。";
      return;
    }
    this.#disconnect();
    this.#activePort = port;
    this.#activePath = path;
    this.#onTitleChange?.(this.title);
    this.#status.textContent = `正在连接 guest 端口 ${port}…`;
    this.#connection = new AbortController();
    const { signal } = this.#connection;
    const timer = setTimeout(() => {
      this.#status.textContent = "预览站点连接超时。请确认站点可访问且浏览器允许此站点使用 Service Worker。";
      this.#disconnect();
    }, 12_000);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const base = await previewBase();
      signal.throwIfAborted();
      const normalized = new URL(`http://localhost${path}`);
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const bridge = new URL("guest-preview.html", base);
      bridge.searchParams.set("id", id);
      bridge.searchParams.set("editor", location.origin);
      const frame = document.createElement("iframe");
      frame.title = `Guest 端口 ${port} 的网页预览`;
      frame.sandbox.add("allow-same-origin", "allow-scripts", "allow-forms");
      frame.referrerPolicy = "no-referrer";
      frame.src = bridge.href;
      frame.addEventListener("load", () => {
        const { port1, port2 } = new MessageChannel();
        const relay = new GuestPreviewRelay(vm, port, port1);
        this.#relay = relay;
        signal.addEventListener("abort", () => port1.close(), { once: true });
        port1.onmessage = (event: MessageEvent<PreviewMessage>) => {
          if (event.data?.t === "guest-loaded") {
            clearTimeout(timer);
            localStorage.setItem(LAST_PORT, String(port));
            this.#status.textContent = `Guest :${port}`;
          } else if (event.data?.t === "guest-error") {
            clearTimeout(timer);
            this.#status.textContent = event.data.message;
            this.#disconnect();
          } else relay.receive(event);
        };
        frame.contentWindow?.postMessage({ t: "guest-init", id, port, path: normalized.pathname + normalized.search + normalized.hash }, bridge.origin, [port2]);
      }, { once: true, signal });
      this.#frameArea.replaceChildren(frame);
      void vm.exited.then(() => {
        if (signal.aborted) return;
        this.#disconnect();
        this.#status.textContent = "虚拟机已停止。";
      });
    } catch (err) {
      if (!signal.aborted) {
        this.#status.textContent = err instanceof Error ? err.message : String(err);
        this.#disconnect();
      }
    }
  }
}

export class GuestPreview {
  readonly #panel = document.querySelector<HTMLElement>("#guest-preview")!;
  readonly #pane: GuestPreviewPane;
  readonly #focusTerminal: () => void;

  constructor(getVm: () => KernelHandle | null, focusTerminal: () => void) {
    this.#focusTerminal = focusTerminal;
    this.#pane = new GuestPreviewPane({
      root: this.#panel,
      getVm,
      onClose: () => {
        this.close();
        this.#focusTerminal();
      },
    });
  }

  get isOpen(): boolean {
    return !this.#panel.hidden;
  }

  get currentPort(): number | null {
    return this.#pane.port;
  }

  get currentPath(): string {
    return this.#pane.path;
  }

  open(): void {
    this.#panel.hidden = false;
    document.body.classList.add("preview-open");
    this.#pane.focusPort();
  }

  openAt(port: number, path = "/"): void {
    this.#panel.hidden = false;
    document.body.classList.add("preview-open");
    this.#pane.openAt(port, path);
  }

  close(): void {
    this.#pane.reset();
    this.#panel.hidden = true;
    document.body.classList.remove("preview-open");
  }
}
