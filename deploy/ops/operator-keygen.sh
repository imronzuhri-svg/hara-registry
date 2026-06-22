#!/usr/bin/env bash
# ============================================================
#  Hara Registry - generate your SSH key (macOS / Linux)
#  Run:  bash operator-keygen.sh
#  Then send the PUBLIC key it prints to your Hara admin.
# ============================================================
set -euo pipefail
KEYDIR="$HOME/.ssh"
KEYFILE="$KEYDIR/id_ed25519"

echo
echo "============================================================"
echo "  Hara Registry - SSH key setup"
echo "============================================================"
echo

command -v ssh-keygen >/dev/null 2>&1 || { echo "ERROR: ssh-keygen not found. Install OpenSSH and re-run."; exit 1; }
mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"

if [ -f "$KEYFILE.pub" ]; then
  echo "You already have an SSH key - reusing it (not overwriting)."
else
  read -r -p "Type your name or email (used only as a label), then Enter: " WHO
  echo
  echo "Creating an ed25519 key. You can set a passphrase (recommended) or press Enter twice for none."
  echo
  ssh-keygen -t ed25519 -f "$KEYFILE" -C "$WHO"
fi

echo
echo "============================================================"
echo "  COPY THE LINE BELOW AND SEND IT TO YOUR HARA ADMIN"
echo "============================================================"
echo
cat "$KEYFILE.pub"
echo
# copy to clipboard if a tool is available (optional convenience)
if   command -v pbcopy  >/dev/null 2>&1; then cat "$KEYFILE.pub" | pbcopy;  echo "(also copied to your clipboard)"
elif command -v xclip   >/dev/null 2>&1; then cat "$KEYFILE.pub" | xclip -selection clipboard; echo "(also copied to your clipboard)"
elif command -v wl-copy >/dev/null 2>&1; then cat "$KEYFILE.pub" | wl-copy; echo "(also copied to your clipboard)"
fi
echo
echo "============================================================"
echo "  SAFE TO SHARE: the line above is your PUBLIC key."
echo "  NEVER send the file 'id_ed25519' (without .pub) - that is PRIVATE."
echo "============================================================"
echo
