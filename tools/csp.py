#!/usr/bin/env python3
"""Write the security and privacy <meta> tags into every page of the site:
Content-Security-Policy, no-referrer, and robots noindex.

Inline <script> blocks are allowed by their SHA-256 hash, so any edit to an inline
script needs this to be re-run, or the browser will refuse to run it:

    python3 tools/csp.py          # update all pages
    python3 tools/csp.py --check  # exit 1 if any page is out of date (for CI)
"""
import base64
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ["index.html", "dashboard/index.html", "dashboard/security.html",
         "dashboard/apps/goals/index.html",
         "dashboard/apps/writing/index.html"]

META_RE = re.compile(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">\n?')
REF_RE = re.compile(r'<meta name="referrer" content="[^"]*">\n?')
ROBOTS_RE = re.compile(r'<meta name="robots" content="[^"]*">\n?')
# Every page asks search engines not to index, follow, cache or preview it.
ROBOTS = '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">\n'
CHARSET_RE = re.compile(r'<meta charset="utf-8">\n?', re.I)
INLINE_RE = re.compile(r"<script>(.*?)</script>", re.S)


def policy(html):
    hashes = ["'sha256-" + base64.b64encode(hashlib.sha256(m.encode("utf-8")).digest()).decode() + "'"
              for m in INLINE_RE.findall(html)]
    uses_scripts = bool(hashes) or "<script src=" in html
    script = "script-src " + (" ".join(["'self'"] + hashes) if uses_scripts else "'none'")
    connect = "connect-src 'self' https://api.github.com" if uses_scripts else "connect-src 'none'"
    return "; ".join([
        "default-src 'none'", script, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
        "font-src 'self'", connect, "base-uri 'none'", "form-action 'none'", "object-src 'none'",
        "frame-src 'none'", "worker-src 'none'", "manifest-src 'self'",
    ])


def apply(html):
    html = META_RE.sub("", html)
    html = REF_RE.sub("", html)
    html = ROBOTS_RE.sub("", html)
    m = CHARSET_RE.search(html)
    if not m:
        raise SystemExit("no <meta charset> found")
    tags = f'<meta http-equiv="Content-Security-Policy" content="{policy(html)}">\n<meta name="referrer" content="no-referrer">\n' + ROBOTS
    line = m.group(0) if m.group(0).endswith("\n") else m.group(0) + "\n"
    return html[: m.start()] + line + tags + html[m.end():]


def main():
    check = "--check" in sys.argv
    stale = []
    for p in PAGES:
        f = ROOT / p
        old = f.read_text(encoding="utf-8")
        new = apply(old)
        if new != old:
            stale.append(p)
            if not check:
                f.write_text(new, encoding="utf-8")
    if check and stale:
        print("CSP out of date:", ", ".join(stale))
        sys.exit(1)
    print(("checked " if check else "updated ") + f"{len(PAGES)} pages" + (f" ({len(stale)} changed)" if stale else ""))


if __name__ == "__main__":
    main()
