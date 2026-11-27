// SPDX-License-Identifier: MIT
// Bridge between unkernel (vsock:2:1023, kwshm, virtio-gpu/virgl, WebGPU vk)
// and the wland Wayland compositor.

import type { KernelHandle, Shm, ShmFile, VsockConnection, VsockListener } from "unkernel";
import type {
  DropFilesHook,
  GpuSource,
  HandleRead,
  HandleSource,
  StreamSource,
  Wland,
  WlandOptions,
} from "wland/client";

export const WLAND_VSOCK_PORT = 1023;
export const FOURCC_XRGB8888 = 0x34325258;
export const FOURCC_XBGR8888 = 0x34324258;
export const WAYLAND_DROP_DIR = "/tmp/drops";
export const WAYLAND_DROP_TIMEOUT_MS = 60_000;

export type WaylandBridgeState =
  | "unsupported"
  | "idle"
  | "loading"
  | "ready"
  | "connected"
  | "error";

export interface WaylandBridgeStatus {
  state: WaylandBridgeState;
  windowCount: number;
  shmMode: "in-place" | "worker" | "none";
  gpuDmabuf: boolean;
  vkExternal: boolean;
  scale: number | null;
  effectiveScale: number;
  browserFullscreen: boolean;
  error: string | null;
}

export interface WaylandDropFilesOptions {
  uploadFiles: (files: File[], dir: string, signal?: AbortSignal) => Promise<string[]>;
  dir?: string;
  timeoutMs?: number;
  onStart?: (count: number) => void;
  onComplete?: (paths: string[]) => void;
  onError?: (err: unknown) => void;
}

/**
 * Bridge browser/OS file drops onto Wayland app windows by uploading dropped
 * files into the guest filesystem and returning their paths for text/uri-list.
 */
export function createWaylandDropFilesHook(opts: WaylandDropFilesOptions): DropFilesHook {
  const dir = opts.dir ?? WAYLAND_DROP_DIR;
  const timeoutMs = opts.timeoutMs ?? WAYLAND_DROP_TIMEOUT_MS - 5_000;
  return async (files: File[]): Promise<readonly string[] | null> => {
    if (files.length === 0) return null;
    opts.onStart?.(files.length);
    try {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const paths = await opts.uploadFiles(files, dir, signal);
      if (paths.length === 0) return null;
      opts.onComplete?.(paths);
      return paths;
    } catch (err) {
      opts.onError?.(err);
      return null;
    }
  };
}

/**
 * Expose unkernel's kwshm exports to wland's HandleSource, preferring synchronous
 * zero-copy views/readSync when shared memory is mapped in place and falling back
 * to batched async reads across the worker boundary.
 */
export function createKwshmHandleSource(shm: Shm): HandleSource<ShmFile> {
  return {
    open(handle) {
      if (handle.kind !== "kwshm") {
        throw new Error(`Unsupported wland buffer handle kind: ${handle.kind}`);
      }
      return shm.openId(handle.id);
    },

    view(file, offset, length) {
      if (!file.inPlace) return null;
      try {
        return file.views(offset, length);
      } catch {
        return null;
      }
    },

    read(file, offset, dst) {
      if (file.inPlace) {
        try {
          file.readSync(offset, dst.length, dst);
          return;
        } catch {
          // Export became stale or released; fall back to worker round-trip read.
        }
      }
      return file.read(offset, dst.length).then((bytes) => {
        dst.set(bytes);
      });
    },

    readv(file, reads: readonly HandleRead[]) {
      if (reads.length === 0) return;
      if (file.inPlace) {
        try {
          for (const span of reads) {
            file.readSync(span.offset, span.dst.length, span.dst);
          }
          return;
        } catch {
          // Fall back to batched async reads if an in-place view became stale.
        }
      }
      return Promise.all(
        reads.map((span) =>
          file.read(span.offset, span.dst.length).then((bytes) => {
            span.dst.set(bytes);
          }),
        ),
      ).then(() => undefined);
    },

    close(file) {
      void file.close().catch(() => {});
    },
  };
}

/**
 * Expose unkernel's virtio-gpu (GL/virgl) and WebGPU Vulkan external swapchain
 * images to wland without guest pixel readback when enabled on the VM.
 */
export function createUnkernelGpuSource(
  vm: Pick<KernelHandle, "gl" | "vk">,
): GpuSource<CanvasImageSource> | undefined {
  const gpuRenderer = vm.gl?.gpu;
  const vkHost = vm.vk;
  if (!gpuRenderer && !vkHost) return undefined;

  const source: GpuSource<CanvasImageSource> = {
    release(image) {
      if (image && "close" in image && typeof image.close === "function") {
        try {
          image.close();
        } catch {
          // Ignore already-closed ImageBitmap/VideoFrame
        }
      }
    },
  };

  if (gpuRenderer) {
    source.resolve = (ref) =>
      gpuRenderer.image(ref.resource, {
        width: ref.width,
        height: ref.height,
        opaque: ref.format === FOURCC_XRGB8888 || ref.format === FOURCC_XBGR8888,
        flipY: (ref.flags & 1) !== 0,
      });
  }

  if (vkHost) {
    source.resolveExternal = (ref) => vkHost.externalImage(ref);
  }

  return source;
}

