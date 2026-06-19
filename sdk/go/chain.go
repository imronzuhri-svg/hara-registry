package hararegistry

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// ChainClient wraps go-ethereum ethclients for Hara Registry. Reads go to a
// cached read endpoint; writes go to the write endpoint. The two may be the
// same client when a caller supplies a single URL.
type ChainClient struct {
	read    *ethclient.Client
	write   *ethclient.Client
	chainID *big.Int
}

// NewChainClient dials the default public read and write endpoints.
func NewChainClient(ctx context.Context) (*ChainClient, error) {
	return NewChainClientWithEndpoints(ctx, EndpointRead, EndpointWrite)
}

// NewChainClientWithEndpoints dials explicit read and write endpoints. Pass the
// same URL for both to use a single node (e.g. a WG-mesh internal node).
func NewChainClientWithEndpoints(ctx context.Context, readURL, writeURL string) (*ChainClient, error) {
	read, err := ethclient.DialContext(ctx, readURL)
	if err != nil {
		return nil, fmt.Errorf("dial read endpoint %q: %w", readURL, err)
	}
	write := read
	if writeURL != readURL {
		write, err = ethclient.DialContext(ctx, writeURL)
		if err != nil {
			read.Close()
			return nil, fmt.Errorf("dial write endpoint %q: %w", writeURL, err)
		}
	}
	return &ChainClient{
		read:    read,
		write:   write,
		chainID: big.NewInt(ChainID),
	}, nil
}

// Read exposes the underlying read-side ethclient for advanced use.
func (c *ChainClient) Read() *ethclient.Client { return c.read }

// Write exposes the underlying write-side ethclient for advanced use.
func (c *ChainClient) Write() *ethclient.Client { return c.write }

// Close releases both underlying clients.
func (c *ChainClient) Close() {
	if c.write != nil && c.write != c.read {
		c.write.Close()
	}
	if c.read != nil {
		c.read.Close()
	}
}

// BlockNumber returns the current head block height (via the read endpoint).
func (c *ChainClient) BlockNumber(ctx context.Context) (uint64, error) {
	return c.read.BlockNumber(ctx)
}

// ChainID returns the chain id reported by the node. It should always be 131216.
func (c *ChainClient) ChainID(ctx context.Context) (*big.Int, error) {
	return c.read.ChainID(ctx)
}

// BalanceAt returns the native HARA balance of addr at the latest block.
func (c *ChainClient) BalanceAt(ctx context.Context, addr common.Address) (*big.Int, error) {
	return c.read.BalanceAt(ctx, addr, nil)
}

// EnsureFunded checks that addr holds >= 1 wei native HARA and returns an error
// if it does not. Besu silently drops txs from zero-balance senders even when
// gasPrice is 0, so a wallet MUST be pre-funded before its first tx. Callers
// should fund the address (ops faucet, or 1 wei from a funded account) on error.
func (c *ChainClient) EnsureFunded(ctx context.Context, addr common.Address) error {
	bal, err := c.BalanceAt(ctx, addr)
	if err != nil {
		return fmt.Errorf("balance check for %s: %w", addr.Hex(), err)
	}
	if bal.Sign() == 0 {
		return fmt.Errorf(
			"wallet %s has zero native HARA balance: Besu drops txs from zero-balance "+
				"senders even at gasPrice 0; pre-fund >= 1 wei before its first tx",
			addr.Hex(),
		)
	}
	return nil
}

// SendLegacyTxOpts configures a legacy (type-0) transaction. GasPrice is always
// forced to 0 and the chain id is always 131216 — those fields cannot be
// overridden because the chain rejects anything else.
type SendLegacyTxOpts struct {
	// Key signs the transaction. Required.
	Key *ecdsa.PrivateKey
	// To is the destination contract/account. Required (nil-to / contract
	// creation is not supported by this helper).
	To common.Address
	// Data is the ABI-encoded calldata. May be nil for a plain value transfer.
	Data []byte
	// Value is the native HARA value to send (wei). nil means 0.
	Value *big.Int
	// GasLimit caps execution gas. If 0, the gas is estimated via the node.
	GasLimit uint64
	// Nonce overrides the sender nonce. If nil, the pending nonce is fetched.
	Nonce *uint64
}

// SendLegacyTx builds, signs, and submits a legacy transaction following the
// chain's hard rules: type-0, gasPrice 0, chainId 131216. It returns the
// transaction hash. Use WaitReceipt to confirm execution status.
//
// The signer is EIP155Signer(131216), which is correct for legacy txs on this
// chain (London EVM, no type-2). The sender is verified funded first.
func (c *ChainClient) SendLegacyTx(ctx context.Context, opts SendLegacyTxOpts) (common.Hash, error) {
	if opts.Key == nil {
		return common.Hash{}, fmt.Errorf("SendLegacyTx: nil signing key")
	}
	from := crypto.PubkeyToAddress(opts.Key.PublicKey)

	if err := c.EnsureFunded(ctx, from); err != nil {
		return common.Hash{}, err
	}

	// Nonce.
	var nonce uint64
	if opts.Nonce != nil {
		nonce = *opts.Nonce
	} else {
		n, err := c.read.PendingNonceAt(ctx, from)
		if err != nil {
			return common.Hash{}, fmt.Errorf("pending nonce for %s: %w", from.Hex(), err)
		}
		nonce = n
	}

	value := opts.Value
	if value == nil {
		value = big.NewInt(0)
	}

	// Gas limit — estimate when not supplied.
	gasLimit := opts.GasLimit
	if gasLimit == 0 {
		est, err := c.read.EstimateGas(ctx, callMsg(from, opts.To, value, opts.Data))
		if err != nil {
			return common.Hash{}, fmt.Errorf("estimate gas: %w", err)
		}
		// Pad estimate by 25% to absorb state drift between estimate and mine.
		gasLimit = est + est/4
	}

	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		GasPrice: big.NewInt(GasPriceZero), // free chain — always 0
		Gas:      gasLimit,
		To:       &opts.To,
		Value:    value,
		Data:     opts.Data,
	})

	signer := types.NewEIP155Signer(c.chainID)
	signed, err := types.SignTx(tx, signer, opts.Key)
	if err != nil {
		return common.Hash{}, fmt.Errorf("sign tx: %w", err)
	}

	if err := c.write.SendTransaction(ctx, signed); err != nil {
		return common.Hash{}, fmt.Errorf("send raw tx: %w", err)
	}
	return signed.Hash(), nil
}

// WaitReceipt blocks until the transaction is mined and returns its receipt. It
// returns an error if the tx reverted (status != 1). The context controls the
// timeout; on cancellation the wait aborts.
func (c *ChainClient) WaitReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	rcpt, err := bind_WaitMined(ctx, c.read, hash)
	if err != nil {
		return nil, err
	}
	if rcpt.Status != types.ReceiptStatusSuccessful {
		return rcpt, fmt.Errorf("tx %s reverted (receipt.status=%d)", hash.Hex(), rcpt.Status)
	}
	return rcpt, nil
}

// SendAndWait is a convenience wrapper: SendLegacyTx then WaitReceipt.
func (c *ChainClient) SendAndWait(ctx context.Context, opts SendLegacyTxOpts) (*types.Receipt, error) {
	hash, err := c.SendLegacyTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return c.WaitReceipt(ctx, hash)
}
