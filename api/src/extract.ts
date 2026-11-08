import { AMOUNT_PATTERN, containsMoney, currencyOf, parseMoney, unitFromText, unparsedScaleAfter } from './money.js';
import type { Claim, Metric, SourceText } from './types.js';
import { z } from 'zod';
import type { Claude } from './claude.js';
import { checkableClaim } from './quality.js';

const quoteSchema = z.string().min(1).max(12000).regex(/\S/);
const fieldSchema = z.string().max(128);
export const claimSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('money'), quote: quoteSchema, amount: fieldSchema.min(1), unit: fieldSchema, period: fieldSchema }),
  z.object({ type: z.literal('text'), quote: quoteSchema }),
  z.object({ type: z.literal('contract'), quote: quoteSchema }),
]);
// Validate the envelope separately so one malformed claim cannot discard its neighbours.
export const claimsSchema = z.object({ claims: z.array(z.unknown()).max(300) });
export interface Extraction { claims: Claim[]; mocked: boolean }
export type ClaimExtractor = (source: SourceText) => Promise<Extraction>;
// Long documents are read in chunks: one call per ~6,000 characters with a modest output limit, so no single answer
// runs into the output limit or the time limit. Quotes are still verified against the full source.
export const CHUNK_CHARS = 6000;
export const CHUNK_MAX_TOKENS = 4096;
export const MAX_CLAIMS = 300;
const CHUNK_CONCURRENCY = 3;
// Counts only: never document text. One note per extracted source.
export interface ExtractionNote {
  dropped_claims: number; // quote not found word for word in the source
  chunks: number; failed_chunks: number; // a failed chunk used the regex fallback after Claude's retry
  claims_returned: number; duplicates: number; fallback_claims: number; kept_claims: number; capped: number;
  invalid_claims?: number;
  invalid_fields?: string[];
  split_chunks?: number;
  non_claims?: number;
}
export interface Chunk { start: number; end: number; text: string }
// Split on the strongest boundary in the second half of each window: a blank line, then a speaker turn
// ("Name:" or a short name line), then any line break, then a sentence end. Chunks cover the text exactly once.
export function splitChunks(text: string, size = CHUNK_CHARS): Chunk[] {
  if (text.length <= size) return [{ start: 0, end: text.length, text }];
  const lastAfter = (window: string, pattern: RegExp, min: number): number | null => {
    let best: number | null = null;
    for (const match of window.matchAll(pattern)) { const at = match.index! + match[0].length; if (at >= min && at < window.length) best = at; }
    return best;
  };
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const window = text.slice(start, end);
      const min = Math.floor(size / 2);
      const cut = lastAfter(window, /\n[ \t]*\n/g, min) ?? lastAfter(window, /\n(?=[A-Z][\w .,'&-]{1,60}:|[A-Z][A-Za-z .,'&-]{1,60}\r?\n)/g, min)
        ?? lastAfter(window, /\n/g, min) ?? lastAfter(window, /[.!?]["')\]]?\s+/g, min);
      if (cut !== null) end = start + cut;
    }
    chunks.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]!, index); }
  }));
  return results;
}
const EXTRACTION_INSTRUCTIONS =
      'Extract every factual claim from this pitch, memo, or transcript. Make every claim atomic: one metric and one number per claim. Split a compound sentence into separate claims, for example "net income of $15.3 billion, EPS of $5.57, and an ROTCE of 20%" becomes three claims: "net income of $15.3 billion", "EPS of $5.57" and "ROTCE of 20%". Keep the metric name next to its number in each quote and put a change ("up 8%", "year-on-year") in its own claim. Never combine two numbers in one quote. Copy each quote exactly, including whitespace and punctuation, as a contiguous source substring. Use type money, text, or contract. For money, copy the stated amount, unit/currency and period as text, never normalize or compute them. Use empty strings for unstated unit or period. Include sufficient context in the quote to identify the metric, amount, currency and period. Never invent a source or citation. Do not return commentary.';
