# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## iOS (jailbroken)

A community port of `dsh` runs on jailbroken iOS (arm64, rootless jailbreaks such as Dopamine and RootHide). It bundles a cross-compiled Node.js 22 runtime, a native `node-pty` addon, and JS shims for `sharp` / `require-builtin` / `fetch`, packaged as a `.deb`.

- Build & packaging guide: [docs/ios-port.md](docs/ios-port.md)
- Project state / handover notes: [docs/HANDOVER.md](docs/HANDOVER.md)
- Current package: `dsh-ios_0.1.7-rc.2-1_iphoneos-arm64e.deb` (bundles `@deepseek-ai/dsh` 0.1.7-rc.2)

Install order matters — `nodejs` first, then `dsh-ios` (sign `node` with `ldid` once, see the guide). Then just run `dsh-ios` and open `http://127.0.0.1:3080` in Safari; the launcher handles RootHide's `jbroot` path translation, the `fetch` shim and the JIT flags for you.

Known limitations: `sharp`/`libvips` are shimmed (no image processing); WebAssembly is stubbed and `fetch` is re-routed through `node:http` by the bundled `fetch-shim.cjs` (undici's wasm llhttp is fatal on A14, and the DeepSeek gateway rejects UA-less requests); the runtime defaults to `--jitless` because the patched V8 W^X path is only verified on A14 and SIGBUSes elsewhere (`DSH_IOS_JIT=1` opts back in); sandbox isolation and koffi-based FFI subprocesses are unavailable on iOS (no prebuilt). The bundled Node ships small-icu, so Unicode property regexes work. `worker_threads` is unavailable under `--single-threaded`. See [docs/ios-port.md](docs/ios-port.md) for full runtime constraints.

### iOS port credits

The iOS port builds on the following public work (idea/recipe lineage, not copied code; full detail in [docs/ios-port.md](docs/ios-port.md)):

- `dddddedcds/Node.js-for-ios` (now removed upstream) — cross-compile recipe, V8 W^X patch, fetch shim, launcher. `scripts/ios/fetch-shim.cjs` here is a clean-room rewrite of that shim.
- [j0shua-SYSON/openclaw-ios](https://github.com/j0shua-SYSON/openclaw-ios) — V8 W^X JIT patch source (MIT).
- [j0shua-SYSON/node-ios](https://github.com/j0shua-SYSON/node-ios) — Node-iOS build approach & entitlements (MIT).
- [davghz/node22-ios-source](https://github.com/davghz/node22-ios-source) — Node 22 iOS cross-compile recipe.
- [imcynic/nodejs-ios](https://github.com/imcynic/nodejs-ios) — no-MAP_JIT path evidence (no independent LICENSE; idea reference only).
## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
