// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ContractRegistry} from "../src/ContractRegistry.sol";
import {PQAnchorRegistry} from "../src/PQAnchorRegistry.sol";

/// @title  DeployGapuraPQAnchor
/// @notice Deploy a **Gapura-scoped** PQAnchorRegistry instance (model c — its own
///         instance, like Atlas) so Gapura's PQ key, anchor id-space, and key rotation
///         are independent of the platform anchor-worker's shared registry
///         (0x8A79...C318). Registered in ContractRegistry under
///         keccak256("GapuraPQAnchorRegistry") so it doesn't collide with the platform's
///         "PQAnchorRegistry" entry.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY    broadcaster key. Must hold REGISTRAR_ROLE on CONTRACT_REGISTRY
///                           if you want the auto-registration step to succeed (the platform
///                           admin 0x944b... does).
///   ADMIN_ADDRESS           DEFAULT_ADMIN_ROLE holder for the instance (governance).
///                           Defaults to the deployer. Also gets ANCHOR + KEY_ROTATOR via
///                           the constructor.
///   GATEWAY_ANCHOR_ADDRESS  the Gapura Gateway's ECDSA key address — granted ANCHOR_ROLE +
///                           KEY_ROTATOR_ROLE so it can anchor + rotate on this instance.
///   INITIAL_PQ_KEY_HASH     bytes32 = keccak256(Gapura's ML-DSA-65 public key). REQUIRED —
///                           derive with services/gapura-gateway/scripts/derive-pq-key.mjs.
///   INITIAL_PQ_ALGORITHM    default "ML-DSA-65".
///   CONTRACT_REGISTRY       shared ContractRegistry (0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512).
///                           If empty, registration is skipped.
///
/// Usage:
///   forge script script/DeployGapuraPQAnchor.s.sol:DeployGapuraPQAnchor \
///     --rpc-url https://rpc.ledger.haratrust.io/write/ --broadcast --legacy --skip-simulation
contract DeployGapuraPQAnchor is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address gateway = vm.envOr("GATEWAY_ANCHOR_ADDRESS", address(0));
        bytes32 initialPQKeyHash = vm.envOr("INITIAL_PQ_KEY_HASH", bytes32(0));
        string memory algo = vm.envOr("INITIAL_PQ_ALGORITHM", string("ML-DSA-65"));
        address registryAddr = vm.envOr("CONTRACT_REGISTRY", address(0));

        require(
            initialPQKeyHash != bytes32(0),
            "INITIAL_PQ_KEY_HASH unset - derive keccak256(ML-DSA-65 pubkey) first (see derive-pq-key.mjs)"
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        PQAnchorRegistry pq = new PQAnchorRegistry(admin, initialPQKeyHash, algo);
        console2.log("Gapura PQAnchorRegistry deployed:", address(pq));
        console2.log("  admin (DEFAULT_ADMIN):", admin);
        console2.log("  initialPQKeyHash:     ", vm.toString(initialPQKeyHash));
        console2.log("  algorithm:            ", algo);

        // Grant the Gateway's ECDSA key ANCHOR_ROLE + KEY_ROTATOR_ROLE on THIS instance.
        // Requires the broadcaster to hold DEFAULT_ADMIN_ROLE — true when admin == deployer.
        // If ADMIN_ADDRESS != deployer, run the two grantRole calls from the admin key after.
        if (gateway != address(0) && admin == deployer) {
            pq.grantRole(pq.ANCHOR_ROLE(), gateway);
            pq.grantRole(pq.KEY_ROTATOR_ROLE(), gateway);
            console2.log("Granted ANCHOR_ROLE + KEY_ROTATOR_ROLE to gateway:", gateway);
        } else if (gateway != address(0)) {
            console2.log("NOTE admin != deployer: grant ANCHOR+KEY_ROTATOR to gateway from the ADMIN key:", gateway);
        }

        if (registryAddr != address(0)) {
            ContractRegistry(registryAddr).register(keccak256("GapuraPQAnchorRegistry"), 1, address(pq));
            console2.log("Registered as 'GapuraPQAnchorRegistry' v1 in:", registryAddr);
        } else {
            console2.log("(CONTRACT_REGISTRY not set - skipped registry write)");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT ===");
        console2.log("1) Set the Gateway env  PQ_ANCHOR_REGISTRY =", address(pq));
        console2.log("2) Fund GATEWAY_ANCHOR_ADDRESS with > 0 HARA (recordAnchor sender needs balance > 0).");
        console2.log("3) Publish Gapura's ML-DSA-65 pubkey to CAS/MinIO keyed by the initialPQKeyHash.");
    }
}
