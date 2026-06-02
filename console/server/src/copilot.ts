// Phase 4 — operator copilot. Answers plain-language questions grounded in the
// LIVE state (insights + sources). Read-only: it explains and recommends, and
// when an action is warranted it tells the operator what to do in the Operations
// tab (propose-only) — it never executes or claims to have changed anything.
//
// Requires COPILOT_API_KEY (Anthropic). Without it, /api/copilot returns 503.
import { fetchT } from "./rpc.js";
import { getInsights } from "./insights.js";
import { getChain, getValidators, getBackups, getVault } from "./sources.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM = `You are "Strata", the read-only operations copilot for the Hara Registry platform —
a permissioned Hyperledger Besu (QBFT) blockchain for palm-oil supply-chain traceability with
post-quantum anchoring. Components: 4 QBFT validators (need 3/4), a dedicated RPC tier (HAProxy +
rpc-write + 2 rpc-read) behind a load balancer, an indexer that feeds Postgres/Blockscout, HashiCorp
Vault (sealed after restart), nightly age-encrypted off-host backups, and a WireGuard mesh.

Rules:
- Answer concisely and in PLAIN LANGUAGE for an operator. Use short paragraphs or bullets.
- Base your answer ONLY on the LIVE STATE JSON provided. If the data needed isn't there, say so —
  do NOT invent numbers.
- You are READ-ONLY. You cannot run anything. When an action is warranted, tell the operator exactly
  what to do in the Console's "Operations" tab (which builds the command for them to run) or which
  screen to check. Never say you executed, fixed, or changed anything.
- Be honest about uncertainty and severity (is this urgent or just worth noting?).`;

export interface CopilotAnswer {
  answer: string;
  model: string;
}

export async function askCopilot(question: string, nowMs: number): Promise<CopilotAnswer> {
  const key = process.env.COPILOT_API_KEY;
  if (!key) throw new Error("copilot not configured — set COPILOT_API_KEY on the console API");
  const model = process.env.COPILOT_MODEL || "claude-3-5-haiku-latest";

  // Assemble a compact live-state context.
  const [insights, chain, validators, backups, vault] = await Promise.all([
    getInsights(nowMs).catch(() => null),
    getChain().catch(() => null),
    getValidators().catch(() => null),
    getBackups().catch(() => null),
    getVault().catch(() => null),
  ]);
  const state = {
    chain,
    validators: validators && { count: validators.count, head: validators.head, nodes: validators.validators.map((v) => ({ recentlyProposed: v.recentlyProposed, proposed: v.proposedBlockCount })) },
    vault,
    backups: backups?.hosts.flatMap((h) => h.timers.map((t) => ({ host: h.host, unit: t.unit, result: t.result, lastRun: t.lastRun }))),
    insights: insights && {
      recommendations: insights.recommendations,
      baselines: insights.baselines.map((b) => ({ label: b.label, current: b.current, status: b.status, z: b.z })),
      slo: insights.slo,
      cacheHitPct: insights.cacheHitPct,
      fairness: { verdict: insights.fairness.verdict, spreadPct: insights.fairness.spreadPct },
      capacity: insights.capacity,
    },
  };

  const body = {
    model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `LIVE STATE (JSON):\n${JSON.stringify(state)}\n\nOPERATOR QUESTION: ${question}`,
      },
    ],
  };

  const res = await fetchT(
    ANTHROPIC_URL,
    {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    30000
  );
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const answer = (j.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return { answer: answer || "(no answer)", model };
}
