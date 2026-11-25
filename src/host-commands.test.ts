// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import type { HostCommandContext } from "unkernel";
import {
  createHostCommands,
  parseOpenUrl,
  parsePreviewArgs,
  resolveGuestPath,
  sanitizeDropFilename,
  shellQuoteArg,
  type HostCommandDeps,
} from "./host-commands.ts";

function makeMockContext(opts: {
  name: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string | Uint8Array;
  signal?: AbortSignal;
}): {
  ctx: HostCommandContext;
  stdout: () => string;
  stderr: () => string;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const inputBytes =
    opts.input === undefined
      ? new Uint8Array(0)
      : typeof opts.input === "string"
        ? encoder.encode(opts.input)
        : opts.input;

  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      if (inputBytes.byteLength > 0) controller.enqueue(inputBytes);
      controller.close();
    },
  });

  const stdout = new WritableStream<Uint8Array | string>({
    write(chunk) {
      outChunks.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
  });

  const stderr = new WritableStream<Uint8Array | string>({
    write(chunk) {
      errChunks.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
  });

  const ctx: HostCommandContext = {
    name: opts.name,
    args: opts.args ?? [],
    env: opts.env ?? { HOME: "/root" },
    cwd: opts.cwd ?? "/workspace",
    pid: 42,
    uid: 0,
    gid: 0,
    isTTY: { stdin: false, stdout: false, stderr: false },
    cols: 80,
    rows: 24,
    stdin,
    stdout,
    stderr,
    signal: opts.signal ?? new AbortController().signal,
  };

  const joinChunks = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return decoder.decode(merged);
  };

  return {
    ctx,
    stdout: () => joinChunks(outChunks),
    stderr: () => joinChunks(errChunks),
  };
}

function makeMockDeps(overrides: Partial<HostCommandDeps> = {}): HostCommandDeps {
  return {
    readClipboard: async () => "clip-text",
    writeClipboard: async () => {},
    openPreview: () => {},
    closePreview: () => {},
    navigatePreview: () => {},
    openUrl: () => true,
    readGuestFile: async () => new Uint8Array([1, 2, 3]),
    writeGuestFile: async () => {},
    writeGuestFiles: async (files, dir) => files.map((f) => `${dir}/${f.name}`),
    triggerDownload: () => {},
    pickUploadFiles: async () => [],
    mountDirectory: async () => "/workspace/demo",
    listMounts: () => [],
    notify: () => {},
    ...overrides,
  };
}

