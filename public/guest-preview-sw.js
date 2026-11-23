// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Adapted from pithings/unkernel web/public/vm-sw.js at 4e58555.
"use strict";

const scope = new URL(self.registration.scope);
const bridge = new URL("../guest-preview.html", scope);
const shim = new URL("../guest-preview-ws.js", scope);
const routePattern = /^([a-f\d]{32})\/(\d{1,5})(\/.*)?$/;
const SNIFF_BYTES = 1024;
const bodyLimit = 16 * 1024 * 1024;
const nullBody = new Set([204, 205, 304]);
const drop = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection",
  "set-cookie", "set-cookie2", "clear-site-data", "service-worker-allowed",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "cache-control", "referrer-policy",
]);

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function route(url) {
  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)) {
    return routePattern.exec(url.pathname.slice(scope.pathname.length));
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin || url.pathname === shim.pathname) return;
  const match = route(url);
  if (match) {
    event.respondWith(match[3] === undefined && event.request.method === "GET"
      ? Response.redirect(new URL(`${url.pathname}/${url.search}`, url).href, 308)
      : relay(event, match[1], Number(match[2]), (match[3] ?? "/") + url.search));
    return;
  }
  if (event.clientId && event.request.mode !== "navigate") {
    event.respondWith((async () => {
      const client = await self.clients.get(event.clientId);
      const from = client && route(new URL(client.url));
      return from ? relay(event, from[1], Number(from[2]), url.pathname + url.search) : fetch(event.request);
    })());
  }
});

function previewHeaders() {
  return new Headers({
    "cache-control": "no-store",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  });
}

function text(status, message) {
  const headers = previewHeaders();
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(`${message}\n`, { status, headers });
}

async function readBody(request) {
  if (!request.body) return null;
  if (Number(request.headers.get("content-length")) > bodyLimit) throw new RangeError();
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > bodyLimit) throw new RangeError();
      chunks.push(value);
    }
    return new Blob(chunks).arrayBuffer();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
}

function relocate(value, prefix, port) {
  if (value.startsWith("/") && !value.startsWith("//")) return prefix + value;
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (local && url.protocol === "http:" && Number(url.port || 80) === port) {
    return prefix + url.pathname + url.search + url.hash;
  }
  return value;
}

async function relay(event, id, port, path) {
  if (port < 1 || port > 65535) return text(400, "端口必须在 1–65535 范围内");
  const gone = "预览已断开。请回到编辑器重新打开端口。";
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const owner = clients.find((client) => {
    const url = new URL(client.url);
    return url.origin === bridge.origin && url.pathname === bridge.pathname && url.searchParams.get("id") === id;
  });
  if (!owner) return text(502, gone);
  const req = event.request;
  let body;
  try {
    body = await readBody(req);
  } catch {
    return text(413, "预览请求正文超过 16 MiB 或无法读取");
  }

  const prefix = `${scope.pathname}${id}/${port}`;
  const { port1: input, port2: output } = new MessageChannel();
  const { promise: completed, resolve: finish } = Promise.withResolvers();
  event.waitUntil(completed);

  return new Promise((resolve) => {
    let stream;
    let wake;
    let answered = false;
    let timer = setTimeout(() => fail(502, gone), 8000);
    function end() {
      clearTimeout(timer);
      wake?.();
      wake = undefined;
      input.close();
      finish();
    }
    function cancel() {
      input.postMessage({ t: "cancel" });
      end();
    }
    function fail(status, message) {
      if (answered) stream?.error(new Error(message));
      else resolve(text(status, message));
      cancel();
    }

    input.onmessage = ({ data }) => {
      switch (data?.t) {
        case "accept":
          clearTimeout(timer);
          timer = setTimeout(() => fail(504, `Guest 端口 ${port} 等待响应超时`), 60_000);
          break;
        case "head": {
          const { status } = data;
          if (answered || !Number.isInteger(status) || status < 200 || status > 599) {
            fail(502, "Guest 返回了无效的 HTTP 状态");
            return;
          }
          clearTimeout(timer);
          const headers = previewHeaders();
          for (const [key, value] of data.headers) {
            if (drop.has(key)) continue;
            try { headers.append(key, key === "location" ? relocate(value, prefix, port) : value); } catch {}
          }
          let responseBody = null;
          if (req.method !== "HEAD" && !nullBody.has(status)) {
            responseBody = new ReadableStream({
              start(controller) { stream = controller; },
              pull() {
                input.postMessage({ t: "more" });
                return new Promise((resolve) => { wake = resolve; });
              },
              cancel,
            });
            if (req.mode === "navigate" && status >= 200 && status < 300 && status !== 206 &&
                !headers.has("content-encoding") && /^text\/html\b/i.test(headers.get("content-type") ?? "")) {
              const nonce = /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(headers.get("content-security-policy") ?? "")?.[1];
              const tag = `<script src="${shim.pathname}" data-kw-vm="${id}" data-kw-port="${port}"${nonce ? ` nonce="${nonce}"` : ""}></script>`;
              responseBody = responseBody.pipeThrough(shimInjector(tag));
              headers.delete("content-length");
            }
          }
          answered = true;
          resolve(new Response(responseBody, { status, headers }));
          if (!responseBody) cancel();
          break;
        }
        case "chunk":
          stream?.enqueue(new Uint8Array(data.data));
          wake?.();
          wake = undefined;
          break;
        case "end":
          stream?.close();
          end();
          break;
        case "error":
          fail(data.status || 502, data.message || gone);
          break;
      }
    };
    try {
      const transfer = body ? [output, body] : [output];
      owner.postMessage({ t: "guest-fetch", id, port, method: req.method, path, headers: [...req.headers], body }, transfer);
    } catch {
      fail(502, gone);
    }
  });
}

function shimOffset(b, end) {
  const s = String.fromCharCode(...b.subarray(0, Math.min(b.length, SNIFF_BYTES)));
  const bom = s.startsWith("\xEF\xBB\xBF") ? 3 : 0;
  const m = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(s.slice(bom));
  if (m) return bom + m[0].length;
  if (end || b.length >= SNIFF_BYTES) return bom;
  // Still on whitespace, a comment or a doctype not yet complete: wait.
  const rest = s.slice(bom).replace(/^(?:\s|<!--[\s\S]*?-->)*/, "");
  const open = rest.startsWith("<!--") || (rest.length < 9 ? "<!doctype".startsWith(rest.toLowerCase()) : /^<!doctype/i.test(rest));
  return open ? -1 : bom;
}

/** A body transform that inserts `tag` once, at shimOffset(). */
function shimInjector(tag) {
  const bytes = new TextEncoder().encode(tag);
  let head = new Uint8Array(0), done = false;
  const emit = (c, at) => {
    done = true;
    const out = new Uint8Array(head.length + bytes.length);
    out.set(head.subarray(0, at));
    out.set(bytes, at);
    out.set(head.subarray(at), at + bytes.length);
    head = null;
    c.enqueue(out);
  };
  return new TransformStream({
    transform(chunk, c) {
      if (done) { c.enqueue(chunk); return; }
      const all = new Uint8Array(head.length + chunk.length);
      all.set(head);
      all.set(chunk, head.length);
      head = all;
      const at = shimOffset(head, false);
      if (at >= 0) emit(c, at);
    },
    flush(c) { if (!done) emit(c, shimOffset(head, true)); },
  });
}
