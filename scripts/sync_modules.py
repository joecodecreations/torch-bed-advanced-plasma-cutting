#!/usr/bin/env python3
"""Keep the geometry modules in jog/tools/*.js and the copies pasted into jog/index.html in step.

The app is a single HTML file so it runs with nothing to install. The modules are developed and
tested as separate files, then pasted in between marker comments.

    python3 scripts/sync_modules.py          # paste the current modules into index.html
    python3 scripts/sync_modules.py --check  # exit 1 if index.html is out of date (used by CI)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "jog", "index.html")
MODULES = ["boolops.js", "slicer.js", "formats.js", "slicer2.js"]
BANNER = re.compile(r"^/\* =+ [^\n]*\(tools/(%s), pasted in\) =+ \*/\n" % "|".join(re.escape(m) for m in MODULES), re.M)
NEXT = re.compile(r"^/\* =+ ", re.M)


def main():
    with open(PAGE) as f:
        page = f.read()
    out, pos, seen = [], 0, []
    for m in BANNER.finditer(page):
        name = m.group(1)
        end = NEXT.search(page, m.end())
        if not end:
            sys.exit("no section after %s in index.html" % name)
        with open(os.path.join(ROOT, "jog", "tools", name)) as f:
            body = f.read().rstrip() + "\n"
        out.append(page[pos:m.end()] + body)
        pos = end.start()
        seen.append(name)
    out.append(page[pos:])
    missing = [m for m in MODULES if m not in seen]
    if missing:
        sys.exit("marker not found in index.html for: %s" % ", ".join(missing))
    new = "".join(out)
    if "--check" in sys.argv:
        if new != page:
            sys.exit("jog/index.html is out of date: run  python3 scripts/sync_modules.py")
        print("index.html matches jog/tools (%s)" % ", ".join(seen))
        return
    if new != page:
        with open(PAGE, "w") as f:
            f.write(new)
        print("updated index.html from: %s" % ", ".join(seen))
    else:
        print("index.html already up to date")


if __name__ == "__main__":
    main()
