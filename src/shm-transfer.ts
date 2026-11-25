// SPDX-License-Identifier: MIT
// Guest/host file transfer accelerated via unkernel's /dev/shm (kwshm) shared
// memory channel, with transparent fallback to vsock pipe exec.

import { ShmError, type KernelHandle, type Shm, type ShmFile } from "unkernel";

export const SHM_MIN_BYTES = 4096;
export const SHM_MAX_BYTES = 64 * 1024 * 1024;

export interface ShmExecHost {
  shm?: Pick<Shm, "open" | "create">;
  exec: KernelHandle["exec"];
}

let shmSeq = 0;

function nextShmName(prefix: "r" | "w"): string {
  shmSeq += 1;
  return `kw-${prefix}-${Date.now().toString(36)}-${shmSeq}`;
}

async function unlinkGuestShm(host: ShmExecHost, shmName: string): Promise<void> {
  await host
    .exec("/bin/rm", ["-f", "--", `/dev/shm/${shmName}`], {
      user: "root",
      timeout: 3000,
    })
    .catch(() => {});
}

async function readGuestFileViaPipe(
  host: ShmExecHost,
  guestPath: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await host.exec(
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

async function writeGuestFileViaPipe(
  host: ShmExecHost,
  dir: string,
  destPath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const res = await host.exec(
    "/bin/sh",
    ["-e", "-c", 'mkdir -p -- "$1" && cat > "$2"', "--", dir, destPath],
    { user: "root", input: bytes, signal },
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `写入 ${destPath} 失败 (exit=${res.exitCode})`);
  }
}

/** Read a guest file, using /dev/shm zero-copy when available and sized within bounds. */
export async function readGuestFileViaShm(
  host: ShmExecHost,
  guestPath: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!host.shm) {
    return readGuestFileViaPipe(host, guestPath, signal);
  }

  const shmName = nextShmName("r");
  const probe = await host.exec(
    "/bin/sh",
    [
      "-c",
      [
        'if [ ! -e "$1" ]; then echo "文件不存在: $1" >&2; exit 2; fi',
        'if [ ! -f "$1" ]; then echo "不是普通文件: $1" >&2; exit 3; fi',
        'sz=$(wc -c < "$1") || exit 4',
        'if [ "$sz" -eq 0 ]; then echo "empty"; exit 0; fi',
        'if [ "$sz" -ge "$3" ] && [ "$sz" -le "$4" ] && [ -d /dev/shm ]; then',
        '  if cp -- "$1" "/dev/shm/$2" 2>/dev/null; then echo "shm"; exit 0; fi',
        "fi",
        'echo "pipe"',
      ].join("; "),
      "--",
      guestPath,
      shmName,
      String(SHM_MIN_BYTES),
      String(SHM_MAX_BYTES),
    ],
    { user: "root", signal },
  );

  if (probe.exitCode !== 0) {
    throw new Error(probe.stderr.trim() || `读取失败 (exit=${probe.exitCode})`);
  }

  const mode = probe.stdout.trim();
  if (mode === "empty") {
    return new Uint8Array(0);
  }
  if (mode !== "shm") {
    return readGuestFileViaPipe(host, guestPath, signal);
  }

  let handle: ShmFile | null = null;
  try {
    handle = await host.shm.open(shmName);
    const bytes = handle.inPlace ? handle.readSync() : await handle.read();
    return new Uint8Array(bytes);
  } catch (err) {
    if (err instanceof ShmError || (err instanceof Error && !signal?.aborted)) {
      return readGuestFileViaPipe(host, guestPath, signal);
    }
    throw err;
  } finally {
    await handle?.close().catch(() => {});
    await unlinkGuestShm(host, shmName);
  }
}

/** Write bytes to a guest path, using /dev/shm when available and sized within bounds. */
export async function writeGuestFileViaShm(
  host: ShmExecHost,
  dir: string,
  destPath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (!host.shm || bytes.byteLength < SHM_MIN_BYTES || bytes.byteLength > SHM_MAX_BYTES) {
    return writeGuestFileViaPipe(host, dir, destPath, bytes, signal);
  }

  const shmName = nextShmName("w");
  let handle: ShmFile | null = null;
  let staged = false;
  try {
    handle = await host.shm.create(shmName, bytes.byteLength);
    await handle.write(0, bytes);
    await handle.close();
    handle = null;
    staged = true;
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlinkGuestShm(host, shmName);
    if (signal?.aborted) throw err;
    return writeGuestFileViaPipe(host, dir, destPath, bytes, signal);
  }

  if (!staged) return;
  try {
    const res = await host.exec(
      "/bin/sh",
      ["-e", "-c", 'mkdir -p -- "$1" && cp -- "/dev/shm/$3" "$2"', "--", dir, destPath, shmName],
      { user: "root", signal },
    );
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `写入 ${destPath} 失败 (exit=${res.exitCode})`);
    }
  } finally {
    await unlinkGuestShm(host, shmName);
  }
}
