package hararegistry

import (
	"github.com/ethereum/go-ethereum/crypto"
)

// AnchorRecord is the input to PQAnchorRegistry.recordAnchor. All hashes are
// 32-byte values; the block range and counters are uint64.
//
// Post-quantum note: PQSignatureHash is keccak256(ML-DSA-65 signature bytes).
// The ML-DSA (Dilithium-3, NIST FIPS 204) signing happens OFF-CHAIN and is the
// caller's responsibility — this SDK only commits the hash on-chain and never
// performs PQ signing. The full signature blob is stored off-chain (MinIO
// bucket hara-pq-anchors) keyed by this hash. PQSignatureHash MUST be non-zero
// or the contract reverts MissingPQCommitment.
type AnchorRecord struct {
	// MerkleRoot is keccak256 of the event range's Merkle root.
	MerkleRoot [32]byte
	// Sha3Root is SHA3-256 of the same data (hash agility / belt-and-suspenders).
	Sha3Root [32]byte
	// BlockFrom is the first block in the anchored range (inclusive).
	BlockFrom uint64
	// BlockTo is the last block in the anchored range (inclusive). Must be >= BlockFrom.
	BlockTo uint64
	// EventCount is the number of events covered by the anchor.
	EventCount uint64
	// AnchorChain identifies the external anchoring chain (e.g. keccak/tag for
	// IOTA, Ethereum L1, ...). May be zero if not anchored externally yet.
	AnchorChain [32]byte
	// PQSignatureHash is keccak256(ML-DSA signature bytes). MUST be non-zero.
	PQSignatureHash [32]byte
}

// PackRecordAnchor ABI-encodes a recordAnchor call from an AnchorRecord. This is
// the calldata helper for callers that manage signing/nonce themselves.
func PackRecordAnchor(a AnchorRecord) ([]byte, error) {
	return abiPQAnchorRegistry.Pack(
		"recordAnchor",
		a.MerkleRoot,
		a.Sha3Root,
		a.BlockFrom,
		a.BlockTo,
		a.EventCount,
		a.AnchorChain,
		a.PQSignatureHash,
	)
}

// PQSignatureHash computes keccak256(signature) — the on-chain PQ commitment for
// a raw ML-DSA signature blob. Provided as a convenience; the ML-DSA signing
// itself is out of scope for this SDK.
func PQSignatureHash(mlDSASignature []byte) [32]byte {
	return crypto.Keccak256Hash(mlDSASignature)
}
