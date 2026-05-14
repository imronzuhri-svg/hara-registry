// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  AnchorRegistry
/// @notice Records Merkle-root anchors of HaraLedger event ranges, plus the public-chain
///         transaction hash where the same root was anchored externally (IOTA in P1,
///         IOTA + Ethereum from P2 onward).
///
///         The anchor model lets any third party verify a HaraLedger event independently:
///           1. Fetch the event from any indexer.
///           2. Compute its Merkle inclusion proof against the recorded root.
///           3. Verify the same root on the external public chain at `anchorTxHash`.
///         No HARA-operated service needs to be trusted.
contract AnchorRegistry is AccessControl {
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    struct Anchor {
        bytes32 merkleRoot;
        uint64 blockFrom;
        uint64 blockTo;
        uint64 eventCount;
        uint64 timestamp;
        bytes32 anchorChain;   // e.g. keccak("iota") or keccak("ethereum")
        bytes32 anchorTxHash;  // tx hash on the external chain (0x0 if pending)
    }

    /// anchorId => Anchor
    mapping(uint256 => Anchor) public anchors;
    uint256 public anchorCount;

    event AnchorRecorded(
        uint256 indexed anchorId,
        bytes32 merkleRoot,
        uint64 blockFrom,
        uint64 blockTo,
        uint64 eventCount,
        bytes32 anchorChain
    );
    event ExternalAnchorConfirmed(
        uint256 indexed anchorId,
        bytes32 anchorChain,
        bytes32 anchorTxHash
    );

    error EmptyRange();
    error AnchorNotFound(uint256 anchorId);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_ROLE, admin);
    }

    /// @notice Record a new Merkle-root anchor covering blocks [blockFrom, blockTo].
    ///         External anchor confirmation (e.g. IOTA tx hash) is filled in later
    ///         via `confirmExternalAnchor` once the public-chain tx is mined.
    function recordAnchor(
        bytes32 merkleRoot,
        uint64 blockFrom,
        uint64 blockTo,
        uint64 eventCount,
        bytes32 anchorChain
    ) external onlyRole(ANCHOR_ROLE) returns (uint256 anchorId) {
        if (blockTo < blockFrom) revert EmptyRange();

        anchorId = ++anchorCount;
        anchors[anchorId] = Anchor({
            merkleRoot: merkleRoot,
            blockFrom: blockFrom,
            blockTo: blockTo,
            eventCount: eventCount,
            timestamp: uint64(block.timestamp),
            anchorChain: anchorChain,
            anchorTxHash: bytes32(0)
        });

        emit AnchorRecorded(anchorId, merkleRoot, blockFrom, blockTo, eventCount, anchorChain);
    }

    /// @notice Confirm that the Merkle root was successfully anchored on the external chain.
    function confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)
        external
        onlyRole(ANCHOR_ROLE)
    {
        Anchor storage a = anchors[anchorId];
        if (a.merkleRoot == bytes32(0)) revert AnchorNotFound(anchorId);
        a.anchorTxHash = anchorTxHash;
        emit ExternalAnchorConfirmed(anchorId, a.anchorChain, anchorTxHash);
    }
}
