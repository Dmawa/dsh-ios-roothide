# dsh 移植到 RootHide 越狱 iOS

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）移植到越狱 iOS 的完整工程：
- **Node.js 22.23.2** 交叉编译为 iOS arm64 Mach-O，并按 RootHide 的随机 jbroot 包布局打包，**V8 完整 JIT（mprotect W^X 补丁）+ small-icu**（Unicode 正则可用）
- **node-pty** 交叉编译真模块（真实 forkpty，终端功能完整）
- **sharp / node-addon-require-builtin** 用 JS shim 替代（libvips 无法在 iOS 编译）
- **fetch-shim**：undici（wasm llhttp）在 A14 上不可用，`fetch` 经 `node:http`（native parser）转发
- RootHide **.deb** 交付（包架构标识 `iphoneos-arm64e`；实际 Node 与 addon 为 arm64 iOS Mach-O；postinst 使用设备上的 `ldid` 签名）

RootHide 包在 deb 内直接使用 `/usr/local/...` 布局，由 RootHide 的包管理环境安装到当前随机 jbroot。运行时路径遵循 bootstrap 根路径；不要写死 `/var/jb` 或某个 `.jbroot-XXXX`。这些构建脚本不使用 Theos，也不调用 libroot API，因此不下载 Theos SDK 或强行链接 `libroot`。

## 目录

| 路径 | 说明 |
|---|---|
| `.github/workflows/build-dsh-ios.yml` | GitHub Actions：云端全自动交叉编译 + 打包（macOS runner + Xcode） |
| `scripts/ios/apply_patches.py` | 源码补丁（幂等）：node / node-pty / V8 W^X |
| `scripts/ios/build-node-ios.sh` | 编译 Node 22 → nodejs deb |
| `scripts/ios/build-dsh-ios.sh` | 编译 node-pty addon + 打包 dsh 全量依赖 → dsh-ios deb |
| `scripts/ios/fetch-shim.cjs` | 运行时垫片：stub WebAssembly + 把 `fetch` 改走 `node:http`（打包进 deb，launcher 预加载） |
| `scripts/ios/inject-web-polyfill.py` | 构建时给前端 `index.html` 注入 `AbortSignal.any` / `timeout` polyfill（幂等） |
| `ios-sdk-shim/mach/mach_vm.h` | iOS SDK 缺失的 mach_vm 声明（libSystem 运行时实际导出） |

> 原配方仓库 `dddddedcds/Node.js-for-ios`（V8 W^X 补丁 / ninja 修复 / fetch-shim / launcher / clang 包装 / CI）**已从 GitHub 删除**。
> 本仓库的 `scripts/ios/fetch-shim.cjs` 是按它文档化的行为契约重写的；其余脚本一直就在本仓库里。

## 安装（设备端，root）

```sh
# 1. 装包（顺序不能反，dsh-ios 依赖 nodejs）
dpkg -i nodejs_22.23.2-1_iphoneos-arm64e.deb
dpkg -i dsh-ios_0.1.7-rc.2-1_iphoneos-arm64e.deb

# 2. 给 node 本体签名 + 进 trustcache（只需一次；nodejs 包不含这一步）
sudo ldid -M -S /usr/local/lib/nodejs/entitlements.plist /usr/local/bin/node
sudo "$(jbroot /basebin/jbctl)" trustcache add "$(jbroot /usr/local/bin/node)"

# 3. 启动
dsh-ios          # 然后 Safari 打开 http://127.0.0.1:3080
```

`fetch-shim.cjs`、前端 polyfill、node-pty 的签名与 trustcache 都已由包内 postinst 自动处理，
**不需要再手工下发任何文件**。

## 关键设计决策

### 1. JIT：V8 W^X 补丁（mprotect 切权限），不用 MAP_JIT
A14（arm64e）实测（C probe，dynamic-codesigning 签名）：

```
[wx-mprotect] PASS (exec ret=0)   ← mmap(RW) → 写代码 → mprotect(RX) → 执行：可用
[rwx-mmap   ] mapped
[map-jit    ] FAIL                ← MAP_JIT 死路（SIGBUS）
```

