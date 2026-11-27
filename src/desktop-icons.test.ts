// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  DESKTOP_ICONS,
  resolvePresetIcon,
  resolveWaylandAppIcon,
  type DesktopIconId,
} from "./desktop-icons.ts";
import { DESKTOP_APP_PRESETS } from "./desktop-state.ts";

describe("desktop-icons", () => {
  test("every icon spec provides valid inline SVG markup without duplicate-prone ID attributes", () => {
    const ids = Object.keys(DESKTOP_ICONS) as DesktopIconId[];
    expect(ids.length).toBeGreaterThanOrEqual(14);
    for (const id of ids) {
      const spec = DESKTOP_ICONS[id];
      expect(spec.id).toBe(id);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.svg).toContain("<svg ");
      expect(spec.svg).toContain("</svg>");
      expect(spec.svg).not.toMatch(/\bid\s*=/i);
    }
  });

  test("all built-in launcher presets resolve to distinct matching icons", () => {
    const resolved = new Map(
      DESKTOP_APP_PRESETS.map((preset) => [preset.id, resolvePresetIcon(preset)]),
    );
    expect(resolved.get("foot")).toBe("terminal");
    expect(resolved.get("pcmanfm")).toBe("files");
    expect(resolved.get("mousepad")).toBe("editor");
    expect(resolved.get("glmark2")).toBe("graphics");
    expect(resolved.get("xterm")).toBe("x11");
    expect(resolved.get("ristretto")).toBe("image");
    expect(resolved.get("zathura")).toBe("document");
    expect(resolved.get("xarchiver")).toBe("archive");
    expect(resolved.get("galculator")).toBe("calculator");
  });

  test("resolveWaylandAppIcon classifies common Linux apps and avoids false substring matches", () => {
    expect(resolveWaylandAppIcon("nvim", "Neovim")).toBe("neovim");
    expect(resolveWaylandAppIcon("xterm", "XTerm")).toBe("x11");
    expect(resolveWaylandAppIcon("xwayland-satellite", "xeyes")).toBe("x11");
    expect(resolveWaylandAppIcon("foot", "foot")).toBe("terminal");
    expect(resolveWaylandAppIcon("pcmanfm", "/workspace")).toBe("files");
    expect(resolveWaylandAppIcon("org.xfce.mousepad", "Untitled")).toBe("editor");
    expect(resolveWaylandAppIcon("glmark2-es2-wayland", "glmark2")).toBe("graphics");
    expect(resolveWaylandAppIcon("org.mozilla.firefox", "Firefox")).toBe("browser");
    expect(resolveWaylandAppIcon("mpv", "video.mp4")).toBe("media");
    expect(resolveWaylandAppIcon("org.pwmt.zathura", "code.pdf")).toBe("document");
    expect(resolveWaylandAppIcon("org.xfce.ristretto", "map.png")).toBe("image");
    expect(resolveWaylandAppIcon("xarchiver", "workspace.zip")).toBe("archive");
    expect(resolveWaylandAppIcon("galculator")).toBe("calculator");

    // Must not falsely match "st" inside "weston" as a terminal
    expect(resolveWaylandAppIcon("weston-flower", "Flower")).toBe("wayland");
    expect(resolveWaylandAppIcon("", "")).toBe("wayland");
    expect(resolveWaylandAppIcon(null, null)).toBe("wayland");
  });
});
