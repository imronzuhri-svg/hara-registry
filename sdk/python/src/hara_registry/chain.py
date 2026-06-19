"""Low-level chain access for Hara Registry.

``ChainClient`` wraps web3.py and bakes in the three rules that bite every
integrator on this chain:

1. **Legacy (type-0) txs, ``gasPrice=0``, ``chainId=131216``** — always.
   EIP-1559 fields are rejected by the Besu nodes.
2. **Pre-fund every wallet with >= 1 wei native HARA before its first tx.**
   Besu silently skips zero-balance senders even at ``gasPrice 0`` — the tx
   sits unmined and your tool hangs. ``ensure_funded`` warns about this.
3. **Verify ``receipt.status == 0x1``.** A mined tx can still have reverted;
   ``wait_for_receipt`` raises if it did.

Reads use a ``Web3(HTTPProvider(read_url))`` (cached ``/read/`` endpoint).
Raw signed transactions are POSTed to the ``/write/`` endpoint.
"""

from __future__ import annotations

import warnings
from typing import Any, Optional

from web3 import Web3
from web3.exceptions import TransactionNotFound
from web3.types import TxParams, TxReceipt

from . import config


class ZeroBalanceWarning(UserWarning):
    """Raised (as a warning) when a sender has zero native balance.

    A zero-balance sender is silently dropped by Besu — pre-fund it first.
    """


class ReceiptStatusError(RuntimeError):
    """A transaction was mined but reverted (``receipt.status != 1``)."""

    def __init__(self, tx_hash: str, receipt: TxReceipt) -> None:
        self.tx_hash = tx_hash
        self.receipt = receipt
        super().__init__(
            f"transaction {tx_hash} reverted: receipt.status="
            f"{receipt.get('status')!r} (expected 1)"
        )


class ChainClient:
    """Web3 wrapper preconfigured for the Hara Registry chain.

    Args:
        read_url: JSON-RPC read endpoint (cached ``/read/``). Defaults to the
            public endpoint.
        write_url: JSON-RPC write endpoint (``/write/``) where raw signed
            transactions are submitted. Defaults to the public endpoint.
        request_timeout: HTTP timeout (seconds) for the underlying provider.
    """

    def __init__(
        self,
        read_url: str = config.RPC_READ_URL,
        write_url: str = config.RPC_WRITE_URL,
        request_timeout: float = 30.0,
    ) -> None:
        self.read_url = read_url
        self.write_url = write_url
        self.chain_id = config.CHAIN_ID

        self.w3 = Web3(
            Web3.HTTPProvider(read_url, request_kwargs={"timeout": request_timeout})
        )
        # Writes go to a separate endpoint; reuse a provider pointed at /write/.
        self._write_w3 = Web3(
            Web3.HTTPProvider(write_url, request_kwargs={"timeout": request_timeout})
        )

    # -- reads --------------------------------------------------------------

    def get_block_number(self) -> int:
        """Current block height (``eth_blockNumber``)."""
        return self.w3.eth.block_number

    def get_chain_id(self) -> int:
        """Chain ID as reported by the node (``eth_chainId``)."""
        return self.w3.eth.chain_id

    def get_balance(self, address: str) -> int:
        """Native HARA balance of ``address`` in wei."""
        return self.w3.eth.get_balance(Web3.to_checksum_address(address))

    def get_transaction_count(self, address: str) -> int:
        """Pending nonce for ``address`` (``eth_getTransactionCount``)."""
        return self.w3.eth.get_transaction_count(
            Web3.to_checksum_address(address), "pending"
        )

    # -- funding guard ------------------------------------------------------

    def ensure_funded(self, address: str) -> int:
        """Return the balance, warning if it is zero.

        Besu silently drops transactions from zero-balance senders even though
        gas is free — pre-fund every wallet with >= 1 wei before its first tx.
        """
        balance = self.get_balance(address)
        if balance == 0:
            warnings.warn(
                f"address {Web3.to_checksum_address(address)} has a zero native "
                "balance. Besu silently drops zero-balance senders even at "
                "gasPrice 0 — pre-fund it with >= 1 wei HARA before its first tx "
                "or the transaction will sit unmined.",
                ZeroBalanceWarning,
                stacklevel=2,
            )
        return balance

    # -- writes -------------------------------------------------------------

    def send_legacy_tx(
        self,
        private_key: str,
        to: str,
        data: bytes | str = b"",
        value: int = 0,
        gas: Optional[int] = None,
        nonce: Optional[int] = None,
    ) -> str:
        """Build, sign and submit a legacy (type-0) transaction.

        Bakes in ``gasPrice=0``, ``chainId=131216`` and ``type=0`` — the only
        transaction shape this chain accepts. Signs locally with ``private_key``
        and POSTs the raw tx to the ``/write/`` endpoint via
        ``eth_sendRawTransaction``.

        Args:
            private_key: Hex private key of the sender (with or without ``0x``).
            to: Destination address (e.g. a contract).
            data: Calldata as bytes or a ``0x`` hex string.
            value: Native value in wei (almost always 0 on this chain).
            gas: Optional gas limit. If omitted, it is estimated via the read
                node and a 25% headroom is applied.
            nonce: Optional nonce. If omitted, the pending nonce is fetched.

        Returns:
            The transaction hash as a ``0x`` hex string.
        """
        account = self.w3.eth.account.from_key(private_key)
        sender = account.address

        # Funding guard — surface the zero-balance footgun before we submit.
        self.ensure_funded(sender)

        if isinstance(data, str):
            data_bytes: bytes = bytes.fromhex(data[2:] if data.startswith("0x") else data)
        else:
            data_bytes = data

        if nonce is None:
            nonce = self.get_transaction_count(sender)

        tx: TxParams = {
            "type": config.TX_TYPE_LEGACY,  # legacy / type-0
            "chainId": config.CHAIN_ID,
            "nonce": nonce,
            "to": Web3.to_checksum_address(to),
            "value": value,
            "gasPrice": config.GAS_PRICE,  # always 0
            "data": data_bytes,
        }

        if gas is None:
            estimated = self.w3.eth.estimate_gas(
                {
                    "from": sender,
                    "to": tx["to"],
                    "value": value,
                    "data": data_bytes,
                }
            )
            gas = int(estimated * 1.25)
        tx["gas"] = gas

        signed = account.sign_transaction(tx)
        # Submit the RAW signed tx to the write endpoint.
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = self._write_w3.eth.send_raw_transaction(raw)
        return tx_hash.hex()

    def wait_for_receipt(
        self,
        tx_hash: str,
        timeout: float = 120.0,
        poll_latency: float = 1.0,
    ) -> TxReceipt:
        """Wait for a receipt and raise if the transaction reverted.

        Polls the read node for ``tx_hash`` and raises
        :class:`ReceiptStatusError` if ``receipt.status != 1`` — a mined tx can
        still have reverted, and silently ignoring that is a common bug.
        """
        receipt = self.w3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=timeout, poll_latency=poll_latency
        )
        if receipt.get("status") != 1:
            raise ReceiptStatusError(tx_hash, receipt)
        return receipt

    def get_receipt(self, tx_hash: str) -> Optional[TxReceipt]:
        """Return the receipt for ``tx_hash`` or ``None`` if not yet mined."""
        try:
            return self.w3.eth.get_transaction_receipt(tx_hash)
        except TransactionNotFound:
            return None

    # -- contract helper ----------------------------------------------------

    def contract(self, address: str, abi: list[dict[str, Any]]) -> Any:
        """Build a read-side ``web3`` contract bound to the read node."""
        return self.w3.eth.contract(
            address=Web3.to_checksum_address(address), abi=abi
        )
