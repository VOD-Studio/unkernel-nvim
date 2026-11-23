// SPDX-License-Identifier: MIT

import type { KernelHandle } from "unkernel";
import type { GuestWebSocket } from "./guest-websocket.ts";

const HTTP_CONCURRENCY = 16;
const HTTP_QUEUE_LIMIT = 256;
const SOCKET_LIMIT = 24;
const SOCKET_MESSAGE_LIMIT = 8 * 1024 * 1024;
const SOCKET_CREDITS = 16;
const REQUEST_HOP_HEADERS = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length",
  "accept-encoding", "proxy-connection", "cookie", "referer", "authorization",
]);
const encoder = new TextEncoder();

interface GuestFetch {
  t: "guest-fetch";
  port: number;
  path: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

type SocketRequest =
  | { t: "ws-open"; id: string; port: number; path: string; protocols: string[] }
  | { t: "ws-send"; id: string; data: string | ArrayBuffer }
  | { t: "ws-ack"; id: string }
  | { t: "ws-close"; id: string; code?: number; reason?: string };

interface SocketState {
  abort: AbortController;
  socket?: GuestWebSocket;
  credits: number;
  outgoing: number;
  wake?: () => void;
}

export type PreviewMessage = GuestFetch | SocketRequest |
  { t: "guest-loaded" } | { t: "guest-error"; message: string };

export class GuestPreviewRelay {
  readonly #abort = new AbortController();
  readonly #sockets = new Map<string, SocketState>();
  readonly #httpQueue: Array<() => void> = [];
  readonly #vm: KernelHandle;
  readonly #port: number;
  readonly #channel: MessagePort;
  #activeRequests = 0;

  constructor(vm: KernelHandle, port: number, channel: MessagePort) {
    this.#vm = vm;
    this.#port = port;
    this.#channel = channel;
  }

