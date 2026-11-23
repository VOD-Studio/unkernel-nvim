// SPDX-License-Identifier: MIT

const LOCAL_PREVIEW_HOST = "unkernel-preview.localhost";
const PREVIEW_FILES = new Set([
  "guest-preview.html", "guest-preview-bridge.js", "guest-preview-sw.js",
  "guest-preview-ws.js", "guest-preview-license.txt",
]);

export function configuredGuestPreviewUrl(): URL | undefined {
  const value = process.env.GUEST_PREVIEW_URL?.trim();
  if (!value) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url;
}

export function isGuestPreviewHost(hostname: string): boolean {
  return hostname === LOCAL_PREVIEW_HOST || hostname === configuredGuestPreviewUrl()?.hostname;
}

export function guestPreviewFile(pathname: string): string | undefined {
  try {
    const file = decodeURIComponent(pathname).split(/[/\\]/).at(-1);
    if (file && PREVIEW_FILES.has(file)) return file;
  } catch { /* invalid URL encoding */ }
}
