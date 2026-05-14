// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  GovernanceContract
/// @notice Permissioned governance for the HaraLedger chain. L0 ships a minimal
///         multi-sig-friendly version: any GOVERNANCE_ROLE holder can propose; an
///         M-of-N approval threshold executes. Real DAO governance lands in P2/L11.
///
///         Use cases this covers in L0:
///           - validator add / remove (off-chain QBFT vote can be coordinated here)
///           - contract upgrade approvals
///           - emergency pause flags (read by downstream contracts)
///           - admin role transfers
///
///         Proposal lifecycle:
///           propose() → approve()×threshold → execute()
contract GovernanceContract is AccessControl {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    enum ProposalState { Pending, Approved, Executed, Cancelled }

    struct Proposal {
        address proposer;
        address target;
        bytes callData;
        uint256 value;
        string description;
        uint64 createdAt;
        uint64 executedAt;
        ProposalState state;
        uint32 approvalCount;
    }

    uint32 public approvalThreshold;
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    /// proposalId => approver => approved?
    mapping(uint256 => mapping(address => bool)) public approvals;

    /// Emergency pause flag — downstream contracts can read this to halt sensitive ops.
    bool public emergencyPaused;

    event ProposalCreated(uint256 indexed id, address indexed proposer, address target, string description);
    event ProposalApproved(uint256 indexed id, address indexed approver, uint32 approvalCount);
    event ProposalExecuted(uint256 indexed id, bytes returnData);
    event ProposalCancelled(uint256 indexed id);
    event EmergencyPauseChanged(bool paused);
    event ApprovalThresholdChanged(uint32 oldThreshold, uint32 newThreshold);

    error AlreadyApproved();
    error NotApproved();
    error WrongState(ProposalState current);
    error ExecutionFailed(bytes returnData);
    error InvalidThreshold();

    constructor(address[] memory initialGovernors, uint32 initialThreshold) {
        if (initialThreshold == 0 || initialThreshold > initialGovernors.length) {
            revert InvalidThreshold();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        for (uint256 i = 0; i < initialGovernors.length; i++) {
            _grantRole(GOVERNANCE_ROLE, initialGovernors[i]);
        }
        approvalThreshold = initialThreshold;
    }

    function propose(address target, bytes calldata callData, uint256 value, string calldata description)
        external
        onlyRole(GOVERNANCE_ROLE)
        returns (uint256 id)
    {
        id = ++proposalCount;
        proposals[id] = Proposal({
            proposer: msg.sender,
            target: target,
            callData: callData,
            value: value,
            description: description,
            createdAt: uint64(block.timestamp),
            executedAt: 0,
            state: ProposalState.Pending,
            approvalCount: 0
        });
        emit ProposalCreated(id, msg.sender, target, description);

        // Proposer auto-approves
        _approve(id, msg.sender);
    }

    function approve(uint256 id) external onlyRole(GOVERNANCE_ROLE) {
        _approve(id, msg.sender);
    }

    function _approve(uint256 id, address approver) internal {
        Proposal storage p = proposals[id];
        if (p.state != ProposalState.Pending) revert WrongState(p.state);
        if (approvals[id][approver]) revert AlreadyApproved();
        approvals[id][approver] = true;
        p.approvalCount += 1;
        emit ProposalApproved(id, approver, p.approvalCount);

        if (p.approvalCount >= approvalThreshold) {
            p.state = ProposalState.Approved;
        }
    }

    function execute(uint256 id) external onlyRole(GOVERNANCE_ROLE) {
        Proposal storage p = proposals[id];
        if (p.state != ProposalState.Approved) revert WrongState(p.state);
        p.state = ProposalState.Executed;
        p.executedAt = uint64(block.timestamp);

        (bool success, bytes memory ret) = p.target.call{value: p.value}(p.callData);
        if (!success) revert ExecutionFailed(ret);
        emit ProposalExecuted(id, ret);
    }

    function cancel(uint256 id) external onlyRole(GOVERNANCE_ROLE) {
        Proposal storage p = proposals[id];
        if (p.state != ProposalState.Pending && p.state != ProposalState.Approved) {
            revert WrongState(p.state);
        }
        p.state = ProposalState.Cancelled;
        emit ProposalCancelled(id);
    }

    function setEmergencyPause(bool paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emergencyPaused = paused;
        emit EmergencyPauseChanged(paused);
    }

    function setApprovalThreshold(uint32 newThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newThreshold == 0) revert InvalidThreshold();
        emit ApprovalThresholdChanged(approvalThreshold, newThreshold);
        approvalThreshold = newThreshold;
    }

    receive() external payable {}
}
