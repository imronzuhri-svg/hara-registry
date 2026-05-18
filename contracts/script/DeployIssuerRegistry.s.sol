// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ContractRegistry} from "../src/ContractRegistry.sol";
import {IssuerRegistry} from "../src/IssuerRegistry.sol";

/// @title  DeployIssuerRegistry
/// @notice Deploy IssuerRegistry and register it in an existing ContractRegistry.
///         Mirrors the DeployPQAnchor pattern: standalone, env-driven, optional
///         ContractRegistry write.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY     hex private key for the broadcaster (anvil #0 default).
///   CONTRACT_REGISTRY        address of an already-deployed ContractRegistry.
///                            If empty, the IssuerRegistry is deployed standalone
///                            (no registry write).
///   INITIAL_REGISTRAR        address that gets REGISTRAR_ROLE at deploy. In
///                            production this should be a deployed
///                            GovernanceContract address so onboarding requires
///                            an M-of-N proposal (per state-2 §11 governance plan).
///                            Defaults to the deployer for dev.
///
/// Usage:
///   forge script script/DeployIssuerRegistry.s.sol:DeployIssuerRegistry \
///     --rpc-url http://rpc-write:8545 --broadcast --legacy --skip-simulation
contract DeployIssuerRegistry is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);

        address registryAddr = vm.envOr("CONTRACT_REGISTRY", address(0));
        address initialRegistrar = vm.envOr("INITIAL_REGISTRAR", deployer);

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        IssuerRegistry issuers = new IssuerRegistry(deployer, initialRegistrar);
        console2.log("IssuerRegistry deployed:", address(issuers));
        console2.log("  admin (DEFAULT_ADMIN_ROLE):", deployer);
        console2.log("  initial REGISTRAR_ROLE:    ", initialRegistrar);

        if (registryAddr != address(0)) {
            ContractRegistry(registryAddr).register(
                keccak256("IssuerRegistry"),
                1,
                address(issuers)
            );
            console2.log("Registered in ContractRegistry at:", registryAddr);
        } else {
            console2.log("(CONTRACT_REGISTRY not set - skipped registry write)");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== IssuerRegistry deployed ===");
        console2.log("IssuerRegistry: ", address(issuers));
        if (initialRegistrar == deployer) {
            console2.log("");
            console2.log("NOTE: REGISTRAR_ROLE was granted to the deployer for dev.");
            console2.log("In production, set INITIAL_REGISTRAR to the GovernanceContract");
            console2.log("address so issuer onboarding requires an M-of-N proposal.");
        }
    }
}
