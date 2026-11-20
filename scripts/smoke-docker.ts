import { DISTRO_ASSETS, releaseGuestAssetPath } from "../src/distro.ts";

const address = process.argv[2];
if (!address) throw new Error("Usage: bun scripts/smoke-docker.ts <app-url>");
const origin = new URL(address);

const home = await fetch(origin, { signal: AbortSignal.timeout(10_000) });
if (
  !home.ok ||
  !home.headers.get("content-type")?.startsWith("text/html") ||
  home.headers.get("cross-origin-opener-policy") !== "same-origin" ||
  home.headers.get("cross-origin-embedder-policy") !== "require-corp"
) {
  throw new Error(`App at ${origin} did not serve the cross-origin isolated frontend (HTTP ${home.status})`);
}

const entry = (await home.text()).match(/<script\s+type="module"[^>]*\bsrc="([^"]+)"/)?.[1];
if (!entry) throw new Error(`App at ${origin} did not include its JavaScript entry`);
const entryUrl = new URL(entry, home.url);
if (!entryUrl.pathname.startsWith(new URL(".", home.url).pathname)) {
  throw new Error(`JavaScript entry ${entryUrl} is outside the app path`);
}
const entryResponse = await fetch(entryUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
if (!entryResponse.ok || !entryResponse.headers.get("content-type")?.includes("javascript")) {
  throw new Error(`JavaScript entry ${entryUrl} did not load (HTTP ${entryResponse.status})`);
}

for (const asset of DISTRO_ASSETS) {
  const url = new URL(releaseGuestAssetPath(asset), home.url);
  const response = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    signal: AbortSignal.timeout(10_000),
  });
  const range = response.headers.get("content-range");
  if (response.status !== 206 || !range || !/^bytes 0-0\/[1-9]\d*$/.test(range)) {
    await response.body?.cancel();
    throw new Error(`Guest asset ${url} is missing or cannot serve byte ranges (HTTP ${response.status})`);
  }
  if ((await response.arrayBuffer()).byteLength !== 1) {
    throw new Error(`Guest asset ${asset} returned the wrong number of bytes`);
  }
  console.log(`Verified ${url.pathname} (${range})`);
}
