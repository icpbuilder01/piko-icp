# PIKO Protocol Paper (v1.0)

*A fair-launch, proof-of-on-chain-work token, mined entirely inside canisters on the Internet Computer.*

Live site: https://5xdl7-taaaa-aaaaj-qseeq-cai.icp.net/

## 0. Abstract

PIKO is a fixed-supply token minted exclusively through proof-of-work: anyone
can search for a nonce that satisfies the current difficulty target, submit
it, and if it's accepted first, the block reward is minted straight to their
own principal. There is no team allocation, no presale, and no code path
that mints PIKO any other way. Every hash attempt runs client-side -- in a
browser tab via the Web Crypto API, or in a self-owned canister running
around the clock -- and every submission is independently re-verified by the
coordinating canister before anything is minted.

Mining is not free: each accepted proof burns a fixed amount of ICP,
permanently, to the ICP ledger's own minting account. Losing a close race
also burns the fee -- there is no refund. That real, occasionally-wasted
cost is deliberate: it is what makes mining a genuine competition instead of
a free claim on the supply.

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
5. **Pay.** The mining fee is pulled from the miner's own ICP balance and
   sent to the ICP ledger's minting account. This happens whether or not the
   submission goes on to win.
6. **Settle.** If the chain height hasn't moved since the search began, this
   submission wins: the block advances, and the reward is minted to the
   miner's principal. If someone else's proof landed first, this one is
   rejected -- its fee stays burned regardless.

## 3. Tokenomics

| Parameter | Value |
|---|---|
| Maximum supply | 21,000,000 PIKO |
| Decimals | 8 |
| Initial block reward | 600 PIKO |
| Halving interval | 17,500 blocks |
| Premine | 0 |
| Mining fee (burned per submission) | 0.5 ICP |
| Anti-spam cooldown | 0.3s / principal |
| Difficulty target | 22 bits (adjustable) |

The reward halves every 17,500 blocks, the same shape as bitcoin's emission
curve, converging toward the 21,000,000 cap without ever formally reaching
it. Difficulty is not yet auto-retargeting -- it's set by the coordinator's
controller based on observed block times, a simplification the roadmap
(&sect;8) addresses.

## 4. The burn

The mining fee is not collected by the project. Every accepted submission's
fee -- and every losing submission's fee -- is transferred to the ICP
ledger's own minting account (`rrkah-fqaaa-aaaaa-aaaaq-cai`), which is how
ICP is destroyed under the ICRC-1 standard. It is a real, permanent,
publicly verifiable burn, not a claim.

**Pay-to-play, not play-to-win.** Paying the fee does not guarantee a
reward. If another submission's fee lands first for the same block, this
one still loses its ICP. That mirrors real proof-of-work, where compute
spent on a block someone else found first is never reimbursed -- and it's
the actual reason mining here functions as a competition rather than a
queue.

## 5. Architecture

PIKO has no servers, no database, and no off-chain component of any kind.
Four canisters, all on the Internet Computer, do the entire job:

- **`ledger`** -- the unmodified, DFINITY-maintained ICRC-1/ICRC-2 ledger
  canister, the same code other ICP tokens run, not a bespoke contract.
- **`mother`** -- the coordinator. Holds chain height and difficulty,
  independently re-verifies every submitted proof, burns the fee, and mints
  the reward.
- **`miner`** -- an optional, self-owned canister for continuous mining on a
  timer, for anyone who doesn't want to keep a browser tab open.
- **`frontend`** -- a static asset canister. The dashboard, wallet, and the
  in-browser miner (a Web Worker calling `crypto.subtle.digest`) all ship
  from here.

If every conventional server DFINITY or anyone else operates vanished
tomorrow, this system would keep running exactly as it does today --
nothing about it is hosted in the traditional sense.

## 6. Trust model & security

Every on-chain rule described in this paper -- the supply cap, the burn,
one winner per block -- is enforced by the code currently installed in
`mother` and `ledger`. That code can be inspected, and its behavior has
been tested against concurrent, competing submissions to confirm exactly
one winner is ever paid per block.

What it cannot yet claim is trustlessness in the strict sense. `mother`,
`ledger`, `miner`, and `frontend` currently share a single controller. A
canister controller can install new code at any time, which means the
guarantees in this paper hold only as long as that controller chooses not
to change them -- whether by altering the supply logic, or by redirecting
the burn destination. This is disclosed here deliberately rather than left
implicit.

**What removes this trust requirement:** *blackholing* -- permanently
removing all controllers from a canister -- makes it unupgradable by
anyone, forever. The roadmap (&sect;8) covers blackholing `ledger` and
`mother` once the mechanism has run long enough, in production, without a
code change. Until then, PIKO's rules are open-source and verifiable, but
not yet immutable.

## 7. Risk disclosure

- PIKO has no liquidity and no listed market at the time of writing. There
  is currently no way to convert PIKO back into ICP or any other asset.
- The mining fee is real ICP, burned immediately and permanently on
  submission -- win or lose the block. It is not refundable under any
  circumstance.
- This document is not investment advice, and PIKO is not a security, a
  share, or a promise of future value. Mine only with ICP you are fully
  prepared to never see again.
- PIKO is an independent project. It is not affiliated with, endorsed by,
  or connected to bob.fun or BOB.

## 8. Roadmap

- **Observation period.** Run in production, monitor difficulty and real
  block times, tune the target as participation becomes clearer.
- **Blackhole `ledger`.** Standard DFINITY code with the lowest bug
  surface -- the earliest candidate for permanently removing its
  controller.
- **Blackhole `mother`** once difficulty and fee parameters have
  stabilized, permanently locking in the supply cap and burn logic.
- **Liquidity.** A PIKO/ICP pool on an ICP-native DEX, funded
  transparently, once there's a real community of miners to trade with.

## Appendix A: Canister reference

| Canister | Principal | Role |
|---|---|---|
| `mother` | `45mjf-rqaaa-aaaaj-qsedq-cai` | Coordinator |
| `ledger` | `56aad-fiaaa-aaaaj-qsefa-cai` | PIKO ICRC-1 ledger |
| `miner` | `5qcnl-6yaaa-aaaaj-qseea-cai` | Reference miner |
| `frontend` | `5xdl7-taaaa-aaaaj-qseeq-cai` | Site & dashboard |
| ICP ledger | `ryjl3-tyaaa-aaaaa-aaaba-cai` | Mainnet ICP (external) |

Add the `ledger` principal above to the NNS dapp or any ICRC-1-aware wallet
to track your PIKO balance outside this site.

---

*PIKO Protocol Paper v1.0 -- independent, non-affiliated project -- source code published alongside this paper.*
