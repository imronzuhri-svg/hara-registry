// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ContractRegistry} from "../src/ContractRegistry.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";
import {GovernanceContract} from "../src/GovernanceContract.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);

        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }

        // 1. ContractRegistry
        ContractRegistry registry = new ContractRegistry(deployer);
        console2.log("ContractRegistry deployed:", address(registry));

        // 2. AnchorRegistry
        AnchorRegistry anchor = new AnchorRegistry(deployer);
        console2.log("AnchorRegistry deployed: ", address(anchor));

        // 3. GovernanceContract — single-governor 1-of-1 for L0 dev; multi-sig in P1
        address[] memory governors = new address[](1);
        governors[0] = deployer;
        GovernanceContract governance = new GovernanceContract(governors, 1);
        console2.log("GovernanceContract deployed:", address(governance));

        // Register all three contracts in the ContractRegistry
        registry.register(keccak256("ContractRegistry"), 1, address(registry));
        registry.register(keccak256("AnchorRegistry"), 1, address(anchor));
        registry.register(keccak256("GovernanceContract"), 1, address(governance));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== HaraLedger L0 contracts deployed ===");
        console2.log("ContractRegistry:    ", address(registry));
        console2.log("AnchorRegistry:      ", address(anchor));
        console2.log("GovernanceContract:  ", address(governance));
    }
}
