// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  HaraPalmOil
/// @notice ERC-1155 representing real sustainable palm oil volume (in liters).
///         Each token ID is a distinct production batch (one plantation cycle,
///         one mill run, etc.). Token amount = liters in that batch.
///         Per-batch metadata (RSPO certificate hash, plantation ID, production
///         date) is stored on-chain so each TransferSingle event can be audited
///         against the certified batch identity.
///
///         Designed for RSPO Segregated / Identity-Preserved supply chains:
///         every custody change is a real safeTransferFrom call, emitting a
///         canonical TransferSingle event that auditors verify as the legal
///         chain-of-custody record.
contract HaraPalmOil is ERC1155Supply, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE");

    /// Per-batch certified metadata.
    /// volumeLiters is denormalised — totalSupply(id) is authoritative.
    struct BatchMeta {
        bytes32 rspoCertificateHash; // keccak of off-chain RSPO cert PDF / VC
        bytes32 plantationId;         // identifier of source plantation/coop
        uint64  productionDate;       // unix seconds
        uint64  mintedAt;
        address mintedBy;
    }

    mapping(uint256 => BatchMeta) public batchMeta;

    event BatchMinted(
        uint256 indexed batchId,
        address indexed firstOwner,
        uint256 liters,
        bytes32 rspoCertificateHash,
        bytes32 plantationId,
        uint64 productionDate
    );
    event BatchMetadataUpdated(uint256 indexed batchId, bytes32 newRspoCertificateHash);

    error BatchAlreadyExists(uint256 batchId);
    error UnknownBatch(uint256 batchId);

    constructor(address admin) ERC1155("https://hara.example/palm-oil/{id}") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(CERTIFIER_ROLE, admin);
    }

    /// Create a new certified batch. The first owner receives the full volume.
    /// Subsequent custody changes use the standard safeTransferFrom flow.
    function mintBatch(
        uint256 batchId,
        address firstOwner,
        uint256 liters,
        bytes32 rspoCertificateHash,
        bytes32 plantationId,
        uint64 productionDate
    ) external onlyRole(MINTER_ROLE) {
        if (batchMeta[batchId].mintedAt != 0) revert BatchAlreadyExists(batchId);

        batchMeta[batchId] = BatchMeta({
            rspoCertificateHash: rspoCertificateHash,
            plantationId: plantationId,
            productionDate: productionDate,
            mintedAt: uint64(block.timestamp),
            mintedBy: msg.sender
        });
        _mint(firstOwner, batchId, liters, "");
        emit BatchMinted(batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate);
    }

    /// Update the certificate hash if a re-audit produces a new VC.
    function updateRspoCertificate(uint256 batchId, bytes32 newHash) external onlyRole(CERTIFIER_ROLE) {
        if (batchMeta[batchId].mintedAt == 0) revert UnknownBatch(batchId);
        batchMeta[batchId].rspoCertificateHash = newHash;
        emit BatchMetadataUpdated(batchId, newHash);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
