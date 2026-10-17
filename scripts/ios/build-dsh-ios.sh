#!/bin/sh
# build-dsh-ios.sh — bundle DeepSeek Harness for jailbroken iOS:
#   * cross-compile node-pty addon (pty.node + spawn-helper, arm64 iOS)
#   * npm-install @deepseek-ai/dsh (scripts disabled)
#   * apply JS shims (sharp / require-builtin / fetch / web polyfills)
#   * package dsh-ios .deb (self-contained, no device-side npm)
#
# Usage: ./scripts/ios/build-dsh-ios.sh   (requires nodejs deb built first: scripts/ios/build-node-ios.sh)
# Output: dist/dsh-ios_${DSH_VER}-${DEB_REV}_${DEB_ARCH}.deb
#
# Env:
#   DSH_VER                 @deepseek-ai/dsh version to bundle (default below)
#   DSH_IOS_STUB_PLUGINS=1  replace dsh-sandbox-local / dsh-subprocess-local with
#                           inert stubs (only needed if koffi blocks boot again;
#                           0.1.7 lazy-requires koffi, so this is off by default)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"
mkdir -p dist

NODE_VER=22.23.2
DSH_VER="${DSH_VER:-0.1.7-rc.2}"
DEB_REV=1
DEB_VER="${DSH_VER}-${DEB_REV}"
DEB_ARCH=iphoneos-arm64e
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
SHIM="$ROOT/ios-sdk-shim"
WORK=/tmp/dsh-ios-work
rm -rf "$WORK"
mkdir -p "$WORK"

echo "== [0/6] 目标版本: @deepseek-ai/dsh@$DSH_VER (deb $DEB_VER) =="

echo "== [1/6] 下载 node headers（node-pty 编译用）=="
curl -sL -o /tmp/node-hdrs.tar.gz "https://nodejs.org/download/release/v$NODE_VER/node-v$NODE_VER-headers.tar.gz"
tar xzf /tmp/node-hdrs.tar.gz -C "$WORK"
mv "$WORK/node-v$NODE_VER" "$WORK/node-headers"

echo "== [2/6] 交叉编译 node-pty =="
mkdir -p "$WORK/node-pty" && cd "$WORK/node-pty"
npm pack node-pty@1.1.0 --silent >/dev/null
tar xzf node-pty-1.1.0.tgz && mv package node-pty-src && cd node-pty-src
npm install --ignore-scripts --no-audit --no-fund --silent >/dev/null 2>&1 || true
# iOS clang 包装（过滤 macOS 专属 -mmacosx-version-min）
cat > /tmp/clang-ios <<EOF
#!/bin/sh
args=""
for a in "\$@"; do
  case "\$a" in
    -mmacosx-version-min*) ;;
    *) args="\$args \$a" ;;
  esac
done
exec /usr/bin/clang -target arm64-apple-ios16.0 -isysroot "$SDK" -miphoneos-version-min=16.0 \$args
EOF
cat > /tmp/clang++-ios <<EOF
#!/bin/sh
args=""
for a in "\$@"; do
  case "\$a" in
    -mmacosx-version-min*) ;;
    *) args="\$args \$a" ;;
  esac
done
exec /usr/bin/clang++ -target arm64-apple-ios16.0 -isysroot "$SDK" -miphoneos-version-min=16.0 -stdlib=libc++ \$args
EOF
chmod +x /tmp/clang-ios /tmp/clang++-ios
# 打 iOS 兼容补丁（libproc/kqueue 等守卫）
python3 - <<'PY'
import re
f = "src/unix/pty.cc"
s = open(f).read()
# libproc.h is macOS-only; guard the include (balanced #if/#endif).
s = s.replace('#elif defined(__APPLE__)\n#include <libproc.h>',
              '#elif defined(__APPLE__)\n#if !defined(__aarch64__)\n#include <libproc.h>\n#endif')
