import { AMOUNT_PATTERN, containsMoney, parseMoney, unitFromText, unparsedScaleAfter } from './money.js';
import type { Claim, Metric, SourceText } from './types.js';
import { z } from 'zod';
import type { Claude } from './claude.js';

const quoteSchema = z.string().min(1).max(12000).regex(/\S/);
const fieldSchema = z.string().max(128);
export const claimsSchema = z.strictObject({ claims: z.array(z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('money'), quote: quoteSchema, amount: fieldSchema.min(1), unit: fieldSchema, period: fieldSchema }),
  z.strictObject({ type: z.literal('text'), quote: quoteSchema }),
  z.strictObject({ type: z.literal('contract'), quote: quoteSchema }),
])).max(100) });
export interface Extraction { claims: Claim[]; mocked: boolean }
export type ClaimExtractor = (source: SourceText) => Promise<Extraction>;
export function createClaimExtractor(claude: Claude, log: (note: { dropped_claims: number }) => void = console.info): ClaimExtractor {
  return async source => {
    const result = await claude.json(claimsSchema,
      'Extract every factual claim from this pitch, memo, or transcript. Copy each quote exactly, including whitespace and punctuation, as a contiguous source substring. Use type money, text, or contract. For money, copy the stated amount, unit/currency and period as text, never normalize or compute them. Use empty strings for unstated unit or period. Include sufficient context in the quote to identify the metric, amount, currency and period. Never invent a source or citation. Do not return commentary.',
      { text: source.text }, 4096);
    if (!result) return { claims: extractClaims(source), mocked: true };
    const claims: Claim[] = [];
    const offsets = new Map<string, number>();
    let dropped = 0;
    for (const labelled of result.claims) {
      // Code, not Claude's label, decides whether a quote is money. Money never reaches Jev as text.
      let item: typeof labelled = labelled.type !== 'money' && containsMoney(labelled.quote)
        ? { type: 'money', quote: labelled.quote, unit: '', period: '', amount: /[+-]?\d[\d,]*(?:\.\d+)?/.exec([...labelled.quote
          .matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))].find(match => containsMoney(match[0]))?.[0] ?? '')?.[0] ?? '' }
        : labelled;
      const offset = source.text.indexOf(item.quote, offsets.get(item.quote) ?? 0);
      if (offset < 0) { dropped++; continue; }
      offsets.set(item.quote, offset + item.quote.length);
      let inheritedPeriod: string | null = null;
      let inheritedScale = 1n;
      let usd = true;
      const headings: string[] = [];
      for (const line of source.text.slice(0, offset).split(/\r?\n/)) {
        if (!/\b(revenue|cash|debt|contracts?|CT-\d+)\b/i.test(line)) {
          if (periodFromLine(line)) inheritedPeriod = periodFromLine(line);
          if (unitFromText(line)) inheritedScale = unitFromText(line)!;
          if (/^\s*(?:currency\s*:\s*)?(?:USD|EUR|GBP|CAD|JPY|AUD|CHF|CNY)\b/i.test(line)) usd = /\bUSD\b/i.test(line);
          headings.push(line);
        }
      }
      // The last currency note above the quote decides the currency of bare numbers.
      const currencyNote = headings.flatMap(line => [...line.matchAll(/\b(USD|US\s+dollars?|EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR)\b|(\$)|([€£¥])/gi)]).pop();
      const currency: 'USD' | 'other' | null = !currencyNote ? null : currencyNote[2] || /^(?:USD|US)/i.test(currencyNote[1] ?? '') ? 'USD' : 'other';
      // A bare number in a money sentence (no $ or USD) is money whatever Claude labelled it; its currency comes from context.
      let bare = false;
      if (item.type !== 'money') {
        const amount = bareMoneyAmount(item.quote);
        if (amount !== null) { item = { type: 'money', quote: item.quote, amount, unit: '', period: '' }; bare = true; }
      }
      // The whole source line holds the claim's context too: "Target 1, 2026 Q3. Cash USD 480,000." dates the
      // amount even when Claude quoted only the amount. An unambiguous period on the line beats an inherited one.
      const lineStart = source.text.lastIndexOf('\n', offset - 1) + 1;
      const lineEnd = source.text.indexOf('\n', offset + item.quote.length);
      const line = source.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, '');
      const linePeriod = periodFromLine(line);
      const context = [item.quote, line, ...headings].join('\n');
      const claim: Claim = { metric: item.type === 'money' ? 'other-money' : item.type,
        type: item.type, source, quote: item.quote, offset, money: null,
        period: periodFromLine(item.quote) ?? (linePeriod && linePeriod !== 'AMBIGUOUS' ? linePeriod : null)
          ?? quarterInYearOf(item.quote, inheritedPeriod) ?? inheritedPeriod };
      if (item.type === 'money') {
        claim.stated = { amount: item.amount, unit: item.unit, period: item.period };
        const metrics = [...new Set(item.quote.toLowerCase().match(/\b(?:revenue|cash|debt)\b/g))];
        if (metrics.length === 1) claim.metric = metrics[0] as Metric;
        else if (metrics.length > 1) {
          // A quote covering several metrics: the label belongs to the amount it directly precedes.
          const at = item.quote.indexOf(item.amount);
          const label = at < 0 ? null : /\b(revenue|cash(?:\s+on\s+hand)?|(?:total\s+)?debt)\b(?:\s*(?:for\s+the\s+period|was|is|of|[:,="]|USD|US\s+dollars?|\$))*\s*$/i
            .exec(item.quote.slice(0, at))?.[1];
          if (label) claim.metric = /revenue/i.test(label) ? 'revenue' : /cash/i.test(label) ? 'cash' : 'debt';
        }
        const statedPeriod = item.period ? normalizePeriod(item.period) ?? quarterInYearOf(item.period, inheritedPeriod) ?? 'AMBIGUOUS' : claim.period;
        claim.period = claim.period && statedPeriod !== claim.period ? 'AMBIGUOUS' : statedPeriod;
        const grounded = item.quote.includes(item.amount) && (!item.unit || item.unit.split(/\s+/).every(word => context.includes(word)))
          && (!item.period || context.includes(item.period));
        const unit = /^(?:(?:USD|US dollars?|dollars?|\$)\s*)?(?:(?:in\s+)?(trillions?|billions?|millions?|thousands?|bn|mm|tn|[KMB]))?(?:\s*(?:USD|US dollars?|dollars?))?$/i.exec(item.unit.trim());
        const numericText = /[+-]?\d[\d,]*(?:\.\d+)?/.exec(item.amount)?.[0];
        const amounts = [...item.quote.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))]
          .filter(match => /[+-]?\d[\d,]*(?:\.\d+)?/.exec(match[0])?.[0] === numericText
            && !/^(?:[\d,]|\.\d|\w)/.test(item.quote.slice(match.index! + match[0].length)));
        // A scale word code cannot parse ("1.4 tril") must never be dropped: the bare number would pass as dollars.
        if (amounts.length === 1) {
          claim.amountIndex = amounts[0]!.index;
          const rest = item.quote.slice(amounts[0]!.index! + amounts[0]![0].length);
          const plainUnit = /^(?:USD|US dollars?|dollars?|\$)?$/i.test(item.unit.trim());
          const otherCurrency = /\b(?:EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR)\b|[€£¥]/i.test(item.unit);
          if (unparsedScaleAfter(rest) || (!unit && !plainUnit && !otherCurrency)) claim.scaleUnparsed = true;
        }
        try {
          if (grounded && unit && !claim.scaleUnparsed && usd && (!bare || currency === 'USD') && amounts.length === 1 && !/\b(?:EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR)\b|[\u20ac\u00a3\u00a5]/i.test(item.quote)) {
            const scale = unit[1] ? parseMoney(`1 ${unit[1]}`).cents / 100n : inheritedScale;
            claim.money = parseMoney(amounts[0]![0], scale);
          }
        } catch { }
        if (!grounded) claim.period = 'AMBIGUOUS';
      }
      // Whatever Claude's label, a signed-contracts assertion is checked against the register.
      if (signedContractsAssertion(item.quote)) claim.metric = 'contracts';
      claims.push(claim);
    }
    log({ dropped_claims: dropped });
    return { claims, mocked: false };
  };
}

