import { formatCompact, formatPiko } from "../lib/format";
import { PikoIcon } from "./PikoIcon";

interface ChipAmountProps {
  amount: bigint;
  unit: string;
  size?: number;
  // Full 8-decimal precision by default; pass e.g. 2 for an ambient/glance
  // display (bankroll, balance) where the raw on-chain figure's full
  // precision is just visual noise -- see formatCompact's own comment.
  decimals?: number;
}

// Real PIKO gets the little PIKO mark (matching the mining app's amount
// display); the Free Play table's play-money "chips" don't, since they
// aren't the real token.
export function ChipAmount({ amount, unit, size = 13, decimals }: ChipAmountProps) {
  return (
    <span className="chip-amount">
      {unit === "PIKO" && <PikoIcon size={size} />}
      {decimals !== undefined ? formatCompact(amount, decimals) : formatPiko(amount)} {unit}
    </span>
  );
}
