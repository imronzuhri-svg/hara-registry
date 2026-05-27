#!/usr/bin/env bash
# backup-setup.sh — one-time helper that generates the age keypair used to
# encrypt nightly backups before they leave the VPS.
#
# Run this ONCE on your operator workstation. The script:
#   1. Generates an age keypair (private key + recipient).
#   2. Writes the private key to ~/.config/age/hara-backups.txt (0600).
#   3. Prints the recipient string ("age1…") and tells you exactly
#      what to add to each VPS .env file.
#
# Why age + not gpg: smaller dependency footprint (single Go binary), no
# keyrings or trust webs, file-stream interface that pipes cleanly between
# pg_dump and rclone. See age-encryption.org.
#
# Backup decryption (during restore):
#   age -d -i ~/.config/age/hara-backups.txt < dump.sql.zst.age | zstd -d | psql …
#
# CRITICAL — losing the private key means every encrypted backup becomes
# unrecoverable. Treat ~/.config/age/hara-backups.txt the same way you
# treat the Vault unseal keys:
#   • Print it on paper and put it in a fireproof box, OR
#   • Store it in 1Password / Bitwarden as a Secure Note, OR
#   • Both (recommended).
#
# Rotation: generate a new keypair, deploy the new recipient to every VPS,
# wait one full retention window (30 days), then retire the old private key.

set -euo pipefail

if ! command -v age >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  echo "✗ age + age-keygen not installed."
  echo "  Install: apt install age   (Ubuntu) "
  echo "           brew install age   (macOS) "
  echo "           or download from https://github.com/FiloSottile/age/releases"
  exit 1
fi

KEY_DIR="${AGE_KEY_DIR:-$HOME/.config/age}"
KEY_FILE="$KEY_DIR/hara-backups.txt"

if [ -f "$KEY_FILE" ]; then
  echo "! $KEY_FILE already exists — refusing to overwrite."
  echo "  If you want to rotate, move the old file aside first:"
  echo "    mv $KEY_FILE $KEY_FILE.$(date +%Y%m%d).bak"
  exit 1
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

echo "▶ Generating age keypair → $KEY_FILE"
age-keygen -o "$KEY_FILE" 2>&1 | head -1
chmod 600 "$KEY_FILE"

RECIPIENT=$(grep -oE 'age1[a-z0-9]+' "$KEY_FILE")
[ -z "$RECIPIENT" ] && { echo "✗ failed to extract recipient from $KEY_FILE"; exit 1; }

cat <<EOF

═════════════════════════════════════════════════════════════════════
  Backup encryption keypair created
═════════════════════════════════════════════════════════════════════

  Private key file:  $KEY_FILE  (chmod 600 — KEEP IT)
  Public recipient:  $RECIPIENT

Next steps:
  1. Add this line to deploy/ops/.env on hara-stateful AND hara-v1..v4:

       BACKUP_AGE_RECIPIENT=$RECIPIENT

     (Or add it to each .env that the snapshot cron uses.)

  2. Back up the private key OUT OF BAND — 1Password / Bitwarden / paper.
     Losing it = every encrypted backup becomes unrecoverable.

  3. To verify a restore works end-to-end, run on operator workstation:

       age -d -i $KEY_FILE < some-backup.sql.zst.age | zstd -d | head

═════════════════════════════════════════════════════════════════════
EOF
