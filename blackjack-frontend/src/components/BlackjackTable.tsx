import { useState } from "react";
import type { BlackjackView, Card as CardType, PlayerHandView, ResolvedPlayerHandView, Rules } from "../bindings/blackjack/blackjack";
import { cardLabel, formatCompact, isRedSuit } from "../lib/format";

// Cards just appear (no multi-second reel choreography needed here) --
// each one gets a brief scale-in staggered by its position in the hand, via
// this shared per-card delay rather than a separate animation queue.
const CARD_STAGGER_MS = 55;

function PlayingCard({ card, index, flip }: { card: CardType; index: number; flip?: boolean }) {
  return (
    <span
      className={`bj-card ${isRedSuit(card.suit) ? "bj-card-red" : "bj-card-black"} ${flip ? "bj-card-flip" : ""}`}
      style={{ animationDelay: `${index * CARD_STAGGER_MS}ms` }}
    >
      {cardLabel(card)}
    </span>
  );
}

// The dealer's hidden hole card -- rendered face-down. The canister itself
// never sends its real value while a round is #Open (see main.mo's
// viewOf/Round comments), so this is never actually "hiding" real data
// client-side, it's just the honest visual for "not resolved yet".
function CardBack({ index, shuffle }: { index: number; shuffle?: boolean }) {
  return (
    <span
      className={`bj-card bj-card-back ${shuffle ? "bj-card-shuffle" : ""}`}
      style={{ animationDelay: `${index * CARD_STAGGER_MS}ms` }}
      aria-hidden="true"
    />
  );
}

function HandZone({
  label,
  hand,
  active,
  bet,
}: {
  label: string;
  hand: PlayerHandView | ResolvedPlayerHandView;
  active: boolean;
  bet: bigint | null;
}) {
  const showChip = bet !== null && bet > 0n;
  return (
    <div className={`bj-zone ${active ? "bj-zone-active" : ""}`}>
      <div className="bj-zone-head">
        <span className="bj-row-label">{label}</span>
        <span className="bj-total-badge">{Number(hand.total)}</span>
      </div>
      <div className="bj-hand">
        {hand.cards.map((c, i) => (
          <PlayingCard key={i} card={c} index={i} />
        ))}
      </div>
      {showChip && (
        <div className="bj-chip-stack">
          <span className="bj-chip" aria-hidden="true" />
          <span className="bj-chip-amount">{formatCompact(bet)}</span>
        </div>
      )}
    </div>
  );
}

export interface BlackjackTableProps {
  round: BlackjackView | null;
  dealing: boolean; // true from the instant Deal is clicked until the response lands -- purely for the "shuffling" placeholder below, real latency is unaffected
  shakeTrigger: number; // bump to play a brief table shake (big wins)
  stamp: { text: string; kind: "up" | "down" | "neutral" } | null; // short, punchy result label stamped across the felt -- same lifecycle as the text banner below the table
  rules: Rules | null; // disclosed payout/dealer rules, shown on the felt's own ribbon
  bet: bigint | null; // the original per-hand wager, shown as a chip under each player hand while a round exists
}

export function BlackjackTable({ round, dealing, shakeTrigger, stamp, rules, bet }: BlackjackTableProps) {
  const isOpen = round?.__kind__ === "Open";
  const isResolved = round?.__kind__ === "Resolved";

  const dealerCards = isResolved ? round.Resolved.dealerCards : isOpen ? [round.Open.dealerUpCard] : [];
  const dealerTotal = isResolved ? round.Resolved.dealerTotal : null;
  const hands: (PlayerHandView | ResolvedPlayerHandView)[] = isResolved ? round.Resolved.hands : isOpen ? round.Open.hands : [];
  const activeHandIndex = isOpen ? Number(round.Open.activeHandIndex) : -1;
  const split = hands.length > 1;

  const [shaking, setShaking] = useState(false);
  const [lastSeenShake, setLastSeenShake] = useState(shakeTrigger);
  if (shakeTrigger !== lastSeenShake && !shaking) {
    // Setting state during render here is intentional and safe -- the
    // React-docs-endorsed "adjusting state when a prop changes" pattern.
    setLastSeenShake(shakeTrigger);
    setShaking(true);
  }

  return (
    <div className={`bj-table ${shaking ? "shake" : ""}`} onAnimationEnd={() => setShaking(false)}>
      <div className="bj-corner bj-corner-left" aria-hidden="true" />
      <div className="bj-corner bj-corner-right" aria-hidden="true" />

      {stamp && <div className={`bj-stamp bj-stamp-${stamp.kind}`}>{stamp.text}</div>}

      <div className="bj-banner">
        <span className="bj-banner-title">Blackjack</span>
        {rules && (
          <span className="bj-banner-ribbon">
            Blackjack pays {(Number(rules.blackjackPayoutBps) / 10000 - 1).toFixed(1)} to 1 &middot; Dealer stands on {Number(rules.dealerStandsOn)}
          </span>
        )}
      </div>

      <div className="bj-zone">
        <div className="bj-zone-head">
          <span className="bj-row-label">Dealer</span>
          {dealerTotal !== null && <span className="bj-total-badge">{Number(dealerTotal)}</span>}
        </div>
        <div className="bj-hand">
          {dealerCards.length === 0 &&
            !isOpen &&
            (dealing ? <CardBack index={0} shuffle /> : <span className="bj-hand-empty">—</span>)}
          {dealerCards.map((c, i) => (
            // Card 0 was already visible as the up-card while #Open (no
            // fresh entrance needed); every card from index 1 on -- the
            // hole card plus anything the dealer drew during stand()'s
            // playout -- was never shown before this exact response, so it
            // gets the flip-reveal treatment instead of the plain deal-in.
            <PlayingCard key={i} card={c} index={i} flip={isResolved && i > 0} />
          ))}
          {isOpen && <CardBack index={dealerCards.length} />}
        </div>
      </div>

      {hands.length === 0 ? (
        <div className="bj-zone">
          <div className="bj-zone-head">
            <span className="bj-row-label">You</span>
          </div>
          <div className="bj-hand">{dealing ? <CardBack index={1} shuffle /> : <span className="bj-hand-empty">—</span>}</div>
        </div>
      ) : (
        <div className={`bj-hands-row ${split ? "bj-hands-split" : ""}`}>
          {hands.map((hand, i) => (
            <HandZone key={i} label={split ? `Hand ${i + 1}` : "You"} hand={hand} active={i === activeHandIndex} bet={bet} />
          ))}
        </div>
      )}
    </div>
  );
}
