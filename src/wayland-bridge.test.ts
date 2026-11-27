// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import type { Shm, ShmFile, VsockConnection, VsockListener } from "unkernel";
import {
  createKwshmHandleSource,
  createLazyVsockStreamSource,
  createUnkernelGpuSource,
  createWaylandDropFilesHook,
  FOURCC_XBGR8888,
  FOURCC_XRGB8888,
  WAYLAND_DROP_DIR,
} from "./wayland-bridge.ts";

function makeFakeShmFile(data: Uint8Array, inPlace: boolean, failSync = false): {
  file: ShmFile;
  closed: () => boolean;
  readCalls: () => number;
} {
  let isClosed = false;
  let asyncReads = 0;

  const file: ShmFile = {
    id: 7,
    name: undefined,
    origin: "guest",
    size: data.byteLength,
    pages: Math.ceil(data.byteLength / 4096),
    writable: false,
    generation: 1,
    inPlace,
    async read(offset = 0, length = data.byteLength - offset) {
      asyncReads += 1;
      return data.slice(offset, offset + length);
    },
    readSync(offset = 0, length = data.byteLength - offset, out?: Uint8Array) {
      if (failSync) throw new Error("EAGAIN");
      const slice = data.subarray(offset, offset + length);
      if (out) {
        out.set(slice);
        return out;
      }
      return slice.slice();
    },
    views(offset = 0, length = data.byteLength - offset) {
      if (failSync) throw new Error("EAGAIN");
      const mid = Math.floor(length / 2);
      if (mid > 0) {
        return [data.subarray(offset, offset + mid), data.subarray(offset + mid, offset + length)];
      }
      return [data.subarray(offset, offset + length)];
    },
    async write() {},
    async refresh() {
      return false;
    },
    async isStale() {
      return false;
    },
    async close() {
      isClosed = true;
      throw new Error("ignore close failure");
    },
    closed: Promise.resolve("closed"),
  };

  return {
    file,
    closed: () => isClosed,
    readCalls: () => asyncReads,
  };
}

