import type { Money } from './types.js';

const scales: Record<string, bigint> = {
  k: 1000n, thousand: 1000n, thousands: 1000n,
  m: 1000000n, million: 1000000n, millions: 1000000n,
  mm: 1000000n,
  b: 1000000000n, bn: 1000000000n, billion: 1000000000n, billions: 1000000000n,
  tn: 1000000000000n, trillion: 1000000000000n, trillions: 1000000000000n,
};
const SCALE_WORDS = String.raw`trillions?|billions?|millions?|thousands?|bn|mm|tn|[KMB]`;
export const AMOUNT_PATTERN = String.raw`(?:USD\s*|\$\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:${SCALE_WORDS})\b)?(?:\s*\(in\s+(?:thousands|millions|billions|trillions)\))?`;
// Independent of any model label: a dollar sign, USD/dollars, or a scaled number marks money.
const MONEY_HINT = /(?:\$|\bUSD\b|\bUS\s*dollars?\b)\s*[+-]?\d|\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:thousand|million|billion|trillion|bn|mm|tn|[KMB])\b|\d\s*(?:USD|(?:US\s+)?dollars?)\b/i;
export function containsMoney(text: string): boolean { return MONEY_HINT.test(text); }
export function unitFromText(text: string): bigint | null {
  const match = /\bin\s+(thousands|millions|billions|trillions)\b/i.exec(text)
    ?? /\b(thousands|millions|billions|trillions)\s+of\s+(?:US\s+)?dollars\b/i.exec(text);
  return match ? scales[match[1]!.toLowerCase()]! : null;
}
// A word that looks like a scale ("tril", "crore", "T") but is not one parseMoney understands. The amount before it
// must never be shown as if it were unscaled.
export function unparsedScaleAfter(rest: string): boolean {
  const word = /^\s*([a-z]+)\b/i.exec(rest)?.[1];
  if (!word || /^(?:thousands?|millions?|billions?|trillions?|bn|mm|tn|k|m|b)$/i.test(word)) return false;
  return /^(?:t|tril|trill?ions?|trn|bil|bils?|bilions?|bln|mil|mils?|milions?|mln|mn|cr|crores?|lakhs?|quadrillions?|[a-z]*zillions?|hundreds?)$/i.test(word);
}
export function parseMoney(text: string, inheritedScale = 1n): Money {
  const match = /^(?:USD\s*|\$\s*)?([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(trillions?|billions?|millions?|thousands?|bn|mm|tn|k|m|b)?\s*(?:\(in\s+(thousands|millions|billions|trillions)\))?$/i.exec(text.trim());
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
