"use strict";
/**
 * fetch-shim.cjs -- iOS (arm64, A14) runtime shim for dsh.
 *
 * Loaded with `node --require /usr/local/lib/fetch-shim.cjs ...`.
 *
 * Why this exists (measured on iPhone 12 Pro Max / A14 / iOS 16.7):
 *   1. Node's built-in fetch is undici, whose HTTP parser (llhttp) is compiled
 *      to WebAssembly. On A14 both wasm paths are fatal: instantiation dies in
 *      WasmMemoryObject::UseInInstance, and the code GC dies in
 *      WasmCodeAllocator::FreeCode (decommit OOM). So undici cannot be used.
 *   2. Therefore: stub WebAssembly so undici's lazy llhttp init never settles
 *      (it hangs instead of crashing), and re-implement `fetch` on top of
 *      node:http, which uses the native parser and needs no wasm.
 *
 * Deliberately NOT done here:
 *   - We do not pass --no-experimental-fetch / --no-experimental-websocket.
 *     Those disable undici's Request/Response/Headers *globals* too, and the
 *     dsh plugin tree (webRuntime -> connection -> apiProxy) needs those
 *     classes at boot; without them apiProxy silently fails to activate and
 *     every /api/* returns 404.
 *
 * Env knobs:
 *   DSH_IOS_KEEP_WASM=1     leave the real WebAssembly in place (debug only)
 *   DSH_IOS_FETCH_BASE=URL  base used to resolve relative request URLs
 *                           (default http://127.0.0.1:3080)
 */

const http = require("node:http");
const https = require("node:https");

const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeHeaders = globalThis.Headers;

// undici's globals must stay available: the dsh plugin tree (webRuntime ->
// connection -> apiProxy) instantiates Request/Response/Headers at boot.
if (!NativeRequest || !NativeResponse || !NativeHeaders) {
  throw new Error(
    "fetch-shim: global Request/Response/Headers are missing. " +
      "Do not launch node with --no-experimental-fetch / --no-experimental-websocket."
  );
}

const FETCH_BASE = process.env.DSH_IOS_FETCH_BASE || "http://127.0.0.1:3080";
const DEFAULT_UA = process.env.DSH_IOS_FETCH_UA || "node";
const MAX_REDIRECTS = 20;

// ---------------------------------------------------------------------------
// 1. WebAssembly stub
// ---------------------------------------------------------------------------

function neverSettles() {
  return new Promise(() => {});
}

function wasmUnavailable() {
  throw new Error("WebAssembly is not available on this iOS build (see fetch-shim.cjs)");
}

// NOTE: the guard MUST NOT be "only stub if WebAssembly already exists".
// Under --jitless (our default launcher flag) Node does not define
// globalThis.WebAssembly at all, so such a guard silently skips the stub and
// undici's llhttp then dies with `ReferenceError: WebAssembly is not defined`
// during module load. Always install the stub unless explicitly opted out.
if (process.env.DSH_IOS_KEEP_WASM !== "1") {
  const stub = {
    compile: neverSettles,
    compileStreaming: neverSettles,
    instantiate: neverSettles,
    instantiateStreaming: neverSettles,
    validate: () => false,
    Module: wasmUnavailable,
    Instance: wasmUnavailable,
    Memory: wasmUnavailable,
    Table: wasmUnavailable,
    Global: wasmUnavailable,
    CompileError: Error,
    LinkError: Error,
    RuntimeError: Error,
  };
  try {
    Object.defineProperty(globalThis, "WebAssembly", {
      value: stub,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    globalThis.WebAssembly = stub;
  }
}

// ---------------------------------------------------------------------------
// 2. fetch on node:http
// ---------------------------------------------------------------------------

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  if (reason !== undefined) err.cause = reason;
  return err;
}

function resolveURL(input) {
  const raw = input instanceof NativeRequest ? input.url : input instanceof URL ? input.href : String(input);
  try {
    return new URL(raw);
  } catch {
    // dsh sometimes hands us server-relative paths such as "/api/session".
    return new URL(raw, FETCH_BASE);
  }
}

async function toBuffer(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "object" && typeof body.getReader === "function") {
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

function collectHeaders(res) {
  const out = new NativeHeaders();
  const raw = res.headers || {};
  for (const name of Object.keys(raw)) {
    const value = raw[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, String(item));
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

function hasBody(method, status) {
  if (method === "HEAD") return false;
  if (status === 204 || status === 205 || status === 304) return false;
  return true;
}

function requestOnce(url, method, headers, bodyBuffer, signal) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const options = { method, headers: Object.fromEntries(headers.entries()) };
    if (bodyBuffer) {
      options.headers["content-length"] = String(bodyBuffer.length);
    }
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
      resolve(res);
    });

    req.on("error", fail);
    if (bodyBuffer) req.end(bodyBuffer);
    else req.end();
  });
}

