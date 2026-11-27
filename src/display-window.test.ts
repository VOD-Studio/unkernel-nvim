// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
  formatDisplayBadge,
  mapClientPointToDisplay,
  normalizeDisplayResize,
  wheelDeltaToClicks,
} from "./display-window.ts";

describe("display-window helpers", () => {
  test("normalizeDisplayResize clamps bounds and rounds to even dimensions", () => {
    expect(normalizeDisplayResize(100, 100)).toEqual({ width: 320, height: 200 });
    expect(normalizeDisplayResize(1281.9, 721.4)).toEqual({ width: 1280, height: 720 });
    expect(normalizeDisplayResize(3000, 2000)).toEqual({ width: 2560, height: 1600 });
  });

  test("mapClientPointToDisplay handles exact fit, letterbox, pillarbox, and clamping", () => {
    // Exact aspect ratio
    expect(
      mapClientPointToDisplay(500, 250, { left: 100, top: 50, width: 800, height: 400 }, 1280, 640),
    ).toEqual({ nx: 0.5, ny: 0.5, inside: true });

    // Wide box with pillarbox around 4:3 display (fitted area: left=100, width=400, height=300)
    const wide = mapClientPointToDisplay(
      100,
      150,
      { left: 0, top: 0, width: 600, height: 300 },
      800,
      600,
    );
    expect(wide.nx).toBeCloseTo(0, 5);
    expect(wide.ny).toBeCloseTo(0.5, 5);
    expect(wide.inside).toBe(true);

    // Outside left margin clamps to 0 and reports inside=false
    const outsideLeft = mapClientPointToDisplay(
      40,
      150,
      { left: 0, top: 0, width: 600, height: 300 },
      800,
      600,
    );
    expect(outsideLeft.nx).toBe(0);
    expect(outsideLeft.inside).toBe(false);

    // Tall box with letterbox (fitted area: top=100, width=400, height=200)
    const tall = mapClientPointToDisplay(
      200,
      300,
      { left: 0, top: 0, width: 400, height: 400 },
      800,
      400,
    );
    expect(tall.nx).toBeCloseTo(0.5, 5);
    expect(tall.ny).toBeCloseTo(1, 5);
    expect(tall.inside).toBe(true);
  });

  test("wheelDeltaToClicks normalizes scroll direction and caps magnitude", () => {
    expect(wheelDeltaToClicks(0)).toBe(0);
    expect(wheelDeltaToClicks(-120)).toBe(1);
    expect(wheelDeltaToClicks(120)).toBe(-1);
    expect(wheelDeltaToClicks(-1000)).toBe(5);
    expect(wheelDeltaToClicks(1000)).toBe(-5);
  });

  test("formatDisplayBadge reflects resolution, driver, and open input devices", () => {
    expect(
      formatDisplayBadge(
        { width: 1280, height: 720, stride: 5120, format: 0x34325258 },
        false,
        { keyboard: false, mouse: false, tablet: false },
      ),
    ).toBe("1280×720 · fb0");

    expect(
      formatDisplayBadge(
        { width: 1920, height: 1080, stride: 7680, format: 0x34325258 },
        true,
        { keyboard: true, mouse: true, tablet: true },
      ),
    ).toBe("1920×1080 · GPU · kbd+abs");
  });
});