describe("wayland-bridge", () => {
  test("createKwshmHandleSource rejects non-kwshm handles and opens kwshm exports", async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const fake = makeFakeShmFile(data, true);
    const shm = {
      open: async () => fake.file,
      create: async () => fake.file,
      openId: async (id: number) => {
        expect(id).toBe(42);
        return fake.file;
      },
      inPlace: true,
      stats: { open: 0, reads: 0, bytesRead: 0, inPlaceReads: 0, writes: 0, bytesWritten: 0 },
    } satisfies Shm;

    const src = createKwshmHandleSource(shm);
    expect(() => src.open({ kind: "procfd", pid: 1, fd: 3, offset: 0, size: 6 }, 1)).toThrow();

    const opened = await src.open({ kind: "kwshm", id: 42, size: 6 }, 1);
    const views = src.view?.(opened, 0, 6);
    expect(Array.isArray(views)).toBe(true);

    const dst = new Uint8Array(4);
    const syncRes = src.read(opened, 1, dst);
    expect(syncRes).toBeUndefined();
    expect(Array.from(dst)).toEqual([20, 30, 40, 50]);
    expect(fake.readCalls()).toBe(0);

    const spanA = new Uint8Array(2);
    const spanB = new Uint8Array(2);
    const readvRes = src.readv?.(opened, [
      { offset: 0, dst: spanA },
      { offset: 4, dst: spanB },
    ]);
    expect(readvRes).toBeUndefined();
    expect(Array.from(spanA)).toEqual([10, 20]);
    expect(Array.from(spanB)).toEqual([50, 60]);

    src.close(opened);
    expect(fake.closed()).toBe(true);
  });

  test("createKwshmHandleSource falls back to batched async readv when inPlace fails or is false", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fake = makeFakeShmFile(data, true, true);
    const shm = {
      open: async () => fake.file,
      create: async () => fake.file,
      openId: async () => fake.file,
      inPlace: false,
      stats: { open: 0, reads: 0, bytesRead: 0, inPlaceReads: 0, writes: 0, bytesWritten: 0 },
    } satisfies Shm;

    const src = createKwshmHandleSource(shm);
    const opened = await src.open({ kind: "kwshm", id: 9, size: 8 }, 1);
    expect(src.view?.(opened, 0, 8)).toBeNull();

    const a = new Uint8Array(3);
    const b = new Uint8Array(2);
    await src.readv?.(opened, [
      { offset: 1, dst: a },
      { offset: 6, dst: b },
    ]);
    expect(Array.from(a)).toEqual([2, 3, 4]);
    expect(Array.from(b)).toEqual([7, 8]);
    expect(fake.readCalls()).toBe(2);
  });

  test("createUnkernelGpuSource maps opaque/flipY flags and releases ImageBitmaps", () => {
    expect(createUnkernelGpuSource({ gl: undefined, vk: undefined })).toBeUndefined();

    const imageCalls: unknown[] = [];
    const externalCalls: unknown[] = [];
    let closedBitmaps = 0;

    const fakeBitmap = {
      width: 100,
      height: 50,
      close() {
        closedBitmaps += 1;
      },
    } as unknown as ImageBitmap;

    const gpuSource = createUnkernelGpuSource({
      gl: {
        gpu: {
          image(resource: number, opts?: unknown) {
            imageCalls.push({ resource, opts });
            return fakeBitmap;
          },
        },
      } as unknown as NonNullable<Parameters<typeof createUnkernelGpuSource>[0]["gl"]>,
      vk: {
        externalImage(ref: unknown) {
          externalCalls.push(ref);
          return fakeBitmap;
        },
      } as unknown as NonNullable<Parameters<typeof createUnkernelGpuSource>[0]["vk"]>,
    });

    expect(gpuSource).toBeDefined();
    const res1 = gpuSource!.resolve!(
      {
        kind: "virtgpu",
        resource: 11,
        width: 320,
        height: 240,
        format: FOURCC_XRGB8888,
        flags: 1,
        offset: 0,
        stride: 1280,
        modifier: 0n,
      },
      { conn: 1, surface: 2, damage: new Int32Array() },
    );
    expect(res1).toBe(fakeBitmap);
    expect(imageCalls[0]).toEqual({
      resource: 11,
      opts: { width: 320, height: 240, opaque: true, flipY: true },
    });

    gpuSource!.resolve!(
      {
        kind: "virtgpu",
        resource: 12,
        width: 100,
        height: 100,
        format: FOURCC_XBGR8888,
        flags: 0,
        offset: 0,
        stride: 400,
        modifier: 0n,
      },
      { conn: 1, surface: 2, damage: new Int32Array() },
    );
    expect(imageCalls[1]).toEqual({
      resource: 12,
      opts: { width: 100, height: 100, opaque: true, flipY: false },
    });

    const extRef = { id: 99n, width: 640, height: 480, format: FOURCC_XRGB8888, flags: 0 };
    expect(gpuSource!.resolveExternal!(extRef, { conn: 1, surface: 3, damage: new Int32Array() })).toBe(fakeBitmap);
    expect(externalCalls[0]).toEqual(extRef);

    gpuSource!.release!(fakeBitmap);
    expect(closedBitmaps).toBe(1);
  });

  test("createLazyVsockStreamSource preserves first accepted connection and yields subsequent ones", async () => {
    const makeConn = (tag: string): VsockConnection & { tag: string; closedFlag: boolean } => ({
      tag,
      closedFlag: false,
      localPort: 1023,
      remotePort: 50000,
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
      closed: Promise.resolve("closed" as const),
      close() {
        this.closedFlag = true;
      },
      reset() {
        this.closedFlag = true;
      },
    });

    const c1 = makeConn("first");
    const c2 = makeConn("second");
    const queue = [c1, c2];
    let listenerClosed = false;

    const listener: VsockListener = {
      port: 1023,
      async accept() {
        const next = queue.shift();
        if (!next) throw new Error("closed");
        return next;
      },
      close() {
        listenerClosed = true;
      },
      async *[Symbol.asyncIterator]() {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      },
    };

    let dialed = 0;
    const lazy = createLazyVsockStreamSource(listener, () => {
      dialed += 1;
    });

    const hasFirst = await lazy.waitForFirstConnection();
    expect(hasFirst).toBe(true);
    expect(dialed).toBe(1);

    const yielded: string[] = [];
    const iter = (lazy.source as AsyncIterable<VsockConnection>)[Symbol.asyncIterator]();
    yielded.push(((await iter.next()).value as { tag: string }).tag);
    yielded.push(((await iter.next()).value as { tag: string }).tag);
    const done = await iter.next();
    expect(done.done).toBe(true);
    expect(yielded).toEqual(["first", "second"]);

    lazy.source.close();
    expect(listenerClosed).toBe(true);
  });

  test("createWaylandDropFilesHook uploads files to /tmp/drops and handles empty or failing drops", async () => {
    let started = 0;
    let completed: string[] = [];
    let failed: unknown = null;

    const hook = createWaylandDropFilesHook({
      uploadFiles: async (files, dir) => {
        expect(dir).toBe(WAYLAND_DROP_DIR);
        return files.map((f) => `${dir}/${f.name}`);
      },
      onStart: (count) => {
        started = count;
      },
      onComplete: (paths) => {
        completed = paths;
      },
      onError: (err) => {
        failed = err;
      },
    });

    expect(await hook([])).toBeNull();
    expect(started).toBe(0);

    const fileA = new File(["hello"], "notes.txt", { type: "text/plain" });
    const fileB = new File(["png"], "pic.png", { type: "image/png" });
    const res = await hook([fileA, fileB]);
    expect(started).toBe(2);
    expect(res).toEqual(["/tmp/drops/notes.txt", "/tmp/drops/pic.png"]);
    expect(completed).toEqual(["/tmp/drops/notes.txt", "/tmp/drops/pic.png"]);
    expect(failed).toBeNull();

    const failingHook = createWaylandDropFilesHook({
      uploadFiles: async () => {
        throw new Error("disk full");
      },
      onError: (err) => {
        failed = err;
      },
    });
    expect(await failingHook([fileA])).toBeNull();
    expect(failed).toBeInstanceOf(Error);
  });
});