// A bare number (no $ or USD) in a sentence about money, ignoring years, dates, quarters, percentages and counted nouns.
const MONEY_WORDS = /\b(?:revenue|sales|cash|debt|bookings|arr|mrr|income|profit|burn|funding|raised|expenses?|costs?)\b/i;
// Returns null when the quote is not a money sentence, '' when it is but the amount cannot be parsed safely
// (the claim then stays NEEDS_REVIEW and never reaches Jev), otherwise the single bare amount.
const MONTH = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?`;
const QUALIFIER = /^\s*(?:,\s*)?(?:for|in|as\s+of|as\s+at|during|at|by|ended|ending|through|over|on|since|from|within|per)\b/i;
export function bareMoneyAmount(quote: string): string | null {
  if (!MONEY_WORDS.test(quote)) return null;
  const blank = (match: string) => ' '.repeat(match.length);
  const blanked = quote.replace(new RegExp(String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*(?:19|20)\d{2})?`, 'gi'), blank)
    .replace(periodPattern, blank).replace(/\b\d{4}-\d{2}-\d{2}\b/g, blank).replace(/\b(?:Q[1-4]|H[12]|FY\s*\d{2})\b/gi, blank);
  const found = [...blanked.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))].filter(match => !/^(?:19|20)\d{2}$/.test(match[0].trim()))
    .filter(match => !/^\s*%/.test(blanked.slice(match.index! + match[0].length)));
  if (!found.length) return null;
  if (found.length > 1) return '';
  const match = found[0]!;
  const after = blanked.slice(match.index! + match[0].length).replace(/^\.(?!\d)/, '');
  const scaled = /(?:[KMB]|illions?|housands?)$/i.test(match[0]);
  // Ordinary period qualifiers may follow; anything else (a counted noun, say) is not safely money.
  if (/^\s*$/.test(after) || QUALIFIER.test(after) || (scaled && /^\s*[^a-z]/i.test(after))) return /[+-]?\d[\d,]*(?:\.\d+)?/.exec(match[0])?.[0] ?? '';
  return '';
}
// True when a quote, possibly a full sentence, affirms that all (material) contracts are signed.
// Negated forms ("not all contracts are signed", "contracts are not signed") are not affirmations.
export function signedContractsAssertion(quote: string): boolean {
  const pattern = /\b(?:all\s+)?(?:(?:of\s+)?(?:our|the)\s+)?(?:material\s+)?contracts\s+(?:are|have\s+been|were)\s+(?:all\s+|now\s+|fully\s+)?signed\b/gi;
  return [...quote.matchAll(pattern)].some(match => {
    const before = quote.slice(0, match.index);
    return !/\b(?:not|no|never|none|n't|nor)\s*$/i.test(before) && !/\b(?:not|never|un)\s*signed\b/i.test(match[0]);
  }) && !/\bcontracts\s+(?:are|have|were)\s*(?:not|n't|never|been\s+not)\b|\bnot\s+(?:all|every)\b[^.]*\bcontracts?\b|\b(?:not|no)\s+(?:yet\s+)?(?:material\s+)?contracts?\b|\bunsigned\b/i.test(quote);
}
// Period spellings: Q3 2026, 2026-Q3, 3Q26, 3Q2026, Q3'26, "third quarter 2026", FY2026, 2026-09-30.
const periodPattern = /\b(?:Q[1-4]\s*[-/]?\s*(?:FY\s*)?20\d{2}|(?:FY\s*)?20\d{2}\s*[-/]?\s*Q[1-4]|20\d{2}-\d{2}-\d{2}|(?:FY\s*|fiscal year\s*|year\s+)20\d{2}|[1-4]Q\s*['’]?\s*(?:20)?\d{2}|Q[1-4]\s*['’]\d{2}|(?:first|second|third|fourth)[-\s]quarter(?:\s+of)?(?:\s+fiscal)?\s+(?:FY\s*)?20\d{2})\b/gi;
const ORDINAL_QUARTER: Record<string, number> = { FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4 };
export function normalizePeriod(text: string): string | null {
  const upper = text.trim().toUpperCase();
  const apostrophe = /^Q([1-4])\s*['’]\s*(\d{2})$/.exec(upper);
  if (apostrophe) return `20${apostrophe[2]}-Q${apostrophe[1]}`;
  const spaced = upper.replace(/[-\s]+/g, ' ');
  const ordinal = /^(FIRST|SECOND|THIRD|FOURTH) QUARTER(?: OF)?(?: FISCAL)?(?: FY)? ?(20\d{2})$/.exec(spaced);
  if (ordinal) return `${ordinal[2]}-Q${ORDINAL_QUARTER[ordinal[1]!]}`;
  const short = /^([1-4])Q ?['’]? ?(?:20)?(\d{2})$/.exec(spaced);
  if (short) return `20${short[2]}-Q${short[1]}`;
  const value = upper.replace(/FISCAL YEAR|YEAR/g, 'FY').replace(/\s+/g, '');
  if (/^20\d{2}-\d{2}-\d{2}$/.test(value)) return `ASOF:${value}`;
  if (!/^(?:(?:FY)?20\d{2}(?:[-/]?Q[1-4])?|Q[1-4][-/]?(?:FY)?20\d{2})$/.test(value)) return null;
  const year = /20\d{2}/.exec(value)?.[0];
  const quarter = /Q[1-4]/.exec(value)?.[0];
  return year ? (quarter ? `${year}-${quarter}` : `FY${year}`) : null;
}
// Every period spelled in a line, in reading order (table column headers rely on the order).
export function periodsInOrder(line: string): (string | null)[] { return [...line.matchAll(periodPattern)].map(m => normalizePeriod(m[0])); }
export function stripPeriods(line: string, replacement = ' '): string { return line.replace(periodPattern, replacement); }
// A quarter named without a year ("in the third quarter", "Q3"), as 1-4. Null when the text names a year too.
export function quarterOnly(text: string): number | null {
  if (stripPeriods(text) !== text) return null;
  const word = /\b(first|second|third|fourth)[-\s]quarter\b/i.exec(text)?.[1];
  if (word) return ORDINAL_QUARTER[word.toUpperCase()]!;
  const digit = /\bQ([1-4])\b|\b([1-4])Q\b/i.exec(text);
  return digit ? Number(digit[1] ?? digit[2]) : null;
}
// "third quarter" plus a dated heading (2026-Q3 or FY2026) names 2026-Q3.
export function quarterInYearOf(text: string, base: string | null): string | null {
  const quarter = quarterOnly(text);
  const year = /^(20\d{2})(?:-Q[1-4])?$|^FY(20\d{2})$/.exec(base ?? '');
  return quarter && year ? `${year[1] ?? year[2]}-Q${quarter}` : null;
}
export function periodFromLine(line: string): string | null {
  const periods = [...line.matchAll(periodPattern)].map(m => normalizePeriod(m[0]));
  const bare = /^\s*(?:period\s*[:,]\s*)?(20\d{2})\s*$/i.exec(line);
  if (bare) periods.push(normalizePeriod(bare[1]!));
  return new Set(periods).size > 1 ? 'AMBIGUOUS' : periods[0] ?? null;
}
// Single-line CSV/semicolon records, including quoted commas and escaped quotes.
// Multiline CSV fields are deliberately outside this small extractor's scope.
function record(line: string): string[] | null {
  const separator = line.includes(';') ? ';' : ',';
  if (!line.includes(separator)) return null;
  const fields: string[] = [];
  let field = ''; let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === separator && !quoted) { fields.push(field.trim()); field = ''; }
    else field += char;
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields;
}
export function extractClaims(source: SourceText): Claim[] {
  const claims: Claim[] = [];
  let period: string | null = null;
  let scale = 1n;
  let usd = true;
  for (const lineMatch of source.text.matchAll(/[^\r\n]+/g)) {
    const rawLine = lineMatch[0];
    const line = rawLine.trim();
    const offset = lineMatch.index! + rawLine.indexOf(line);
    if (!line) continue;
    const linePeriod = periodFromLine(line);
    const lineScale = unitFromText(line);
    if (/^(?:currency\s*:\s*)?(?:USD|EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR)\b/i.test(line) && !/\b(revenue|cash|debt)\b/i.test(line))
      usd = /\bUSD\b/i.test(line);
    const columns = record(line);
    if (columns && /^(revenue|cash|debt)$/i.test(columns[0]!)) {
      const csvPeriod = columns[2] ? normalizePeriod(columns[2]) ?? 'AMBIGUOUS' : linePeriod ?? period;
      let money = null;
      try { if (usd && columns.length <= 3) money = parseMoney(columns[1]!, scale); } catch { /* Keep unsupported claims for review. */ }
      claims.push({ metric: columns[0]!.toLowerCase() as Metric, source, quote: line, period: csvPeriod, money, offset });
      continue;
    }
    const expression = new RegExp(String.raw`\b(revenue|cash(?:\s+on\s+hand)?|(?:total\s+)?debt)\b"?\s*(?:for\s+the\s+period\s+)?(?:(?:was|is|of|[:,=])\s*)?"?(${AMOUNT_PATTERN})(?![\d,]|\.\d|\s*(?:EUR|GBP|CAD)\b)`, 'gi');
    for (const match of line.matchAll(expression)) {
      // Avoid treating a currency-free year or a malformed amount prefix as money.
      const after = line.slice(match.index! + match[0].length);
      if (/^\w/.test(after) || /^(?:\s*[-/]?\s*Q[1-4])\b/i.test(after)) continue;
      const metric = /revenue/i.test(match[1]!) ? 'revenue' : /cash/i.test(match[1]!) ? 'cash' : 'debt';
      try {
        claims.push({ metric, source, quote: match[0], period: linePeriod ?? period, offset: offset + match.index!,
          money: usd ? parseMoney(match[2]!, scale) : null });
      } catch { /* Unsupported amounts cannot become verified numeric claims. */ }
    }
    const contracts = /\b(?:all\s+)?(?:material\s+)?contracts\s+are\s+signed\b/gi;
    for (const match of line.matchAll(contracts)) {
      // Do not turn "not all contracts are signed" into an affirmative claim.
      if (/\bnot\s*$/i.test(line.slice(0, match.index))) continue;
      claims.push({ metric: 'contracts', source, quote: match[0], money: null, period: linePeriod ?? period, offset: offset + match.index! });
    }
    // Context headings apply to following rows, not inline units/periods of other claims.
    if (!/\b(revenue|cash|debt|contracts?|CT-\d+)\b/i.test(line)) {
      if (linePeriod) period = linePeriod;
      if (lineScale) scale = lineScale;
    }
  }
  return claims;
}
export interface ContractRow { id: string; signed: boolean | null; quote: string; source: SourceText; period: string | null }
function contractPeriodFromLine(line: string): string | null {
  const periods = [periodFromLine(line)].filter((p): p is string => p !== null);
  for (const match of line.matchAll(/\bas\s+of\s+([a-z]+)\s+(\d{1,2}),\s*(20\d{2})\b/gi)) {
    const month = 'january february march april may june july august september october november december'.split(' ').indexOf(match[1]!.toLowerCase());
    const day = Number(match[2]); const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day));
    periods.push(month < 0 || date.getUTCMonth() !== month || date.getUTCDate() !== day ? 'AMBIGUOUS'
      : `ASOF:${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return new Set(periods).size > 1 ? 'AMBIGUOUS' : periods[0] ?? null;
}
export function sameContractPeriod(register: string | null, claim: string | null): boolean {
  if (samePeriod(register, claim)) return true;
  // A contract-status snapshot at calendar quarter end also covers that quarter.
  const asOf = /^ASOF:(20\d{2})-(03-31|06-30|09-30|12-31)$/.exec(register ?? '');
  return asOf !== null && claim === `${asOf[1]}-Q${['03-31', '06-30', '09-30', '12-31'].indexOf(asOf[2]!) + 1}`;
}
export function contractRows(source: SourceText): ContractRow[] {
  let period: string | null = null;
  let header: string[] | null = null;
  const result: ContractRow[] = [];
  for (const line of source.text.split(/\r?\n/)) {
    const linePeriod = contractPeriodFromLine(line);
    const columns = record(line);
    if (columns?.some(c => /^(contract_id|contract|id)$/i.test(c)) && columns.some(c => /^(status|signed)$/i.test(c))) {
      header = columns.map(c => c.toLowerCase()); continue;
    }
    if (columns && (header || /^[A-Z]+-\d+$/i.test(columns[0]!))) {
      const idIndex = header ? header.findIndex(c => /^(contract_id|contract|id)$/.test(c)) : 0;
      const statusIndex = header ? header.findIndex(c => /^(status|signed)$/.test(c)) : 1;
      const id = columns[idIndex]; const status = columns[statusIndex]?.toLowerCase();
      const periodIndex = header?.indexOf('period') ?? -1;
      const rowPeriod = periodIndex >= 0 && columns[periodIndex] ? normalizePeriod(columns[periodIndex]!) ?? 'AMBIGUOUS' : linePeriod ?? period;
      if (id && /^[\w-]+$/.test(id)) result.push({ id, signed: status === 'signed' ? true : status === 'unsigned' ? false : null,
        quote: line.trim(), source, period: rowPeriod });
      continue;
    }
    // Register IDs may be CT-102, vendor-7, or another non-whitespace identifier.
    const delimited = /^\s*([\w-]+)\s*[,;:\t]\s*(unsigned|signed)\s*(?:[,;\t].*)?$/i.exec(line);
    const matches = delimited ? [delimited] : [...line.matchAll(/\b([A-Z]+-\d+)\s+(?:is\s+|was\s+)?(unsigned|signed)\b/gi)];
    for (const match of matches) result.push({ id: match[1]!, signed: match[2]!.toLowerCase() === 'signed', quote: line.trim(), source, period: linePeriod ?? period });
    if (!matches.length && linePeriod) period = linePeriod;
  }
  return result;
}
export function samePeriod(left: string | null, right: string | null): boolean {
  return left !== 'AMBIGUOUS' && right !== 'AMBIGUOUS' && left === right;
}
export function isMetric(value: Claim['metric']): value is Metric { return value === 'revenue' || value === 'cash' || value === 'debt'; }
