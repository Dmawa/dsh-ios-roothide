"use strict";
/**
 * undici-stub.cjs — pure-JS stand-in for undici on jailbroken iOS.
 *
 * Real undici compiles its llhttp HTTP parser to WebAssembly. This device must
 * run --jitless (its JIT path SIGBUSes), and --jitless leaves no WebAssembly at
 * all, so loading undici is fatal. fetch-shim.mjs redirects every undici import
 * here via module.registerHooks(); the URL must point at a real file, because
 * ESM import() rejects custom URL schemes.
 *
 * dsh only needs dispatchers plus fetch. Dispatchers degenerate to no-ops
 * because fetch-shim.mjs talks to node:http directly.
 */

class Dispatcher {
  constructor(options) { this.options = options || {}; }
  dispatch() { return false; }
  close() { return Promise.resolve(); }
  destroy() { return Promise.resolve(); }
}

class Agent extends Dispatcher {}
class Pool extends Dispatcher {}
class ProxyAgent extends Dispatcher {}
class Client extends Dispatcher {}

let globalDispatcher = new Agent();

function getGlobalDispatcher() { return globalDispatcher; }
function setGlobalDispatcher(d) { globalDispatcher = d; }

function fetch(input, init) {
  const rest = Object.assign({}, init);
  delete rest.dispatcher;
  return globalThis.fetch(input, rest);
}

function unsupported(name) {
  return function () {
    throw new Error("undici." + name + " is not available on this iOS build (use fetch)");
  };
}

const mod = {
  Agent, Pool, ProxyAgent, Client, Dispatcher,
  getGlobalDispatcher, setGlobalDispatcher, fetch,
  request: unsupported("request"),
  stream: unsupported("stream"),
  pipeline: unsupported("pipeline"),
  connect: unsupported("connect"),
  upgrade: unsupported("upgrade"),
  buildConnector: unsupported("buildConnector"),
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
  errors: {},
};

module.exports = mod;
module.exports.default = mod;
module.exports.Agent = Agent;
module.exports.Pool = Pool;
module.exports.ProxyAgent = ProxyAgent;
module.exports.Client = Client;
module.exports.Dispatcher = Dispatcher;
module.exports.fetch = fetch;
module.exports.getGlobalDispatcher = getGlobalDispatcher;
module.exports.setGlobalDispatcher = setGlobalDispatcher;