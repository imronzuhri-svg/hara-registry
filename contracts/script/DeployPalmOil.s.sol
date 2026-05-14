// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HaraPalmOil} from "../src/HaraPalmOil.sol";
import {TraceabilityBatchRelay} from "../src/TraceabilityBatchRelay.sol";

contract DeployPalmOil is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        HaraPalmOil token = new HaraPalmOil(deployer);
        TraceabilityBatchRelay relay = new TraceabilityBatchRelay();

        vm.stopBroadcast();

        console2.log("HaraPalmOil deployed:           ", address(token));
        console2.log("TraceabilityBatchRelay deployed:", address(relay));
    }
}
