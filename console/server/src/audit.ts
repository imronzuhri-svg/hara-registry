// Append-only audit log for proposed privileged actions. Propose-only means we
// record the intent + the exact command emitted; execution happens off-console.
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const AUDIT_PATH = process.env.AUDIT_PATH ?? "/data/audit.jsonl";

export interface AuditEntry {
  ts: string;
  actor: string;
  kind: string;
  summary: string;
  risk: string;
  params: Record<string, unknown>;
  commands: string[];
}

export async function recordProposal(entry: AuditEntry): Promise<void> {
  try {
    await mkdir(dirname(AUDIT_PATH), { recursive: true });
  } catch {
    /* dir exists */
  }
  await appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export async function readAudit(limit = 100): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await readFile(AUDIT_PATH, "utf8");
  } catch {
    return []; // no log yet
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-limit)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l) as AuditEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEntry => e !== null);
}
