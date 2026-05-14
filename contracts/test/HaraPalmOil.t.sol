// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {HaraPalmOil} from "../src/HaraPalmOil.sol";
import {TraceabilityBatchRelay} from "../src/TraceabilityBatchRelay.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

contract HaraPalmOilTest is Test {
    HaraPalmOil token;
    TraceabilityBatchRelay relay;
    address admin = address(0xA11CE);

    bytes32 constant RSPO = keccak256("rspo-cert-001");
    bytes32 constant PLANT = keccak256("plantation-jkt-01");

    function setUp() public {
        vm.prank(admin);
        token = new HaraPalmOil(admin);
        relay = new TraceabilityBatchRelay();
    }

    function test_MintAndTransfer() public {
        address a = address(0x1);
        address b = address(0x2);

        vm.prank(admin);
        token.mintBatch(1, a, 1000, RSPO, PLANT, uint64(block.timestamp));

        assertEq(token.balanceOf(a, 1), 1000);
        assertEq(token.totalSupply(1), 1000);

        vm.prank(a);
        token.safeTransferFrom(a, b, 1, 900, "");

        assertEq(token.balanceOf(a, 1), 100);
        assertEq(token.balanceOf(b, 1), 900);

        (bytes32 cert, bytes32 plant, , , ) = token.batchMeta(1);
        assertEq(cert, RSPO);
        assertEq(plant, PLANT);
    }

    function test_RevertOnDuplicateBatch() public {
        vm.startPrank(admin);
        token.mintBatch(42, address(0x1), 1000, RSPO, PLANT, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(HaraPalmOil.BatchAlreadyExists.selector, uint256(42)));
        token.mintBatch(42, address(0x2), 500, RSPO, PLANT, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_RelayExecutesChain() public {
        // 5-hop chain: w0 → w1 → w2 → w3 → w4
        address[] memory holders = new address[](5);
        for (uint i = 0; i < 5; i++) holders[i] = address(uint160(0xAA00 + i));

        // mint to w0
        vm.prank(admin);
        token.mintBatch(7, holders[0], 1000, RSPO, PLANT, uint64(block.timestamp));

        // each holder pre-approves the relay
        for (uint i = 0; i < 4; i++) {
            vm.prank(holders[i]);
            token.setApprovalForAll(address(relay), true);
        }

        // single tx: execute the chain (using a non-holder caller — the relay
        // does the transferFrom on each holder's approval)
        vm.prank(address(0xBEEF));
        relay.executeChain(IERC1155(address(token)), 7, 900, holders);

        // verify final state: only w4 holds the volume
        assertEq(token.balanceOf(holders[0], 7), 100);
        assertEq(token.balanceOf(holders[1], 7), 0);
        assertEq(token.balanceOf(holders[2], 7), 0);
        assertEq(token.balanceOf(holders[3], 7), 0);
        assertEq(token.balanceOf(holders[4], 7), 900);
    }

    function test_RelayEmits4TransferSingleEvents() public {
        address[] memory holders = new address[](5);
        for (uint i = 0; i < 5; i++) holders[i] = address(uint160(0xBB00 + i));

        vm.prank(admin);
        token.mintBatch(11, holders[0], 1000, RSPO, PLANT, uint64(block.timestamp));

        for (uint i = 0; i < 4; i++) {
            vm.prank(holders[i]);
            token.setApprovalForAll(address(relay), true);
        }

        vm.recordLogs();
        vm.prank(address(0xBEEF));
        relay.executeChain(IERC1155(address(token)), 11, 900, holders);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 transferSingleCount;
        bytes32 topic = keccak256("TransferSingle(address,address,address,uint256,uint256)");
        for (uint i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) transferSingleCount++;
        }
        // 4 hops = 4 TransferSingle events from the ERC-1155 contract
        assertEq(transferSingleCount, 4, "expected 4 TransferSingle events");
    }
}
