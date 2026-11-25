// SPDX-License-Identifier: MIT
// Kernel log buffer, /run/kw-base safe-mode parser, and byte formatting helpers.

export interface KernelLogEntry {
  time: number;
  line: string;
  important: boolean;
  source: "kernel" | "overlay";
}

export interface KwBaseInfo {
  name: string;
  image: string;
  upper: string;
  why: string;
  state: string;
  dev: string;
  fstype: string;
  safeMode: boolean;
}

const DEFAULT_MAX_LOG_ENTRIES = 500;

/** Bounded ring buffer of kernel and kw-overlay log lines. */
export class KernelLogBuffer {
  #maxEntries: number;
  #entries: KernelLogEntry[] = [];

  constructor(maxEntries = DEFAULT_MAX_LOG_ENTRIES) {
    this.#maxEntries = maxEntries;
  }

  push(entry: KernelLogEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) {
      this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    }
  }

  entries(): readonly KernelLogEntry[] {
    return this.#entries;
  }

  clear(): void {
    this.#entries = [];
  }

  importantCount(): number {
    let count = 0;
    for (const entry of this.#entries) {
      if (entry.important) count += 1;
    }
    return count;
  }

  format(importantOnly = false): string {
    const list = importantOnly ? this.#entries.filter((e) => e.important) : this.#entries;
    return list.map((e) => e.line).join("\n");
  }
}

/** Parse /run/kw-base key=value output and detect safe mode. */
export function parseKwBase(raw: string): KwBaseInfo {
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) fields[key] = val;
  }

  const name = fields.name ?? "";
  const image = fields.image ?? "";
  const upper = fields.upper ?? "";
  const why = fields.why ?? "";
  const state = fields.state ?? "";
  const dev = fields.dev ?? "";
  const fstype = fields.fstype ?? "";
  const safeMode =
    why.toLowerCase().startsWith("safe mode") ||
    (upper !== "" && upper !== "data" && Boolean(why));

  return { name, image, upper, why, state, dev, fstype, safeMode };
}

/** Format byte counts cleanly for block / SHM throughput counters. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${(bytes / 1073741824).toFixed(2)} GiB`;
}
