#!/bin/sh
# build-node-ios.sh — cross-compile Node.js 22.23.2 for RootHide (arm64 Mach-O)
# and package the nodejs .deb (RootHide layout, darwin-style JIT path).
#
# Usage: ./scripts/build-node-ios.sh
# Output: dist/nodejs_22.23.2-1_iphoneos-arm64e.deb
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"
mkdir -p dist

NODE_VER=22.23.2
DEB_ARCH=iphoneos-arm64e
NODE_SRC="$ROOT/node-v$NODE_VER"
SHIM="$ROOT/ios-sdk-shim"

echo "== [0/6] 缓存命中检测 =="
if [ -f "$NODE_SRC/out/Release/node" ]; then
  echo "构建产物已缓存，增量编译..."
  cd "$NODE_SRC"
  SDK=$(xcrun --sdk iphoneos --show-sdk-path)
  export CC="/usr/bin/clang -target arm64-apple-ios16.0 -isysroot $SDK -miphoneos-version-min=16.0 -I$SHIM"
  export CXX="/usr/bin/clang++ -target arm64-apple-ios16.0 -isysroot $SDK -miphoneos-version-min=16.0 -stdlib=libc++ -std=gnu++20 -I$SHIM"
  export CC_host=/usr/bin/clang
  export CXX_host="/usr/bin/clang++ -std=gnu++20"
  ninja -C out/Release node
  echo "增量编译完成"
else
  echo "无缓存，走完整构建"
fi

echo "== [1/6] Node $NODE_VER 源码 =="
if [ ! -d "$NODE_SRC" ]; then
  curl -sL -o /tmp/node-src.tar.gz "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER.tar.gz"
  tar xzf /tmp/node-src.tar.gz -C "$ROOT"
fi

echo "== [2/6] 应用 iOS 补丁 =="
python3 "$SCRIPT_DIR/apply_patches.py" "$NODE_SRC"

# ccache 加速（存在则启用）
if command -v ccache >/dev/null 2>&1; then
  export CCACHE_CPP2=1 CCACHE_SLOPPINESS=time_macros CCACHE_BASEDIR="$ROOT" CCACHE_DIR="${CCACHE_DIR:-$ROOT/.ccache}"
  mkdir -p "$ROOT/ccache-bin"
  SDK_FOR_CC=$(xcrun --sdk iphoneos --show-sdk-path)
  cat > "$ROOT/ccache-bin/clang-ios" <<CCEOF
#!/bin/sh
exec ccache /usr/bin/clang -target arm64-apple-ios16.0 -isysroot "$SDK_FOR_CC" -miphoneos-version-min=16.0 -I$SHIM "\$@"
CCEOF
  cat > "$ROOT/ccache-bin/clang++-ios" <<CCEOF
#!/bin/sh
exec ccache /usr/bin/clang++ -target arm64-apple-ios16.0 -isysroot "$SDK_FOR_CC" -miphoneos-version-min=16.0 -stdlib=libc++ -std=gnu++20 -I$SHIM "\$@"
CCEOF
  chmod +x "$ROOT/ccache-bin/clang-ios" "$ROOT/ccache-bin/clang++-ios"
  export CC="$ROOT/ccache-bin/clang-ios" CXX="$ROOT/ccache-bin/clang++-ios"
  echo "ccache 已启用"
fi

echo "== [3/6] configure（darwin JIT 路径 + ninja）=="
cd "$NODE_SRC"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
export CC="/usr/bin/clang -target arm64-apple-ios16.0 -isysroot $SDK -miphoneos-version-min=16.0 -I$SHIM"
export CXX="/usr/bin/clang++ -target arm64-apple-ios16.0 -isysroot $SDK -miphoneos-version-min=16.0 -stdlib=libc++ -std=gnu++20 -I$SHIM"
export CC_host=/usr/bin/clang
export CXX_host="/usr/bin/clang++ -std=gnu++20"
# --with-intl=small-icu 不是可选项：dsh 的插件链在几百处使用 Unicode 属性转义
# (\p{L}, \p{XID_Start}, ...)，没有 ICU 数据时这些正则字面量会在模块求值阶段直接抛
# SyntaxError: Invalid regular expression —— 表现为「所有插件 failed to import」。
# 之前这里是 --with-intl=none，正是 12 个插件全红的根因。
./configure --dest-os=ios --dest-cpu=arm64 --with-intl=small-icu --prefix=/usr/local --openssl-no-asm --ninja

