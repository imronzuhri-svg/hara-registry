// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  PQAnchorRegistry
/// @notice Post-quantum-aware version of AnchorRegistry. Records Merkle roots of
///         on-chain event ranges PLUS a parallel post-quantum signature commitment.
///
///         The threat model: EVM consensus signatures (SECP256K1/ECDSA) are
///         vulnerable to Shor's algorithm. An attacker who later acquires a
///         cryptographically-relevant quantum computer (CRQC, ~2030–2040 est.)
///         could forge historical anchor signatures and retroactively fabricate
///         chain history.
///
///         The mitigation: at anchor time, sign the Merkle root with BOTH:
///           - the standard ECDSA path (cheap, current Ethereum tooling)
///           - a post-quantum signature scheme: ML-DSA-65 (Dilithium 3, NIST FIPS 204)
///         and commit BOTH signature hashes on-chain. Verification can be done
///         off-chain against the published PQ public keys (anchor file in CAS).
///
///         Why hybrid (not pure PQ): ML-DSA signatures are ~3 KB. Verifying
///         on-chain in Solidity is gas-prohibitive today (~5M gas per verify).
///         Instead, we COMMIT to the PQ signature hash on-chain and store the
///         actual signature off-chain in MinIO/IPFS. Auditors verify the off-chain
///         signature against the on-chain hash commitment — quantum-safe without
///         the on-chain verifier cost.
///
///         Migration path: when EVMs add ML-DSA precompiles (likely 2027–2029),
///         add an on-chain `verifyPQ()` function. Until then, this is the
///         "harvest-now-decrypt-later" defence.
contract PQAnchorRegistry is AccessControl {
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");
    bytes32 public constant KEY_ROTATOR_ROLE = keccak256("KEY_ROTATOR_ROLE");

    /// Currently-active post-quantum signing key (hash of public key).
    /// The actual public key bytes live off-chain (CAS, MinIO) at this hash.
    /// Rotated periodically as PQ standards evolve (Dilithium → SLH-DSA → ...).
    bytes32 public currentPQKeyHash;
    string  public currentPQAlgorithm; // e.g. "ML-DSA-65" or "SLH-DSA-SHA2-128s"

    struct Anchor {
        bytes32 merkleRoot;          // Keccak256 of the event range's root
        bytes32 sha3Root;            // SHA3-256 of the SAME data — belt-and-suspenders hash agility
        uint64  blockFrom;
        uint64  blockTo;
        uint64  eventCount;
        uint64  timestamp;
        // External-chain anchor pointer (IOTA tx hash, Ethereum L1 tx hash, etc.)
        bytes32 anchorChain;
        bytes32 anchorTxHash;
        // Post-quantum commitment
        bytes32 pqSignatureHash;     // Keccak256(ML-DSA signature bytes)
        bytes32 pqKeyHash;           // The PQ pubkey hash at signing time (frozen, not currentPQKeyHash)
    }

    mapping(uint256 => Anchor) public anchors;
    uint256 public anchorCount;

    event AnchorRecorded(
        uint256 indexed anchorId,
        bytes32 merkleRoot,
        bytes32 sha3Root,
        uint64 blockFrom,
        uint64 blockTo,
        uint64 eventCount,
        bytes32 pqSignatureHash,
        bytes32 pqKeyHash,
        bytes32 anchorChain
    );
    event ExternalAnchorConfirmed(
        uint256 indexed anchorId,
        bytes32 anchorChain,
        bytes32 anchorTxHash
    );
    event PQKeyRotated(
        bytes32 indexed oldKeyHash,
        bytes32 indexed newKeyHash,
        string newAlgorithm
    );

    error EmptyRange();
    error AnchorNotFound(uint256 anchorId);
    error MissingPQCommitment();

    constructor(address admin, bytes32 initialPQKeyHash, string memory initialAlgorithm) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_ROLE, admin);
        _grantRole(KEY_ROTATOR_ROLE, admin);
        currentPQKeyHash = initialPQKeyHash;
        currentPQAlgorithm = initialAlgorithm;
    }

    /// Record an anchor with both classical and post-quantum commitments.
    /// pqSignatureHash MUST be non-zero — empty PQ sig commitment is disallowed
    /// for this contract (use the classic AnchorRegistry if you don't want PQ).
    function recordAnchor(
        bytes32 merkleRoot,
        bytes32 sha3Root,
        uint64 blockFrom,
        uint64 blockTo,
        uint64 eventCount,
        bytes32 anchorChain,
        bytes32 pqSignatureHash
    ) external onlyRole(ANCHOR_ROLE) returns (uint256 anchorId) {
        if (blockTo < blockFrom) revert EmptyRange();
        if (pqSignatureHash == bytes32(0)) revert MissingPQCommitment();

        anchorId = ++anchorCount;
        anchors[anchorId] = Anchor({
            merkleRoot: merkleRoot,
            sha3Root: sha3Root,
            blockFrom: blockFrom,
            blockTo: blockTo,
            eventCount: eventCount,
            timestamp: uint64(block.timestamp),
            anchorChain: anchorChain,
            anchorTxHash: bytes32(0),
            pqSignatureHash: pqSignatureHash,
            pqKeyHash: currentPQKeyHash
        });

        emit AnchorRecorded(
            anchorId, merkleRoot, sha3Root, blockFrom, blockTo, eventCount,
            pqSignatureHash, currentPQKeyHash, anchorChain
        );
    }

    function confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)
        external
        onlyRole(ANCHOR_ROLE)
    {
        Anchor storage a = anchors[anchorId];
        if (a.merkleRoot == bytes32(0)) revert AnchorNotFound(anchorId);
        a.anchorTxHash = anchorTxHash;
        emit ExternalAnchorConfirmed(anchorId, a.anchorChain, anchorTxHash);
    }

    /// Rotate the post-quantum signing key. New anchors will be tagged with the new key hash.
    /// Old anchors keep their original `pqKeyHash` — auditors fetch the matching public key
    /// from the off-chain CAS to verify historical anchors.
    function rotatePQKey(bytes32 newKeyHash, string calldata newAlgorithm)
        external
        onlyRole(KEY_ROTATOR_ROLE)
    {
        emit PQKeyRotated(currentPQKeyHash, newKeyHash, newAlgorithm);
        currentPQKeyHash = newKeyHash;
        currentPQAlgorithm = newAlgorithm;
    }
}
