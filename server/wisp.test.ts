// SPDX-License-Identifier: MIT
// Unit and end-to-end integration tests for the Bun backend, Wisp v1 engine,
// server-side Bearer auth gateway, frictionless HttpOnly session cookies, and SSRF guards.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpBase, wispBackend } from "unkernel/node";
import { startAppServer } from "./index.ts";
import {
  buildSessionSetCookieHeader,
  createSessionToken,
  hasValidSessionCookie,
  IpRateLimiter,
  isHostAllowed,
  isOriginAllowed,
  isPortAllowed,
  isPrivateOrReservedIp,
  SESSION_COOKIE_NAME,
  verifyBearerToken,
  verifySessionToken,
} from "./security.ts";
import { startStandaloneWispServer } from "./wisp-server.ts";

describe("security primitives", () => {
  test("verifyBearerToken enforces constant-time bearer auth", () => {
    const secret = "super-secret-wisp-token-9f8a7b6c";
    expect(verifyBearerToken(`Bearer ${secret}`, secret)).toBe(true);
    expect(verifyBearerToken(`bearer   ${secret} `, secret)).toBe(true);
    expect(verifyBearerToken(`Bearer wrong-token`, secret)).toBe(false);
    expect(verifyBearerToken(secret, secret)).toBe(false);
    expect(verifyBearerToken(null, secret)).toBe(false);
    expect(verifyBearerToken(`Bearer ${secret}`, "")).toBe(false);
  });

  test("frictionless HMAC session tokens verify & expire properly", () => {
    const secret = "session-secret-key";
    const now = 1_700_000_000;
    const tok = createSessionToken(secret, 300, now);

    expect(verifySessionToken(tok, secret, now + 100)).toBe(true);
    expect(verifySessionToken(tok, secret, now + 301)).toBe(false);
    expect(verifySessionToken(`${tok}tamper`, secret, now + 100)).toBe(false);
    expect(verifySessionToken(tok, "wrong-secret", now + 100)).toBe(false);

    const setCookie = buildSessionSetCookieHeader(secret, 300, true);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");

    const cookiePair = setCookie.split(";")[0]!;
    expect(hasValidSessionCookie(cookiePair, secret)).toBe(true);
    expect(hasValidSessionCookie("other=123", secret)).toBe(false);
  });

  test("isOriginAllowed validates same-origin, explicit allowlist, and reverse proxy headers", () => {
    const sameOriginReq = new Request("http://localhost:3000/wisp", {
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000" },
    });
    expect(isOriginAllowed(sameOriginReq, [], false)).toBe(true);

    const crossOriginReq = new Request("http://localhost:3000/wisp", {
      headers: { Host: "localhost:3000", Origin: "https://evil.example" },
    });
    expect(isOriginAllowed(crossOriginReq, [], false)).toBe(false);
    expect(isOriginAllowed(crossOriginReq, ["https://evil.example"], false)).toBe(true);

    const noOriginReq = new Request("http://localhost:3000/wisp", {
      headers: { Host: "localhost:3000" },
    });
    expect(isOriginAllowed(noOriginReq, [], false)).toBe(false);

    const proxiedHttpsReq = new Request("http://127.0.0.1:3000/wisp", {
      headers: {
        Host: "127.0.0.1:3000",
        "X-Forwarded-Host": "nvim.example.com",
        "X-Forwarded-Proto": "https",
        Origin: "https://nvim.example.com",
      },
    });
    expect(isOriginAllowed(proxiedHttpsReq, [], true)).toBe(true);

    const proxiedDowngradeReq = new Request("http://127.0.0.1:3000/wisp", {
      headers: {
        Host: "127.0.0.1:3000",
        "X-Forwarded-Host": "nvim.example.com",
        "X-Forwarded-Proto": "https",
        Origin: "http://nvim.example.com",
      },
    });
    expect(isOriginAllowed(proxiedDowngradeReq, [], true)).toBe(false);
  });

  test("isPrivateOrReservedIp blocks loopback, RFC1918, metadata, CGNAT, and IPv4-mapped IPv6", () => {
    const blocked = [
      "0.0.0.0",
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "64:ff9b::10.0.0.1",
    ];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }

    const allowed = ["1.1.1.1", "8.8.8.8", "140.82.121.4", "2606:4700:4700::1111"];
    for (const ip of allowed) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  test("host and port allowlists enforce rules and reject bypasses", () => {
    const hosts = ["github.com", "*.githubusercontent.com"];
    expect(isHostAllowed("github.com", hosts)).toBe(true);
    expect(isHostAllowed("GITHUB.COM.", hosts)).toBe(true);
    expect(isHostAllowed("raw.githubusercontent.com", hosts)).toBe(true);
    expect(isHostAllowed("a.b.githubusercontent.com", hosts)).toBe(true);
    expect(isHostAllowed("githubusercontent.com", hosts)).toBe(false);
    expect(isHostAllowed("evilgithub.com", hosts)).toBe(false);
    expect(isHostAllowed("140.82.121.4", hosts)).toBe(false);
    expect(isHostAllowed("github.com\r\nEvil: 1", ["*"])).toBe(false);

    expect(isPortAllowed(443, [80, 443])).toBe(true);
    expect(isPortAllowed(22, [80, 443])).toBe(false);
    expect(isPortAllowed(25, "*")).toBe(false);
    expect(isPortAllowed(587, "*")).toBe(false);
    expect(isPortAllowed(8443, "*")).toBe(true);
  });

  test("IpRateLimiter enforces concurrent and per-minute quotas", () => {
    const limiter = new IpRateLimiter(2, 3);
    const t1 = limiter.acquire("1.2.3.4");
    const t2 = limiter.acquire("1.2.3.4");
    const t3 = limiter.acquire("1.2.3.4");
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    expect(t3.ok).toBe(false); // concurrent cap = 2
    if (t1.ok) t1.release();
    const t4 = limiter.acquire("1.2.3.4");
    expect(t4.ok).toBe(true); // 3rd connection within minute allowed
    if (t2.ok) t2.release();
    const t5 = limiter.acquire("1.2.3.4");
    expect(t5.ok).toBe(false); // per-minute cap = 3 reached
  });
});

describe("gateway <-> authenticated Wisp end-to-end", () => {
  const cleanups: Array<() => void> = [];

  afterAll(() => {
    for (const fn of cleanups.reverse()) fn();
  });

  function startEchoTcpServer(): Promise<{ server: TcpServer; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((sock) => {
        sock.on("data", (buf) => {
          const chunk = typeof buf === "string" ? Buffer.from(buf) : buf;
          sock.write(Buffer.concat([Buffer.from("ECHO:"), chunk]));
          sock.end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        cleanups.push(() => server.close());
        resolve({ server, port });
      });
    });
  }

  test("standalone Wisp refuses to start without WISP_AUTH_TOKEN by default", () => {
    expect(() =>
      startStandaloneWispServer({
        host: "127.0.0.1",
        wispPort: 0,
        wispAuthToken: "",
        wispAllowUnauthenticated: false,
      }),
    ).toThrow(/WISP_AUTH_TOKEN/);
  });

  test("full flow: browser gets frictionless cookie -> gateway attaches Bearer token -> private Wisp proxies TCP", async () => {
    const { port: echoPort } = await startEchoTcpServer();
    const wispToken = "e2e-server-only-wisp-secret-token";
    const sessionSecret = "e2e-session-secret";

    // 1. Start standalone authenticated Wisp server (allows localhost echoPort for this test)
    const wisp = startStandaloneWispServer({
      host: "127.0.0.1",
      wispPort: 0,
      wispPath: "/wisp",
      wispAuthToken: wispToken,
      allowedHosts: ["*"],
      allowedPorts: [echoPort],
      allowPrivateIps: true,
    });
    cleanups.push(() => wisp.stop());

    // Direct unauthenticated connection to standalone Wisp MUST be rejected with 401
    const unauthRes = await fetch(`http://127.0.0.1:${wisp.port}/wisp`);
    expect(unauthRes.status).toBe(401);
    const wrongAuthRes = await fetch(`http://127.0.0.1:${wisp.port}/wisp`, {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    expect(wrongAuthRes.status).toBe(401);

    // 2. Start unified App server in gateway mode pointing to the private Wisp server
    const app = startAppServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        wispPath: "/wisp",
        wispUpstreamUrl: `ws://127.0.0.1:${wisp.port}/wisp`,
        wispAuthToken: wispToken,
        sessionSecret,
        requireSession: true,
        allowedOrigins: [],
        trustProxy: false,
      },
    });
    cleanups.push(() => app.stop());
    expect(app.mode).toBe("gateway");

    // 3. Browser loads "/" (no login) -> receives COOP/COEP headers and frictionless HttpOnly Cookie
    const pageRes = await fetch(`http://127.0.0.1:${app.port}/`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(pageRes.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    const setCookie = pageRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie!).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie!).toContain("HttpOnly");
    const cookieHeader = setCookie!.split(";")[0]!;

    // 4. Direct /wisp requests without Origin or Cookie MUST be rejected with 403
    expect((await fetch(`http://127.0.0.1:${app.port}/wisp`)).status).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${app.port}/wisp`, {
          headers: { Origin: `http://127.0.0.1:${app.port}` },
        })
      ).status,
    ).toBe(403);

    // 5. Connect using real unkernel `wispBackend()` with ONLY browser Origin + HttpOnly Cookie
    //    (ZERO WISP_AUTH_TOKEN on the client side!)
    const backend = wispBackend(`ws://127.0.0.1:${app.port}/wisp`, {
      headers: {
        Origin: `http://127.0.0.1:${app.port}`,
        Cookie: cookieHeader,
      },
    });

    const received = await new Promise<string>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      const conn = backend.connect(
        { host: "127.0.0.1", port: echoPort },
        {
          onConnect() {
            conn.write(new TextEncoder().encode("hello-from-unkernel"));
          },
          onData(u8) {
            chunks.push(u8.slice());
          },
          onEnd() {},
          onDrain() {},
          onClose(err) {
            if (err) {
              reject(err);
              return;
            }
            const total = chunks.reduce((n, c) => n + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              merged.set(c, off);
              off += c.byteLength;
            }
            resolve(new TextDecoder().decode(merged));
          },
        },
      );
    });

    expect(received).toBe("ECHO:hello-from-unkernel");
    backend.close();
  });

  test("SSRF and host allowlist block unauthorized targets with Wisp close reason 0x48", async () => {
    const { port: echoPort } = await startEchoTcpServer();

    // Built-in mode with strict SSRF (allowPrivateIps: false) and strict host allowlist
    const app = startAppServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        wispPath: "/wisp",
        wispUpstreamUrl: "",
        requireSession: false,
        allowedHosts: ["github.com"],
        allowedPorts: [80, 443, echoPort],
        allowPrivateIps: false,
      },
    });
    cleanups.push(() => app.stop());

    const backend = wispBackend(`ws://127.0.0.1:${app.port}/wisp`, {
      headers: { Origin: `http://127.0.0.1:${app.port}` },
    });

    const err1 = await new Promise<Error | null>((resolve) => {
      backend.connect(
        { host: "127.0.0.1", port: echoPort },
        {
          onConnect() {},
          onData() {},
          onEnd() {},
          onDrain() {},
          onClose(err) {
            resolve(err);
          },
        },
      );
    });
    expect(err1).toBeTruthy();
    expect(err1!.message).toContain("blocked by the proxy");

    const err2 = await new Promise<Error | null>((resolve) => {
      backend.connect(
        { host: "example.com", port: 443 },
        {
          onConnect() {},
          onData() {},
          onEnd() {},
          onDrain() {},
          onClose(err) {
            resolve(err);
          },
        },
      );
    });
    expect(err2).toBeTruthy();
    expect(err2!.message).toContain("blocked by the proxy");

    backend.close();
  });

  test("SSRF guard blocks localhost/127.0.0.1 even when WISP_ALLOWED_HOSTS is '*'", async () => {
    const { port: echoPort } = await startEchoTcpServer();

    const app = startAppServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        wispPath: "/wisp",
        wispUpstreamUrl: "",
        requireSession: false,
        allowedHosts: ["*"],
        allowedPorts: [echoPort],
        allowPrivateIps: false,
      },
    });
    cleanups.push(() => app.stop());

    const backend = wispBackend(`ws://127.0.0.1:${app.port}/wisp`, {
      headers: { Origin: `http://127.0.0.1:${app.port}` },
    });

    for (const target of ["127.0.0.1", "localhost"]) {
      const err = await new Promise<Error | null>((resolve) => {
        backend.connect(
          { host: target, port: echoPort },
          {
            onConnect() {},
            onData() {},
            onEnd() {},
            onDrain() {},
            onClose(e) {
              resolve(e);
            },
          },
        );
      });
      expect(err).toBeTruthy();
      expect(err!.message).toContain("blocked by the proxy");
    }

    backend.close();
  });

  test("gateway rejects upstream when WISP_AUTH_TOKEN does not match standalone Wisp", async () => {
    const wisp = startStandaloneWispServer({
      host: "127.0.0.1",
      wispPort: 0,
      wispPath: "/wisp",
      wispAuthToken: "correct-server-secret",
      allowedHosts: ["*"],
      allowedPorts: [80, 443],
    });
    cleanups.push(() => wisp.stop());

    const app = startAppServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        wispPath: "/wisp",
        wispUpstreamUrl: `ws://127.0.0.1:${wisp.port}/wisp`,
        wispAuthToken: "mismatched-secret",
        requireSession: false,
      },
    });
    cleanups.push(() => app.stop());

    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/wisp`, {
      headers: { Origin: `http://127.0.0.1:${app.port}` },
    } as unknown as string[]);

    const closeCode = await new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code);
    });
    expect(closeCode).not.toBe(1000);
  });

  test("static asset server supports HTTP Range requests for unkernel HttpBase distro images", async () => {
    const tmpDist = mkdtempSync(path.join(tmpdir(), "unkernel-nvim-range-"));
    cleanups.push(() => rmSync(tmpDist, { recursive: true, force: true }));
    writeFileSync(path.join(tmpDist, "index.html"), "<!doctype html><html></html>");
    const payload = new Uint8Array(65536);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    writeFileSync(path.join(tmpDist, "alpine.erofs"), payload);

    const app = startAppServer({
      distDir: tmpDist,
      config: {
        host: "127.0.0.1",
        port: 0,
        wispPath: "/wisp",
        wispUpstreamUrl: "",
        requireSession: false,
      },
    });
    cleanups.push(() => app.stop());

    const url = `http://127.0.0.1:${app.port}/alpine.erofs`;
    const partial = await fetch(url, { headers: { Range: "bytes=0-1023" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(partial.headers.get("content-range")).toBe(`bytes 0-1023/${payload.length}`);
    expect((await partial.arrayBuffer()).byteLength).toBe(1024);

    const clamped = await fetch(url, { headers: { Range: "bytes=0-262143" } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe(`bytes 0-${payload.length - 1}/${payload.length}`);
    expect((await clamped.arrayBuffer()).byteLength).toBe(payload.length);

    const invalid = await fetch(url, { headers: { Range: `bytes=${payload.length}-` } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${payload.length}`);

    const httpBase = await HttpBase.open(url, { chunkSize: 16384, strict: true, prefetch: false });
    expect(httpBase.size).toBe(payload.length);
    const slice = await httpBase.read(20000, 128);
    expect(slice).toEqual(payload.subarray(20000, 20128));
  });
});
