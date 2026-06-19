"""Subscribe to new blocks over the JSON-RPC WebSocket endpoint.

Hara Registry exposes ``wss://rpc.ledger.haratrust.io/ws`` for ``eth_subscribe``
(newHeads / logs). This uses web3.py's WebSocket provider.

Requires web3 with websockets support (``pip install 'web3[ws]'`` or just
``websockets``). Run:

    python examples/subscribe.py
"""

from __future__ import annotations

import asyncio

from web3 import AsyncWeb3
from web3.providers.persistent import WebSocketProvider

from hara_registry import config


async def watch_new_heads() -> None:
    async with AsyncWeb3(WebSocketProvider(config.RPC_WS_URL)) as w3:
        print(f"connected to {config.RPC_WS_URL}; chain id {await w3.eth.chain_id}")
        sub_id = await w3.eth.subscribe("newHeads")
        print(f"subscribed to newHeads ({sub_id}); waiting for blocks ...")

        async for message in w3.socket.process_subscriptions():
            head = message["result"]
            number = int(head["number"], 16)
            print(f"new block #{number}  hash={head['hash'].hex()}")


def main() -> None:
    try:
        asyncio.run(watch_new_heads())
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
