// Strata Console — backups-status agent (dependency-free).
// Reports THIS host's hara-*-snapshot systemd timer status, read-only, over a
// tiny node:http server. No npm deps so it runs on the distro Node on any host
// (incl. validators) with no install step. The Console API aggregates each host
// via BACKUPS_AGENT_URLS.
import http from "node:http";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PORT = Number(process.env.AGENT_PORT ?? 8911);
const BIND = process.env.AGENT_BIND ?? "0.0.0.0";
const TIMER_GLOB = process.env.AGENT_TIMER_GLOB ?? "hara-*-snapshot.timer";

// Where each snapshot service drops its newest local artifact. Used to report
// backup SIZE + on-disk freshness (a proxy for "did it actually produce output").
// Missing dirs are simply skipped — a validator host only has the validator dir.
const ARTIFACT_DIRS = {
  "hara-postgres-snapshot": "/var/backups/hara/postgres",
  "hara-postgres-basebackup-snapshot": "/var/backups/hara/postgres-base",
  "hara-redis-snapshot": "/var/backups/hara/redis",
  "hara-minio-snapshot": "/var/backups/hara/minio",
  "hara-validator-snapshot": "/var/backups/hara",
};

// systemd list-timers emits microseconds-since-epoch (or null/0).
const usecToIso = (v) => (v && v > 0 ? new Date(v / 1000).toISOString() : null);

const DRILL_DIR = process.env.AGENT_DRILL_DIR ?? "/var/backups/hara/drills";

// Recovery-drill results written by *-restore-drill.sh (one JSON per drill).
// Surfaced under the console's Recovery panel as "recovery is periodically tested".
async function readDrills() {
  try {
    const names = await fs.readdir(DRILL_DIR);
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(DRILL_DIR, name), "utf8");
        const j = JSON.parse(raw);
        if (j && j.drill) out.push({ drill: j.drill, status: j.status ?? null, at: j.at ?? null, durationSec: j.durationSec ?? null });
      } catch {
        /* skip unreadable/partial file */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Newest regular file in a backup dir → {bytes, mtime}. Best-effort, dep-free.
async function newestArtifact(dir) {
  try {
    const names = await fs.readdir(dir);
    let best = null;
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { bytes: st.size, mtimeMs: st.mtimeMs };
    }
    return best ? { bytes: best.bytes, mtime: new Date(best.mtimeMs).toISOString() } : null;
  } catch {
    return null;
  }
}

// systemd monotonic timestamps are µs-since-boot (CLOCK_MONOTONIC) — the same
// clock Node's process.hrtime() reads. Convert one to a wall-clock ISO string
// by anchoring against "now" in both clocks (TZ-independent; no parsing of
// systemd's locale/abbrev timestamp strings like "Wed … WIB").
function makeMonoToIso() {
  const monoNowUs = Number(process.hrtime.bigint() / 1000n);
  const realNowMs = Date.now();
  return (monoStr) => {
    const m = Number(monoStr);
    if (!Number.isFinite(m) || m <= 0) return null;
    return new Date(realNowMs - (monoNowUs - m) / 1000).toISOString();
  };
}

async function listTimers() {
  const { stdout } = await exec("systemctl", [
    "list-timers",
    "--all",
    "--output=json",
    TIMER_GLOB,
  ]);
  const raw = JSON.parse(stdout);
  const monoToIso = makeMonoToIso();
  const out = [];
  for (const t of raw) {
    let result = null;
    let exitStatus = null;
    let durationSec = null;
    let activeState = null;
    let serviceLastRun = null;
    if (t.activates) {
      try {
        // NOTE: `systemctl show --value` does NOT preserve the requested order
        // (it uses systemd's internal property order), so parse KEY=value pairs
        // into a map instead of relying on line position. (Bug fixed 2026-06-03.)
        const { stdout: shown } = await exec("systemctl", [
          "show",
          t.activates,
          "--property=Result,ExecMainStatus,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic,ActiveState",
        ]);
        const props = {};
        for (const line of shown.split(/\r?\n/)) {
          const i = line.indexOf("=");
          if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
        }
        result = (props.Result || "").trim() || null;
        exitStatus = (props.ExecMainStatus || "").trim() || null;
        activeState = (props.ActiveState || "").trim() || null;
        const s = Number(props.ExecMainStartTimestampMonotonic),
          e = Number(props.ExecMainExitTimestampMonotonic);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s && s > 0) durationSec = Math.round((e - s) / 1e6);
        // The service's own last-exit wall-clock — used as the lastRun fallback
        // when the TIMER hasn't auto-fired yet (e.g. a manual `systemctl start`
        // or before the first scheduled run), so a backup that DID run isn't
        // shown as "never".
        serviceLastRun = monoToIso(props.ExecMainExitTimestampMonotonic);
      } catch {
        /* service not loaded yet */
      }
    }
    const base = t.unit.replace(/\.timer$/, "");
    const artifact = ARTIFACT_DIRS[base] ? await newestArtifact(ARTIFACT_DIRS[base]) : null;
    out.push({
      unit: t.unit,
      service: t.activates ?? null,
      nextRun: usecToIso(t.next),
      // Prefer the most recent of the timer's last trigger and the service's
      // last actual execution (covers manual runs / pre-first-fire).
      lastRun: usecToIso(t.last) ?? serviceLastRun,
      result,
      exitStatus,
      durationSec,
      activeState,
      artifactBytes: artifact ? artifact.bytes : null,
      artifactAt: artifact ? artifact.mtime : null,
    });
  }
  return out;
}

const send = (res, code, body) => {
  const json = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") return send(res, 200, { ok: true, host: os.hostname() });
    if (req.url === "/backups") {
      const [timers, drills] = await Promise.all([listTimers(), readDrills()]);
      return send(res, 200, { host: os.hostname(), generatedAt: new Date().toISOString(), timers, drills });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`backups-status agent listening on ${BIND}:${PORT} (host ${os.hostname()})`);
});
