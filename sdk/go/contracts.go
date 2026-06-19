package hararegistry

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// ----------------------------------------------------------------------------
// Minimal inline ABIs. Only the methods this SDK uses are included. Each must
// match the deployed selector exactly (see hara-registry-facts.md and the
// Solidity sources in contracts/src/).
// ----------------------------------------------------------------------------

const haraPalmOilABI = `[
  {"type":"function","name":"balanceOf","stateMutability":"view",
   "inputs":[{"name":"account","type":"address"},{"name":"id","type":"uint256"}],
   "outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"isApprovedForAll","stateMutability":"view",
   "inputs":[{"name":"account","type":"address"},{"name":"operator","type":"address"}],
   "outputs":[{"name":"","type":"bool"}]},
  {"type":"function","name":"setApprovalForAll","stateMutability":"nonpayable",
   "inputs":[{"name":"operator","type":"address"},{"name":"approved","type":"bool"}],
   "outputs":[]},
  {"type":"function","name":"mintBatch","stateMutability":"nonpayable",
   "inputs":[
     {"name":"batchId","type":"uint256"},
     {"name":"firstOwner","type":"address"},
     {"name":"liters","type":"uint256"},
     {"name":"rspoCertificateHash","type":"bytes32"},
     {"name":"plantationId","type":"bytes32"},
     {"name":"productionDate","type":"uint64"}],
   "outputs":[]}
]`

const relayABI = `[
  {"type":"function","name":"executeChain","stateMutability":"nonpayable",
   "inputs":[
     {"name":"token","type":"address"},
     {"name":"batchId","type":"uint256"},
     {"name":"amount","type":"uint256"},
     {"name":"holders","type":"address[]"}],
   "outputs":[]},
  {"type":"function","name":"executeChainVariable","stateMutability":"nonpayable",
   "inputs":[
     {"name":"token","type":"address"},
     {"name":"batchId","type":"uint256"},
     {"name":"holders","type":"address[]"},
     {"name":"amounts","type":"uint256[]"}],
   "outputs":[]},
  {"type":"function","name":"executeHops","stateMutability":"nonpayable",
   "inputs":[
     {"name":"token","type":"address"},
     {"name":"batchId","type":"uint256"},
     {"name":"froms","type":"address[]"},
     {"name":"tos","type":"address[]"},
     {"name":"amounts","type":"uint256[]"}],
   "outputs":[]}
]`

const contractRegistryABI = `[
  {"type":"function","name":"getActive","stateMutability":"view",
   "inputs":[{"name":"name","type":"bytes32"}],
   "outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"register","stateMutability":"nonpayable",
   "inputs":[
     {"name":"name","type":"bytes32"},
     {"name":"version","type":"uint64"},
     {"name":"addr","type":"address"}],
   "outputs":[]}
]`

const pqAnchorRegistryABI = `[
  {"type":"function","name":"recordAnchor","stateMutability":"nonpayable",
   "inputs":[
     {"name":"merkleRoot","type":"bytes32"},
     {"name":"sha3Root","type":"bytes32"},
     {"name":"blockFrom","type":"uint64"},
     {"name":"blockTo","type":"uint64"},
     {"name":"eventCount","type":"uint64"},
     {"name":"anchorChain","type":"bytes32"},
     {"name":"pqSignatureHash","type":"bytes32"}],
   "outputs":[{"name":"anchorId","type":"uint256"}]}
]`

// parsed ABIs (panic on bad literal is a programming error caught at init).
var (
	abiHaraPalmOil      = mustABI(haraPalmOilABI)
	abiRelay            = mustABI(relayABI)
	abiContractRegistry = mustABI(contractRegistryABI)
	abiPQAnchorRegistry = mustABI(pqAnchorRegistryABI)
)

func mustABI(s string) abi.ABI {
	a, err := abi.JSON(strings.NewReader(s))
	if err != nil {
		panic(fmt.Sprintf("hararegistry: invalid inline ABI: %v", err))
	}
	return a
}

// callView performs an eth_call against the read endpoint and unpacks a single
// return value into out (a pointer).
func (c *ChainClient) callView(ctx context.Context, a abi.ABI, to common.Address, method string, args ...interface{}) ([]interface{}, error) {
	data, err := a.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("pack %s: %w", method, err)
	}
	out, err := c.read.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return nil, fmt.Errorf("eth_call %s: %w", method, err)
	}
	vals, err := a.Unpack(method, out)
	if err != nil {
		return nil, fmt.Errorf("unpack %s: %w", method, err)
	}
	return vals, nil
}

// ============================================================================
// HaraPalmOil (ERC-1155)
// ============================================================================

