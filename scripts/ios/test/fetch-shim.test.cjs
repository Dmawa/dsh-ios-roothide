"use strict";
/**
 * Regression tests for scripts/ios/fetch-shim.cjs.
 *
 * Runs on any desktop Node (no iOS needed): it stands up a local HTTP server
 * and drives the shim against it. Run with:
 *
 *   node --test scripts/ios/test/
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const SHIM = path.join(__dirname, "..", "fetch-shim.cjs");
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.DSH_IOS_FETCH_BASE = BASE;
require(SHIM);

let server;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE);

    if (url.pathname === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ua: req.headers["user-agent"] || null }));
      return;
    }
    if (url.pathname === "/echo") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json", "x-custom": "yes" });
        res.end(
          JSON.stringify({
            body: Buffer.concat(chunks).toString(),
            contentType: req.headers["content-type"] || null,
          })
        );
      });
      return;
    }
    if (url.pathname === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({ n: n++ })}\n\n`);
        if (n >= 3) {
          clearInterval(timer);
          res.end();
        }
      }, 5);
      return;
    }
    if (url.pathname === "/slow") {
      const timer = setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 3000);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/json" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Regression: under --jitless Node does not define globalThis.WebAssembly at
// all. A guard of the form "only stub if WebAssembly already exists" therefore
// skips the stub, and undici's llhttp then throws
// `ReferenceError: WebAssembly is not defined` while loading. The stub must be
// installed unconditionally.
test("WebAssembly is defined even when the engine lacks it (--jitless)", () => {
  assert.equal(typeof globalThis.WebAssembly, "object");
  assert.equal(typeof globalThis.WebAssembly.compile, "function");
});

test("WebAssembly is stubbed and never settles", async () => {
  assert.equal(typeof globalThis.WebAssembly.compile, "function");
  const pending = globalThis.WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  assert.ok(pending instanceof Promise);
  const winner = await Promise.race([
    pending.then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 50)),
  ]);
  assert.equal(winner, "pending");
});

test("GET returns a native Response with url and default User-Agent", async () => {
  const res = await fetch(`${BASE}/json`);
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.url, `${BASE}/json`);
  assert.equal(res.redirected, false);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.ua, "node");
});

test("POST sends body, content-type and reads custom response headers", async () => {
  const payload = JSON.stringify({ a: 1 });
  const res = await fetch(`${BASE}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-custom"), "yes");
  const body = await res.json();
  assert.equal(body.body, payload);
  assert.equal(body.contentType, "application/json");
});

test("SSE streams through res.body.getReader()", async () => {
  const res = await fetch(`${BASE}/sse`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.equal(text.split("\n\n").filter(Boolean).length, 3);
});

test("AbortSignal.timeout aborts an in-flight request", async () => {
  await assert.rejects(
    () => fetch(`${BASE}/slow`, { signal: AbortSignal.timeout(100) }),
    (err) => err.name === "AbortError" || err.name === "TimeoutError"
  );
});

test("relative URLs resolve against DSH_IOS_FETCH_BASE", async () => {
  const res = await fetch("/json");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("redirects are followed and flagged", async () => {
  const res = await fetch(`${BASE}/redirect`);
  assert.equal(res.status, 200);
  assert.equal(res.redirected, true);
  assert.ok(res.url.endsWith("/json"));
});

test("undici globals are preserved (plugin tree depends on them)", () => {
  assert.equal(typeof globalThis.Request, "function");
  assert.equal(typeof globalThis.Response, "function");
  assert.equal(typeof globalThis.Headers, "function");
});