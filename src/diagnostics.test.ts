// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { formatByteSize, KernelLogBuffer, parseKwBase } from "./diagnostics.ts";

describe("diagnostics", () => {
  test("KernelLogBuffer bounds capacity, counts important entries, and formats output", () => {
    const buf = new KernelLogBuffer(3);
    buf.push({ time: 0.1, line: "[    0.100000] boot 1", important: false, source: "kernel" });
    buf.push({ time: 0.2, line: "[    0.200000] OOM kill", important: true, source: "kernel" });
    buf.push({ time: 0.3, line: "[    0.300000] boot 3", important: false, source: "kernel" });
    buf.push({ time: 0.4, line: "kw-overlay: SAFE MODE: too many boots", important: true, source: "overlay" });

    expect(buf.entries().length).toBe(3);
    expect(buf.entries()[0]!.line).toContain("OOM kill");
    expect(buf.importantCount()).toBe(2);
    expect(buf.format(true)).toBe("[    0.200000] OOM kill\nkw-overlay: SAFE MODE: too many boots");

    buf.clear();
    expect(buf.entries().length).toBe(0);
    expect(buf.importantCount()).toBe(0);
  });

  test("parseKwBase parses normal persistent overlay and safe mode state", () => {
    const normal = parseKwBase(
      "name=alpine\nimage=/dev/wda\nupper=data\nwhy=\nstate=/data/distros/alpine\ndev=/dev/wdb\nfstype=ext4\n",
    );
    expect(normal.safeMode).toBe(false);
    expect(normal.upper).toBe("data");
    expect(normal.name).toBe("alpine");

    const safe = parseKwBase(
      "name=debian\nimage=/dev/wda\nupper=\nwhy=safe mode: 3 unconfirmed boots\nstate=/data/distros/debian\ndev=/dev/wdb\nfstype=ext4\n",
    );
    expect(safe.safeMode).toBe(true);
    expect(safe.why).toBe("safe mode: 3 unconfirmed boots");

    const fallback = parseKwBase("name=alpine\nupper=none\nwhy=image mismatch\n");
    expect(fallback.safeMode).toBe(true);
  });

  test("reports a missing data disk separately from overlay safe mode", () => {
    const info = parseKwBase("name=debian\nimage=/dev/wda\nupper=tmpfs\nwhy=no data disk\n");
    expect(info.dataDiskMissing).toBe(true);
    expect(info.safeMode).toBe(false);
  });

  test("formatByteSize scales B, KiB, MiB, and GiB", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.0 KiB");
    expect(formatByteSize(5 * 1048576)).toBe("5.0 MiB");
    expect(formatByteSize(2.5 * 1024 ** 3)).toBe("2.50 GiB");
  });
});
