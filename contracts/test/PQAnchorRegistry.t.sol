// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PQAnchorRegistry} from "../src/PQAnchorRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract PQAnchorRegistryTest is Test {
    PQAnchorRegistry registry;

    address admin    = address(0xA11CE);
    address rotator  = address(0xB0B);
    address stranger = address(0xC0DE);

    bytes32 constant INITIAL_KEY = keccak256("initial-pq-key");
    string  constant INITIAL_ALG = "ML-DSA-65";

    bytes32 constant ROOT       = keccak256("merkle-root");
    bytes32 constant SHA3_ROOT  = keccak256("sha3-root");
    bytes32 constant CHAIN_TAG  = keccak256("iota");
    bytes32 constant PQ_SIG     = keccak256("pq-signature-bytes");
    bytes32 constant TX_HASH    = keccak256("external-tx-hash");

    function setUp() public {
        registry = new PQAnchorRegistry(admin, INITIAL_KEY, INITIAL_ALG);
    }

    // ── Construction ──────────────────────────────────────────────────────

    function test_ConstructorGrantsAdminAllRoles() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(registry.hasRole(registry.ANCHOR_ROLE(),        admin));
        assertTrue(registry.hasRole(registry.KEY_ROTATOR_ROLE(),   admin));
    }

    function test_ConstructorSetsInitialKeyAndAlgorithm() public view {
        assertEq(registry.currentPQKeyHash(), INITIAL_KEY);
        assertEq(registry.currentPQAlgorithm(), INITIAL_ALG);
    }

    // ── recordAnchor happy path ───────────────────────────────────────────

    function test_RecordAnchorSucceedsAndIncrementsCount() public {
        vm.prank(admin);
        uint256 id = registry.recordAnchor(ROOT, SHA3_ROOT, 100, 250, 42, CHAIN_TAG, PQ_SIG);

        assertEq(id, 1);
        assertEq(registry.anchorCount(), 1);

        (
            bytes32 root,
            bytes32 sha3,
            uint64 from,
            uint64 to,
            uint64 count,
            uint64 ts,
            bytes32 chain,
            bytes32 txHash,
            bytes32 pqSig,
            bytes32 pqKey
        ) = registry.anchors(1);

        assertEq(root,    ROOT);
        assertEq(sha3,    SHA3_ROOT);
        assertEq(from,    100);
        assertEq(to,      250);
        assertEq(count,   42);
        assertEq(ts,      uint64(block.timestamp));
        assertEq(chain,   CHAIN_TAG);
        assertEq(txHash,  bytes32(0));            // not yet externally confirmed
        assertEq(pqSig,   PQ_SIG);
        assertEq(pqKey,   INITIAL_KEY);           // frozen at signing time
    }

    function test_RecordAnchorTwiceIncrementsId() public {
        vm.startPrank(admin);
        uint256 id1 = registry.recordAnchor(ROOT, SHA3_ROOT, 0, 10, 5, CHAIN_TAG, PQ_SIG);
        uint256 id2 = registry.recordAnchor(ROOT, SHA3_ROOT, 10, 20, 5, CHAIN_TAG, PQ_SIG);
        vm.stopPrank();
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(registry.anchorCount(), 2);
    }

    // ── recordAnchor revert paths ─────────────────────────────────────────

    function test_RevertWhen_RecordAnchorEmptyRange() public {
        vm.prank(admin);
        vm.expectRevert(PQAnchorRegistry.EmptyRange.selector);
        registry.recordAnchor(ROOT, SHA3_ROOT, 250, 100, 0, CHAIN_TAG, PQ_SIG);
    }

    function test_RevertWhen_RecordAnchorMissingPQCommitment() public {
        vm.prank(admin);
        vm.expectRevert(PQAnchorRegistry.MissingPQCommitment.selector);
        registry.recordAnchor(ROOT, SHA3_ROOT, 0, 100, 0, CHAIN_TAG, bytes32(0));
    }

    function test_RevertWhen_RecordAnchorNotAnchorRole() public {
        bytes32 anchorRole = registry.ANCHOR_ROLE(); // hoist out of prank window
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                anchorRole
            )
        );
        registry.recordAnchor(ROOT, SHA3_ROOT, 0, 100, 0, CHAIN_TAG, PQ_SIG);
    }

    // ── confirmExternalAnchor ─────────────────────────────────────────────

    function test_ConfirmExternalAnchor() public {
        vm.startPrank(admin);
        uint256 id = registry.recordAnchor(ROOT, SHA3_ROOT, 0, 100, 0, CHAIN_TAG, PQ_SIG);
        registry.confirmExternalAnchor(id, TX_HASH);
        vm.stopPrank();

        (, , , , , , , bytes32 txHash, , ) = registry.anchors(id);
        assertEq(txHash, TX_HASH);
    }

    function test_RevertWhen_ConfirmNonExistent() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(PQAnchorRegistry.AnchorNotFound.selector, uint256(99))
        );
        registry.confirmExternalAnchor(99, TX_HASH);
    }

    // ── rotatePQKey ───────────────────────────────────────────────────────

    function test_RotatePQKey() public {
        bytes32 newKey = keccak256("rotated-pq-key");
        string memory newAlg = "ML-DSA-87";

        vm.prank(admin);
        registry.rotatePQKey(newKey, newAlg);

        assertEq(registry.currentPQKeyHash(), newKey);
        assertEq(registry.currentPQAlgorithm(), newAlg);
    }

    function test_RotatePQKeyDoesNotAffectExistingAnchors() public {
        vm.startPrank(admin);
        uint256 id = registry.recordAnchor(ROOT, SHA3_ROOT, 0, 100, 0, CHAIN_TAG, PQ_SIG);
        registry.rotatePQKey(keccak256("rotated"), "ML-DSA-87");
        vm.stopPrank();

        // The old anchor must keep its original pqKeyHash.
        (, , , , , , , , , bytes32 pqKey) = registry.anchors(id);
        assertEq(pqKey, INITIAL_KEY);
    }

    function test_RevertWhen_RotatePQKeyNotRotator() public {
        bytes32 rotatorRole = registry.KEY_ROTATOR_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                rotatorRole
            )
        );
        registry.rotatePQKey(keccak256("attempt"), "ML-DSA-87");
    }

    // ── Role plumbing: a granted rotator can rotate ───────────────────────

    function test_GrantedRotatorCanRotate() public {
        bytes32 rotatorRole = registry.KEY_ROTATOR_ROLE();
        vm.prank(admin);
        registry.grantRole(rotatorRole, rotator);

        bytes32 newKey = keccak256("by-rotator");
        vm.prank(rotator);
        registry.rotatePQKey(newKey, "ML-DSA-65");
        assertEq(registry.currentPQKeyHash(), newKey);
    }
}