export function createClaimExtractor(claude: Claude, log: (note: ExtractionNote) => void = note => console.info(JSON.stringify(note))): ClaimExtractor {
  return async source => {
    const initial = splitChunks(source.text);
    let splits = 0;
    type Result = { chunk: Chunk; result: z.infer<typeof claimsSchema> | null };
    const read = async (chunk: Chunk, label: string, depth = 0): Promise<Result[]> => {
      let truncated = false;
      const result = await claude.json(claimsSchema,
        `${EXTRACTION_INSTRUCTIONS} Return only complete checkable statements with a subject and a verb or a definite metric value/status. Exclude names, speaker/job titles, headings, document titles, topic phrases, questions and fragments. Each claim must match: ${JSON.stringify(z.toJSONSchema(claimSchema))}`,
        { text: chunk.text }, CHUNK_MAX_TOKENS, label, () => { truncated = true; });
      // Bound recursive recovery to two splits per path. Children run sequentially inside
      // the parent's worker slot, keeping the global transport limit at three.
      if (truncated && depth < 2 && chunk.text.length > 1) {
        splits++;
        const half = Math.ceil(chunk.text.length / 2);
        const children = [{ start: chunk.start, end: chunk.start + half, text: chunk.text.slice(0, half) },
          { start: chunk.start + half, end: chunk.end, text: chunk.text.slice(half) }];
        const leaves: Result[] = [];
        for (const [index, child] of children.entries()) leaves.push(...await read(child, `${label}.${index + 1}`, depth + 1));
        return leaves;
      }
      return [{ chunk, result }];
    };
    const leaves = (await mapLimit(initial, CHUNK_CONCURRENCY, (chunk, index) => read(chunk, `extract ${index + 1}/${initial.length}`))).flat();
    const chunks = leaves.map(leaf => leaf.chunk);
    const results = leaves.map(leaf => leaf.result);
    const note: ExtractionNote = { dropped_claims: 0, chunks: chunks.length, failed_chunks: results.filter(result => !result).length,
      claims_returned: results.reduce((sum, result) => sum + (result?.claims.length ?? 0), 0), duplicates: 0, fallback_claims: 0, kept_claims: 0, capped: 0 };
    if (splits) note.split_chunks = splits;
    // Every chunk failed (or no key): the whole source uses the regex extractor, exactly as before chunking.
    if (results.every(result => !result)) {
      const claims = extractClaims(source);
      log({ ...note, fallback_claims: claims.length, kept_claims: claims.length });
      return { claims, mocked: true };
    }
    const claims: Claim[] = [];
    const offsets = new Map<string, number>();
    const seen = new Set<string>();
    let dropped = 0;
    for (const [chunkIndex, result] of results.entries()) {
    const chunk = chunks[chunkIndex]!;
    if (!result) {
      // Only this chunk falls back. The regex extractor reads the source up to the chunk's end so headings above it
      // still date and scale its amounts; only claims inside the chunk are kept, each marked as a mock result.
      const fallback = extractClaims({ ...source, text: source.text.slice(0, chunk.end) })
        .filter(claim => (claim.offset ?? -1) >= chunk.start).map(claim => ({ ...claim, source, mocked: true }));
      for (const claim of fallback) {
        const key = `${claim.offset}\0${claim.quote}`;
        if (seen.has(key)) { note.duplicates++; continue; }
        if (claims.length >= MAX_CLAIMS) { note.capped++; continue; }
        seen.add(key); claims.push(claim); note.fallback_claims++;
      }
      continue;
    }
    const queue: z.infer<typeof claimSchema>[] = [];
    for (const [index, raw] of result.claims.entries()) {
      const checked = claimSchema.safeParse(raw);
      if (checked.success) queue.push(checked.data); // z.object strips every unknown key.
      else {
        note.invalid_claims = (note.invalid_claims ?? 0) + 1;
        note.invalid_fields ??= [];
        // Paths come only from the allowlisted schema fields; never log input keys or values.
        for (const issue of checked.error.issues) note.invalid_fields.push(`chunks.${chunkIndex}.claims.${index}${issue.path.length ? `.${issue.path.join('.')}` : ''}`);
      }
    }
    for (let next = 0; next < queue.length; next++) {
      const labelled = queue[next]!;
      // Code, not Claude's label, decides whether a quote is money. Money never reaches Jev as text.
      let item: typeof labelled = labelled.type !== 'money' && containsMoney(labelled.quote)
        ? { type: 'money', quote: labelled.quote, unit: '', period: '', amount: /[+-]?\d[\d,]*(?:\.\d+)?/.exec([...labelled.quote
          .matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))].find(match => containsMoney(match[0]))?.[0] ?? '')?.[0] ?? '' }
        : labelled;
      // A level and a change in one quote ("revenue of $50.9 billion, up 8%") are two claims. Code splits what Claude
      // left joined, using substrings of the same quote, so each part is still verified word for word below.
      if (item.type === 'money') {
        const numeric = /[+-]?\d[\d,]*(?:\.\d+)?/.exec(item.amount)?.[0];
        const found = [...item.quote.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))].filter(match => /[+-]?\d[\d,]*(?:\.\d+)?/.exec(match[0])?.[0] === numeric);
        const cut = found.length === 1 ? changeStart(item.quote, found[0]!.index! + found[0]![0].length) : null;
        if (cut !== null) {
          const level = item.quote.slice(0, cut).replace(/[,;\s]+$/, '');
          const change = item.quote.slice(cut).replace(/^[,;\s]+(?:and\s+)?/i, '').replace(/\s+$/, '');
          if (level && change && level.includes(item.amount)) { item = { ...item, quote: level }; queue.push({ type: 'text', quote: change }); }
        }
      }
      // Verified word for word against the full source: first inside this chunk, then anywhere in the source.
      let offset = source.text.indexOf(item.quote, Math.max(chunk.start, offsets.get(item.quote) ?? 0));
      if (offset >= 0 && offset + item.quote.length > chunk.end) offset = -1;
      if (offset < 0) offset = source.text.indexOf(item.quote, offsets.get(item.quote) ?? 0);
      if (offset < 0 && source.text.includes(item.quote)) offset = source.text.indexOf(item.quote);
      if (offset < 0) { dropped++; continue; }
      if (!checkableClaim(item.quote)) { note.non_claims = (note.non_claims ?? 0) + 1; continue; }
      // The same quote at the same place, returned twice (by two chunks or twice by one), is one claim.
      const key = `${offset}\0${item.quote}`;
      if (seen.has(key)) { note.duplicates++; continue; }
      if (claims.length >= MAX_CLAIMS) { note.capped++; continue; }
      seen.add(key);
      offsets.set(item.quote, offset + item.quote.length);
      let inheritedPeriod: string | null = null;
      let inheritedScale = 1n;
      const headings: string[] = [];
      for (const line of source.text.slice(0, offset).split(/\r?\n/)) {
        // Only context headings may change inherited units/periods. An earlier
        // comparative claim or an analyst's question does not redate the call.
        if (!checkableClaim(line) && !/\?$/.test(line.trim())) {
          const headingPeriod = periodFromLine(line);
          if (headingPeriod && headingPeriod !== 'AMBIGUOUS' && !/\b(?:annual\s+report|form\s+10[- ]?[kq])\b/i.test(line)) inheritedPeriod = headingPeriod;
          if (unitFromText(line)) inheritedScale = unitFromText(line)!;
          headings.push(line);
        }
      }
      // The last currency note above the quote decides the currency of bare numbers.
      const currencyNote = headings.flatMap(line => [...line.matchAll(/\b(USD|US\s+dollars?|EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR)\b|(\$)|([€£¥])/gi)]).pop();
      // No note above the quote: the source as a whole decides. A $/US$/USD marker and no other currency anywhere is USD.
      const whole = currencyOf(source.text);
      const currency: 'USD' | 'other' | null = whole === 'other' ? 'other' : !currencyNote ? (whole === 'USD' ? 'USD' : null) : currencyNote[2] || /^(?:USD|US)/i.test(currencyNote[1] ?? '') ? 'USD' : 'other';
      // A bare number in a money sentence (no $ or USD) is money whatever Claude labelled it; its currency comes from context.
      let bare = false;
      if (item.type !== 'money') {
        const amount = bareMoneyAmount(item.quote);
        if (amount !== null) { item = { type: 'money', quote: item.quote, amount, unit: '', period: '' }; bare = true; }
      }
      // An amount with no $/USD marker of its own takes its currency from context, like any bare number.
      if (item.type === 'money' && currencyOf(item.quote) !== 'USD') bare = true;
      // The whole source line holds the claim's context too: "Target 1, 2026 Q3. Cash USD 480,000." dates the
      // amount even when Claude quoted only the amount. An unambiguous period on the line beats an inherited one.
      const lineStart = source.text.lastIndexOf('\n', offset - 1) + 1;
      const lineEnd = source.text.indexOf('\n', offset + item.quote.length);
      const line = source.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, '');
      const linePeriod = periodFromLine(line);
      // Currency is local to the assertion's sentence. Explicit dollars beat
      // unrelated transcript currencies, but a mixed-currency sentence fails closed.
      const beforeSentence = line.slice(0, offset - lineStart).split(/[.!?](?:\s+|$)/).pop() ?? '';
      const afterSentence = line.slice(offset - lineStart + item.quote.length).split(/[.!?](?:\s+|$)/)[0] ?? '';
      const sentenceCurrency = currencyOf(`${beforeSentence}${item.quote}${afterSentence}`);
      const quoteCurrency = currencyOf(item.quote);
      const context = [item.quote, line, ...headings].join('\n');
      const claim: Claim = { metric: item.type === 'money' ? 'other-money' : item.type,
        type: item.type, source, quote: item.quote, offset, money: null,
        period: periodFromLine(item.quote) ?? (linePeriod && linePeriod !== 'AMBIGUOUS' ? linePeriod : null)
          ?? quarterInYearOf(item.quote, inheritedPeriod) ?? quarterInYearOf(line, inheritedPeriod) ?? inheritedPeriod };
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
        const grounded = item.quote.includes(item.amount) && (!item.unit || item.unit.split(/\s+/).every(word => context.includes(word)
          || (/^(?:USD|US\$|dollars?)$/i.test(word) && quoteCurrency === 'USD')))
          && (!item.period || context.includes(item.period) || (statedPeriod !== 'AMBIGUOUS'
            && (periodFromLine(item.quote) ?? quarterInYearOf(item.quote, inheritedPeriod) ?? inheritedPeriod) === statedPeriod));
        const unit = /^(?:in\s+)?(trillions?|billions?|millions?|thousands?|bn|mm|tn|[KMB])?$/i.exec(item.unit.replace(/\b(?:USD|US|U\.S\.|dollars?|of)\b|\$/gi, ' ').replace(/\s+/g, ' ').trim());
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
          const usd = sentenceCurrency !== 'other' && (quoteCurrency === 'USD' || (bare && currency === 'USD'));
          if (grounded && unit && !claim.scaleUnparsed && usd && amounts.length === 1) {
            const perShare = /\bEPS\b|\bper\s+(?:[a-z]+\s+){0,2}share\b/i.test(item.quote);
            const scale = perShare ? 1n : unit[1] ? parseMoney(`1 ${unit[1]}`).cents / 100n : inheritedScale;
            claim.money = parseMoney(amounts[0]![0], scale);
          }
        } catch { }
        if (!grounded) claim.period = 'AMBIGUOUS';
      }
      // Whatever Claude's label, a signed-contracts assertion is checked against the register.
      if (signedContractsAssertion(item.quote)) claim.metric = 'contracts';
      claims.push(claim);
    }
    }
    log({ ...note, dropped_claims: dropped, kept_claims: claims.length });
    return { claims, mocked: false };
  };
}