echo "== [4/6] ninja host 生成器去冲突（configure 后必做）=="
cd out/Release
node -e '
const fs = require("fs");
function patch(f) {
  const hostP = "obj.host/tools/v8_gypfiles/" + f;
  const targetP = "obj/tools/v8_gypfiles/" + f;
  if (!fs.existsSync(targetP)) return;
  const lines = fs.readFileSync(hostP, "utf8").split("\n");
  const stmts = []; let cur = null;
  for (const l of lines) { if (/^\S/.test(l)) { cur = [l]; stmts.push(cur); } else if (cur && l.trim()) cur.push(l); }
  const joined = (s) => s.map(l => l.trimEnd().replace(/\$$/, "")).join(" ").replace(/\s+/g, " ").trim();
  const out = []; let dropped = 0;
  for (const s of stmts) {
    const j = joined(s);
    if (j.startsWith("rule ")) { dropped++; continue; }
    if (j.startsWith("build ")) {
      const c = j.indexOf(":");
      const o = (c >= 0 ? j.slice(6, c) : "").trim();
      if (/^gen\//.test(o)) { dropped++; continue; }
    }
    out.push(...s);
  }
  if (dropped) { fs.writeFileSync(hostP, out.join("\n") + "\n"); console.log("  patched:", f, "删除:", dropped); }
}
for (const f of fs.readdirSync("obj.host/tools/v8_gypfiles")) { if (f.endsWith(".ninja")) patch(f); }
'

echo "== [5/6] ninja 构建 =="
cd "$NODE_SRC"
ninja -C out/Release node

echo "== [6/6] 打包 nodejs deb =="
rm -rf /tmp/node-ios-staging /tmp/nodejs-deb
make install DESTDIR=/tmp/node-ios-staging >/dev/null
rm -rf /tmp/node-ios-staging/usr/local/include /tmp/node-ios-staging/usr/local/share/man
mkdir -p /tmp/nodejs-deb/DEBIAN /tmp/nodejs-deb/usr/local/lib/nodejs
cp -a /tmp/node-ios-staging/usr/local/. /tmp/nodejs-deb/usr/local/
cp "$SCRIPT_DIR/node-jit-entitlements.plist" /tmp/nodejs-deb/usr/local/lib/nodejs/entitlements.plist
cat > /tmp/nodejs-deb/DEBIAN/control <<'CTRL'
Package: nodejs
Name: Node.js (RootHide iOS)
Version: 22.23.2-1
Architecture: iphoneos-arm64e
Maintainer: dsh-ios port
Section: Development
Description: Node.js 22.23.2 for RootHide on jailbroken iOS. Uses the RootHide package layout and Darwin-style V8 JIT path. Bundles npm, npx, corepack.
CTRL
cat > /tmp/nodejs-deb/DEBIAN/postinst <<'CTRL'
#!/bin/sh
P=/usr/local
# /rootfs is rootHide's view of the real root; on a plain rootless jailbreak it
# does not exist, so fall back to the plain path.
LOG=/rootfs/var/mobile/.dsh/postinst.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || {
  LOG=/var/mobile/.dsh/postinst.log
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
}
log(){ echo "[nodejs postinst $(date +%H:%M:%S)] $*" >> "$LOG" 2>/dev/null; }

# rootHide keeps ldid/jbctl outside the default PATH, under the (randomly named)
# jbroot. Without this the postinst aborts and the user is left re-signing node
# by hand - which is exactly the manual step we are trying to remove.
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

chmod 755 "$P/bin/node" >>"$LOG" 2>&1 || { log "ERROR: chmod node failed"; exit 1; }
if command -v ldid >/dev/null 2>&1; then
  if ldid -M -S"$P/lib/nodejs/entitlements.plist" "$P/bin/node" >>"$LOG" 2>&1; then
    echo "node signed (JIT entitlements)"
    log "node signed OK"
  else
    echo "ERROR: node signing FAILED - binary left UNSIGNED, will SIGKILL on V8 JIT" >&2
    log "ERROR: ldid -M -S node FAILED (see above)"
    exit 1
  fi
else
  echo "ERROR: ldid not found - node left UNSIGNED, will SIGKILL on V8 JIT" >&2
  log "ERROR: ldid not found in PATH"
  exit 1
fi
# Register the executable in the active jailbreak trustcache when jbctl is available.
if command -v jbctl >/dev/null 2>&1; then
  jbctl trustcache add "$P/bin/node" >>"$LOG" 2>&1 && log "trustcache add node OK" || log "WARN: jbctl trustcache add node failed"
else
  log "WARN: jbctl not found - trustcache registration skipped (SIGKILL risk remains)"
fi
exit 0
CTRL
chmod 755 /tmp/nodejs-deb/DEBIAN/postinst
dpkg-deb -b --root-owner-group -Zgzip /tmp/nodejs-deb "$ROOT/dist/nodejs_22.23.2-1_${DEB_ARCH}.deb" >/dev/null
echo "✅ $ROOT/dist/nodejs_22.23.2-1_${DEB_ARCH}.deb"