export interface LazyVsockStreamSource {
  /** Wait for the first guest connection before loading wland.wasm; resolves false if closed first. */
  waitForFirstConnection(): Promise<boolean>;
  /** StreamSource yielding the pre-accepted connection first (if any) then remaining listener connections. */
  source: StreamSource & { close(): void };
}

/**
 * Wrap a VsockListener so the host can await the very first guest dial before
 * downloading/instantiating wland.wasm, without losing that first connection.
 */
export function createLazyVsockStreamSource(
  listener: VsockListener,
  onFirstConnection?: () => void,
): LazyVsockStreamSource {
  let firstConn: VsockConnection | null = null;
  let closed = false;
  let startedAccepting = false;
  let firstAcceptedPromise: Promise<boolean> | null = null;

  const waitForFirstConnection = (): Promise<boolean> => {
    if (firstAcceptedPromise) return firstAcceptedPromise;
    startedAccepting = true;
    firstAcceptedPromise = (async () => {
      try {
        const conn = await listener.accept();
        if (!conn) return false;
        if (closed) {
          conn.close();
          return false;
        }
        firstConn = conn;
        onFirstConnection?.();
        return true;
      } catch {
        return false;
      }
    })();
    return firstAcceptedPromise;
  };

  const source: StreamSource & { close(): void } = {
    async *[Symbol.asyncIterator]() {
      if (startedAccepting && firstAcceptedPromise && !firstConn && !closed) {
        const ok = await firstAcceptedPromise;
        if (!ok) return;
      }
      if (firstConn) {
        const conn = firstConn;
        firstConn = null;
        yield conn;
      }
      while (!closed) {
        let conn: VsockConnection | null;
        try {
          conn = await listener.accept();
        } catch {
          return;
        }
        if (!conn) return;
        if (closed) {
          conn.close();
          return;
        }
        yield conn;
      }
    },
    close() {
      closed = true;
      if (firstConn) {
        const conn = firstConn;
        firstConn = null;
        conn.close();
      }
      listener.close();
    },
  };

  return { waitForFirstConnection, source };
}

export type WlandClientModule = typeof import("wland/client");

export type WaylandHostOptions = Omit<WlandOptions, "link" | "buffers" | "gpu" | "scale" | "browserFullscreen" | "dnd"> & {
  initialScale?: number | null;
  initialBrowserFullscreen?: boolean;
  dndFiles?: DropFilesHook;
  dndFilesTimeout?: number;
  onStatusChange?: (status: WaylandBridgeStatus) => void;
  onGuestDial?: () => void;
  loadClient?: () => Promise<WlandClientModule>;
};

/**
 * Manages the wland compositor lifecycle for the active KernelHandle,
 * supporting both lazy on-demand startup (when a guest runs `wland <app>`)
 * and eager startup (when the user enters Desktop Mode).
 */
export class WaylandHostBridge {
  readonly #options: WaylandHostOptions;
  readonly #loadClient: () => Promise<WlandClientModule>;
  #vm: KernelHandle | null = null;
  #listener: VsockListener | null = null;
  #lazyStream: LazyVsockStreamSource | null = null;
  #wland: Wland | null = null;
  #starting: Promise<Wland | null> | null = null;
  #state: WaylandBridgeState = "idle";
  #error: string | null = null;
  #epoch = 0;
  #pinnedScale: number | null;
  #browserFullscreen: boolean;

  constructor(options: WaylandHostOptions) {
    this.#options = options;
    this.#loadClient = options.loadClient ?? (() => import("wland/client"));
    this.#pinnedScale = options.initialScale ?? null;
    this.#browserFullscreen = Boolean(options.initialBrowserFullscreen);
  }

  get wland(): Wland | null {
    return this.#wland;
  }

  getStatus(): WaylandBridgeStatus {
    const vm = this.#vm;
    const shmMode: "in-place" | "worker" | "none" = !vm?.shm
      ? "none"
      : vm.shm.inPlace
        ? "in-place"
        : "worker";
    const defaultDpr = typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
    const effectiveScale = this.#wland?.output.state().scale ?? this.#pinnedScale ?? defaultDpr;
    return {
      state: this.#state,
      windowCount: this.#wland?.windows().length ?? 0,
      shmMode,
      gpuDmabuf: Boolean(vm?.gl?.gpu),
      vkExternal: Boolean(vm?.vk),
      scale: this.#pinnedScale,
      effectiveScale,
      browserFullscreen: this.#browserFullscreen,
      error: this.#error,
    };
  }