describe("host-commands helpers", () => {
  test("resolveGuestPath normalizes relative, absolute, ., .., and ~ paths", () => {
    expect(resolveGuestPath("/workspace", "foo.txt")).toBe("/workspace/foo.txt");
    expect(resolveGuestPath("/workspace/sub", "../bar/./baz.ts")).toBe("/workspace/bar/baz.ts");
    expect(resolveGuestPath("/workspace", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveGuestPath("/workspace", "~")).toBe("/root");
    expect(resolveGuestPath("/workspace", "~/project/init.lua", "/home/dev")).toBe("/home/dev/project/init.lua");
    expect(resolveGuestPath("/workspace", "../../../../tmp")).toBe("/tmp");
  });

  test("sanitizeDropFilename strips paths, control characters, and dot names", () => {
    expect(sanitizeDropFilename("notes.md")).toBe("notes.md");
    expect(sanitizeDropFilename("/Users/a/b/hello.txt")).toBe("hello.txt");
    expect(sanitizeDropFilename("C:\\temp\\win\\data.json")).toBe("data.json");
    expect(sanitizeDropFilename("bad\x00name\x1f.txt")).toBe("badname.txt");
    expect(sanitizeDropFilename("..")).toBe("file");
    expect(sanitizeDropFilename(".")).toBe("file");
    expect(sanitizeDropFilename("   ")).toBe("file");
  });

  test("shellQuoteArg quotes spaces and single quotes safely", () => {
    expect(shellQuoteArg("/workspace/a.txt")).toBe("'/workspace/a.txt'");
    expect(shellQuoteArg("/workspace/my file.txt")).toBe("'/workspace/my file.txt'");
    expect(shellQuoteArg("/workspace/it's.lua")).toBe("'/workspace/it'\\''s.lua'");
  });

  test("parsePreviewArgs handles open, close, port, path, URLs, and invalid inputs", () => {
    expect(parsePreviewArgs([])).toEqual({ action: "open" });
    expect(parsePreviewArgs(["close"])).toEqual({ action: "close" });
    expect(parsePreviewArgs(["--close"])).toEqual({ action: "close" });
    expect(parsePreviewArgs(["5173"])).toEqual({ action: "navigate", port: 5173, path: "/" });
    expect(parsePreviewArgs(["5173", "/api/v1"])).toEqual({ action: "navigate", port: 5173, path: "/api/v1" });
    expect(parsePreviewArgs(["5173/app?q=1"])).toEqual({ action: "navigate", port: 5173, path: "/app?q=1" });
    expect(parsePreviewArgs(["http://localhost:3000/test"])).toEqual({
      action: "navigate",
      port: 3000,
      path: "/test",
    });
    expect(parsePreviewArgs(["http://127.0.0.1:8080"])).toEqual({
      action: "navigate",
      port: 8080,
      path: "/",
    });
    expect(parsePreviewArgs(["0"]).action).toBe("error");
    expect(parsePreviewArgs(["70000"]).action).toBe("error");
    expect(parsePreviewArgs(["3000", "//evil"]).action).toBe("error");
    expect(parsePreviewArgs(["abc"]).action).toBe("error");
  });

  test("parseOpenUrl allows http/https and rejects unsafe protocols", () => {
    const okHttps = parseOpenUrl(["https://example.com/docs?a=1"]);
    expect(okHttps.ok).toBe(true);
    if (okHttps.ok) expect(okHttps.url.href).toBe("https://example.com/docs?a=1");

    expect(parseOpenUrl(["http://localhost:5173"]).ok).toBe(true);
    expect(parseOpenUrl([]).ok).toBe(false);
    expect(parseOpenUrl(["javascript:alert(1)"]).ok).toBe(false);
    expect(parseOpenUrl(["data:text/plain,hi"]).ok).toBe(false);
    expect(parseOpenUrl(["file:///etc/passwd"]).ok).toBe(false);
  });
});

describe("createHostCommands", () => {
  test("pbcopy and pbpaste bridge stdin/stdout with clipboard deps", async () => {
    let copied = "";
    const cmds = createHostCommands(
      makeMockDeps({
        writeClipboard: async (text) => {
          copied = text;
        },
        readClipboard: async () => "from-host",
      }),
    );

    const copyRun = makeMockContext({ name: "pbcopy", input: "hello world\n" });
    expect(await cmds.pbcopy!(copyRun.ctx)).toBe(0);
    expect(copied).toBe("hello world\n");

    const pasteRun = makeMockContext({ name: "pbpaste" });
    expect(await cmds.pbpaste!(pasteRun.ctx)).toBe("from-host");
  });

  test("pbcopy and pbpaste support optional guest file paths for large transfers", async () => {
    let copied = "";
    const writtenFiles = new Map<string, Uint8Array>();
    const cmds = createHostCommands(
      makeMockDeps({
        readGuestFile: async (p) => new TextEncoder().encode(`file:${p}`),
        writeGuestFile: async (p, bytes) => {
          writtenFiles.set(p, bytes);
        },
        readClipboard: async () => "from-host-clipboard",
        writeClipboard: async (text) => {
          copied = text;
        },
      }),
    );

    const copyFileRun = makeMockContext({ name: "pbcopy", args: ["notes.txt"] });
    expect(await cmds.pbcopy!(copyFileRun.ctx)).toBe(0);
    expect(copied).toBe("file:/workspace/notes.txt");

    const pasteFileRun = makeMockContext({ name: "pbpaste", args: ["out.txt"] });
    expect(await cmds.pbpaste!(pasteFileRun.ctx)).toBe("/workspace/out.txt\n");
    expect(new TextDecoder().decode(writtenFiles.get("/workspace/out.txt"))).toBe("from-host-clipboard");
  });

  test("preview dispatches open, close, navigate, and rejects bad args", async () => {
    const calls: string[] = [];
    const cmds = createHostCommands(
      makeMockDeps({
        openPreview: () => calls.push("open"),
        closePreview: () => calls.push("close"),
        navigatePreview: (port, path) => calls.push(`nav:${port}:${path}`),
      }),
    );

    expect(await cmds.preview!(makeMockContext({ name: "preview", args: [] }).ctx)).toContain("已打开");
    expect(await cmds.preview!(makeMockContext({ name: "preview", args: ["5173", "/app"] }).ctx)).toContain(
      "localhost:5173/app",
    );
    expect(await cmds.preview!(makeMockContext({ name: "preview", args: ["close"] }).ctx)).toContain("已关闭");
    expect(calls).toEqual(["open", "nav:5173:/app", "close"]);

    const bad = makeMockContext({ name: "preview", args: ["notaport"] });
    expect(await cmds.preview!(bad.ctx)).toBe(2);
    expect(bad.stderr()).toContain("无效端口");
  });

  test("open reports blocked popups and returns 1", async () => {
    const notices: string[] = [];
    const cmds = createHostCommands(
      makeMockDeps({
        openUrl: () => false,
        notify: (m) => notices.push(m),
      }),
    );
    const run = makeMockContext({ name: "open", args: ["https://neovim.io"] });
    expect(await cmds.open!(run.ctx)).toBe(1);
    expect(run.stderr()).toContain("拦截了弹窗");
    expect(notices[0]).toContain("https://neovim.io/");
  });

  test("download reads guest files and stdin '-' mode", async () => {
    const downloads: Array<{ name: string; bytes: Uint8Array }> = [];
    const cmds = createHostCommands(
      makeMockDeps({
        readGuestFile: async (p) => new TextEncoder().encode(`content:${p}`),
        triggerDownload: (bytes, name) => downloads.push({ name, bytes }),
      }),
    );

    const fileRun = makeMockContext({ name: "download", cwd: "/workspace", args: ["notes.txt"] });
    expect(await cmds.download!(fileRun.ctx)).toBe(0);
    expect(downloads[0]?.name).toBe("notes.txt");
    expect(new TextDecoder().decode(downloads[0]?.bytes)).toBe("content:/workspace/notes.txt");
    expect(fileRun.stdout()).toContain("已下载 notes.txt");

    const stdinRun = makeMockContext({ name: "download", args: ["-", "pipe.txt"], input: "abc" });
    expect(await cmds.download!(stdinRun.ctx)).toBe(0);
    expect(downloads[1]?.name).toBe("pipe.txt");
    expect(new TextDecoder().decode(downloads[1]?.bytes)).toBe("abc");
  });

  test("upload writes picked files into target dir and prints paths", async () => {
    const file = new File(["hello"], "demo.lua", { type: "text/plain" });
    const cmds = createHostCommands(
      makeMockDeps({
        pickUploadFiles: async () => [file],
        writeGuestFiles: async (files, dir) => files.map((f) => `${dir}/${f.name}`),
      }),
    );

    const run = makeMockContext({ name: "upload", cwd: "/workspace", args: ["sub"] });
    expect(await cmds.upload!(run.ctx)).toBe("/workspace/sub/demo.lua\n");

    const cancelCmds = createHostCommands(makeMockDeps({ pickUploadFiles: async () => [] }));
    const cancelRun = makeMockContext({ name: "upload" });
    expect(await cancelCmds.upload!(cancelRun.ctx)).toBe(1);
    expect(cancelRun.stderr()).toContain("已取消上传");
  });

  test("mount triggers directory mount and lists active mounts", async () => {
    const cmds = createHostCommands(
      makeMockDeps({
        mountDirectory: async () => "/workspace/my-repo",
        listMounts: () => ["/workspace/a", "/workspace/b"],
      }),
    );

    expect(await cmds.mount!(makeMockContext({ name: "mount" }).ctx)).toBe("/workspace/my-repo\n");
    expect(await cmds.mount!(makeMockContext({ name: "mount", args: ["--list"] }).ctx)).toBe(
      "/workspace/a\n/workspace/b\n",
    );
  });
});