# extern "C" pthread externs are macOS-only APIs; guard them, but keep
# HANDLE_EINTR defined unconditionally -- the kqueue wait block below still
# uses it on iOS. (Previous version nested an extra #if without a matching
# #endif, which unbalanced the preprocessor and hid HANDLE_EINTR.)
old_block = '''#if defined(__APPLE__)
extern "C" {
// Changes the current thread's directory to a path or directory file
// descriptor. libpthread only exposes a syscall wrapper starting in
// macOS 10.12, but the system call dates back to macOS 10.5. On older OSes,
// the syscall is issued directly.
int pthread_chdir_np(const char* dir) API_AVAILABLE(macosx(10.12));
int pthread_fchdir_np(int fd) API_AVAILABLE(macosx(10.12));
}

#define HANDLE_EINTR(x) ({ \\
  int eintr_wrapper_counter = 0; \\
  decltype(x) eintr_wrapper_result; \\
  do { \\
    eintr_wrapper_result = (x); \\
  } while (eintr_wrapper_result == -1 && errno == EINTR && \\
           eintr_wrapper_counter++ < 100); \\
  eintr_wrapper_result; \\
})
#endif'''
new_block = '''#if defined(__APPLE__) && !defined(__aarch64__)
extern "C" {
// Changes the current thread's directory to a path or directory file
// descriptor. libpthread only exposes a syscall wrapper starting in
// macOS 10.12, but the system call dates back to macOS 10.5. On older OSes,
// the syscall is issued directly.
int pthread_chdir_np(const char* dir) API_AVAILABLE(macosx(10.12));
int pthread_fchdir_np(int fd) API_AVAILABLE(macosx(10.12));
}
#endif

#define HANDLE_EINTR(x) ({ \\
  int eintr_wrapper_counter = 0; \\
  decltype(x) eintr_wrapper_result; \\
  do { \\
    eintr_wrapper_result = (x); \\
  } while (eintr_wrapper_result == -1 && errno == EINTR && \\
           eintr_wrapper_counter++ < 100); \\
  eintr_wrapper_result; \\
})'''
assert old_block in s, "pty.cc extern/HANDLE_EINTR block not found -- patch text mismatch"
s = s.replace(old_block, new_block)
# pty_getproc depends on libproc; guard its declaration + uses on iOS.
s = s.replace('#if defined(__APPLE__)\nstatic char *\npty_getproc(int);',
              '#if defined(__APPLE__) && !defined(__aarch64__)\nstatic char *\npty_getproc(int);')
s = s.replace('#if defined(__APPLE__)\n  if (info.Length() != 1 ||',
              '#if defined(__APPLE__) && !defined(__aarch64__)\n  if (info.Length() != 1 ||')
s = s.replace('#elif defined(__APPLE__)\n\nstatic char *\npty_getproc(int fd) {',
              '#elif defined(__APPLE__) && !defined(__aarch64__)\n\nstatic char *\npty_getproc(int fd) {')
open(f, "w").write(s)
print("pty.cc patched")
PY
export CC=/tmp/clang-ios CXX=/tmp/clang++-ios CFLAGS="-DNAPI_VERSION=8" CXXFLAGS="-DNAPI_VERSION=8"
npx --yes node-gyp@10 rebuild --nodedir="$WORK/node-headers" --arch=arm64 >"$WORK/node-pty-build.log" 2>&1 || {
  echo "node-pty 编译失败，详见 $WORK/node-pty-build.log:"; tail -40 "$WORK/node-pty-build.log"; exit 1; }
ls build/Release/pty.node build/Release/spawn-helper >/dev/null 2>&1 || { echo "node-pty 产物缺失"; exit 1; }

echo "== [3/6] npm 安装 @deepseek-ai/dsh@$DSH_VER（跳过原生构建）=="
mkdir -p "$WORK/dsh" && cd "$WORK/dsh"
npm init -y >/dev/null 2>&1
npm_config_ignore_scripts=true npm_config_fund=false npm_config_audit=false \
  npm install "@deepseek-ai/dsh@$DSH_VER" --no-audit --no-fund >"$WORK/npm-install.log" 2>&1 || {
  echo "npm install 失败，详见 $WORK/npm-install.log:"; tail -40 "$WORK/npm-install.log"; exit 1; }

