// SPDX-License-Identifier: MIT
// Unified production Bun server (`bun run start`):
// - Serves built `dist/` static assets with COOP/COEP headers for SharedArrayBuffer
// - Issues frictionless short-lived HttpOnly HMAC session cookies (no login required)
// - Exposes `/wisp` WebSocket endpoint in either:
//     1) Gateway mode (WISP_UPSTREAM_URL set): authenticates to private Wisp with WISP_AUTH_TOKEN
//     2) Built-in mode (default): runs Wisp v1 engine directly in-process

import type { ServerWebSocket } from "bun";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatProxyForLog, loadConfig, type ServerConfig } from "./config.ts";
import { configuredGuestPreviewUrl, guestPreviewFile, isGuestPreviewHost } from "./guest-preview-config.ts";
import {
  buildSessionSetCookieHeader,
  getClientIp,
  hasValidSessionCookie,
  IpRateLimiter,
  isHttpsRequest,
  isOriginAllowed,
} from "./security.ts";
import { createWispEngine, createWispSocketData, type WispSocketData } from "./wisp-core.ts";
import { createGatewaySocketData, createWispGateway, type GatewaySocketData } from "./wisp-gateway.ts";

type AppSocketData = WispSocketData | GatewaySocketData;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIST_DIR = path.join(ROOT_DIR, "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".gz": "application/gzip",
  ".erofs": "application/octet-stream",
  ".kwsparse": "application/octet-stream",
};

function parseByteRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(.+)$/i.exec(header.trim());
  if (!m) return null;
  const spec = m[1]!.trim();
  if (spec.includes(",")) return null;
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;
  const [, startStr, endStr] = parts;
  if (!startStr && !endStr) return null;
  if (size <= 0) return "invalid";
  if (!startStr) {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startStr);
  const end = endStr ? Math.min(Number(endStr), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return "invalid";
  }
  return { start, end };
}

function baseSecurityHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  };
}

function safeResolveAsset(distDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = path.resolve(distDir, rel);
  if (full !== distDir && !full.startsWith(`${distDir}${path.sep}`)) {
    return null;
  }
  if (!existsSync(full)) return null;
  const st = statSync(full);
  if (!st.isFile()) return null;
  return full;
}

export interface AppServerHandle {
  server: ReturnType<typeof Bun.serve<AppSocketData>>;
  port: number;
  mode: "builtin" | "gateway";
  stop: () => void;
}

