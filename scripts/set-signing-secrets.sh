#!/bin/bash
# Verifies a .p12 against a password, then stores both as repo secrets from
# those exact bytes. Works in bash and zsh; the password is never echoed, never
# on the command line, and so never in shell history.
#
# Usage: bash set-signing-secrets.sh ~/Documents/Certificates2.p12
set -u

P12="${1:?usage: set-signing-secrets.sh <path to .p12>}"
[ -f "$P12" ] || { echo "No such file: $P12" >&2; exit 1; }

printf 'Password for %s: ' "$(basename "$P12")"
read -rs PW
echo

# env: reads the environment, so PW has to be exported, not just set.
export PW
if ! openssl pkcs12 -in "$P12" -passin env:PW -noout 2>/dev/null; then
  echo "✗ That password does not open this .p12. Nothing was changed." >&2
  exit 1
fi
echo "✓ Password opens the certificate (${#PW} characters)."

# The private key must be in there, or CI signs nothing.
if ! openssl pkcs12 -in "$P12" -passin env:PW -nocerts -nodes 2>/dev/null |
     grep -q 'PRIVATE KEY'; then
  echo "✗ No private key in this .p12 — re-export from 'My Certificates'." >&2
  exit 1
fi
echo "✓ Private key present."

base64 -i "$P12" | gh secret set CSC_LINK
echo "✓ CSC_LINK set ($(base64 -i "$P12" | wc -c | tr -d ' ') base64 characters)."

# printf, not echo: gh stores stdin verbatim and a newline would land inside
# the password.
printf '%s' "$PW" | gh secret set CSC_KEY_PASSWORD
echo "✓ CSC_KEY_PASSWORD set from the same bytes that just verified."

unset PW
echo
echo "Both secrets now come from one verified pair."
