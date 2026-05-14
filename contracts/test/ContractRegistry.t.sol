// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ContractRegistry} from "../src/ContractRegistry.sol";

contract ContractRegistryTest is Test {
    ContractRegistry registry;
    address admin = address(0xA11CE);
    address other = address(0xB0B);

    bytes32 constant NAME = keccak256("TestContract");
    address constant ADDR_V1 = address(0x1111111111111111111111111111111111111111);
    address constant ADDR_V2 = address(0x2222222222222222222222222222222222222222);

    function setUp() public {
        registry = new ContractRegistry(admin);
    }

    function test_RegisterFirstVersionAutoActivates() public {
        vm.prank(admin);
        registry.register(NAME, 1, ADDR_V1);
        assertEq(registry.getActive(NAME), ADDR_V1);
        assertEq(registry.activeVersion(NAME), 1);
    }

    function test_RegisterSecondVersionDoesNotChangeActive() public {
        vm.startPrank(admin);
        registry.register(NAME, 1, ADDR_V1);
        registry.register(NAME, 2, ADDR_V2);
        vm.stopPrank();

        assertEq(registry.getActive(NAME), ADDR_V1);
        assertEq(registry.activeVersion(NAME), 1);
    }

    function test_SetActiveVersion() public {
        vm.startPrank(admin);
        registry.register(NAME, 1, ADDR_V1);
        registry.register(NAME, 2, ADDR_V2);
        registry.setActiveVersion(NAME, 2);
        vm.stopPrank();

        assertEq(registry.getActive(NAME), ADDR_V2);
    }

    function test_RevertWhen_DuplicateVersion() public {
        vm.startPrank(admin);
        registry.register(NAME, 1, ADDR_V1);
        vm.expectRevert(
            abi.encodeWithSelector(ContractRegistry.AlreadyRegistered.selector, NAME, uint64(1))
        );
        registry.register(NAME, 1, ADDR_V2);
        vm.stopPrank();
    }

    function test_RevertWhen_ZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(ContractRegistry.ZeroAddress.selector);
        registry.register(NAME, 1, address(0));
    }

    function test_RevertWhen_NonRegistrarRegisters() public {
        vm.prank(other);
        vm.expectRevert();
        registry.register(NAME, 1, ADDR_V1);
    }
}
