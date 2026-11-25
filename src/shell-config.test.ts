// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SHELL,
  SHELL_CANDIDATES,
  getShellCandidatesToTry,
  isShellNotFoundError,
  parseResolvedShell,
} from "./shell-config.ts";

describe("shell-config", () => {
  test("prefers fish followed by bash and sh", () => {
    expect(DEFAULT_SHELL).toBe("/usr/bin/fish");
    expect(SHELL_CANDIDATES).toEqual(["/usr/bin/fish", "/bin/bash", "/bin/sh"]);
  });

  test("parseResolvedShell trims valid candidates and rejects unknown output", () => {
    expect(parseResolvedShell("/usr/bin/fish\n")).toBe("/usr/bin/fish");
    expect(parseResolvedShell("  /bin/bash  ")).toBe("/bin/bash");
    expect(parseResolvedShell("/bin/sh")).toBe("/bin/sh");
    expect(parseResolvedShell("")).toBeNull();
    expect(parseResolvedShell("   \n")).toBeNull();
    expect(parseResolvedShell("/bin/zsh")).toBeNull();
  });

  test("getShellCandidatesToTry orders fallbacks from resolved shell", () => {
    expect(getShellCandidatesToTry(null)).toEqual(["/usr/bin/fish", "/bin/bash", "/bin/sh"]);
    expect(getShellCandidatesToTry("/usr/bin/fish")).toEqual(["/usr/bin/fish", "/bin/bash", "/bin/sh"]);
    expect(getShellCandidatesToTry("/bin/bash")).toEqual(["/bin/bash", "/bin/sh"]);
    expect(getShellCandidatesToTry("/bin/sh")).toEqual(["/bin/sh"]);
    expect(getShellCandidatesToTry("/bin/zsh")).toEqual(["/usr/bin/fish", "/bin/bash", "/bin/sh"]);
  });

  test("isShellNotFoundError distinguishes missing binaries from transient errors", () => {
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isShellNotFoundError(enoent)).toBe(true);
    expect(isShellNotFoundError(new Error("kwtty: ENOENT: /usr/bin/fish"))).toBe(true);
    expect(isShellNotFoundError(new Error("Permission denied"))).toBe(true);
    expect(isShellNotFoundError(new Error("No such file or directory"))).toBe(true);

    const aborted = Object.assign(new Error("aborted"), { code: "ABORTED" });
    const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(isShellNotFoundError(aborted)).toBe(false);
    expect(isShellNotFoundError(reset)).toBe(false);
    expect(isShellNotFoundError(new Error("The operation timed out"))).toBe(false);
    expect(isShellNotFoundError(null)).toBe(false);
    expect(isShellNotFoundError("ENOENT")).toBe(false);
  });
});
