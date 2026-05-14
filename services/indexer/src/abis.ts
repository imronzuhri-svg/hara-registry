import { parseAbi } from "viem";

/**
 * Registry of contract ABIs the indexer understands.
 * `watched_contracts.name` in Postgres → key in this map.
 *
 * Adding a new contract:
 *   1. Add an entry here (events only — full ABI not needed for indexing)
 *   2. INSERT INTO watched_contracts (...) VALUES ('0x...', 'NewContract')
 *   3. Restart indexer (picks up new ABI + address on startup)
 */

export const AbiRegistry = {
  ContractRegistry: parseAbi([
    "event ContractRegistered(bytes32 indexed name, uint64 indexed version, address addr)",
    "event ActiveVersionChanged(bytes32 indexed name, uint64 indexed version, address addr)",
    "event ContractDeactivated(bytes32 indexed name, uint64 indexed version)",
  ]),

  AnchorRegistry: parseAbi([
    "event AnchorRecorded(uint256 indexed anchorId, bytes32 merkleRoot, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain)",
    "event ExternalAnchorConfirmed(uint256 indexed anchorId, bytes32 anchorChain, bytes32 anchorTxHash)",
  ]),

  GovernanceContract: parseAbi([
    "event ProposalCreated(uint256 indexed id, address indexed proposer, address target, string description)",
    "event ProposalApproved(uint256 indexed id, address indexed approver, uint32 approvalCount)",
    "event ProposalExecuted(uint256 indexed id, bytes returnData)",
    "event ProposalCancelled(uint256 indexed id)",
    "event EmergencyPauseChanged(bool paused)",
    "event ApprovalThresholdChanged(uint32 oldThreshold, uint32 newThreshold)",
  ]),

  HaraPalmOil: parseAbi([
    "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
    "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
    "event BatchMinted(uint256 indexed batchId, address indexed firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)",
    "event BatchMetadataUpdated(uint256 indexed batchId, bytes32 newRspoCertificateHash)",
    "event ApprovalForAll(address indexed account, address indexed operator, bool approved)",
  ]),

  TraceabilityBatchRelay: parseAbi([
    "event ChainExecuted(address indexed token, uint256 indexed batchId, address indexed initiator, uint16 hopCount, address firstHolder, address finalHolder)",
  ]),
} as const;

export type AbiName = keyof typeof AbiRegistry;

export function getAbi(name: string) {
  return (AbiRegistry as Record<string, readonly unknown[]>)[name];
}
