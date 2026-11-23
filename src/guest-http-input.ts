// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Buffered handshake reader from pithings/unkernel js/core/http.ts at 4e58555.

import { HTTP_MAX_HEADER_BYTES } from "unkernel";
export type { GuestConnect } from "unkernel";

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REASON = /^[\t\x20-\x7e\x80-\xff]*$/;
const EMPTY = new Uint8Array(0);

const malformed = (what: string) => new TypeError(`fetchOver: malformed response: ${what}`);

/** Bytes to a string, one char per byte (headers are byte strings). */
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

/** A string of byte chars to bytes. */
export function latin1Bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** A buffered reader over a connection (ws.ts reads frames through it after the head). */
export class Input {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array = EMPTY;
  eof = false;
  /** Bytes consumed by readLine(). */
  lineBytes = 0;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  get buffered(): number {
    return this.#buf.length;
  }

  /** Read one more chunk from the connection; false at EOF. */
  async more(): Promise<boolean> {
    while (!this.eof) {
      const { done, value } = await this.#reader.read();
      if (done) {
        this.eof = true;
        break;
      }
      if (!value.length) continue;
      this.#buf = this.#buf.length ? concat(this.#buf, value) : value;
      return true;
    }
    return false;
  }

  /** Up to n buffered bytes. */
  take(n: number): Uint8Array {
    const b = this.#buf;
    if (n >= b.length) {
      this.#buf = EMPTY;
      return b;
    }
    this.#buf = b.subarray(n);
    return b.subarray(0, n);
  }

  /** The next line without its LF or CRLF, or null at EOF; throws past `max` bytes. */
  async readLine(max: number): Promise<string | null> {
    let from = 0;
    for (;;) {
      const i = this.#buf.indexOf(10, from);
      if (i > max || (i < 0 && this.#buf.length > max)) throw new TypeError(`fetchOver: response header block over ${HTTP_MAX_HEADER_BYTES} bytes, or a line too long`);
      if (i >= 0) {
        const line = this.take(i + 1);
        this.lineBytes += line.length;
        const end = line.length >= 2 && line[line.length - 2] === 13 ? line.length - 2 : line.length - 1;
        return latin1(line.subarray(0, end));
      }
      from = this.#buf.length;
      if (!(await this.more())) return null;
    }
  }
}

export interface Head {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

/** A status line and header block (names lowercased); throws on a malformed or oversized one. */
export async function readHead(input: Input): Promise<Head> {
  const left = () => HTTP_MAX_HEADER_BYTES - input.lineBytes;
  let line = await input.readLine(left());
  while (line === "") line = await input.readLine(left()); // stray CRLFs before a status line
  if (line === null) throw new TypeError("fetchOver: the connection closed before a response");
  const m = /^HTTP\/1\.[01] ([1-9]\d\d)(?: (.*))?$/.exec(line);
  if (!m) throw malformed(`status line ${JSON.stringify(line.slice(0, 80))}`);
  const status = Number(m[1]);
  const reason = m[2] ?? "";
  const head: Head = { status, statusText: REASON.test(reason) ? reason : "", headers: [] };
  for (;;) {
    line = await input.readLine(left());
    if (line === null) throw new TypeError("fetchOver: the connection closed inside the response headers");
    if (line === "") return head;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon) : "";
    if (!TOKEN.test(name)) throw malformed(`header line ${JSON.stringify(line.slice(0, 80))}`);
    head.headers.push([name.toLowerCase(), line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "")]);
  }
}
