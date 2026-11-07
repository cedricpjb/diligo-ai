import type { Money } from './types.js';

const scales: Record<string, bigint> = {
  k: 1000n, thousand: 1000n, thousands: 1000n,
  m: 1000000n, million: 1000000n, millions: 1000000n,
  b: 1000000000n, billion: 1000000000n, billions: 1000000000n,
};
export const AMOUNT_PATTERN = String.raw`(?:USD\s*|\$\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:billions?|millions?|thousands?|[KMB])\b)?(?:\s*\(in\s+(?:thousands|millions|billions)\))?`;
export function unitFromText(text: string): bigint | null {
  const match = /\bin\s+(thousands|millions|billions)\b/i.exec(text);
  return match ? scales[match[1]!.toLowerCase()]! : null;
}
export function parseMoney(text: string, inheritedScale = 1n): Money {
  const match = /^(?:USD\s*|\$\s*)?([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|m|b|thousands?|millions?|billions?)?\s*(?:\(in\s+(thousands|millions|billions)\))?$/i.exec(text.trim());
  if (!match || text.length > 128) throw new Error('Invalid USD amount.');
  const [, sign, whole, fraction = '', suffix, units] = match;
  if (suffix && units) throw new Error('Ambiguous money units.');
  const scale = suffix || units ? scales[(suffix ?? units)!.toLowerCase()]! : inheritedScale;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole!.replaceAll(',', '') + fraction) * scale * 100n;
  if (numerator % denominator !== 0n) throw new Error('Amounts must resolve to whole cents.');
  return {
    cents: (sign === '-' ? -1n : 1n) * numerator / denominator,
    quantum: scale * 100n / denominator || 1n,
  };
}
export const abs = (value: bigint): bigint => value < 0n ? -value : value;
export function decimal(cents: bigint): string {
  return `${cents < 0n ? '-' : ''}${abs(cents) / 100n}.${(abs(cents) % 100n).toString().padStart(2, '0')}`;
}
// Round to nearest, with exact ties away from zero. No floating-point money.
export function roundTo(value: bigint, quantum: bigint): bigint {
  if (quantum < 1n) throw new Error('Invalid rounding quantum.');
  return (value < 0n ? -1n : 1n) * ((abs(value) * 2n + quantum) / (2n * quantum)) * quantum;
}
export function compareMoney(claim: Money, proof: Money) {
  const gap = abs(claim.cents - proof.cents);
  const base = abs(claim.cents);
  const percentage = base === 0n ? (gap === 0n ? 0n : null) : (gap * 10000n * 2n + base) / (2n * base);
  return {
    matches: roundTo(proof.cents, claim.quantum) === claim.cents,
    claimed_usd: decimal(claim.cents), proof_usd: decimal(proof.cents),
    gap_usd: decimal(gap), gap_pct: percentage === null ? null : decimal(percentage),
  };
}
