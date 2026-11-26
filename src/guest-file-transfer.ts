// SPDX-License-Identifier: MIT
// Adapted from pithings/unkernel web/src/upload.ts.
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>

import type { KernelHandle } from "unkernel";
import { sanitizeDropFilename } from "./host-commands.ts";
import { readGuestFileViaShm } from "./shm-transfer.ts";

// Field 8 of /proc/PID/stat is the terminal's foreground process group.
// The process name in parentheses may itself contain spaces or parentheses.
const SHELL_DIRECTORY = `set -f
read -r stat < "/proc/$1/stat" || exit 0
set -- \${stat##*\\) }
pid=$6
read -r name < "/proc/$pid/comm" || exit 0
case "$name" in sh|ash|bash|dash|zsh|fish|busybox) ;; *) exit 0 ;; esac
first=1
for arg in $(tr '\\000' '\\n' < "/proc/$pid/cmdline"); do
  if [ "$first" = 1 ]; then first=0; continue; fi
  case "$arg" in --command|--command=*) exit 0 ;; --*) ;; -*c*) exit 0 ;; -*) ;; *) exit 0 ;; esac
done
cd -P -- "/proc/$pid/cwd" 2>/dev/null || exit 0
if [ -d "$PWD" ] && [ -w "$PWD" ]; then printf '%s' "$PWD"; fi`;

export async function foregroundShellDirectory(vm: KernelHandle, pid: number): Promise<string | null> {
  const result = await vm.exec("/bin/sh", ["-c", SHELL_DIRECTORY, "drop", String(pid)], {
    user: "root",
    timeout: 5000,
  });
  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

// Publish only after EOF and size verification. link(2) cannot replace an
// existing name. On mounts without hard links (including 9p), reserve the
// candidate with noclobber before renaming the completed file over it.
const PUBLISH_UPLOAD = `set -eu
cd -- "$1"
tmp=$6
reserved=
trap 'rm -f -- "$tmp"; if [ -n "$reserved" ]; then rm -f -- "$reserved"; fi' EXIT
trap 'exit 1' HUP INT TERM
if [ "$(stat -c %s "$tmp")" != "$5" ]; then echo '上传文件大小不符' >&2; exit 1; fi
chmod 644 "$tmp"
name=$2
index=1
while :; do
  dest=./$name
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    if link "$tmp" "$dest" 2>/dev/null; then break; fi
    if (set -C; : > "$dest") 2>/dev/null; then
      reserved=$dest
      mv -fT -- "$tmp" "$dest"
      reserved=
      break
    fi
    if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then echo "无法创建文件: $dest" >&2; exit 1; fi
  fi
  index=$((index + 1))
  name="$3 ($index)$4"
done
printf '%s/%s' "\${PWD%/}" "$name"`;

/** Run a transfer on guest pipes. Keep draining both outputs while feeding stdin. */
async function transfer(
  vm: KernelHandle,
  command: string,
  args: string[],
  input?: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Blob> {
  const proc = await vm.spawn(command, args, { pty: false, user: "root", signal });
  const abort = () => { void proc.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const [output, stderr, end] = await Promise.all([
      new Response(proc.stdout).blob(),
      new Response(proc.stderr).text(),
      proc.ended,
      input ? input.pipeTo(proc.stdin, { signal, preventAbort: true }) : proc.stdin.close(),
    ]);
    signal?.throwIfAborted();
    if (end.type !== "exit" || end.code !== 0) {
      throw new Error(stderr.trim() || `${command} 文件传输失败`);
    }
    return output;
  } finally {
    signal?.removeEventListener("abort", abort);
    await proc.close().catch(() => {});
  }
}

export async function uploadGuestFile(
  vm: KernelHandle,
  file: File,
  dir: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const name = sanitizeDropFilename(file.name);
  const dot = name.lastIndexOf(".");
  const encoder = new TextEncoder();
  const suffix = dot > 0 ? name.slice(dot) : "";
  const extension = encoder.encode(suffix).length <= 64 ? suffix : "";
  const stem = name.slice(0, name.length - extension.length);
  // Leave room for the collision suffix within ext4's 255-byte name limit.
  const { read } = encoder.encodeInto(stem, new Uint8Array(240 - encoder.encode(extension).length));
  const numberedStem = stem.slice(0, read);
  const original = encoder.encode(name).length <= 255 ? name : numberedStem + extension;
  // Learn the temporary path before streaming. A cancelled or broken pipe
  // may hang up its guest process before a shell cleanup trap gets to run.
  const stage = await vm.exec(
    "/bin/sh",
    ["-ec", 'mkdir -p -- "$1"; mktemp -- "$1/.upload.XXXXXX"', "upload", dir],
    { user: "root" },
  );
  if (stage.exitCode !== 0) throw new Error(stage.stderr.trim() || `无法在 ${dir} 创建临时文件`);
  const tmp = stage.stdout.trimEnd();
  try {
    await transfer(vm, "/bin/sh", ["-ec", 'exec cat > "$1"', "upload", tmp], file.stream(), signal);
    signal?.throwIfAborted();
    // Once publishing starts, let it finish the name reservation and rename.
    const args = ["-c", PUBLISH_UPLOAD, "upload", dir, original, numberedStem, extension, String(file.size), tmp];
    const result = await vm.exec("/bin/sh", args, { user: "root" });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `无法保存 ${name}`);
    return result.stdout;
  } catch (error) {
    await vm.exec("/bin/rm", ["-f", "--", tmp], { user: "root" }).catch(() => {});
    throw error;
  }
}

export async function readGuestDownload(vm: KernelHandle, path: string, signal?: AbortSignal): Promise<File> {
  const filename = sanitizeDropFilename(path.split("/").pop() || "root");
  const directory = await vm.exec(
    "/bin/sh",
    ["-c", 'if [ -d "$1" ]; then cd -P -- "$1" && printf %s "$PWD"; fi', "download", path],
    { user: "root", signal },
  );
  if (directory.exitCode !== 0) throw new Error(directory.stderr.trim() || `无法访问 ${path}`);
  if (!directory.stdout) {
    const bytes = await readGuestFileViaShm(vm, path, signal);
    return new File([bytes.slice()], filename);
  }
  const slash = directory.stdout.lastIndexOf("/");
  const parent = directory.stdout.slice(0, slash) || "/";
  const name = directory.stdout.slice(slash + 1);
  const blob = await transfer(vm, "tar", ["-czf", "-", "-C", parent, name ? `./${name}` : "."], undefined, signal);
  return new File([blob], `${filename}.tar.gz`, { type: "application/gzip" });
}
