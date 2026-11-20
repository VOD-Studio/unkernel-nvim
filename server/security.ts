// SPDX-License-Identifier: MIT
// Security primitives for public-facing Wisp server & gateway:
// - Constant-time bearer token verification (Server <-> Wisp auth)
// - Frictionless HMAC-SHA256 HttpOnly session cookie (no login required)
// - Strict Origin allowlist validation
// - IPv4/IPv6/IPv4-mapped SSRF blocking + DNS rebinding protection
// - Hostname/port allowlisting & per-IP connection rate limiting

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const SESSION_COOKIE_NAME = "unkernel_wisp_sid";

/** High-risk ports always blocked when WISP_ALLOWED_PORTS="*". */
const BLOCKED_WILDCARD_PORTS = new Set([
  25, // SMTP
  465, // SMTPS
  587, // SMTP submission
  2525, // Alt SMTP
]);

/** Constant-time string comparison (hashes both inputs first so length is not leaked). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Verify `Authorization: Bearer <token>` against the server-side WISP_AUTH_TOKEN. */
export function verifyBearerToken(authHeader: string | null, expectedToken: string): boolean {
  if (!authHeader || !expectedToken) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match?.[1]) return false;
  return timingSafeEqualStr(match[1].trim(), expectedToken);
}

function signSessionPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a frictionless, short-lived signed session token (`exp.nonce.sig`). */
export function createSessionToken(secret: string, ttlSeconds: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + ttlSeconds;
  const nonce = randomBytes(12).toString("base64url");
  const payload = `${exp}.${nonce}`;
  const sig = signSessionPayload(payload, secret);
  return `${payload}.${sig}`;
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  if (!expStr || !nonce || !sig) return false;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const expectedSig = signSessionPayload(`${expStr}.${nonce}`, secret);
  return timingSafeEqualStr(sig, expectedSig);
}

export function parseCookies(cookieHeader: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out.set(key, val);
  }
  return out;
}

export function hasValidSessionCookie(cookieHeader: string | null, secret: string): boolean {
  const cookies = parseCookies(cookieHeader);
  return verifySessionToken(cookies.get(SESSION_COOKIE_NAME), secret);
}

export function isHttpsRequest(req: Request, trustProxy: boolean): boolean {
  if (trustProxy) {
    const fwdProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (fwdProto === "https") return true;
    if (fwdProto === "http") return false;
  }
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function buildSessionSetCookieHeader(secret: string, ttlSeconds: number, secure: boolean): string {
  const token = createSessionToken(secret, ttlSeconds);
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${ttlSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Validate WebSocket `Origin` header:
 * - Always allow exact match in `allowedOrigins`
 * - Allow same-origin matching the request Host (or X-Forwarded-Host when trustProxy=true)
 */
export function isOriginAllowed(
  req: Request,
  allowedOrigins: readonly string[],
  trustProxy: boolean,
): boolean {
  const originRaw = req.headers.get("origin")?.trim();
  if (!originRaw) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(originRaw);
  } catch {
    return false;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return false;
  }
  const normalizedOrigin = `${originUrl.protocol}//${originUrl.host}`;

  if (allowedOrigins.includes("*")) return true;
  if (allowedOrigins.includes(normalizedOrigin)) return true;

  const hostHeader =
    (trustProxy ? req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : null) ||
    req.headers.get("host")?.trim();
  if (!hostHeader) return false;

  // Allow exact host match; enforce HTTPS when the request itself arrived over HTTPS.
  const expectedProto = isHttpsRequest(req, trustProxy) ? "https:" : "http:";
  if (originUrl.host.toLowerCase() === hostHeader.toLowerCase()) {
    if (expectedProto === "https:" && originUrl.protocol !== "https:") return false;
    return true;
  }
  return false;
}

export function getClientIp(req: Request, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return socketAddress || "unknown";
}

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    val = ((val << 8) | n) >>> 0;
  }
  return val;
}

