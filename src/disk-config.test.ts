// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DISK_GIB,
  formatDiskGiB,
  getDiskCacheState,
  GIB,
  MAX_DISK_GIB,
  parseDiskGiB,
  parseDiskModeParam,
  SNAPSHOT_LIMIT_BYTES,
} from "./disk-config.ts";

describe("disk-config", () => {
  test("parseDiskGiB validates integer bounds", () => {
    expect(parseDiskGiB(String(DEFAULT_DISK_GIB))).toBe(DEFAULT_DISK_GIB);
    expect(parseDiskGiB(String(MAX_DISK_GIB))).toBe(MAX_DISK_GIB);
    expect(parseDiskGiB(String(DEFAULT_DISK_GIB - 1))).toBeUndefined();
    expect(parseDiskGiB(String(MAX_DISK_GIB + 1))).toBeUndefined();
    expect(parseDiskGiB("4.5")).toBeUndefined();
    expect(parseDiskGiB(null)).toBeUndefined();
  });

  test("formatDiskGiB formats bytes in GiB", () => {
    expect(formatDiskGiB(4 * GIB)).toBe("4 GiB");
  });

  test("parseDiskModeParam parses snapshot and persistent URL overrides", () => {
    expect(parseDiskModeParam("snapshot")).toBe("snapshot");
    expect(parseDiskModeParam("0")).toBe("snapshot");
    expect(parseDiskModeParam("persistent")).toBe("persistent");
    expect(parseDiskModeParam("1")).toBe("persistent");
    expect(parseDiskModeParam("invalid")).toBeUndefined();
    expect(parseDiskModeParam(null)).toBeUndefined();
  });

  test("detects an initialized disk with no blocks in every boot mode", () => {
    expect(getDiskCacheState(true, 0, "persistent")).toBe("empty");
    expect(getDiskCacheState(true, 0, "snapshot")).toBe("empty");
    expect(getDiskCacheState(true, 0, "resume")).toBe("empty");
  });

  test("reuses populated disks and respects the in-memory copy limit", () => {
    expect(getDiskCacheState(false, 0, "persistent")).toBe("unavailable");
    expect(getDiskCacheState(false, 0, "snapshot")).toBe("unavailable");
    expect(getDiskCacheState(true, 4096, "persistent")).toBe("ready");
    expect(getDiskCacheState(true, SNAPSHOT_LIMIT_BYTES, "snapshot")).toBe("ready");
    expect(getDiskCacheState(true, SNAPSHOT_LIMIT_BYTES + 4096, "snapshot")).toBe("unavailable");
    expect(getDiskCacheState(true, SNAPSHOT_LIMIT_BYTES + 4096, "persistent")).toBe("ready");
    expect(getDiskCacheState(true, SNAPSHOT_LIMIT_BYTES + 4096, "resume")).toBe("ready");
  });
});
