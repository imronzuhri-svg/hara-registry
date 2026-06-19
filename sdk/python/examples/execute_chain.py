"""End-to-end write example: mint a batch, approve the relay, run a custody chain.

Demonstrates the full write convention on Hara Registry:
  - legacy type-0 txs, gasPrice 0, chainId 131216 (baked into the SDK)
  - every wallet must be pre-funded with >= 1 wei before its first tx
  - every tx is confirmed via wait_for_receipt() which raises on revert

The relay's trusted-relay model requires each intermediate holder to call
setApprovalForAll(relay, True) ONCE before they can be a custody hop.

Usage (DO NOT hardcode real keys — use env vars):
    export MINTER_KEY=0x...        # has MINTER_ROLE on HaraPalmOil
    export ORIGIN_KEY=0x...        # holders[0], the first owner
    python examples/execute_chain.py
"""

from __future__ import annotations

import os
import time

from web3 import Web3

from hara_registry import HaraRegistry


def main() -> None:
    minter_key = os.environ["MINTER_KEY"]
    origin_key = os.environ["ORIGIN_KEY"]

    reg = HaraRegistry()
    acct = reg.chain.w3.eth.account
    origin = acct.from_key(origin_key).address

    # Two downstream custodians (mill, refinery). Demo-only addresses.
    mill = Web3.to_checksum_address("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
    refinery = Web3.to_checksum_address("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")

    # Pre-fund guard: warns if any wallet has a zero balance.
    reg.chain.ensure_funded(origin)

    batch_id = int(time.time())  # unique-ish demo batch id
    litres = 1000

    # 1) Mint the batch to the origin holder (MINTER_ROLE).
    print(f"minting batch {batch_id} ({litres} L) to {origin} ...")
    txh = reg.palm_oil.mint_batch(
        minter_key,
        batch_id=batch_id,
        first_owner=origin,
        liters=litres,
        rspo_certificate_hash=b"\x11" * 32,
        plantation_id=b"\x22" * 32,
        production_date=int(time.time()),
    )
    reg.chain.wait_for_receipt(txh)
    print(f"  minted (tx {txh})")

    # 2) Origin approves the relay so it can move the batch on its behalf.
    relay_addr = reg.relay.address
    if not reg.palm_oil.is_approved_for_all(origin, relay_addr):
        print(f"approving relay {relay_addr} for {origin} ...")
        txh = reg.palm_oil.set_approval_for_all(origin_key, relay_addr, True)
        reg.chain.wait_for_receipt(txh)
        print(f"  approved (tx {txh})")

    # 3) Run the full custody chain in ONE atomic tx: origin -> mill -> refinery.
    #    (mill must also have approved the relay for the second hop.)
    holders = [origin, mill, refinery]
    print(f"executing chain {' -> '.join(holders)} ...")
    txh = reg.relay.execute_chain(
        origin_key,
        token=reg.palm_oil.address,
        batch_id=batch_id,
        amount=litres,
        holders=holders,
    )
    receipt = reg.chain.wait_for_receipt(txh)
    print(f"  chain executed in block {receipt['blockNumber']} (tx {txh})")

    final = reg.palm_oil.balance_of(refinery, batch_id)
    print(f"refinery now holds {final} L of batch {batch_id}")


if __name__ == "__main__":
    main()
