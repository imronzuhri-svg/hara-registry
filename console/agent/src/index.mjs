// Strata Console — backups-status agent (dependency-free).
// Reports THIS host's hara-*-snapshot systemd timer status, read-only, over a
// tiny node:http server. No npm deps so it runs on the distro Node on any host
// (incl. validators) with no install step. The Console API aggregates each host
// via BACKUPS_AGENT_URLS.
import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PORT = Number(process.env.AGENT_PORT ?? 8911);
const BIND = process.env.AGENT_BIND ?? "0.0.0.0";
const TIMER_GLOB = process.env.AGENT_TIMER_GLOB ?? "hara-*-snapshot.timer";

// systemd list-timers emits microseconds-since-epoch (or null/0).
const usecToIso = (v) => (v && v > 0 ? new Date(v / 1000).toISOString() : null);

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
    if (t.activates) {
      try {
        const { stdout: shown } = await exec("systemctl", [
          "show",
          t.activates,
          "--property=Result,ExecMainStatus",
          "--value",
        ]);
        const [r, ex] = shown.split(/\r?\n/);
        result = (r || "").trim() || null;
        exitStatus = (ex || "").trim() || null;
      } catch {
        /* service not loaded yet */
      }
    }
    out.push({
      unit: t.unit,
      service: t.activates ?? null,
      nextRun: usecToIso(t.next),
      lastRun: usecToIso(t.last),
      result,
      exitStatus,
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
