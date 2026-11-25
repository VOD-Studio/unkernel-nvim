// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  formatDiskError,
  formatSnapshotMismatch,
  parseMacAddress,
} from "./disk-diagnostics.ts";

describe("disk-diagnostics", () => {
  test("formatDiskError detects QuotaExceededError and generic IDB failures", () => {
    const quotaErr = Object.assign(new Error("The quota has been exceeded."), {
      name: "QuotaExceededError",
    });
    const info1 = formatDiskError(quotaErr, 1234);
    expect(info1.isQuota).toBe(true);
    expect(info1.at).toBe(1234);
    expect(info1.message).toContain("配额已满");

    const genericInfo = formatDiskError(new Error("Transaction inactive"));
    expect(genericInfo.isQuota).toBe(false);
    expect(genericInfo.message).toContain("Transaction inactive");
  });

  test("parseMacAddress parses valid MAC addresses and rejects invalid ones", () => {
    expect(parseMacAddress("02:11:22:33:44:ff")).toEqual(
      new Uint8Array([0x02, 0x11, 0x22, 0x33, 0x44, 0xff]),
    );
    expect(parseMacAddress("02:11:22")).toBeUndefined();
    expect(parseMacAddress("zz:11:22:33:44:ff")).toBeUndefined();
    expect(parseMacAddress(undefined)).toBeUndefined();
  });

  test("formatSnapshotMismatch formats CPU, device, and disk reasons", () => {
    expect(formatSnapshotMismatch("cpu", "the snapshot has 2 CPUs, this machine has 1")).toContain(
      "CPU 核数不匹配",
    );
    expect(
      formatSnapshotMismatch("device", "the snapshot has a shm device, which this machine is not given"),
    ).toContain("虚拟设备配置与挂起时不一致");
    expect(
      formatSnapshotMismatch("device", "the network device has another MAC than in the snapshot"),
    ).toContain("虚拟网卡 MAC 地址与挂起时不一致");
    expect(
      formatSnapshotMismatch("disk", "disk wda (alpine.erofs) is not the disk of the snapshot (old)"),
    ).toContain("底层系统镜像已更新");
    expect(
      formatSnapshotMismatch("disk", "disk wdb (kwdata-v2) was written after the snapshot (generation 5, the snapshot has 4)"),
    ).toContain("数据盘在挂起后发生过写入");
  });
});
