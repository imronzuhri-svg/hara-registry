// Package hararegistry is the official Go SDK for Hara Registry — a permissioned
// Hyperledger Besu (QBFT) blockchain for palm-oil supply-chain traceability with
// post-quantum audit anchoring.
//
// Three rules that bite every integrator (enforced by helpers in this SDK):
//
//  1. Legacy txs only, gasPrice 0, chainId 131216. EIP-1559 type-2 txs are rejected.
//  2. Pre-fund >= 1 wei native HARA to any wallet before its first tx. Besu silently
//     skips zero-balance senders even at gasPrice 0 — the tx sits unmined.
//  3. Verify receipt.status == 0x1. A mined tx can still have reverted.
//
// Source of truth: doc/api/hara-registry-facts.md in the hara-registry repo.
package hararegistry

import "github.com/ethereum/go-ethereum/common"

// Chain identity — invariants, never change.
const (
	// ChainID is the EVM chain id of Hara Registry.
	ChainID = 131216

	// GasPriceZero documents that all legacy txs MUST be sent with gasPrice 0
	// (zeroBaseFee genesis). See SendLegacyTx.
	GasPriceZero = 0
)

// Public endpoints. The trailing slash on /read/ and /write/ is significant —
// dropping it returns "404 Route not found".
const (
	// EndpointRead is the cached JSON-RPC read endpoint.
	EndpointRead = "https://rpc.ledger.haratrust.io/read/"

	// EndpointWrite is the JSON-RPC write endpoint (eth_sendRawTransaction).
	EndpointWrite = "https://rpc.ledger.haratrust.io/write/"

	// EndpointWS is the JSON-RPC WebSocket endpoint (subscriptions).
	EndpointWS = "wss://rpc.ledger.haratrust.io/ws"

	// EndpointExplorer is the Blockscout explorer (and /api/v2/* REST).
	EndpointExplorer = "https://explorer.ledger.haratrust.io/"

	// EndpointTrace is the traceability REST API (/v1/*). Requires HTTP Basic auth.
	EndpointTrace = "https://trace.ledger.haratrust.io"
)

// Deployed contract addresses on chain 131216, as canonical hex strings.
const (
	AddrHaraPalmOilHex            = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
	AddrTraceabilityBatchRelayHex = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6"
	AddrPQAnchorRegistryHex       = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318"
	AddrContractRegistryHex       = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
	AddrGovernanceContractHex     = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
	AddrAnchorRegistryLegacyHex   = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
)

// Deployed contract addresses as common.Address values.
var (
	AddrHaraPalmOil            = common.HexToAddress(AddrHaraPalmOilHex)
	AddrTraceabilityBatchRelay = common.HexToAddress(AddrTraceabilityBatchRelayHex)
	AddrPQAnchorRegistry       = common.HexToAddress(AddrPQAnchorRegistryHex)
	AddrContractRegistry       = common.HexToAddress(AddrContractRegistryHex)
	AddrGovernanceContract     = common.HexToAddress(AddrGovernanceContractHex)
	AddrAnchorRegistryLegacy   = common.HexToAddress(AddrAnchorRegistryLegacyHex)
)