echo "== [4/6] 应用 iOS addon + shims =="
NM="$WORK/dsh/node_modules"
mkdir -p "$NM/node-pty/build/Release"
cp "$WORK/node-pty/node-pty-src/build/Release/pty.node" "$NM/node-pty/build/Release/"
cp "$WORK/node-pty/node-pty-src/build/Release/spawn-helper" "$NM/node-pty/build/Release/"
chmod 755 "$NM/node-pty/build/Release/spawn-helper"
rm -rf "$NM/node-pty/prebuilds" "$NM/@img"

# sharp: libvips 无法在 iOS 编译 -> 双入口 shim（exports 把 ESM import 路由到 index.mjs）
if [ -d "$NM/sharp" ]; then
cat > "$NM/sharp/dist/index.cjs" <<'EOF'
"use strict";
function u(){throw new Error("sharp is not available on this iOS build: image attachment processing is disabled");}
u.format={};u.versions={sharp:"0.0.0-ios-shim"};u.simd=false;u.concurrency=1;u.cache=()=>u;u.cacheable=true;
module.exports=u;module.exports.default=u;
EOF
cat > "$NM/sharp/dist/index.mjs" <<'EOF'
function u(){throw new Error("sharp is not available on this iOS build: image attachment processing is disabled");}
u.format={};u.versions={sharp:"0.0.0-ios-shim"};u.simd=false;u.concurrency=1;u.cache=()=>u;u.cacheable=true;
export default u;
EOF
fi

# node-addon-require-builtin: 依赖 V8 内部绑定，iOS 上改用普通 require
if [ -d "$NM/node-addon-require-builtin" ]; then
cat > "$NM/node-addon-require-builtin/lib/index.js" <<'EOF'
"use strict";
function requireBuiltin(id){return require(id);}
function isAllowedInternalId(){return true;}
function getBindingInfo(){return {native:false,addon:null};}
exports.requireBuiltin=requireBuiltin;exports.isAllowedInternalId=isAllowedInternalId;exports.getBindingInfo=getBindingInfo;
exports.default={requireBuiltin,isAllowedInternalId,getBindingInfo};
EOF
fi

# 可选：koffi 硬 import 挡启动时，把两个本地 provider 换成惰性 stub。
# 0.1.7 起 koffi 已是 createLazyRequire 惰性加载，默认不需要。
if [ "${DSH_IOS_STUB_PLUGINS:-0}" = "1" ]; then
  echo "  DSH_IOS_STUB_PLUGINS=1 -> 应用 sandbox/subprocess 惰性 stub"
  if [ -d "$NM/@deepseek-ai/dsh-sandbox-local/lib" ]; then
