// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @title  TraceabilityBatchRelay
/// @notice Executes a chain of N safeTransferFrom calls in a single transaction.
///
///         Why it exists:
///           - Besu QBFT's mempool doesn't preserve strict insertion order
///             across blocks, so pre-signing N dependent transfers and flooding
///             the mempool ends up with most reverting (we verified this).
///           - Forcing each hop to wait for receipt is correct but slow
///             (~4 seconds/hop on a 2-second-block chain).
///           - This relay does all N hops in ONE tx, atomically, in ONE block.
///             ~50ms total for 100 hops vs ~7 minutes sequential.
///
///         Trust model:
///           Each intermediate holder must call setApprovalForAll(relay, true)
///           ONCE before they can be a custody hop. After that, this relay can
///           move tokens FROM that holder. So this is a "trusted relay" model —
///           appropriate for permissioned consortia where the relay's caller is
///           an accredited body (RSPO auditor, BPJPH-licensed traceability
///           operator). For trustless models, use the EIP-712 signed-permits
///           variant (not implemented here; see roadmap).
///
///         Auditability:
///           Each hop emits a canonical ERC-1155 TransferSingle event from the
///           token contract. The audit trail is identical to the sequential
///           pattern — auditors see the same chain of Transfer events.
///           In addition, this relay emits a single ChainExecuted event with
///           the path summary for fast off-chain indexing.
contract TraceabilityBatchRelay {
    event ChainExecuted(
        IERC1155 indexed token,
        uint256 indexed batchId,
        address indexed initiator,
        uint16 hopCount,
        address firstHolder,
        address finalHolder
    );

    error LengthMismatch();
    error EmptyChain();

    /// @notice Move tokens through a chain of N+1 holders in one tx.
    ///         holders[0] is the current owner; holders[holders.length-1] is the final custodian.
    ///         amount stays constant — used when the full volume moves at each hop (most palm-oil traceability).
    function executeChain(
        IERC1155 token,
        uint256 batchId,
        uint256 amount,
        address[] calldata holders
    ) external {
        uint256 n = holders.length;
        if (n < 2) revert EmptyChain();

        for (uint256 i = 0; i < n - 1; ++i) {
            token.safeTransferFrom(holders[i], holders[i + 1], batchId, amount, "");
        }

        emit ChainExecuted(token, batchId, msg.sender, uint16(n - 1), holders[0], holders[n - 1]);
    }

    /// @notice Same as executeChain, but each hop has its own amount (for chains
    ///         where each custodian takes a cut or distributes partial volumes).
    function executeChainVariable(
        IERC1155 token,
        uint256 batchId,
        address[] calldata holders,
        uint256[] calldata amounts
    ) external {
        uint256 n = holders.length;
        if (n < 2) revert EmptyChain();
        if (amounts.length != n - 1) revert LengthMismatch();

        for (uint256 i = 0; i < n - 1; ++i) {
            token.safeTransferFrom(holders[i], holders[i + 1], batchId, amounts[i], "");
        }

        emit ChainExecuted(token, batchId, msg.sender, uint16(n - 1), holders[0], holders[n - 1]);
    }

    /// @notice Execute an arbitrary DAG of custody hops in one transaction.
    ///         For each i, transfers `amounts[i]` from `froms[i]` to `tos[i]` for the same batchId.
    ///         Hops MUST be in topological order — each intermediate node must have received
    ///         enough volume BEFORE its outgoing hops are processed. Caller's responsibility.
    ///
    ///         Use this for split/merge patterns (refinery flows, blending operations) where
    ///         a single batch goes through tank operations: 1 source → N receiving → M holding
    ///         → fanout to processing lines → blend into K output batches.
    ///
    ///         Mass balance is enforced automatically by ERC-1155 balance semantics — any
    ///         intermediate node that hasn't received enough volume will cause the whole tx
    ///         to revert.
    function executeHops(
        IERC1155 token,
        uint256 batchId,
        address[] calldata froms,
        address[] calldata tos,
        uint256[] calldata amounts
    ) external {
        uint256 n = froms.length;
        if (n == 0) revert EmptyChain();
        if (tos.length != n || amounts.length != n) revert LengthMismatch();

        for (uint256 i = 0; i < n; ++i) {
            token.safeTransferFrom(froms[i], tos[i], batchId, amounts[i], "");
        }

        emit ChainExecuted(token, batchId, msg.sender, uint16(n), froms[0], tos[n - 1]);
    }
}