// HaraPalmOil binds the deployed HaraPalmOil ERC-1155 contract.
type HaraPalmOil struct {
	c    *ChainClient
	addr common.Address
}

// PalmOil returns a binding to the canonical HaraPalmOil deployment.
func (c *ChainClient) PalmOil() *HaraPalmOil {
	return &HaraPalmOil{c: c, addr: AddrHaraPalmOil}
}

// Address returns the bound contract address.
func (h *HaraPalmOil) Address() common.Address { return h.addr }

// BalanceOf returns the litres of batchId held by account.
func (h *HaraPalmOil) BalanceOf(ctx context.Context, account common.Address, batchId *big.Int) (*big.Int, error) {
	vals, err := h.c.callView(ctx, abiHaraPalmOil, h.addr, "balanceOf", account, batchId)
	if err != nil {
		return nil, err
	}
	return vals[0].(*big.Int), nil
}

// IsApprovedForAll reports whether operator may move account's tokens.
func (h *HaraPalmOil) IsApprovedForAll(ctx context.Context, account, operator common.Address) (bool, error) {
	vals, err := h.c.callView(ctx, abiHaraPalmOil, h.addr, "isApprovedForAll", account, operator)
	if err != nil {
		return false, err
	}
	return vals[0].(bool), nil
}

// PackMintBatch ABI-encodes a mintBatch call (MINTER_ROLE gated on-chain). The
// parameter order matches the deployed contract:
// (batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate).
func PackMintBatch(batchId *big.Int, firstOwner common.Address, liters *big.Int, rspoCertificateHash, plantationId [32]byte, productionDate uint64) ([]byte, error) {
	return abiHaraPalmOil.Pack("mintBatch", batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate)
}

// MintBatch sends a mintBatch tx with key and waits for a successful receipt.
func (h *HaraPalmOil) MintBatch(ctx context.Context, key *ecdsa.PrivateKey, batchId *big.Int, firstOwner common.Address, liters *big.Int, rspoCertificateHash, plantationId [32]byte, productionDate uint64) (*types.Receipt, error) {
	data, err := PackMintBatch(batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate)
	if err != nil {
		return nil, err
	}
	return h.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: h.addr, Data: data})
}

// PackSetApprovalForAll ABI-encodes a setApprovalForAll call.
func PackSetApprovalForAll(operator common.Address, approved bool) ([]byte, error) {
	return abiHaraPalmOil.Pack("setApprovalForAll", operator, approved)
}

// SetApprovalForAll grants/revokes operator approval for the caller's tokens and
// waits for a successful receipt. Each intermediate holder must approve the
// relay once before it can be a custody hop.
func (h *HaraPalmOil) SetApprovalForAll(ctx context.Context, key *ecdsa.PrivateKey, operator common.Address, approved bool) (*types.Receipt, error) {
	data, err := PackSetApprovalForAll(operator, approved)
	if err != nil {
		return nil, err
	}
	return h.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: h.addr, Data: data})
}

// ============================================================================
// TraceabilityBatchRelay
// ============================================================================

// Relay binds the deployed TraceabilityBatchRelay.
type Relay struct {
	c    *ChainClient
	addr common.Address
}

// Relay returns a binding to the canonical TraceabilityBatchRelay deployment.
func (c *ChainClient) Relay() *Relay {
	return &Relay{c: c, addr: AddrTraceabilityBatchRelay}
}

// Address returns the bound contract address.
func (r *Relay) Address() common.Address { return r.addr }

// PackExecuteChain ABI-encodes executeChain (uniform amount down a line of
// holders; holders[0] is the current owner, last is the final custodian).
func PackExecuteChain(token common.Address, batchId, amount *big.Int, holders []common.Address) ([]byte, error) {
	return abiRelay.Pack("executeChain", token, batchId, amount, holders)
}

// ExecuteChain moves batchId through holders at a uniform amount, in one tx.
func (r *Relay) ExecuteChain(ctx context.Context, key *ecdsa.PrivateKey, token common.Address, batchId, amount *big.Int, holders []common.Address) (*types.Receipt, error) {
	data, err := PackExecuteChain(token, batchId, amount, holders)
	if err != nil {
		return nil, err
	}
	return r.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: r.addr, Data: data})
}

// PackExecuteChainVariable ABI-encodes executeChainVariable (per-leg amounts;
// len(amounts) must equal len(holders)-1).
func PackExecuteChainVariable(token common.Address, batchId *big.Int, holders []common.Address, amounts []*big.Int) ([]byte, error) {
	return abiRelay.Pack("executeChainVariable", token, batchId, holders, amounts)
}

