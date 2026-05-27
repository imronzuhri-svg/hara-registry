#!/usr/bin/env bash
# RPC node entrypoint — non-validator, exposes JSON-RPC + WebSocket.
# Tuned for high parallel read capacity (palm-oil traceability fan-out queries).

set -euo pipefail

DATA_DIR=/opt/besu/data
GENESIS=/opt/besu/genesis/genesis.json
STATIC_NODES=/shared/static-nodes.json

mkdir -p "${DATA_DIR}"

# JVM heap tuning — RPC nodes serve lots of concurrent eth_getLogs / debug_traceCall
# which benefit from a roomy heap. Defaults are too conservative on multi-GB hosts.
# Use 60% of container memory limit (Besu's recommendation).
#
# 2026-05-27: raised heap 4g→6g and added Vert.x workerPoolSize=64 (default 20)
# after stress-testing exposed RPC HTTP listener deadlock under sustained batched load
# (see memory: rpc-node-hang-bug). The default worker pool exhausted when many heavy
# batched eth_sendRawTransaction / getTransactionReceipt calls ran concurrently and
# the JSON-RPC handler stopped accepting connections without recovering.
export BESU_OPTS="${BESU_OPTS:--Xmx6g -Xms4g -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -Dvertx.options.workerPoolSize=64}"

BOOTNODES=$(grep -oE 'enode://[^\"]+' "${STATIC_NODES}" | paste -sd,)
echo "▶ Bootnodes: ${BOOTNODES}"
echo "▶ JVM heap:  ${BESU_OPTS}"

exec besu \
  --data-path="${DATA_DIR}" \
  --genesis-file="${GENESIS}" \
  --p2p-host=0.0.0.0 \
  --p2p-port=30303 \
  --discovery-enabled=true \
  --bootnodes="${BOOTNODES}" \
  --rpc-http-enabled=true \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=8545 \
  --rpc-http-max-active-connections=4000 \
  --rpc-http-max-batch-size=200 \
  --rpc-http-cors-origins="*" \
  --rpc-http-api=ETH,NET,WEB3,QBFT,DEBUG,TRACE,TXPOOL \
  --rpc-http-authentication-enabled=false \
  --rpc-ws-enabled=true \
  --rpc-ws-host=0.0.0.0 \
  --rpc-ws-port=8546 \
  --rpc-ws-api=ETH,NET,WEB3,QBFT \
  --rpc-ws-max-active-connections=2000 \
  --rpc-ws-max-frame-size=2097152 \
  --host-allowlist="*" \
  --metrics-enabled=true \
  --metrics-host=0.0.0.0 \
  --metrics-port=9545 \
  --min-gas-price=0 \
  --remote-connections-limit-enabled=false \
  --logging=INFO
