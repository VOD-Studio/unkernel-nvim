// SPDX-License-Identifier: MIT

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAppServer } from "./index.ts";

test("guest preview and editor files are served on different hostnames", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "unkernel-guest-preview-test-"));
  writeFileSync(join(distDir, "index.html"), "editor");
  writeFileSync(join(distDir, "guest-preview.html"), "preview bridge");
  writeFileSync(join(distDir, "guest-preview-sw.js"), "preview worker");
  const app = startAppServer({ config: { host: "127.0.0.1", port: 0 }, distDir });
  try {
    const get = (path: string, hostname = "localhost") => fetch(`http://127.0.0.1:${app.port}${path}`, {
      headers: { Host: `${hostname}:${app.port}` },
    });
    expect((await get("/")).status).toBe(200);
    expect((await get("/guest-preview.html")).status).toBe(404);
    expect((await get("/%67uest-preview.html")).status).toBe(404);
    expect((await get("/guest-preview-sw.js")).status).toBe(404);

    const preview = "unkernel-preview.localhost";
    expect((await get("/", preview)).status).toBe(404);
    expect((await get("/index.html", preview)).status).toBe(404);
    expect((await get("/wisp", preview)).status).toBe(404);
    const bridge = await get("/guest-preview.html", preview);
    expect(bridge.status).toBe(200);
    expect(bridge.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(bridge.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(bridge.headers.has("Set-Cookie")).toBe(false);
    expect(await bridge.text()).toBe("preview bridge");
    expect((await get("/guest-preview-sw.js", preview)).status).toBe(200);
  } finally {
    app.stop();
    rmSync(distDir, { recursive: true });
  }
});
