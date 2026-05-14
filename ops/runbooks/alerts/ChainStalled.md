# ChainStalled

**Severity**: critical
**Tier**: chain
**Page on-call?** Yes — immediately.

## What this means

A validator reports no new blocks for 1 minute. QBFT requires a supermajority (3-of-4 in dev, ⌈2N/3⌉ in general) to produce blocks. If consensus has halted, no transactions confirm; the whole product layer freezes.

## First diagnostic steps

```bash
# 1. Which validator(s) are reporting stall?
curl -s http://localhost:9090/api/v1/alerts | python -m json.tool | \
  grep -A1 ChainStalled

# 2. Are the other validators producing blocks?
for v in validator1 validator2 validator3 validator4; do
  echo -n "$v: "
  docker exec hara-$v curl -s http://localhost:9545/metrics 2>/dev/null | \
    grep ^besu_blockchain_chain_head_block_number | head -1
done

# 3. Is the alert isolated to one node or all of them?
```

## Common causes

| Cause | Action |
|---|---|
| One validator container crashed | `docker logs hara-validator<N>`; if it's restart-looping, fix the underlying issue (Vault unreachable? key fetch failing?) and restart |
| Network partition between two halves | Check Docker network connectivity; both sides will believe they're correct — fall back to which side has higher block height |
| Multiple validators wedged on QBFT round | Restart the wedged node — QBFT will reach consensus once 3-of-4 are responsive |
| Disk full on a validator | `docker exec hara-validator<N> df -h /opt/besu/data`; clear chain data and resync from peers if necessary |
| Clock drift > QBFT request timeout | Sync host clocks (NTP); restart |

## Mitigation

If 3 validators are healthy and only 1 is wedged:

```bash
docker restart hara-validator<N>
```

The healthy 3 will keep producing blocks at degraded confirmation latency; the restarted validator will catch up.

If 2+ validators are wedged (network is below QBFT quorum):

```bash
# Force-restart all validators in sequence
for v in 1 2 3 4; do
  docker restart hara-validator$v
  sleep 5
done
```

This is a destructive operation in production — page tier-2.

## Root cause investigation

After mitigation, capture:

1. The 5 minutes of logs from each validator around the stall window:
   ```bash
   docker logs --since 10m hara-validator1 > /tmp/v1.log
   ...
   ```
2. The `besu_blockchain_chain_head_block_number` and `besu_peers_peer_count` time series from Prometheus.
3. The output of `curl http://localhost:8545/rpc/read -d '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' -H "Content-Type: application/json"` — verifies the active validator set matches the genesis.

## Escalation

Page tier-2 if:
- Stall persists > 5 minutes after one validator restart
- More than one validator is in a restart loop
- HSM/Vault is unreachable (signing keys cannot be loaded)
- Disk failure on any validator host

## Post-incident

- Did our alerts give enough notice? Should the `for: 30s` window be tighter?
- Was the runbook accurate? Update it with what actually worked.
- Was monitoring sufficient to root-cause? If not, what metric was missing?