cat > "$NM/@deepseek-ai/dsh-sandbox-local/lib/index.js" <<'EOF'
import { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
export default class LocalSandboxProvider extends SandboxProvider {
  async start() {}
}
EOF
  fi
  if [ -d "$NM/@deepseek-ai/dsh-subprocess-local/lib" ]; then
cat > "$NM/@deepseek-ai/dsh-subprocess-local/lib/index.js" <<'EOF'
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
export default class LocalSubprocessRuntime extends SubprocessRuntime {
  async start() {}
}
EOF
  fi
fi

# 前端 polyfill（iOS 16.7 Safari 缺 AbortSignal.any）
python3 "$SCRIPT_DIR/inject-web-polyfill.py" "$NM"

echo "== [5/6] 组装 deb 目录 =="
DEB=/tmp/dsh-deb
rm -rf "$DEB" && mkdir -p "$DEB/DEBIAN" "$DEB/usr/local/bin" "$DEB/usr/local/lib"
cp -a "$NM" "$DEB/usr/local/lib/node_modules"
cp "$SCRIPT_DIR/fetch-shim.cjs" "$DEB/usr/local/lib/fetch-shim.cjs"
chmod 644 "$DEB/usr/local/lib/fetch-shim.cjs"

# 所有入口都走同一套 node 参数。
#
# RootHide 的文件系统是虚拟化的：shell 看到的是 jbroot 合并后的视图，而 node
# 看到的是真实路径。所以交给 node 的每一个路径都必须先过 `jbroot` 翻译，否则
# --require / 入口脚本都会 ENOENT（真机实测过）。
#
# --jitless 是默认值：移植作者的 V8 W^X 补丁只在 A14 上验证过，A 系列之外的
# 设备（如 M1 iPad）开 JIT 会 SIGBUS。功能不受影响，只是 JS 慢一些。
# 想赌一把 JIT 就 DSH_IOS_JIT=1 dsh-ios。
cat > "$DEB/usr/local/bin/dsh" <<'EOF'
#!/bin/sh
# dsh — DeepSeek Harness on jailbroken iOS (rootHide / rootless aware)
#
# rootHide answers "where is /usr/local?" two different ways: a jailbreak shell
# sees the merged, jbroot-prefixed view; a plain iOS process like node sees the
# real root. Every path handed to node must be translated, or it ENOENTs.

JB=""
if command -v jbroot >/dev/null 2>&1; then
  JB="$(jbroot 2>/dev/null)" || JB=""
fi
if [ -z "$JB" ]; then
  JB="${JBROOT:-}"
fi
[ -n "$JB" ] || JB="/"

NODE="${JB}usr/local/bin/node"
ENTRY="${JB}usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
SHIM="${JB}usr/local/lib/fetch-shim.cjs"

if [ ! -x "$NODE" ]; then
  echo "dsh: node not found at $NODE (install the nodejs package first)" >&2
  exit 127
fi
if [ ! -f "$SHIM" ]; then
  echo "dsh: fetch-shim missing at $SHIM (broken install?)" >&2
  exit 127
fi

# The real root has almost nothing in /bin — the jailbreak userland lives under
# jbroot. node does not get rootHide's path interposition, so everything it
# spawns (the bash tool, node-pty's shell) only resolves if the jbroot bin
# directories are on PATH. Without this, spawn fails with ENOENT and it looks
# like a sandbox denial.
export PATH="${JB}usr/bin:${JB}bin:${JB}usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export DSH_HOME="${DSH_HOME:-${HOME:-/var/mobile}/.dsh}"

# --predictable --single-threaded: required by the patched V8 W^X path.
FLAGS="--predictable --single-threaded"
if [ "${DSH_IOS_JIT:-0}" != "1" ]; then
  FLAGS="--jitless $FLAGS"
fi

exec "$NODE" $FLAGS --expose-internals --require "$SHIM" "$ENTRY" "$@"
EOF
chmod 755 "$DEB/usr/local/bin/dsh"

cat > "$DEB/usr/local/bin/dsh-ios" <<'EOF'
#!/bin/sh
# dsh-ios — 启动 Web UI（不自动开浏览器），然后用 Safari 打开 http://127.0.0.1:3080
exec /usr/local/bin/dsh web --no-open "$@"
EOF
chmod 755 "$DEB/usr/local/bin/dsh-ios"
cat > "$DEB/DEBIAN/control" <<CTRL
Package: dsh-ios
Name: DeepSeek Harness for iOS
Version: $DEB_VER
Architecture: $DEB_ARCH
Maintainer: dsh-ios port
Section: Development
Depends: nodejs (>= 22.19.0)
Description: DeepSeek Harness (dsh) for jailbroken iOS. Bundles the full CLI with cross-compiled node-pty (real PTY) and JS shims for sharp / require-builtin / fetch. Self-contained: no npm needed on the device. Launch with "dsh-ios".
CTRL

cat > "$DEB/DEBIAN/postinst" <<'CTRL'
#!/bin/sh
# dsh-ios postinst
#  - sign the cross-compiled node-pty addons so AMFI will load them
#  - register them in the trust cache (RootHide: jbctl lives under $JBROOT/basebin)
P=/usr/local
REL="$P/lib/node_modules/node-pty/build/Release"
# /rootfs is rootHide's view of the real root; on a plain rootless jailbreak it
# does not exist, so fall back to the plain path.
LOG=/rootfs/var/mobile/.dsh/postinst.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || {
  LOG=/var/mobile/.dsh/postinst.log
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
}
log(){ echo "[dsh-ios postinst $(date +%H:%M:%S)] $*" >> "$LOG" 2>/dev/null; }

# rootHide keeps ldid/jbctl outside the default PATH, under the (randomly named)
# jbroot. `jbroot` with no argument prints that root, trailing slash included.
JB=""
if command -v jbroot >/dev/null 2>&1; then
  JB="$(jbroot 2>/dev/null)" || JB=""
fi
[ -n "$JB" ] || JB="${JBROOT:-}"
[ -n "$JB" ] || JB="/"
for d in basebin usr/bin usr/local/bin; do
  [ -d "${JB}$d" ] && PATH="${JB}$d:$PATH"
done
for d in /var/jb/basebin /var/jb/usr/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

if [ ! -f "$P/lib/fetch-shim.cjs" ]; then
  log "WARN: /usr/local/lib/fetch-shim.cjs missing - dsh will not start"
fi

if command -v ldid >/dev/null 2>&1; then
  for f in "$REL/pty.node" "$REL/spawn-helper"; do
    [ -f "$f" ] || continue
    ldid -M -S "$f" >>"$LOG" 2>&1 && log "signed $f OK (no added entitlements)" || { echo "ERROR: ldid -M -S $f FAILED" >&2; log "ERROR: ldid -M -S $f FAILED"; exit 1; }
  done
  chmod 755 "$REL/spawn-helper" >>"$LOG" 2>&1 || { log "ERROR: chmod spawn-helper failed"; exit 1; }
else
  echo "ERROR: ldid not found - node-pty addons left UNSIGNED" >&2
  log "ERROR: ldid not found"
  exit 1
fi

# trustcache: AMFI needs the addons registered or they SIGKILL on load.
if command -v jbctl >/dev/null 2>&1; then
  for f in "$REL/pty.node" "$REL/spawn-helper"; do
    [ -f "$f" ] || continue
    jbctl trustcache add "$f" >>"$LOG" 2>&1 && log "trustcache add $f OK" || log "WARN: jbctl trustcache add $f failed"
  done
else
  log "WARN: jbctl not found - trustcache registration skipped"
fi

echo "dsh-ios installed."
echo "  start:  dsh-ios"
echo "  (if that fails with a bad-interpreter error, run: sh /usr/local/bin/dsh-ios)"
echo "  then open http://127.0.0.1:3080 in Safari"
exit 0
CTRL
chmod 755 "$DEB/DEBIAN/postinst"

echo "== [6/6] 打包前自检 =="
fail=0
check(){ if [ -e "$1" ]; then echo "  ok   $2"; else echo "  MISS $2"; fail=1; fi; }
check "$DEB/usr/local/lib/fetch-shim.cjs" "fetch-shim.cjs"
check "$DEB/usr/local/bin/dsh-ios" "launcher dsh-ios"
check "$DEB/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" "dsh entry"
check "$DEB/usr/local/lib/node_modules/node-pty/build/Release/pty.node" "node-pty addon"
grep -q 'dsh-ios-polyfill' "$DEB/usr/local/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html" \
  && echo "  ok   web polyfill" || { echo "  MISS web polyfill"; fail=1; }
grep -q 'fetch-shim.cjs' "$DEB/usr/local/bin/dsh" \
  && echo "  ok   launcher requires fetch-shim" || { echo "  MISS launcher fetch-shim wiring"; fail=1; }
if [ "$fail" != "0" ]; then echo "打包自检失败"; exit 1; fi

dpkg-deb -b --root-owner-group -Zgzip "$DEB" "$ROOT/dist/dsh-ios_${DEB_VER}_${DEB_ARCH}.deb" >/dev/null
echo "✅ $ROOT/dist/dsh-ios_${DEB_VER}_${DEB_ARCH}.deb"