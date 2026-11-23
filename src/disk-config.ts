// SPDX-License-Identifier: MIT

export const GIB = 1024 ** 3;
export const DEFAULT_DISK_GIB = 4;
export const MAX_DISK_GIB = 1024;

export function parseDiskGiB(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return;
  const gib = Number(value);
  if (gib >= DEFAULT_DISK_GIB && gib <= MAX_DISK_GIB) return gib;
}

export function formatDiskGiB(bytes: number): string {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(bytes / GIB)} GiB`;
}
