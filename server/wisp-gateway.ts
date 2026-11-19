// SPDX-License-Identifier: MIT
// Authenticated Wisp Gateway handler:
// Bridges browser WebSocket traffic -> upstream private Wisp server while
// attaching `Authorization: Bearer <WISP_AUTH_TOKEN>` strictly on the server side.

import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ServerConfig } from "./config.ts";

const MAX_PENDING_UPSTREAM_BYTES = 1024 * 1024; // 1 MiB queue while upstream handshake opens

export interface GatewaySocketData {
  kind: "gateway";
  clientIp: string;
  releaseIp: () => void;
  upstream: WebSocket | null;
  pending: Uint8Array<ArrayBuffer>[];
  pendingBytes: number;
  closed: boolean;
}

export interface WispGatewayEngine {
  handler: WebSocketHandler<GatewaySocketData>;
  getActiveSessions(): number;
}

export function createWispGateway(
  config: ServerConfig,
  log: (msg: string) => void = (m) => console.log(`[wisp-gateway] ${m}`),
): WispGatewayEngine {
  let activeSessions = 0;

  function teardown(ws: ServerWebSocket<GatewaySocketData>, closeClient: boolean, code = 1000, reason = ""): void {
    if (ws.data.closed) return;
    ws.data.closed = true;
    activeSessions = Math.max(0, activeSessions - 1);
    ws.data.pending.length = 0;
    ws.data.pendingBytes = 0;

    const up = ws.data.upstream;
    ws.data.upstream = null;
    if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) {
      try {
        up.close(1000);
      } catch {}
    }

    if (closeClient) {
      try {
        ws.close(code, reason);
      } catch {}
    }
    ws.data.releaseIp();
  }

  const handler: WebSocketHandler<GatewaySocketData> = {
    maxPayloadLength: config.maxWsPayloadBytes,
    idleTimeout: config.idleTimeoutSec,
    sendPings: true,
    perMessageDeflate: false,

    open(ws) {
      activeSessions++;
      const headers: Record<string, string> = {};
      if (config.wispAuthToken) {
        headers["Authorization"] = `Bearer ${config.wispAuthToken}`;
      }

      let upstream: WebSocket;
      try {
        // Bun's WebSocket constructor accepts `{ headers }` as its second argument
        upstream = new WebSocket(
          config.wispUpstreamUrl,
          Object.keys(headers).length > 0 ? ({ headers } as unknown as string[]) : undefined,
        );
      } catch (err) {
        log(`failed to dial upstream ${config.wispUpstreamUrl}: ${(err as Error)?.message ?? String(err)}`);
        teardown(ws, true, 1011, "upstream unavailable");
        return;
      }

      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;

      upstream.onopen = () => {
        if (ws.data.closed) {
          upstream.close();
          return;
        }
        if (ws.data.pending.length > 0) {
          const batch = ws.data.pending.splice(0);
          ws.data.pendingBytes = 0;
          for (const pkt of batch) {
            upstream.send(pkt);
          }
        }
      };

      upstream.onmessage = (event) => {
        if (ws.data.closed) return;
        if (event.data instanceof ArrayBuffer) {
          ws.sendBinary(new Uint8Array(event.data));
        } else if (ArrayBuffer.isView(event.data)) {
          ws.sendBinary(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        }
      };

      upstream.onerror = () => {
        log(`upstream error (client=${ws.data.clientIp})`);
        teardown(ws, true, 1011, "upstream error");
      };

      upstream.onclose = (ev) => {
        teardown(ws, true, ev.code === 1000 ? 1000 : 1011, ev.reason || "upstream closed");
      };
    },

    message(ws, message) {
      if (ws.data.closed || typeof message === "string") return;
      const view =
        message instanceof Uint8Array ? message : new Uint8Array(message as ArrayBufferLike);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      const up = ws.data.upstream;
      if (!up) return;

      if (up.readyState === WebSocket.OPEN) {
        up.send(copy);
      } else if (up.readyState === WebSocket.CONNECTING) {
        if (ws.data.pendingBytes + copy.byteLength > MAX_PENDING_UPSTREAM_BYTES) {
          teardown(ws, true, 1009, "buffer overflow");
          return;
        }
        ws.data.pending.push(copy);
        ws.data.pendingBytes += copy.byteLength;
      }
    },

    close(ws) {
      teardown(ws, false);
    },
  };

  return {
    handler,
    getActiveSessions: () => activeSessions,
  };
}

export function createGatewaySocketData(clientIp: string, releaseIp: () => void): GatewaySocketData {
  return {
    kind: "gateway",
    clientIp,
    releaseIp,
    upstream: null,
    pending: [],
    pendingBytes: 0,
    closed: false,
  };
}