export function startAppServer(opts: { config?: Partial<ServerConfig>; distDir?: string } = {}): AppServerHandle {
  const config: ServerConfig = { ...loadConfig(), ...(opts.config ?? {}) };
  const distDir = path.resolve(opts.distDir ?? DEFAULT_DIST_DIR);

  if (!existsSync(path.join(distDir, "index.html"))) {
    throw new Error(`Missing built frontend at ${distDir}/index.html. Run \`bun run build\` first.`);
  }

  const mode: "builtin" | "gateway" = config.wispUpstreamUrl ? "gateway" : "builtin";
  const wispEngine = mode === "builtin" ? createWispEngine(config) : null;
  const gatewayEngine = mode === "gateway" ? createWispGateway(config) : null;
  const ipLimiter = new IpRateLimiter(config.maxConnectionsPerIp, config.maxConnectsPerMinPerIp);
  const startedAt = Date.now();

  const server = Bun.serve<AppSocketData>({
    hostname: config.host,
    port: config.port,

    fetch(req, srv) {
      const url = new URL(req.url);
      const previewAsset = guestPreviewFile(url.pathname);
      if (isGuestPreviewHost(url.hostname) !== (previewAsset !== undefined)) {
        return new Response("Not Found", { status: 404, headers: baseSecurityHeaders() });
      }

      if (url.pathname === "/guest-preview-config.json") {
        return Response.json({ url: configuredGuestPreviewUrl()?.href ?? "" }, {
          headers: { ...baseSecurityHeaders(), "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json(
          {
            ok: true,
            mode,
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            activeSessions: mode === "gateway" ? gatewayEngine!.getActiveSessions() : wispEngine!.getActiveSessions(),
            activeStreams: mode === "builtin" ? wispEngine!.getActiveStreams() : undefined,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      if (url.pathname === config.wispPath) {
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

        const data: AppSocketData =
          mode === "gateway"
            ? createGatewaySocketData(clientIp, ticket.release)
            : createWispSocketData(clientIp, ticket.release);

        const upgraded = srv.upgrade(req, { data });
        if (!upgraded) {
          ticket.release();
          return new Response("Expected WebSocket upgrade", { status: 426 });
        }
        return undefined;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const filePath = safeResolveAsset(distDir, url.pathname);
      if (!filePath) {
        return new Response("Not Found", { status: 404, headers: baseSecurityHeaders() });
      }

      const st = statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

      const headers = new Headers(baseSecurityHeaders());
      if (previewAsset === "guest-preview.html") {
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      }
      headers.set("Content-Type", contentType);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Length", String(st.size));
      headers.set("ETag", etag);

      const isIndex = url.pathname === "/" || url.pathname === "/index.html";
      if (previewAsset) {
        headers.set("Cache-Control", "no-cache");
      } else if (isIndex) {
        headers.set("Cache-Control", "no-cache");
        // Issue frictionless short-lived HttpOnly session cookie (no login prompt)
        if (!hasValidSessionCookie(req.headers.get("cookie"), config.sessionSecret)) {
          const secure = isHttpsRequest(req, config.trustProxy);
          headers.append("Set-Cookie", buildSessionSetCookieHeader(config.sessionSecret, config.sessionTtlSeconds, secure));
        }
      } else if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/releases/")) {
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        headers.set("Cache-Control", "public, max-age=3600");
      }

      if (req.headers.get("if-none-match") === etag && !headers.has("Set-Cookie")) {
        return new Response(null, { status: 304, headers });
      }

      if (req.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }

      const rangeHeader = req.headers.get("range");
      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, st.size);
        if (range === "invalid") {
          headers.set("Content-Range", `bytes */${st.size}`);
          headers.delete("Content-Length");
          return new Response(null, { status: 416, headers });
        }
        if (range) {
          headers.set("Content-Range", `bytes ${range.start}-${range.end}/${st.size}`);
          headers.set("Content-Length", String(range.end - range.start + 1));
          return new Response(Bun.file(filePath).slice(range.start, range.end + 1), { status: 206, headers });
        }
      }

      return new Response(Bun.file(filePath), { status: 200, headers });
    },

    websocket: {
      maxPayloadLength: config.maxWsPayloadBytes,
      idleTimeout: config.idleTimeoutSec,
      sendPings: true,
      perMessageDeflate: false,

      open(ws) {
        if (ws.data.kind === "gateway") {
          gatewayEngine!.handler.open?.(ws as ServerWebSocket<GatewaySocketData>);
        } else {
          wispEngine!.handler.open?.(ws as ServerWebSocket<WispSocketData>);
        }
      },
      message(ws, msg) {
        if (ws.data.kind === "gateway") {
          gatewayEngine!.handler.message?.(ws as ServerWebSocket<GatewaySocketData>, msg);
        } else {
          wispEngine!.handler.message?.(ws as ServerWebSocket<WispSocketData>, msg);
        }
      },
      drain(ws) {
        if (ws.data.kind === "wisp") {
          wispEngine!.handler.drain?.(ws as ServerWebSocket<WispSocketData>);
        }
      },
      close(ws, code, reason) {
        if (ws.data.kind === "gateway") {
          gatewayEngine!.handler.close?.(ws as ServerWebSocket<GatewaySocketData>, code, reason);
        } else {
          wispEngine!.handler.close?.(ws as ServerWebSocket<WispSocketData>, code, reason);
        }
      },
    },
  });

  const proxySummary = config.outboundProxy ? `, proxy=${formatProxyForLog(config.outboundProxy)}` : "";
  const wispSummary =
    mode === "gateway"
      ? `gateway -> ${config.wispUpstreamUrl} (auth=${config.wispAuthToken ? "bearer-token" : "none"})`
      : `builtin (hosts=${config.allowedHosts.includes("*") ? "*" : config.allowedHosts.length}, ports=${config.allowedPorts === "*" ? "*" : config.allowedPorts.join(",")}, privateIps=${config.allowPrivateIps}${proxySummary})`;

  console.log(
    `[server] unkernel-nvim listening on http://${server.hostname}:${server.port} ` +
      `| wisp=${config.wispPath} [${wispSummary}] | sessionCookie=${config.requireSession}`,
  );

  return {
    server,
    port: server.port ?? config.port,
    mode,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const handle = startAppServer();
  const shutdown = () => {
    console.log("[server] shutting down...");
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
