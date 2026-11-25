// SPDX-License-Identifier: MIT
// Disk persistence error formatting and pre-restore snapshot mismatch diagnostics.

export interface DiskErrorInfo {
  message: string;
  isQuota: boolean;
  raw: string;
  at: number;
}

/** Format an IndexedDB / disk flush error into a user-facing warning. */
export function formatDiskError(error: unknown, now = Date.now()): DiskErrorInfo {
  const errObj = error as { name?: string; code?: number; message?: string } | null;
  const raw =
    error instanceof Error
      ? error.message || error.name
      : typeof errObj?.message === "string"
        ? errObj.message
        : String(error);
  const name = typeof errObj?.name === "string" ? errObj.name : "";
  const isQuota =
    name === "QuotaExceededError" ||
    errObj?.code === 22 ||
    /quota|storage.*full|exceeded/i.test(raw);

  const message = isQuota
    ? "浏览器存储配额已满，文件写入未能落盘。请清理空间或尽快导出磁盘备份 (.kwsparse.gz)。"
    : `磁盘写入 IndexedDB 失败（${raw || "未知错误"}），当前修改可能仅保留在内存中。`;

  return {
    message,
    isQuota,
    raw,
    at: now,
  };
}

/** Convert a colon-separated MAC string ("aa:bb:cc:dd:ee:ff") into 6 bytes. */
export function parseMacAddress(mac: string | undefined): Uint8Array | undefined {
  if (!mac) return undefined;
  const parts = mac.split(":");
  if (parts.length !== 6) return undefined;
  const bytes = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    if (!/^[0-9a-f]{2}$/i.test(parts[i]!)) return undefined;
    bytes[i] = Number.parseInt(parts[i]!, 16);
  }
  return bytes;
}

/** Translate unkernel's snapshot mismatch messages into clear Chinese diagnostics. */
export function formatSnapshotMismatch(
  kind: "cpu" | "device" | "disk",
  rawReason: string,
): string {
  if (kind === "cpu") {
    return `CPU 核数不匹配，无法恢复挂起会话（${rawReason}）。`;
  }
  if (kind === "device") {
    if (/\bMAC\b/.test(rawReason)) {
      return `虚拟网卡 MAC 地址与挂起时不一致，无法恢复（${rawReason}）。`;
    }
    return `虚拟设备配置与挂起时不一致，无法恢复（${rawReason}）。`;
  }
  if (/wda\b/i.test(rawReason)) {
    return `底层系统镜像已更新或与挂起时不一致，无法恢复旧内存状态（${rawReason}）。`;
  }
  if (/written after the snapshot/i.test(rawReason)) {
    return `数据盘在挂起后发生过写入，与内存快照不一致，已阻止恢复以防文件系统损坏（${rawReason}）。`;
  }
  if (/not the disk of the snapshot/i.test(rawReason)) {
    return `当前持久化数据盘与挂起快照不匹配（${rawReason}）。`;
  }
  return `磁盘状态与挂起快照不一致，无法恢复（${rawReason}）。`;
}
