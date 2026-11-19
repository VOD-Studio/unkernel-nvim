// SPDX-License-Identifier: MIT
// Vite configuration with COOP/COEP headers and an embedded Bun Wisp plugin
// so `bun run dev` and `bun run preview` expose the exact same `/wisp` endpoint
// and security model as the production Bun server (`server/index.ts`).

import type { ServerWebSocket } from "bun";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { defineConfig, type Connect, type Plugin } from "vite";
import { loadConfig } from "./server/config.ts";
import {
  buildSessionSetCookieHeader,
  getClientIp,
  hasValidSessionCookie,
  IpRateLimiter,
  isOriginAllowed,
} from "./server/security.ts";
import { createWispEngine, createWispSocketData, type WispSocketData } from "./server/wisp-core.ts";
import { createGatewaySocketData, createWispGateway, type GatewaySocketData } from "./server/wisp-gateway.ts";

type DevSocketData = WispSocketData | GatewaySocketData;

const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function attachDevWisp(
  middlewares: Connect.Server,
  httpServer: { on(ev: "upgrade", fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown; once(ev: "close", fn: () => void): unknown } | null,
): void {
  if (!httpServer) return;
  const config = loadConfig();
  const mode: "builtin" | "gateway" = config.wispUpstreamUrl ? "gateway" : "builtin";
  const wispEngine = mode === "builtin" ? createWispEngine(config, (m) => console.log(`[dev-wisp] ${m}`)) : null;
  const gatewayEngine = mode === "gateway" ? createWispGateway(config, (m) => console.log(`[dev-wisp-gw] ${m}`)) : null;
  const ipLimiter = new IpRateLimiter(config.maxConnectionsPerIp, config.maxConnectsPerMinPerIp);

  // Run the native Bun WebSocket Wisp server on an ephemeral loopback port and tunnel `/wisp` upgrades to it.
  const backend = Bun.serve<DevSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== config.wispPath) {
        return new Response("Not Found", { status: 404 });
      }
      if (!isOriginAllowed(req, config.allowedOrigins, config.trustProxy)) {
        return new Response("Forbidden: Origin not allowed", { status: 403 });
      }
      if (config.requireSession && !hasValidSessionCookie(req.headers.get("cookie"), config.sessionSecret)) {
        return new Response("Forbidden: Missing or expired session", { status: 403 });
      }
      const socketIp = srv.requestIP(req)?.address;
      const clientIp = getClientIp(req, socketIp, config.trustProxy);
      const ticket = ipLimiter.acquire(clientIp);
      if (!ticket.ok) {
        return new Response(`Too Many Requests: ${ticket.reason}`, { status: 429 });
      }
      const data: DevSocketData =
        mode === "gateway"
          ? createGatewaySocketData(clientIp, ticket.release)
          : createWispSocketData(clientIp, ticket.release);
      if (!srv.upgrade(req, { data })) {
        ticket.release();
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: config.maxWsPayloadBytes,
      idleTimeout: config.idleTimeoutSec,
      sendPings: true,
      perMessageDeflate: false,
      open(ws) {
        if (ws.data.kind === "gateway") gatewayEngine!.handler.open?.(ws as ServerWebSocket<GatewaySocketData>);
        else wispEngine!.handler.open?.(ws as ServerWebSocket<WispSocketData>);
      },
      message(ws, msg) {
        if (ws.data.kind === "gateway") gatewayEngine!.handler.message?.(ws as ServerWebSocket<GatewaySocketData>, msg);
        else wispEngine!.handler.message?.(ws as ServerWebSocket<WispSocketData>, msg);
      },
      drain(ws) {
        if (ws.data.kind === "wisp") wispEngine!.handler.drain?.(ws as ServerWebSocket<WispSocketData>);
      },
      close(ws, code, reason) {
        if (ws.data.kind === "gateway") gatewayEngine!.handler.close?.(ws as ServerWebSocket<GatewaySocketData>, code, reason);
        else wispEngine!.handler.close?.(ws as ServerWebSocket<WispSocketData>, code, reason);
      },
    },
  });

  // Issue the same frictionless HttpOnly session cookie on page load during dev/preview
  middlewares.use((req, res, next) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/" || pathname === "/index.html") {
      const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : null;
      if (!hasValidSessionCookie(cookieHeader, config.sessionSecret)) {
        const setCookie = buildSessionSetCookieHeader(config.sessionSecret, config.sessionTtlSeconds, false);
        const existing = res.getHeader("Set-Cookie");
        if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, setCookie]);
        else if (typeof existing === "string") res.setHeader("Set-Cookie", [existing, setCookie]);
        else res.setHeader("Set-Cookie", setCookie);
      }
    }
    next();
  });

  // Forward only `/wisp` WebSocket upgrades so Vite HMR (`vite-hmr`) remains completely untouched
  httpServer.on("upgrade", (req, clientSocket, head) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== config.wispPath) return;

    const targetPort = backend.port;
    if (!targetPort) {
      clientSocket.destroy();
      return;
    }

    const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
    upstream.setNoDelay(true);

    const cleanup = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };

    upstream.once("error", () => {
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      cleanup();
    });
    clientSocket.once("error", cleanup);
    clientSocket.once("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });

    upstream.once("connect", () => {
      let rawReq = `${req.method ?? "GET"} ${req.url ?? config.wispPath} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      rawReq += "\r\n";
      upstream.write(rawReq);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  httpServer.once("close", () => {
    backend.stop(true);
  });

  console.log(
    `[vite-wisp] mounted ${config.wispPath} -> ${
      mode === "gateway" ? `gateway(${config.wispUpstreamUrl})` : "builtin Bun Wisp engine"
    }`,
  );
}

function localWispPlugin(): Plugin {
  return {
    name: "unkernel-local-wisp",
    configureServer(server) {
      attachDevWisp(server.middlewares, server.httpServer);
    },
    configurePreviewServer(server) {
      attachDevWisp(server.middlewares, server.httpServer);
    },
  };
}

export default defineConfig({
  plugins: [localWispPlugin()],
  server: {
    port: 5173,
    headers: crossOriginHeaders,
  },
  preview: {
    port: 4173,
    headers: crossOriginHeaders,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@vod-studio/unkernel"],
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 1500,
  },
});
