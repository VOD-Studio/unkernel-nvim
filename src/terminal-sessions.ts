// SPDX-License-Identifier: MIT
// Pure session state helpers for concurrent multi-PTY terminal tabs and
// multi-TTY suspend/restore reconciliation.

import type { PtyEnd } from "unkernel";

export const MAX_TERMINAL_SESSIONS = 9;
// Cold boots have always assigned the first Neovim tab this ID. Reserve it across restores.
export const STARTUP_SESSION_ID = "pty-1";
const LEGACY_SINGLE_SESSION_ID = "restored-1";

export type SessionMode = "nvim" | "shell";

export interface TerminalSessionRecord {
  id: string;
  mode: SessionMode;
  title: string;
  cwd: string;
  terminalId?: string;
  exited: boolean;
  exitCode?: number | null;
}

export interface SuspendedTerminalEntry {
  id: string;
  mode: SessionMode;
  title: string;
  cwd: string;
  terminalId: string;
}

export function shouldReturnToShell(session: TerminalSessionRecord, end: PtyEnd): boolean {
  const startup = session.id === STARTUP_SESSION_ID || session.id === LEGACY_SINGLE_SESSION_ID;
  return startup && session.mode === "nvim" && (end.type === "exit" || end.type === "signal");
}

/** Generate a unique human-readable tab title such as "nvim", "fish", or "fish #2". */
export function nextSessionTitle(
  mode: SessionMode,
  shellName: string,
  existing: readonly TerminalSessionRecord[],
): string {
  const base = mode === "nvim" ? "nvim" : (shellName || "sh");
  const used = new Set(existing.map((s) => s.title));
  if (!used.has(base)) return base;

  let index = 2;
  while (used.has(`${base} #${index}`)) {
    index += 1;
  }
  return `${base} #${index}`;
}

/** Pick the next active session ID when closing a session, or null if none remain. */
export function pickNextActiveSessionId(
  sessions: readonly TerminalSessionRecord[],
  closingId: string,
  currentActiveId: string | null,
): string | null {
  const remaining = sessions.filter((s) => s.id !== closingId);
  if (remaining.length === 0) return null;
  if (currentActiveId && currentActiveId !== closingId && remaining.some((s) => s.id === currentActiveId)) {
    return currentActiveId;
  }
  const closingIndex = sessions.findIndex((s) => s.id === closingId);
  if (closingIndex <= 0) return remaining[0]!.id;
  return remaining[Math.min(closingIndex - 1, remaining.length - 1)]!.id;
}

/** Cycle through existing terminal sessions in either direction. */
export function cycleSessionId(
  sessions: readonly TerminalSessionRecord[],
  activeId: string | null,
  delta: 1 | -1,
): string | null {
  if (sessions.length === 0) return null;
  if (sessions.length === 1) return sessions[0]!.id;
  const idx = activeId ? sessions.findIndex((s) => s.id === activeId) : 0;
  const start = idx >= 0 ? idx : 0;
  const next = (start + delta + sessions.length) % sessions.length;
  return sessions[next]!.id;
}

/**
 * Reconcile saved session metadata against KernelSnapshot.ttys, preserving
 * backward compatibility with legacy single-terminalId snapshots.
 */
export function reconcileRestoredSessions(
  savedSessions: readonly SuspendedTerminalEntry[] | undefined,
  fallback: { mode: SessionMode; cwd: string; terminalId?: string },
  snapshotTtys: readonly { id: string }[] | undefined,
): SuspendedTerminalEntry[] {
  const validIds = snapshotTtys ? new Set(snapshotTtys.map((t) => t.id)) : null;

  if (savedSessions && savedSessions.length > 0) {
    return savedSessions.filter((entry) => Boolean(entry.terminalId) && (!validIds || validIds.has(entry.terminalId)));
  }

  if (fallback.terminalId && (!validIds || validIds.has(fallback.terminalId))) {
    return [
      {
        id: LEGACY_SINGLE_SESSION_ID,
        mode: fallback.mode,
        title: fallback.mode === "nvim" ? "nvim" : "shell",
        cwd: fallback.cwd,
        terminalId: fallback.terminalId,
      },
    ];
  }

  return [];
}
