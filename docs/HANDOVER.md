# 交接说明（dsh iOS / RootHide 移植）

> 接手人核查时间：2026-10-17。本文只记录**实测过的事实**，推断的地方会标注"待验证"。

## 1. 这是什么

把 DeepSeek Harness（`dsh`）移植到越狱 iOS 的工程。产出两个 `.deb`：

| 包 | 内容 |
|---|---|
| `nodejs_22.23.2-1_iphoneos-arm64e.deb` | Node 22.23.2 交叉编译成 arm64 iOS Mach-O，带 V8 W^X 补丁（完整 JIT）、small-icu |
| `dsh-ios_*_iphoneos-arm64e.deb` | dsh 全量依赖 + 交叉编译的 node-pty + 若干 JS shim，自包含（设备端不需要 npm） |

安装顺序 nodejs → dsh-ios，启动 `dsh-ios`，Safari 打开 `http://127.0.0.1:3080`。

## 2. 代码在哪

| 位置 | 说明 |
|---|---|
| `https://github.com/Dmawa/dsh-ios-roothide` | 唯一权威仓库（公开，8 commits，MIT）。旧名 `18157153951-sudo/dsh-ios-roothide`，GitHub 会自动跳转 |
| `C:\Users\端木\Documents\deepseek-harness\default-workspace\dsh-ios-roothide` | **本交接建立的可写工作副本**，HEAD `900d96e`，与远端一致 |
| `D:\ai\tweaks\sigtest\zipcheck` | 原工作目录。内容与远端一致，但**整个 `D:\ai\tweaks` 树对当前用户只读**（ACL 限制），无法提交/构建，仅作历史副本 |
| `D:\ai\deepseek-harness` | 上游 `deepseek-ai/deepseek-harness` 的本地克隆（master，有大量未提交改动）。**不含 iOS 脚本**，与本项目无直接关系，别混淆 |
| `C:\Users\端木\Desktop\zcode产物\` | 构建产物：`dsh-ios_0.1.1-rc.2-1_iphoneos-arm64e.deb`（127 MB）、`nodejs_22.23.2-1_iphoneos-arm64e.deb`（22 MB） |

`docs/ios-port.md` 是原作者的完整技术文档（设计决策、真机验证记录、踩坑），**接手前必读**。

## 3. 构建链

```
GitHub Actions (macos-15-intel, .github/workflows/build-dsh-ios.yml)
  ├─ scripts/ios/build-node-ios.sh     Node 22 → out/Release/node → nodejs deb   (~2.5h)
  └─ scripts/ios/build-dsh-ios.sh      node-pty 交叉编译 + npm i dsh + 打包       (~6min)
       └─ scripts/ios/apply_patches.py  7 处 Node 源码补丁（幂等）
```

关键设计（详见 `docs/ios-port.md`）：

- **JIT**：V8 走普通 `mmap` + `mprotect` 切 W^X，不用 `MAP_JIT`（A14 上 MAP_JIT 必崩）。必须 `--predictable --single-threaded`，否则切页与编译线程竞争 SIGBUS。
- **不定义 `-DTARGET_OS_IPHONE`**：否则 V8 走 `V8_OS_IOS` 内存路径，真机启动即崩。
- **WebAssembly 不可用**：A14 上实例化与代码 GC 双崩，运行时整体 stub。
- **`fetch` 走 `node:http` shim**：undici 的 llhttp 是 wasm，用不了；shim 还必须补 `User-Agent`（DeepSeek 网关对无 UA 请求返回 401）。
- **沙箱/FFI 子进程不可用**：koffi 无 iOS prebuilt。

## 4. 当前状态（核查结论）

- git 工作区干净，HEAD = `900d96e ci: pin dsh to 0.1.7-rc.2`。
- 最近一次 CI：`build-dsh-ios #9` **成功**（6m 14s，run 37031810719）。此前 6 次失败，都是脚本路径/依赖版本问题，已修。
- 12 个 open PR 全是 dependabot 噪音（`chore: disable dependabot` 提交没真正关掉它）。
- 无 Release、无 tag，产物只存在于 Actions artifact 里。

