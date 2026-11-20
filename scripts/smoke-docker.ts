import { DISTROS } from "../src/distro.ts";

const address = process.argv[2];
if (!address) throw new Error("Usage: bun scripts/smoke-docker.ts <app-url>");
const origin = new URL(address);

const home = await fetch(origin, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
if (
  !home.ok ||
  !home.headers.get("content-type")?.startsWith("text/html") ||
  home.headers.get("cross-origin-opener-policy") !== "same-origin" ||
  home.headers.get("cross-origin-embedder-policy") !== "require-corp"
) {
  throw new Error(`App at ${origin} did not serve the cross-origin isolated frontend (HTTP ${home.status})`);
}

const assets = Object.values(DISTROS).flatMap(({ image, template }) => [image, template]);
for (const asset of assets) {
  const response = await fetch(new URL(asset, origin), {
    headers: { Range: "bytes=0-0" },
    signal: AbortSignal.timeout(10_000),
  });
  const range = response.headers.get("content-range");
  if (response.status !== 206 || !range || !/^bytes 0-0\/[1-9]\d*$/.test(range)) {
    await response.body?.cancel();
    throw new Error(`Guest asset ${asset} is missing or cannot serve byte ranges (HTTP ${response.status})`);
  }
  if ((await response.arrayBuffer()).byteLength !== 1) {
    throw new Error(`Guest asset ${asset} returned the wrong number of bytes`);
  }
  console.log(`Verified ${asset} (${range})`);
}
