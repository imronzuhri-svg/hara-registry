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

async function listTimers() {
  const { stdout } = await exec("systemctl", [
    "list-timers",
    "--all",
    "--output=json",
    TIMER_GLOB,
  ]);
  const raw = JSON.parse(stdout);
  const out = [];
  for (const t of raw) {
    let result = null;
    let exitStatus = null;
    let durationSec = null;
    let activeState = null;
    if (t.activates) {
      try {
        const { stdout: shown } = await exec("systemctl", [
          "show",
          t.activates,
          "--property=Result,ExecMainStatus,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic,ActiveState",
          "--value",
        ]);
        const [r, ex, startMono, exitMono, active] = shown.split(/\r?\n/);
        result = (r || "").trim() || null;
        exitStatus = (ex || "").trim() || null;
        activeState = (active || "").trim() || null;
        // Monotonic timestamps are µs since boot; a run's duration is exit-start
        // (avoids wall-clock/TZ parsing). Both 0 until the service has run once.
        const s = Number(startMono),
          e = Number(exitMono);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s && s > 0) durationSec = Math.round((e - s) / 1e6);
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
      lastRun: usecToIso(t.last),
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
      const timers = await listTimers();
      return send(res, 200, { host: os.hostname(), generatedAt: new Date().toISOString(), timers });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`backups-status agent listening on ${BIND}:${PORT} (host ${os.hostname()})`);
});