## 5. 我核查出的问题（按严重度）

> 状态：P0-1 / P0-2 / P1-1 / P1-2 / P2 已于 2026-10-17 修复，详见 §10。P1-3（RootHide 真机回归）仍待设备验证。

### P0-1　版本号自相矛盾
`build-dsh-ios.sh` 里 `npm install @deepseek-ai/dsh@0.1.7-rc.2`，但 deb 的 `control` `Version:`、文件名、CI artifact 路径、README 全都还是 `0.1.1-rc.2-1`。
**已实测**：解包 Desktop 上那个 127 MB deb，里面 `@deepseek-ai/dsh/package.json` 是 `0.1.7-rc.2`，`control` 写 `0.1.1-rc.2-1`。
后果：设备端升级判断错乱，用户以为装的是 0.1.1。

### P0-2　`fetch-shim.cjs` 根本不在包里
文档和 README 都说"WebAssembly 由随包的 `fetch-shim.cjs` stub、`fetch` 改走 `node:http`"，但：

- 仓库里**没有** `fetch-shim.cjs` 这个文件（只有 README/docs 提到它）；
- 实测 deb 内 `data.tar.gz` 里搜不到任何 `fetch-shim`；
- `dsh-ios` launcher 也**没有** `--require .../fetch-shim.cjs`。

也就是说 CI 产出的 deb 在 A14 上跑 `fetch` 会撞 undici/wasm 崩溃。原文档里的"真机 HTTP 200 / LLM 200"是**手工在设备上补了 shim 之后**的结果，不是这个 deb 自带的。
源头 `dddddedcds/Node.js-for-ios`（含 `scripts/fetch-shim.cjs` 4385 B、`scripts/dsh-ios-launcher` 752 B）**已经 404**，源码需要重写。

### P1-1　`AbortSignal.any` polyfill 没注入
文档说"已注入前端 index.html"。实测 deb 内 `dsh-web-frontend/dist/index.html` 只有 825 B，**不含** `AbortSignal`。iOS 16.7 Safari 下前端会报错。同样需要固化进构建脚本。

### P1-2　koffi 插件 stub 没固化
文档说"stub 已固化进 deb"，实测 `dsh-sandbox-local/lib/index.js`(22 KB) 和 `dsh-subprocess-local/lib/index.js`(54 KB) 都是**原版**，不是 stub。
不过 0.1.7 里 koffi 已改成 `createLazyRequire` 惰性加载（见 `dsh-win32-process/lib/index.js:25`），**可能不再阻塞启动**——需要在真机上实测确认，确认后可以删掉"必须 stub"的说法。

### P1-3　RootHide 从未真机验证
文档里所有真机记录都是 **iPhone 12 Pro Max / A14 / iOS 16.7 / Dopamine rootless**。这个仓库叫 roothide，但 RootHide 路径、随机 jbroot、postinst 里的 `ldid`/`jbctl trustcache` 都没跑通过。

### P2　文档与实现漂移
`docs/ios-port.md`「当前发布状态」一节描述的能力（fetch-shim、stub、polyfill）大部分没进脚本，属于"当时手工做了一遍，没回写进 CI"。

## 6. 建议的下一步

按性价比排序，建议先做 1→3，做完这套 CI 产物才算"设备可用"：

