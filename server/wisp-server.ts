// SPDX-License-Identifier: MIT
// Standalone authenticated Wisp v1 server (`bun run wisp`).
// Designed to run behind the app server gateway on an internal network or VPS,
// authenticated strictly via server-side `WISP_AUTH_TOKEN` (Authorization: Bearer).

import { formatProxyForLog, loadConfig, type ServerConfig } from "./config.ts";
import { getClientIp, IpRateLimiter, verifyBearerToken } from "./security.ts";
import { createWispEngine, createWispSocketData, type WispSocketData } from "./wisp-core.ts";

export interface StandaloneWispHandle {
  server: ReturnType<typeof Bun.serve<WispSocketData>>;
  port: number;
  stop: () => void;
}

export function startStandaloneWispServer(overrides: Partial<ServerConfig> = {}): StandaloneWispHandle {
  const config: ServerConfig = { ...loadConfig(), ...overrides };

  if (!config.wispAuthToken && !config.wispAllowUnauthenticated) {
    throw new Error(
      "Refusing to start standalone Wisp server without WISP_AUTH_TOKEN. " +
        "Set WISP_AUTH_TOKEN=<strong-secret> in the server environment " +
        "(or WISP_ALLOW_UNAUTHENTICATED=true for local-only testing).",
    );
  }

  const engine = createWispEngine(config, (m) => console.log(`[wisp-server] ${m}`));
  // Gateway typically connects from a small number of backend IPs, so scale IP limits generously
  const limiter = new IpRateLimiter(
    Math.max(config.maxConnectionsPerIp * 16, 64),
    Math.max(config.maxConnectsPerMinPerIp * 16, 300),
  );
  const startedAt = Date.now();

  const server = Bun.serve<WispSocketData>({
    hostname: config.host,
    port: config.wispPort,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          service: "unkernel-wisp",
          authenticated: Boolean(config.wispAuthToken),
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          activeSessions: engine.getActiveSessions(),
          activeStreams: engine.getActiveStreams(),
        });
      }

      if (url.pathname !== config.wispPath && url.pathname !== "/") {
        return new Response("Not Found", { status: 404 });
      }

      if (config.wispAuthToken) {
        const authHeader = req.headers.get("authorization");
        if (!verifyBearerToken(authHeader, config.wispAuthToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const socketIp = srv.requestIP(req)?.address;
      const clientIp = getClientIp(req, socketIp, config.trustProxy);
      const ticket = limiter.acquire(clientIp);
      if (!ticket.ok) {
        return new Response(`Too Many Requests (${ticket.reason})`, { status: 429 });
      }

      const upgraded = srv.upgrade(req, {
        data: createWispSocketData(clientIp, ticket.release),
      });
      if (!upgraded) {
        ticket.release();
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return undefined;
    },
    websocket: engine.handler,
  });

  const hostPolicy = config.allowedHosts.includes("*") ? "* (all public hosts)" : `${config.allowedHosts.length} host rules`;
  const portPolicy = config.allowedPorts === "*" ? "* (non-SMTP)" : config.allowedPorts.join(",");
  const proxyPolicy = config.outboundProxy ? `, proxy=${formatProxyForLog(config.outboundProxy)}` : "";
  console.log(
    `[wisp-server] listening on ws://${server.hostname}:${server.port}${config.wispPath} ` +
      `(auth=${config.wispAuthToken ? "bearer-token" : "DISABLED"}, hosts=${hostPolicy}, ports=${portPolicy}, privateIps=${config.allowPrivateIps}${proxyPolicy})`,
  );

  return {
    server,
    port: server.port ?? config.wispPort,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const handle = startStandaloneWispServer();
  const shutdown = () => {
    console.log("[wisp-server] shutting down...");
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
