// SPDX-License-Identifier: MIT
// Native Bun Wisp v1 protocol server engine (TCP subset used by unkernel).
// Implements 0-RTT pipelined DATA buffering, bidirectional backpressure,
// CONTINUE credit replenishment, SSRF/DNS-rebinding protection, host/port
// allowlists, and optional outbound HTTP CONNECT proxy tunneling.

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { createConnection, type Socket } from "node:net";
import type { ServerConfig } from "./config.ts";
import { isHostAllowed, isPortAllowed, resolveAndValidateHost, shouldBypassProxy } from "./security.ts";

// Wisp v1 packet types
export const WISP_PKT_CONNECT = 1;
export const WISP_PKT_DATA = 2;
export const WISP_PKT_CONTINUE = 3;
export const WISP_PKT_CLOSE = 4;

// Wisp v1 stream types
const WISP_STREAM_TCP = 1;

// Wisp v1 close reasons (matches unkernel CLOSE_REASONS)
export const WISP_CLOSE_UNSPECIFIED = 0x01;
export const WISP_CLOSE_VOLUNTARY = 0x02;
export const WISP_CLOSE_NETWORK_ERROR = 0x03;
export const WISP_CLOSE_INVALID_INFO = 0x41; // 65
export const WISP_CLOSE_HOST_UNREACHABLE = 0x42; // 66
export const WISP_CLOSE_CONNECT_TIMEOUT = 0x43; // 67
export const WISP_CLOSE_CONN_REFUSED = 0x44; // 68
export const WISP_CLOSE_TRANSFER_TIMEOUT = 0x47; // 71
export const WISP_CLOSE_BLOCKED = 0x48; // 72
export const WISP_CLOSE_THROTTLED = 0x49; // 73

const MAX_PENDING_WRITE_BYTES = 1024 * 1024; // 1 MiB cap per stream before TCP connects
const MAX_DOWNSTREAM_CHUNK = 32_768; // 32 KiB per Wisp DATA frame
const WS_BACKPRESSURE_HIGH_WATER = 2 * 1024 * 1024; // 2 MiB WebSocket send queue threshold

const textDecoder = new TextDecoder();

export function encodeContinuePacket(streamId: number, bufferRemaining: number): Uint8Array {
  const buf = new Uint8Array(9);
  const dv = new DataView(buf.buffer);
  buf[0] = WISP_PKT_CONTINUE;
  dv.setUint32(1, streamId, true);
  dv.setUint32(5, bufferRemaining, true);
  return buf;
}

export function encodeDataPacket(streamId: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(5 + payload.byteLength);
  buf[0] = WISP_PKT_DATA;
  new DataView(buf.buffer).setUint32(1, streamId, true);
  buf.set(payload, 5);
  return buf;
}

export function encodeClosePacket(streamId: number, reason: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = WISP_PKT_CLOSE;
  new DataView(buf.buffer).setUint32(1, streamId, true);
  buf[5] = reason & 0xff;
  return buf;
}

interface TcpStreamState {
  id: number;
  host: string;
  port: number;
  socket: Socket | null;
  connected: boolean;
  closed: boolean;
  pausedByWs: boolean;
  waitingTcpDrain: boolean;
  remainingCredit: number;
  pendingWrites: Uint8Array[];
  pendingWriteBytes: number;
  connectTimer: ReturnType<typeof setTimeout> | null;
}

export interface WispSocketData {
  kind: "wisp";
  clientIp: string;
  releaseIp: () => void;
  streams: Map<number, TcpStreamState>;
  pausedStreams: Set<TcpStreamState>;
  wsClosed: boolean;
}

export interface WispEngine {
  handler: WebSocketHandler<WispSocketData>;
  getActiveStreams(): number;
  getActiveSessions(): number;
}

