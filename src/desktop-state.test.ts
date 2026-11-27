// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  applyWindowResize,
  buildDebianDesktopInstallCommand,
  clampWindowRect,
  computeCascadeRect,
  computeContextMenuPosition,
  computeDockMagnification,
  formatAudioButtonState,
  formatWaylandScale,
  parseLauncherCommand,
  parseStoredBoolean,
  parseWaylandScale,
  WIN_EDGE_BOTTOM,
  WIN_EDGE_LEFT,
  WIN_EDGE_RIGHT,
  WIN_EDGE_TOP,
} from "./desktop-state.ts";

describe("desktop-state", () => {
  test("parseStoredBoolean parses 1/true/0/false and applies fallback", () => {
    expect(parseStoredBoolean("1")).toBe(true);
    expect(parseStoredBoolean("true")).toBe(true);
    expect(parseStoredBoolean("0")).toBe(false);
    expect(parseStoredBoolean("false")).toBe(false);
    expect(parseStoredBoolean(null, true)).toBe(true);
    expect(parseStoredBoolean("other", false)).toBe(false);
  });

  test("clampWindowRect keeps window size and titlebar within desktop bounds", () => {
    const bounds = { width: 1200, height: 800 };
    expect(clampWindowRect({ x: -2000, y: -50, width: 1500, height: 950 }, bounds)).toEqual({
      x: -1136,
      y: 0,
      width: 1200,
      height: 800,
    });
    expect(clampWindowRect({ x: 100, y: 120, width: 120, height: 80 }, bounds)).toEqual({
      x: 100,
      y: 120,
      width: 320,
      height: 200,
    });
  });

  test("computeCascadeRect offsets windows cleanly inside small and large viewports", () => {
    const bounds = { width: 1280, height: 720 };
    const r0 = computeCascadeRect(0, bounds, 700, 480);
    const r1 = computeCascadeRect(1, bounds, 700, 480);
    expect(r0.x).toBe(24);
    expect(r0.y).toBe(24);
    expect(r1.x).toBe(52);
    expect(r1.y).toBe(52);
  });

  test("applyWindowResize adjusts position for top/left edges and respects min/max limits", () => {
    const bounds = { width: 1280, height: 720 };
    const start = { x: 200, y: 150, width: 500, height: 400 };

    expect(applyWindowResize(start, 60, -40, WIN_EDGE_RIGHT | WIN_EDGE_BOTTOM, bounds)).toEqual({
      x: 200,
      y: 150,
      width: 560,
      height: 360,
    });

    expect(applyWindowResize(start, 100, 50, WIN_EDGE_LEFT | WIN_EDGE_TOP, bounds)).toEqual({
      x: 300,
      y: 200,
      width: 400,
      height: 350,
    });

    // Respects max size limits
    expect(applyWindowResize(start, 400, 400, WIN_EDGE_RIGHT | WIN_EDGE_BOTTOM, bounds, 320, 200, 600, 450)).toEqual({
      x: 200,
      y: 150,
      width: 600,
      height: 450,
    });
  });

  test("parseLauncherCommand splits whitespace, quotes, and escapes", () => {
    expect(parseLauncherCommand("")).toBeNull();
    expect(parseLauncherCommand("   ")).toBeNull();
    expect(parseLauncherCommand("foot")).toEqual({ file: "foot", args: [] });
    expect(parseLauncherCommand('pcmanfm "/workspace/my project" --new-win')).toEqual({
      file: "pcmanfm",
      args: ["/workspace/my project", "--new-win"],
    });
    expect(parseLauncherCommand("mousepad '/tmp/it is.txt'")).toEqual({
      file: "mousepad",
      args: ["/tmp/it is.txt"],
    });
  });

  test("buildDebianDesktopInstallCommand installs core Wayland/X11 desktop packages", () => {
    const cmd = buildDebianDesktopInstallCommand();
    expect(cmd).toContain("apt-get install");
    expect(cmd).toContain("foot");
    expect(cmd).toContain("pcmanfm");
    expect(cmd).toContain("xwayland");
    expect(cmd).toContain("libegl-mesa0");
  });

  test("parseWaylandScale and formatWaylandScale handle auto, valid, and out-of-range values", () => {
    expect(parseWaylandScale(null)).toBeNull();
    expect(parseWaylandScale("")).toBeNull();
    expect(parseWaylandScale("auto")).toBeNull();
    expect(parseWaylandScale("0")).toBeNull();
    expect(parseWaylandScale("-1")).toBeNull();
    expect(parseWaylandScale("5")).toBeNull();
    expect(parseWaylandScale("abc")).toBeNull();
    expect(parseWaylandScale("1.5")).toBe(1.5);
    expect(parseWaylandScale("2")).toBe(2);

    expect(formatWaylandScale(null)).toBe("自动");
    expect(formatWaylandScale(null, 2)).toBe("自动 (2×)");
    expect(formatWaylandScale(null, 1.25)).toBe("自动 (1.25×)");
    expect(formatWaylandScale(1.5, 2)).toBe("1.5×");
  });

  test("formatAudioButtonState maps waiting, running, idle, and muted states", () => {
    expect(formatAudioButtonState("waiting", false)).toEqual({
      label: "点击启用音频",
      title: "浏览器拦截了自动播放，点击立即播放虚拟机音频",
      attention: true,
      pressed: false,
      action: "resume",
    });
    expect(formatAudioButtonState("running", true)).toEqual({
      label: "静音中",
      title: "点击取消静音",
      attention: false,
      pressed: true,
      action: "toggle-mute",
    });
    expect(formatAudioButtonState("running", false)).toEqual({
      label: "音频中",
      title: "点击静音",
      attention: false,
      pressed: false,
      action: "toggle-mute",
    });
    expect(formatAudioButtonState("idle", false)).toEqual({
      label: "音频",
      title: "点击静音",
      attention: false,
      pressed: false,
      action: "toggle-mute",
    });
  });

  test("computeDockMagnification applies symmetric cosine falloff within radius", () => {
    const centers = [100, 150, 200, 320];
    expect(computeDockMagnification(centers, null, 1.25, 90)).toEqual([1, 1, 1, 1]);
    expect(computeDockMagnification(centers, 150, 1.25, 0)).toEqual([1, 1, 1, 1]);

    const scales = computeDockMagnification(centers, 150, 1.25, 90);
    expect(scales[1]).toBe(1.25);
    expect(scales[0]).toBeCloseTo(scales[2]!, 4);
    expect(scales[0]!).toBeGreaterThan(1);
    expect(scales[0]!).toBeLessThan(1.25);
    expect(scales[3]).toBe(1);
  });

  test("computeContextMenuPosition flips near edges and clamps to viewport & topbar inset", () => {
    // Normal placement below-right of pointer
    expect(computeContextMenuPosition(240, 180, 200, 260, 1280, 800)).toEqual({
      left: 240,
      top: 180,
    });

    // Near right & bottom edges: flips left & up
    expect(computeContextMenuPosition(1200, 740, 200, 260, 1280, 800)).toEqual({
      left: 1000,
      top: 480,
    });

    // Near topbar: clamps to topInset (36px)
    expect(computeContextMenuPosition(120, 12, 200, 180, 1280, 800)).toEqual({
      left: 120,
      top: 36,
    });

    // Very small viewport: clamps cleanly to padding/topInset
    expect(computeContextMenuPosition(50, 50, 300, 300, 260, 240, 10, 36)).toEqual({
      left: 10,
      top: 36,
    });
  });
});
