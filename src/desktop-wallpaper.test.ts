// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WALLPAPER_CONFIG,
  formatWallpaperSummary,
  getNextWallpaperPresetId,
  getWallpaperPreset,
  MAX_WALLPAPER_FILE_BYTES,
  parseWallpaperConfig,
  parseWallpaperUrl,
  resolveWallpaperStyles,
  serializeWallpaperConfig,
  validateWallpaperFile,
  WALLPAPER_PRESETS,
} from "./desktop-wallpaper.ts";

describe("desktop-wallpaper", () => {
  test("built-in presets have unique IDs and non-empty styles", () => {
    const ids = new Set(WALLPAPER_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(WALLPAPER_PRESETS.length);
    expect(WALLPAPER_PRESETS.length).toBe(8);
    for (const preset of WALLPAPER_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.backgroundImage.length).toBeGreaterThan(0);
    }
    expect(getWallpaperPreset("unknown").id).toBe(WALLPAPER_PRESETS[0]!.id);
  });

  test("parseWallpaperUrl accepts safe http(s) and base64 image data URLs and rejects unsafe strings", () => {
    expect(parseWallpaperUrl("  https://example.com/bg.png  ")).toBe("https://example.com/bg.png");
    expect(parseWallpaperUrl("http://localhost:8080/img.webp?w=1920")).toBe(
      "http://localhost:8080/img.webp?w=1920",
    );
    expect(parseWallpaperUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );

    expect(parseWallpaperUrl("")).toBeNull();
    expect(parseWallpaperUrl("javascript:alert(1)")).toBeNull();
    expect(parseWallpaperUrl("file:///etc/passwd")).toBeNull();
    expect(parseWallpaperUrl('https://example.com/a"b.png')).toBeNull();
    expect(parseWallpaperUrl("https://example.com/a(b).png")).toBeNull();
    expect(parseWallpaperUrl("https://example.com/a\\b.png")).toBeNull();
    expect(parseWallpaperUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  test("parseWallpaperConfig validates sources and clamps dim/blur values", () => {
    expect(parseWallpaperConfig(null)).toEqual(DEFAULT_WALLPAPER_CONFIG);
    expect(parseWallpaperConfig("{bad json")).toEqual(DEFAULT_WALLPAPER_CONFIG);

    const parsedPreset = parseWallpaperConfig(
      JSON.stringify({
        source: { kind: "preset", presetId: "alpine-peaks" },
        fit: "contain",
        dim: 2.5,
        blur: 99,
      }),
    );
    expect(parsedPreset).toEqual({
      source: { kind: "preset", presetId: "alpine-peaks" },
      fit: "contain",
      dim: 0.75,
      blur: 24,
    });

    const parsedCustom = parseWallpaperConfig(
      JSON.stringify({
        source: { kind: "custom", name: "  mountain.jpg  " },
        fit: "tile",
        dim: -1,
        blur: -5,
      }),
    );
    expect(parsedCustom).toEqual({
      source: { kind: "custom", name: "mountain.jpg" },
      fit: "tile",
      dim: 0,
      blur: 0,
    });

    const invalidUrl = parseWallpaperConfig(
      JSON.stringify({
        source: { kind: "url", url: "javascript:alert(1)" },
        fit: "cover",
        dim: 0.2,
        blur: 4,
      }),
    );
    expect(invalidUrl).toEqual({
      source: DEFAULT_WALLPAPER_CONFIG.source,
      fit: "cover",
      dim: 0.2,
      blur: 4,
    });

    const roundTrip = serializeWallpaperConfig(parsedPreset);
    expect(parseWallpaperConfig(roundTrip)).toEqual(parsedPreset);
  });

  test("getNextWallpaperPresetId cycles through presets and recovers from custom/url", () => {
    const first = getNextWallpaperPresetId(DEFAULT_WALLPAPER_CONFIG);
    expect(first).toBe(WALLPAPER_PRESETS[1]!.id);

    const lastId = WALLPAPER_PRESETS[WALLPAPER_PRESETS.length - 1]!.id;
    expect(
      getNextWallpaperPresetId({
        source: { kind: "preset", presetId: lastId },
        fit: "cover",
        dim: 0,
        blur: 0,
      }),
    ).toBe(WALLPAPER_PRESETS[0]!.id);

    expect(
      getNextWallpaperPresetId({
        source: { kind: "custom", name: "photo.png" },
        fit: "cover",
        dim: 0.2,
        blur: 0,
      }),
    ).toBe(WALLPAPER_PRESETS[0]!.id);
  });

  test("validateWallpaperFile checks size and image format", () => {
    expect(validateWallpaperFile({ name: "bg.png", type: "image/png", size: 1024 })).toEqual({ ok: true });
    expect(validateWallpaperFile({ name: "bg.webp", type: "", size: 2048 })).toEqual({ ok: true });
    expect(validateWallpaperFile({ name: "empty.png", type: "image/png", size: 0 }).ok).toBe(false);
    expect(
      validateWallpaperFile({ name: "huge.png", type: "image/png", size: MAX_WALLPAPER_FILE_BYTES + 1 }).ok,
    ).toBe(false);
    expect(validateWallpaperFile({ name: "doc.pdf", type: "application/pdf", size: 512 }).ok).toBe(false);
    expect(validateWallpaperFile({ name: "readme.txt", type: "", size: 512 }).ok).toBe(false);
  });

  test("resolveWallpaperStyles maps presets, custom object URLs, external URLs, and fit modes", () => {
    const presetStyles = resolveWallpaperStyles(DEFAULT_WALLPAPER_CONFIG, null);
    expect(presetStyles.usesImage).toBe(false);
    expect(presetStyles.backgroundColor).toBe(WALLPAPER_PRESETS[0]!.backgroundColor);

    const missingCustom = resolveWallpaperStyles(
      { source: { kind: "custom", name: "a.png" }, fit: "cover", dim: 0.25, blur: 6 },
      null,
    );
    expect(missingCustom.usesImage).toBe(false);
    expect(missingCustom.dimOpacity).toBe(0.25);
    expect(missingCustom.blurPx).toBe(6);

    const customCover = resolveWallpaperStyles(
      { source: { kind: "custom", name: "a.png" }, fit: "cover", dim: 0.2, blur: 4 },
      "blob:http://localhost/123",
    );
    expect(customCover).toEqual({
      backgroundColor: "#101010",
      backgroundImage: 'url("blob:http://localhost/123")',
      backgroundSize: "cover",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "center",
      blurPx: 4,
      dimOpacity: 0.2,
      usesImage: true,
    });

    const urlTile = resolveWallpaperStyles(
      { source: { kind: "url", url: "https://example.com/tile.png" }, fit: "tile", dim: 0, blur: 0 },
      null,
    );
    expect(urlTile.backgroundSize).toBe("auto");
    expect(urlTile.backgroundRepeat).toBe("repeat");
    expect(urlTile.backgroundPosition).toBe("top left");
  });

  test("formatWallpaperSummary describes preset, custom, and url wallpapers", () => {
    expect(formatWallpaperSummary(DEFAULT_WALLPAPER_CONFIG)).toBe("赤陶余烬");
    expect(
      formatWallpaperSummary({
        source: { kind: "custom", name: "desk.jpg" },
        fit: "cover",
        dim: 0,
        blur: 0,
      }),
    ).toBe("本地图片 · desk.jpg");
    expect(
      formatWallpaperSummary({
        source: { kind: "custom" },
        fit: "cover",
        dim: 0,
        blur: 0,
      }),
    ).toBe("本地图片");
    expect(
      formatWallpaperSummary({
        source: { kind: "url", url: "https://example.com/a.jpg" },
        fit: "cover",
        dim: 0,
        blur: 0,
      }),
    ).toBe("网络图片");
  });
});
