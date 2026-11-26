// SPDX-License-Identifier: MIT
// Browser File System Access API (FileSystemDirectoryHandle) -> unkernel 9p Fs bridge.
// Allows mounting a host folder directly into the guest at /workspace/<name>
// with full read/write/create/delete/rename support.

import {
  FsError,
  type Fs,
  type FsAttr,
  type FsDirEntry,
  type FsFile,
  type FsOpenFlags,
  type FsSetAttr,
} from "unkernel";

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}

function splitPath(p: string): string[] {
  return p.split("/").filter((part) => part.length > 0 && part !== ".");
}

function mapDomError(err: unknown, path: string): never {
  if (err instanceof FsError) throw err;
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotFoundError") throw new FsError("ENOENT", path);
  if (name === "TypeMismatchError") throw new FsError("ENOTDIR", path);
  if (name === "NotAllowedError" || name === "SecurityError") throw new FsError("EACCES", path);
  if (name === "InvalidModificationError") throw new FsError("ENOTEMPTY", path);
  if (name === "NoModificationAllowedError") throw new FsError("EROFS", path);
  throw new FsError("EIO", `${path}: ${(err as Error)?.message ?? String(err)}`);
}

class BrowserHandleFile implements FsFile {
  #handle: FileSystemFileHandle;
  #writable: boolean;
  #mode: number;
  #buffer: Uint8Array | null = null;
  #dirty = false;
  #mtimeMs = Date.now();
  #saving: Promise<void> = Promise.resolve();

  constructor(handle: FileSystemFileHandle, writable: boolean, mode = 0o644) {
    this.#handle = handle;
    this.#writable = writable;
    this.#mode = mode;
  }

  async #load(): Promise<Uint8Array> {
    if (this.#buffer !== null) return this.#buffer;
    const file = await this.#handle.getFile();
    this.#mtimeMs = file.lastModified || Date.now();
    this.#buffer = new Uint8Array(await file.arrayBuffer());
    return this.#buffer;
  }

  async initTruncate(): Promise<void> {
    this.#buffer = new Uint8Array(0);
    this.#dirty = true;
    this.#mtimeMs = Date.now();
    await this.fsync();
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = await this.#load();
    if (offset >= buf.byteLength) return new Uint8Array(0);
    return buf.subarray(offset, Math.min(buf.byteLength, offset + length)).slice();
  }

  async write(offset: number, data: Uint8Array): Promise<number> {
    if (!this.#writable) throw new FsError("EACCES", this.#handle.name);
    const cur = await this.#load();
    const end = offset + data.byteLength;
    if (end > cur.byteLength) {
      const next = new Uint8Array(end);
      next.set(cur);
      this.#buffer = next;
    }
    this.#buffer!.set(data, offset);
    this.#dirty = true;
    this.#mtimeMs = Date.now();
    return data.byteLength;
  }

  async getattr(): Promise<FsAttr> {
    const buf = await this.#load();
    return {
      type: "file",
      mode: this.#mode,
      size: buf.byteLength,
      mtimeMs: this.#mtimeMs,
      atimeMs: this.#mtimeMs,
      ctimeMs: this.#mtimeMs,
    };
  }

  async setattr(attr: FsSetAttr): Promise<void> {
    if (attr.mode !== undefined) {
      this.#mode = attr.mode & 0o7777;
    }
    if (attr.size !== undefined) {
      if (!this.#writable) throw new FsError("EACCES", this.#handle.name);
      const cur = await this.#load();
      if (attr.size !== cur.byteLength) {
        const next = new Uint8Array(attr.size);
        next.set(cur.subarray(0, Math.min(cur.byteLength, attr.size)));
        this.#buffer = next;
        this.#dirty = true;
        this.#mtimeMs = Date.now();
      }
    }
    if (attr.mtimeMs !== undefined) {
      this.#mtimeMs = attr.mtimeMs;
    }
  }

  async fsync(): Promise<void> {
    if (!this.#dirty || !this.#writable || this.#buffer === null) return;
    const snapshot = this.#buffer.slice();
    this.#dirty = false;
    const run = async () => {
      const writable = await this.#handle.createWritable();
      try {
        await writable.write(snapshot);
      } finally {
        await writable.close();
      }
    };
    this.#saving = this.#saving.then(run, run);
    await this.#saving;
  }

  async close(): Promise<void> {
    await this.fsync();
    this.#buffer = null;
  }
}

export class BrowserDirectoryFs implements Fs {
  readonly root: FileSystemDirectoryHandle;
  readonly name: string;
  #modes = new Map<string, number>();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.name = root.name;
  }

  async #resolveDir(parts: string[], create = false): Promise<FileSystemDirectoryHandle> {
    let cur = this.root;
    for (const part of parts) {
      cur = await cur.getDirectoryHandle(part, { create });
    }
    return cur;
  }

  async #resolveParent(path: string): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const parts = splitPath(path);
    const name = parts.pop();
    if (!name) throw new FsError("EINVAL", path);
    const parent = await this.#resolveDir(parts, false);
    return { parent, name };
  }

