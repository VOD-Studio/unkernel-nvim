// SPDX-License-Identifier: MIT
// VM memory quota constants, parsing, validation, and graceful fallback ladder.

export const MEMORY_STORAGE_KEY = "unkernel-nvim.memoryMiB";
export const MEMORY_MIN_MIB = 128;
export const MEMORY_MAX_MIB = 4096;
export const MEMORY_PRESETS_MIB = [512, 1024, 2048, 4096] as const;

/**
 * Step-down ladder tried when the browser cannot allocate the requested
 * WebAssembly.Memory size. unkernel filters entries strictly smaller than
 * the requested memoryMiB.
 */
export const MEMORY_FALLBACK_MIB = [
  3072, 2048, 1536, 1024, 768, 512, 384, 256, 192, 128, 96, 64,
] as const;

/** null represents "auto" (defer to unkernel's autoMemoryMiB()). */
export type MemoryConfigMiB = number | null;

export function isPresetMemoryMiB(
  mib: MemoryConfigMiB,
): mib is (typeof MEMORY_PRESETS_MIB)[number] {
  return mib !== null && (MEMORY_PRESETS_MIB as readonly number[]).includes(mib);
}

/**
 * Parse a stored or URL-supplied memory spec (`"auto"`, `"1024"`, `"2G"`, `"1.5GiB"`, `"768m"`).
 * Returns:
 * - `null` for `"auto"` or empty string
 * - clamped integer MiB in [MEMORY_MIN_MIB, MEMORY_MAX_MIB] for valid values
 * - `undefined` if unparseable
 */
export function parseMemorySpec(raw: string | null | undefined): MemoryConfigMiB | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return null;

  const match = /^(\d+(?:\.\d+)?)\s*(m|mb|mib|g|gb|gib)?$/i.exec(trimmed);
  if (!match) return undefined;

  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;

  const unit = (match[2] ?? "m").toLowerCase();
  const mib = unit.startsWith("g") ? Math.round(num * 1024) : Math.round(num);
  return Math.max(MEMORY_MIN_MIB, Math.min(MEMORY_MAX_MIB, mib));
}

/**
 * Strict validation for manual UI input (integer MiB in [MEMORY_MIN_MIB, MEMORY_MAX_MIB]).
 */
export function validateCustomMemoryInput(
  raw: string,
): { ok: true; mib: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: `请输入 ${MEMORY_MIN_MIB} ～ ${MEMORY_MAX_MIB} 之间的内存大小 (MiB)`,
    };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "内存大小需为正整数 (单位 MiB)" };
  }
  const mib = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(mib) || mib < MEMORY_MIN_MIB || mib > MEMORY_MAX_MIB) {
    return {
      ok: false,
      error: `内存大小需在 ${MEMORY_MIN_MIB} ～ ${MEMORY_MAX_MIB} MiB 之间`,
    };
  }
  return { ok: true, mib };
}

/** Format MiB nicely for labels (e.g. "512 MiB", "1024 MiB (1 GiB)"). */
export function formatMemoryLabel(mib: MemoryConfigMiB, autoFallbackMiB?: number): string {
  if (mib === null) {
    return autoFallbackMiB ? `自动 (${autoFallbackMiB} MiB)` : "自动";
  }
  if (mib >= 1024 && mib % 1024 === 0) {
    return `${mib} MiB (${mib / 1024} GiB)`;
  }
  return `${mib} MiB`;
}
