// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TestToken} from "../src/TestToken.sol";

contract DeployTestToken is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        TestToken t = new TestToken();
        console2.log("TestToken deployed at:", address(t));
        vm.stopBroadcast();
    }
}
