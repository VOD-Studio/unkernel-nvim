// SPDX-License-Identifier: MIT
// Default interactive shell configuration, guest probe script, and fallback helpers.

export const DEFAULT_SHELL = "/usr/bin/fish";
export const FALLBACK_SHELLS = ["/bin/bash", "/bin/sh"] as const;
export const SHELL_CANDIDATES = [DEFAULT_SHELL, ...FALLBACK_SHELLS] as const;

// Match unkernel's default kwtty handshake timeout so probing waits for boot and commands.gate().
export const SHELL_PROBE_TIMEOUT_MS = 30_000;

export const SHELL_PROBE_SCRIPT =
  'for shell in /usr/bin/fish /bin/bash /bin/sh; do if [ -x "$shell" ]; then printf "%s" "$shell"; exit 0; fi; done; exit 1';

/** Extract a recognized interactive shell path from probe output. */
export function parseResolvedShell(stdout: string): string | null {
  const trimmed = stdout.trim();
  return (SHELL_CANDIDATES as readonly string[]).includes(trimmed) ? trimmed : null;
}

/** Return ordered shell candidates starting from a resolved shell, defaulting to fish first. */
export function getShellCandidatesToTry(resolved: string | null): readonly string[] {
  if (resolved) {
    const idx = (SHELL_CANDIDATES as readonly string[]).indexOf(resolved);
    if (idx !== -1) {
      return SHELL_CANDIDATES.slice(idx);
    }
  }
  return [...SHELL_CANDIDATES];
}

/** Return true only when spawn failed because the shell binary could not be found or executed. */
export function isShellNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code === "ENOENT") return true;
  if (err instanceof Error) {
    return /\b(?:ENOENT|EACCES|ENOTDIR)\b|no such file|not found|permission denied/i.test(err.message);
  }
  return false;
}
