#!/usr/bin/env bash
# Deploys PIKO to the local ICP network (free, for development/testing).
#
# The ledger's minting_account must be the `mother` canister's principal,
# but that principal only exists once `mother` has been created, and
# minting_account can never change after the ledger is installed (see
# ledger/ledger.did: UpgradeArgs has no minting_account field). So this
# script: (1) writes a placeholder init-args file just so the project loads,
# (2) creates `mother` to reserve its real principal, (3) regenerates the
# real init-args file from the template, (4) deploys everything.
set -euo pipefail
cd "$(dirname "$0")/.."

PLACEHOLDER="2vxsx-fae" # the anonymous principal, just a syntactically valid placeholder

render_ledger_args() {
  sed -e "s/__MOTHER_PRINCIPAL__/$1/" -e "s/__DEPLOYER_PRINCIPAL__/$2/" \
    ledger/icrc1_ledger_init.args.template > ledger/icrc1_ledger_init.args
}

# Idempotent: `icp canister create` errors if the canister already exists
# (e.g. re-running this script), so fall back to reading its id via `status`.
get_or_create() {
  icp canister create "$1" -q 2>/dev/null || icp canister status "$1" -i
}

echo "==> Writing placeholder ledger init args so the project can load..."
render_ledger_args "$PLACEHOLDER" "$PLACEHOLDER"

echo "==> Starting local ICP network..."
icp network start -d

echo "==> Creating 'mother' canister to reserve its principal..."
MOTHER_ID=$(get_or_create mother)
DEPLOYER_ID=$(icp identity principal)
echo "    mother principal:   $MOTHER_ID"
echo "    deployer principal: $DEPLOYER_ID"

echo "==> Regenerating ledger init args with the real mother principal..."
render_ledger_args "$MOTHER_ID" "$DEPLOYER_ID"

echo "==> Deploying ledger (reinstall -- minting_account can't be changed by an upgrade)..."
icp canister create ledger -q 2>/dev/null || true
icp build ledger
icp canister install ledger --mode reinstall --args-file ledger/icrc1_ledger_init.args -y

echo "==> Deploying mother, miner, casino, frontend, casino-frontend..."
icp deploy mother miner casino frontend casino-frontend -y

FRONTEND_ID=$(icp canister status frontend -i)
CASINO_FRONTEND_ID=$(icp canister status casino-frontend -i)
echo ""
echo "==> Done. Open the sites at:"
echo "    mining (frontend):  http://${FRONTEND_ID}.localhost:8010/"
echo "    casino-frontend:    http://${CASINO_FRONTEND_ID}.localhost:8010/"
