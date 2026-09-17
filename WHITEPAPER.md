# PIKO Protocol Paper (v1.5)

*A fair-launch, proof-of-on-chain-work token, mined entirely inside canisters on the Internet Computer.*

Live sites: https://5xdl7-taaaa-aaaaj-qseeq-cai.icp.net/ (mining) &middot;
https://77zu2-baaaa-aaaaj-qseiq-cai.icp.net/ (PIKO Dice, &sect;5) &middot;
https://bcd2h-5iaaa-aaaai-ax4hq-cai.icp.net/ (PikoBlackjack, &sect;6) &middot;
https://cglm2-byaaa-aaaac-bf4aq-cai.icp.net/ (PikoPixel, &sect;7) &middot;
https://2uuxi-qyaaa-aaaac-qhbyq-cai.icp.net/ (PikoPoker, &sect;8)

## 0. Abstract

PIKO is a fixed-supply token minted exclusively through proof-of-work: anyone
can search for a nonce that satisfies the current difficulty target, submit
it, and if it's accepted first, the block reward is minted straight to their
own principal. There is no team allocation, no presale, and no code path
that mints PIKO any other way. Every hash attempt runs client-side -- in a
browser tab (one search per available CPU core, hashing via a
WASM-compiled SHA-256 implementation), or in a self-owned canister running
around the clock -- and every submission is independently re-verified by the
coordinating canister before anything is minted.

Mining is not free: each accepted proof costs a fixed amount of ICP, pulled
from the miner and non-refundable from that instant on -- most of it burned
permanently to the ICP ledger's own minting account, a small share converted
to cycles to help fund the protocol's own canisters (&sect;4). Losing a
close race costs the same fee -- there is no refund. That real,
occasionally-wasted cost is deliberate: it is what makes mining a genuine
competition instead of a free claim on the supply.

## 1. Why another token

Most new tokens allocate a chunk of supply to a team or treasury before
anyone outside the project can acquire any. That allocation is often
defensible, but it also means the token's stated fairness is a promise, not
a mechanism. PIKO takes the opposite approach, closer to how bitcoin's
supply is described than how most token launches actually work: the *only*
way any PIKO comes into existence is by paying the same on-chain cost
everyone else pays, racing the same difficulty target everyone else races,
and winning.

This project is inspired by the publicly described "proof-of-on-chain-work"
mechanics of bob.fun -- a mother-node-and-miners design where miners submit
work and a coordinator mints the reward. PIKO is an independent
implementation of that idea, under its own name, its own token, and its own
codebase. **It is not affiliated with, endorsed by, or connected to bob.fun
or BOB.**

## 2. How mining works

A block is won by finding a nonce such that
`sha256(previousHash || height || nonce)` has at least `difficultyBits`
leading zero bits, then submitting it before anyone else's valid nonce for
the same height is accepted.

1. **Approve.** The miner grants the coordinator canister an ICRC-2
   allowance on the ICP ledger, covering a few blocks' worth of mining fee.
2. **Search.** One Web Worker per available CPU core in the browser (or a
   timer loop inside a self-deployed canister) repeatedly hashes candidate
   nonces against the current header using SHA-256, entirely client-side.
   Each session's search starts from a random per-job base offset rather
   than nonce zero, so independent sessions -- this same account's other
   tabs/devices, or any other miner on the network -- search genuinely
   different, independent slices of the nonce space instead of converging
   on the same answer.
3. **Submit.** The moment a valid nonce is found, it's sent to the
   coordinator canister as a single call.
4. **Verify.** The coordinator recomputes the hash itself -- it never trusts
   a client-supplied result -- and rejects anything that doesn't clear the
   current target.
5. **Pay.** The mining fee is pulled from the miner's own ICP balance into
   the coordinator's. This happens whether or not the submission goes on to
   win, and is never refunded from this point on.
6. **Settle.** If the chain height hasn't moved since the search began, this
   submission wins: the block advances, and the reward is minted to the
   miner's principal. If someone else's proof landed first, this one is
   rejected -- its fee is gone regardless.
7. **Burn.** Fees aren't sent to their final destination one at a time --
   that would mean paying an extra ICP ledger transfer fee on every single
   block. Instead they accumulate in the coordinator's own balance, and a
   periodic sweep (automatic, hourly) burns most of it and converts a
   configured share to cycles (&sect;4).

## 3. Tokenomics

