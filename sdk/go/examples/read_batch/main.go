// read_batch fetches a batch summary + custody hops from the trace API and the
// live block height from the chain.
//
// Run:
//
//	TRACE_USER=... TRACE_PASS=... go run ./examples/read_batch <batchId>
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	hararegistry "github.com/imronzuhri-svg/hara-registry/sdk/go"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatalf("usage: read_batch <batchId>")
	}
	batchID := os.Args[1]

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Chain height (no auth, read endpoint).
	chain, err := hararegistry.NewChainClient(ctx)
	if err != nil {
		log.Fatalf("dial chain: %v", err)
	}
	defer chain.Close()

	height, err := chain.BlockNumber(ctx)
	if err != nil {
		log.Fatalf("block number: %v", err)
	}
	fmt.Printf("chain head: %d\n", height)

	// Trace API (HTTP Basic auth).
	trace := hararegistry.NewTraceClient(
		hararegistry.WithBasicAuth(os.Getenv("TRACE_USER"), os.Getenv("TRACE_PASS")),
	)

	batch, err := trace.GetBatch(ctx, batchID)
	if err != nil {
		log.Fatalf("get batch: %v", err)
	}
	fmt.Printf("batch %s: %s litres, origin %s, now held by %s, %s hops\n",
		batch.BatchID, batch.InitialLiters, batch.FirstOwner, batch.CurrentHolder, batch.HopCount)

	hops, err := trace.GetHops(ctx, batchID)
	if err != nil {
		log.Fatalf("get hops: %v", err)
	}
	for i, h := range hops {
		fmt.Printf("  hop %d: %s -> %s  %s L  (block %s, tx %s)\n",
			i, h.FromAddr, h.ToAddr, h.Liters, h.BlockNumber, h.TxHash)
	}
}