function isPrivateIpv4(ip: string): boolean {
  const n = parseIpv4ToInt(ip);
  if (n === null) return true;
  const b0 = (n >>> 24) & 0xff;
  const b1 = (n >>> 16) & 0xff;
  const b2 = (n >>> 8) & 0xff;

  if (b0 === 0) return true; // 0.0.0.0/8 (this network)
  if (b0 === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (b0 === 127) return true; // 127.0.0.0/8 (loopback)
  if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true; // 198.18.0.0/15 (benchmarking / unkernel fake DNS)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (b0 >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved & broadcast
  return false;
}

function expandIpv6(ip: string): number[] | null {
  let clean = ip.toLowerCase();
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx !== -1) clean = clean.slice(0, zoneIdx);

  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1) into two 16-bit hex groups
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1 && clean.slice(lastColon + 1).includes(".")) {
    const v4Int = parseIpv4ToInt(clean.slice(lastColon + 1));
    if (v4Int === null) return null;
    const hi = ((v4Int >>> 16) & 0xffff).toString(16);
    const lo = (v4Int & 0xffff).toString(16);
    clean = `${clean.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = clean.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    const nums: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      nums.push(Number.parseInt(g, 16));
    }
    return nums;
  };

  const left = parseGroups(halves[0] ?? "");
  const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;

  const isAllZero = g.every((x) => x === 0);
  if (isAllZero) return true; // ::/128
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1/128 loopback
  }

  // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96) or NAT64 (64:ff9b::/96)
  const isV4Mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const isV4Compat = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (isV4Mapped || isV4Compat || isNat64) {
    const embeddedV4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
    return isPrivateIpv4(embeddedV4);
  }

  // 6to4 (2002::/16) embeds IPv4 in groups 1 and 2
  if (g[0] === 0x2002) {
    const embeddedV4 = `${g[1]! >>> 8}.${g[1]! & 0xff}.${g[2]! >>> 8}.${g[2]! & 0xff}`;
    return isPrivateIpv4(embeddedV4);
  }

  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 Site-Local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 Documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 Discard
  return false;
}

/** Returns true if the IP address is loopback, private, link-local, metadata, multicast, or invalid. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

export function isPortAllowed(port: number, allowedPorts: "*" | readonly number[]): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (allowedPorts === "*") {
    return !BLOCKED_WILDCARD_PORTS.has(port);
  }
  return allowedPorts.includes(port);
}

export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return false;
  // Reject whitespace or control characters (prevents proxy header injection)
  if (/[\s\x00-\x1f\x7f/]/.test(host)) return false;

  if (allowedHosts.includes("*")) return true;

  // When a strict domain allowlist is active, reject raw IP literals so domains cannot be bypassed
  if (isIP(host) !== 0) {
    return allowedHosts.includes(host);
  }

  for (const pattern of allowedHosts) {
    const p = pattern.trim().toLowerCase().replace(/\.$/, "");
    if (!p) continue;
    if (p === "*") return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) {
        return true;
      }
    } else if (host === p) {
      return true;
    }
  }
  return false;
}

/**
 * Standard NO_PROXY matching for bypassing an outbound HTTP CONNECT proxy.
 * Supports `*`, exact IP/hostname, optional `:port` (including `[::1]:port`),
 * and domain suffixes (`example.com`, `.example.com`, `*.example.com`).
 */
export function shouldBypassProxy(hostname: string, port: number, noProxy: readonly string[]): boolean {
  if (noProxy.length === 0) return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  const hostIsIp = isIP(host) !== 0;

  for (const rawEntry of noProxy) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;

    let patternHost = entry;
    let patternPort: number | null = null;

    if (entry.startsWith("[")) {
      const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
      if (!m?.[1]) continue;
      patternHost = m[1];
      if (m[2]) patternPort = Number.parseInt(m[2], 10);
    } else {
      const firstColon = entry.indexOf(":");
      const lastColon = entry.lastIndexOf(":");
      if (firstColon !== -1 && firstColon === lastColon) {
        const maybePort = entry.slice(firstColon + 1);
        if (/^\d+$/.test(maybePort)) {
          patternHost = entry.slice(0, firstColon);
          patternPort = Number.parseInt(maybePort, 10);
        }
      }
    }

    if (patternPort !== null && patternPort !== port) continue;
    patternHost = patternHost.replace(/\.$/, "");
    if (!patternHost) continue;
    if (patternHost === "*") return true;
    if (host === patternHost) return true;

    if (hostIsIp || isIP(patternHost) !== 0) continue;

    if (patternHost.startsWith("*.")) {
      const suffix = patternHost.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (patternHost.startsWith(".")) {
      const bare = patternHost.slice(1);
      if (host === bare || host.endsWith(patternHost)) return true;
    } else if (host.endsWith(`.${patternHost}`)) {
      return true;
    }
  }

  return false;
}

export type ResolveResult =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; code: "blocked" | "unreachable"; reason: string };

/**
 * Resolve hostname once and validate EVERY returned IP against SSRF rules.
 * Connecting directly to the returned IP eliminates DNS rebinding windows.
 */
export async function resolveAndValidateHost(hostname: string, allowPrivateIps: boolean): Promise<ResolveResult> {
  const cleanHost = hostname.trim().replace(/^\[|\]$/g, "");
  const ipFamily = isIP(cleanHost);
  if (ipFamily === 4 || ipFamily === 6) {
    if (!allowPrivateIps && isPrivateOrReservedIp(cleanHost)) {
      return { ok: false, code: "blocked", reason: `private/reserved IP blocked: ${cleanHost}` };
    }
    return { ok: true, address: cleanHost, family: ipFamily };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(cleanHost, { all: true, verbatim: false });
  } catch (err) {
    return {
      ok: false,
      code: "unreachable",
      reason: `DNS lookup failed for ${cleanHost}: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  if (records.length === 0) {
    return { ok: false, code: "unreachable", reason: `DNS returned no records for ${cleanHost}` };
  }

  if (!allowPrivateIps) {
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return {
          ok: false,
          code: "blocked",
          reason: `${cleanHost} resolved to private/reserved IP ${rec.address}`,
        };
      }
    }
  }

  // Prefer IPv4 first (most containers/VPS have reliable IPv4 egress)
  const preferred = records.find((r) => r.family === 4) ?? records[0]!;
  return {
    ok: true,
    address: preferred.address,
    family: preferred.family === 6 ? 6 : 4,
  };
}

/** Tracks concurrent WebSocket sessions and per-minute connection rate per client IP. */
export class IpRateLimiter {
  #active = new Map<string, number>();
  #history = new Map<string, number[]>();
  #maxConcurrent: number;
  #maxPerMin: number;

  constructor(maxConcurrent: number, maxPerMin: number) {
    this.#maxConcurrent = maxConcurrent;
    this.#maxPerMin = maxPerMin;
  }

  acquire(ip: string): { ok: true; release: () => void } | { ok: false; reason: string } {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (this.#history.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.#maxPerMin) {
      this.#history.set(ip, recent);
      return { ok: false, reason: "rate limit exceeded" };
    }

    const active = this.#active.get(ip) ?? 0;
    if (active >= this.#maxConcurrent) {
      return { ok: false, reason: "too many concurrent connections" };
    }

    recent.push(now);
    this.#history.set(ip, recent);
    this.#active.set(ip, active + 1);

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const cur = this.#active.get(ip) ?? 0;
        if (cur <= 1) this.#active.delete(ip);
        else this.#active.set(ip, cur - 1);
      },
    };
  }
}
