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

export class GuestPreview {
  readonly #panel = document.querySelector<HTMLElement>("#guest-preview")!;
  readonly #form = this.#panel.querySelector<HTMLFormElement>("form")!;
  readonly #port = this.#form.querySelector<HTMLInputElement>("#guest-preview-port")!;
  readonly #path = this.#form.querySelector<HTMLInputElement>("#guest-preview-path")!;
  readonly #status = this.#panel.querySelector<HTMLElement>("#guest-preview-status")!;
  readonly #frameArea = this.#panel.querySelector<HTMLElement>("#guest-preview-frame-area")!;
  readonly #getVm: () => KernelHandle | null;
  readonly #focusTerminal: () => void;
  #connection: AbortController | null = null;
  #relay: GuestPreviewRelay | null = null;

  constructor(getVm: () => KernelHandle | null, focusTerminal: () => void) {
    this.#getVm = getVm;
    this.#focusTerminal = focusTerminal;
    this.#port.value = localStorage.getItem(LAST_PORT) || "5173";
    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#navigate();
    });
    this.#panel.querySelector("#btn-close-preview")!.addEventListener("click", () => {
      this.close();
      this.#focusTerminal();
    });
  }

  open(): void {
    this.#panel.hidden = false;
    document.body.classList.add("preview-open");
    this.#port.focus();
    this.#port.select();
  }

  openAt(port: number, path = "/"): void {
    this.#port.value = String(port);
    this.#path.value = path || "/";
    this.#panel.hidden = false;
    document.body.classList.add("preview-open");
    void this.#navigate();
  }

  close(): void {
    this.#disconnect();
    this.#panel.hidden = true;
    this.#status.textContent = "运行 guest Web 服务后，输入其端口。";
    document.body.classList.remove("preview-open");
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
