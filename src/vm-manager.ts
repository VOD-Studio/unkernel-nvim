// SPDX-License-Identifier: MIT
// WorkerKernel lifecycle, zero-download IndexedDB fast boot, PTY session
// orchestration, snapshot management, and local directory mounting.

import {
  checkSupport,
  createKernel,
  decodeSnapshot,
  encodeSnapshot,
  gzipBlob,
  importDataDisk,
  kwsparseHeader,
  resetDataDisk,
  WorkerKernel,
  type BootProgress,
  type DiskSpec,
  type InstanceStats,
  type KernelHandle,
  type Mount,
  type NetSpec,
  type Pty,
  type PtyEnd,
} from "unkernel";
import { BrowserDirectoryFs } from "./fs-bridge.ts";

export const DISK_NAME = "unkernel-nvim";
export const DISK_VERSION = "v1";
export const DISK_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB kwdata template size
export const PREBAKED_DISK_URL = "/nvim-data.kwsparse.gz";
const SNAPSHOT_DB_NAME = "unkernel-nvim-snapshots";
const SNAPSHOT_STORE = "snapshots";
const SNAPSHOT_KEY = "latest";

export interface BootStatusUpdate {
  phase: "check" | "disk-check" | "disk-download" | "compile" | "boot" | "userspace" | "ready";
  title: string;
  detail?: string;
  progress?: number; // 0..1
}

export interface MountedFolder {
  name: string;
  guestPath: string;
  mount: Mount;
}

/**
 * Fast probe of IndexedDB `kwdisk:unkernel-nvim-v1` to check whether the
 * persistent data disk has already been seeded on a previous visit.
 * When true, we pass a 24-byte empty kwsparse header as `template`, skipping
 * the 44 MiB `/nvim-data.kwsparse.gz` download completely!
 */
export async function isDataDiskSeeded(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const dbName = `kwdisk:${DISK_NAME}-${DISK_VERSION}`;
  return new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        // DB did not exist yet; abort creation so openDataDisk initializes it cleanly.
        req.transaction?.abort();
        resolve(false);
      };
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains("meta")) {
            db.close();
            resolve(false);
            return;
          }
          const tx = db.transaction("meta", "readonly");
          const getReq = tx.objectStore("meta").get("initialized");
          getReq.onsuccess = () => {
            db.close();
            resolve(getReq.result === true);
          };
          getReq.onerror = () => {
            db.close();
            resolve(false);
          };
        } catch {
          db.close();
          resolve(false);
        }
      };
    } catch {
      resolve(false);
    }
  });
}

