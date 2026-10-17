/**
 * fetch-shim.mjs — iOS runtime shim for dsh, loaded as an ESM preload:
 *
 *     node --import /usr/local/lib/fetch-shim.mjs ...
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On this device JIT is unusable (SIGBUS), so we must run --jitless. But
 * --jitless also disables WebAssembly, and Node's built-in fetch (undici)
 * compiles its HTTP parser (llhttp) from WebAssembly. Under --jitless:
 *
 *   - globalThis.WebAssembly does not exist;
 *   - undici references `WebAssembly` as a bare identifier in its own bundled
 *     module scope, which does NOT consult globalThis, so patching
 *     globalThis.WebAssembly from outside has no effect;
 *   - the moment anything touches fetch / Request / Response / Headers, Node's
 *     lazy getter loads undici, which dies in lazyllhttp with
 *     "ReferenceError: WebAssembly is not defined".
 *
 * Conclusion: undici must never be loaded. That means we cannot keep the native
 * Request/Response/Headers classes (they are undici's; merely reading them
 * triggers the load). This module defines ALL FOUR globals itself, in an ESM
 * preload (--import runs before Node's internal modules are reachable), so the
 * lazy getters never fire.
 *
 * Bodies are streamed, not buffered: dsh consumes the DeepSeek chat API as
 * Server-Sent Events, which never end. Buffering the whole response before
 * returning would hang forever.
 */

import http from "node:http";
import https from "node:https";

const FETCH_BASE = process.env.DSH_IOS_FETCH_BASE || "http://127.0.0.1:3080";
const DEFAULT_UA = process.env.DSH_IOS_FETCH_UA || "node";
const MAX_REDIRECTS = 20;

