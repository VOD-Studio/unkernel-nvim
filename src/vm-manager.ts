// SPDX-License-Identifier: MIT
// WorkerKernel lifecycle, zero-download IndexedDB fast boot, PTY session
// orchestration, snapshot management, and local directory mounting.

import {
  autoMemoryMiB,
  bundledKernelUrl,
  checkSupport,
  createKernel,
  decodeSnapshot,
  download,
  encodeSnapshot,
  gzipBlob,
  importDataDisk,
  kwsparseHeader,
  loadKernelModule,
  resetDataDisk,
  webCpuBlocker,
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
import { DEFAULT_DISTRO, DISTROS, isDistro, type Distro } from "./distro.ts";
import { BrowserDirectoryFs } from "./fs-bridge.ts";
import {
  MEMORY_FALLBACK_MIB,
  MEMORY_STORAGE_KEY,
  parseMemorySpec,
  type MemoryConfigMiB,
} from "./memory-config.ts";

const DISK_VERSION = "v2"; // aarch64 + unkernel 0.2.0 distro overlay layout
const DISK_SIZE_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_SHELL = "/usr/bin/fish";
const FALLBACK_SHELL = "/bin/sh";
const CPU_STORAGE_KEY = "unkernel-nvim.cpus";
const DISTRO_STORAGE_KEY = "unkernel-nvim.distro";
const MAX_CPUS = 16; // CONFIG_NR_CPUS in the upstream SMP kernel
const SNAPSHOT_DB_NAME = "unkernel-nvim-snapshots";
const SNAPSHOT_STORE = "snapshots";

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
 * Fast probe of the distro's IndexedDB disk to check whether the
 * persistent data disk has already been seeded on a previous visit.
 * An initialized disk only needs a size-matched empty template.
 */
async function isDataDiskSeeded(name: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const dbName = `kwdisk:${name}-${DISK_VERSION}`;
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

export type NetMode = "builtin" | "custom" | "off";

export function getSameOriginWispUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/wisp`;
}

function loadInitialNetMode(savedCustomUrl: string): NetMode {
  const stored = localStorage.getItem("unkernel-nvim.netMode");
  if (stored === "builtin" || stored === "custom" || stored === "off") {
    return stored;
  }
  return savedCustomUrl.trim() ? "custom" : "builtin";
}

function loadStoredMemoryConfig(): MemoryConfigMiB {
  const parsed = parseMemorySpec(localStorage.getItem(MEMORY_STORAGE_KEY));
  return parsed === undefined ? null : parsed;
}

function loadUrlMemoryOverride(): MemoryConfigMiB | undefined {
  const param = new URLSearchParams(location.search).get("mem");
  if (param === null) return undefined;
  return parseMemorySpec(param);
}

function loadDistro(): Distro {
  const value = localStorage.getItem(DISTRO_STORAGE_KEY);
  return isDistro(value) ? value : DEFAULT_DISTRO;
}

export class VmManager {
  vm: KernelHandle | null = null;
  activePty: Pty | null = null;
  currentMode: "nvim" | "shell" = "nvim";
  currentCwd = "/workspace";
  mountedFolders: Map<string, MountedFolder> = new Map();
  wispUrl: string = localStorage.getItem("unkernel-nvim.wisp") ?? "";
  netMode: NetMode = loadInitialNetMode(this.wispUrl);
  #bootedNetwork: { mode: NetMode; servers: string[] } | null = null;
  readonly cpuBlocker = webCpuBlocker({ worker: true });
  readonly cpuLimit = this.cpuBlocker ? 1 : Math.min(navigator.hardwareConcurrency || 1, MAX_CPUS);
  #distro = loadDistro();
  #bootDistro: Distro | null = null;
  #cpuCount = this.#loadCpuCount();
  #bootCpuCount: number | null = null;
  #onlineCpuCount: number | null = null;
  #shellPath: string | null = null;
  memoryConfigMiB: MemoryConfigMiB = loadStoredMemoryConfig();
  urlMemoryOverride: MemoryConfigMiB | undefined = loadUrlMemoryOverride();
  memoryRequestedMiB: number | null = null;
  memoryAllocatedMiB: number | null = null;
  memoryFallbackReasons: string[] = [];
  seededFromCache = false;

  get distro(): Distro {
    return this.#distro;
  }

  get activeDistro(): Distro {
    return this.#bootDistro ?? this.#distro;
  }

  get shellPath(): string {
    return this.#shellPath ?? DEFAULT_SHELL;
  }

  get shellName(): string {
    return this.shellPath.split("/").pop() || "sh";
  }

  setDistro(distro: Distro): void {
    localStorage.setItem(DISTRO_STORAGE_KEY, distro);
    this.#distro = distro;
  }

  hasPendingDistroChange(): boolean {
    return this.activeDistro !== this.#distro;
  }

  #loadCpuCount(): number {
    const stored = Number(localStorage.getItem(CPU_STORAGE_KEY));
    return Number.isInteger(stored) && stored >= 1 ? Math.min(stored, this.cpuLimit) : 1;
  }

  get cpuCount(): number {
    return this.#cpuCount;
  }

  setCpuCount(cpus: number): void {
    if (!Number.isInteger(cpus) || cpus < 1 || cpus > this.cpuLimit) return;
    localStorage.setItem(CPU_STORAGE_KEY, String(cpus));
    this.#cpuCount = cpus;
  }

  hasPendingCpuChange(): boolean {
    return this.#bootCpuCount !== null && this.#cpuCount !== this.#bootCpuCount;
  }

  getAutoMemoryInfo(): { mib: number; why: string } {
    return autoMemoryMiB();
  }

  getEffectiveMemoryConfig(): MemoryConfigMiB {
    return this.urlMemoryOverride !== undefined ? this.urlMemoryOverride : this.memoryConfigMiB;
  }

  getTargetMemoryMiB(): number {
    return this.getEffectiveMemoryConfig() ?? this.getAutoMemoryInfo().mib;
  }

  hasUrlMemoryOverride(): boolean {
    return this.urlMemoryOverride !== undefined;
  }

  setMemoryConfig(mib: MemoryConfigMiB): void {
    this.memoryConfigMiB = mib;
    this.urlMemoryOverride = undefined;
    if (mib === null) localStorage.removeItem(MEMORY_STORAGE_KEY);
    else localStorage.setItem(MEMORY_STORAGE_KEY, String(mib));

    const url = new URL(location.href);
    if (url.searchParams.has("mem")) {
      url.searchParams.delete("mem");
      history.replaceState(null, "", url.toString());
    }
  }

  didMemoryFallback(): boolean {
    return (
      this.memoryRequestedMiB !== null &&
      this.memoryAllocatedMiB !== null &&
      this.memoryAllocatedMiB !== this.memoryRequestedMiB
    );
  }

  hasPendingMemoryChange(): boolean {
    if (!this.vm) return false;
    const nextTarget = this.getTargetMemoryMiB();
    const runningMiB = this.vm.memoryMiB;
    const bootedTarget = this.memoryRequestedMiB ?? runningMiB;
    return nextTarget !== bootedTarget && nextTarget !== runningMiB;
  }

  getEffectiveWispServers(): string[] {
    if (this.netMode === "off") return [];
    if (this.netMode === "builtin") return [getSameOriginWispUrl()];
    return this.wispUrl
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  hasPendingNetworkChange(): boolean {
    const network = this.#bootedNetwork;
    if (!this.vm || !network) return false;
    if (this.netMode !== network.mode) return true;
    const nextServers = this.getEffectiveWispServers();
    return nextServers.length !== network.servers.length ||
      nextServers.some((server, i) => server !== network.servers[i]);
  }

  hasPendingRestartChanges(): boolean {
    return this.hasPendingDistroChange() || this.hasPendingCpuChange() ||
      this.hasPendingMemoryChange() || this.hasPendingNetworkChange();
  }

  setNetworkConfig(mode: NetMode, customUrl?: string): void {
    this.netMode = mode;
    localStorage.setItem("unkernel-nvim.netMode", mode);
    if (customUrl !== undefined) {
      const val = customUrl.trim();
      this.wispUrl = val;
      if (val) localStorage.setItem("unkernel-nvim.wisp", val);
      else localStorage.removeItem("unkernel-nvim.wisp");
    }
  }

  #onStatus: (s: BootStatusUpdate) => void;
  #onSessionExit?: (mode: "nvim" | "shell", end: PtyEnd) => void;

  constructor(opts: {
    onStatus: (s: BootStatusUpdate) => void;
    onSessionExit?: (mode: "nvim" | "shell", end: PtyEnd) => void;
  }) {
    this.#onStatus = opts.onStatus;
    this.#onSessionExit = opts.onSessionExit;
  }

  async #prepareDataDisk(distro: Distro, signal: AbortSignal): Promise<Uint8Array> {
    const { diskName, label, template } = DISTROS[distro];
    this.#onStatus({ phase: "disk-check", title: `检查 ${label} 持久化磁盘…` });
    this.seededFromCache = await isDataDiskSeeded(diskName);
    signal.throwIfAborted();
    let bytes: Uint8Array;
    if (this.seededFromCache) {
      bytes = kwsparseHeader(DISK_SIZE_BYTES, 4096, []);
    } else {
      const title = `首次启动：正在加载 ${label} 的 Neovim 镜像…`;
      this.#onStatus({ phase: "disk-download", title, progress: 0 });
      let lastUpdate = performance.now();
      try {
        bytes = await download(template, {
          signal,
          onProgress: ({ loaded, total, done }) => {
            const now = performance.now();
            if (!done && now - lastUpdate < 50) return;
            lastUpdate = now;
            const mib = (loaded / 1048576).toFixed(1);
            this.#onStatus({
              phase: "disk-download",
              title,
              detail: total ? `${mib} / ${(total / 1048576).toFixed(1)} MiB` : `${mib} MiB`,
              progress: total ? Math.min(1, loaded / total) : undefined,
            });
          },
        });
      } catch (err) {
        throw new Error(`无法下载 ${label} 磁盘模板 (${template})，请确认已执行 bun run prebake ${distro}。`, { cause: err });
      }
    }
    this.#onStatus({
      phase: "compile",
      title: "正在准备 Linux Wasm 内核…",
      detail: this.seededFromCache ? `已找到 ${label} 持久化磁盘` : `${label} 数据盘已下载`,
    });
    return bytes;
  }

  async boot(cols: number, rows: number): Promise<void> {
    const distro = this.#distro;
    const { diskName, image, label } = DISTROS[distro];
    this.#bootDistro = distro;
    const cpus = this.#cpuCount;
    this.#bootCpuCount = cpus;
    this.#onlineCpuCount = null;
    this.#onStatus({ phase: "check", title: "检查浏览器 WebAssembly / JSPI 环境…" });
    const support = await checkSupport();
    if (!support.ok) {
      throw new Error(`当前浏览器缺少必要特性:\n${support.problems.join("\n")}`);
    }

    // Download the kernel while probing or fetching the distro's data disk.
    const loading = new AbortController();
    let kernel: WebAssembly.Module;
    let templateBytes: Uint8Array;
    try {
      [kernel, templateBytes] = await Promise.all([
        loadKernelModule(bundledKernelUrl, { smp: cpus > 1, signal: loading.signal }),
        this.#prepareDataDisk(distro, loading.signal),
      ]);
    } catch (err) {
      loading.abort();
      throw err;
    }

    const diskSpec: DiskSpec = {
      kind: "data",
      name: diskName,
      version: DISK_VERSION,
      template: templateBytes,
      mode: "persistent",
    };

    const wispServers = this.getEffectiveWispServers();
    const network = { mode: this.netMode, servers: [...wispServers] };
    const netSpec: NetSpec | undefined =
      wispServers.length > 0
        ? {
            kind: "net",
            backend: {
              kind: "wisp",
              servers: wispServers,
            },
            optional: true,
          }
        : undefined;

    const onProgress = (p: BootProgress) => {
      if (p.stage === "memory") {
        this.memoryRequestedMiB = p.requestedMiB;
        this.memoryAllocatedMiB = p.mib;
        this.memoryFallbackReasons = [...p.failures];
        const fellBack = p.mib !== p.requestedMiB;
        this.#onStatus({
          phase: "boot",
          title: fellBack
            ? `目标 ${p.requestedMiB} MiB 内存分配失败，已自动回退至 ${p.mib} MiB…`
            : `已分配 ${p.mib} MiB 虚拟机内存，正在引导内核…`,
          detail: fellBack ? p.failures[0] : undefined,
        });
      } else if (p.stage === "start") {
        this.#onStatus({
          phase: "boot",
          title: this.seededFromCache ? `正在挂载 ${label} 持久化磁盘…` : `正在初始化持久化磁盘并引导 ${label}…`,
        });
      }
    };

    const effectiveMemory = this.getEffectiveMemoryConfig();
    const targetMemoryMiB = effectiveMemory ?? this.getAutoMemoryInfo().mib;
    this.memoryRequestedMiB = null;
    this.memoryAllocatedMiB = null;
    this.memoryFallbackReasons = [];

    const vm = await createKernel({
      kernel,
      worker: true,
      distro: image,
      cpus,
      jit: true,
      vsock: true,
      ...(effectiveMemory !== null ? { memoryMiB: effectiveMemory } : {}),
      memoryFallbackMiB: [...MEMORY_FALLBACK_MIB],
      consoleSize: { cols, rows },
      disks: [diskSpec],
      net: netSpec,
      onProgress,
      log: (m) => console.debug(m),
    });
    this.vm = vm;
    this.#bootedNetwork = network;
    this.#shellPath = null;
    void this.#resolveShell(vm);

    if (cpus > 1) {
      void vm.exec("/usr/bin/nproc", [], { signal: AbortSignal.timeout(2000) }).then((result) => {
        const online = Number(result.stdout.trim());
        if (this.vm === vm && result.exitCode === 0 && Number.isInteger(online) && online >= 1 && online <= cpus) {
          this.#onlineCpuCount = online;
        }
      }).catch(() => {});
    }

    if (this.memoryAllocatedMiB === null) {
      this.memoryAllocatedMiB = this.vm.memoryMiB;
    }
    if (this.memoryRequestedMiB === null) {
      this.memoryRequestedMiB = targetMemoryMiB;
    }

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

  async #resolveShell(vm: KernelHandle | null = this.vm): Promise<string> {
    if (!vm) return FALLBACK_SHELL;
    if (this.vm === vm && this.#shellPath === DEFAULT_SHELL) {
      return DEFAULT_SHELL;
    }
    try {
      const res = await vm.exec("/bin/sh", ["-c", `test -x ${DEFAULT_SHELL}`], {
        user: "root",
        signal: AbortSignal.timeout(2000),
      });
      const resolved = res.exitCode === 0 ? DEFAULT_SHELL : FALLBACK_SHELL;
      if (this.vm === vm) this.#shellPath = resolved;
      return resolved;
    } catch {
      if (this.vm === vm && this.#shellPath === null) {
        this.#shellPath = FALLBACK_SHELL;
      }
      return this.#shellPath ?? FALLBACK_SHELL;
    }
  }

  async startSession(
    mode: "nvim" | "shell",
    size: { cols: number; rows: number; xpixel?: number; ypixel?: number },
    targetPath?: string,
  ): Promise<Pty> {
    if (!this.vm) throw new Error("Kernel is not running");
    const previousPty = this.activePty;
    if (previousPty) {
      this.activePty = null;
      await previousPty.close().catch(() => {});
    }

    const cwd = targetPath ?? this.currentCwd;
    const shell = await this.#resolveShell(this.vm);

    this.#onStatus({
      phase: "userspace",
      title: mode === "nvim" ? "正在启动 Neovim…" : `正在启动 ${DISTROS[this.activeDistro].label} Shell…`,
      detail: cwd,
    });

    const file = mode === "nvim" ? "/usr/bin/nvim" : shell;
    const args = mode === "nvim" ? [] : ["-l"];

    const pty = await this.vm.spawn(file, args, {
      user: "root",
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
        SHELL: shell,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: "C.UTF-8",
      },
    });

    this.currentMode = mode;
    this.currentCwd = cwd;
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
    const name = `unkernel-nvim-${this.activeDistro}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.kwsparse.gz`;
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
    await importDataDisk(bytes, { name: DISTROS[this.activeDistro].diskName, version: DISK_VERSION, size: DISK_SIZE_BYTES });
    location.reload();
  }

  async syncAndReload(): Promise<void> {
    const vm = this.vm;
    if (vm) {
      if (!(await this.syncDisk())) throw new Error("磁盘同步未完成，请重试");
      // The guest clears the overlay boot counter during an orderly shutdown.
      void vm.exec("/usr/local/sbin/poweroff", [], { user: "root" }).catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          vm.exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("虚拟机关闭超时，请重试")), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    location.reload();
  }

  async resetToFactoryDisk(): Promise<void> {
    if (this.vm instanceof WorkerKernel) {
      await this.vm.detachDisk(0).catch(() => {});
      await this.vm.stop().catch(() => {});
    }
    await resetDataDisk({ name: DISTROS[this.activeDistro].diskName, version: DISK_VERSION });
    await this.clearSnapshot().catch(() => {});
    location.reload();
  }

  async saveMemorySnapshot(): Promise<{ bytes: number }> {
    if (!this.vm) throw new Error("Kernel is not running");
    if ((this.#bootCpuCount ?? 1) > 1) {
      throw new Error("多核模式暂不支持内存快照，可使用磁盘同步保存文件。");
    }
    if (this.mountedFolders.size > 0) {
      throw new Error("挂载了本地宿主机目录时不支持保存内存快照，请先卸载本地目录或直接使用磁盘持久化 (Sync)。");
    }
    const snap = await this.vm.snapshot({ stop: false });
    const encoded = encodeSnapshot(snap);
    await saveSnapshotBytes(snapshotKey(this.activeDistro), encoded);
    return { bytes: encoded.byteLength };
  }

  async clearSnapshot(): Promise<void> {
    await deleteSnapshotBytes(snapshotKey(this.activeDistro));
  }

  getStats(): {
    transport: string;
    cpus: number | null;
    memoryMiB: number;
    memoryRequestedMiB: number;
    memoryFallback: boolean;
    memoryFallbackReason: string | null;
    crossOriginIsolated: boolean;
    stats: InstanceStats | null;
    diskBlocks: number;
  } {
    const stats = this.vm ? this.vm.stats() : null;
    let diskBlocks = 0;
    if (this.vm instanceof WorkerKernel && this.vm.disks[0]) {
      diskBlocks = this.vm.disks[0].overlayBlocks ?? 0;
    }
    const memoryMiB = this.vm?.memoryMiB ?? 0;
    return {
      transport: this.vm?.transport ?? "unknown",
      cpus: this.#onlineCpuCount ?? stats?.cpus ?? null,
      memoryMiB,
      memoryRequestedMiB: this.memoryRequestedMiB ?? memoryMiB,
      memoryFallback: this.didMemoryFallback(),
      memoryFallbackReason: this.memoryFallbackReasons[0] ?? null,
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

function snapshotKey(distro: Distro): string {
  return distro === "alpine" ? "latest" : distro;
}

async function saveSnapshotBytes(key: string, bytes: Uint8Array): Promise<void> {
  const db = await openSnapshotDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
      tx.objectStore(SNAPSHOT_STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteSnapshotBytes(key: string): Promise<void> {
  const db = await openSnapshotDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
      tx.objectStore(SNAPSHOT_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export { decodeSnapshot };
