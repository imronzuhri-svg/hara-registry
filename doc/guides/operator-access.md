# Hara Infrastructure — Server Access

Onboarding for team members granted SSH access to the Hara server fleet. You log in
with the SSH key you generated and sent the admin — nothing else to set up.

Accounts are provisioned with [`deploy/ops/add-operator.sh`](../../deploy/ops/add-operator.sh)
(named user + your key + sudo) and revoked with
[`remove-operator.sh`](../../deploy/ops/remove-operator.sh). If you don't have a key yet,
run [`deploy/ops/operator-keygen.bat`](../../deploy/ops/operator-keygen.bat) (Windows) or
[`operator-keygen.sh`](../../deploy/ops/operator-keygen.sh) (macOS/Linux) and send the admin
the **public** key it prints.

## 1. Your login

- **Username:** your assigned name (the filename of the public key you sent — e.g. `gilang`).
- **Key:** your private key stays on your laptop at `~/.ssh/id_ed25519`
  (Windows: `C:\Users\<you>\.ssh\id_ed25519`). **Never share it, never copy it to a server.**
  Only the public `.pub` was shared, and it's already installed.
- Login is **key-only** — there are no passwords.

## 2. Connect

```bash
ssh <your-username>@<server-ip>
```

Example: `ssh gilang@202.155.18.234`

For admin/maintenance tasks, become root after logging in:

```bash
sudo -i                      # root shell
sudo systemctl status besu   # or run a single command
```

## 3. The servers

| Name | Role | IP |
|---|---|---|
| hara-v1 | Besu QBFT validator | `202.155.18.234` |
| hara-v2 | Besu QBFT validator | `103.169.206.46` |
| hara-v3 | Besu QBFT validator | `103.169.206.127` |
| hara-v4 | Besu QBFT validator | `160.19.166.23` |
| hara-rpc-1 | RPC tier (Besu RPC + HAProxy) | `103.169.206.237` |
| hara-stateless-2 | Services, observability, edge (Caddy) | `103.169.206.239` |
| hara-stateful | Vault, Postgres, Redis, MinIO | `103.67.244.250` |

## 4. Optional: shortcuts (recommended)

Paste this into your `~/.ssh/config` (create the file if needed), replacing `YOURNAME`:

```sshconfig
Host hara-v1
    HostName 202.155.18.234
    User YOURNAME
Host hara-v2
    HostName 103.169.206.46
    User YOURNAME
Host hara-v3
    HostName 103.169.206.127
    User YOURNAME
Host hara-v4
    HostName 160.19.166.23
    User YOURNAME
Host hara-rpc-1
    HostName 103.169.206.237
    User YOURNAME
Host hara-stateless-2
    HostName 103.169.206.239
    User YOURNAME
Host hara-stateful
    HostName 103.67.244.250
    User YOURNAME
```

Then you can just run `ssh hara-v1`, `ssh hara-stateful`, etc.

## 5. Ground rules

- **This is production** (the live sovereign chain). Think before you run anything with `sudo`.
- Your actions are logged under **your** username — that's the point; don't share your
  account or key with anyone.
- Don't restart validators, edit chain config, or touch Vault/Postgres/MinIO unless you
  know what you're doing or have been asked to.
- If you lose your laptop or your key may be exposed, **tell the admin immediately** so it
  can be revoked.

## 6. Troubleshooting

- **`Permission denied (publickey)`** → check (a) you used the right username, (b) your key
  is at `~/.ssh/id_ed25519`, (c) you sent the matching `.pub`. Diagnose: `ssh -v <user>@<ip>`.
- **`sudo: a password is required`** → shouldn't happen (passwordless sudo is configured);
  tell the admin.
- First connection asks to trust the host fingerprint — type `yes`.

Questions or access problems → message the admin.
