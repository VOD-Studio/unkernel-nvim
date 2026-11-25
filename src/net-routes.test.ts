// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  areFetchRoutesEqual,
  FETCH_ROUTES_STORAGE_KEY,
  formatFetchRoutesText,
  loadFetchRoutes,
  MAX_FETCH_ROUTES,
  parseFetchRoutesText,
  resolveFetchRoutesForWorker,
  saveFetchRoutes,
} from "./net-routes.ts";

describe("net-routes", () => {
  test("parseFetchRoutesText parses valid lines, ignores comments, and rejects invalid syntax", () => {
    const res = parseFetchRoutesText(`
      # Alpine mirror
      mirror.local = https://mirrors.example.com/alpine/
      assets.local   /mirror
    `);
    expect(res).toEqual({
      ok: true,
      routes: {
        "mirror.local": "https://mirrors.example.com/alpine",
        "assets.local": "/mirror",
      },
    });

    expect(parseFetchRoutesText("bad_host! = https://example.com").ok).toBe(false);
    expect(parseFetchRoutesText("mirror.local = ftp://example.com").ok).toBe(false);
    expect(parseFetchRoutesText("mirror.local = //protocol-relative").ok).toBe(false);
    expect(parseFetchRoutesText("mirror.local = https://a.com\nmirror.local = https://b.com").ok).toBe(false);

    const tooMany = Array.from({ length: MAX_FETCH_ROUTES + 1 }, (_, i) => `h${i}.local = https://example.com`).join("\n");
    expect(parseFetchRoutesText(tooMany).ok).toBe(false);
  });

  test("formatFetchRoutesText and areFetchRoutesEqual normalize ordering and comparison", () => {
    const map = { "b.local": "https://b.test", "a.local": "https://a.test" };
    expect(formatFetchRoutesText(map)).toBe("a.local = https://a.test\nb.local = https://b.test");
    expect(areFetchRoutesEqual(map, { "a.local": "https://a.test", "b.local": "https://b.test" })).toBe(true);
    expect(areFetchRoutesEqual(map, { "a.local": "https://a.test" })).toBe(false);
  });

  test("loadFetchRoutes and saveFetchRoutes round-trip through Storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };

    saveFetchRoutes({ "mirror.local": "https://example.com/repo/" }, storage);
    expect(store.has(FETCH_ROUTES_STORAGE_KEY)).toBe(true);
    expect(loadFetchRoutes(storage)).toEqual({ "mirror.local": "https://example.com/repo" });

    saveFetchRoutes({}, storage);
    expect(store.has(FETCH_ROUTES_STORAGE_KEY)).toBe(false);
    expect(loadFetchRoutes(storage)).toEqual({});
  });

  test("resolveFetchRoutesForWorker resolves relative paths against page URL", () => {
    const resolved = resolveFetchRoutesForWorker(
      {
        "static.local": "/mirror/",
        "remote.local": "https://cdn.example.com/pkg/",
      },
      "https://nvim.example.com/app/",
    );
    expect(resolved).toEqual({
      "static.local": "https://nvim.example.com/mirror",
      "remote.local": "https://cdn.example.com/pkg",
    });
  });
});