  async #resolveEntry(path: string): Promise<FileSystemDirectoryHandle | FileSystemFileHandle> {
    const parts = splitPath(path);
    if (parts.length === 0) return this.root;
    const name = parts.pop()!;
    const parent = await this.#resolveDir(parts, false);
    try {
      return await parent.getFileHandle(name);
    } catch {
      return await parent.getDirectoryHandle(name);
    }
  }

  async getattr(path: string): Promise<FsAttr> {
    try {
      const entry = await this.#resolveEntry(path);
      if (entry.kind === "directory") {
        return {
          type: "dir",
          mode: this.#modes.get(path) ?? 0o755,
          size: 4096,
          mtimeMs: Date.now(),
        };
      }
      const file = await (entry as FileSystemFileHandle).getFile();
      return {
        type: "file",
        mode: this.#modes.get(path) ?? 0o644,
        size: file.size,
        mtimeMs: file.lastModified || Date.now(),
        atimeMs: file.lastModified || Date.now(),
        ctimeMs: file.lastModified || Date.now(),
      };
    } catch (err) {
      mapDomError(err, path);
    }
  }

  async readdir(path: string): Promise<FsDirEntry[]> {
    try {
      const dir = await this.#resolveDir(splitPath(path), false);
      const out: FsDirEntry[] = [];
      for await (const [name, handle] of dir.entries()) {
        out.push({
          name,
          type: handle.kind === "directory" ? "dir" : "file",
        });
      }
      return out;
    } catch (err) {
      mapDomError(err, path);
    }
  }

  async open(path: string, flags: FsOpenFlags): Promise<FsFile> {
    try {
      const { parent, name } = await this.#resolveParent(path);
      const handle = await parent.getFileHandle(name, { create: false });
      const mode = this.#modes.get(path) ?? 0o644;
      const f = new BrowserHandleFile(handle, flags.write, mode);
      if (flags.write && flags.truncate) {
        await f.initTruncate();
      }
      return f;
    } catch (err) {
      mapDomError(err, path);
    }
  }

  async create(path: string, mode: number): Promise<FsFile> {
    try {
      const { parent, name } = await this.#resolveParent(path);
      const exists = await parent
        .getFileHandle(name)
        .then(() => true)
        .catch(() =>
          parent
            .getDirectoryHandle(name)
            .then(() => true)
            .catch(() => false),
        );
      if (exists) throw new FsError("EEXIST", path);
      const handle = await parent.getFileHandle(name, { create: true });
      const m = (mode & 0o7777) || 0o644;
      this.#modes.set(path, m);
      const f = new BrowserHandleFile(handle, true, m);
      await f.initTruncate();
      return f;
    } catch (err) {
      mapDomError(err, path);
    }
  }

  async mkdir(path: string, mode: number): Promise<void> {
    try {
      const { parent, name } = await this.#resolveParent(path);
      const exists = await parent
        .getDirectoryHandle(name)
        .then(() => true)
        .catch(() =>
          parent
            .getFileHandle(name)
            .then(() => true)
            .catch(() => false),
        );
      if (exists) throw new FsError("EEXIST", path);
      await parent.getDirectoryHandle(name, { create: true });
      this.#modes.set(path, (mode & 0o7777) || 0o755);
    } catch (err) {
      mapDomError(err, path);
    }
  }

  async remove(path: string, dir: boolean): Promise<void> {
    try {
      const { parent, name } = await this.#resolveParent(path);
      if (dir) {
        await parent.getDirectoryHandle(name);
      } else {
        await parent.getFileHandle(name);
      }
      await parent.removeEntry(name, { recursive: false });
      this.#modes.delete(path);
    } catch (err) {
      mapDomError(err, path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      const entry = await this.#resolveEntry(from);
      if (entry.kind === "directory") {
        throw new FsError("EOPNOTSUPP", "Directory rename is not supported by browser FileSystemAccess API");
      }
      const srcFile = await (entry as FileSystemFileHandle).getFile();
      const { parent: dstParent, name: dstName } = await this.#resolveParent(to);
      const dstHandle = await dstParent.getFileHandle(dstName, { create: true });
      const writable = await dstHandle.createWritable();
      await srcFile.stream().pipeTo(writable);
      const { parent: srcParent, name: srcName } = await this.#resolveParent(from);
      await srcParent.removeEntry(srcName);
      const mode = this.#modes.get(from);
      if (mode !== undefined) {
        this.#modes.set(to, mode);
        this.#modes.delete(from);
      }
    } catch (err) {
      mapDomError(err, `${from} -> ${to}`);
    }
  }

  async setattr(path: string, attr: FsSetAttr): Promise<void> {
    try {
      if (attr.mode !== undefined) {
        this.#modes.set(path, attr.mode & 0o7777);
      }
      if (attr.size !== undefined) {
        const { parent, name } = await this.#resolveParent(path);
        const handle = await parent.getFileHandle(name, { create: false });
        const f = new BrowserHandleFile(handle, true, this.#modes.get(path) ?? 0o644);
        await f.setattr({ size: attr.size });
        await f.close();
      }
    } catch (err) {
      mapDomError(err, path);
    }
  }
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickHostDirectory(): Promise<BrowserDirectoryFs> {
  if (!window.showDirectoryPicker) {
    throw new Error("当前浏览器不支持 File System Access API (showDirectoryPicker)，请使用 Chromium / Edge / Chrome。");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  return new BrowserDirectoryFs(handle);
}