async function fetchTemplateWithProgress(
  url: string,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载预烘焙镜像失败 (${res.status} ${res.statusText}): 请确认已执行 pnpm prebake 生成 public/nvim-data.kwsparse.gz`);
  }
  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class VmManager {
  vm: KernelHandle | null = null;
  activePty: Pty | null = null;
  currentMode: "nvim" | "shell" = "nvim";
  currentCwd = "/workspace";
  mountedFolders: Map<string, MountedFolder> = new Map();
  wispUrl: string = localStorage.getItem("unkernel-nvim.wisp") ?? "";
  seededFromCache = false;

  #onStatus: (s: BootStatusUpdate) => void;
  #onSessionExit?: (mode: "nvim" | "shell", end: PtyEnd) => void;

  constructor(opts: {
    onStatus: (s: BootStatusUpdate) => void;
    onSessionExit?: (mode: "nvim" | "shell", end: PtyEnd) => void;
  }) {
    this.#onStatus = opts.onStatus;
    this.#onSessionExit = opts.onSessionExit;
  }

  async boot(cols: number, rows: number): Promise<void> {
    this.#onStatus({ phase: "check", title: "检查浏览器 WebAssembly / JSPI 环境…" });
    const support = await checkSupport();
    if (!support.ok) {
      throw new Error(`当前浏览器缺少必要特性:\n${support.problems.join("\n")}`);
    }

    this.#onStatus({ phase: "disk-check", title: "检查本地 IndexedDB 持久化镜像…" });
    const alreadySeeded = await isDataDiskSeeded();
    this.seededFromCache = alreadySeeded;

    let templateBytes: Uint8Array;
    if (alreadySeeded) {
      // 24-byte empty kwsparse header with matching 4 GiB size: zero download!
      templateBytes = kwsparseHeader(DISK_SIZE_BYTES, 4096, []);
      this.#onStatus({
        phase: "compile",
        title: "已命中本地持久化磁盘，跳过镜像下载",
        detail: "0 B 下载 · 直接挂载 IndexedDB",
      });
    } else {
      this.#onStatus({
        phase: "disk-download",
        title: "首次启动：正在加载预烘焙 Neovim + Alpine 镜像…",
        detail: "包含 Neovim 0.12.2、DefectingCat/nvim、13 个插件、24 个 Treesitter 解析器与 LuaLS",
        progress: 0,
      });
      templateBytes = await fetchTemplateWithProgress(PREBAKED_DISK_URL, (loaded, total) => {
        const mb = (loaded / 1048576).toFixed(1);
        const totalMb = total ? (total / 1048576).toFixed(1) : null;
        this.#onStatus({
          phase: "disk-download",
          title: "首次启动：正在加载预烘焙 Neovim + Alpine 镜像…",
          detail: totalMb ? `${mb} / ${totalMb} MiB` : `${mb} MiB`,
          progress: total ? Math.min(1, loaded / total) : undefined,
        });
      });
    }

    const diskSpec: DiskSpec = {
      kind: "data",
      name: DISK_NAME,
      version: DISK_VERSION,
      template: templateBytes,
      mode: "persistent",
    };

    const netSpec: NetSpec | undefined = this.wispUrl.trim()
      ? {
          kind: "net",
          backend: {
            kind: "wisp",
            servers: this.wispUrl
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          },
          optional: true,
        }
      : undefined;

    const onProgress = (p: BootProgress) => {
      if (p.stage === "download") {
        const mb = (p.loaded / 1048576).toFixed(1);
        this.#onStatus({
          phase: "compile",
          title: "正在流式加载并编译 Linux Wasm 内核…",
          detail: `${mb} MiB`,
        });
      } else if (p.stage === "compile") {
        this.#onStatus({ phase: "compile", title: "正在编译 Linux Wasm 内核…" });
      } else if (p.stage === "memory") {
        this.#onStatus({
          phase: "boot",
          title: `已分配 ${p.mib} MiB 虚拟机内存，正在引导内核…`,
        });
      } else if (p.stage === "start") {
        this.#onStatus({
          phase: "boot",
          title: alreadySeeded ? "正在挂载持久化 Overlay 根文件系统…" : "正在写入首次持久化缓存并引导 Alpine…",
        });
      }
    };

    this.vm = await createKernel({
      worker: true,
      jit: true,
      vsock: true,
      consoleSize: { cols, rows },
      disks: [diskSpec],
      net: netSpec,
      onProgress,
      log: (m) => console.debug(m),
    });

    // Sync disk automatically when page becomes hidden
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        void this.syncDisk();
      }
    });
    window.addEventListener("pagehide", () => {
      void this.syncDisk();
    });
  }

  async startSession(
    mode: "nvim" | "shell",
    size: { cols: number; rows: number; xpixel?: number; ypixel?: number },
    targetPath?: string,
  ): Promise<Pty> {
    if (!this.vm) throw new Error("Kernel is not running");
    if (this.activePty) {
      await this.activePty.close().catch(() => {});
      this.activePty = null;
    }

    this.currentMode = mode;
    const cwd = targetPath ?? this.currentCwd;
    this.currentCwd = cwd;

    this.#onStatus({
      phase: "userspace",
      title: mode === "nvim" ? "正在启动 Neovim…" : "正在启动 Alpine Shell…",
      detail: cwd,
    });

    const file = mode === "nvim" ? "/usr/bin/nvim" : "/bin/sh";
    const args = mode === "nvim" ? [] : ["-l"];

    const pty = await this.vm.spawn(file, args, {
      cols: size.cols,
      rows: size.rows,
      xpixel: size.xpixel,
      ypixel: size.ypixel,
      cwd,
      term: "xterm-256color",
      env: {
        HOME: "/root",
        USER: "root",
        LOGNAME: "root",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: "C.UTF-8",
      },
    });

    this.activePty = pty;
    void pty.ended.then(
      (end) => {
        if (this.activePty === pty) {
          this.activePty = null;
          this.#onSessionExit?.(mode, end);
        }
      },
      () => {},
    );

    this.#onStatus({ phase: "ready", title: "Ready" });
    return pty;
  }

  async mountHostDirectory(dirFs: BrowserDirectoryFs): Promise<MountedFolder> {
    if (!this.vm) throw new Error("Kernel is not running");
    const safeName = dirFs.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
    const guestPath = `/workspace/${safeName}`;

    const existing = this.mountedFolders.get(guestPath);
    if (existing) {
      await existing.mount.unmount().catch(() => {});
      this.mountedFolders.delete(guestPath);
    }

    const mount = await this.vm.mount(guestPath, dirFs, { readOnly: false });
    const entry: MountedFolder = { name: dirFs.name, guestPath, mount };
    this.mountedFolders.set(guestPath, entry);
    return entry;
  }

  async syncDisk(): Promise<boolean> {
    if (!this.vm) return false;
    return this.vm.sync({ timeout: 5000 }).catch(() => false);
  }

  async exportDiskImage(): Promise<{ name: string; bytes: number; blocks: number }> {
    if (!(this.vm instanceof WorkerKernel)) {
      throw new Error("内核未运行在 Worker 模式");
    }
    await this.syncDisk();
    const { parts, blocks } = await this.vm.exportDisk(0);
    const blob = await gzipBlob(parts);
    const name = `unkernel-nvim-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.kwsparse.gz`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    return { name, bytes: blob.size, blocks };
  }

  async importDiskImage(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (this.vm instanceof WorkerKernel) {
      await this.vm.detachDisk(0).catch(() => {});
      await this.vm.stop().catch(() => {});
    }
    await importDataDisk(bytes, { name: DISK_NAME, version: DISK_VERSION, size: DISK_SIZE_BYTES });
    location.reload();
  }

  async resetToFactoryDisk(): Promise<void> {
    if (this.vm instanceof WorkerKernel) {
      await this.vm.detachDisk(0).catch(() => {});
      await this.vm.stop().catch(() => {});
    }
    await resetDataDisk({ name: DISK_NAME, version: DISK_VERSION });
    await this.clearSnapshot().catch(() => {});
    location.reload();
  }

  async saveMemorySnapshot(): Promise<{ bytes: number }> {
    if (!this.vm) throw new Error("Kernel is not running");
    if (this.mountedFolders.size > 0) {
      throw new Error("挂载了本地宿主机目录时不支持保存内存快照，请先卸载本地目录或直接使用磁盘持久化 (Sync)。");
    }
    const snap = await this.vm.snapshot({ stop: false });
    const encoded = encodeSnapshot(snap);
    await saveSnapshotBytes(encoded);
    return { bytes: encoded.byteLength };
  }

  async clearSnapshot(): Promise<void> {
    await deleteSnapshotBytes();
  }

  getStats(): {
    transport: string;
    memoryMiB: number;
    crossOriginIsolated: boolean;
    stats: InstanceStats | null;
    diskBlocks: number;
  } {
    const stats = this.vm ? this.vm.stats() : null;
    let diskBlocks = 0;
    if (this.vm instanceof WorkerKernel && this.vm.disks[0]) {
      diskBlocks = this.vm.disks[0].overlayBlocks ?? 0;
    }
    return {
      transport: this.vm?.transport ?? "unknown",
      memoryMiB: this.vm?.memoryMiB ?? 0,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      stats,
      diskBlocks,
    };
  }
}

function openSnapshotDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SNAPSHOT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SNAPSHOT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSnapshotBytes(bytes: Uint8Array): Promise<void> {
  const db = await openSnapshotDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
      tx.objectStore(SNAPSHOT_STORE).put(bytes, SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteSnapshotBytes(): Promise<void> {
  const db = await openSnapshotDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
      tx.objectStore(SNAPSHOT_STORE).delete(SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export { decodeSnapshot };
