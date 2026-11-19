// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import {
  formatMemoryLabel,
  isPresetMemoryMiB,
  MEMORY_FALLBACK_MIB,
  MEMORY_MAX_MIB,
  MEMORY_MIN_MIB,
  parseMemorySpec,
  validateCustomMemoryInput,
} from "./memory-config.ts";

describe("memory-config", () => {
  test("parseMemorySpec handles auto, MiB, GiB, clamping, and invalid inputs", () => {
    expect(parseMemorySpec(null)).toBeUndefined();
    expect(parseMemorySpec(undefined)).toBeUndefined();
    expect(parseMemorySpec("")).toBeNull();
    expect(parseMemorySpec("  auto  ")).toBeNull();
    expect(parseMemorySpec("AUTO")).toBeNull();

    expect(parseMemorySpec("512")).toBe(512);
    expect(parseMemorySpec("1024m")).toBe(1024);
    expect(parseMemorySpec("1536 MiB")).toBe(1536);
    expect(parseMemorySpec("2g")).toBe(2048);
    expect(parseMemorySpec("1.5GB")).toBe(1536);
    expect(parseMemorySpec("4GiB")).toBe(4096);

    // Clamping to [MEMORY_MIN_MIB, MEMORY_MAX_MIB]
    expect(parseMemorySpec("32")).toBe(MEMORY_MIN_MIB);
    expect(parseMemorySpec("8192")).toBe(MEMORY_MAX_MIB);
    expect(parseMemorySpec("8G")).toBe(MEMORY_MAX_MIB);

    // Invalid inputs
    expect(parseMemorySpec("0")).toBeUndefined();
    expect(parseMemorySpec("-512")).toBeUndefined();
    expect(parseMemorySpec("abc")).toBeUndefined();
    expect(parseMemorySpec("512tb")).toBeUndefined();
  });

  test("validateCustomMemoryInput enforces strict integer bounds", () => {
    expect(validateCustomMemoryInput("128")).toEqual({ ok: true, mib: 128 });
    expect(validateCustomMemoryInput(" 1536 ")).toEqual({ ok: true, mib: 1536 });
    expect(validateCustomMemoryInput("4096")).toEqual({ ok: true, mib: 4096 });

    expect(validateCustomMemoryInput("").ok).toBe(false);
    expect(validateCustomMemoryInput("127").ok).toBe(false);
    expect(validateCustomMemoryInput("4097").ok).toBe(false);
    expect(validateCustomMemoryInput("1024.5").ok).toBe(false);
    expect(validateCustomMemoryInput("-256").ok).toBe(false);
    expect(validateCustomMemoryInput("2G").ok).toBe(false);
  });

  test("isPresetMemoryMiB and formatMemoryLabel format presets and custom sizes", () => {
    expect(isPresetMemoryMiB(null)).toBe(false);
    expect(isPresetMemoryMiB(512)).toBe(true);
    expect(isPresetMemoryMiB(1024)).toBe(true);
    expect(isPresetMemoryMiB(2048)).toBe(true);
    expect(isPresetMemoryMiB(4096)).toBe(true);
    expect(isPresetMemoryMiB(1536)).toBe(false);

    expect(formatMemoryLabel(null)).toBe("自动");
    expect(formatMemoryLabel(null, 512)).toBe("自动 (512 MiB)");
    expect(formatMemoryLabel(512)).toBe("512 MiB");
    expect(formatMemoryLabel(1024)).toBe("1024 MiB (1 GiB)");
    expect(formatMemoryLabel(1536)).toBe("1536 MiB");
    expect(formatMemoryLabel(4096)).toBe("4096 MiB (4 GiB)");
  });

  test("MEMORY_FALLBACK_MIB is strictly descending for smooth step-down", () => {
    for (let i = 1; i < MEMORY_FALLBACK_MIB.length; i++) {
      expect(MEMORY_FALLBACK_MIB[i]).toBeLessThan(MEMORY_FALLBACK_MIB[i - 1]);
    }
    expect(MEMORY_FALLBACK_MIB[0]).toBeLessThan(MEMORY_MAX_MIB);
  });
});
