"""Read on-chain state directly: chain height + an ERC-1155 batch balance.

Usage:
    python examples/balance.py <account_address> <batch_id>
"""

from __future__ import annotations

import sys

from hara_registry import HaraRegistry


def main() -> None:
    reg = HaraRegistry()

    print(f"chain id     : {reg.chain.get_chain_id()}")
    print(f"block number : {reg.chain.get_block_number()}")

    if len(sys.argv) < 3:
        print("\npass <account_address> <batch_id> to query a balance")
        return

    account = sys.argv[1]
    batch_id = int(sys.argv[2])

    litres = reg.palm_oil.balance_of(account, batch_id)
    print(f"\n{account} holds {litres} litres of batch {batch_id}")

    relay = reg.relay.address
    approved = reg.palm_oil.is_approved_for_all(account, relay)
    print(f"relay {relay} approved as operator: {approved}")


if __name__ == "__main__":
    main()
