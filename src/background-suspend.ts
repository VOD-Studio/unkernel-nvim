// SPDX-License-Identifier: MIT

import type { SnapshotHoldDecision } from "unkernel";

export function backgroundSuspendEnabled(
  stored: string | null,
  device: { userAgent: string; platform: string; maxTouchPoints: number },
): boolean {
  if (stored === "1" || stored === "0") return stored === "1";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent) ||
    (device.platform === "MacIntel" && device.maxTouchPoints > 1);
}

// The Worker calls hold only after the IndexedDB commit. The page may already
// have returned to the foreground while the Worker was taking the snapshot.
export function holdUntilShown(shown: AbortSignal, workerEnded: AbortSignal): Promise<SnapshotHoldDecision> {
  const wake = AbortSignal.any([shown, workerEnded]);
  return new Promise((resolve) => {
    const decide = () => resolve(workerEnded.aborted ? "stop" : "continue");
    if (wake.aborted) decide();
    else wake.addEventListener("abort", decide, { once: true });
  });
}

interface BackgroundActions {
  canSuspend(): boolean;
  suspend(shown: AbortSignal): Promise<"continued" | "stopped">;
  syncDisk(): Promise<boolean>;
  restore(): void;
  onError(error: unknown): void;
}

export class BackgroundSuspend {
  #actions: BackgroundActions;
  #hidden = false;
  #enabled = false;
  #shown: AbortController | null = null;
  #restoreOnShow = false;
  #failure: { error: unknown } | null = null;

  constructor(actions: BackgroundActions) {
    this.#actions = actions;
  }

  async update(hidden: boolean, enabled: boolean): Promise<void> {
    if (this.#hidden === hidden && this.#enabled === enabled) {
      // pagehide may follow visibilitychange long after a background build wrote to disk.
      if (hidden && !this.#shown && !this.#restoreOnShow) await this.#actions.syncDisk();
      return;
    }
    this.#hidden = hidden;
    this.#enabled = enabled;
    if (!hidden || !enabled) this.#shown?.abort();
    if (!hidden) {
      if (this.#restoreOnShow) this.#actions.restore();
      if (this.#failure) {
        this.#actions.onError(this.#failure.error);
        this.#failure = null;
      }
      return;
    }
    await this.#onHidden();
  }

  async #onHidden(): Promise<void> {
    if (this.#shown || this.#restoreOnShow) return;
    if (!this.#enabled || !this.#actions.canSuspend()) {
      await this.#actions.syncDisk();
      return;
    }
    const shown = new AbortController();
    this.#shown = shown;
    try {
      this.#restoreOnShow = await this.#actions.suspend(shown.signal) === "stopped";
    } catch (error) {
      if (this.#hidden) this.#failure = { error };
      else this.#actions.onError(error);
      await this.#actions.syncDisk();
    } finally {
      this.#shown = null;
    }
    if (this.#restoreOnShow) {
      if (!this.#hidden) this.#actions.restore();
    } else if (shown.signal.aborted && this.#hidden) {
      // Hidden again before the previous release and snapshot cleanup finished.
      await this.#onHidden();
    }
  }
}
