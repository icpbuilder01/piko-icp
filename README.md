# PIKO

PIKO is a fixed-supply, no-premine token you can mine **right in your
browser** -- no wallet software or CLI needed, just Internet Identity --
entirely hosted on the Internet Computer (ICP): the ledger, the mining
coordinator, the reference miner, and the website are all canisters. No
off-chain server, no off-chain database.

**Live on mainnet:**

| Canister | ID | URL |
|---|---|---|
| frontend | `5xdl7-taaaa-aaaaj-qseeq-cai` | https://5xdl7-taaaa-aaaaj-qseeq-cai.icp.net/ |
| mother | `45mjf-rqaaa-aaaaj-qsedq-cai` | https://45mjf-rqaaa-aaaaj-qsedq-cai.icp.net/ |
| miner (reference instance) | `5qcnl-6yaaa-aaaaj-qseea-cai` | https://5qcnl-6yaaa-aaaaj-qseea-cai.icp.net/ |
| ledger | `56aad-fiaaa-aaaaj-qsefa-cai` | https://56aad-fiaaa-aaaaj-qsefa-cai.icp.net/ |

The mainnet canisters currently hold modest cycle balances (~0.5T each for
mother/miner/frontend, ~3.7T for the ledger) -- enough to run for a good
while at low traffic, but top up before relying on them long-term:
`icp canister top-up <name> --amount <cycles> -e ic`.

**Independent project.** PIKO is inspired by the publicly described
"proof-of-on-chain-work" mining mechanics of bob.fun, but it is an original
codebase, token, and brand. **It is not affiliated with, endorsed by, or
connected to bob.fun or BOB in any way.**

## How it works

- **Two ways to mine, same rules:**
  - **In the browser** (the site's "Mine" panel): a Web Worker hashes
    candidate nonces locally with the Web Crypto API against the current
    block header. Requires being logged in with Internet Identity (rewards go
    to your principal); stops when you close the tab.
  - **A dedicated `miner` canister** you deploy and keep topped up with
    cycles, for continuous/unattended mining -- same hashing, same rewards,
    driven by a timer instead of your browser tab.
  - Both search for a nonce such that `sha256(previousHash # height # nonce)`
    has enough leading zero bits to clear the current difficulty.
- The first to find a valid proof submits it to the **`mother`**
  canister (the coordinator), which re-verifies the hash server-side, advances
  the chain, and mints the block reward straight to the submitter's own
  principal via the **`ledger`** canister (the official, pre-built
  ICRC-1/ICRC-2 ledger from `dfinity/ic` -- not a custom reimplementation).
- Tokenomics: 21,000,000 PIKO max supply, 600 PIKO initial block reward,
  halving every 17,500 blocks, 8 decimals, no premine (every PIKO in
  circulation was mined through the contract).
- **PIKO is a standard ICRC-1 token** -- the ledger canister ID is shown on
  the site (with a copy button) so you can add it to the NNS dapp or any
  other ICRC-1-aware wallet, not just view your balance on this site.
- A live **leaderboard** (`getLeaderboard`) tracks cumulative blocks/PIKO per
  miner, persisted across upgrades (unlike the per-block recent-blocks feed,
  which is capped at the last 20).

This mirrors the design the project was inspired by, with a few explicit
**simplifications**, documented here rather than hidden:

- **Difficulty is set manually** by the `mother` canister's controller
  (`proposeDifficulty(bits)`, taking effect via `executeDifficulty()` after a
  48h timelock -- see "Timelocked admin changes" below) instead of an
  automatic retarget algorithm. Default is 22 bits, a rough estimate for "a
  few minutes per block" at a handful of concurrent miners (browser hashrate
  via Web Crypto varies a lot by device) -- watch actual block times on the
  dashboard and adjust.