| Parameter | Value |
|---|---|
| Maximum supply | 21,000,000 PIKO |
| Decimals | 8 |
| Initial block reward | 600 PIKO |
| Halving interval | 17,500 blocks |
| Premine | 0 |
| Mining fee (burned per submission) | 0.25 ICP (adjustable via `setMiningFeeE8s`; check `getStats()` for the live value) |
| Anti-spam cooldown | 0.3s / principal |
| Difficulty target | 18 bits (starting point and floor; retargets automatically) |
| Retarget interval | 10 blocks |
| Target block time | 5 minutes |
| Max retarget step | &plusmn;2 bits (4x work) per window |

The reward halves every 17,500 blocks, the same shape as bitcoin's emission
curve, converging toward the 21,000,000 cap without ever formally reaching
it. Difficulty retargets itself automatically, bitcoin-style: every 10
blocks, the coordinator compares how long that window actually took against
the 5-minute-per-block target and adjusts `difficultyBits` up or down to
compensate, capped at &plusmn;2 bits per window so one unusually fast or
slow window on a small sample of miners can't swing it wildly, and never
drops below the 18-bit starting point -- a floor that only matters when
long idle gaps between mining sessions (not slow real hashing) would
otherwise read as "blocks came slowly" and ratchet difficulty toward
near-zero, at which point the next active session would find blocks
near-instantly. Retargeting can still move difficulty arbitrarily far
*above* that floor, unbounded, as real participation grows. There is no
controller call involved -- difficulty was set by hand in an earlier
version of this design, which worked day-to-day but would have frozen
permanently at whatever value it last held once the coordinator is
blackholed (&sect;12); the automatic version has no such dead end.

## 4. The burn -- and the cycles that keep the lights on

The mining fee is not collected by the project as revenue. Every accepted
submission's fee -- and every losing submission's fee -- ends up split two
ways once it's swept:

- **The large majority (100% minus `cyclesFundRatioBps`, default 80%) is
  transferred to the ICP ledger's own minting account**
  (`rrkah-fqaaa-aaaaa-aaaaq-cai`), which is how ICP is destroyed under the
  ICRC-1 standard. A real, permanent, publicly verifiable burn, not a claim.
- **The remaining share (`cyclesFundRatioBps`, default 20%) is converted to
  cycles** via the Internet Computer's Cycles Minting Canister, and used to
  fund the coordinator canister's own compute -- the alternative being that
  this canister depends on someone remembering to manually top it up with
  cycles forever, indefinitely, by hand. Cycles obtained this way can't be
  converted back into ICP or any other asset; this is fuel for the protocol
  to keep running, not revenue anyone can extract or spend.

This split doesn't happen block-by-block -- fees accumulate in the
coordinator's own ICP balance and get swept out (burned + converted)
automatically on an hourly timer, so the fee doesn't pay a second ICP ledger
transfer fee on every single block just to be moved along. The split ratio
itself is disclosed live via `getStats()`, and -- like the burn destination
itself -- can be locked permanently by the controller once tuned, so it
becomes a promise enforced by code rather than by a key (&sect;10). Both
locks on `mother` are no longer hypothetical: `icpFeeTargetLocked` and
`cyclesFundRatioLocked` are both confirmed `true` live, independently
checkable via `getStats()` -- the burn destination and the burn/cycles
split ratio are already enforced by code, not by a key, ahead of `mother`
itself ever being blackholed.

**Pay-to-play, not play-to-win.** Paying the fee does not guarantee a
reward. If another submission's fee lands first for the same block, this
one still loses its ICP. That mirrors real proof-of-work, where compute
spent on a block someone else found first is never reimbursed -- and it's
the actual reason mining here functions as a competition rather than a
queue.

## 5. PIKO Dice

PIKO Dice is a companion game, giving PIKO somewhere to actually be spent
rather than only mined and held. It's deliberately a separate pair of
canisters and a separate site from mining (&sect;9) -- opting into the game
is a distinct choice from opting into mining, not a bundled default. Bets
are PIKO-only (see below).

