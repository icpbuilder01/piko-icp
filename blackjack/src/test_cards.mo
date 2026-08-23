import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import VarArray "mo:core/VarArray";
import Cards "cards";

// Standalone correctness check for cards.mo, run via `moc -r` (not part of
// the deployed canister). freshDeck/shuffle are ported byte-for-byte from a
// previously proven-correct implementation, so those checks are ported too;
// the handTotal checks below are new, specific to blackjack.

var failures = 0;

func check(name : Text, got : Bool) {
  if (not got) {
    Debug.print("FAIL: " # name);
    failures += 1;
  } else {
    Debug.print("ok:   " # name);
  };
};

// rank helpers: 0=2 .. 8=10, 9=J, 10=Q, 11=K, 12=A. suit*13+rank.
func c(suit : Nat, rank : Nat) : Nat8 { Nat8.fromNat(suit * 13 + rank) };

// ---- shuffle sanity: same 52 cards present, deterministic given the same seed ----
let deckA = VarArray.fromArray<Nat8>(Cards.freshDeck());
Cards.shuffle(deckA, 123456789);
let deckB = VarArray.fromArray<Nat8>(Cards.freshDeck());
Cards.shuffle(deckB, 123456789);
var sameSeedSameResult = true;
var i = 0;
while (i < 52) {
  if (deckA[i] != deckB[i]) { sameSeedSameResult := false };
  i += 1;
};
check("shuffle is deterministic given the same seed", sameSeedSameResult);

let deckC = VarArray.fromArray<Nat8>(Cards.freshDeck());
Cards.shuffle(deckC, 987654321);
var differentSeedDifferentResult = false;
i := 0;
while (i < 52) {
  if (deckA[i] != deckC[i]) { differentSeedDifferentResult := true };
  i += 1;
};
check("shuffle differs given a different seed", differentSeedDifferentResult);

let seen = VarArray.tabulate<Bool>(52, func _ = false);
for (card in deckA.vals()) { seen[Nat8.toNat(card)] := true };
var allPresent = true;
i := 0;
while (i < 52) {
  if (not seen[i]) { allPresent := false };
  i += 1;
};
check("shuffled deck still contains all 52 distinct cards", allPresent);

// ---- rankValue ----
check("rankValue: 2 is 2", Cards.rankValue(c(0, 0)) == 2);
check("rankValue: 10 is 10", Cards.rankValue(c(0, 8)) == 10);
check("rankValue: Jack is 10", Cards.rankValue(c(0, 9)) == 10);
check("rankValue: King is 10", Cards.rankValue(c(0, 11)) == 10);
check("rankValue: Ace is 11 (soft)", Cards.rankValue(c(0, 12)) == 11);

// ---- handTotal / natural / bust / soft-ace reduction ----
check("natural: Ace+King = 21 on 2 cards", Cards.handTotal([c(0, 12), c(1, 11)]) == 21);
check("natural identity: no non-ace 2-card combo reaches 21", Cards.handTotal([c(0, 8), c(1, 9)]) != 21); // Ten+Jack = 20
check("hard 20: Ten+King", Cards.handTotal([c(0, 8), c(1, 11)]) == 20);
check("soft 17: Ace+6 counts the ace as 11", Cards.handTotal([c(0, 12), c(1, 4)]) == 17);
check("bust: 10+9+5 = 24, no ace to save it", Cards.handTotal([c(0, 8), c(1, 7), c(2, 3)]) == 24);
check("multi-ace reduction: Ace+Ace+9 = 11+11+9 reduced once to 21", Cards.handTotal([c(0, 12), c(1, 12), c(2, 7)]) == 21);
check("multi-ace reduction: Ace+Ace+Ace+8 reduces twice to 21", Cards.handTotal([c(0, 12), c(1, 12), c(2, 12), c(3, 6)]) == 21);
// A *hard* 21 (no reducible ace left) always busts on any further hit,
// since the new card's minimum value is 2: 21+2=23, no ace to absorb it.
check("hit from a hard 21 always busts", Cards.handTotal([c(0, 5), c(1, 5), c(2, 5), c(3, 0)]) > 21); // 7+7+7=21 hard, +2 -> 23
// But a *soft* 21 that still has a spare reducible ace is NOT guaranteed to
// bust -- Ace+Ace+9 is 21 with one ace still counted as 11 (only one of the
// two aces has been downgraded so far), so it still has slack: this is why
// no "disable Hit at total==21" shortcut belongs anywhere in this game --
// handTotal's from-scratch recomputation on every hit is what actually
// determines bust/no-bust, never the mere fact that total()==21.
check("hit from a soft 21 (spare ace) does not necessarily bust", Cards.handTotal([c(0, 12), c(1, 12), c(2, 7), c(3, 0)]) <= 21); // A+A+9=21 soft, +2 -> 13

// ---- cardOf round-trips rank/suit correctly ----
let aceOfSpades = Cards.cardOf(c(3, 12));
check("cardOf: rank decodes to Ace", aceOfSpades.rank == #Ace);
check("cardOf: suit decodes to Spades", aceOfSpades.suit == #Spades);
let twoOfHearts = Cards.cardOf(c(0, 0));
check("cardOf: rank decodes to Two", twoOfHearts.rank == #Two);
check("cardOf: suit decodes to Hearts", twoOfHearts.suit == #Hearts);

if (failures > 0) {
  Debug.print(Nat.toText(failures) # " FAILURE(S)");
  Runtime.trap("test_cards.mo: failures detected, see output above");
} else {
  Debug.print("all cards.mo checks passed");
};