1. **修版本号**：把版本收敛成单一变量（`DSH_VER`），同步改 `control`、deb 文件名、workflow 的 artifact 路径、README。
2. **补 `fetch-shim.cjs`**：按 `docs/ios-port.md` 的描述重写（stub `WebAssembly` 为永不 settle 的 promise、`fetch` 用 `node:http` 实现、默认补 `User-Agent`、支持 SSE `getReader` 与 `AbortSignal.timeout`），进仓库 + 打进 deb + 写进 launcher。
3. **补 `AbortSignal.any` polyfill**：构建时注入 `dsh-web-frontend/dist/index.html`。
4. **真机验证 0.1.7**：先确认 koffi 是否还需要 stub，再决定要不要固化 stub；补 RootHide 验证记录。
5. **收尾**：清理 dependabot PR、打第一个 tag + Release、把 `D:\ai\tweaks\sigtest\zipcheck` 标注为历史副本。

## 7. 怎么构建 / 怎么验证

- 本地（Windows）**无法构建**：需要 macOS + Xcode（`xcrun --sdk iphoneos`）、ninja、dpkg。只能走 GitHub Actions。
- 触发：push 到 `main`（改动 `scripts/**`、`ios-sdk-shim/**` 或 workflow 本身）或手动 `workflow_dispatch`。
- 产物：Actions artifact `dsh-ios-debs`；打 tag 会自动发 Release。
- 解包检查（Windows 自带 tar 即可，不需要 dpkg）：
  ```powershell
  tar -tf dsh-ios_xxx.deb                     # 看 ar 成员：control.tar.gz / data.tar.gz
  tar -xzf control.tar.gz -C ctrl; cat ctrl/control
  tar -tzf data.tar.gz | Select-String 'fetch-shim|dsh-ios$'
  ```

## 8. 已知限制（能力边界，非 bug）

- WebAssembly 不可用（整体 stub）。
- 沙箱隔离、FFI 子进程不可用（koffi 无 iOS prebuilt）；Node 内置 `child_process` 可用。
- `sharp`/libvips 不可用 → 图片附件处理禁用（shim 抛错）。
- `worker_threads` 不可用（`--single-threaded`）；dsh 的 subagent 走子进程，不受影响。
- nodejs deb 不含 npm CLI。
- iOS 16.7 Safari 需要 `AbortSignal.any` polyfill（见 P1-1）。

## 9. 血缘 / Credits

思路与配方来自公开工作，非代码直接拷贝：

- `dddddedcds/Node.js-for-ios`（已 404）— 交叉编译配方、V8 W^X、fetch shim、launcher
- `j0shua-SYSON/openclaw-ios` — V8 W^X 补丁来源（MIT）
- `j0shua-SYSON/node-ios` — Node-iOS 构建与 entitlements（MIT）
- `davghz/node22-ios-source` — Node 22 iOS 交叉编译配方
- `imcynic/nodejs-ios` — 无 MAP_JIT 路径实测（仅思路参考）
## 10. 接手后的改动记录（2026-10-17）

### 新增文件

| 文件 | 作用 |
|---|---|
| `scripts/ios/fetch-shim.cjs` | 运行时垫片。原配方仓库已 404，这是按 `docs/ios-port.md` 的行为契约重写的实现：stub `WebAssembly`（永不 settle 的 promise，避免 undici 的 wasm llhttp 崩）、把 `fetch` 换成 `node:http` 实现（原生 `Request`/`Response`/`Headers`、SSE `getReader`、`AbortSignal.timeout`、相对 URL、重定向、默认补 `User-Agent: node`）。本地 19 项用例全过 + HTTPS 实测 200 |
| `scripts/ios/inject-web-polyfill.py` | 构建期给 `dsh-web-frontend/dist/index.html` 注入 `AbortSignal.any` / `AbortSignal.timeout` polyfill（幂等，带 reason 传播）。已在 Node 里跑过 10 项用例 |
| `docs/HANDOVER.md` | 本文 |

### 修改