The mechanics are the standard "roll under" crypto-dice formula used across
the space: pick a target in `[2, 98]`, a fresh on-chain random roll in
`[0, 99]` (drawn from the subnet's own threshold randomness via `raw_rand`)
decides the outcome, and rolling strictly under the target wins
`stake * 99 / target`. The `99` (not `100`) numerator is what encodes a
fixed **1% house edge** -- expected return over many rolls is 99% -- and it
is a compile-time constant, never admin-adjustable.

**Ordering, not commit-reveal, is what makes this fair.** The stake is
pulled from the player via `icrc2_transfer_from` *before* `raw_rand` is ever
called -- so there is no point in the sequence where the outcome is known
and either side (player or canister) can still back out. If randomness
genuinely can't be drawn, the stake is refunded through the same
pending-payout recovery path a failed win payout uses, rather than stranded.

**Every bet is sized against the game's real, live bankroll**, recomputed
from the ledger's actual balance on every single bet -- never a cached
figure. A bet whose potential payout would exceed `maxPayoutBps` (1% at
launch) of that live bankroll is rejected outright, before any stake moves,
so the game can never accept a bet it couldn't cover if it lost.

**PIKO-only, by site policy.** The `dice` canister's contract itself
still understands both PIKO and ICP as bettable tokens, but
`dice-frontend` -- the only sanctioned way to play -- offers PIKO bets
exclusively. An ICP bet is also economically inert in practice: the ICP
bankroll starts, and stays, at zero unless someone deliberately funds it, and
a zero bankroll means `maxPayoutAllowed` is zero, so any ICP bet is rejected
as too large before a single e8 moves.

(`dice` was named `casino` earlier in this project's history -- same
canister, same principal, renamed at the project level once that name read
as a heavier claim than intended for what the site itself always just
called "PIKO Dice".)

Risk parameters (`maxPayoutBps`, the protected bankroll floor, the
cycles-funding split) are timelocked and lockable exactly like `mother`'s
own admin-settable fields -- see &sect;10 for what that means in practice.
Both locks are now exercised on `dice`: `withdrawalsLocked` and
`riskConfigLocked` are both confirmed `true` live, checkable via
`getConfig()` -- the bankroll can never be withdrawn and the risk
parameters can never change again, short of a code upgrade. The same
hourly-sweep, ICP-profit-to-cycles self-funding pattern as `mother` keeps
the canister running without manual cycle top-ups.

## 6. PikoBlackjack

PikoBlackjack is a second companion game: a full interactive single-deck
Blackjack table (Hit/Stand/Double/Split) played against the protocol's own
PIKO bankroll. Like PIKO Dice (&sect;5), it's a separate pair of canisters
and a separate site from both mining and Dice -- opting into it is a
distinct choice, not a bundled default. Bets are PIKO-only.

Standard single-deck rules: the dealer stands on 17 (no soft-17 exception),
a natural blackjack pays 3:2, an ordinary win pays 2:1, and a push returns
the stake. Double and Split are both offered (no resplit, no
double-after-split), each capped so the worst-case combined payout on a
single original bet never exceeds 4x it, however the hand branches.

**Same ordering guarantee as Dice.** The stake is pulled via
`icrc2_transfer_from` before the deck is shuffled with `raw_rand`, and the
dealer's own hole card is resolved -- checking for a dealer natural or a
push -- before the player is ever offered a Hit, Double, or Split decision,
so there is no point in the sequence where the outcome is knowable and
either side can still back out.

**Bankroll-checked like Dice, same self-funding pattern.** A bet whose
worst-case payout would exceed `maxPayoutBps` (5% at the time of writing)
of the live, real bankroll is rejected before any stake moves. Risk
parameters and the withdrawal path go through the identical
propose/48h-wait/execute/cancel/lock machinery as `mother` and `dice`
(&sect;10) -- as with `dice`, all three of `blackjack`'s own locks
(`pikoLedgerLocked`, `bankrollConfigLocked`, `withdrawalsLocked`) are now
exercised, all confirmed `true` live. The same hourly-sweep,
ICP-profit-to-cycles pattern keeps the canister funded without manual
top-ups.

(`blackjack` began as a simple Plinko-style game, then a slot machine,
before becoming the Blackjack table described here -- same canister, same
principal, same bankroll throughout each change; the code comments still
note the earlier names for anyone diffing history.)

## 7. PikoPixel

PikoPixel is a third companion, and a different kind of one: a shared,
r/place-style pixel canvas, not a betting game. Anyone can burn a small,
fixed amount of PIKO to paint one cell of a shared grid a color of their
choosing, visible to every visitor in real time, no login required just to
look.

**A burn, not a bet.** Unlike PIKO Dice (&sect;5) and PikoBlackjack
(&sect;6), there is no payout, no bankroll, and no way to get the PIKO
back. Each placement pulls the fixed fee via `icrc2_transfer_from` and
sends it straight to the ledger's own minting account -- a real ICRC-1
burn, atomic with the pull itself, permanently removed from total supply.
The `place` canister never holds the PIKO even transiently, so unlike
every betting game in this family it has no withdrawal path and no
timelocked risk config -- there's nothing for a controller to withdraw or
mismanage in the first place. `pikoLedgerId` is locked the same way
`icpFeeTarget` is (&sect;10): a one-way `lockPikoLedgerId()` call, checkable
live via `getConfig()`, closes off the only lever that could otherwise
redirect where burns go -- confirmed `true` live, the earliest of any
companion app's ledger lock to actually be exercised.

**Fully permissionless, same anti-spam pattern as the rest of the family.**
A per-caller cooldown prevents a caller with no PIKO/allowance from forcing
free, repeated failed transfer attempts; the grid, palette size, and stats
(total placements, distinct painters, total PIKO burned) are all readable
without logging in via plain queries.

PikoPixel (`~/pikopixel/`) is, like PikoBlackjack, a wholly separate
icp-cli project from this one -- its own repository, its own local
network, its own deploy lifecycle -- not a dependency in this workspace's
own `icp.yaml`. It shares mining's real PIKO `ledger` and, like
`dice`/`blackjack`, has no PIKO/ICP income of its own (every burn leaves
the ecosystem entirely rather than landing in the canister), so `mother`
tops it up directly from its own cycles surplus the same way it does for
`dice`; `place` then relays its own surplus on to `place-frontend`.

## 8. PikoPoker

PikoPoker is a fourth companion, and the first in the family that's
player-versus-player rather than player-versus-bankroll: on-chain
No-Limit Texas Hold'em, up to 8 seats per table, played in real PIKO.
Unlike Dice (&sect;5) and Blackjack (&sect;6), the canister is not the
house taking the other side of every hand -- it's the dealer and escrow
for a table of real opponents, and takes a small, disclosed rake out of
contested pots rather than a bankroll edge.

**Same escrow-before-play ordering guarantee as the rest of the family.**
A seat's buy-in is pulled via `icrc2_transfer_from` -- escrowed into that
player's stack -- before they're dealt into a hand, not after; a shuffle
uses `raw_rand` per hand, and hole cards are redacted per-caller in every
query, so no other player (or spectator) can read cards they haven't been
shown. Public tables are openly joinable; private tables are joined by an
invite code. A dedicated zero-buy-in "Free Play" table exists purely as
play money -- no PIKO ever moves for it, by a `buyIn == 0` sentinel the
contract checks explicitly, not a UI-only distinction.

**Rake, not a bankroll bet.** A small, configurable share of each
contested pot (`rakeBps`) is retained by the canister rather than a
Dice/Blackjack-style house edge on a single wager. Collected rake is
withdrawn through the identical propose/48h-wait/execute/cancel/lock
machinery as `mother`'s, `dice`'s, and `blackjack`'s own withdrawal paths
(&sect;10) -- unlike `dice`'s and `blackjack`'s own withdrawal locks
(both now exercised, &sect;10), `lockRakeWithdrawals` has not been called
here yet.

**The youngest, and most actively corrected, canister in this family.**
PikoPoker launched 2026-09-02, materially later than mining, Dice,
Blackjack, or PikoPixel, and real multiplayer table state (whose turn it
is, whether a hand is still live, whether a seat is mid-leave) is a
larger surface than a single bet-and-resolve call. In practice this has
meant a real fix shipped roughly every one to two weeks since launch --
most recently, the same day this paper was updated, an internal review
found and fixed a genuine information-disclosure gap: private-table
invite codes were generated without real randomness, and two read-only
query methods didn't check table membership before returning it, together
meaning a caller who simply enumerated table ids could have read a
private table's invite code and its live hand state, including cards not
yet revealed at showdown. Both are fixed and confirmed deployed --
invite codes are now drawn from `raw_rand`, and every per-table query
checks the caller actually belongs there first -- but it's disclosed here
rather than quietly folded into a changelog, in keeping with this
project's own transparency norm (&sect;10 lists the equivalent findings
for `dice` and `blackjack`). A separate, still-not-fully-root-caused
reliability quirk -- an internal self-rescheduling timer occasionally
failing to fire its own next tick on mainnet specifically, never
reproduced on a local replica -- is mitigated by the frontend itself
periodically nudging the same game-advancing method externally, which
needs no special privilege and has proven reliable in practice, but the
underlying mechanism isn't proven fixed, only worked around.

