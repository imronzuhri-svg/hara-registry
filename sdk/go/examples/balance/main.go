// balance reads an on-chain ERC-1155 balance (litres of a batch held by an
// address) directly from HaraPalmOil via eth_call — no auth, no key needed.
//
// Run:
//
//	go run ./examples/balance <account-address> <batchId>
package main

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"os"
	"time"

	"github.com/ethereum/go-ethereum/common"
	hararegistry "github.com/imronzuhri-svg/hara-registry/sdk/go"
)

func main() {
	if len(os.Args) < 3 {
		log.Fatalf("usage: balance <account-address> <batchId>")
	}
	account := common.HexToAddress(os.Args[1])
	batchID, ok := new(big.Int).SetString(os.Args[2], 10)
	if !ok {
		log.Fatalf("invalid batchId: %q", os.Args[2])
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	chain, err := hararegistry.NewChainClient(ctx)
	if err != nil {
		log.Fatalf("dial chain: %v", err)
	}
	defer chain.Close()

	bal, err := chain.PalmOil().BalanceOf(ctx, account, batchID)
	if err != nil {
		log.Fatalf("balanceOf: %v", err)
	}
	fmt.Printf("%s holds %s litres of batch %s\n", account.Hex(), bal.String(), batchID.String())
}
