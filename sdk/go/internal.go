package hararegistry

import (
	"context"
	"errors"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

// callMsg builds an ethereum.CallMsg for gas estimation and eth_call.
func callMsg(from, to common.Address, value *big.Int, data []byte) ethereum.CallMsg {
	return ethereum.CallMsg{
		From:  from,
		To:    &to,
		Value: value,
		Data:  data,
	}
}

// bind_WaitMined polls for the receipt of hash until it is available or ctx is
// done. It mirrors go-ethereum's bind.WaitMined but takes a bare ethclient so
// the SDK does not pull in the abigen bind runtime.
func bind_WaitMined(ctx context.Context, c *ethclient.Client, hash common.Hash) (*types.Receipt, error) {
	// ~2 second block time; poll a little faster than that.
	ticker := time.NewTicker(750 * time.Millisecond)
	defer ticker.Stop()

	for {
		rcpt, err := c.TransactionReceipt(ctx, hash)
		if err == nil && rcpt != nil {
			return rcpt, nil
		}
		if err != nil && !errors.Is(err, ethereum.NotFound) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