  setScale(scale: number | null): void {
    if (scale !== null && (!Number.isFinite(scale) || scale <= 0)) {
      throw new RangeError(`Invalid Wayland scale: ${scale}`);
    }
    this.#pinnedScale = scale;
    if (this.#wland) {
      this.#wland.output.setScale(scale);
    }
    this.#options.onStatusChange?.(this.getStatus());
  }

  setBrowserFullscreen(enabled: boolean): boolean {
    this.#browserFullscreen = enabled;
    this.#options.onStatusChange?.(this.getStatus());
    return this.#wland === null;
  }

  #setState(state: WaylandBridgeState, error: string | null = null): void {
    this.#state = state;
    this.#error = error;
    this.#options.onStatusChange?.(this.getStatus());
  }

  attach(vm: KernelHandle): void {
    this.detach();
    this.#vm = vm;
    const epoch = ++this.#epoch;

    if (!vm.vsock || !vm.shm) {
      this.#setState("unsupported");
      return;
    }

    const listener = vm.vsock.listen(WLAND_VSOCK_PORT);
    this.#listener = listener;
    const lazy = createLazyVsockStreamSource(listener, () => {
      if (this.#epoch !== epoch || this.#vm !== vm) return;
      this.#options.onGuestDial?.();
    });
    this.#lazyStream = lazy;
    this.#setState("idle");

    void lazy.waitForFirstConnection().then((connected) => {
      if (!connected || this.#epoch !== epoch || this.#vm !== vm) return;
      void this.ensureReady().catch((err) => {
        console.warn("[wland] Failed to start compositor on guest dial:", err);
      });
    });

    void vm.exited.then(() => {
      if (this.#epoch === epoch && this.#vm === vm) {
        this.detach();
      }
    });
  }

  async ensureReady(): Promise<Wland | null> {
    if (this.#wland) return this.#wland;
    if (this.#starting) return this.#starting;

    const vm = this.#vm;
    const lazy = this.#lazyStream;
    if (!vm || !vm.shm || !lazy) return null;

    const epoch = this.#epoch;
    this.#setState("loading");

    this.#starting = (async () => {
      try {
        const mod = await this.#loadClient();
        if (this.#epoch !== epoch || this.#vm !== vm) return null;

        const {
          initialScale: _initialScale,
          initialBrowserFullscreen: _initialBrowserFullscreen,
          dndFiles,
          dndFilesTimeout,
          onStatusChange: _onStatus,
          onGuestDial: _onDial,
          loadClient: _load,
          onEvent: userOnEvent,
          onWindowsChange: userOnWindowsChange,
          onFocusChange: userOnFocusChange,
          ...restOptions
        } = this.#options;

        const link = mod.createStreamLink(lazy.source);
        const wland = await mod.createWland({
          ...restOptions,
          link,
          buffers: createKwshmHandleSource(vm.shm!),
          gpu: createUnkernelGpuSource(vm),
          ...(this.#pinnedScale !== null ? { scale: this.#pinnedScale } : {}),
          browserFullscreen: this.#browserFullscreen,
          ...(dndFiles
            ? {
                dnd: {
                  files: dndFiles,
                  filesTimeout: dndFilesTimeout ?? WAYLAND_DROP_TIMEOUT_MS,
                },
              }
            : {}),
          onWindowsChange: () => {
            userOnWindowsChange?.();
            if (this.#epoch === epoch) {
              this.#options.onStatusChange?.(this.getStatus());
            }
          },
          onFocusChange: () => {
            userOnFocusChange?.();
            if (this.#epoch === epoch) {
              this.#options.onStatusChange?.(this.getStatus());
            }
          },
          onEvent: (ev) => {
            if (this.#epoch === epoch) {
              if (ev.type === "open") {
                this.#setState("connected");
              } else if (ev.type === "close") {
                this.#setState("ready");
              } else if (ev.type === "error") {
                this.#error = ev.detail;
                this.#options.onStatusChange?.(this.getStatus());
              }
            }
            userOnEvent?.(ev);
          },
        });

        if (this.#epoch !== epoch || this.#vm !== vm) {
          wland.dispose();
          return null;
        }

        this.#wland = wland;
        if (this.#state === "loading") {
          this.#setState("ready");
        }
        return wland;
      } catch (err) {
        if (this.#epoch === epoch) {
          this.#setState("error", err instanceof Error ? err.message : String(err));
        }
        throw err;
      } finally {
        if (this.#epoch === epoch) {
          this.#starting = null;
        }
      }
    })();

    return this.#starting;
  }

  detach(): void {
    this.#epoch += 1;
    this.#starting = null;
    this.#vm = null;

    const wland = this.#wland;
    this.#wland = null;
    if (wland) {
      try {
        wland.dispose();
      } catch {}
    }

    const lazy = this.#lazyStream;
    this.#lazyStream = null;
    if (lazy) {
      try {
        lazy.source.close();
      } catch {}
    }

    const listener = this.#listener;
    this.#listener = null;
    if (listener) {
      try {
        listener.close();
      } catch {}
    }

    this.#setState("idle");
  }
}
