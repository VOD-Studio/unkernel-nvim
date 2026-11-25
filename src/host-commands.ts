// SPDX-License-Identifier: MIT
// Host commands exposed inside the guest via unkernel's createKernel({ commands })
// (/run/kw/bin/<name>) plus pure path/argument helpers and browser helpers.

import type { CommandsOption, HostCommandContext } from "unkernel";

const MAX_PBCOPY_BYTES = 16 * 1024 * 1024;
const MAX_DOWNLOAD_STDIN_BYTES = 64 * 1024 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface HostCommandDeps {
  readClipboard: () => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  openPreview: () => void;
  closePreview: () => void;
  navigatePreview: (port: number, path: string) => void;
  openUrl: (url: string) => boolean;
  readGuestFile: (guestPath: string, signal?: AbortSignal) => Promise<Uint8Array>;
  writeGuestFile?: (guestPath: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  writeGuestFiles: (files: readonly File[], targetDir: string, signal?: AbortSignal) => Promise<string[]>;
  triggerDownload: (bytes: Uint8Array, filename: string) => void;
  pickUploadFiles: (signal: AbortSignal) => Promise<File[]>;
  mountDirectory: () => Promise<string>;
  listMounts: () => string[];
  notify?: (message: string) => void;
}

export type ParsedPreviewArgs =
  | { action: "open" }
  | { action: "close" }
  | { action: "navigate"; port: number; path: string }
  | { action: "error"; message: string };

export type ParsedOpenUrl =
  | { ok: true; url: URL }
  | { ok: false; message: string };

/** Resolve a guest path relative to `cwd`, expanding leading `~` to `home`. */
export function resolveGuestPath(cwd: string, target: string, home = "/root"): string {
  const cleanHome = home.startsWith("/") ? home : `/${home}`;
  let combined: string;
  if (target === "~") {
    combined = cleanHome;
  } else if (target.startsWith("~/")) {
    combined = `${cleanHome}/${target.slice(2)}`;
  } else if (target.startsWith("/")) {
    combined = target;
  } else {
    const base = cwd.startsWith("/") ? cwd : "/";
    combined = `${base}/${target}`;
  }

  const parts: string[] = [];
  for (const segment of combined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return `/${parts.join("/")}`;
}

/** Sanitize a browser-supplied filename to a single safe POSIX basename. */
export function sanitizeDropFilename(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? "";
  let cleaned = "";
  for (let i = 0; i < leaf.length; i++) {
    const code = leaf.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += leaf[i]!;
  }
  cleaned = cleaned.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "file";
  }
  return cleaned;
}

/** Single-quote an argument safely for fish and POSIX shells. */
export function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Parse arguments for the guest `preview` host command. */
export function parsePreviewArgs(args: readonly string[]): ParsedPreviewArgs {
  const usage = "用法: preview [port [path] | close]";
  if (args.length === 0) {
    return { action: "open" };
  }
  const first = args[0]!;
  if (first === "-h" || first === "--help") {
    return { action: "error", message: usage };
  }
  if (first === "close" || first === "--close") {
    if (args.length > 1) {
      return { action: "error", message: usage };
    }
    return { action: "close" };
  }
  if (args.length > 2) {
    return { action: "error", message: usage };
  }

  let portStr = first;
  let path = args[1] ?? "/";
  const urlMatch = /^https?:\/\/[^/:?#]+:(\d+)(\/.*)?$/i.exec(first);
  if (urlMatch) {
    if (args.length > 1) {
      return { action: "error", message: usage };
    }
    portStr = urlMatch[1]!;
    path = urlMatch[2] || "/";
  } else {
    const slashIdx = first.indexOf("/");
    if (slashIdx !== -1) {
      if (args.length > 1) {
        return { action: "error", message: usage };
      }
      portStr = first.slice(0, slashIdx);
      path = first.slice(slashIdx);
    }
  }

  if (!/^\d+$/.test(portStr)) {
    return { action: "error", message: `无效端口: ${first}\n${usage}` };
  }
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { action: "error", message: `端口必须在 1–65535 之间: ${portStr}` };
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    return { action: "error", message: `路径必须以单个 / 开头: ${path}` };
  }
  return { action: "navigate", port, path };
}

/** Parse and validate an http/https URL for the guest `open` host command. */
export function parseOpenUrl(args: readonly string[]): ParsedOpenUrl {
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    return { ok: false, message: "用法: open <http(s)://url>" };
  }
  const raw = args[0]!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `无效 URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: `仅支持 http:// 或 https:// 链接，拒绝协议: ${url.protocol}` };
  }
  return { ok: true, url };
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    await reader.cancel().catch(() => {});
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`输入超出最大限制 (${Math.round(maxBytes / 1048576)} MiB)`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function writeErr(ctx: HostCommandContext, message: string): Promise<void> {
  const writer = ctx.stderr.getWriter();
  try {
    await writer.write(message.endsWith("\n") ? message : `${message}\n`);
  } finally {
    writer.releaseLock();
  }
}

