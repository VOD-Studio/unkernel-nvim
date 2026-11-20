// SPDX-License-Identifier: MIT
// Centralized server & Wisp proxy configuration loaded from environment variables.

import { randomBytes } from "node:crypto";

export const DEFAULT_PROD_ALLOWED_HOSTS: readonly string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "dl-cdn.alpinelinux.org",
  "*.alpinelinux.org",
  "deb.debian.org",
  "security.debian.org",
  "gitlab.com",
  "*.gitlab.com",
  "codeberg.org",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
];

export interface ServerConfig {
  isProduction: boolean;
  host: string;
  port: number;
  wispPort: number;
  wispPath: string;
  trustProxy: boolean;

  // Gateway <-> Standalone Wisp authentication (server-side only, never exposed to browser)
  wispUpstreamUrl: string;
  wispAuthToken: string;
  wispAllowUnauthenticated: boolean;

  // Browser <-> App server frictionless session cookie (no login required)
  sessionSecret: string;
  sessionTtlSeconds: number;
  requireSession: boolean;

  // Origin & egress security policy
  allowedOrigins: string[];
  allowedHosts: string[];
  allowedPorts: "*" | number[];
  allowPrivateIps: boolean;
  outboundProxy: string;
  noProxy: string[];

  // Rate limits & resource quotas
  maxConnectionsPerIp: number;
  maxConnectsPerMinPerIp: number;
  maxStreamsPerWs: number;
  maxTotalStreams: number;
  connectTimeoutMs: number;
  idleTimeoutSec: number;
  initialBufferPackets: number;
  maxWsPayloadBytes: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function parseIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAllowedPorts(value: string | undefined): "*" | number[] {
  const raw = value?.trim();
  if (!raw) return [80, 443];
  if (raw === "*") return "*";
  const ports = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  return ports.length > 0 ? [...new Set(ports)] : [80, 443];
}

function normalizePath(p: string | undefined, fallback: string): string {
  const trimmed = (p ?? fallback).trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

const ENV_PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

function normalizeHttpProxyUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "";
  const candidate = value.includes("://") ? value : `http://${value}`;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return "";
    }
    return candidate;
  } catch {
    return "";
  }
}

function pickEnvHttpProxy(env: Record<string, string | undefined>): string {
  for (const key of ENV_PROXY_KEYS) {
    const normalized = normalizeHttpProxyUrl(env[key]);
    if (normalized) return normalized;
  }
  return "";
}

/** Return a credential-safe proxy representation for startup logs. */
export function formatProxyForLog(proxyUrl: string): string {
  if (!proxyUrl) return "";
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<configured>";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const isProduction = env.NODE_ENV === "production";

  const rawHosts = parseList(env.WISP_ALLOWED_HOSTS);
  const allowedHosts =
    rawHosts.length > 0
      ? rawHosts.map((h) => h.toLowerCase())
      : isProduction
        ? [...DEFAULT_PROD_ALLOWED_HOSTS]
        : ["*"];

  const sessionSecret = env.SESSION_SECRET?.trim() || randomBytes(32).toString("hex");

  const useEnvProxy = parseBool(env.WISP_USE_ENV_PROXY, true);
  const explicitProxy = env.WISP_OUTBOUND_PROXY?.trim() || "";
  const outboundProxy = explicitProxy
    ? explicitProxy.includes("://")
      ? explicitProxy
      : `http://${explicitProxy}`
    : useEnvProxy
      ? pickEnvHttpProxy(env)
      : "";
  const noProxy =
    env.WISP_NO_PROXY !== undefined
      ? parseList(env.WISP_NO_PROXY)
      : useEnvProxy
        ? parseList(env.NO_PROXY ?? env.no_proxy)
        : [];

  return {
    isProduction,
    host: env.HOST?.trim() || "0.0.0.0",
    port: parseIntEnv(env.PORT, 3000, 1, 65535),
    wispPort: parseIntEnv(env.WISP_PORT, 6680, 1, 65535),
    wispPath: normalizePath(env.WISP_PATH, "/wisp"),
    trustProxy: parseBool(env.TRUST_PROXY, false),

    wispUpstreamUrl: env.WISP_UPSTREAM_URL?.trim() || "",
    wispAuthToken: env.WISP_AUTH_TOKEN?.trim() || "",
    wispAllowUnauthenticated: parseBool(env.WISP_ALLOW_UNAUTHENTICATED, false),

    sessionSecret,
    sessionTtlSeconds: parseIntEnv(env.SESSION_TTL_SECONDS, 7200, 60, 86400 * 7),
    requireSession: parseBool(env.WISP_REQUIRE_SESSION, true),

    allowedOrigins: parseList(env.WISP_ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, "")),
    allowedHosts,
    allowedPorts: parseAllowedPorts(env.WISP_ALLOWED_PORTS),
    allowPrivateIps: parseBool(env.WISP_ALLOW_PRIVATE, false),
    outboundProxy,
    noProxy,

    maxConnectionsPerIp: parseIntEnv(env.WISP_MAX_CONNECTIONS_PER_IP, 4, 1, 1000),
    maxConnectsPerMinPerIp: parseIntEnv(env.WISP_MAX_CONNECTS_PER_MIN_PER_IP, 30, 1, 10000),
    maxStreamsPerWs: parseIntEnv(env.WISP_MAX_STREAMS_PER_WS, 32, 1, 1024),
    maxTotalStreams: parseIntEnv(env.WISP_MAX_TOTAL_STREAMS, 512, 1, 65535),
    connectTimeoutMs: parseIntEnv(env.WISP_CONNECT_TIMEOUT_MS, 10_000, 1000, 60_000),
    idleTimeoutSec: parseIntEnv(env.WISP_IDLE_TIMEOUT_SEC, 120, 10, 960),
    initialBufferPackets: parseIntEnv(env.WISP_INITIAL_BUFFER_PACKETS, 128, 8, 1024),
    maxWsPayloadBytes: parseIntEnv(env.WISP_MAX_WS_PAYLOAD_BYTES, 256 * 1024, 65536, 4 * 1024 * 1024),
  };
}
