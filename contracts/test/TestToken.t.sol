// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract TestTokenTest is Test {
    TestToken token;

    address deployer = address(this);   // setUp() is the deployer
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address stranger = address(0xC0DE);

    function setUp() public {
        token = new TestToken();
    }

    // ── Metadata / supply ─────────────────────────────────────────────────

    function test_MetadataAndInitialSupply() public view {
        assertEq(token.name(),     "HaraTest");
        assertEq(token.symbol(),   "HTST");
        assertEq(token.decimals(), 18);

        uint256 expected = 1_000_000 * 10 ** 18;
        assertEq(token.totalSupply(),         expected);
        assertEq(token.balanceOf(deployer),   expected);
    }

    function test_DeployerHoldsBothRoles() public view {
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), deployer));
        assertTrue(token.hasRole(token.MINTER_ROLE(),        deployer));
    }

    // ── Mint ──────────────────────────────────────────────────────────────

    function test_MinterCanMint() public {
        uint256 amount = 500 * 10 ** 18;
        token.mint(alice, amount);
        assertEq(token.balanceOf(alice), amount);
        assertEq(token.totalSupply(),    1_000_000 * 10 ** 18 + amount);
    }

    function test_RevertWhen_NonMinterMints() public {
        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                minterRole
            )
        );
        token.mint(alice, 1);
    }

    function test_GrantedMinterCanMint() public {
        bytes32 minterRole = token.MINTER_ROLE();
        token.grantRole(minterRole, alice);
        vm.prank(alice);
        token.mint(bob, 42);
        assertEq(token.balanceOf(bob), 42);
    }

    // ── Transfer ──────────────────────────────────────────────────────────

    function test_Transfer() public {
        uint256 amount = 1000;
        token.transfer(alice, amount);
        assertEq(token.balanceOf(alice),    amount);
        assertEq(token.balanceOf(deployer), 1_000_000 * 10 ** 18 - amount);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        vm.prank(alice); // alice holds 0
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector,
                alice,
                uint256(0),
                uint256(1)
            )
        );
        token.transfer(bob, 1);
    }

    // ── Allowance / transferFrom ──────────────────────────────────────────

    function test_ApproveAndTransferFrom() public {
        uint256 amount = 500;
        token.approve(alice, amount);
        assertEq(token.allowance(deployer, alice), amount);

        vm.prank(alice);
        token.transferFrom(deployer, bob, amount);

        assertEq(token.balanceOf(bob), amount);
        assertEq(token.allowance(deployer, alice), 0);
    }

    function test_RevertWhen_TransferFromExceedsAllowance() public {
        token.approve(alice, 100);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                alice,
                uint256(100),
                uint256(101)
            )
        );
        token.transferFrom(deployer, bob, 101);
    }
}
