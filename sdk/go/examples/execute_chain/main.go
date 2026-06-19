// execute_chain demonstrates the full mint -> approve -> relay flow:
//
//  1. The minter mints a batch to the first owner (origin/plantation).
//  2. Each intermediate holder approves the relay once (setApprovalForAll).
//  3. The relay moves the batch down the chain of holders in ONE atomic tx.
//
// All txs are legacy / gasPrice 0 / chainId 131216, and every sender wallet must
// be pre-funded with >= 1 wei native HARA. Keys are read from hex env vars.
//
// Run (keys are 0x-less or 0x-prefixed 32-byte hex private keys):
//
//	MINTER_KEY=...      \
//	HOLDER0_KEY=...     \   # current owner of the batch after mint
//	HOLDER1_KEY=...     \   # intermediate custodian
//	go run ./examples/execute_chain
//
// HOLDER2 is the final custodian; it does not need to approve the relay (the
// relay only moves tokens FROM a holder, never the last one).
package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"log"
	"math/big"
	"os"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	hararegistry "github.com/imronzuhri-svg/hara-registry/sdk/go"
)

func mustKey(env string) *ecdsa.PrivateKey {
	v := os.Getenv(env)
	if v == "" {
		log.Fatalf("missing env %s", env)
	}
	k, err := crypto.HexToECDSA(strings0x(v))
	if err != nil {
		log.Fatalf("bad key in %s: %v", env, err)
	}
	return k
}

// strings0x strips an optional 0x prefix (crypto.HexToECDSA wants none).
func strings0x(s string) string {
	if len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X") {
		return s[2:]
	}
	return s
}

func addr(k *ecdsa.PrivateKey) common.Address { return crypto.PubkeyToAddress(k.PublicKey) }

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	minter := mustKey("MINTER_KEY")
	holder0 := mustKey("HOLDER0_KEY")
	holder1 := mustKey("HOLDER1_KEY")

	chain, err := hararegistry.NewChainClient(ctx)
	if err != nil {
		log.Fatalf("dial chain: %v", err)
	}
	defer chain.Close()

	palmOil := chain.PalmOil()
	relay := chain.Relay()

	// A fresh, unlikely-to-collide batch id for the demo.
	batchID := big.NewInt(time.Now().Unix())
	liters := big.NewInt(1000)

	// Holder chain: origin (holder0) -> intermediate (holder1) -> final (holder2).
	holder2 := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	holders := []common.Address{addr(holder0), addr(holder1), holder2}

	// 1. Mint to holder0 (the first owner / origin).
	var rspoHash, plantationID [32]byte
	copy(rspoHash[:], crypto.Keccak256([]byte("RSPO-CERT-DEMO")))
	copy(plantationID[:], crypto.Keccak256([]byte("PLANTATION-DEMO")))
	productionDate := uint64(time.Now().Unix())

	fmt.Println("minting batch", batchID)
	if _, err := palmOil.MintBatch(ctx, minter, batchID, addr(holder0), liters, rspoHash, plantationID, productionDate); err != nil {
		log.Fatalf("mintBatch: %v", err)
	}

	// 2. Every holder that the relay will move tokens FROM must approve it once.
	//    That is holder0 and holder1 (not holder2, the final custodian).
	fmt.Println("approving relay for holder0 and holder1")
	if _, err := palmOil.SetApprovalForAll(ctx, holder0, relay.Address(), true); err != nil {
		log.Fatalf("approve holder0: %v", err)
	}
	if _, err := palmOil.SetApprovalForAll(ctx, holder1, relay.Address(), true); err != nil {
		log.Fatalf("approve holder1: %v", err)
	}

	// 3. Relay the whole volume down the chain in one atomic tx. The initiator
	//    here is the minter (any funded account may call the relay).
	fmt.Println("executing custody chain via relay")
	rcpt, err := relay.ExecuteChain(ctx, minter, palmOil.Address(), batchID, liters, holders)
	if err != nil {
		log.Fatalf("executeChain: %v", err)
	}
	fmt.Printf("chain executed in block %d (tx %s)\n", rcpt.BlockNumber.Uint64(), rcpt.TxHash.Hex())

	// Verify the final custodian now holds the batch.
	bal, err := palmOil.BalanceOf(ctx, holder2, batchID)
	if err != nil {
		log.Fatalf("final balanceOf: %v", err)
	}
	fmt.Printf("final custodian %s holds %s litres of batch %s\n", holder2.Hex(), bal.String(), batchID.String())
}