// Where a change statement starts after the amount: "..., up 8% year-on-year". Null when the quote has none.
export function changeStart(quote: string, amountEnd: number): number | null {
  const found = /(?:,\s*|\s+)(?:and\s+)?(?:(?:was|were|is|are)\s+)?(?:up|down|higher|lower|increased|decreased|rose|fell|grew)\b/i.exec(quote.slice(amountEnd));
  return found ? amountEnd + found.index : null;
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
    // Any heading that names a currency ("($ in millions)", "(€ in millions)") sets it for the lines below.
    else if (!/\b(revenue|cash|debt)\b/i.test(line) && !/\d{3}/.test(stripPeriods(line)) && currencyOf(line) !== 'unknown') usd = currencyOf(line) === 'USD';
    const columns = record(line);
    if (columns && /^(revenue|cash|debt)$/i.test(columns[0]!)) {
      const csvPeriod = columns[2] ? normalizePeriod(columns[2]) ?? 'AMBIGUOUS' : linePeriod ?? period;
      let money = null;
      try { if (usd && columns.length <= 3) money = parseMoney(columns[1]!, scale); } catch { /* Keep unsupported claims for review. */ }
      claims.push({ metric: columns[0]!.toLowerCase() as Metric, source, quote: line, period: csvPeriod, money, offset, scale });
      continue;
    }
    const expression = new RegExp(String.raw`\b(revenue|cash(?:\s+on\s+hand)?|(?:total\s+)?debt)\b"?\s*(?:for\s+the\s+period\s+)?(?:(?:was|is|of|[:,=])\s*)?"?(${AMOUNT_PATTERN})(?![\d,]|\.\d|\s*(?:EUR|GBP|CAD|JPY|AUD|CHF|CNY|INR|euros?|pounds?|yen|yuan|francs?)\b)`, 'gi');
    for (const match of line.matchAll(expression)) {
      // Avoid treating a currency-free year or a malformed amount prefix as money.
      const after = line.slice(match.index! + match[0].length);
      if (/^\w/.test(after) || /^(?:\s*[-/]?\s*Q[1-4])\b/i.test(after)) continue;
      const metric = /revenue/i.test(match[1]!) ? 'revenue' : /cash/i.test(match[1]!) ? 'cash' : 'debt';
      try {
        claims.push({ metric, source, quote: match[0], period: linePeriod ?? period, offset: offset + match.index!, scale,
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
