import { AMOUNT_PATTERN, parseMoney, unitFromText } from './money.js';
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
    for (const item of result.claims) {
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
      const context = [item.quote, ...headings].join('\n');
      const claim: Claim = { metric: item.type === 'money' ? 'other-money' : item.type,
        type: item.type, source, quote: item.quote, offset, money: null, period: periodFromLine(item.quote) ?? inheritedPeriod };
      if (item.type === 'money') {
        claim.stated = { amount: item.amount, unit: item.unit, period: item.period };
        const metrics = [...new Set(item.quote.toLowerCase().match(/\b(?:revenue|cash|debt)\b/g))];
        if (metrics.length === 1) claim.metric = metrics[0] as Metric;
        const statedPeriod = item.period ? normalizePeriod(item.period) ?? 'AMBIGUOUS' : claim.period;
        claim.period = claim.period && statedPeriod !== claim.period ? 'AMBIGUOUS' : statedPeriod;
        const grounded = item.quote.includes(item.amount) && (!item.unit || item.unit.split(/\s+/).every(word => context.includes(word)))
          && (!item.period || context.includes(item.period));
        const unit = /^(?:(?:USD|US dollars?|dollars?|\$)\s*)?(?:(?:in\s+)?(thousands?|millions?|billions?|[KMB]))?(?:\s*(?:USD|US dollars?|dollars?))?$/i.exec(item.unit.trim());
        const numericText = /[+-]?\d[\d,]*(?:\.\d+)?/.exec(item.amount)?.[0];
        const amounts = [...item.quote.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))]
          .filter(match => /[+-]?\d[\d,]*(?:\.\d+)?/.exec(match[0])?.[0] === numericText
            && !/^(?:[\d,]|\.\d|\w)/.test(item.quote.slice(match.index! + match[0].length)));
        try {
          if (grounded && unit && usd && amounts.length === 1 && !/\b(?:EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR)\b|[\u20ac\u00a3\u00a5]/i.test(item.quote)) {
            const scale = unit[1] ? parseMoney(`1 ${unit[1]}`).cents / 100n : inheritedScale;
            claim.money = parseMoney(amounts[0]![0], scale);
          }
        } catch { }
        if (!grounded) claim.period = 'AMBIGUOUS';
      } else if (item.type === 'contract') {
        if (/^\s*(?:all\s+)?(?:material\s+)?contracts\s+are\s+signed[.!]?\s*$/i.test(item.quote)) claim.metric = 'contracts';
      }
      claims.push(claim);
    }
    log({ dropped_claims: dropped });
    return { claims, mocked: false };
  };
}

const periodPattern = /\b(?:Q[1-4]\s*[-/]?\s*(?:FY\s*)?20\d{2}|(?:FY\s*)?20\d{2}\s*[-/]?\s*Q[1-4]|20\d{2}-\d{2}-\d{2}|(?:FY\s*|fiscal year\s*|year\s+)20\d{2})\b/gi;
export function normalizePeriod(text: string): string | null {
  const value = text.trim().toUpperCase().replace(/FISCAL YEAR|YEAR/g, 'FY').replace(/\s+/g, '');
  if (/^20\d{2}-\d{2}-\d{2}$/.test(value)) return `ASOF:${value}`;
  if (!/^(?:(?:FY)?20\d{2}(?:[-/]?Q[1-4])?|Q[1-4][-/]?(?:FY)?20\d{2})$/.test(value)) return null;
  const year = /20\d{2}/.exec(value)?.[0];
  const quarter = /Q[1-4]/.exec(value)?.[0];
  return year ? (quarter ? `${year}-${quarter}` : `FY${year}`) : null;
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
