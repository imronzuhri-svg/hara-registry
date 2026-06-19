"""Read a batch and its custody hops from the trace API (read-only).

Usage:
    export HARA_TRACE_USER=... HARA_TRACE_PASS=...
    python examples/read_batch.py <batch_id>
"""

from __future__ import annotations

import os
import sys

from hara_registry import HaraRegistry


def main() -> None:
    batch_id = sys.argv[1] if len(sys.argv) > 1 else None

    reg = HaraRegistry(
        trace_user=os.environ.get("HARA_TRACE_USER"),
        trace_pass=os.environ.get("HARA_TRACE_PASS"),
    )

    if batch_id is None:
        batches = reg.trace.list_batches(limit=5)
        print("Latest batches:")
        for b in batches:
            print(f"  {b.batch_id}: {b.initial_liters} L, holder={b.current_holder}")
        if not batches:
            return
        batch_id = batches[0].batch_id

    batch = reg.trace.get_batch(batch_id)
    print(f"\nBatch {batch.batch_id}")
    print(f"  origin   : {batch.first_owner}")
    print(f"  holder   : {batch.current_holder}")
    print(f"  liters   : {batch.initial_liters}")
    print(f"  hops     : {batch.hop_count}")
    print(f"  rspo     : {batch.rspo_hash}")

    hops = reg.trace.get_hops(batch_id)
    print(f"\nCustody trail ({len(hops)} hops):")
    for h in hops:
        print(f"  block {h.block_number}: {h.from_addr} -> {h.to_addr} ({h.liters} L)")


if __name__ == "__main__":
    main()
