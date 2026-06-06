# hara-did — RPC endpoint migration packet (2026-05-31)

We moved the chain RPC tier onto a **dedicated host** (`hara-rpc-1`). Your write
endpoint changes. This is a coordinated WG + config change on your side; our side
is already prepared.

## 1. New endpoints (over the WG mesh)

| Use | Old (retiring) | **New** |
|---|---|---|
| Write | `http://10.43.0.20:8545/rpc/write` | **`http://10.43.0.21:8545/rpc/write`** |
| Read  | `http://10.43.0.20:8545/rpc/read`  | **`http://10.43.0.21:8545/rpc/read`** |
| WS    | `ws://10.43.0.20:8546/rpc/read`    | **`ws://10.43.0.21:8546/rpc/read`** |

(Postgres `pq_indexer_reader` at `10.43.0.40:5432` is **unchanged** — that host did not move.)

## 2. Add `hara-rpc-1` as a WireGuard peer on `hara-did-stg`

Append this block to `/etc/wireguard/wg0.conf` on your `did-stg` box:

```ini
[Peer]
# hara-rpc-1
PublicKey = kTKSTfFb6BqsMwnHhOj+/WLEFQhh238QDLk1puaAd30=
AllowedIPs = 10.43.0.21/32
Endpoint = 103.169.206.237:51820
PersistentKeepalive = 25
```

Then apply without dropping the interface:

```bash
sudo bash -c 'wg syncconf wg0 <(wg-quick strip /etc/wireguard/wg0.conf)'
```

> We have **already added `hara-did-stg` (10.43.0.50) as a peer on `hara-rpc-1`**,
> so the handshake establishes as soon as you apply the block above. No reply/pubkey
> exchange needed.

## 3. Verify

```bash
ping -c3 10.43.0.21
curl -s -X POST http://10.43.0.21:8545/rpc/write \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
```

Expect a `result` block height that tracks the chain (~190k+, advancing every 2s).

## 4. Cut over your config

Repoint your anchor-oracle / api-gateway RPC URL from `10.43.0.20` → `10.43.0.21`
and restart. Confirm anchoring works end-to-end.

## 5. Tell us when done

Once you confirm you're on `10.43.0.21` and healthy, we will **retire the old
`10.43.0.20` RPC path** and decommission the old host. Until then, **`10.43.0.20`
keeps working** — migrate at your own pace.

---
Contact: ops@haratrust.io
