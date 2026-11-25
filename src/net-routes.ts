// SPDX-License-Identifier: MIT
// Configuration parsing, persistence, and Worker URL resolution for
// unkernel's NetSpec.backend.routes (fetchRoutes) direct HTTP bypass.

export const FETCH_ROUTES_STORAGE_KEY = "unkernel-nvim.fetchRoutes";
export const MAX_FETCH_ROUTES = 254;

export type FetchRouteMap = Record<string, string>;

const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isValidTargetBase(target: string): boolean {
  if (target.startsWith("/")) {
    return !target.startsWith("//");
  }
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeTargetBase(target: string): string {
  if (target === "/") return "/";
  return target.replace(/\/+$/, "");
}

/** Parse multiline `host = targetBaseUrl` config into a normalized FetchRouteMap. */
export function parseFetchRoutesText(
  text: string,
): { ok: true; routes: FetchRouteMap } | { ok: false; error: string } {
  const routes: FetchRouteMap = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let rawHost: string;
    let rawTarget: string;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      rawHost = trimmed.slice(0, eqIdx).trim();
      rawTarget = trimmed.slice(eqIdx + 1).trim();
    } else {
      const parts = trimmed.split(/\s+/);
      if (parts.length !== 2) {
        return { ok: false, error: `第 ${lineNo} 行格式无效，请使用 "域名 = 目标URL"` };
      }
      rawHost = parts[0]!;
      rawTarget = parts[1]!;
    }

    const host = rawHost.toLowerCase();
    if (!HOSTNAME_RE.test(host)) {
      return { ok: false, error: `第 ${lineNo} 行域名无效: ${rawHost || "(空)"}` };
    }
    if (!rawTarget || !isValidTargetBase(rawTarget)) {
      return {
        ok: false,
        error: `第 ${lineNo} 行目标地址无效（仅支持 http://、https:// 或同源 / 路径）`,
      };
    }
    if (Object.prototype.hasOwnProperty.call(routes, host)) {
      return { ok: false, error: `第 ${lineNo} 行域名重复: ${host}` };
    }
    if (Object.keys(routes).length >= MAX_FETCH_ROUTES) {
      return { ok: false, error: `直连路由最多支持 ${MAX_FETCH_ROUTES} 条` };
    }

    routes[host] = normalizeTargetBase(rawTarget);
  }

  return { ok: true, routes };
}

/** Format a FetchRouteMap as sorted `host = target` lines for textarea editing. */
export function formatFetchRoutesText(routes: FetchRouteMap): string {
  return Object.entries(routes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, target]) => `${host} = ${target}`)
    .join("\n");
}

/** Load saved FetchRouteMap from storage, ignoring malformed values. */
export function loadFetchRoutes(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage !== "undefined" ? localStorage : undefined,
): FetchRouteMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(FETCH_ROUTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: FetchRouteMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const host = k.trim().toLowerCase();
      if (
        typeof v === "string" &&
        HOSTNAME_RE.test(host) &&
        isValidTargetBase(v.trim()) &&
        Object.keys(out).length < MAX_FETCH_ROUTES
      ) {
        out[host] = normalizeTargetBase(v.trim());
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist FetchRouteMap to storage (removes key when empty). */
export function saveFetchRoutes(
  routes: FetchRouteMap,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = typeof localStorage !== "undefined" ? localStorage : undefined,
): void {
  if (!storage) return;
  if (Object.keys(routes).length === 0) {
    storage.removeItem(FETCH_ROUTES_STORAGE_KEY);
  } else {
    storage.setItem(FETCH_ROUTES_STORAGE_KEY, JSON.stringify(routes));
  }
}

/** Resolve same-origin relative route targets against `baseHref` for WorkerKernel fetch(). */
export function resolveFetchRoutesForWorker(routes: FetchRouteMap, baseHref: string): FetchRouteMap {
  const out: FetchRouteMap = {};
  for (const [host, target] of Object.entries(routes)) {
    const resolved = target.startsWith("/") ? new URL(target, baseHref).href : target;
    out[host] = resolved.replace(/\/+$/, "");
  }
  return out;
}

/** Compare two FetchRouteMap objects for equality. */
export function areFetchRoutesEqual(a: FetchRouteMap, b: FetchRouteMap): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
