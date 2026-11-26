// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createKernel, type KernelHandle } from "unkernel/node";
import { foregroundShellDirectory, readGuestDownload, uploadGuestFile } from "./guest-file-transfer.ts";

describe("guest file transfers", () => {
  let vm: KernelHandle;
  beforeAll(async () => {
    // Only the package's bundled BusyBox is needed, including for the 9p mount.
    vm = await createKernel({ memoryMiB: 128, mounts: { "/mnt/files": {} }, log() {} });
  });
  afterAll(async () => { await vm?.stop(); });

  test("finds the foreground interactive shell's directory after cd", async () => {
    const pty = await vm.spawn("/bin/sh", ["-i"], { user: "root", cwd: "/" });
    const reader = pty.output.getReader();
    try {
      await pty.write("cd /tmp && echo drop''-ready\n");
      let output = "";
      while (!output.includes("drop-ready")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("shell ended before cd");
        output += new TextDecoder().decode(chunk.value);
      }
      expect(await foregroundShellDirectory(vm, pty.pid)).toBe("/tmp");
    } finally {
      reader.releaseLock();
      await pty.close();
    }
    const cat = await vm.spawn("/bin/cat", [], { user: "root" });
    try {
      expect(await foregroundShellDirectory(vm, cat.pid)).toBeNull();
    } finally {
      await cat.close();
    }
  });

  for (const dir of ["/tmp/native files", "/mnt/files/project"]) {
    test(`preserves names and contents across simultaneous uploads in ${dir}`, async () => {
      const setup = await vm.exec("/bin/sh", ["-ec", 'mkdir -p "$1/notes (2).txt"; printf original > "$1/notes.txt"', "setup", dir]);
      expect(setup.exitCode).toBe(0);
      const files = ["one", "two"].map((content) => new File([content], "notes.txt"));
      const paths = await Promise.all(files.map((file) => uploadGuestFile(vm, file, dir)));
      expect(paths.toSorted()).toEqual([`${dir}/notes (3).txt`, `${dir}/notes (4).txt`]);
      expect((await vm.exec("cat", [`${dir}/notes.txt`, ...paths])).stdout).toBe("originalonetwo");
      expect((await vm.exec("ls", ["-A", dir])).stdout).not.toContain(".upload.");
    });
  }

  test("keeps dangling symlinks and numbers long UTF-8 names within the filesystem limit", async () => {
    const dir = "/tmp/name-conflicts";
    const setup = await vm.exec("/bin/sh", ["-ec", 'mkdir -p "$1"; ln -s missing "$1/.env"', "setup", dir]);
    expect(setup.exitCode).toBe(0);
    expect(await uploadGuestFile(vm, new File([], ".env"), dir)).toBe(`${dir}/.env (2)`);
    expect((await vm.exec("readlink", [`${dir}/.env`])).stdout.trim()).toBe("missing");

    const name = "界".repeat(83) + "ab.txt"; // Exactly 255 UTF-8 bytes.
    const file = new File(["first"], name);
    expect(await uploadGuestFile(vm, file, dir)).toBe(`${dir}/${name}`);
    const copy = await uploadGuestFile(vm, new File(["second"], name), dir);
    expect(copy).toMatch(/界+ \(2\)\.txt$/);
    expect((await vm.exec("cat", [`${dir}/${name}`, copy])).stdout).toBe("firstsecond");
  });

  test("validates streamed bytes and removes incomplete files", async () => {
    const dir = "/tmp/incomplete";
    const short = new File(["expected size"], "partial.bin");
    Object.defineProperty(short, "stream", { value: () => new Blob(["short"]).stream() });
    await expect(uploadGuestFile(vm, short, dir)).rejects.toThrow("大小不符");
    const broken = new File([], "unreadable.bin");
    Object.defineProperty(broken, "stream", { value: () => new ReadableStream({
      start(writer) { writer.error(new Error("cannot read source")); },
    }) });
    await expect(uploadGuestFile(vm, broken, dir)).rejects.toThrow("cannot read source");
    expect((await vm.exec("ls", ["-A", dir])).stdout).toBe("");
  });

  test("cancelling an open stream discards its staged bytes", async () => {
    const dir = "/tmp/cancel-transfer";
    const controller = new AbortController();
    const file = new File(["data"], "cancel.bin");
    Object.defineProperty(file, "stream", { value: () => new ReadableStream({
      start(writer) { writer.enqueue(new TextEncoder().encode("data")); },
    }) });
    const upload = uploadGuestFile(vm, file, dir, controller.signal);
    // Even if every declared byte arrived, EOF is required to publish it.
    const staged = await vm.exec("/bin/sh", ["-c", 'until test -s "$1"/.upload.*; do sleep 0.01; done', "wait", dir], {
      signal: AbortSignal.timeout(2000),
    });
    expect(staged.exitCode).toBe(0);
    controller.abort(new Error("cancel transfer"));
    await expect(upload).rejects.toThrow("cancel transfer");
    expect((await vm.exec("ls", ["-A", dir])).stdout).toBe("");
  });

  test("downloads nested directories including dotfiles, and individual binary files", async () => {
    const dir = "/tmp/-archive dir";
    const bytes = new Uint8Array([0, 255, 0, 42]);
    await uploadGuestFile(vm, new File([bytes], "data.bin"), `${dir}/nested`);
    await uploadGuestFile(vm, new File([], ".hidden"), dir);
    const archive = await readGuestDownload(vm, dir);
    expect(archive.name).toBe("-archive dir.tar.gz");
    const entry = await vm.exec("tar", ["-xzOf", "-", "./-archive dir/nested/data.bin"], {
      input: await archive.bytes(), encoding: "buffer",
    });
    expect(entry.exitCode).toBe(0);
    expect(entry.stdout).toEqual(bytes);
    expect((await vm.exec("tar", ["-tzf", "-"], { input: await archive.bytes() })).stdout).toContain("/.hidden");
    expect(await (await readGuestDownload(vm, `${dir}/nested/data.bin`)).bytes()).toEqual(bytes);
  });
});