V8 默认 darwin 路径用 `MAP_JIT`（A14 上拿不到可执行页 → `KERN_PROTECTION_FAILURE` / SIGBUS）。
解法：移植 [openclaw-ios](https://github.com/j0shua-SYSON/openclaw-ios) 的 **V8 W^X 补丁**（`apply-v8-jit.py`，
7 文件 9 处）——代码区改走普通 mmap + mprotect 切权限。**设备实测完整 JIT 可用**（`JIT_OK`，无需 `--jitless`）。
Node 使用 `scripts/ios/node-jit-entitlements.plist` 中的 `dynamic-codesigning`、
`platform-application`、`no-sandbox`、`get-task-allow` 与 JIT/库验证权限；`allow-jit` 单独无效。

### 2. 不用 `-DTARGET_OS_IPHONE`
定义该宏会让 V8 走 `V8_OS_IOS` 内存路径（MAP_JIT 问题 + 更多 iOS 专属分支），真机启动即崩。
不定义 → `V8_OS_MACOS` + `V8_TARGET_OS_IOS`（后者由 gyp `dest-os=ios` 的 flavor 机制自动设置）。

### 3. 关键系统限制（真机实测，A14 / iOS 16.7 / Dopamine rootless）
- `mmap(MAP_JIT)`：**失败**（SIGBUS，即使 CS_JIT 已授予）
- 普通 `mmap(RW)` + `mprotect(RX)`：**可用**（W^X 补丁的根基）
- **W^X race**：mprotect 切页与后台编译线程并发会崩 → 必须 `--predictable --single-threaded`
- **wasm 双路径不可用**：实例化崩（`WasmMemoryObject::UseInInstance`）+ 代码 GC 崩
  （`WasmCodeAllocator::FreeCode` decommit OOM）→ 见 fetch-shim 段

### 4. 其他补丁摘要（详见 apply_patches.py）
- c-ares：`HAVE_SYS_RANDOM_H` 关闭（macOS 独有头，改走 arc4random_buf）
- v8.gyp：trap handler 源提升到 target 顶层（原嵌套在 maglev 块内，maglev 关闭时不求值，mksnapshot 缺符号）
- node.gypi：CoreFoundation/Security framework 链接对 ios 生效
- crypto_context.cc：macOS 专属 SecTrustSettings 代码对 iOS 排除
- ninja 生成器：configure 后需去掉 host 变体与 target 冲突的 gen 输出规则（`fix-ninja.py`）
- node-pty `src/unix/pty.cc`：`libproc.h` 与 `pthread_chdir_np`/`pthread_fchdir_np` externs 是 macOS 专有，
  用 `#if defined(__APPLE__) && !defined(__aarch64__)` guard；`HANDLE_EINTR` 宏**必须留在 guard 外**
  （iOS 的 kqueue 等待块仍要用它）。
  - **踩坑修复（0.1.1-rc.2 构建）**：构建脚本的 python 补丁曾多插一个无配 `#endif` 的 `#if`，
    预处理失衡 → `error: unterminated conditional directive`，连带把块内 `HANDLE_EINTR` 宏吞掉 →
    后续 7 处 `HANDLE_EINTR` 报 `undeclared`。已修（`#if`/`#endif` 平衡，19/19）。
    同时把 node-gyp 失败从 `>/dev/null 2>&1 || true` 改为吐真实日志。

## ICU 是硬性前提（12 个插件全红的根因）

`build-node-ios.sh` 原来用的是 `--with-intl=none`。dsh 的插件链在几百处使用 Unicode 属性转义
（`\p{L}`、`\p{XID_Start}`、`\p{XID_Continue}`…），**没有 ICU 数据时这些正则字面量在模块求值阶段
就抛 `SyntaxError: Invalid regular expression`**，表现就是启动时"所有插件 failed to import"。

现在改为 `--with-intl=small-icu`（与 xlpoistop-prog/dsh-ios 一致）。small-icu 只裁掉 locale 数据，
Unicode 属性表仍然完整，`\p{...}` 可用，代价是 node 二进制大一些。

> 排查提示：`node -e "console.log(process.versions.icu)"` —— 打印 `undefined` 就说明这个构建没带 ICU。

## 运行时垫片（fetch-shim）

**背景**：dsh 0.1.1 的 HTTP 客户端是 node 内建 **undici**，其 HTTP parser（llhttp）由 **WebAssembly** 编译；
A14 上 wasm 双路径都崩（见上），且 `--jitless` 时代还叠加 wasm 被禁。解法是**不碰 undici**——用一个
基于 `node:http`（native parser，无 wasm）的 `fetch` 覆盖全局：

- `globalThis.WebAssembly` 被 stub 为永不 settle 的 promise → undici 的 lazy llhttp 初始化永远挂起、不崩
- `globalThis.fetch` 覆盖为 `node:http` 实现（支持 SSE `getReader`、`AbortSignal.timeout`），
  内部使用**原生** `Request`/`Response`/`Headers`（构造时 resolve 相对 URL）
- **必须补 `User-Agent` 头**：node:http 默认不带 UA，DeepSeek API 网关把无 UA 的调用当机器人拒
  （401 governor）——shim 默认补 `user-agent: node`（这是"设备 401 / Mac 200"的真因，不是 TLS 指纹）
- **不要**加 `--no-experimental-fetch` / `--no-experimental-websocket`：它们会把 undici 的
  `Request`/`Response`/`Headers` **全局类也禁掉**，dsh 插件树（webRuntime→connection→apiProxy 链）
  启动时依赖这些类 → apiProxy 服务静默不激活 → 所有 `/api/*` 返回 404

> **坑：`globalThis.fetch = fn` 是错的。** Node 把 `fetch` 装成了惰性 getter，普通赋值会先读旧值，
> 从而把 undici 加载进来——正是会崩的那个模块，垫片看起来"完全没生效"。必须用
> `Object.defineProperty(globalThis, "fetch", { value, configurable: true, writable: true })`。
> （这条来自 xlpoistop-prog/dsh-ios 的 `docs/ios-constraints.md` §3。）

**垫片现在随包发布**：源码在 `scripts/ios/fetch-shim.cjs`，构建时复制到 `/usr/local/lib/fetch-shim.cjs`，
并由 `/usr/local/bin/dsh` 用 `--require` 预加载。打包自检（`build-dsh-ios.sh` 第 6 步）会校验它确实在包里、
且 launcher 确实引用了它——不会再出现"文档说有、包里没有"的情况。

> 历史备注：0.1.1 那版 deb 确实漏装了垫片（原作者是在设备上手工补的）。本仓库的 `fetch-shim.cjs` 是按上面
> 的行为契约重写的（原配方仓库 `dddddedcds/Node.js-for-ios` 已 404），本地 19 项用例覆盖 GET/POST/SSE/
> AbortSignal.timeout/相对 URL/重定向/HTTPS。

## 真机验证记录（iPhone 12 Pro Max, A14, iOS 16.7, Dopamine rootless）

- **JIT**：`node -e "console.log(1+1)"` 不带 `--jitless` → `JIT_OK`（W^X 补丁生效）
- **WebAssembly 本体**：`WebAssembly.compile/instantiate` 单次可用（`WASM_OK 42`），但**反复编译/GC 崩**（见上），故运行时整体 stub
- **ICU**：`process.versions.icu` = 78.2，`/\p{L}+/u.test("中文abc")` → true
- **fetch-shim**：30 次连续 HTTPS fetch 压力测试 `OK 30 / ERR 0`（曾必崩）；SSE 流式读取 2 事件 PASS
- **dsh web**：`dsh-ios` 启动后 `http://127.0.0.1:3080` 返回 **HTTP 200**（HTML 页），进程稳定、日志干净
- **LLM**：直连 `api.deepseek.com` chat 200 正常回复（shim 补 UA 后；此前 401 governor）
- **前端兼容**：`AbortSignal.any()` 需 iOS 17.4+ 的 Safari，iOS 16.7 需在 `index.html` 注入 polyfill（已注入）

## 运行时环境与通用性约束（真机实测 2026-08-27）

dsh-ios 附带的 nodejs 是**标准 Node.js 22.23.2**（arm64 iOS），任何**纯 JS** 程序都能运行；实际边界：

1. **JIT 可用但需防 race**：`--predictable --single-threaded` 必需（W^X 切页与编译线程竞争会 SIGBUS）；
   代价是 `worker_threads` 不可用（dsh 的 subagent 走子进程，不受影响）。
2. **WebAssembly 不可用（stub）**：A14 上 wasm 实例化与代码 GC 双路径崩（见上）。
   依赖 wasm 的库/工具无法使用（wasm 打包的压缩/加密/sqlite 等）。
3. **global fetch 用 shim**：undici（wasm llhttp）在 A14 上不可用 → `fetch` 走 `node:http` shim
   （native parser）。任何用 fetch 的工具建议挂 `fetch-shim.cjs`
   （RootHide 包内路径为 `/usr/local/lib/fetch-shim.cjs`）。

其它注意：
- **原生 addon（.node）**：npm 现成 prebuilt 多为 macOS/Linux，iOS 无法 dlopen，需交叉编译 arm64 iOS 版
  （node-pty 已做）；纯 JS 包无此限制。
- **nodejs deb 只含 node 二进制，不含 npm CLI**：装其他工具需从开发机拷 `node_modules` 或自行补 npm。
- **Unicode 正则**：已带 ICU（small-icu），任意 `\p{...}` 属性正则可用。

## iOS 插件 stub（koffi / sandbox / subprocess）

dsh 0.1.1 的 `dsh-sandbox-local` / `dsh-subprocess-local` 依赖 **koffi**（FFI 原生 addon，
无 iOS prebuilt），sandbox 还依赖 Linux landlock 与 Windows ACL——**iOS 上这些能力本就不存在**
（toolpkg manifest 的 `disabled_features` 早已标注 "koffi - no ios prebuilt"）。但插件的硬
`import koffi` 会直接挡死 dsh web 启动。

**解法（已实测，dsh web 3080 返回 HTTP 200）**：把两个插件的 `lib/index.js` 替换为
**extends 基类的惰性 stub**（基类 `SandboxProvider` / `SubprocessRuntime` 是纯 JS，服务注册
`ctx.sandbox` / `ctx.subprocess` 仍生效，`dsh-bash-sandbox` / `dsh-permission-presets` 可正常
激活）：

```js
// dsh-sandbox-local/lib/index.js
import { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
export default class LocalSandboxProvider extends SandboxProvider {
  async start() {}
}
// dsh-subprocess-local/lib/index.js
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
export default class LocalSubprocessRuntime extends SubprocessRuntime {
  async start() {}
}
```

代价：沙箱隔离与 FFI 子进程在 iOS 上不可用（Node 内置 `child_process`/`fork` 仍可用）；
聊天气泡、Web UI、文件、会话等核心功能不受影响。若后续需要真 koffi，可交叉编译
（node-gyp，纯 C，15–30 分钟量级）。

> ⚠️ **0.1.7 起默认不打 stub**：`dsh-win32-process` 里的 koffi 已改成 `createLazyRequire` 惰性加载，
> `node-addon-system` 的 flock 绑定也是函数内 require，所以启动时不再硬碰 koffi。真机若发现启动被挡，
> 构建时加 `DSH_IOS_STUB_PLUGINS=1` 即可把两个插件换成上面的惰性 stub（脚本里已内置这段）。

### 推荐启动姿势（dsh）

包里已经装好两个入口，**直接敲就行**：

```sh
dsh-ios            # = dsh web --no-open，然后在 Safari 打开 http://127.0.0.1:3080
dsh <任意子命令>    # 其他 dsh 子命令走同一个 node 参数组合
```

`/usr/local/bin/dsh` 会做三件事：

1. 用 `jbroot` 把 node / 入口 / 垫片的路径翻译成**真实路径**（RootHide 的 shell 与 node 看到的
   文件系统视图不同，不翻译会 ENOENT——真机踩过）；
2. 默认加 `--jitless`（见下）；
3. `--require fetch-shim.cjs` + `--expose-internals`。

手写等价命令：

```sh
node --jitless --predictable --single-threaded --expose-internals \
     --require "$(jbroot /usr/local/lib/fetch-shim.cjs)" \
     "$(jbroot /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js)" web --no-open
```

**rootHide 适配清单**（全部在 launcher / postinst 里）：

| 问题 | 处理 |
|---|---|
| shell 与 node 看到的文件系统不是同一个视图 | `jbroot` 翻译 node / 入口 / 垫片的路径 |
| 真实根目录的 `/bin` 几乎是空的，node 没有路径插桩 | `PATH` 前置 `${jbroot}usr/bin:${jbroot}bin:...`，否则 spawn 全 ENOENT（看着像沙箱拒绝，其实是路径不存在） |
| `ldid` / `jbctl` 在 `$JBROOT/basebin` | postinst 先补 PATH 再签名 / 加 trustcache |
| 原生 `.node` 不能放在真实文件系统的用户目录（沙箱拒绝 mmap 可执行页） | deb 装进 `/usr/local/...`，由 rootHide 映射进 jbroot |
| shebang 解释器在两种视图下都不稳定 | postinst 提示：失败就用 `sh /usr/local/bin/dsh-ios` |

**为什么默认 `--jitless`**：作者的 V8 W^X 补丁只在 A14 上验证过；A 系列之外的设备（如 M1 iPad）
开 JIT 会 SIGBUS。功能不受影响，只是 JS 慢一些。确认自己设备能开 JIT 时用 `DSH_IOS_JIT=1 dsh-ios`
切回快路径。

### 推荐启动姿势（其他工具）
```sh
NODE_OPTIONS="--predictable --single-threaded \
  --require /usr/local/lib/fetch-shim.cjs"
/usr/local/bin/node your-tool.js
```

## Credits / 血缘

本 iOS 移植的思路与 recipe 借鉴自以下公开工作（**血缘/思路来源，非代码直接拷贝**）：
- [davghz/node22-ios-source](https://github.com/davghz/node22-ios-source) — Node 22 iOS 交叉编译 recipe
- [j0shua-SYSON/node-ios](https://github.com/j0shua-SYSON/node-ios) — Node iOS 移植参考
- [j0shua-SYSON/openclaw-ios](https://github.com/j0shua-SYSON/openclaw-ios) — **V8 W^X 补丁来源**（A9 验证，本工程适配 A14/arm64e）
- [imcynic/nodejs-ios](https://github.com/imcynic/nodejs-ios) — V8/iOS 无 MAP_JIT 路径实测（Node 18 行为对齐；该仓库无独立 LICENSE，仅思路参考）

## 当前发布状态

- 产物：`dsh-ios_0.1.7-rc.2-1_iphoneos-arm64e.deb`（内含 `@deepseek-ai/dsh` 0.1.7-rc.2、node-pty
  交叉编译产物、`fetch-shim.cjs`、前端 polyfill）+ `nodejs_22.23.2-1_iphoneos-arm64e.deb`。
  安装顺序：nodejs → dsh-ios。**deb 产物不进 git（dist/ 已 gitignore），由 CI 产出。**
- 版本号只有一处来源：`scripts/ios/build-dsh-ios.sh` 顶部的 `DSH_VER`；`control` 的 `Version`、
  deb 文件名、CI 的产物校验都从它推出来。
- 设备验证覆盖：JIT / ICU / fetch-shim / dsh web 200 / LLM 200 的记录来自
  **iPhone 12 Pro Max / A14 / iOS 16.7 / Dopamine rootless**；RootHide 上只验证到
  "插件系统启动 + 垫片生效"，**0.1.7-rc.2 这版还没做完整真机回归**。
- 已知限制：WebAssembly 不可用（stub）；沙箱隔离与 FFI 子进程不可用；sharp/libvips 图片附件不可用；
  `worker_threads` 不可用（`--single-threaded`）；JIT 默认关闭（`DSH_IOS_JIT=1` 可开）；
  iOS 16.7 Safari 的 `AbortSignal.any` 由构建期注入的 polyfill 兜底。
