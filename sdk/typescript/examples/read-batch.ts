/**
 * Read batch traceability data from the REST API.
 *
 *   TRACE_USER=... TRACE_PASS=... npx tsx examples/read-batch.ts <batchId>
 *
 * trace.ledger.haratrust.io is HTTP-Basic gated — supply credentials.
 */
import { TraceClient } from "@hara/registry-sdk";

async function main() {
  const batchId = process.argv[2] ?? "1";

  const trace = new TraceClient({
    user: process.env.TRACE_USER,
    pass: process.env.TRACE_PASS,
  });

  console.log("Latest batches:");
  const batches = await trace.listBatches({ limit: 5 });
  for (const b of batches) {
    console.log(`  #${b.batch_id}  ${b.initial_liters} L  holder=${b.current_holder}  hops=${b.hop_count}`);
  }

  console.log(`\nBatch ${batchId}:`);
  const batch = await trace.getBatch(batchId);
  console.log(batch);

  console.log(`\nCustody hops for ${batchId}:`);
  const hops = await trace.getHops(batchId);
  for (const h of hops) {
    console.log(`  ${h.from_addr} -> ${h.to_addr}  ${h.liters} L  (${h.tx_hash})`);
  }

  console.log(`\nAggregated graph for ${batchId}:`);
  const graph = await trace.getGraph(batchId, { aggregate: true });
  console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
