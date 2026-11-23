// SPDX-License-Identifier: MIT
// Runs in the preview origin. The editor supplies one MessagePort for this guest port.
"use strict";

const params = new URL(location.href).searchParams;
const id = params.get("id");
const editorOrigin = params.get("editor");
const workerUrl = new URL("guest-preview-sw.js", location.href);
const scope = new URL("__guest/", location.href);

window.addEventListener("message", function connect(event) {
  const { data } = event;
  const channel = event.ports[0];
  if (parent === window || event.source !== parent || event.origin !== editorOrigin ||
      !channel || data?.t !== "guest-init" || data.id !== id || !/^[a-f\d]{32}$/.test(id ?? "")) return;
  window.removeEventListener("message", connect);
  void start(channel, data.port, data.path).catch((error) => {
    channel.postMessage({ t: "guest-error", message: error instanceof Error ? error.message : String(error) });
  });
});

async function start(channel, port, path) {
  if (!navigator.serviceWorker) throw new Error("此浏览器无法在预览来源使用 Service Worker");
  const sockets = new BroadcastChannel(`kw-vm-${id}`);
  const socketIds = new Set();
  const lock = new AbortController();
  const lifetime = new Promise((resolve) => addEventListener("pagehide", resolve, { once: true }));
  const listen = (event) => {
    if (event.source?.scriptURL !== workerUrl.href || event.data?.t !== "guest-fetch" ||
        event.data.id !== id || event.data.port !== port || !event.ports[0]) return;
    channel.postMessage(event.data, event.ports);
  };
  navigator.serviceWorker.addEventListener("message", listen);
  navigator.serviceWorker.startMessages();
  void lifetime.then(() => {
    lock.abort();
    navigator.serviceWorker.removeEventListener("message", listen);
    sockets.close();
  });

  // The document's sockets use this lock to detect that the parent bridge is gone.
  if (navigator.locks) {
    await new Promise((resolve, reject) => {
      void navigator.locks.request(`kw-vm-${id}`, { signal: lock.signal }, () => {
        resolve();
        return lifetime;
      }).catch(reject);
    });
  }
  channel.onmessage = (event) => {
    if (event.data?.t?.startsWith("ws-")) {
      if (event.data.t === "ws-closed" || event.data.t === "ws-error") socketIds.delete(event.data.id);
      sockets.postMessage(event.data);
    }
  };
  sockets.onmessage = ({ data }) => {
    if (!data || typeof data.id !== "string" || !/^[a-f\d-]{32,36}$/.test(data.id)) return;
    if (data.t === "ws-open") {
      if (data.port !== port || socketIds.size >= 24) {
        sockets.postMessage({ t: "ws-error", id: data.id, message: "该连接超出当前预览的端口或连接数限制" });
        return;
      }
      if (socketIds.has(data.id)) return;
      socketIds.add(data.id);
      void navigator.locks?.request(`kw-ws-${data.id}`, { signal: lock.signal }, () => {
        if (socketIds.delete(data.id)) channel.postMessage({ t: "ws-close", id: data.id });
      }).catch(() => {});
    } else if (!socketIds.has(data.id) || !["ws-send", "ws-ack", "ws-close"].includes(data.t)) return;
    channel.postMessage(data);
  };

  const registration = await navigator.serviceWorker.register(workerUrl, { scope: scope.href, updateViaCache: "none" });
  if (registration.active?.state !== "activated") {
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker) throw new Error("无法启动预览 Service Worker");
    await new Promise((resolve, reject) => {
      function check() {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(new Error("预览 Service Worker 安装失败"));
      }
      worker.addEventListener("statechange", check);
      check();
    });
  }

  const frame = document.createElement("iframe");
  frame.title = `Guest :${port}`;
  frame.referrerPolicy = "no-referrer";
  frame.src = new URL(`${id}/${port}${path}`, scope).href;
  frame.addEventListener("load", () => channel.postMessage({ t: "guest-loaded" }));
  document.body.replaceChildren(frame);
}
