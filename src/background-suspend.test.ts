// SPDX-License-Identifier: MIT

import { describe, expect, mock, test } from "bun:test";
import { BackgroundSuspend, backgroundSuspendEnabled, holdUntilShown } from "./background-suspend.ts";

function setup(suspend: (shown: AbortSignal) => Promise<"continued" | "stopped">, canSuspend = true) {
  const actions = {
    canSuspend: () => canSuspend,
    suspend: mock(suspend),
    syncDisk: mock(async () => true),
    restore: mock(() => {}),
    onError: mock((_error: unknown) => {}),
  };
  return { background: new BackgroundSuspend(actions), actions };
}

describe("background suspend", () => {
  test("defaults to phones and tablets and respects the stored switch on every device", () => {
    const desktop = { userAgent: "Windows NT", platform: "Win32", maxTouchPoints: 10 };
    const ipad = { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 };
    const iphone = { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 };
    const android = { userAgent: "Android", platform: "Linux", maxTouchPoints: 5 };
    for (const device of [ipad, iphone, android]) {
      expect(backgroundSuspendEnabled(null, device)).toBe(true);
      expect(backgroundSuspendEnabled("0", device)).toBe(false);
    }
    expect(backgroundSuspendEnabled(null, desktop)).toBe(false);
    expect(backgroundSuspendEnabled(null, { ...ipad, maxTouchPoints: 0 })).toBe(false);
    expect(backgroundSuspendEnabled("1", desktop)).toBe(true);
  });

  test("flushes on hide and again on a later pagehide when disabled or blocked", async () => {
    for (const [enabled, allowed] of [[false, true], [true, false]] as const) {
      const { actions, background } = setup(async () => "continued", allowed);
      await background.update(true, enabled);
      await background.update(true, enabled);
      expect(actions.syncDisk).toHaveBeenCalledTimes(2);
      expect(actions.suspend).not.toHaveBeenCalled();
    }
  });

  test("showing the page during a save releases the hold as soon as the commit finishes", async () => {
    const commit = Promise.withResolvers<void>();
    const { actions, background } = setup(async (shown) => {
      await commit.promise;
      expect(await holdUntilShown(shown, new AbortController().signal)).toBe("continue");
      return "continued";
    });
    const saving = background.update(true, true);
    await background.update(true, true);
    await background.update(false, true);
    commit.resolve();
    await saving;
    expect(actions.suspend).toHaveBeenCalledTimes(1);
    expect(actions.syncDisk).not.toHaveBeenCalled();
    expect(actions.restore).not.toHaveBeenCalled();
  });

  test("serializes a second hide behind the previous release and cleanup", async () => {
    const cleanup = Promise.withResolvers<void>();
    const secondHold = Promise.withResolvers<void>();
    let attempts = 0;
    const { actions, background } = setup(async (shown) => {
      if (++attempts === 2) secondHold.resolve();
      expect(await holdUntilShown(shown, new AbortController().signal)).toBe("continue");
      await cleanup.promise;
      return "continued";
    });
    const first = background.update(true, true);
    await background.update(false, true);
    await background.update(true, true);
    expect(attempts).toBe(1);
    cleanup.resolve();
    await secondHold.promise;
    await background.update(false, true);
    await first;
    expect(actions.suspend).toHaveBeenCalledTimes(2);
    expect(actions.restore).not.toHaveBeenCalled();
  });

  test("restores the committed session on show if the held Worker dies", async () => {
    const ended = new AbortController();
    const { actions, background } = setup(async (shown) => {
      expect(await holdUntilShown(shown, ended.signal)).toBe("stop");
      return "stopped";
    });
    const held = background.update(true, true);
    ended.abort();
    await held;
    expect(actions.restore).not.toHaveBeenCalled();
    await background.update(false, true);
    expect(actions.restore).toHaveBeenCalledTimes(1);
  });

  test("falls back to disk sync after a failed save and tries again on the next hide", async () => {
    const error = new Error("quota exceeded");
    const { actions, background } = setup(async () => { throw error; });
    await background.update(true, true);
    expect(actions.onError).not.toHaveBeenCalled();
    expect(actions.syncDisk).toHaveBeenCalledTimes(1);
    await background.update(false, true);
    expect(actions.onError).toHaveBeenCalledWith(error);
    await background.update(true, true);
    expect(actions.suspend).toHaveBeenCalledTimes(2);
    expect(actions.restore).not.toHaveBeenCalled();
  });
});
