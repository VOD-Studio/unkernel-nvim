// SPDX-License-Identifier: MIT

import { encodeSnapshot, type KernelSnapshot } from "unkernel";
import type { Distro } from "./distro.ts";
import type { FetchRouteMap } from "./net-routes.ts";
import type { SuspendedTerminalEntry } from "./terminal-sessions.ts";
import type { NetMode } from "./vm-manager.ts";

const DB_NAME = "unkernel-nvim-snapshots";
const STORE_NAME = "snapshots";

export interface SessionMetadata {
  id: string;
  mode: "nvim" | "shell";
  cwd: string;
  shell: string;
  terminalId?: string;
  activeSessionId?: string;
  sessions?: SuspendedTerminalEntry[];
  network: { mode: NetMode; servers: string[]; routes?: FetchRouteMap };
}

export interface SuspendedSession extends SessionMetadata {
  snapshot: Blob;
}

export class ResumeSessionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function sessionKey(distro: Distro): string {
  return `suspended:${distro}`;
}

export async function readSuspendedSession(distro: Distro): Promise<SuspendedSession | undefined> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(sessionKey(distro));
      request.onsuccess = () => resolve(request.result as SuspendedSession | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function updateStore(action: (store: IDBObjectStore) => void, signal?: AbortSignal): Promise<void> {
  const db = await openDb();
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
      const abort = () => {
        try { transaction.abort(); } catch { /* already committed */ }
      };
      transaction.oncomplete = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      transaction.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? transaction.error ?? new Error("保存挂起会话失败"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        action(transaction.objectStore(STORE_NAME));
      } catch (err) {
        abort();
        reject(err);
      }
    });
  } finally {
    db.close();
  }
}

export async function writeSuspendedSession(
  distro: Distro,
  metadata: SessionMetadata,
  snapshot: KernelSnapshot,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const blob = new Blob([encodeSnapshot(snapshot) as Uint8Array<ArrayBuffer>]);
  await updateStore((store) => store.put({ ...metadata, snapshot: blob }, sessionKey(distro)), signal);
  return blob.size;
}

export async function deleteSuspendedSession(distro: Distro, id?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const key = sessionKey(distro);
  await updateStore((store) => {
    if (id === undefined) {
      store.delete(key);
      store.delete(distro === "alpine" ? "latest" : distro);
      return;
    }
    const request = store.get(key);
    request.onsuccess = () => {
      if ((request.result as SuspendedSession | undefined)?.id === id) store.delete(key);
    };
  });
}
