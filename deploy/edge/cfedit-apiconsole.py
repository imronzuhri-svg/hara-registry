#!/usr/bin/env python3
# One-shot, idempotent insert of the API-console handles into the explorer site
# of the ON-HOST Caddyfile. Preserves the file inode (open 'w' truncates in place)
# and every existing bcrypt hash; reuses the trace site's hash for /capi/trace.
import re, sys
p = "/opt/hara/hara-ledger/deploy/edge/Caddyfile"
s = open(p, encoding="utf-8").read()
if "/api-console/*" in s:
    print("already inserted; no change"); sys.exit(0)
m = re.search(r"trace\.ledger\.haratrust\.io\s*\{.*?basic_auth\s*\{\s*hara\s+(\S+)", s, re.S)
if not m:
    print("ERROR: could not find trace basic_auth hash"); sys.exit(2)
h = m.group(1)
block = (
    "    # ── Developer API Console (static SPA, repo: api-console/) ──\n"
    "    # Served same-origin so the console's browser fetches hit the /capi/*\n"
    "    # proxies below with zero CORS. Reach it at /api-console/ .\n"
    "    handle_path /api-console/* {\n"
    "        root * /srv/trace/api-console\n"
    "        file_server\n"
    "    }\n"
    "    handle /capi/read/* {\n"
    "        uri strip_prefix /capi/read\n"
    "        reverse_proxy http://hara-rpc-cache:8080\n"
    "    }\n"
    "    handle /capi/write/* {\n"
    "        uri strip_prefix /capi/write\n"
    "        reverse_proxy http://10.43.0.21:8545\n"
    "    }\n"
    "    handle /capi/trace/* {\n"
    "        basic_auth {\n"
    "            hara " + h + "\n"
    "        }\n"
    "        uri strip_prefix /capi/trace\n"
    "        reverse_proxy http://hara-indexer:9100\n"
    "    }\n\n"
)
em = re.search(r"explorer\.ledger\.haratrust\.io\s*\{", s)
if not em:
    print("ERROR: explorer site not found"); sys.exit(3)
idx = s.find("# Everything else", em.end())
if idx < 0:
    print("ERROR: explorer catch-all marker not found"); sys.exit(4)
line_start = s.rfind("\n", 0, idx) + 1   # start of the indented marker line
s = s[:line_start] + block + s[line_start:]
open(p, "w", encoding="utf-8").write(s)
print("inserted API-console handles into explorer site (trace hash len %d)" % len(h))
