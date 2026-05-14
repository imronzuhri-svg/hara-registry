// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";

contract AnchorRegistryTest is Test {
    AnchorRegistry registry;
    address admin = address(0xA11CE);

    bytes32 constant ROOT = keccak256("test-merkle-root");
    bytes32 constant IOTA = keccak256("iota");
    bytes32 constant TX_HASH = keccak256("public-tx-hash");

    function setUp() public {
        registry = new AnchorRegistry(admin);
    }

    function test_RecordAnchor() public {
        vm.prank(admin);
        uint256 id = registry.recordAnchor(ROOT, 0, 100, 250, IOTA);
        assertEq(id, 1);
        assertEq(registry.anchorCount(), 1);

        (bytes32 root, uint64 from, uint64 to, uint64 count, , bytes32 chain, bytes32 txHash) =
            registry.anchors(1);
        assertEq(root, ROOT);
        assertEq(from, 0);
        assertEq(to, 100);
        assertEq(count, 250);
        assertEq(chain, IOTA);
        assertEq(txHash, bytes32(0));
    }

    function test_ConfirmExternalAnchor() public {
        vm.startPrank(admin);
        uint256 id = registry.recordAnchor(ROOT, 0, 100, 250, IOTA);
        registry.confirmExternalAnchor(id, TX_HASH);
        vm.stopPrank();

        (, , , , , , bytes32 txHash) = registry.anchors(id);
        assertEq(txHash, TX_HASH);
    }

    function test_RevertWhen_EmptyRange() public {
        vm.prank(admin);
        vm.expectRevert(AnchorRegistry.EmptyRange.selector);
        registry.recordAnchor(ROOT, 100, 50, 0, IOTA);
    }

    function test_RevertWhen_ConfirmNonExistent() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.AnchorNotFound.selector, uint256(99)));
        registry.confirmExternalAnchor(99, TX_HASH);
    }
}
