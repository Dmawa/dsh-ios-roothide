#!/usr/bin/env python3
"""Inject the iOS Safari polyfill bundle into the bundled dsh web frontend.

The frontend bundles use `AbortSignal.any()` (Safari 17.4+), `Iterator` helpers
(Safari 18.4+) and friends. iOS 16/17 is the oldest target we claim to support,
so the page must be patched before it is shipped inside the .deb.

The payload lives in scripts/ios/web-polyfill.js next to this file, so it can be
linted and reviewed as ordinary JavaScript.

Usage: python3 inject-web-polyfill.py <node_modules-dir>

Idempotent: re-running is a no-op once the marker is present.
"""
import pathlib
import sys

MARKER = "/* dsh-ios-polyfill */"
HERE = pathlib.Path(__file__).resolve().parent
PAYLOAD = HERE / "web-polyfill.js"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: inject-web-polyfill.py <node_modules-dir>", file=sys.stderr)
        return 2

    if not PAYLOAD.is_file():
        print(f"ERROR: polyfill payload not found: {PAYLOAD}", file=sys.stderr)
        return 1
    body = PAYLOAD.read_text(encoding="utf-8")

    node_modules = pathlib.Path(sys.argv[1])
    html = node_modules / "@deepseek-ai" / "dsh-web-frontend" / "dist" / "index.html"
    if not html.is_file():
        print(f"ERROR: frontend entry not found: {html}", file=sys.stderr)
        return 1

    text = html.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"  polyfill already injected: {html}")
        return 0

    at = text.lower().find("<head>")
    if at == -1:
        print(f"ERROR: no <head> tag in {html}", file=sys.stderr)
        return 1

    script = f"<script>{MARKER}\n{body}</script>"
    cut = at + len("<head>")
    html.write_text(text[:cut] + "\n" + script + text[cut:], encoding="utf-8")
    print(f"  polyfill injected ({len(body)} bytes): {html}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())