**How this shapes PikoPoker's own place in the roadmap (&sect;12):** given
how recently it launched and how much more often it has needed a real
code fix than any other companion app, PikoPoker is not on a blackhole
track yet at all, not even the intermediate lock step the other games are
already partway through -- see &sect;12 for what would need to change
first.

## 9. Architecture

PIKO has no servers, no database, and no off-chain component of any kind.
Fourteen canisters, all on the Internet Computer, do the entire job:

- **`ledger`** -- the unmodified, DFINITY-maintained ICRC-1/ICRC-2 ledger
  canister, the same code other ICP tokens run, not a bespoke contract.
- **`mother`** -- the coordinator. Holds chain height and difficulty,
  independently re-verifies every submitted proof, burns the fee, and mints
  the reward.
- **`miner`** -- an optional, self-owned canister for continuous mining on a
  timer, for anyone who doesn't want to keep a browser tab open. CLI-only:
  deploying and running one is `git clone` + `icp deploy` + a few
  `icp canister call` commands (see the README), not something the mining
  site itself walks you through.
- **`frontend`** -- a static asset canister. The dashboard, wallet, and the
  in-browser miner (one Web Worker per CPU core, hashing via a
  WASM-compiled SHA-256 implementation) all ship from here.
- **`index`** -- the official, unmodified `ic-icrc1-index-ng` canister,
  indexing every `ledger` transaction so the mining site's own block
  explorer can look one up by index without a bespoke indexer. It never
  moves funds, only reads the ledger.