// ---------------------------------------------------------------------------
// WebAssembly stub (installed unconditionally; under --jitless none exists)
// ---------------------------------------------------------------------------
function neverSettles() {
  return new Promise(() => {});
}
if (process.env.DSH_IOS_KEEP_WASM !== "1") {
  const stub = {
    compile: neverSettles,
    compileStreaming: neverSettles,
    instantiate: neverSettles,
    instantiateStreaming: neverSettles,
    validate: () => false,
    Module: () => { throw new Error("WebAssembly unavailable"); },
    Instance: () => { throw new Error("WebAssembly unavailable"); },
    Memory: () => { throw new Error("WebAssembly unavailable"); },
    Table: () => { throw new Error("WebAssembly unavailable"); },
    Global: () => { throw new Error("WebAssembly unavailable"); },
    CompileError: Error,
    LinkError: Error,
    RuntimeError: Error,
  };
  try {
    Object.defineProperty(globalThis, "WebAssembly", {
      value: stub, writable: true, configurable: true, enumerable: false,
    });
  } catch {
    globalThis.WebAssembly = stub;
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------
class Headers {
  #map = new Map();
  constructor(init) {
    if (!init) return;
    if (init instanceof Headers) {
      for (const [k, v] of init.entries()) this.append(k, v);
      return;
    }
    if (Array.isArray(init)) {
      for (const pair of init) this.append(pair[0], pair[1]);
      return;
    }
    if (typeof init === "object") {
      for (const k of Object.keys(init)) this.append(k, init[k]);
    }
  }
  append(name, value) {
    const key = String(name).toLowerCase();
    const cur = this.#map.get(key);
    this.#map.set(key, cur === undefined ? String(value) : cur + ", " + String(value));
  }
  set(name, value) { this.#map.set(String(name).toLowerCase(), String(value)); }
  get(name) {
    const v = this.#map.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }
  has(name) { return this.#map.has(String(name).toLowerCase()); }
  delete(name) { this.#map.delete(String(name).toLowerCase()); }
  *entries() { for (const pair of this.#map) yield pair; }
  *keys() { yield* this.#map.keys(); }
  *values() { yield* this.#map.values(); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(cb, thisArg) {
    for (const [k, v] of this.#map) cb.call(thisArg, v, k, this);
  }
  raw() {
    const out = {};
    for (const [k, v] of this.#map) out[k] = v;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
class Request {
  constructor(input, init = {}) {
    const raw = String(input instanceof Request ? input.url : input);
    try {
      this.url = new URL(raw).href;
    } catch {
      this.url = new URL(raw, FETCH_BASE).href;
    }
    this.method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    this.headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    this.signal = init.signal || (input instanceof Request ? input.signal : undefined) || null;
    this.body = init.body !== undefined ? init.body : input instanceof Request ? input.body : null;
  }
}

// ---------------------------------------------------------------------------
// Response — body is a real ReadableStream (SSE-safe), never pre-buffered
// ---------------------------------------------------------------------------
function streamFromNode(res) {
  let onData;
  let onEnd;
  let onError;
  return new ReadableStream({
    start(controller) {
      onData = (chunk) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          res.destroy();
        }
      };
      onEnd = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      onError = (err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      };
      res.on("data", onData);
      res.on("end", onEnd);
      res.on("error", onError);
      res.on("aborted", () => onError(new Error("response aborted")));
    },
    cancel() {
      res.destroy();
    },
  });
}

function bytesToStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes && bytes.length) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

class Response {
  constructor(body, init = {}) {
    this.status = init.status === undefined ? 200 : Number(init.status);
    this.statusText = init.statusText || "";
    this.headers = new Headers(init.headers);
    this.url = init.url || "";
    this.redirected = Boolean(init.redirected);
    this.ok = this.status >= 200 && this.status < 300;
    this.bodyUsed = false;
    this.type = "default";

    if (body === null || body === undefined) {
      this.#source = { kind: "bytes", bytes: Buffer.alloc(0) };
    } else if (typeof body.getReader === "function") {
      this.#source = { kind: "stream", stream: body };
    } else if (typeof body === "string") {
      this.#source = { kind: "bytes", bytes: Buffer.from(body) };
    } else if (Buffer.isBuffer(body)) {
      this.#source = { kind: "bytes", bytes: body };
    } else if (typeof body.arrayBuffer === "function") {
      this.#source = { kind: "bytes", bytes: Buffer.from(body) };
    } else {
      this.#source = { kind: "bytes", bytes: Buffer.from(String(body)) };
    }
  }

  #source;

  get body() {
    if (this.bodyUsed) return null;
    this.bodyUsed = true;
    if (this.#source.kind === "stream") return this.#source.stream;
    return bytesToStream(this.#source.bytes);
  }

  async #collect() {
    if (this.#source.kind === "bytes") return this.#source.bytes;
    const reader = this.#source.stream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async arrayBuffer() {
    const bytes = await this.#collect();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  async text() {
    return (await this.#collect()).toString("utf8");
  }
  async json() {
    return JSON.parse(await this.text());
  }
  clone() {
    if (this.#source.kind !== "bytes") {
      throw new Error("Response.clone() is not supported for streamed bodies");
    }
    return new Response(Buffer.from(this.#source.bytes), {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      url: this.url,
      redirected: this.redirected,
    });
  }
  static error() {
    return new Response(null, { status: 0, statusText: "" });
  }
  static json(data, init = {}) {
    const res = new Response(JSON.stringify(data), init);
    if (!res.headers.has("content-type")) {
      res.headers.set("content-type", "application/json");
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------
async function toBuffer(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body));
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  if (reason !== undefined) err.cause = reason;
  return err;
}

// Resolves as soon as response headers arrive; the body stays readable as a
// stream (required for SSE, which never ends).
function requestOnce(url, method, headers, bodyBuffer, signal) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const options = { method, headers };
    if (bodyBuffer) options.headers["content-length"] = String(bodyBuffer.length);
    if (signal) options.signal = signal;

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(signal && signal.aborted ? abortError(signal.reason) : err);
    };

    const req = mod.request(url, options, (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      if (signal && signal.aborted) {
        res.destroy();
        reject(abortError(signal.reason));
        return;
      }
      resolve(res);
    });

    req.on("error", fail);
    if (bodyBuffer) req.end(bodyBuffer);
    else req.end();
  });
}

function headersFromNode(res) {
  const out = new Headers();
  for (const name of Object.keys(res.headers || {})) {
    const value = res.headers[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else {
      out.append(name, value);
    }
  }
  return out;
}

async function iosFetch(input, init) {
  const options = init || {};
  const request = input instanceof Request ? input : new Request(input, options);

  if (!request.headers.has("user-agent")) request.headers.set("user-agent", DEFAULT_UA);
  if (!request.headers.has("accept")) request.headers.set("accept", "*/*");

  let bodyBuffer = await toBuffer(request.body);
  if (bodyBuffer && !request.headers.has("content-type")) {
    request.headers.set("content-type", "text/plain;charset=UTF-8");
  }

  if (request.signal && request.signal.aborted) {
    throw abortError(request.signal.reason);
  }

  let currentURL = new URL(request.url);
  let method = request.method;
  let redirects = 0;
  const headers = request.headers;

  for (;;) {
    const res = await requestOnce(currentURL, method, headers.raw(), bodyBuffer, request.signal);
    const status = res.statusCode || 0;

    if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
      redirects += 1;
      res.resume(); // drain the redirect body
      currentURL = new URL(res.headers.location, currentURL);
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        bodyBuffer = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      continue;
    }

    return new Response(streamFromNode(res), {
      status,
      statusText: res.statusMessage || "",
      headers: headersFromNode(res),
      url: currentURL.href,
      redirected: redirects > 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Blob / File / FormData and the event classes are ALSO undici-backed globals in
// Node 22. Touching any of them (attachment upload, multipart body) loads undici
// just like touching fetch does, so they have to be taken over as well.
// ---------------------------------------------------------------------------
class Blob {
  #parts;
  constructor(parts = [], options = {}) {
    this.#parts = Array.isArray(parts) ? parts : [parts];
    this.type = String(options.type || "");
  }
  get size() {
    let n = 0;
    for (const part of this.#parts) {
      if (typeof part === "string") n += Buffer.byteLength(part);
      else if (part instanceof ArrayBuffer) n += part.byteLength;
      else if (ArrayBuffer.isView(part)) n += part.byteLength;
      else if (part instanceof Blob) n += part.size;
      else n += Buffer.byteLength(String(part));
    }
    return n;
  }
  #bytes() {
    const chunks = [];
    for (const part of this.#parts) {
      if (typeof part === "string") chunks.push(Buffer.from(part));
      else if (part instanceof ArrayBuffer) chunks.push(Buffer.from(part));
      else if (ArrayBuffer.isView(part)) chunks.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      else if (part instanceof Blob) chunks.push(part.#bytes());
      else chunks.push(Buffer.from(String(part)));
    }
    return Buffer.concat(chunks);
  }
  async arrayBuffer() {
    const bytes = this.#bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  async text() { return this.#bytes().toString("utf8"); }
  async bytes_() { return new Uint8Array(this.#bytes()); }
  stream() {
    const bytes = this.#bytes();
    return new ReadableStream({
      start(controller) {
        if (bytes.length) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  }
  slice(start, end, type) {
    const bytes = this.#bytes().subarray(start, end);
    return new Blob([bytes], { type: type || this.type });
  }
}

class File extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = String(name);
    this.lastModified = options.lastModified === undefined ? Date.now() : Number(options.lastModified);
  }
}

class FormData {
  #entries = [];
  append(name, value, filename) {
    this.#entries.push([String(name), value, filename]);
  }
  set(name, value, filename) {
    this.delete(name);
    this.append(name, value, filename);
  }
  get(name) {
    const hit = this.#entries.find((e) => e[0] === String(name));
    return hit ? hit[1] : null;
  }
  getAll(name) {
    return this.#entries.filter((e) => e[0] === String(name)).map((e) => e[1]);
  }
  has(name) { return this.#entries.some((e) => e[0] === String(name)); }
  delete(name) { this.#entries = this.#entries.filter((e) => e[0] !== String(name)); }
  *entries() { for (const [k, v] of this.#entries) yield [k, v]; }
  *keys() { for (const [k] of this.#entries) yield k; }
  *values() { for (const [, v] of this.#entries) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(cb, thisArg) { for (const [k, v] of this.#entries) cb.call(thisArg, v, k, this); }
}

class MessageEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.data = init.data === undefined ? null : init.data;
    this.origin = init.origin || "";
  }
}
class CloseEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.code = init.code === undefined ? 0 : Number(init.code);
    this.reason = init.reason || "";
    this.wasClean = Boolean(init.wasClean);
  }
}

// No WebSocket implementation on this build; fail loudly instead of silently
// loading undici's.
class WebSocket {
  constructor() {
    throw new Error("WebSocket is not available on this iOS build (undici-free shim)");
  }
}
// ---------------------------------------------------------------------------
// Take over the globals BEFORE Node's lazy undici getters can fire.
// ---------------------------------------------------------------------------
const installed = [];
const failed = [];
function define(name, value) {
  try {
    Object.defineProperty(globalThis, name, {
      value, writable: true, configurable: true, enumerable: false,
    });
    const after = Object.getOwnPropertyDescriptor(globalThis, name);
    if (after && after.value === value) installed.push(name);
    else failed.push(name + " (descriptor mismatch)");
  } catch (err) {
    // Do NOT fall back to assignment: on an accessor-only global that would
    // invoke the very undici getter we are trying to avoid.
    failed.push(name + " (" + err.message + ")");
  }
}

define("Headers", Headers);
define("Request", Request);
define("Response", Response);
define("fetch", iosFetch);
define("Blob", Blob);
define("File", File);
define("FormData", FormData);
define("MessageEvent", MessageEvent);
define("CloseEvent", CloseEvent);
define("WebSocket", WebSocket);

// Always expose the install result so a device-side smoke test can assert it:
//     node --jitless --import <shim> -e "console.log(globalThis.__dshShim)"
Object.defineProperty(globalThis, "__dshShim", {
  value: { installed: installed.slice(), failed: failed.slice() },
  writable: false, configurable: true, enumerable: false,
});

if (process.env.DSH_IOS_SHIM_VERBOSE === "1") {
  console.error("[fetch-shim] installed:", installed.join(", "));
  if (failed.length) console.error("[fetch-shim] FAILED:", failed.join(", "));
}