function toResponseStream(res) {
  return new ReadableStream({
    start(controller) {
      res.on("data", (chunk) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          res.destroy();
        }
      });
      res.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      res.on("error", (err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
      res.on("aborted", () => {
        try {
          controller.error(new Error("response aborted"));
        } catch {
          /* already errored */
        }
      });
    },
    cancel() {
      res.destroy();
    },
  });
}

async function iosFetch(input, init) {
  const options = init || {};
  const isRequest = input instanceof NativeRequest;
  const url = resolveURL(input);
  const method = String(options.method || (isRequest ? input.method : "GET") || "GET").toUpperCase();

  const headers = new NativeHeaders(isRequest ? input.headers : undefined);
  if (options.headers) {
    for (const [name, value] of new NativeHeaders(options.headers).entries()) headers.set(name, value);
  }
  // node:http sends no User-Agent by default. The DeepSeek API gateway rejects
  // UA-less calls with 401 ("governor"), which is the real cause of the old
  // "device 401 / Mac 200" mystery -- it is not a TLS fingerprint issue.
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_UA);
  if (!headers.has("accept")) headers.set("accept", "*/*");

  let bodyBuffer = await toBuffer(options.body);
  if (bodyBuffer === null && isRequest && input.body) {
    bodyBuffer = await toBuffer(input.body);
  }
  if (bodyBuffer !== null && !headers.has("content-type")) {
    headers.set("content-type", "text/plain;charset=UTF-8");
  }

  const signal = options.signal || (isRequest ? input.signal : undefined);
  if (signal && signal.aborted) throw abortError(signal.reason);

  let currentURL = url;
  let currentMethod = method;
  let currentBody = bodyBuffer;
  let redirects = 0;

  for (;;) {
    const res = await requestOnce(currentURL, currentMethod, headers, currentBody, signal);
    const status = res.statusCode || 0;

    if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
      res.resume(); // drain
      redirects += 1;
      currentURL = new URL(res.headers.location, currentURL);
      if (status === 303 || ((status === 301 || status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      continue;
    }

    const responseHeaders = collectHeaders(res);
    const response = new NativeResponse(hasBody(currentMethod, status) ? toResponseStream(res) : null, {
      status,
      statusText: res.statusMessage || "",
      headers: responseHeaders,
    });
    // Response.url / .redirected are read-only on the prototype; shadow them.
    try {
      Object.defineProperty(response, "url", { value: currentURL.href, configurable: true });
      Object.defineProperty(response, "redirected", { value: redirects > 0, configurable: true });
    } catch {
      /* non-fatal */
    }
    return response;
  }
}

// Node installs `fetch` as a LAZY GETTER: a plain assignment
// (`globalThis.fetch = iosFetch`) reads the existing value first, which loads
// undici — the very module whose wasm llhttp dies on this device. The polyfill
// then looks "ignored". defineProperty bypasses the getter entirely.
Object.defineProperty(globalThis, "fetch", {
  value: iosFetch,
  writable: true,
  configurable: true,
  enumerable: false,
});

if (process.env.DSH_IOS_SHIM_VERBOSE === "1") {
  console.error("[fetch-shim] installed (wasm stubbed, fetch -> node:http)");
}