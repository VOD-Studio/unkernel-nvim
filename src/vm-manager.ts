// SPDX-License-Identifier: MIT
// WorkerKernel lifecycle, zero-download IndexedDB fast boot, PTY session
// orchestration, snapshot management, and local directory mounting.

import {
  autoMemoryMiB,
  bundledKernelUrl,
  checkSupport,
  createKernel,
  decodeKwsparse,
  decodeSnapshot,
  download,
  gzipBlob,
  gunzipIfNeeded,
  importDataDisk,
  kwsparseHeader,
  loadKernelModule,
  resetDataDisk,
  serveWasiPrograms,
  webCpuBlocker,
  WorkerKernel,
  type BootProgress,
  type CommandsOption,
  type DiskSpec,
  type InstanceStats,
  type KernelHandle,
  type KernelSnapshot,
  type Mount,
  type NetSpec,
  type Pty,
  type PtyEnd,
  type PtySize,
  type WasiExecServer,
} from "unkernel";
import { DEFAULT_DISTRO, DISTROS, isDistro, releaseGuestAssetPath, type Distro } from "./distro.ts";
import { DEFAULT_DISK_GIB, GIB, MAX_DISK_GIB, parseDiskGiB } from "./disk-config.ts";
import { BrowserDirectoryFs } from "./fs-bridge.ts";
import { sanitizeDropFilename } from "./host-commands.ts";
import {
  MEMORY_FALLBACK_MIB,
  MEMORY_STORAGE_KEY,
  parseMemorySpec,
  type MemoryConfigMiB,
} from "./memory-config.ts";
import {
  DEFAULT_SHELL,
  SHELL_PROBE_SCRIPT,
  SHELL_PROBE_TIMEOUT_MS,
  getShellCandidatesToTry,
  isShellNotFoundError,
  parseResolvedShell,
} from "./shell-config.ts";
import {
  deleteSuspendedSession,
  readSuspendedSession,
  ResumeSessionError,
  writeSuspendedSession,
  type SessionMetadata,
  type SuspendedSession,
} from "./suspended-session.ts";
import {
  MAX_TERMINAL_SESSIONS,
  nextSessionTitle,
  pickNextActiveSessionId,
  reconcileRestoredSessions,
  type SessionMode,
  type SuspendedTerminalEntry,
  type TerminalSessionRecord,
} from "./terminal-sessions.ts";

export interface TerminalSession extends TerminalSessionRecord {
  pty: Pty | null;
}

const DISK_VERSION = "v2"; // aarch64 + unkernel 0.2.0 distro overlay layout
const DISK_SIZE_BYTES = DEFAULT_DISK_GIB * GIB;
const CPU_STORAGE_KEY = "unkernel-nvim.cpus";
const DISTRO_STORAGE_KEY = "unkernel-nvim.distro";
const MAX_CPUS = 16; // CONFIG_NR_CPUS in the upstream SMP kernel

function acquireDiskLock(name: string): Promise<() => void> {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`kwdisk:${name}-${DISK_VERSION}`, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("此发行版的持久化磁盘正在另一个标签页使用，请关闭该标签页后刷新。");
      return new Promise<void>((release) => resolve(release));
    }).catch(reject);
  });
}

function diskSizeKey(distro: Distro): string {
  return `unkernel-nvim.diskSizeGiB.${distro}`;
}

