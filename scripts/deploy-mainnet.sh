#!/usr/bin/env bash
# Deploys PIKO to ICP mainnet. Costs real cycles (converted from real ICP) --
# read this whole script before running it.
#
# Same principal-ordering problem as deploy-local.sh (see its header comment)
# plus two mainnet-only costs to budget cycles for:
#   - Canister creation charges a flat ~0.5T cycles fee, deducted from
#     whatever you send with `--cycles`.
#   - Installing code costs cycles on top of that (proportional to wasm
#     size), separate from the creation fee -- budget headroom above 0.5T or
#     `icp canister install` will reject with "out of cycles".
set -euo pipefail
cd "$(dirname "$0")/.."

# Adjust to taste; these are what was actually used for the first mainnet
# deploy (see README for the resulting canister ids). Each must exceed the
# ~0.5T creation fee with enough left over to also cover code installation.
CYCLES_MOTHER=1000000000000    # 1T
CYCLES_MINER=1000000000000     # 1T
CYCLES_FRONTEND=1000000000000  # 1T
CYCLES_LEDGER=4000000000000    # 4T -- the ledger needs the most: it funds
                                # its own archive canisters as tx history grows

PLACEHOLDER="2vxsx-fae"

render_ledger_args() {
  sed -e "s/__MOTHER_PRINCIPAL__/$1/" -e "s/__DEPLOYER_PRINCIPAL__/$2/" \
    ledger/icrc1_ledger_init.args.template > ledger/icrc1_ledger_init.args
}

get_or_create() {
  icp canister create "$1" -e ic --cycles "$2" -q 2>/dev/null || icp canister status "$1" -e ic -i
}

echo "==> Checking your mainnet ICP/cycles balance..."
icp token balance -e ic
icp cycles balance -e ic
echo "    (mint more with: icp cycles mint --cycles <amount>t -e ic)"
read -p "Continue with canister creation? [y/N] " -n 1 -r; echo
[[ $REPLY =~ ^[Yy]$ ]] || exit 1

render_ledger_args "$PLACEHOLDER" "$PLACEHOLDER" # placeholder so the project loads

echo "==> Creating canisters (mother first, to reserve its principal)..."
MOTHER_ID=$(get_or_create mother "$CYCLES_MOTHER")
MINER_ID=$(get_or_create miner "$CYCLES_MINER")
FRONTEND_ID=$(get_or_create frontend "$CYCLES_FRONTEND")
LEDGER_ID=$(get_or_create ledger "$CYCLES_LEDGER")
DEPLOYER_ID=$(icp identity principal)
echo "    mother:   $MOTHER_ID"
echo "    miner:    $MINER_ID"
echo "    frontend: $FRONTEND_ID"
echo "    ledger:   $LEDGER_ID"

echo "==> Rendering real ledger init args..."
render_ledger_args "$MOTHER_ID" "$DEPLOYER_ID"

echo "==> Installing ledger..."
icp build ledger -e ic
icp canister install ledger -e ic --mode install --args-file ledger/icrc1_ledger_init.args -y

echo "==> Deploying mother, miner, frontend..."
icp deploy mother miner frontend -e ic -y

echo ""
echo "==> Done. If any install step failed with 'out of cycles', top up and retry:"
echo "    icp canister top-up <name> --amount <cycles> -e ic"
echo "    icp deploy <name> -e ic -y"
echo ""
echo "    frontend: https://${FRONTEND_ID}.icp.net/"
