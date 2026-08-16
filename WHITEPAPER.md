# PIKO Protocol Paper (v1.1)

*A fair-launch, proof-of-on-chain-work token, mined entirely inside canisters on the Internet Computer.*

Live sites: https://5xdl7-taaaa-aaaaj-qseeq-cai.icp.net/ (mining) &middot;
https://77zu2-baaaa-aaaaj-qseiq-cai.icp.net/ (PIKO Dice, &sect;5)

## 0. Abstract

PIKO is a fixed-supply token minted exclusively through proof-of-work: anyone
can search for a nonce that satisfies the current difficulty target, submit
it, and if it's accepted first, the block reward is minted straight to their
own principal. There is no team allocation, no presale, and no code path
that mints PIKO any other way. Every hash attempt runs client-side -- in a
browser tab via the Web Crypto API, or in a self-owned canister running
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
2. **Search.** A Web Worker in the browser (or a timer loop inside a
   self-deployed canister) repeatedly hashes candidate nonces against the
   current header using SHA-256, entirely client-side.
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
| Mining fee (burned per submission) | 0.05 ICP (adjustable; kept low during the adoption phase) |
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
blackholed (&sect;9); the automatic version has no such dead end.

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
becomes a promise enforced by code rather than by a key (&sect;7).

**Pay-to-play, not play-to-win.** Paying the fee does not guarantee a
reward. If another submission's fee lands first for the same block, this
one still loses its ICP. That mirrors real proof-of-work, where compute
spent on a block someone else found first is never reimbursed -- and it's
the actual reason mining here functions as a competition rather than a
queue.

## 5. PIKO Dice

PIKO Dice is a companion game, giving PIKO somewhere to actually be spent
rather than only mined and held. It's deliberately a separate pair of
canisters and a separate site from mining (&sect;6) -- opting into the game
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

**PIKO-only, by site policy.** The `casino` canister's contract itself
still understands both PIKO and ICP as bettable tokens, but
`casino-frontend` -- the only sanctioned way to play -- offers PIKO bets
exclusively. An ICP bet is also economically inert in practice: the ICP
bankroll starts, and stays, at zero unless someone deliberately funds it, and
a zero bankroll means `maxPayoutAllowed` is zero, so any ICP bet is rejected
as too large before a single e8 moves.

Risk parameters (`maxPayoutBps`, the protected bankroll floor, the
cycles-funding split) are timelocked and lockable exactly like `mother`'s
own admin-settable fields -- see &sect;7 for what that means in practice.
The same hourly-sweep, ICP-profit-to-cycles self-funding pattern as
`mother` keeps the canister running without manual cycle top-ups.

## 6. Architecture

PIKO has no servers, no database, and no off-chain component of any kind.
Six canisters, all on the Internet Computer, do the entire job:

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
  in-browser miner (a Web Worker calling `crypto.subtle.digest`) all ship
  from here.
- **`casino`** -- the PIKO Dice game logic (&sect;5): bet resolution,
  bankroll accounting, and its own timelocked risk config.
- **`casino-frontend`** -- a second, separate static asset canister for
  PIKO Dice, intentionally not folded into `frontend` so mining and betting
  stay two distinct sites.

If every conventional server DFINITY or anyone else operates vanished
tomorrow, this system would keep running exactly as it does today --
nothing about it is hosted in the traditional sense.

## 7. Trust model & security

Every on-chain rule described in this paper -- the supply cap, the burn,
one winner per block -- is enforced by the code currently installed in
`mother` and `ledger`. That code can be inspected, and its behavior has
been tested against concurrent, competing submissions to confirm exactly
one winner is ever paid per block.

What it cannot yet claim is trustlessness in the strict sense. `mother`,
`ledger`, `miner`, `frontend`, `casino`, and `casino-frontend` currently
share a single controller. A canister controller can install new code at
any time, which means the guarantees in this paper hold only as long as
that controller chooses not to change them by replacing the code outright.
This is disclosed here deliberately rather than left implicit -- it applies
to `casino`'s bankroll exactly as it applies to `mother`'s supply cap.

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
nothing that freezes once the controller is gone. `casino`'s own risk
parameters (&sect;5) go through the identical
propose/48h-wait/execute/cancel/lock machinery, independent of `mother`'s.

**What removes the remaining trust requirement:** *blackholing* --
permanently removing all controllers from a canister -- makes it
unupgradable by anyone, forever, closing the one door the timelock
deliberately doesn't cover. The roadmap (&sect;9) covers blackholing
`ledger` and `mother` once the mechanism has run long enough, in
production, without a code change. Until then, PIKO's rules are open-source
and verifiable, and the parameters within them move on a public delay, but
the code itself is not yet immutable.

## 8. Risk disclosure

- PIKO has no liquidity and no listed market at the time of writing. There
  is currently no way to convert PIKO back into ICP or any other asset.
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
- PIKO is an independent project. It is not affiliated with, endorsed by,
  or connected to bob.fun or BOB.

## 9. Roadmap

- **Automatic difficulty retargeting.** Done -- see &sect;3. Removes the
  one remaining reason blackholing `mother` would have permanently frozen a
  hand-picked parameter.
- **Observation period.** Run in production, monitor real block times
  against the 5-minute target, confirm the retarget algorithm tracks
  participation as intended before locking anything else.
- **Blackhole `ledger`.** Standard DFINITY code with the lowest bug
  surface -- the earliest candidate for permanently removing its
  controller.
- **Lock `icpFeeTarget` and `cyclesFundRatio`** on `mother` once the burn
  destination, CMC, and burn/cycles split are considered final -- turning
  those specific promises into code-enforced ones ahead of blackholing
  itself.
- **Blackhole `mother`** once difficulty and fee parameters have
  stabilized, permanently locking in the supply cap and burn logic.
- **Third-party security audit**, independent of this paper's own trust-model
  disclosures, before either blackholing step above or any meaningful
  liquidity event.
- **Liquidity.** A PIKO/ICP pool on an ICP-native DEX, funded
  transparently, once there's a real community of miners to trade with.

## Appendix A: Canister reference

| Canister | Principal | Role |
|---|---|---|
| `mother` | `45mjf-rqaaa-aaaaj-qsedq-cai` | Coordinator |
| `ledger` | `56aad-fiaaa-aaaaj-qsefa-cai` | PIKO ICRC-1 ledger |
| `miner` | `5qcnl-6yaaa-aaaaj-qseea-cai` | Reference miner |
| `frontend` | `5xdl7-taaaa-aaaaj-qseeq-cai` | Mining site & dashboard |
| `casino` | `7yyso-myaaa-aaaaj-qseia-cai` | PIKO Dice game logic |
| `casino-frontend` | `77zu2-baaaa-aaaaj-qseiq-cai` | PIKO Dice site |
| ICP ledger | `ryjl3-tyaaa-aaaaa-aaaba-cai` | Mainnet ICP (external) |

Add the `ledger` principal above to the NNS dapp or any ICRC-1-aware wallet
to track your PIKO balance outside this site.

---

*PIKO Protocol Paper v1.1 -- independent, non-affiliated project -- source code published alongside this paper.*