- **`dice`** -- the PIKO Dice game logic (&sect;5): bet resolution,
  bankroll accounting, and its own timelocked risk config.
- **`dice-frontend`** -- a second, separate static asset canister for
  PIKO Dice, intentionally not folded into `frontend` so mining and betting
  stay distinct sites.
- **`blackjack`** -- PikoBlackjack's game logic (&sect;6): hand and round
  resolution, bankroll accounting, and its own timelocked risk config.
- **`blackjack-frontend`** -- a third, separate static asset canister, for
  the same reason `dice-frontend` is kept separate from `frontend`.
- **`place`** -- PikoPixel's canvas logic (&sect;7): pixel storage, stats,
  and the burn-per-placement flow. No timelocked risk config here, unlike
  `dice`/`blackjack` -- there's no bankroll to protect.
- **`place-frontend`** -- a fourth, separate static asset canister, for the
  same reason `dice-frontend`/`blackjack-frontend` are kept separate.
- **`pikopoker`** -- PikoPoker's table logic (&sect;8): seating, escrow,
  hand resolution, and rake accounting across public, private, and Free
  Play tables.
- **`pikopoker-frontend`** -- a fifth, separate static asset canister, for
  the same reason the other companion apps' frontends are kept separate.
- **`landing`** -- the project's public entry point (`piko.network`): a
  single static page explaining PIKO and linking out to the applications
  above. It never calls any canister itself -- no login, no approval,
  nothing at stake here -- purely a signpost.

**How the six sites relate.** `landing` is the hub: it explains the
project once and links out, rather than duplicating any application.
`frontend` (mining), `dice-frontend` (dice betting), `blackjack-frontend`
(blackjack), `place-frontend` (PikoPixel), and `pikopoker-frontend`
(PikoPoker) are deliberately separate applications with separate
login/approval flows -- opting into one is never a bundled default for
the others -- but all five ultimately move the *same* PIKO through the
*same* `ledger` canister. A balance shown on the mining dashboard, the
dice site, the blackjack table, the PikoPixel canvas, and the poker lobby
is the same number, read from the same account (subject to Internet
Identity deriving a distinct principal per site's own origin -- each site
pins its own canonical origin so that at least stays consistent *within*
itself), not separate in-game currencies. `mother`, `dice`, `blackjack`,
`place`, and `pikopoker` are the coordinator canisters behind `frontend`,
`dice-frontend`, `blackjack-frontend`, `place-frontend`, and
`pikopoker-frontend` respectively; an end user calls the frontend, never
the coordinator directly.

If every conventional server DFINITY or anyone else operates vanished
tomorrow, this system would keep running exactly as it does today --
nothing about it is hosted in the traditional sense.

## 10. Trust model & security

Every on-chain rule described in this paper -- the supply cap, the burn,
one winner per block -- is enforced by the code currently installed in
`mother` and `ledger`. That code can be inspected, and its behavior has
been tested against concurrent, competing submissions to confirm exactly
one winner is ever paid per block.

What it cannot yet claim is trustlessness in the strict sense. `mother`,
`ledger`, `miner`, `frontend`, `index`, `dice`, `dice-frontend`,
`blackjack`, `blackjack-frontend`, `place`, `place-frontend`, `pikopoker`,
and `pikopoker-frontend` currently share a single controller. A canister
controller can install new code at any time, which means the guarantees
in this paper hold only as long as that controller chooses not to change
them by replacing the code outright. This is disclosed here deliberately
rather than left implicit -- it applies to `dice`'s, `blackjack`'s, and
`pikopoker`'s escrowed funds, and to where `place` sends every burn,
exactly as it applies to `mother`'s supply cap.

