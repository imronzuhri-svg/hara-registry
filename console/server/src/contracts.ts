// Static chain/contract metadata used to BUILD privileged-action commands.
// Propose-only: the console never signs — it emits the exact `cast` command for
// the operator to run with the appropriate key. Addresses from state-4 §6.

export const ADMIN = "0x944b237097A03E1e8CdE8A0F46605506319EC329"; // DEFAULT_ADMIN_ROLE holder
export const FUNDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil-1 genesis funder (public key)
// Public write endpoint operators run `cast` against (trailing slash required).
export const WRITE_RPC = "https://rpc.ledger.haratrust.io/write/";

export interface ContractMeta {
  address: string;
  roles: string[]; // role constant names (keccak256(name)); DEFAULT_ADMIN_ROLE = 0x00..0
}

export const CONTRACTS: Record<string, ContractMeta> = {
  HaraPalmOil: { address: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853", roles: ["MINTER_ROLE", "CERTIFIER_ROLE", "DEFAULT_ADMIN_ROLE"] },
  TraceabilityBatchRelay: { address: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6", roles: ["DEFAULT_ADMIN_ROLE"] },
  PQAnchorRegistry: { address: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", roles: ["ANCHOR_ROLE", "KEY_ROTATOR_ROLE", "DEFAULT_ADMIN_ROLE"] },
  ContractRegistry: { address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", roles: ["REGISTRAR_ROLE", "DEFAULT_ADMIN_ROLE"] },
  GovernanceContract: { address: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9", roles: ["GOVERNANCE_ROLE", "DEFAULT_ADMIN_ROLE"] },
  AnchorRegistry: { address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", roles: ["ANCHOR_ROLE", "DEFAULT_ADMIN_ROLE"] },
};

/** A cast-compatible expression for a role hash (computed at run time on the operator's box). */
export const roleHashExpr = (role: string): string =>
  role === "DEFAULT_ADMIN_ROLE"
    ? "0x0000000000000000000000000000000000000000000000000000000000000000"
    : `$(cast keccak "${role}")`;

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);
