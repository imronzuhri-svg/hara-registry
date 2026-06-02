// Proposal builders — turn an operator's intent into the exact, reviewable
// command they should run. NOTHING is executed or signed here (propose-only).
import { ADMIN, FUNDER, WRITE_RPC, CONTRACTS, roleHashExpr, isAddress } from "./contracts.js";

export type Risk = "low" | "medium" | "high";

export interface Proposal {
  kind: string;
  title: string;
  summary: string;
  risk: Risk;
  commands: string[]; // one or more shell commands the operator runs
  notes: string[];
}

const COMMON = `--rpc-url ${WRITE_RPC} --legacy --gas-price 0`;

function need(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function buildFund(p: { to: string; amountEth: string }): Proposal {
  need(isAddress(p.to), "invalid 'to' address");
  need(/^\d+(\.\d+)?$/.test(p.amountEth), "invalid amount");
  return {
    kind: "fund",
    title: "Fund account",
    summary: `Send ${p.amountEth} HARA to ${p.to} from the genesis funder`,
    risk: "low",
    commands: [`cast send ${p.to} --value ${p.amountEth}ether ${COMMON} --private-key $HARA_FUNDER_KEY`],
    notes: [
      `Funder = anvil-1 ${FUNDER} (genesis, public key). Set $HARA_FUNDER_KEY in your shell.`,
      "Gas is free, so a one-time balance is never consumed — this fixes the zero-balance tx-skip.",
      "Verify after: cast balance <to> --rpc-url https://rpc.ledger.haratrust.io/read/",
    ],
  };
}

export function buildRegister(p: { name: string; version: number; address: string }): Proposal {
  need(!!p.name && p.name.length <= 31, "name required (<=31 bytes for bytes32)");
  need(Number.isInteger(p.version) && p.version >= 0, "version must be a non-negative integer");
  need(isAddress(p.address), "invalid contract address");
  const reg = CONTRACTS.ContractRegistry.address;
  return {
    kind: "register",
    title: "Register contract in ContractRegistry",
    summary: `register("${p.name}", v${p.version}, ${p.address})`,
    risk: "medium",
    commands: [
      `cast send ${reg} "register(bytes32,uint64,address)" $(cast format-bytes32-string "${p.name}") ${p.version} ${p.address} ${COMMON} --private-key $HARA_REGISTRAR_KEY`,
    ],
    notes: [
      `Needs REGISTRAR_ROLE — the platform admin ${ADMIN} holds it ($HARA_REGISTRAR_KEY = admin or a delegated registrar).`,
      "name is bytes32 (cast format-bytes32-string); confirm the version is new for this name.",
    ],
  };
}

export function buildGrantRole(p: { contract: string; role: string; account: string; revoke?: boolean }): Proposal {
  const meta = CONTRACTS[p.contract];
  need(!!meta, `unknown contract '${p.contract}'`);
  need(meta!.roles.includes(p.role), `role '${p.role}' not valid for ${p.contract}`);
  need(isAddress(p.account), "invalid account address");
  const fn = p.revoke ? "revokeRole" : "grantRole";
  return {
    kind: p.revoke ? "revokeRole" : "grantRole",
    title: `${p.revoke ? "Revoke" : "Grant"} ${p.role} on ${p.contract}`,
    summary: `${fn}(${p.role}, ${p.account}) @ ${meta!.address}`,
    risk: "high",
    commands: [
      `cast send ${meta!.address} "${fn}(bytes32,address)" ${roleHashExpr(p.role)} ${p.account} ${COMMON} --private-key $HARA_ADMIN_KEY`,
    ],
    notes: [
      `Uses the platform ADMIN key (${ADMIN}). HIGH RISK — admin authority.`,
      !p.revoke ? "Follow the grant → use → revoke pattern: revoke the role once the task is done." : "",
      "Until the P2 Gnosis Safe multisig lands, admin actions are single-key — double-check the account.",
    ].filter(Boolean),
  };
}

export function buildOnboard(p: {
  label: string;
  address: string;
  amountEth: string;
  roles?: { contract: string; role: string }[];
  register?: { name: string; version: number };
}): Proposal {
  need(!!p.label, "label required");
  need(isAddress(p.address), "invalid deployer address");
  const commands: string[] = [buildFund({ to: p.address, amountEth: p.amountEth }).commands[0]];
  const notes: string[] = [`Onboarding "${p.label}" (deployer ${p.address}).`, "Step 1 funds the deployer (avoids the zero-balance hang)."];
  for (const r of p.roles ?? []) {
    commands.push(buildGrantRole({ contract: r.contract, role: r.role, account: p.address }).commands[0]);
    notes.push(`Grants ${r.role} on ${r.contract} (admin key; revoke when done).`);
  }
  if (p.register) {
    commands.push(buildRegister({ name: p.register.name, version: p.register.version, address: p.address }).commands[0]);
    notes.push(`Registers "${p.register.name}" v${p.register.version} in ContractRegistry.`);
  }
  notes.push("Hand the partner doc/hara-xchange-deploy-guide.md (template), pre-filled with their address.");
  return {
    kind: "onboard",
    title: `Onboard partner: ${p.label}`,
    summary: `fund ${p.amountEth} HARA${(p.roles?.length ?? 0) ? " + " + p.roles!.length + " role(s)" : ""}${p.register ? " + registry" : ""}`,
    risk: (p.roles?.length ?? 0) ? "high" : "low",
    commands,
    notes,
  };
}

export function buildSnapshot(p: { host: string; unit: string }): Proposal {
  need(/^[a-z0-9.-]+$/i.test(p.host), "invalid host");
  need(/^hara-[a-z-]+-snapshot$/.test(p.unit), "unit must be a hara-*-snapshot service");
  const isValidator = p.unit.includes("validator");
  return {
    kind: "snapshot",
    title: `Trigger ${p.unit} on ${p.host}`,
    summary: `on-demand ${p.unit}`,
    risk: isValidator ? "high" : "medium",
    commands: [`ssh ${p.host} "sudo systemctl start ${p.unit}.service && journalctl -u ${p.unit}.service -n 20 --no-pager"`],
    notes: isValidator
      ? ["⚠ The validator snapshot STOPS the validator while it archives. Run ONE at a time (QBFT needs 3/4)."]
      : ["Safe — no service downtime (Postgres/Vault snapshots stream live)."],
  };
}

export function buildProposal(kind: string, params: Record<string, unknown>): Proposal {
  switch (kind) {
    case "fund":
      return buildFund(params as any);
    case "register":
      return buildRegister(params as any);
    case "grantRole":
      return buildGrantRole(params as any);
    case "revokeRole":
      return buildGrantRole({ ...(params as any), revoke: true });
    case "onboard":
      return buildOnboard(params as any);
    case "snapshot":
      return buildSnapshot(params as any);
    default:
      throw new Error(`unknown proposal kind '${kind}'`);
  }
}
