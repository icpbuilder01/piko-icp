import { CardRank, CardSuit, type Card } from "../bindings/blackjack/blackjack";

export const RANK_LABEL: Record<CardRank, string> = {
  [CardRank.Two]: "2",
  [CardRank.Three]: "3",
  [CardRank.Four]: "4",
  [CardRank.Five]: "5",
  [CardRank.Six]: "6",
  [CardRank.Seven]: "7",
  [CardRank.Eight]: "8",
  [CardRank.Nine]: "9",
  [CardRank.Ten]: "10",
  [CardRank.Jack]: "J",
  [CardRank.Queen]: "Q",
  [CardRank.King]: "K",
  [CardRank.Ace]: "A",
};

export const SUIT_GLYPH: Record<CardSuit, string> = {
  [CardSuit.Hearts]: "♥",
  [CardSuit.Diamonds]: "♦",
  [CardSuit.Clubs]: "♣",
  [CardSuit.Spades]: "♠",
};

export function isRedSuit(suit: CardSuit): boolean {
  return suit === CardSuit.Hearts || suit === CardSuit.Diamonds;
}

export function cardLabel(card: Card): string {
  return `${RANK_LABEL[card.rank]}${SUIT_GLYPH[card.suit]}`;
}

const DECIMALS = 8; // both PIKO and ICP use 8 decimals
const DECIMALS_FACTOR = 10n ** BigInt(DECIMALS);

export function formatAmount(raw: bigint | number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(Math.trunc(raw));
  const whole = value / DECIMALS_FACTOR;
  const frac = value % DECIMALS_FACTOR;
  const fracStr = frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return fracStr.length > 0 ? `${wholeStr}.${fracStr}` : wholeStr;
}

export const formatPiko = formatAmount;
export const formatIcp = formatAmount;

// Rounds to `decimals` places before formatting -- for ambient stat
// displays (bankroll, balance, payout, bet) where a raw on-chain amount can
// carry all 8 decimals of real precision (e.g. after ledger fees), which
// reads as visual clutter ("1,094.16358 PIKO") rather than useful
// information at a glance. Never used for the actual amount sent to the
// canister -- only display.
export function formatCompact(raw: bigint | number, decimals = 2): string {
  const value = typeof raw === "bigint" ? raw : BigInt(Math.trunc(raw));
  const factor = 10n ** BigInt(DECIMALS - decimals);
  const rounded = ((value + factor / 2n) / factor) * factor;
  return formatAmount(rounded);
}

/** Parses a user-typed decimal amount (e.g. "1.5") into raw e8s, or null if invalid. */
export function parseAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > DECIMALS) return null;
  const paddedFrac = fracPart.padEnd(DECIMALS, "0");
  try {
    return BigInt(wholePart) * DECIMALS_FACTOR + BigInt(paddedFrac || "0");
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function shortPrincipal(principal: string): string {
  if (principal.length <= 16) return principal;
  const parts = principal.split("-");
  if (parts.length <= 2) return principal;
  return `${parts[0]}...${parts[parts.length - 1]}`;
}

export function timeAgo(nanoseconds: bigint): string {
  const ms = Number(nanoseconds / 1_000_000n);
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
