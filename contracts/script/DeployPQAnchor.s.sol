// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ContractRegistry} from "../src/ContractRegistry.sol";
import {PQAnchorRegistry} from "../src/PQAnchorRegistry.sol";

/// @title  DeployPQAnchor
/// @notice Deploy PQAnchorRegistry and register it in an existing ContractRegistry.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY     hex private key for the broadcaster (e.g. anvil #0).
///   CONTRACT_REGISTRY        address of an already-deployed ContractRegistry.
///                            If empty, registry registration is skipped (the
///                            PQAnchorRegistry is still deployed standalone).
///   INITIAL_PQ_KEY_HASH      bytes32 hex; the keccak256 of the bootstrap PQ
///                            public key bytes. Defaults to a clearly-labelled
///                            placeholder — operator MUST rotate before any
///                            real anchor goes through (via KEY_ROTATOR_ROLE).
///   INITIAL_PQ_ALGORITHM     string label, default "ML-DSA-65" per ADR-0010.
///
/// Usage:
///   forge script script/DeployPQAnchor.s.sol:DeployPQAnchor \
///     --rpc-url http://rpc-write:8545 --broadcast --legacy --skip-simulation
contract DeployPQAnchor is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);

        address registryAddr = vm.envOr("CONTRACT_REGISTRY", address(0));

        bytes32 initialPQKeyHash = vm.envOr(
            "INITIAL_PQ_KEY_HASH",
            keccak256("BOOTSTRAP_PQ_KEY_PLACEHOLDER_V0_ROTATE_BEFORE_USE")
        );
        string memory algo = vm.envOr("INITIAL_PQ_ALGORITHM", string("ML-DSA-65"));

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        PQAnchorRegistry pq = new PQAnchorRegistry(deployer, initialPQKeyHash, algo);
        console2.log("PQAnchorRegistry deployed:", address(pq));
        console2.log("  initial PQ key hash:    ", vm.toString(initialPQKeyHash));
        console2.log("  algorithm:              ", algo);

        if (registryAddr != address(0)) {
            ContractRegistry(registryAddr).register(
                keccak256("PQAnchorRegistry"),
                1,
                address(pq)
            );
            console2.log("Registered in ContractRegistry at:", registryAddr);
        } else {
            console2.log("(CONTRACT_REGISTRY not set - skipped registry write)");
        }

        // Optional: if ANCHOR_WORKER_ADDRESS is set, grant ANCHOR_ROLE + KEY_ROTATOR_ROLE
        // to it at deploy time. Closes a real cold-start footgun: the worker
        // cold-starts by trying to rotate the placeholder PQ key hash, but
        // can't unless it has KEY_ROTATOR_ROLE. Without this env, the worker
        // refuses to start on first run until the operator hand-grants the
        // roles via `cast send ... grantRole(...)`. Set the env in CI/Compose
        // when the worker address is known up-front.
        address workerAddr = vm.envOr("ANCHOR_WORKER_ADDRESS", address(0));
        if (workerAddr != address(0)) {
            pq.grantRole(pq.ANCHOR_ROLE(), workerAddr);
            pq.grantRole(pq.KEY_ROTATOR_ROLE(), workerAddr);
            console2.log("Granted ANCHOR_ROLE + KEY_ROTATOR_ROLE to:", workerAddr);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== PQAnchorRegistry deployed ===");
        console2.log("PQAnchorRegistry: ", address(pq));
        console2.log("");
        console2.log("WARNING: bootstrap PQ key is a placeholder. Rotate to a");
        console2.log("real ML-DSA-65 public-key hash via rotatePQKey() before");
        console2.log("any production anchor. See ADR-0010.");
    }
}
