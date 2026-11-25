// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DISK_GIB,
  formatDiskGiB,
  GIB,
  MAX_DISK_GIB,
  parseDiskGiB,
  parseDiskModeParam,
  shouldDownloadTemplate,
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

  test("shouldDownloadTemplate skips template only when seeded and within snapshot limit", () => {
    expect(shouldDownloadTemplate(false, 0, "persistent")).toBe(true);
    expect(shouldDownloadTemplate(false, 0, "snapshot")).toBe(true);
    expect(shouldDownloadTemplate(true, 100 * 1024 * 1024, "persistent")).toBe(false);
    expect(shouldDownloadTemplate(true, 100 * 1024 * 1024, "snapshot")).toBe(false);
    expect(shouldDownloadTemplate(true, SNAPSHOT_LIMIT_BYTES + 4096, "snapshot")).toBe(true);
    expect(shouldDownloadTemplate(true, SNAPSHOT_LIMIT_BYTES + 4096, "persistent")).toBe(false);
  });
});