- **版本号单一来源**：`build-dsh-ios.sh` 顶部 `DSH_VER=0.1.7-rc.2`，`control` 的 `Version`、deb 文件名、CI 产物校验全部从它推出，不再出现"0.1.1 的包装 0.1.7 的货"。
- **垫片进包**：`cp scripts/ios/fetch-shim.cjs → /usr/local/lib/fetch-shim.cjs`。
- **launcher 重写**（`/usr/local/bin/dsh`）：不再用 symlink，改成 wrapper，做三件事——
  1. 用 `jbroot` 翻译 node / 入口 / 垫片路径（RootHide 的 shell 与 node 看到的文件系统视图不同，不翻译必 ENOENT，真机踩过）；
  2. 默认 `--jitless`（作者的 V8 W^X 补丁只在 A14 验证过，M1 iPad 开 JIT 会 SIGBUS）；`DSH_IOS_JIT=1` 可切回；
  3. `--require <shim> --expose-internals`。
  `dsh-ios` 变成 `dsh web --no-open` 的一行封装。
- **postinst**：RootHide 的 `ldid`/`jbctl` 在 `$JBROOT/basebin`，脚本现在会先把它加进 PATH 再签名/加 trustcache；另加垫片缺失告警。
- **koffi stub 改为 opt-in**：0.1.7 的 koffi 已是 `createLazyRequire` 惰性加载，默认不再打 stub（会破坏沙箱插件语义）；需要时 `DSH_IOS_STUB_PLUGINS=1` 构建。
- **打包自检**：`build-dsh-ios.sh` 第 6 步校验垫片、launcher 引用、polyfill 标记、node-pty 产物，缺一个就构建失败。
- **CI**：新增 `bash -n` / `node --check` / `py_compile` 语法门禁（在 2.5 小时的交叉编译**之前**失败）；产物路径改成 `dist/*.deb` + 版本一致性断言。
- **文档**：README、`docs/ios-port.md` 的安装步骤、垫片说明、启动姿势、发布状态全部对齐到实际实现。

### 仍然待办

1. **0.1.7-rc.2 真机回归**：装新 deb → `dsh-ios` → 确认 3080 返回 200、插件全绿、能正常对话。
2. 若插件仍被 koffi 挡住，用 `DSH_IOS_STUB_PLUGINS=1` 重出包。
3. JIT 在 M1 上的崩溃没定位（需要崩溃报告），目前 `--jitless` 兜底。
4. 清掉 12 个 dependabot PR，打第一个 tag + Release。

## 11. 第二轮改动（2026-10-17，对照 xlpoistop-prog/dsh-ios 之后）

本移植与 `xlpoistop-prog/dsh-ios` 同源（同样的 `build-node-ios.sh` / `entitlements.plist` /
`ios-sdk-shim/mach/mach_vm.h` / V8 补丁结构）。对照它的 `docs/ios-constraints.md` 后补了三处：

1. **ICU（根因）**：`build-node-ios.sh` 的 `--with-intl=none` → `--with-intl=small-icu`。
   没有 ICU，`\p{XID_Start}` 这类正则字面量在 import 阶段就抛 SyntaxError，dsh-tools 被 30 个包
   引用，于是所有插件全红。这才是"12 个插件 failed to import"的真正原因，与 dsh 版本无关。
2. **`fetch` 必须用 defineProperty 覆盖**：Node 的 `fetch` 是惰性 getter，直接赋值会先触发
   getter → 加载 undici → 崩。改成 `Object.defineProperty`。
3. **前端 polyfill 补全**：除 `AbortSignal.any/timeout` 外，补 `Iterator` helpers（Safari 18.4 才有，
   而 dsh 前端用 `typeof Iterator.prototype.join !== 'function'` 做特性检测，全局不存在时直接
   ReferenceError）、`Promise.withResolvers`、`Object/Map.groupBy`、`Array.fromAsync`。
   实现来自 `scripts/ios/web-polyfill.js`，由 `inject-web-polyfill.py` 注入 index.html。

经核对，0.1.7 里 **不需要** 额外 stub：koffi 已是 `await import()` 惰性加载，`dsh-win32-process`
的 ABI 断言在函数内，`node-addon-system/flock` 没有任何包引用。
