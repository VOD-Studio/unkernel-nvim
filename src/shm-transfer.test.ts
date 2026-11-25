// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { ShmError, type ShmFile } from "unkernel";
import {
  readGuestFileViaShm,
  SHM_MIN_BYTES,
  writeGuestFileViaShm,
  type ShmExecHost,
} from "./shm-transfer.ts";

function makeFakeShmHandle(data: Uint8Array, opts: { inPlace?: boolean } = {}): ShmFile & {
  closedCalled: boolean;
  written?: Uint8Array;
} {
  let closedCalled = false;
  const buf = new Uint8Array(data);
  return {
    id: 1,
    name: "fake",
    origin: "host",
    size: buf.byteLength,
    pages: Math.ceil(buf.byteLength / 4096),
    writable: true,
    generation: 1,
    inPlace: opts.inPlace ?? false,
    get closedCalled() {
      return closedCalled;
    },
    read: async () => new Uint8Array(buf),
    readSync: () => new Uint8Array(buf),
    views: () => [buf],
    write: async (offset, chunk) => {
      buf.set(chunk, offset);
    },
    refresh: async () => false,
    isStale: async () => false,
    close: async () => {
      closedCalled = true;
    },
    closed: Promise.resolve("closed"),
  };
}

describe("shm-transfer", () => {
  test("readGuestFileViaShm uses SHM for files >= 4 KiB and unlinks /dev/shm file", async () => {
    const payload = new Uint8Array(SHM_MIN_BYTES).fill(0x41);
    const commands: string[] = [];
    const handle = makeFakeShmHandle(payload, { inPlace: true });

    const host: ShmExecHost = {
      shm: {
        open: async () => handle,
        create: async () => handle,
      },
      exec: (async (file: string, args: readonly string[] = []) => {
        commands.push(`${file} ${args.join(" ")}`);
        if (file === "/bin/rm") {
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "shm\n", stderr: "", exitCode: 0, signal: null };
      }) as ShmExecHost["exec"],
    };

    const result = await readGuestFileViaShm(host, "/workspace/big.bin");
    expect(result).toEqual(payload);
    expect(handle.closedCalled).toBe(true);
    expect(commands.some((cmd) => cmd.startsWith("/bin/rm -f -- /dev/shm/kw-r-"))).toBe(true);
  });

  test("readGuestFileViaShm falls back to pipe when SHM open fails", async () => {
    const pipePayload = new Uint8Array([9, 8, 7]);
    const host: ShmExecHost = {
      shm: {
        open: async () => {
          throw new ShmError("ENOENT", "missing");
        },
        create: async () => {
          throw new ShmError("ENODEV", "no shm");
        },
      },
      exec: (async (file: string, _args?: readonly string[], opts?: { encoding?: string }) => {
        if (file === "/bin/rm") {
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        }
        if (opts?.encoding === "buffer") {
          return { stdout: pipePayload, stderr: new Uint8Array(0), exitCode: 0, signal: null };
        }
        return { stdout: "shm\n", stderr: "", exitCode: 0, signal: null };
      }) as ShmExecHost["exec"],
    };

    const result = await readGuestFileViaShm(host, "/workspace/fallback.bin");
    expect(result).toEqual(pipePayload);
  });

  test("writeGuestFileViaShm uses SHM for >= 4 KiB and pipes for < 4 KiB", async () => {
    const large = new Uint8Array(SHM_MIN_BYTES + 128).fill(0x5a);
    const createdBuf = new Uint8Array(large.byteLength);
    const handle = makeFakeShmHandle(createdBuf);
    const execCalls: Array<{ file: string; args: readonly string[]; hasInput: boolean }> = [];

    const host: ShmExecHost = {
      shm: {
        open: async () => handle,
        create: async (_name, size) => {
          expect(size).toBe(large.byteLength);
          return handle;
        },
      },
      exec: (async (file: string, args: readonly string[] = [], opts?: { input?: Uint8Array }) => {
        execCalls.push({ file, args, hasInput: Boolean(opts?.input) });
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      }) as ShmExecHost["exec"],
    };

    await writeGuestFileViaShm(host, "/workspace", "/workspace/large.bin", large);
    expect(handle.closedCalled).toBe(true);
    expect(execCalls.some((c) => c.file === "/bin/sh" && !c.hasInput)).toBe(true);
    expect(execCalls.some((c) => c.file === "/bin/rm")).toBe(true);

    const small = new Uint8Array([1, 2, 3]);
    await writeGuestFileViaShm(host, "/workspace", "/workspace/small.bin", small);
    expect(execCalls.some((c) => c.file === "/bin/sh" && c.hasInput)).toBe(true);
  });
});