**Parameter changes, short of a code upgrade, are timelocked.** The ICP fee
target (which ledger, which burn account, which CMC) can't change in a
single transaction: it's proposed, visible on-chain for 48 hours, and only
takes effect after that delay -- long enough for anyone watching to notice
and react before a change lands. The burn/cycles split ratio gets the same
treatment for a related reason: it can never move funds off-protocol, but
an instantly-changeable ratio would make "X% of every fee is burned" just
as unreliable a promise as an unlocked burn address. Each of these can also
be **permanently locked** by the controller once tuned, turning that
specific promise from "enforced by a key" into "enforced by code" well
before the whole canister is blackholed. **Difficulty has no controller
path at all** -- see &sect;3 -- it retargets itself from on-chain block
timestamps, so there is nothing to propose, timelock, or lock for it, and
nothing that freezes once the controller is gone. `dice`'s own risk
parameters (&sect;5) and `blackjack`'s (&sect;6) each go through the
identical propose/48h-wait/execute/cancel/lock machinery, independent of
`mother`'s and of each other's -- both are now fully locked
(`riskConfigLocked`/`withdrawalsLocked` confirmed `true` on `dice`;
`bankrollConfigLocked`/`withdrawalsLocked`/`pikoLedgerLocked` confirmed
`true` on `blackjack`, all live-checkable via their own `getConfig()`).
`place` has no risk parameters to timelock -- there's no bankroll -- but
its own single lever,
which real PIKO ledger burns are sent to, is now permanently locked too (a
plain one-way `lockPikoLedgerId()`, no propose/wait step needed since it
isn't adjustable day-to-day the way a betting risk parameter is).
`pikopoker`'s rake withdrawal (&sect;8) goes through the same
propose/48h-wait/execute/cancel/lock machinery as `dice`'s and
`blackjack`'s (now-locked) bankroll withdrawals, but neither
`lockRakeWithdrawals` nor its own `lockPikoLedgerId()` -- unlike
`blackjack`'s and `place`'s, both already exercised -- has been called
yet.

**What removes the remaining trust requirement:** *blackholing* --
permanently removing all controllers from a canister -- makes it
unupgradable by anyone, forever, closing the one door the timelock
deliberately doesn't cover. The roadmap (&sect;12) covers blackholing
`ledger`, `mother`, and eventually `dice`, `blackjack`, and `place`, once
each has run long enough, in production, without a code change.
`pikopoker` (&sect;8) is deliberately not on that list yet -- it is the
youngest canister in the family and has needed a real code fix far more
often than the others since launch, so it is not far enough along even
the intermediate lock step to have a blackhole timeline at all right now.
A paid third-party audit before `mother`/`dice`/`blackjack` are blackholed
is the goal, not a guarantee -- this is a
self-funded, no-premine project with no treasury to draw on, so whether one
happens depends on whether it's affordable at the time, not on a promise
made here. What isn't conditional: the code is open-source today, every
figure in this paper is independently checkable via query calls, and
blackholing itself won't happen on a rushed timeline just because an audit
didn't. Until then, PIKO's rules are open-source and verifiable, and the
parameters within them move on a public delay, but the code itself is not
yet immutable.

**What's been checked in the meantime, pending that audit:** an internal
self-review -- not independent, and not a substitute for one -- covering
`mother`, `dice`, `blackjack`, and `miner` for concurrency bugs (races
between different callers, not just the same caller racing itself), and
every permissionless maintenance function (`sweepTreasury`, `topUpProject`,
`sweepIcpProfit`, `topUpDiceFrontend`, `topUpBlackjackFrontend`) for spam
resistance. One real cross-principal race in `dice`'s bankroll check was
found and fixed (different players could each pass the payout cap against
the same bankroll snapshot before either resolved); it's now closed with a
per-token committed-exposure counter, verified under real concurrent load
locally, not just reasoned about. A related bug was found and fixed in
`blackjack`: its own committed-payout counter could momentarily understate
a real in-progress round's exposure across a canister upgrade, verified
fixed by actually forcing an upgrade mid-round and confirming a clean
resolve afterward, not just by code review. Separately, the vendored
`ledger` wasm
was hash-verified byte-for-byte against DFINITY's own published release
artifact, and the `sha2` hashing dependency's actual output was checked
against known SHA-256 test vectors by running it, rather than trusting its
version label. `place` (&sect;7) was reviewed the same way and, as of this
writing, has had nothing to fix -- its burn-per-placement path checks
bounds and pulls the fee before mutating any state, and every persisted
constant was declared correctly from day one. `pikopoker` (&sect;8) is the
one exception: the same review found and fixed a real information-
disclosure gap the same day this paper was updated -- private-table
invite codes weren't drawn from real randomness, and two read-only query
methods didn't check that a caller actually belonged to the table before
returning its state, together meaning a table's private code and live
hand state (cards included) could have been read by anyone willing to
enumerate table ids. Both are fixed and confirmed deployed. None of this
replaces an independent audit -- it's the floor, not the ceiling.

**`landing` is deliberately out of scope for blackholing, indefinitely.**
It holds no funds, calls no other canister, and enforces no rule this paper
makes any claim about -- see &sect;9: "no login, no approval, nothing at
stake here." Locking it would buy no additional trust for anyone, at the
permanent cost of never being able to update the project's own front door
(new links, corrections, future sites). Immutability is a tool for the
canisters whose code *is* the promise being made; `landing` isn't one of
them.

## 11. Risk disclosure

- A PIKO/ICP pool exists on ICPSwap, seeded at the network's own
  mining-cost ratio, but it is small and new -- price can move sharply on
  modest volume. This document is not a claim about PIKO's market price or
  liquidity depth at any given moment; check the pool itself for that.
- The mining fee is real ICP, non-refundable the instant it's pulled --
  win or lose the block -- and permanently burned (the large majority) or
  converted to cycles (a small share) in batches shortly after. Under no
  circumstance does it return to the miner who paid it.
- This document is not investment advice, and PIKO is not a security, a
  share, or a promise of future value. Mine only with ICP you are fully
  prepared to never see again.
- **PIKO Dice (&sect;5) is a betting game, not an investment.** A losing
  roll's stake is burned into the bankroll, non-refundable, the same way
  the mining fee is. With no PIKO market yet, winnings are still just
  PIKO -- only bet what you're fully fine losing.
- **PikoBlackjack (&sect;6) is also a betting game, not an investment.**
  The same real-PIKO, non-refundable-on-a-loss economics as Dice apply --
  only bet what you're fully fine losing.
- **PikoPixel (&sect;7) is not a game or an investment either -- it is a
  burn, full stop.** There is no roll, no hand, no chance of winning
  anything back: the PIKO spent placing a pixel is gone the moment the
  placement succeeds, by design, every time. Only place with PIKO you're
  fully fine never seeing again.
- **PikoPoker (&sect;8) is real-stakes poker, not an investment.** Buy-ins
  are escrowed in real PIKO and paid out by hand outcome, same
  non-refundable-on-a-loss economics as Dice and Blackjack -- only sit
  down with PIKO you're fully fine losing. It is also, as of this writing,
  the youngest and most actively-corrected canister in this family (&sect;8,
  &sect;10) -- treat it as the least battle-tested application here.
- PIKO is an independent project. It is not affiliated with, endorsed by,
  or connected to bob.fun or BOB.

## 12. Roadmap

- **Automatic difficulty retargeting.** Done -- see &sect;3. Removes the
  one remaining reason blackholing `mother` would have permanently frozen a
  hand-picked parameter.
- **Lock `icpFeeTarget` and `cyclesFundRatio`** on `mother`. Done -- both
  confirmed permanently locked, live and independently checkable via
  `getStats()`. Turns those two promises from "enforced by a key" into
  "enforced by code" ahead of blackholing `mother` itself.
- **Observation period.** Run in production, monitor real block times
  against the 5-minute target, confirm the retarget algorithm tracks
  participation as intended before locking anything else.
- **Blackhole `ledger`.** Standard DFINITY code with the lowest bug
  surface -- the earliest candidate for permanently removing its
  controller.
- **Third-party security audit, funding permitting.** There's no treasury
  here to pay for one -- no premine, no revenue, fees are burned or turned
  into cycles, never captured (&sect;4) -- so this happens if and when it's
  affordable, not on a committed date. Not a precondition this paper can
  promise before blackholing `mother`/`dice`; a longer production track
  record and open-source community review are what actually gate that
  timeline regardless of whether a paid audit happens too.
- **Blackhole `mother`** once difficulty and fee parameters have stabilized
  and a long enough production track record backs the code, permanently
  locking in the supply cap and burn logic.
- **Lock `dice`'s withdrawal path and risk config** (&sect;5, &sect;10).
  Done -- `withdrawalsLocked`/`riskConfigLocked` both confirmed
  permanently locked, live and independently checkable via `getConfig()`,
  the same propose/48h-wait/lock step already applied to `mother`.
- **Blackhole `dice`**, after `mother` and only once a real track record of
  betting volume has run without incident -- bet resolution and the
  randomness/transfer ordering are more moving parts than `mother`'s
  simpler verify-and-mint path, and have changed more recently, so it earns
  immutability on a slower timeline, not
  the same one.
- **Lock `blackjack`'s withdrawal path and risk config** (&sect;6, &sect;10).
  Done -- `pikoLedgerLocked`/`bankrollConfigLocked`/`withdrawalsLocked` all
  confirmed permanently locked, live and independently checkable via
  `getConfig()`, the same propose/48h-wait/lock step already applied to
  `mother` and `dice`.
- **Blackhole `blackjack`**, on a similar track to `dice` -- hand/round
  resolution and the double/split payout logic are more moving parts than
  `mother`'s simpler path, so it earns immutability once a real track
  record of play backs it, not on `mother`'s timeline.
- **Lock `place`'s ledger id** (&sect;7, &sect;10). Done -- confirmed
  permanently locked, live and independently checkable via `getConfig()`.
  No withdrawal path or risk config to lock beyond that, since there's no
  bankroll.
- **Blackhole `place`**, on a similar track to `dice`/`blackjack` once a
  real track record of use backs it -- simpler logic than either (no
  betting, no payout math), but not a reason to skip the same production
  track record other canisters earn immutability with. Worth noting as of
  this writing: only one distinct principal has ever used it, so its
  fund-handling path has real code review behind it but no real
  multi-user concurrency track record yet.
- **Lock `pikopoker`'s ledger id and rake withdrawal path** (&sect;8,
  &sect;10), the same propose/48h-wait/lock step as `dice`/`blackjack`.
  Not done -- `lockPikoLedgerId()` has never been called and
  `lockRakeWithdrawals` hasn't either.