  close(): void {
    this.#abort.abort();
    for (const wake of this.#httpQueue.splice(0)) wake();
    for (const state of this.#sockets.values()) this.#closeSocket(state);
    this.#sockets.clear();
  }

  receive(event: MessageEvent<PreviewMessage>): void {
    const data = event.data;
    if (this.#abort.signal.aborted || !data) return;
    if (data.t === "guest-fetch" && event.ports[0]) {
      void this.#serveHttp(data, event.ports[0]);
      return;
    }
    if ("id" in data && typeof data.id === "string") this.#handleSocket(data);
  }

  async #serveHttp(request: GuestFetch, channel: MessagePort): Promise<void> {
    const abort = new AbortController();
    const signal = AbortSignal.any([this.#abort.signal, abort.signal]);
    let acquired = false;
    let credits = 2;
    let wake: (() => void) | undefined;
    const unblock = () => { wake?.(); wake = undefined; };
    signal.addEventListener("abort", unblock, { once: true });
    channel.onmessage = ({ data }) => {
      if (data?.t === "cancel") abort.abort();
      if (data?.t === "more") credits++;
      unblock();
    };
    try {
      if (request.port !== this.#port || typeof request.path !== "string" || !request.path.startsWith("/")) {
        channel.postMessage({ t: "error", status: 400, message: "请求超出当前 guest 预览端口" });
        return;
      }
      if (this.#httpQueue.length >= HTTP_QUEUE_LIMIT) {
        channel.postMessage({ t: "error", status: 503, message: "预览请求过多，请稍后重试" });
        return;
      }
      channel.postMessage({ t: "accept" });
      if (this.#activeRequests < HTTP_CONCURRENCY) this.#activeRequests++;
      else await new Promise<void>((resolve) => this.#httpQueue.push(resolve));
      acquired = true;
      signal.throwIfAborted();
      const origin = `http://localhost:${this.#port}`;
      const headers = new Headers(request.headers);
      for (const name of REQUEST_HOP_HEADERS) headers.delete(name);
      for (const name of [...headers.keys()]) {
        if (name.startsWith("sec-fetch-")) headers.delete(name);
      }
      headers.set("accept-encoding", "identity");
      if (headers.has("origin")) headers.set("origin", origin);
      const res = await this.#vm.fetch(origin + request.path, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal,
      });
      channel.postMessage({ t: "head", status: res.status, headers: [...res.headers] });
      const reader = res.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            while (credits <= 0 && !signal.aborted) await new Promise<void>((resolve) => { wake = resolve; });
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            const chunk = new Uint8Array(value);
            credits--;
            channel.postMessage({ t: "chunk", data: chunk.buffer }, [chunk.buffer]);
          }
        } finally {
          if (signal.aborted) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      channel.postMessage({ t: "end" });
    } catch (err) {
      if (!abort.signal.aborted) {
        const detail = err instanceof Error ? err.message : String(err);
        channel.postMessage({ t: "error", status: 502, message: `Guest 端口 ${this.#port} 请求失败。请确认服务已启动。\n${detail}` });
      }
    } finally {
      if (acquired) {
        const next = this.#httpQueue.shift();
        if (next) next();
        else this.#activeRequests--;
      }
      signal.removeEventListener("abort", unblock);
      channel.close();
    }
  }

  #handleSocket(data: SocketRequest): void {
    const state = this.#sockets.get(data.id);
    if (data.t === "ws-open") {
      if (!state) void this.#openSocket(data);
      return;
    }
    if (!state) return;
    if (data.t === "ws-ack") {
      state.credits = Math.min(SOCKET_CREDITS, state.credits + 1);
      state.wake?.();
      return;
    }
    if (data.t === "ws-close") {
      this.#closeSocket(state, data.code, data.reason);
      return;
    }
    const socket = state.socket;
    if (!socket || (typeof data.data !== "string" && !(data.data instanceof ArrayBuffer))) return;
    const bytes = typeof data.data === "string" ? encoder.encode(data.data).length : data.data.byteLength;
    if (bytes + state.outgoing > SOCKET_MESSAGE_LIMIT) {
      socket.close(4009, "Preview send buffer full");
      return;
    }
    state.outgoing += bytes;
    void socket.send(typeof data.data === "string" ? data.data : new Uint8Array(data.data)).then(() => {
      this.#channel.postMessage({ t: "ws-sent", id: data.id, n: bytes });
    }).catch(() => socket.close()).finally(() => { state.outgoing -= bytes; });
  }

  #closeSocket(state: SocketState, code?: number, reason?: string): void {
    state.abort.abort();
    state.wake?.();
    try { state.socket?.close(code, reason); } catch { state.socket?.close(); }
  }

  async #openSocket(data: Extract<SocketRequest, { t: "ws-open" }>): Promise<void> {
    const { id } = data;
    const fail = (message: string) => this.#channel.postMessage({ t: "ws-error", id, message });
    if (data.port !== this.#port || typeof data.path !== "string" || !data.path.startsWith("/") ||
        this.#sockets.size >= SOCKET_LIMIT) {
      fail("该连接超出当前预览的端口或连接数限制");
      return;
    }
    const state: SocketState = { abort: new AbortController(), credits: SOCKET_CREDITS, outgoing: 0 };
    this.#sockets.set(id, state);
    this.#channel.postMessage({ t: "ws-accept", id });
    try {
      const { websocketOver } = await import("./guest-websocket.ts");
      const signal = AbortSignal.any([this.#abort.signal, state.abort.signal, AbortSignal.timeout(30_000)]);
      const socket = await websocketOver(this.#vm.connect.bind(this.#vm), `ws://localhost:${this.#port}${data.path}`, {
        protocols: Array.isArray(data.protocols) ? data.protocols : [],
        headers: { origin: `http://localhost:${this.#port}` },
        signal,
        maxMessage: SOCKET_MESSAGE_LIMIT,
      });
      state.socket = socket;
      if (state.abort.signal.aborted || this.#abort.signal.aborted) socket.close();
      else this.#channel.postMessage({ t: "ws-opened", id, protocol: socket.protocol });
      const reader = socket.messages.getReader();
      try {
        for (;;) {
          while (state.credits <= 0 && !state.abort.signal.aborted) {
            await new Promise<void>((resolve) => { state.wake = resolve; });
            state.wake = undefined;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (state.abort.signal.aborted) continue;
          state.credits--;
          if (typeof value === "string") this.#channel.postMessage({ t: "ws-msg", id, data: value });
          else {
            const copy = new Uint8Array(value);
            this.#channel.postMessage({ t: "ws-msg", id, data: copy.buffer }, [copy.buffer]);
          }
        }
      } finally {
        reader.releaseLock();
      }
      this.#channel.postMessage({ t: "ws-closed", id, ...await socket.closed });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      state.socket?.close();
      this.#sockets.delete(id);
    }
  }
}