- **Mining is pay-to-play, not play-to-win.** Every *submitted* proof pulls
  `miningFeeE8s` (**0.5 ICP**, admin-adjustable via `setMiningFeeE8s`) from
  the submitter's own ICP balance via `icrc2_transfer_from`, into `mother`'s
  own ICP balance -- non-refundable and out of the submitter's control from
  that instant, whether or not this particular submission goes on to win the
  block. You must `icrc2_approve` the `mother` canister on the ICP ledger
  before mining (the site's "Mine" panel does this for you). There's also a
  per-principal cooldown (`MIN_SUBMIT_INTERVAL_NANOS`, 0.3s) as a cheap first
  filter before the ICP check runs.
  - **The fee is burned in batches, not per-block.** `mother` doesn't forward
    the fee straight to the ICP ledger's minting account on every single
    submission -- that would mean paying the ICP ledger's ~10,000 e8s
    transfer fee twice per block just for bookkeeping. Instead, `sweepTreasury()`
    -- called automatically on an hourly timer, and callable by anyone,
    anytime, as a manual fallback -- splits whatever ICP balance `mother`
    is actually holding right now: `cyclesFundRatioBps` of it (default 20%,
    timelocked and lockable exactly like the burn destination -- see below)
    is converted to cycles via the Cycles Minting Canister to help fund
    `mother`'s own upkeep, and the rest is burned exactly as every block's
    fee always was. It's stateless by design: every sweep re-reads the real
    ICP balance rather than trusting a running counter, so a failed leg
    (a transfer that traps, a `notify_top_up` that errors) just leaves its
    share of the balance for the next sweep to retry.
  - **No refund if you lose the race.** If another submission's fee pull
    happens to land first while this one is also awaiting its own, this one
    still loses its ICP -- same as real proof-of-work, where compute (or
    electricity) spent on a block someone else found first is never
    reimbursed. That real, unrecoverable cost is what makes mining an actual
    competition instead of a free-roll ("pay only when you're about to win").
    Verified with two miners racing for the same block concurrently: the
    winner is minted the reward, the loser's fee is gone and they get
    nothing -- there is exactly one winner per block, never more (`mother`
    re-checks the chain height right after the fee pull, before ever
    minting, so a losing submission can never mutate state or double-pay).
  - **Read this before mining**: at 0.5 ICP/block with no PIKO market yet,
    mining is a real-money cost for a token with no established, liquid
    value, and you can lose that cost even with a genuinely valid proof if
    someone else's lands first. There is no way to convert PIKO back to ICP
    right now (no DEX listing). Only mine with ICP you're fully fine never
    seeing again -- the site's banner says this too, deliberately, not just
    in fine print here.
- **This is a simulated/gamified proof-of-work**, like bob.fun itself: IC
  compute is deterministic and cheap to replicate compared to real ASIC
  hashpower, so it is not Bitcoin-grade economic security. Treat it as a fun,
  fully on-chain mining game, not a store of serious value.
- If a mint transfer fails after a block is accepted (e.g. the ledger call
  traps), the reward is recorded as a **pending reward** the miner can retry
  any time via `claimPendingReward()` -- a block being accepted is never
  blocked on the mint succeeding immediately.

## Architecture

```
piko-icp/
  icp.yaml                          canisters: ledger, mother, miner, frontend
  ledger/                           official pre-built ICRC-1/ICRC-2 ledger (dfinity/ic)
    ic-icrc1-ledger.wasm             downloaded from the ledger-suite-icrc-2026-03-09 release
    ledger.did                       candid interface, extracted from the wasm itself (`ic-wasm metadata`)
    icrc1_ledger_init.args.template  init args template (minting_account is filled in at deploy time)
  mother/                           Motoko -- mining coordinator ("mother node")
  miner/                            Motoko -- reference miner canister (deploy your own copy)
  frontend/                         React/Vite site -- dashboard, Internet Identity login, miner guide
  scripts/deploy-local.sh           deploys everything to the local network
```

### Why the ledger's init args are generated, not static

The ICRC ledger's `minting_account` is fixed forever at install time (it
cannot be changed later, see `UpgradeArgs` in `ledger/ledger.did`), and it
must be the `mother` canister's own principal. But canister principals are
only assigned once a canister is *created* -- so `scripts/deploy-local.sh`
creates `mother` first to reserve its principal, then renders
`ledger/icrc1_ledger_init.args` from the `.template` file before installing
the ledger. `ledger/icrc1_ledger_init.args` is a build artifact -- don't
hand-edit it.

The `mother` canister itself finds the `ledger` canister's principal at
runtime via the `PUBLIC_CANISTER_ID:ledger` environment variable that
`icp deploy` injects automatically (see the "Canister Discovery" concept in
the icp-cli docs) -- no manual wiring needed on that side.

## Run it locally (free)

Requires [icp-cli](https://cli.internetcomputer.org) and Node.js (already set
up in this environment). PIKO's local network runs on **port 8010** (not the
default 8000) to avoid clashing with any other icp-cli project already
running locally -- see `networks:` in `icp.yaml`.

```bash
./scripts/deploy-local.sh
```

This starts the local network, deploys all four canisters, and prints the
frontend URL. Useful commands once deployed:

```bash
# Chain state
icp canister call mother getWork
icp canister call mother getStats
icp canister call mother getRecentBlocks
icp canister call mother getPendingAdminChanges   # any queued propose*() waiting on its timelock?
icp canister call mother getTotalPendingRewards   # unclaimed PIKO owed across all miners

# Mine with the reference miner
icp canister call miner start
icp canister call miner getStatus
icp canister call miner stop

# Check your PIKO balance
icp canister call ledger icrc1_balance_of '(record { owner = principal "<your-principal>" })'
```

Frontend dev server with hot reload (after the canisters above are deployed):

```bash
cd frontend && npm install && npm run dev
```

## Deploying to mainnet

Mainnet deployment costs real cycles (paid for by converting real ICP) --
see `icp cycles mint --help` and the
["Deploying to IC Mainnet"](https://cli.internetcomputer.org/1.3/guides/deploying-to-mainnet.md)
guide.

```bash
icp cycles mint --cycles 7t -e ic   # convert ICP to cycles first
./scripts/deploy-mainnet.sh
```

Two mainnet-only costs to budget for, beyond what's needed locally:
creating a canister charges a flat **~0.5T cycles fee** deducted from
whatever you send it, and **installing code costs additional cycles** on top
of that (roughly proportional to wasm size) -- send meaningfully more than
0.5T per canister or `icp canister install` rejects with "out of cycles".
The ledger needs the most headroom since it also funds the archive canisters
it spins up as transaction history grows. If a canister ends up
under-funded, top it up and retry:

```bash
icp canister top-up <name> --amount <cycles> -e ic
icp deploy <name> -e ic -y
```

## Upgrading `mother` or `miner` safely

Both are `actor { ... }` bodies compiled with `--default-persistent-actors`
(enhanced orthogonal persistence): every top-level `let`/`var` is part of the
canister's persisted state by default. In practice, tested against a real
upgrade of the deployed `mother` canister:

- **Adding** a new top-level `let`/`var` is safe, even without a migration
  (only declaring one is required for *fields whose value must come from old
  data*, which none of ours currently do).
- **Renaming, retyping, or removing** an existing top-level `let`/`var` --
  *even a plain compile-time-constant literal* -- traps the upgrade with
  `RTS error: Memory-incompatible program upgrade`. This includes constants
  you might assume are "just code": once deployed, their declaration is part
  of the persisted shape.
- The practical rule this project follows: only ever **add** declarations;
  if a constant becomes unused, leave it declared rather than deleting or
  renaming it, unless you've decided a clean reinstall (wiping state) is
  acceptable for that deploy.
- Always test an upgrade against a canister that already has real state
  before touching mainnet -- `icp deploy <name> -y` locally against the
  already-running local canister (not a fresh reinstall) reproduces the exact
  upgrade path mainnet will go through.

## Trust model and known limitations (read before relying on this)

- **Canister controllers can upgrade code, which overrides all on-chain
  logic.** `mother`, `ledger`, `miner`, and `frontend` are all currently
  controlled by a single identity (the deployer's). That controller could, in
  principle, push a new `mother` build that ignores the 21,000,000 supply
  cap, or a new `ledger` build that mints itself PIKO directly. None of
  PIKO's "fixed supply" or "real burn" claims are enforced by anything
  *other than* the currently deployed code -- they hold only as long as you
  trust the controller not to replace it. **A code upgrade is not covered by
  the timelock described below** -- that only slows down *parameter*
  changes within the current code, not a wholesale replacement of the code
  itself. This is true of most early-stage IC projects, not specific to
  PIKO, but it's the single most important thing to understand before
  treating PIKO as trustless. The standard way projects remove this trust
  requirement is **blackholing** a canister (setting its controllers to
  none), which makes it permanently unupgradable -- a serious, irreversible
  step only worth taking once the code is considered final.
- **Timelocked admin changes.** The two admin actions that could hurt
  miners/holders in a single call -- `proposeDifficulty` (0 would make every
  nonce a winning proof) and `proposeIcpFeeTarget` (redirects where the burn,
  and the CMC conversion, actually go) -- don't take effect immediately.
  They're queued via `propose*()`, visible to anyone via
  `getPendingAdminChanges()`, and only become live via `execute*()` after a
  **48-hour** delay (`ADMIN_TIMELOCK_NANOS`, a hardcoded constant -- not a
  controller-settable var, since a setter for it would let a compromised key
  shorten it to zero right before pushing a malicious change).
  `cyclesFundRatioBps` gets the same treatment for a different reason: it
  can't redirect funds anywhere off-protocol, but an instantly-changeable
  burn/cycles split would make "X% of every fee is burned" just as
  unreliable a promise as an unlocked burn address. `setMiningFeeE8s` is the
  one setter left immediate -- it can only make mining cheaper or more
  expensive for everyone equally, never drain supply or redirect funds.
  `execute*()` is deliberately permissionless (like `sweepTreasury()`): the
  value was already fixed and public at proposal time, so anyone can apply
  it once the delay has passed, even if the controller key that proposed it
  is unavailable by then. `cancelPending*()` lets the controller abort a
  queued change before it lands.
- **`icpBurnOwner`, `cmcId`, and `cyclesFundRatioBps` can be permanently
  locked.** `lockIcpFeeTarget()` and `lockCyclesFundRatio()` irreversibly
  disable their respective `propose*()` functions -- meant to be called once
  local-testing/tuning needs are done, so these specific promises become
  "enforced by code" rather than "enforced by a key," even before the whole
  canister is blackholed.
- **`mother`'s per-caller `lastAttempt` map (and, less so, cycle balance) can
  be grown/drained cheaply.** Any real (non-anonymous) principal can call
  `submitProof` -- Internet Identity sessions and self-authenticating
  principals are free and effectively unlimited to create -- and even a call
  that fails instantly (bad hash) still adds an entry and costs `mother` a
  little compute. This is a general property of public IC canisters (callers
  don't pay for the canister's own cycles), not unique to PIKO.
  `pruneStaleAttempts()` -- permissionless, meant to be called periodically
  by a keeper/cron -- removes entries whose cooldown has already
  provably expired, bounding how large the map can get between prunes;
  `mother`'s own cycle balance should still be monitored and topped up
  periodically.
- **Fixed: `pendingRewards` used to be `transient`.** A reward that's been
  earned but not yet successfully transferred (e.g. the ledger call trapped)
  is real PIKO owed to a specific miner. Marking that map `transient` -- as
  an earlier version of `mother` did -- meant it silently reset to empty on
  *every* canister upgrade, with no trap and no error: any miner with an
  unclaimed pending reward at upgrade time would just lose it. It's now
  persisted like `minerBlocks`/`minerRewards`. **If you're upgrading an
  already-deployed `mother` from before this fix, check
  `getTotalPendingRewards()` first** -- this specific transition (from
  transient to persisted) can't retroactively rescue whatever's already
  pending at that exact upgrade, only prevent the loss from happening again
  afterward; if it's non-zero, get outstanding rewards claimed via
  `claimPendingReward()` before upgrading.
- **The `miner` canister has no way to move its own ICP without a
  controller/owner-only call.** `withdrawIcp(to, amount)` exists specifically
  so ICP sent to fund a miner's mining fees isn't stuck if you want to
  reclaim it.
- Fixed: earlier versions of `miner` initialized `owner` to the anonymous
  principal as a placeholder before the first `start()` call, and
  `requireOwner` only checked `caller != owner` -- meaning an anonymous
  caller matched that placeholder and could operate a freshly deployed,
  not-yet-started miner. `requireOwner` now rejects anonymous callers
  explicitly, closing that window.

## Security notes

- `submitProof` recomputes the hash server-side and never trusts a
  client-supplied hash.
- Chain state (height/header) is mutated *before* the inter-canister call to
  the ledger, so a second submission against a now-stale header can never
  validate twice -- no separate reentrancy lock is needed for that path.
- All mutating entry points reject the anonymous principal.
- Admin-only calls (`proposeDifficulty`, `setMiningFeeE8s`, etc.) are gated
  on `Principal.isController`; the two that could hurt miners/holders in one
  call are also timelocked -- see "Timelocked admin changes" above.
- `claimPendingReward` clears the pending-reward entry *before* awaiting the
  transfer, so a second concurrent claim call can't double-pay.
- **Supply-cap integrity:** `totalMinted` is incremented the instant a
  block's reward is decided (in `submitProof`, when height advances) --
  *not* when the ICRC transfer to the miner actually succeeds. Fixed from an
  earlier version where it was only incremented on transfer success:
  clamping every new block's reward against a `totalMinted` that only counts
  *confirmed* payouts means a sustained ledger outage (transfers trapping
  while mining keeps going) could mint blocks whose rewards were never
  counted against the cap at the time, only added to `pendingRewards` --
  letting the eventual sum of claimed pending rewards land past
  21,000,000 PIKO once the ledger recovered. Counting the reward against the
  cap the moment it's decided, regardless of whether the transfer itself
  succeeds yet, closes that gap.

## Non-affiliation

PIKO -- this codebase, this token, this site -- is an independent project. It
is not affiliated with, endorsed by, or connected to bob.fun or BOB. Any
resemblance in mechanics is homage to a publicly described design, not a
claim of association.