- **`pikopoker` is deliberately not on a blackhole track at all yet**,
  unlike every other game in this family -- see &sect;8 for why: it is
  the youngest canister here and has needed a real fix roughly every one
  to two weeks since its 2026-09-02 launch, most recently a genuine
  information-disclosure bug fixed the same day this paper was updated.
  It needs a materially longer incident-free production run before even
  the lock step above is worth doing, let alone blackholing.
- **`landing` is not on this list, on purpose** -- see &sect;10. It holds no
  funds and makes no promise this paper needs code to enforce, so there is
  nothing blackholing it would protect -- only future flexibility it would
  cost.
- **Liquidity.** Done -- a PIKO/ICP pool is live on ICPSwap, seeded at the
  mining-cost ratio and grown incrementally since. Deeper liquidity as real
  volume and community holdings grow remains ongoing, not a one-time task.

## Appendix A: Canister reference

| Canister | Principal | Role |
|---|---|---|
| `mother` | `45mjf-rqaaa-aaaaj-qsedq-cai` | Coordinator |
| `ledger` | `56aad-fiaaa-aaaaj-qsefa-cai` | PIKO ICRC-1 ledger |
| `miner` | `5qcnl-6yaaa-aaaaj-qseea-cai` | Reference miner |
| `frontend` | `5xdl7-taaaa-aaaaj-qseeq-cai` | Mining site & dashboard |
| `dice` | `7yyso-myaaa-aaaaj-qseia-cai` | PIKO Dice game logic |
| `dice-frontend` | `77zu2-baaaa-aaaaj-qseiq-cai` | PIKO Dice site |
| `blackjack` | `d76up-oaaaa-aaaai-ax4ia-cai` | PikoBlackjack game logic |
| `blackjack-frontend` | `bcd2h-5iaaa-aaaai-ax4hq-cai` | PikoBlackjack site |
| `place` | `cpihg-xqaaa-aaaac-bf4ba-cai` | PikoPixel canvas logic |
| `place-frontend` | `cglm2-byaaa-aaaac-bf4aq-cai` | PikoPixel site |
| `pikopoker` | `25x4u-gqaaa-aaaac-qhbza-cai` | PikoPoker table logic |
| `pikopoker-frontend` | `2uuxi-qyaaa-aaaac-qhbyq-cai` | PikoPoker site |
| `index` | `ymzxo-vqaaa-aaaaj-qse3q-cai` | ICRC-1 transaction index (read-only) |
| `landing` | `7w27g-xiaaa-aaaaj-qseja-cai` | Project entry point (`piko.network`) |
| ICP ledger | `ryjl3-tyaaa-aaaaa-aaaba-cai` | Mainnet ICP (external) |

Add the `ledger` principal above to the NNS dapp or any ICRC-1-aware wallet
to track your PIKO balance outside this site.

---

*PIKO Protocol Paper v1.5 -- independent, non-affiliated project -- source code published alongside this paper.*
