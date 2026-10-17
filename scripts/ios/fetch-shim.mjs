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
 * Request/Response/Headers classes (they are undici's, and merely reading them
 * triggers the load). This module therefore defines ALL FOUR globals itself,
 * before Node's lazy getters can fire, using a pure node:http implementation.
 *
 * Loaded with --import (not --require): an ESM preload runs before Node's
 * internal modules are reachable. --require is too late and too weak here.
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
// Minimal Headers / Request / Response, implemented without undici
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
      for (const [k, v] of init) this.append(k, v);
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
  *entries() { for (const [k, v] of this.#map) yield [k, v]; }
  *keys() { for (const k of this.#map.keys()) yield k; }
  *values() { for (const v of this.#map.values()) yield v; }
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

class Request {
  constructor(input, init = {}) {
    const url = String(input instanceof Request ? input.url : input);
    try {
      this.url = new URL(url).href;
    } catch {
      this.url = new URL(url, FETCH_BASE).href;
    }
    this.method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    this.headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    this.signal = init.signal || (input instanceof Request ? input.signal : undefined) || null;
    this.body = init.body !== undefined ? init.body : input instanceof Request ? input.body : null;
  }
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

    if (body === null || body === undefined) {
      this.#bytes = Buffer.alloc(0);
    } else if (typeof body === "string") {
      this.#bytes = Buffer.from(body);
    } else if (Buffer.isBuffer(body)) {
      this.#bytes = body;
    } else if (typeof body.arrayBuffer === "function") {
      this.#bytes = Buffer.from(body);
    } else {
      this.#bytes = Buffer.from(String(body));
    }
    this.body = null;
  }

  #bytes = Buffer.alloc(0);

  _stream() {
    const bytes = this.#bytes;
    let done = false;
    return new ReadableStream({
      start(controller) {
        if (bytes.length) controller.enqueue(new Uint8Array(bytes));
        controller.close();
        done = true;
      },
      cancel() { done = true; },
    });
  }

  async arrayBuffer() {
    this.bodyUsed = true;
    return this.#bytes.buffer.slice(
      this.#bytes.byteOffset,
      this.#bytes.byteOffset + this.#bytes.byteLength
    );
  }
  async text() { this.bodyUsed = true; return this.#bytes.toString("utf8"); }
  async json() { this.bodyUsed = true; return JSON.parse(this.#bytes.toString("utf8")); }
  clone() {
    return new Response(Buffer.from(this.#bytes), {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      url: this.url,
      redirected: this.redirected,
    });
  }
  static error() { return new Response(null, { status: 0, statusText: "" }); }
  static json(data, init = {}) {
    const r = new Response(JSON.stringify(data), init);
    if (!r.headers.has("content-type")) r.headers.set("content-type", "application/json");
    return r;
  }
}

function bodyToBuffer(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body.arrayBuffer === "function") return Buffer.from(body);
  return Buffer.from(String(body));
}

async function toBuffer(body) {
  const direct = bodyToBuffer(body);
  if (direct) return direct;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return null;
}

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
      reject(signal && signal.aborted
        ? Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
        : err);
    };

    const req = mod.request(url, options, (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ res, bytes: Buffer.concat(chunks) }));
      res.on("error", fail);
      res.on("aborted", () => fail(new Error("response aborted")));
    });

    req.on("error", fail);
    if (bodyBuffer) req.end(bodyBuffer);
    else req.end();
  });
}

async function iosFetch(input, init) {
  const options = init || {};
  const req = input instanceof Request ? input : new Request(input, options);

  if (!req.headers.has("user-agent")) req.headers.set("user-agent", DEFAULT_UA);
  if (!req.headers.has("accept")) req.headers.set("accept", "*/*");

  let bodyBuffer = await toBuffer(req.body);
  if (bodyBuffer && !req.headers.has("content-type")) {
    req.headers.set("content-type", "text/plain;charset=UTF-8");
  }

  if (req.signal && req.signal.aborted) {
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  }

  let currentURL = new URL(req.url);
  let method = req.method;
  let redirects = 0;
  const headers = req.headers;

  for (;;) {
    const { res, bytes } = await requestOnce(currentURL, method, headers.raw(), bodyBuffer, req.signal);
    const status = res.statusCode || 0;

    if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
      redirects += 1;
      currentURL = new URL(res.headers.location, currentURL);
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        bodyBuffer = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      continue;
    }

    const responseHeaders = new Headers();
    for (const name of Object.keys(res.headers || {})) {
      const value = res.headers[name];
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
      else responseHeaders.append(name, value);
    }

    return new Response(bytes, {
      status,
      statusText: res.statusMessage || "",
      headers: responseHeaders,
      url: currentURL.href,
      redirected: redirects > 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Take over the globals BEFORE Node's lazy undici getters can fire.
// defineProperty bypasses the getter (plain assignment would invoke it).
// ---------------------------------------------------------------------------
const define = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, {
      value, writable: true, configurable: true, enumerable: false,
    });
  } catch {
    globalThis[name] = value;
  }
};

define("Headers", Headers);
define("Request", Request);
define("Response", Response);
define("fetch", iosFetch);

if (process.env.DSH_IOS_SHIM_VERBOSE === "1") {
  console.error("[fetch-shim] undici-free globals installed (--jitless safe)");
}