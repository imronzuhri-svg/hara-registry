import Fastify from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const exec = promisify(execFile);

const PORT = Number(process.env.AGENT_PORT ?? 8911);
const BIND = process.env.AGENT_BIND ?? "0.0.0.0";
// systemd unit glob this agent reports on.
const TIMER_GLOB = process.env.AGENT_TIMER_GLOB ?? "hara-*-snapshot.timer";

interface TimerStatus {
  unit: string;
  service: string | null;
  nextRun: string | null;
  lastRun: string | null;
  result: string | null; // systemd Result: "success" | "exit-code" | ...
  exitStatus: string | null;
}

/** systemd list-timers emits microseconds-since-epoch (or null). */
const usecToIso = (v: number | null): string | null =>
  v && v > 0 ? new Date(v / 1000).toISOString() : null;

async function listTimers(): Promise<TimerStatus[]> {
  const { stdout } = await exec("systemctl", [
    "list-timers",
    "--all",
    "--output=json",
    TIMER_GLOB,
  ]);
  const raw = JSON.parse(stdout) as Array<{
    unit: string;
    activates: string | null;
    next: number | null;
    last: number | null;
  }>;

  return Promise.all(
    raw.map(async (t) => {
      let result: string | null = null;
      let exitStatus: string | null = null;
      if (t.activates) {
        try {
          const { stdout: shown } = await exec("systemctl", [
            "show",
            t.activates,
            "--property=Result,ExecMainStatus",
            "--value",
          ]);
          const [r, ex] = shown.split(/\r?\n/);
          result = r?.trim() || null;
          exitStatus = ex?.trim() || null;
        } catch {
          /* service not loaded yet — leave null */
        }
      }
      return {
        unit: t.unit,
        service: t.activates,
        nextRun: usecToIso(t.next),
        lastRun: usecToIso(t.last),
        result,
        exitStatus,
      };
    })
  );
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.get("/healthz", async () => ({ ok: true, host: os.hostname() }));

app.get("/backups", async () => {
  const timers = await listTimers();
  return { host: os.hostname(), generatedAt: new Date().toISOString(), timers };
});

app
  .listen({ port: PORT, host: BIND })
  .then((addr) => app.log.info(`backups-status agent listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