// ExecuteChainVariable moves batchId through holders with per-leg amounts.
func (r *Relay) ExecuteChainVariable(ctx context.Context, key *ecdsa.PrivateKey, token common.Address, batchId *big.Int, holders []common.Address, amounts []*big.Int) (*types.Receipt, error) {
	data, err := PackExecuteChainVariable(token, batchId, holders, amounts)
	if err != nil {
		return nil, err
	}
	return r.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: r.addr, Data: data})
}

// PackExecuteHops ABI-encodes executeHops (arbitrary DAG; froms/tos/amounts must
// be equal length and topologically ordered).
func PackExecuteHops(token common.Address, batchId *big.Int, froms, tos []common.Address, amounts []*big.Int) ([]byte, error) {
	return abiRelay.Pack("executeHops", token, batchId, froms, tos, amounts)
}

// ExecuteHops executes an arbitrary DAG of custody hops in one tx.
func (r *Relay) ExecuteHops(ctx context.Context, key *ecdsa.PrivateKey, token common.Address, batchId *big.Int, froms, tos []common.Address, amounts []*big.Int) (*types.Receipt, error) {
	data, err := PackExecuteHops(token, batchId, froms, tos, amounts)
	if err != nil {
		return nil, err
	}
	return r.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: r.addr, Data: data})
}

// ============================================================================
// ContractRegistry  (name = keccak256(utf8(name)), version = uint64)
// ============================================================================

// ContractRegistry binds the deployed ContractRegistry.
type ContractRegistry struct {
	c    *ChainClient
	addr common.Address
}

// Registry returns a binding to the canonical ContractRegistry deployment.
func (c *ChainClient) Registry() *ContractRegistry {
	return &ContractRegistry{c: c, addr: AddrContractRegistry}
}

// Address returns the bound contract address.
func (r *ContractRegistry) Address() common.Address { return r.addr }

// RegistryNameHash computes the registry key for a logical contract name:
// keccak256(utf8(name)). This is how every on-chain entry is keyed — NOT
// format-bytes32-string / right-padded ASCII.
func RegistryNameHash(name string) common.Hash {
	return crypto.Keccak256Hash([]byte(name))
}

// GetActive returns the active address for a logical contract name.
func (r *ContractRegistry) GetActive(ctx context.Context, name string) (common.Address, error) {
	nameHash := RegistryNameHash(name)
	vals, err := r.c.callView(ctx, abiContractRegistry, r.addr, "getActive", [32]byte(nameHash))
	if err != nil {
		return common.Address{}, err
	}
	return vals[0].(common.Address), nil
}

// PackRegister ABI-encodes register(bytes32 name, uint64 version, address addr).
// version is a real uint64 — NOT padded ASCII.
func PackRegister(name string, version uint64, addr common.Address) ([]byte, error) {
	nameHash := RegistryNameHash(name)
	return abiContractRegistry.Pack("register", [32]byte(nameHash), version, addr)
}

// Register registers a new contract version (first version auto-activates).
func (r *ContractRegistry) Register(ctx context.Context, key *ecdsa.PrivateKey, name string, version uint64, addr common.Address) (*types.Receipt, error) {
	data, err := PackRegister(name, version, addr)
	if err != nil {
		return nil, err
	}
	return r.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: r.addr, Data: data})
}

// ============================================================================
// PQAnchorRegistry
// ============================================================================

// PQAnchorRegistry binds the deployed PQAnchorRegistry.
type PQAnchorRegistry struct {
	c    *ChainClient
	addr common.Address
}

// PQAnchors returns a binding to the canonical PQAnchorRegistry deployment.
func (c *ChainClient) PQAnchors() *PQAnchorRegistry {
	return &PQAnchorRegistry{c: c, addr: AddrPQAnchorRegistry}
}

// Address returns the bound contract address.
func (p *PQAnchorRegistry) Address() common.Address { return p.addr }

// RecordAnchor sends a recordAnchor tx and waits for a successful receipt.
// pqSignatureHash MUST be non-zero (the contract reverts MissingPQCommitment
// otherwise) and is the keccak256 of the off-chain ML-DSA signature — computing
// that signature is the caller's responsibility (see anchor.go).
func (p *PQAnchorRegistry) RecordAnchor(ctx context.Context, key *ecdsa.PrivateKey, a AnchorRecord) (*types.Receipt, error) {
	data, err := PackRecordAnchor(a)
	if err != nil {
		return nil, err
	}
	return p.c.SendAndWait(ctx, SendLegacyTxOpts{Key: key, To: p.addr, Data: data})
}
