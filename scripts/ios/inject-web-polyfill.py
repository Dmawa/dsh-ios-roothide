#!/usr/bin/env python3
"""Inject the iOS 16.7 Safari polyfills into the bundled dsh web frontend.

The frontend bundle uses `AbortSignal.any()` (Safari 17.4+) and assumes a
fairly modern DOM. iOS 16.7 is the oldest target we claim to support, so the
page must be patched before it is shipped inside the .deb.

Usage: python3 inject-web-polyfill.py <node_modules-dir>

Idempotent: re-running is a no-op once the marker is present.
"""
import sys
import pathlib

MARKER = "/* dsh-ios-polyfill */"

POLYFILL = """<script>%(marker)s
(function () {
  var AS = window.AbortSignal;
  if (!AS) return;

  // AbortSignal.any() -- Safari 17.4+. Reason must propagate to the derived
  // signal (dsh relies on it to tell timeouts apart from user cancels).
  if (typeof AS.any !== "function") {
    AS.any = function (signals) {
      var controller = new AbortController();
      var cleanups = [];
      var done = false;

      function cleanup() {
        while (cleanups.length) {
          try { cleanups.pop()(); } catch (e) {}
        }
      }
      function abort(reason) {
        if (done) return;
        done = true;
        cleanup();
        controller.abort(reason);
      }

      var list;
      try { list = Array.from(signals); } catch (e) { throw new TypeError("AbortSignal.any: signals is not iterable"); }

      for (var i = 0; i < list.length; i++) {
        var sig = list[i];
        if (sig.aborted) { abort(sig.reason); break; }
        (function (s) {
          var onAbort = function () { abort(s.reason); };
          s.addEventListener("abort", onAbort, { once: true });
          cleanups.push(function () { s.removeEventListener("abort", onAbort); });
        })(sig);
      }
      return controller.signal;
    };
  }

  // AbortSignal.timeout() -- Safari 16.4+; keep a fallback for older builds.
  if (typeof AS.timeout !== "function") {
    AS.timeout = function (ms) {
      var controller = new AbortController();
      setTimeout(function () {
        var reason;
        try { reason = new DOMException("The operation timed out.", "TimeoutError"); }
        catch (e) { reason = new Error("The operation timed out."); reason.name = "TimeoutError"; }
        controller.abort(reason);
      }, ms);
      return controller.signal;
    };
  }
})();
</script>""" % {"marker": MARKER}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: inject-web-polyfill.py <node_modules-dir>", file=sys.stderr)
        return 2

    node_modules = pathlib.Path(sys.argv[1])
    html = node_modules / "@deepseek-ai" / "dsh-web-frontend" / "dist" / "index.html"
    if not html.is_file():
        print(f"ERROR: frontend entry not found: {html}", file=sys.stderr)
        return 1

    text = html.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"  polyfill already injected: {html}")
        return 0

    lower = text.lower()
    at = lower.find("<head>")
    if at == -1:
        print(f"ERROR: no <head> tag in {html}", file=sys.stderr)
        return 1

    cut = at + len("<head>")
    patched = text[:cut] + "\n" + POLYFILL + text[cut:]
    html.write_text(patched, encoding="utf-8")
    print(f"  polyfill injected: {html}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())