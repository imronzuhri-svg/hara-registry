// Alertmanager silence CRUD (the "acknowledge / ignore" primitive). Silencing
// mutes a notification for a window; it's reversible and scoped to the
// monitoring plane (no chain/keys). Prometheus alerts themselves auto-resolve
// when their condition clears — there is no manual "mark solved".
import { config } from "./config.js";
import { fetchT } from "./rpc.js";

export interface Silence {
  id: string;
  alertname: string;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
  state: string;
}

export async function createSilence(p: { alertname: string; hours: number; createdBy: string; comment: string }): Promise<{ silenceID: string }> {
  const hours = Math.max(0.25, Math.min(720, p.hours));
  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const body = {
    matchers: [{ name: "alertname", value: p.alertname, isRegex: false, isEqual: true }],
    startsAt,
    endsAt,
    createdBy: p.createdBy || "strata-console",
    comment: p.comment || `silenced via console for ${hours}h`,
  };
  const res = await fetchT(`${config.alertmanagerUrl}/api/v2/silences`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Alertmanager HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as { silenceID: string };
}

export async function listSilences(): Promise<Silence[]> {
  const res = await fetchT(`${config.alertmanagerUrl}/api/v2/silences`);
  if (!res.ok) throw new Error(`Alertmanager HTTP ${res.status}`);
  const arr = (await res.json()) as Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    createdBy: string;
    comment: string;
    status: { state: string };
    matchers: { name: string; value: string }[];
  }>;
  return arr
    .filter((s) => s.status?.state !== "expired")
    .map((s) => ({
      id: s.id,
      alertname: s.matchers.find((m) => m.name === "alertname")?.value ?? "(any)",
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      createdBy: s.createdBy,
      comment: s.comment,
      state: s.status?.state ?? "unknown",
    }));
}

export async function deleteSilence(id: string): Promise<void> {
  const res = await fetchT(`${config.alertmanagerUrl}/api/v2/silence/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Alertmanager HTTP ${res.status}`);
}
