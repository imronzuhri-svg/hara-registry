// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/IssuerRegistry.sol";

contract IssuerRegistryTest is Test {
    IssuerRegistry reg;
    address admin     = address(0xA11CE);
    address registrar = address(0xB055);          // intended to be GovernanceContract in prod
    address controller = address(0xC1DE);

    bytes32 constant ISSUER_ID = keccak256("did:hara:iss:bri-bank");
    bytes32 constant PK_HASH   = keccak256("issuer-pubkey-v1");

    function setUp() public {
        reg = new IssuerRegistry(admin, registrar);
    }

    // ── Constructor + role grants ──────────────────────────────────────────

    function test_constructor_grants_admin_and_registrar() public view {
        assertTrue(reg.hasRole(reg.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(reg.hasRole(reg.REGISTRAR_ROLE(), registrar));
        assertFalse(reg.hasRole(reg.REGISTRAR_ROLE(), address(this)),
            "test contract must not have REGISTRAR_ROLE by default");
    }

    function test_constructor_with_zero_registrar_skips_grant() public {
        IssuerRegistry r2 = new IssuerRegistry(admin, address(0));
        assertFalse(r2.hasRole(r2.REGISTRAR_ROLE(), address(0)));
    }

    // ── addIssuer + access control ─────────────────────────────────────────

    function test_addIssuer_happy_path() public {
        vm.prank(registrar);
        reg.addIssuer(
            ISSUER_ID,
            IssuerRegistry.Role.FinancialServices,
            controller,
            PK_HASH,
            "ipfs://Qm.../issuer.json"
        );

        IssuerRegistry.Issuer memory i = reg.getIssuer(ISSUER_ID);
        assertEq(uint8(i.role),   uint8(IssuerRegistry.Role.FinancialServices));
        assertEq(uint8(i.status), uint8(IssuerRegistry.Status.Active));
        assertEq(i.controller,    controller);
        assertEq(i.publicKeyHash, PK_HASH);
        assertEq(i.metadataURI,   "ipfs://Qm.../issuer.json");
        assertEq(reg.issuerCount(), 1);
        assertEq(reg.issuerAt(0),   ISSUER_ID);
        assertTrue(reg.isActive(ISSUER_ID));
    }

    function test_addIssuer_emits_event_with_expected_topics() public {
        vm.expectEmit(true, false, false, true);
        emit IssuerRegistry.IssuerRegistered(
            ISSUER_ID,
            uint8(IssuerRegistry.Role.Government),
            controller,
            PK_HASH
        );
        vm.prank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Government, controller, PK_HASH, "");
    }

    function test_addIssuer_reverts_for_non_registrar() public {
        vm.expectRevert();
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Other, controller, PK_HASH, "");
    }

    function test_addIssuer_reverts_on_duplicate() public {
        vm.startPrank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Government, controller, PK_HASH, "");
        vm.expectRevert(IssuerRegistry.AlreadyExists.selector);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Government, controller, PK_HASH, "");
        vm.stopPrank();
    }

    // ── Status transitions ─────────────────────────────────────────────────

    function test_status_active_to_suspended_to_active() public {
        vm.startPrank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Education, controller, PK_HASH, "");
        reg.setIssuerStatus(ISSUER_ID, IssuerRegistry.Status.Suspended);
        assertFalse(reg.isActive(ISSUER_ID));
        reg.setIssuerStatus(ISSUER_ID, IssuerRegistry.Status.Active);
        assertTrue(reg.isActive(ISSUER_ID));
        vm.stopPrank();
    }

    function test_status_revoked_is_terminal() public {
        vm.startPrank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Healthcare, controller, PK_HASH, "");
        reg.setIssuerStatus(ISSUER_ID, IssuerRegistry.Status.Revoked);
        vm.expectRevert(
            abi.encodeWithSelector(
                IssuerRegistry.InvalidTransition.selector,
                uint8(IssuerRegistry.Status.Revoked),
                uint8(IssuerRegistry.Status.Active)
            )
        );
        reg.setIssuerStatus(ISSUER_ID, IssuerRegistry.Status.Active);
        vm.stopPrank();
    }

    function test_status_active_to_active_is_invalid() public {
        vm.startPrank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Healthcare, controller, PK_HASH, "");
        vm.expectRevert();
        reg.setIssuerStatus(ISSUER_ID, IssuerRegistry.Status.Active);
        vm.stopPrank();
    }

    function test_status_change_reverts_for_unregistered_issuer() public {
        vm.expectRevert(IssuerRegistry.NotFound.selector);
        vm.prank(registrar);
        reg.setIssuerStatus(keccak256("unknown"), IssuerRegistry.Status.Suspended);
    }

    // ── Key rotation ───────────────────────────────────────────────────────

    function test_rotateKey_by_controller() public {
        vm.prank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Telecom, controller, PK_HASH, "");
        bytes32 newKey = keccak256("issuer-pubkey-v2");
        vm.prank(controller);
        reg.rotateIssuerKey(ISSUER_ID, newKey);
        assertEq(reg.getIssuer(ISSUER_ID).publicKeyHash, newKey);
    }

    function test_rotateKey_by_registrar() public {
        vm.prank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Telecom, controller, PK_HASH, "");
        bytes32 newKey = keccak256("emergency-pubkey");
        vm.prank(registrar);
        reg.rotateIssuerKey(ISSUER_ID, newKey);
        assertEq(reg.getIssuer(ISSUER_ID).publicKeyHash, newKey);
    }

    function test_rotateKey_rejects_random_caller() public {
        vm.prank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Telecom, controller, PK_HASH, "");
        vm.expectRevert();
        reg.rotateIssuerKey(ISSUER_ID, keccak256("hacker"));
    }

    function test_rotateKey_emits_old_and_new_hash() public {
        vm.prank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Telecom, controller, PK_HASH, "");
        bytes32 newKey = keccak256("v2");
        vm.expectEmit(true, false, false, true);
        emit IssuerRegistry.IssuerKeyRotated(ISSUER_ID, PK_HASH, newKey);
        vm.prank(controller);
        reg.rotateIssuerKey(ISSUER_ID, newKey);
    }

    // ── Metadata updates ───────────────────────────────────────────────────

    function test_setMetadata_replaces_uri() public {
        vm.startPrank(registrar);
        reg.addIssuer(ISSUER_ID, IssuerRegistry.Role.Other, controller, PK_HASH, "initial");
        reg.setIssuerMetadata(ISSUER_ID, "https://issuer.example/.well-known/issuer.json");
        vm.stopPrank();
        assertEq(reg.getIssuer(ISSUER_ID).metadataURI, "https://issuer.example/.well-known/issuer.json");
    }

    // ── Role admin ─────────────────────────────────────────────────────────

    function test_admin_can_grant_and_revoke_registrar() public {
        // Cache the role hash up-front. `vm.prank` only persists for the NEXT
        // external call; if we did `reg.grantRole(reg.REGISTRAR_ROLE(), …)`,
        // Solidity would resolve the inner getter first (consuming the prank)
        // and then the outer mutator would run unpranked.
        bytes32 registrarRole = reg.REGISTRAR_ROLE();
        address newReg = address(0x99);

        vm.prank(admin);
        reg.grantRole(registrarRole, newReg);
        assertTrue(reg.hasRole(registrarRole, newReg));

        vm.prank(newReg);
        reg.addIssuer(keccak256("did:hara:iss:newone"), IssuerRegistry.Role.Community, controller, PK_HASH, "");

        vm.prank(admin);
        reg.revokeRole(registrarRole, newReg);
        assertFalse(reg.hasRole(registrarRole, newReg));
    }

    function test_non_admin_cannot_grant_role() public {
        bytes32 registrarRole = reg.REGISTRAR_ROLE();
        vm.prank(controller);
        vm.expectRevert();
        reg.grantRole(registrarRole, controller);
    }
}
