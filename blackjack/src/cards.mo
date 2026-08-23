import Nat8 "mo:core/Nat8";
import Array "mo:core/Array";
import Types "types";

// Deck, shuffle, and blackjack hand-total logic -- a pure module with no
// actor/canister state, so it can be unit-tested standalone with `moc -r`
// (see test_cards.mo). freshDeck/shuffle/entropyToNat are ported
// byte-for-byte from a previously proven-correct implementation used
// elsewhere in this same family of PIKO canisters.
//
// A card is a Nat8 0..51 internally: rank = card % 13 (0 = "2" ... 12 =
// Ace), suit = card / 13 (0..3, arbitrary suit order -- gameplay never
// depends on suit identity). Only converted to the nicer candid-facing
// Types.Card (explicit CardRank/CardSuit variants, self-describing to any
// caller without needing this encoding out of band) at the actor boundary,
// via cardOf below.
module {

  public func rankOf(c : Nat8) : Nat = Nat8.toNat(c) % 13;
  public func suitOf(c : Nat8) : Nat = Nat8.toNat(c) / 13;

  public func freshDeck() : [Nat8] {
    Array.tabulate<Nat8>(52, func(i) { Nat8.fromNat(i) });
  };

  // Fisher-Yates driven by one big arbitrary-precision integer built from
  // raw_rand's 32 bytes (256 bits of real threshold randomness). Treating
  // that integer as a mixed-radix number and peeling off `n % (i+1)` /
  // dividing by `(i+1)` at each step consumes the entropy exactly, with no
  // modulo bias the way naively taking `byte % range` per swap would have.
  // 52! is about 2^225.6, well under the 2^256 the seed provides, so this
  // fully determines an unbiased permutation with room to spare.
  public func shuffle(deck : [var Nat8], seed : Nat) {
    var n = seed;
    var i = deck.size();
    while (i > 1) {
      i -= 1;
      let j = n % (i + 1);
      n := n / (i + 1);
      let tmp = deck[i];
      deck[i] := deck[j];
      deck[j] := tmp;
    };
  };

  public func entropyToNat(bytes : [Nat8]) : Nat {
    var n : Nat = 0;
    for (b in bytes.vals()) { n := n * 256 + Nat8.toNat(b) };
    n;
  };

  let RANKS : [Types.CardRank] = [#Two, #Three, #Four, #Five, #Six, #Seven, #Eight, #Nine, #Ten, #Jack, #Queen, #King, #Ace];
  let SUITS : [Types.CardSuit] = [#Hearts, #Diamonds, #Clubs, #Spades];

  public func cardOf(c : Nat8) : Types.Card { { rank = RANKS[rankOf(c)]; suit = SUITS[suitOf(c)] } };

  // Blackjack value: 2..10 face value, Jack/Queen/King = 10, Ace = 11 (soft
  // -- see handTotal for how a hand full of aces gets reduced to stay <=21
  // where possible).
  public func rankValue(c : Nat8) : Nat {
    let r = rankOf(c);
    if (r <= 8) { r + 2 } else if (r <= 11) { 10 } else { 11 }; // r==12 is Ace
  };

  // Sums every card at Ace=11, then downgrades one Ace at a time to 1
  // (subtracting 10) while the total is still over 21 and an Ace is still
  // being counted as 11 -- the one function every decision point in the
  // game needs (bust check, natural check via `handTotal(c)==21 and
  // c.size()==2`, and the dealer's stand-on-17 rule), since this project's
  // dealer never hits a soft 17, so no separate soft/hard flag is ever
  // needed anywhere else.
  public func handTotal(cards : [Nat8]) : Nat {
    var total = 0;
    var aces = 0;
    for (c in cards.vals()) {
      total += rankValue(c);
      if (rankOf(c) == 12) { aces += 1 };
    };
    while (total > 21 and aces > 0) {
      total -= 10;
      aces -= 1;
    };
    total;
  };
}