export interface BootStatusUpdate {
  phase: "check" | "disk-check" | "disk-download" | "compile" | "boot" | "userspace" | "ready" | "suspended";
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
  const url = new URL("wisp", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function getGuestAssetUrl(asset: string): string {
  const relativePath = import.meta.env.DEV ? asset.slice(1) : releaseGuestAssetPath(asset);
  return new URL(relativePath, location.href).href;
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
  #sessions: TerminalSession[] = [];
  #activeSessionId: string | null = null;
  #nextSessionSeq = 1;
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
  #suspending = false;
  #shellPath: string | null = null;
  #shellProbe: Promise<string | null> | null = null;
  #commands?: CommandsOption;
  #wasiServer: WasiExecServer | null = null;
  memoryConfigMiB: MemoryConfigMiB = loadStoredMemoryConfig();
  urlMemoryOverride: MemoryConfigMiB | undefined = loadUrlMemoryOverride();
  memoryRequestedMiB: number | null = null;
  memoryAllocatedMiB: number | null = null;
  memoryFallbackReasons: string[] = [];
  seededFromCache = false;

  get sessions(): readonly TerminalSession[] {
    return this.#sessions;
  }

  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  get activeSession(): TerminalSession | null {
    if (!this.#activeSessionId) return null;
    return this.#sessions.find((s) => s.id === this.#activeSessionId) ?? null;
  }

  get activePty(): Pty | null {
    return this.activeSession?.pty ?? null;
  }

  get currentMode(): SessionMode {
    return this.activeSession?.mode ?? "nvim";
  }

  get currentCwd(): string {
    return this.activeSession?.cwd ?? "/workspace";
  }

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
      this.hasPendingMemoryChange() || this.hasPendingNetworkChange() || this.hasPendingDiskSizeChange();
  }

  get diskSize(): number {
    return this.vm instanceof WorkerKernel ? this.vm.disks[0]?.size ?? DISK_SIZE_BYTES : DISK_SIZE_BYTES;
  }

  get targetDiskSize(): number {
    return Math.max(this.diskSize, this.#configuredDiskSize(this.activeDistro));
  }

  #configuredDiskSize(distro: Distro): number {
    return (parseDiskGiB(localStorage.getItem(diskSizeKey(distro))) ?? DEFAULT_DISK_GIB) * GIB;
  }

  setDiskSize(gib: number): boolean {
    if (!this.vm || !Number.isInteger(gib) || gib > MAX_DISK_GIB || gib * GIB < this.diskSize) return false;
    localStorage.setItem(diskSizeKey(this.activeDistro), String(gib));
    return true;
  }

  hasPendingDiskSizeChange(): boolean {
    return this.vm !== null && this.targetDiskSize > this.diskSize;
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
  #onSessionExit?: (session: TerminalSession, end: PtyEnd) => void;
  #onSessionsChange?: () => void;
  #onNotice?: (message: string) => void;

  constructor(opts: {
    onStatus: (s: BootStatusUpdate) => void;
    onSessionExit?: (session: TerminalSession, end: PtyEnd) => void;
    onSessionsChange?: () => void;
    onNotice?: (message: string) => void;
    commands?: CommandsOption;
  }) {
    this.#onStatus = opts.onStatus;
    this.#onSessionExit = opts.onSessionExit;
    this.#onSessionsChange = opts.onSessionsChange;
    this.#onNotice = opts.onNotice;
    this.#commands = opts.commands;
  }

  setCommands(commands: CommandsOption): void {
    this.#commands = commands;
  }

  #stopWasiServer(): void {
    this.#wasiServer?.close();
    this.#wasiServer = null;
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
        bytes = await download(getGuestAssetUrl(template), {
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

  async boot(cols: number, rows: number, pixels: Pick<PtySize, "xpixel" | "ypixel"> = {}): Promise<TerminalSession[]> {
    const distro = this.#distro;
    const release = await acquireDiskLock(DISTROS[distro].diskName);
    let saved: SuspendedSession | undefined;
    try {
      saved = await readSuspendedSession(distro);
      if (!saved) {
        await this.#boot(cols, rows);
        return [];
      }
      this.#onStatus({ phase: "boot", title: "正在读取挂起会话…" });
      const snapshot = decodeSnapshot(new Uint8Array(await saved.snapshot.arrayBuffer()));
      const vm = await this.#boot(cols, rows, snapshot, saved.network);
      await deleteSuspendedSession(distro, saved.id).catch(() => {
        this.#onNotice?.("会话已恢复，但无法清除旧快照");
      });
      const size = { cols, rows, ...pixels };
      const entries = reconcileRestoredSessions(saved.sessions, saved, snapshot.ttys);
      this.#shellPath = saved.shell;
      if (saved.shell !== DEFAULT_SHELL) {
        void this.#resolveShell(vm);
      }

      const restored: TerminalSession[] = [];
      for (const entry of entries) {
        try {
          const pty = await vm.attach(entry.terminalId, { ...size, timeout: 8000 });
          const session = this.#registerSession(pty, entry.mode, entry.cwd, {
            id: entry.id,
            title: entry.title,
            activate: false,
            ready: false,
          });
          restored.push(session);
        } catch {
          // Session already ended before or during restore
        }
      }

      if (restored.length > 0) {
        const activeSavedId = saved.activeSessionId;
        const preferred =
          (activeSavedId && restored.find((s) => s.id === activeSavedId)) ||
          restored[0]!;
        this.#activeSessionId = preferred.id;
        this.#onSessionsChange?.();
        this.#onStatus({ phase: "ready", title: "Ready" });
        if (restored.length < entries.length) {
          this.#onNotice?.(`已恢复 ${restored.length} / ${entries.length} 个终端会话`);
        }
        return restored;
      }

      if (entries.length > 0 || saved.terminalId) {
        this.#onNotice?.("虚拟机已恢复。原终端已结束，正在打开新会话。");
      }
      const fallback = await this.openSession(saved.mode, size, saved.cwd);
      return [fallback];
    } catch (err) {
      this.#stopWasiServer();
      this.#sessions = [];
      this.#activeSessionId = null;
      if (this.vm) await this.vm.stop().catch(() => {});
      this.vm = null;
      release();
      if (saved) throw new ResumeSessionError(err);
      throw err;
    }
  }

  async #boot(
    cols: number,
    rows: number,
    restore?: KernelSnapshot,
    network = { mode: this.netMode, servers: this.getEffectiveWispServers() },
  ): Promise<KernelHandle> {
    const distro = this.#distro;
    const { diskName, image, label } = DISTROS[distro];
    this.#bootDistro = distro;
    const cpus = restore ? restore.cpus ?? 1 : this.#cpuCount;
    if (cpus > this.cpuLimit) throw new Error(`该会话需要 ${cpus} 个 CPU 核，当前浏览器支持 ${this.cpuLimit} 核`);
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
      size: restore ? undefined : this.#configuredDiskSize(distro),
    };

    const netSpec: NetSpec | undefined =
      (restore ? restore.devices.network : network.servers.length > 0)
        ? {
            kind: "net",
            backend: {
              kind: "wisp",
              servers: network.servers,
            },
            mac: restore?.devices.network?.mac.map((byte) => byte.toString(16).padStart(2, "0")).join(":"),
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
          title: restore ? `正在恢复 ${label} 会话…` :
            this.seededFromCache ? `正在挂载 ${label} 持久化磁盘…` : `正在初始化持久化磁盘并引导 ${label}…`,
        });
      }
    };

    const effectiveMemory = this.getEffectiveMemoryConfig();
    const targetMemoryMiB = restore ? restore.memory.byteLength / 1048576 : effectiveMemory ?? this.getAutoMemoryInfo().mib;
    this.memoryRequestedMiB = null;
    this.memoryAllocatedMiB = null;
    this.memoryFallbackReasons = [];

    const vm = await createKernel({
      kernel,
      worker: true,
      transferRestore: true,
      restore,
      distro: getGuestAssetUrl(image),
      cpus,
      jit: true,
      vsock: true,
      commands: this.#commands,
      ...(effectiveMemory !== null ? { memoryMiB: effectiveMemory } : {}),
      memoryFallbackMiB: [...MEMORY_FALLBACK_MIB],
      consoleSize: { cols, rows },
      disks: [diskSpec],
      net: netSpec,
      onProgress,
      log: (m) => console.debug(m),
    });
    this.vm = vm;
    this.#stopWasiServer();
    if (vm.vsock) {
      try {
        const wasi = serveWasiPrograms(vm.vsock, { log: (m) => console.debug(m) });
        this.#wasiServer = wasi;
        void vm.exited.then(() => {
          if (this.#wasiServer === wasi) this.#stopWasiServer();
        });
      } catch (err) {
        console.warn("[wasi] Failed to start host WASI server:", err);
      }
    }
    this.#bootedNetwork = network;
    this.#shellPath = null;
    this.#shellProbe = null;
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
    return vm;
  }

  async #resolveShell(vm: KernelHandle | null = this.vm): Promise<string | null> {
    if (!vm) return null;
    if (this.vm === vm && this.#shellPath === DEFAULT_SHELL) {
      return DEFAULT_SHELL;
    }
    if (this.vm === vm && this.#shellProbe) {
      return this.#shellProbe;
    }

    const probe = this.#probeShell(vm);
    if (this.vm === vm) {
      this.#shellProbe = probe;
    }
    try {
      return await probe;
    } finally {
      if (this.vm === vm && this.#shellProbe === probe) {
        this.#shellProbe = null;
      }
    }
  }

  async #probeShell(vm: KernelHandle): Promise<string | null> {
    try {
      const res = await vm.exec("/bin/sh", ["-c", SHELL_PROBE_SCRIPT], {
        user: "root",
        timeout: SHELL_PROBE_TIMEOUT_MS,
        signal: AbortSignal.timeout(SHELL_PROBE_TIMEOUT_MS),
      });
      const resolved = res.exitCode === 0 ? parseResolvedShell(res.stdout) : null;
      if (resolved && this.vm === vm) {
        this.#shellPath = resolved;
      }
      return resolved;
    } catch {
      return null;
    }
  }

  async #readBaseShellReason(vm: KernelHandle): Promise<string | null> {
    try {
      const res = await vm.exec("/bin/sh", ["-c", "cat /run/kw-base"], {
        user: "root",
        signal: AbortSignal.timeout(1500),
      });
      if (res.exitCode !== 0) return null;
      let upper = "";
      let why = "";
      for (const line of res.stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key === "upper") upper = val;
        else if (key === "why") why = val;
      }
      if (upper === "none") return why || "回退到了基础 initramfs";
      return null;
    } catch {
      return null;
    }
  }

  async startSession(
    mode: SessionMode,
    size: { cols: number; rows: number; xpixel?: number; ypixel?: number },
    targetPath?: string,
  ): Promise<Pty> {
    const session = await this.openSession(mode, size, targetPath, {
      replaceSessionId: this.#activeSessionId ?? undefined,
    });
    return session.pty!;
  }

  async openSession(
    mode: SessionMode,
    size: { cols: number; rows: number; xpixel?: number; ypixel?: number },
    targetPath?: string,
    opts?: { replaceSessionId?: string; title?: string },
  ): Promise<TerminalSession> {
    if (!this.vm || this.#suspending) throw new Error("虚拟机当前无法打开终端");
    const replaceIdx = opts?.replaceSessionId
      ? this.#sessions.findIndex((s) => s.id === opts.replaceSessionId)
      : -1;
    if (replaceIdx === -1 && this.#sessions.length >= MAX_TERMINAL_SESSIONS) {
      throw new Error(`最多同时保留 ${MAX_TERMINAL_SESSIONS} 个终端会话，请先关闭其他标签页`);
    }

    if (replaceIdx >= 0) {
      const prev = this.#sessions[replaceIdx]!;
      const prevPty = prev.pty;
      prev.pty = null;
      prev.exited = true;
      if (prevPty) {
        await prevPty.close().catch(() => {});
      }
    }

    const cwd = targetPath ?? this.currentCwd;
    const resolvedShell = await this.#resolveShell(this.vm);

    this.#onStatus({
      phase: "userspace",
      title: mode === "nvim" ? "正在启动 Neovim…" : `正在启动 ${DISTROS[this.activeDistro].label} Shell…`,
      detail: cwd,
    });

    const spawnSession = (file: string, args: string[], shellEnv: string) =>
      this.vm!.spawn(file, args, {
        user: "root",
        detachable: true,
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
          SHELL: shellEnv,
          PATH: "/run/kw/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/kw/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: "C.UTF-8",
        },
      });

    const throwDistroBootErrorIfBase = async (err: unknown): Promise<never> => {
      const reason = this.vm ? await this.#readBaseShellReason(this.vm) : null;
      if (reason) {
        throw new Error(
          `${DISTROS[this.activeDistro].label} 系统镜像无法引导（${reason}）。请运行 bun run prebake ${this.activeDistro} 刷新本地镜像后刷新页面。`,
          { cause: err },
        );
      }
      throw err;
    };

    const register = (pty: Pty) =>
      this.#registerSession(pty, mode, cwd, {
        id: replaceIdx >= 0 ? this.#sessions[replaceIdx]!.id : undefined,
        title: opts?.title,
        replaceIndex: replaceIdx >= 0 ? replaceIdx : undefined,
        activate: true,
        ready: true,
      });

    if (mode === "nvim") {
      try {
        const pty = await spawnSession("/usr/bin/nvim", [], resolvedShell ?? DEFAULT_SHELL);
        return register(pty);
      } catch (err) {
        return await throwDistroBootErrorIfBase(err);
      }
    }

    const candidates = getShellCandidatesToTry(resolvedShell);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      try {
        const pty = await spawnSession(candidate, ["-l"], candidate);
        this.#shellPath = candidate;
        return register(pty);
      } catch (err) {
        await throwDistroBootErrorIfBase(err).catch((bootOrOriginal) => {
          if (bootOrOriginal !== err) throw bootOrOriginal;
        });
        if (i < candidates.length - 1 && isShellNotFoundError(err)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error("未找到可用的交互式 Shell");
  }

  #registerSession(
    pty: Pty,
    mode: SessionMode,
    cwd: string,
    opts: {
      id?: string;
      title?: string;
      replaceIndex?: number;
      activate: boolean;
      ready: boolean;
    },
  ): TerminalSession {
    let id = opts.id;
    if (!id) {
      do {
        id = `pty-${this.#nextSessionSeq++}`;
      } while (this.#sessions.some((s) => s.id === id));
    }
    const others =
      opts.replaceIndex !== undefined
        ? this.#sessions.filter((_, i) => i !== opts.replaceIndex)
        : this.#sessions;
    const title = opts.title ?? nextSessionTitle(mode, this.shellName, others);

    const session: TerminalSession = {
      id,
      mode,
      title,
      cwd,
      terminalId: pty.sessionId,
      exited: false,
      exitCode: null,
      pty,
    };

    if (opts.replaceIndex !== undefined) {
      this.#sessions[opts.replaceIndex] = session;
    } else {
      this.#sessions.push(session);
    }

    if (opts.activate) {
      this.#activeSessionId = session.id;
    }

    void pty.ended.then(
      (end) => {
        if (session.pty !== pty) return;
        session.pty = null;
        session.exited = true;
        session.exitCode = end.type === "exit" ? end.code : null;
        this.#onSessionsChange?.();
        if (!this.#suspending) this.#onSessionExit?.(session, end);
      },
      () => {
        if (session.pty !== pty) return;
        session.pty = null;
        session.exited = true;
        this.#onSessionsChange?.();
      },
    );

    if (opts.activate) {
      this.#onSessionsChange?.();
    }
    if (opts.ready) {
      this.#onStatus({ phase: "ready", title: "Ready" });
    }
    return session;
  }

  switchSession(id: string): TerminalSession | null {
    const target = this.#sessions.find((s) => s.id === id);
    if (!target) return null;
    this.#activeSessionId = target.id;
    this.#onSessionsChange?.();
    return target;
  }

  async closeSession(id: string): Promise<{ closed: TerminalSession; nextActive: TerminalSession | null } | null> {
    const target = this.#sessions.find((s) => s.id === id);
    if (!target) return null;

    const nextId = pickNextActiveSessionId(this.#sessions, id, this.#activeSessionId);
    this.#sessions = this.#sessions.filter((s) => s.id !== id);
    this.#activeSessionId = nextId;

    const pty = target.pty;
    target.pty = null;
    target.exited = true;
    if (pty) {
      await pty.close().catch(() => {});
    }
    this.#onSessionsChange?.();
    return { closed: target, nextActive: this.activeSession };
  }

  async mountHostDirectory(dirFs: BrowserDirectoryFs): Promise<MountedFolder> {
    if (!this.vm || this.#suspending) throw new Error("虚拟机当前无法挂载目录");
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

  async readGuestFile(guestPath: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.vm || this.#suspending) throw new Error("虚拟机当前无法读取文件");
    const res = await this.vm.exec(
      "/bin/sh",
      [
        "-c",
        'if [ ! -e "$1" ]; then echo "文件不存在: $1" >&2; exit 2; fi; if [ ! -f "$1" ]; then echo "不是普通文件: $1" >&2; exit 3; fi; exec cat -- "$1"',
        "--",
        guestPath,
      ],
      { user: "root", encoding: "buffer", signal },
    );
    if (res.exitCode !== 0) {
      const msg = new TextDecoder().decode(res.stderr).trim();
      throw new Error(msg || `读取失败 (exit=${res.exitCode})`);
    }
    return res.stdout;
  }

  async writeGuestFiles(
    files: readonly File[],
    targetDir = this.currentCwd || "/workspace",
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!this.vm || this.#suspending) throw new Error("虚拟机当前无法写入文件");
    const dir = targetDir.replace(/\/+$/, "") || "/";
    const used = new Set<string>();
    const written: string[] = [];

    for (const file of files) {
      const base = sanitizeDropFilename(file.name);
      let candidate = base;
      if (used.has(candidate)) {
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : "";
        let index = 2;
        while (used.has(`${stem}-${index}${ext}`)) {
          index += 1;
        }
        candidate = `${stem}-${index}${ext}`;
      }
      used.add(candidate);

      const destPath = dir === "/" ? `/${candidate}` : `${dir}/${candidate}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await this.vm.exec(
        "/bin/sh",
        ["-e", "-c", 'mkdir -p -- "$1" && cat > "$2"', "--", dir, destPath],
        { user: "root", input: bytes, signal },
      );
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `写入 ${destPath} 失败 (exit=${res.exitCode})`);
      }
      written.push(destPath);
    }

    return written;
  }

  async syncDisk(): Promise<boolean> {
    if (!this.vm || this.#suspending) return false;
    return this.vm.sync({ timeout: 5000 }).catch(() => false);
  }

  async exportDiskImage(): Promise<{ name: string; bytes: number; blocks: number }> {
    if (!(this.vm instanceof WorkerKernel)) {
      throw new Error("内核未运行在 Worker 模式");
    }
    if (!(await this.syncDisk())) throw new Error("磁盘同步未完成，请重试");
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
    const bytes = await gunzipIfNeeded(await file.arrayBuffer());
    const { size, blockSize } = decodeKwsparse(bytes);
    if (blockSize !== 4096 || !Number.isSafeInteger(size) || size % blockSize !== 0 ||
        size < DISK_SIZE_BYTES || size > MAX_DISK_GIB * GIB) {
      throw new Error(`备份须为 ${DEFAULT_DISK_GIB}–${MAX_DISK_GIB} GiB 的数据盘，使用 4 KiB 磁盘块`);
    }
    const distro = this.activeDistro;
    await this.#stopForReload();
    await importDataDisk(bytes, { name: DISTROS[distro].diskName, version: DISK_VERSION, size });
    localStorage.removeItem(diskSizeKey(distro));
    location.reload();
  }

  async syncAndReload(): Promise<void> {
    await this.#stopForReload();
    location.reload();
  }

  async #stopForReload(): Promise<void> {
    this.#stopWasiServer();
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
  }

  async resetToFactoryDisk(): Promise<void> {
    this.#stopWasiServer();
    if (this.vm instanceof WorkerKernel) {
      await this.vm.detachDisk(0).catch(() => {});
      await this.vm.stop().catch(() => {});
    }
    await resetDataDisk({ name: DISTROS[this.activeDistro].diskName, version: DISK_VERSION });
    localStorage.removeItem(diskSizeKey(this.activeDistro));
    await deleteSuspendedSession(this.activeDistro).catch(() => {});
    location.reload();
  }

  async suspendSession(): Promise<void> {
    const vm = this.vm;
    if (!(vm instanceof WorkerKernel) || !vm.disks[0]?.persistent || !this.#bootedNetwork) {
      throw new Error("挂起需要正在运行的虚拟机和持久化磁盘");
    }
    if (this.#suspending) throw new Error("正在保存挂起会话");
    if (this.hasPendingDistroChange()) throw new Error("请先应用发行版切换，或选回当前发行版后挂起");
    if (this.mountedFolders.size > 0) {
      throw new Error("请先卸载本地目录，再挂起虚拟机");
    }
    const distro = this.activeDistro;
    const liveSessions = this.#sessions.filter((s) => !s.exited && s.pty !== null);
    const suspendedEntries: SuspendedTerminalEntry[] = [];
    for (const s of liveSessions) {
      if (!s.pty?.sessionId) {
        throw new Error(`终端会话 ${s.title} 不支持续接，请重新打开后再挂起`);
      }
      suspendedEntries.push({
        id: s.id,
        mode: s.mode,
        title: s.title,
        cwd: s.cwd,
        terminalId: s.pty.sessionId,
      });
    }
    const active = this.activeSession;
    const session: SessionMetadata = {
      id: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"),
      mode: this.currentMode,
      cwd: this.currentCwd,
      shell: this.shellPath,
      terminalId: active?.pty?.sessionId ?? suspendedEntries[0]?.terminalId,
      activeSessionId: active && !active.exited ? active.id : suspendedEntries[0]?.id,
      sessions: suspendedEntries,
      network: this.#bootedNetwork,
    };
    this.#suspending = true;
    let bytes = 0;
    try {
      await vm.snapshot({
        dropCaches: true,
        commitTimeoutMs: 60_000,
        commit: async (snapshot, signal) => {
          const ttyIds = new Set((snapshot.ttys ?? []).map((tty) => tty.id));
          for (const entry of suspendedEntries) {
            if (!ttyIds.has(entry.terminalId)) {
              throw new Error(`终端会话 ${entry.title} 已结束，请重试`);
            }
          }
          bytes = await writeSuspendedSession(distro, session, snapshot, signal);
          if (signal.aborted) {
            await deleteSuspendedSession(distro, session.id);
            signal.throwIfAborted();
          }
        },
      });
      this.#stopWasiServer();
      this.#sessions = [];
      this.#activeSessionId = null;
      this.vm = null;
      this.#onSessionsChange?.();
      this.#onStatus({
        phase: "suspended",
        title: `${DISTROS[distro].label} 已挂起`,
        detail: `会话已保存到此浏览器 (${(bytes / 1048576).toFixed(1)} MiB)`,
      });
    } catch (err) {
      if (bytes) await deleteSuspendedSession(distro, session.id).catch(() => {});
      throw err;
    } finally {
      this.#suspending = false;
    }
  }

  async discardSuspendedSession(): Promise<void> {
    const release = await acquireDiskLock(DISTROS[this.#distro].diskName);
    try {
      await deleteSuspendedSession(this.#distro);
    } finally {
      release();
    }
    location.reload();
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
    wasi: {
      active: boolean;
      shared: boolean;
      runs: number;
      cachedModules: number;
    };
  } {
    const stats = this.vm ? this.vm.stats() : null;
    let diskBlocks = 0;
    if (this.vm instanceof WorkerKernel && this.vm.disks[0]) {
      diskBlocks = this.vm.disks[0].overlayBlocks ?? 0;
    }
    const memoryMiB = this.vm?.memoryMiB ?? 0;
    const wasiStats = this.#wasiServer?.stats;
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
      wasi: {
        active: this.#wasiServer !== null,
        shared: this.#wasiServer?.shared ?? false,
        runs: wasiStats?.started ?? 0,
        cachedModules: wasiStats?.cached ?? 0,
      },
    };
  }
}