async function writeOut(ctx: HostCommandContext, message: string): Promise<void> {
  const writer = ctx.stdout.getWriter();
  try {
    await writer.write(message);
  } finally {
    writer.releaseLock();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the map of host commands registered on `createKernel({ commands })`. */
export function createHostCommands(deps: HostCommandDeps): CommandsOption {
  return {
    async pbcopy(ctx) {
      if (ctx.args[0] === "-h" || ctx.args[0] === "--help" || ctx.args.length > 1) {
        await writeErr(ctx, "用法: <stdout> | pbcopy | pbcopy <file>");
        return 2;
      }
      try {
        let bytes: Uint8Array;
        if (ctx.args.length === 1) {
          const home = ctx.env.HOME || "/root";
          const guestPath = resolveGuestPath(ctx.cwd, ctx.args[0]!, home);
          bytes = await deps.readGuestFile(guestPath, ctx.signal);
          if (bytes.byteLength > MAX_PBCOPY_BYTES) {
            throw new Error(`输入超出最大限制 (${Math.round(MAX_PBCOPY_BYTES / 1048576)} MiB)`);
          }
        } else {
          bytes = await readStreamLimited(ctx.stdin, MAX_PBCOPY_BYTES, ctx.signal);
        }
        await deps.writeClipboard(decoder.decode(bytes));
        return 0;
      } catch (err) {
        await writeErr(ctx, `pbcopy: ${errorMessage(err)}`);
        return 1;
      }
    },

    async pbpaste(ctx) {
      if (ctx.args[0] === "-h" || ctx.args[0] === "--help" || ctx.args.length > 1) {
        await writeErr(ctx, "用法: pbpaste [file]");
        return 2;
      }
      try {
        const text = await deps.readClipboard();
        if (ctx.args.length === 1) {
          if (!deps.writeGuestFile) {
            throw new Error("当前宿主环境不支持写入文件");
          }
          const home = ctx.env.HOME || "/root";
          const guestPath = resolveGuestPath(ctx.cwd, ctx.args[0]!, home);
          const bytes = encoder.encode(text);
          await deps.writeGuestFile(guestPath, bytes, ctx.signal);
          return `${guestPath}\n`;
        }
        return text;
      } catch (err) {
        await writeErr(ctx, `pbpaste: ${errorMessage(err)}`);
        return 1;
      }
    },

    async preview(ctx) {
      const parsed = parsePreviewArgs(ctx.args);
      if (parsed.action === "error") {
        await writeErr(ctx, parsed.message);
        return 2;
      }
      if (parsed.action === "open") {
        deps.openPreview();
        return "已打开 Guest 端口预览面板\n";
      }
      if (parsed.action === "close") {
        deps.closePreview();
        return "已关闭 Guest 端口预览面板\n";
      }
      deps.navigatePreview(parsed.port, parsed.path);
      return `正在预览 http://localhost:${parsed.port}${parsed.path}\n`;
    },

    async open(ctx) {
      const parsed = parseOpenUrl(ctx.args);
      if (!parsed.ok) {
        await writeErr(ctx, parsed.message);
        return 2;
      }
      const opened = deps.openUrl(parsed.url.href);
      if (!opened) {
        const msg = `浏览器拦截了弹窗，请允许弹窗后重试: ${parsed.url.href}`;
        await writeErr(ctx, `open: ${msg}`);
        deps.notify?.(msg);
        return 1;
      }
      return 0;
    },

    async download(ctx) {
      if (ctx.args.length === 0 || ctx.args[0] === "-h" || ctx.args[0] === "--help") {
        await writeErr(ctx, "用法: download <file> [file...] | <stdout> | download - [filename]");
        return 2;
      }
      if (ctx.args[0] === "-") {
        try {
          const filename = sanitizeDropFilename(ctx.args[1] || "download.bin");
          const bytes = await readStreamLimited(ctx.stdin, MAX_DOWNLOAD_STDIN_BYTES, ctx.signal);
          deps.triggerDownload(bytes, filename);
          await writeOut(ctx, `已下载 ${filename} (${bytes.byteLength} B)\n`);
          return 0;
        } catch (err) {
          await writeErr(ctx, `download: ${errorMessage(err)}`);
          return 1;
        }
      }

      const home = ctx.env.HOME || "/root";
      for (const arg of ctx.args) {
        const guestPath = resolveGuestPath(ctx.cwd, arg, home);
        const filename = sanitizeDropFilename(guestPath.split("/").pop() || "download.bin");
        try {
          const bytes = await deps.readGuestFile(guestPath, ctx.signal);
          deps.triggerDownload(bytes, filename);
          await writeOut(ctx, `已下载 ${filename} (${bytes.byteLength} B)\n`);
        } catch (err) {
          await writeErr(ctx, `download: ${guestPath}: ${errorMessage(err)}`);
          return 1;
        }
      }
      return 0;
    },

    async upload(ctx) {
      if (ctx.args[0] === "-h" || ctx.args[0] === "--help") {
        await writeErr(ctx, "用法: upload [target-dir]");
        return 2;
      }
      const home = ctx.env.HOME || "/root";
      const targetDir = ctx.args[0] ? resolveGuestPath(ctx.cwd, ctx.args[0], home) : ctx.cwd;
      try {
        const files = await deps.pickUploadFiles(ctx.signal);
        if (files.length === 0) {
          await writeErr(ctx, "已取消上传");
          return 1;
        }
        const paths = await deps.writeGuestFiles(files, targetDir, ctx.signal);
        deps.notify?.(
          paths.length === 1
            ? `已上传 ${paths[0]}`
            : `已上传 ${paths.length} 个文件到 ${targetDir}`,
        );
        return `${paths.join("\n")}\n`;
      } catch (err) {
        await writeErr(ctx, `upload: ${errorMessage(err)}`);
        return 1;
      }
    },

    async mount(ctx) {
      if (ctx.args[0] === "-h" || ctx.args[0] === "--help") {
        await writeErr(ctx, "用法: mount [-l|--list]");
        return 2;
      }
      if (ctx.args[0] === "-l" || ctx.args[0] === "--list") {
        const list = deps.listMounts();
        return list.length > 0 ? `${list.join("\n")}\n` : "";
      }
      try {
        const guestPath = await deps.mountDirectory();
        return `${guestPath}\n`;
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === "AbortError") {
          await writeErr(ctx, "已取消挂载");
          return 1;
        }
        if (name === "SecurityError" || name === "NotAllowedError") {
          await writeErr(ctx, "mount: 浏览器需要用户手势才能打开目录选择器，请直接在终端前景运行或在控制中心 (Ctrl+Shift+P) 挂载。");
          return 1;
        }
        await writeErr(ctx, `mount: ${errorMessage(err)}`);
        return 1;
      }
    },
  };
}

/** Trigger a browser file download for raw bytes. */
export function triggerBrowserDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.slice()]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** Open a temporary `<input type="file" multiple>` picker that resolves when files are chosen or cancelled. */
export function createBrowserFilePicker(signal: AbortSignal): Promise<File[]> {
  return new Promise<File[]>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;

    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      window.removeEventListener("focus", onWindowFocus);
      input.remove();
    };
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    // Fallback for browsers that do not emit the `cancel` event on `<input type="file">`.
    const onWindowFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          finish([]);
        }
      }, 300);
    };

    input.addEventListener("change", () => {
      finish(Array.from(input.files ?? []));
    });
    input.addEventListener("cancel", () => {
      finish([]);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("focus", onWindowFocus);

    document.body.append(input);
    input.click();
  });
}