function mapErrnoToCloseReason(err: NodeJS.ErrnoException): number {
  switch (err.code) {
    case "ECONNREFUSED":
      return WISP_CLOSE_CONN_REFUSED;
    case "ETIMEDOUT":
      return WISP_CLOSE_CONNECT_TIMEOUT;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_NONAME":
      return WISP_CLOSE_HOST_UNREACHABLE;
    default:
      return WISP_CLOSE_NETWORK_ERROR;
  }
}

/**
 * Open a TCP tunnel through an HTTP CONNECT proxy (e.g. http://127.0.0.1:7890).
 * Returns the connected socket plus any trailing bytes received right after the HTTP 200 header.
 */
function connectViaHttpProxy(
  proxyUrlStr: string,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<{ socket: Socket; leftover: Uint8Array | null }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(proxyUrlStr);
    } catch {
      reject(Object.assign(new Error("Invalid outbound proxy URL"), { code: "EHOSTUNREACH" }));
      return;
    }

    const proxyHost = parsed.hostname.replace(/^\[|\]$/g, "");
    const proxyPort = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
    const socket = createConnection({ host: proxyHost, port: proxyPort });
    socket.setNoDelay(true);

    let settled = false;
    let headerBuf: Buffer = Buffer.alloc(0);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(Object.assign(new Error("Proxy CONNECT timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);

    const cleanTargetHost = targetHost.replace(/^\[|\]$/g, "");
    const authority = cleanTargetHost.includes(":") ? `[${cleanTargetHost}]:${targetPort}` : `${cleanTargetHost}:${targetPort}`;
    const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: Keep-Alive"];
    if (parsed.username || parsed.password) {
      const cred = Buffer.from(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
      ).toString("base64");
      headers.push(`Proxy-Authorization: Basic ${cred}`);
    }
    const reqPayload = `${headers.join("\r\n")}\r\n\r\n`;

    const onData = (chunk: Buffer) => {
      headerBuf = headerBuf.length === 0 ? chunk : Buffer.concat([headerBuf, chunk]);
      if (headerBuf.length > 16_384) {
        fail(Object.assign(new Error("Proxy response header too large"), { code: "ECONNREFUSED" }));
        return;
      }
      const sepIdx = headerBuf.indexOf("\r\n\r\n");
      if (sepIdx === -1) return;

      const headText = headerBuf.subarray(0, sepIdx).toString("ascii");
      const statusLine = headText.split("\r\n")[0] ?? "";
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine);
      const statusCode = statusMatch?.[1] ? Number.parseInt(statusMatch[1], 10) : 0;

      if (statusCode !== 200) {
        fail(Object.assign(new Error(`Proxy rejected CONNECT (${statusLine})`), { code: "ECONNREFUSED" }));
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);

      const rest = headerBuf.subarray(sepIdx + 4);
      resolve({
        socket,
        leftover: rest.length > 0 ? new Uint8Array(rest.buffer, rest.byteOffset, rest.byteLength) : null,
      });
    };

    const onError = (err: Error) => fail(err);
    const onClose = () => fail(Object.assign(new Error("Proxy closed before CONNECT completed"), { code: "ECONNREFUSED" }));

    socket.once("connect", () => {
      socket.write(reqPayload);
    });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

export function createWispEngine(
  config: ServerConfig,
  log: (msg: string) => void = (m) => console.log(`[wisp] ${m}`),
): WispEngine {
  let totalStreams = 0;
  let totalSessions = 0;

  const creditReplenishThreshold = Math.max(1, Math.floor(config.initialBufferPackets / 2));

  function sendPacket(ws: ServerWebSocket<WispSocketData>, packet: Uint8Array): number {
    if (ws.data.wsClosed) return 0;
    try {
      return ws.sendBinary(packet);
    } catch {
      return 0;
    }
  }

  function closeStream(
    ws: ServerWebSocket<WispSocketData>,
    stream: TcpStreamState,
    reason: number,
    notifyClient: boolean,
  ): void {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.connectTimer) {
      clearTimeout(stream.connectTimer);
      stream.connectTimer = null;
    }
    stream.pendingWrites.length = 0;
    stream.pendingWriteBytes = 0;
    ws.data.pausedStreams.delete(stream);

    if (ws.data.streams.delete(stream.id)) {
      totalStreams = Math.max(0, totalStreams - 1);
    }

    if (stream.socket) {
      stream.socket.removeAllListeners();
      stream.socket.destroy();
      stream.socket = null;
    }

    if (notifyClient && !ws.data.wsClosed) {
      sendPacket(ws, encodeClosePacket(stream.id, reason));
    }
  }

  function forwardDownstream(ws: ServerWebSocket<WispSocketData>, stream: TcpStreamState, chunk: Uint8Array): void {
    if (stream.closed || ws.data.wsClosed) return;
    let offset = 0;
    let backpressured = false;
    while (offset < chunk.byteLength) {
      const end = Math.min(chunk.byteLength, offset + MAX_DOWNSTREAM_CHUNK);
      const slice = offset === 0 && end === chunk.byteLength ? chunk : chunk.subarray(offset, end);
      const res = sendPacket(ws, encodeDataPacket(stream.id, slice));
      if (res === -1 || ws.getBufferedAmount() > WS_BACKPRESSURE_HIGH_WATER) {
        backpressured = true;
      }
      offset = end;
    }
    if (backpressured && stream.socket && !stream.pausedByWs) {
      stream.pausedByWs = true;
      stream.socket.pause();
      ws.data.pausedStreams.add(stream);
    }
  }

  function writeToTcpSocket(ws: ServerWebSocket<WispSocketData>, stream: TcpStreamState, payload: Uint8Array): void {
    if (!stream.socket || stream.closed) return;
    const ok = stream.socket.write(payload);
    stream.remainingCredit = Math.max(0, stream.remainingCredit - 1);

    if (!ok) {
      if (!stream.waitingTcpDrain) {
        stream.waitingTcpDrain = true;
        stream.socket.once("drain", () => {
          stream.waitingTcpDrain = false;
          if (stream.closed || ws.data.wsClosed) return;
          stream.remainingCredit = config.initialBufferPackets;
          sendPacket(ws, encodeContinuePacket(stream.id, stream.remainingCredit));
        });
      }
      return;
    }

    if (!stream.waitingTcpDrain && stream.remainingCredit <= creditReplenishThreshold) {
      stream.remainingCredit = config.initialBufferPackets;
      sendPacket(ws, encodeContinuePacket(stream.id, stream.remainingCredit));
    }
  }

  function attachConnectedSocket(
    ws: ServerWebSocket<WispSocketData>,
    stream: TcpStreamState,
    socket: Socket,
    leftover: Uint8Array | null,
  ): void {
    if (stream.closed || ws.data.wsClosed) {
      socket.destroy();
      return;
    }

    stream.socket = socket;
    stream.connected = true;
    socket.setNoDelay(true);

    if (stream.connectTimer) {
      clearTimeout(stream.connectTimer);
      stream.connectTimer = null;
    }

    socket.on("data", (buf: Buffer) => {
      forwardDownstream(ws, stream, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    socket.on("end", () => {
      closeStream(ws, stream, WISP_CLOSE_VOLUNTARY, true);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      closeStream(ws, stream, mapErrnoToCloseReason(err), true);
    });
    socket.on("close", () => {
      closeStream(ws, stream, WISP_CLOSE_VOLUNTARY, true);
    });

    // Flush any 0-RTT pipelined DATA frames received while DNS/TCP handshake was in flight
    if (stream.pendingWrites.length > 0) {
      const queued = stream.pendingWrites.splice(0);
      stream.pendingWriteBytes = 0;
      for (const chunk of queued) {
        if (stream.closed) break;
        writeToTcpSocket(ws, stream, chunk);
      }
    }

    if (leftover && leftover.byteLength > 0) {
      forwardDownstream(ws, stream, leftover);
    }
  }

  async function openStreamConnection(ws: ServerWebSocket<WispSocketData>, stream: TcpStreamState): Promise<void> {
    if (!isPortAllowed(stream.port, config.allowedPorts)) {
      log(`blocked port ${stream.host}:${stream.port} (client=${ws.data.clientIp})`);
      closeStream(ws, stream, WISP_CLOSE_BLOCKED, true);
      return;
    }

    if (!isHostAllowed(stream.host, config.allowedHosts)) {
      log(`blocked host ${stream.host}:${stream.port} (client=${ws.data.clientIp})`);
      closeStream(ws, stream, WISP_CLOSE_BLOCKED, true);
      return;
    }

    if (config.outboundProxy && !shouldBypassProxy(stream.host, stream.port, config.noProxy)) {
      // Even with an outbound HTTP proxy, still block explicit private IP literals unless allowed
      const resolved = await resolveAndValidateHost(stream.host, config.allowPrivateIps).catch(() => null);
      if (resolved && !resolved.ok && resolved.code === "blocked") {
        log(`blocked SSRF target ${stream.host}:${stream.port} -> ${resolved.reason}`);
        closeStream(ws, stream, WISP_CLOSE_BLOCKED, true);
        return;
      }
      if (stream.closed || ws.data.wsClosed) return;

      try {
        const { socket, leftover } = await connectViaHttpProxy(
          config.outboundProxy,
          stream.host,
          stream.port,
          config.connectTimeoutMs,
        );
        attachConnectedSocket(ws, stream, socket, leftover);
      } catch (err) {
        closeStream(ws, stream, mapErrnoToCloseReason(err as NodeJS.ErrnoException), true);
      }
      return;
    }

    const resolved = await resolveAndValidateHost(stream.host, config.allowPrivateIps);
    if (stream.closed || ws.data.wsClosed) return;

    if (!resolved.ok) {
      if (resolved.code === "blocked") {
        log(`blocked SSRF ${stream.host}:${stream.port} (${resolved.reason})`);
        closeStream(ws, stream, WISP_CLOSE_BLOCKED, true);
      } else {
        closeStream(ws, stream, WISP_CLOSE_HOST_UNREACHABLE, true);
      }
      return;
    }

    // Connect directly to the already-validated IP to prevent DNS rebinding
    const socket = createConnection({
      host: resolved.address,
      port: stream.port,
      family: resolved.family,
    });
    stream.socket = socket;

    stream.connectTimer = setTimeout(() => {
      closeStream(ws, stream, WISP_CLOSE_CONNECT_TIMEOUT, true);
    }, config.connectTimeoutMs);

    socket.once("connect", () => {
      attachConnectedSocket(ws, stream, socket, null);
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      closeStream(ws, stream, mapErrnoToCloseReason(err), true);
    });
    socket.once("close", () => {
      if (!stream.connected) {
        closeStream(ws, stream, WISP_CLOSE_NETWORK_ERROR, true);
      }
    });
  }

  function handleConnectPacket(ws: ServerWebSocket<WispSocketData>, streamId: number, payload: Uint8Array): void {
    if (streamId === 0 || payload.byteLength < 4) {
      sendPacket(ws, encodeClosePacket(streamId, WISP_CLOSE_INVALID_INFO));
      return;
    }
    if (ws.data.streams.has(streamId)) {
      sendPacket(ws, encodeClosePacket(streamId, WISP_CLOSE_INVALID_INFO));
      return;
    }

    const streamType = payload[0];
    if (streamType !== WISP_STREAM_TCP) {
      sendPacket(ws, encodeClosePacket(streamId, WISP_CLOSE_INVALID_INFO));
      return;
    }

    const port = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(1, true);
    const host = textDecoder.decode(payload.subarray(3)).trim();
    if (!host || port < 1 || port > 65535) {
      sendPacket(ws, encodeClosePacket(streamId, WISP_CLOSE_INVALID_INFO));
      return;
    }

    if (ws.data.streams.size >= config.maxStreamsPerWs || totalStreams >= config.maxTotalStreams) {
      log(`throttled stream ${host}:${port} (ws=${ws.data.streams.size}, total=${totalStreams})`);
      sendPacket(ws, encodeClosePacket(streamId, WISP_CLOSE_THROTTLED));
      return;
    }

    const stream: TcpStreamState = {
      id: streamId,
      host,
      port,
      socket: null,
      connected: false,
      closed: false,
      pausedByWs: false,
      waitingTcpDrain: false,
      remainingCredit: config.initialBufferPackets,
      pendingWrites: [],
      pendingWriteBytes: 0,
      connectTimer: null,
    };

    ws.data.streams.set(streamId, stream);
    totalStreams++;
    void openStreamConnection(ws, stream);
  }

  function handleDataPacket(ws: ServerWebSocket<WispSocketData>, streamId: number, payload: Uint8Array): void {
    const stream = ws.data.streams.get(streamId);
    if (!stream || stream.closed) return;

    if (!stream.connected) {
      if (stream.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES) {
        closeStream(ws, stream, WISP_CLOSE_THROTTLED, true);
        return;
      }
      stream.pendingWrites.push(payload.slice());
      stream.pendingWriteBytes += payload.byteLength;
      return;
    }

    writeToTcpSocket(ws, stream, payload);
  }

  function handleClosePacket(ws: ServerWebSocket<WispSocketData>, streamId: number): void {
    const stream = ws.data.streams.get(streamId);
    if (!stream) return;
    closeStream(ws, stream, WISP_CLOSE_VOLUNTARY, false);
  }

  const handler: WebSocketHandler<WispSocketData> = {
    maxPayloadLength: config.maxWsPayloadBytes,
    idleTimeout: config.idleTimeoutSec,
    sendPings: true,
    perMessageDeflate: false,

    open(ws) {
      totalSessions++;
      // Wisp v1 handshake: server immediately sends CONTINUE on stream 0 with initial packet buffer size
      sendPacket(ws, encodeContinuePacket(0, config.initialBufferPackets));
    },

    message(ws, message) {
      if (typeof message === "string") return;
      const bytes =
        message instanceof Uint8Array
          ? message
          : new Uint8Array(message as ArrayBufferLike);
      if (bytes.byteLength < 5) return;

      const pktType = bytes[0];
      const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
      const payload = bytes.subarray(5);

      switch (pktType) {
        case WISP_PKT_CONNECT:
          handleConnectPacket(ws, streamId, payload);
          break;
        case WISP_PKT_DATA:
          handleDataPacket(ws, streamId, payload);
          break;
        case WISP_PKT_CLOSE:
          handleClosePacket(ws, streamId);
          break;
        default:
          break;
      }
    },

    drain(ws) {
      if (ws.data.pausedStreams.size === 0) return;
      for (const stream of [...ws.data.pausedStreams]) {
        ws.data.pausedStreams.delete(stream);
        stream.pausedByWs = false;
        if (!stream.closed && stream.socket) {
          stream.socket.resume();
        }
      }
    },

    close(ws) {
      if (ws.data.wsClosed) return;
      ws.data.wsClosed = true;
      totalSessions = Math.max(0, totalSessions - 1);
      for (const stream of [...ws.data.streams.values()]) {
        closeStream(ws, stream, WISP_CLOSE_VOLUNTARY, false);
      }
      ws.data.releaseIp();
    },
  };

  return {
    handler,
    getActiveStreams: () => totalStreams,
    getActiveSessions: () => totalSessions,
  };
}

export function createWispSocketData(clientIp: string, releaseIp: () => void): WispSocketData {
  return {
    kind: "wisp",
    clientIp,
    releaseIp,
    streams: new Map(),
    pausedStreams: new Set(),
    wsClosed: false,
  };
}
