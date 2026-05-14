// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {GovernanceContract} from "../src/GovernanceContract.sol";

contract GovTarget {
    uint256 public value;
    function setValue(uint256 v) external { value = v; }
}

contract GovernanceContractTest is Test {
    GovernanceContract gov;
    GovTarget target;

    address gov1 = address(0xA1);
    address gov2 = address(0xA2);
    address gov3 = address(0xA3);

    function setUp() public {
        address[] memory governors = new address[](3);
        governors[0] = gov1;
        governors[1] = gov2;
        governors[2] = gov3;
        gov = new GovernanceContract(governors, 2); // 2-of-3
        target = new GovTarget();
    }

    function test_ProposeAndExecute2of3() public {
        bytes memory data = abi.encodeWithSelector(GovTarget.setValue.selector, uint256(42));

        vm.prank(gov1);
        uint256 id = gov.propose(address(target), data, 0, "set value to 42");

        // gov1 auto-approved on propose; one more approval reaches threshold
        vm.prank(gov2);
        gov.approve(id);

        vm.prank(gov1);
        gov.execute(id);

        assertEq(target.value(), 42);
    }

    function test_RevertWhen_ExecuteBeforeThreshold() public {
        bytes memory data = abi.encodeWithSelector(GovTarget.setValue.selector, uint256(7));

        vm.prank(gov1);
        uint256 id = gov.propose(address(target), data, 0, "set value to 7");

        // Only 1 approval (proposer's auto-approve), threshold is 2
        vm.prank(gov1);
        vm.expectRevert();
        gov.execute(id);
    }

    function test_RevertWhen_DoubleApprove() public {
        bytes memory data = abi.encodeWithSelector(GovTarget.setValue.selector, uint256(1));

        vm.prank(gov1);
        uint256 id = gov.propose(address(target), data, 0, "");

        vm.prank(gov1);
        vm.expectRevert(GovernanceContract.AlreadyApproved.selector);
        gov.approve(id);
    }

    function test_EmergencyPause() public {
        vm.prank(address(this));
        gov.setEmergencyPause(true);
        assertTrue(gov.emergencyPaused());
    }
}
