// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  cycleSessionId,
  MAX_TERMINAL_SESSIONS,
  nextSessionTitle,
  pickNextActiveSessionId,
  reconcileRestoredSessions,
  type SuspendedTerminalEntry,
  type TerminalSessionRecord,
} from "./terminal-sessions.ts";

function makeRecord(overrides: Partial<TerminalSessionRecord> & { id: string }): TerminalSessionRecord {
  return {
    mode: "shell",
    title: "fish",
    cwd: "/workspace",
    exited: false,
    ...overrides,
  };
}

describe("terminal-sessions", () => {
  test("nextSessionTitle numbers duplicate titles per mode", () => {
    const existing: TerminalSessionRecord[] = [];
    expect(nextSessionTitle("nvim", "fish", existing)).toBe("nvim");

    existing.push(makeRecord({ id: "s1", mode: "nvim", title: "nvim" }));
    expect(nextSessionTitle("nvim", "fish", existing)).toBe("nvim #2");

    existing.push(makeRecord({ id: "s2", mode: "shell", title: "fish" }));
    expect(nextSessionTitle("shell", "fish", existing)).toBe("fish #2");

    existing.push(makeRecord({ id: "s3", mode: "shell", title: "fish #2" }));
    expect(nextSessionTitle("shell", "fish", existing)).toBe("fish #3");
  });

  test("pickNextActiveSessionId preserves other active tab or selects neighbor", () => {
    const list = [
      makeRecord({ id: "a" }),
      makeRecord({ id: "b" }),
      makeRecord({ id: "c" }),
    ];
    expect(pickNextActiveSessionId(list, "a", "c")).toBe("c");
    expect(pickNextActiveSessionId(list, "b", "b")).toBe("a");
    expect(pickNextActiveSessionId(list, "a", "a")).toBe("b");
    expect(pickNextActiveSessionId([makeRecord({ id: "only" })], "only", "only")).toBeNull();
  });

  test("cycleSessionId wraps around in both directions", () => {
    const list = [
      makeRecord({ id: "a" }),
      makeRecord({ id: "b" }),
      makeRecord({ id: "c" }),
    ];
    expect(cycleSessionId(list, "a", 1)).toBe("b");
    expect(cycleSessionId(list, "c", 1)).toBe("a");
    expect(cycleSessionId(list, "a", -1)).toBe("c");
    expect(cycleSessionId([], null, 1)).toBeNull();
    expect(MAX_TERMINAL_SESSIONS).toBe(9);
  });

  test("reconcileRestoredSessions handles multi-session metadata and legacy single-session fallback", () => {
    const entries: SuspendedTerminalEntry[] = [
      { id: "s1", mode: "nvim", title: "nvim", cwd: "/workspace", terminalId: "tty-1" },
      { id: "s2", mode: "shell", title: "fish", cwd: "/workspace", terminalId: "tty-2" },
    ];
    expect(
      reconcileRestoredSessions(entries, { mode: "nvim", cwd: "/workspace" }, [{ id: "tty-1" }]),
    ).toEqual([entries[0]!]);

    expect(
      reconcileRestoredSessions(undefined, { mode: "nvim", cwd: "/workspace", terminalId: "legacy-1" }, [
        { id: "legacy-1" },
      ]),
    ).toEqual([
      {
        id: "restored-1",
        mode: "nvim",
        title: "nvim",
        cwd: "/workspace",
        terminalId: "legacy-1",
      },
    ]);

    expect(
      reconcileRestoredSessions(undefined, { mode: "nvim", cwd: "/workspace", terminalId: "missing" }, [
        { id: "other" },
      ]),
    ).toEqual([]);
  });
});
