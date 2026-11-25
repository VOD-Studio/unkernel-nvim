// SPDX-License-Identifier: MIT

export const GIB = 1024 ** 3;
export const DEFAULT_DISK_GIB = 4;
export const MAX_DISK_GIB = 1024;
export const SNAPSHOT_LIMIT_BYTES = 512 * 1024 * 1024;

export type DiskMode = "persistent" | "snapshot";

export function parseDiskGiB(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return;
  const gib = Number(value);
  if (gib >= DEFAULT_DISK_GIB && gib <= MAX_DISK_GIB) return gib;
}

export function formatDiskGiB(bytes: number): string {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(bytes / GIB)} GiB`;
}

export function parseDiskModeParam(value: string | null): DiskMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "snapshot" || normalized === "0") return "snapshot";
  if (normalized === "persistent" || normalized === "1") return "persistent";
  return undefined;
}

export function shouldDownloadTemplate(
  seeded: boolean,
  storedBytes: number,
  mode: DiskMode,
  limitBytes = SNAPSHOT_LIMIT_BYTES,
): boolean {
  if (!seeded) return true;
  if (mode === "snapshot" && storedBytes > limitBytes) return true;
  return false;
}
