// Reads figures out of real filings (press-release tables, prose) and the metric/period context of a claim.
// Everything here is deterministic code on integer cents; no model is involved.
import { AMOUNT_PATTERN, containsMoney, currencyOf, OTHER_CURRENCY, parseMoney, roundTo, unitFromText, unparsedScaleAfter, type Currency } from './money.js';
export { currencyOf, type Currency } from './money.js';
import { extractClaims, isMetric, periodsInOrder, stripPeriods, quarterInYearOf } from './extract.js';
import { completeAssertion } from './quality.js';
import type { Claim, Money, SourceText } from './types.js';

// A percentage in 1e-4 percent units (15.7% is 157000) with the precision it was written at.
export interface Percent { value: bigint; quantum: bigint }
export interface Figure {
  key: string; money: Money | null; percent: Percent | null; period: string | null; quote: string; source: SourceText;
  currency: Currency;
  // The heading of the section (segment table) the figure is in; `firmwide` is true outside any segment section.
  section: string | null; firmwide: boolean;
  // The row sits under a scale heading but its unit (per employee, share count...) cannot be told: fail closed.
  unitUnclear: boolean;
  // "Net revenue - managed" vs "- reported": the same metric on two bases.
  basis: 'managed' | 'reported' | null;
}
export const basisOf = (text: string): 'managed' | 'reported' | null => /\bmanaged\b/i.test(text) ? 'managed' : /\breported\b/i.test(text) ? 'reported' : null;
// A number followed by a scale word ("100 million", "2.5bn").
export function hasScaledAmount(text: string): boolean { return /\d\s*(?:trillions?|billions?|millions?|thousands?|bn|mm|tn|[KMB])\b/i.test(text); }

export function parsePercent(text: string, negative = false): Percent {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!match) throw new Error('Invalid percentage.');
  const fraction = match[3] ?? '';
  const value = BigInt(match[2]! + fraction.padEnd(4, '0'));
  return { value: negative !== (match[1] === '-') ? -value : value, quantum: 10n ** BigInt(4 - fraction.length) };
}
export function comparePercent(claim: Percent, proof: Percent): boolean { return roundTo(proof.value, claim.quantum) === claim.value; }

// ---- Metric names -------------------------------------------------------------------------------------------
const STOPWORDS = new Set(['the', 'a', 'an', 'total', 'reported', 'firmwide', 'managed', 'quarterly', 'record', 'our', 'its', 'approximately']);
// "managed" and "reported" are dropped from names, so "Net revenue - managed" and "Net revenue - reported" are both
// "revenue"; when they disagree, only a claim that equals one of them is settled (see check.ts).
const SYNONYMS: Record<string, string> = {
  'net revenue': 'revenue', 'net earning': 'net income', nii: 'net interest income', 'cash on hand': 'cash',
  eps: 'earning per share diluted', 'diluted eps': 'earning per share diluted', 'earning per diluted share': 'earning per share diluted',
  'diluted earning per share': 'earning per share diluted',
  'earning per share - diluted': 'earning per share diluted',
  rotce: 'return on tangible common equity', roe: 'return on common equity',
};
export function metricKey(label: string): string {
  const words = (label.toLowerCase().match(/[a-z0-9][a-z0-9&'-]*/g) ?? []).filter(word => !STOPWORDS.has(word))
    // A footnote digit glued to a word ("revenue2", "ROTCE2"); CET1 and similar short names keep theirs.
    .map(word => /^[a-z]{5,}\d$/.test(word) ? word.slice(0, -1) : word)
    .map(word => word.length <= 3 ? word : word.endsWith('sses') ? word.slice(0, -2) : word.endsWith('ies') ? `${word.slice(0, -3)}y`
      : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  const key = words.join(' ');
  return SYNONYMS[key] ?? key;
}
// Words that end a metric name when walking backwards from an amount: "we delivered net income of $14.4 billion".
const BREAK = new Set(['we', 'our', 'i', 'they', 'it', 'was', 'were', 'is', 'are', 'be', 'been', 'has', 'have', 'had', 'with', 'and', 'in', 'for',
  'on', 'at', 'by', 'to', 'of', 'earned', 'reported', 'delivered', 'posted', 'generated', 'recorded', 'achieved', 'produced', 'saw', 'came',
  'totaled', 'totalled', 'reached', 'hit', 'brought', 'stands', 'standing', 'that', 'which', 'this', 'as', 'from', 'about', 'around', 'roughly',
  'approximately', 'nearly', 'almost', 'over', 'under', 'just', 'compared', 'versus', 'vs', 'than', 'a', 'an', 'the', 'quarter', 'year', 'also',
  'now', 'at', 'stood', 'ended', 'closed', 'ending', 'rose', 'fell', 'increased', 'decreased', 'grew', 'up', 'down', 'to', 'record', 'strong']);
export function labelBefore(text: string): string | null {
  const pieces = text.split(/[.,;:()|—]/);
  const tokens = (pieces[pieces.length - 1] ?? '').match(/[A-Za-z0-9][A-Za-z0-9&'/-]*/g) ?? [];
  let end = tokens.length;
  // "US" and "USD" right before the amount belong to the currency ("US$100 million"), not to the metric name.
  while (end > 0 && (BREAK.has(tokens[end - 1]!.toLowerCase()) || /^(?:us|usd)$/i.test(tokens[end - 1]!))) end--;
  let start = end;
  while (start > 0 && end - start < 6 && !BREAK.has(tokens[start - 1]!.toLowerCase())) start--;
  return start === end ? null : tokens.slice(start, end).join(' ');
}
// Up, down, increase, growth: a claim about a change is not a claim about the level, so no level in the proof settles it.
const CHANGE = /\b(?:up|down|rose|fell|grew|growth|increase[sd]?|decrease[sd]?|higher|lower|gain(?:ed|s)?|declin\w*|jump\w*|climb\w*|change[sd]?|expand\w*|contract(?:ed|ion)|year[-\s]on[-\s]year|year[-\s]over[-\s]year|yoy|qoq|quarter[-\s]on[-\s]quarter|quarter[-\s]over[-\s]quarter|sequential(?:ly)?|versus\s+(?:the\s+)?prior|vs\.?\s+(?:the\s+)?prior)\b/i;
export interface AmountContext { key: string | null; change: boolean }
export function amountContext(quote: string, amountIndex: number): AmountContext {
  const before = periodsSplit(quote.slice(0, amountIndex));
  const label = labelBefore(before);
  // A change word before the amount ("up 8%") or right after it ("... was up 8% year-on-year") makes this a change claim.
  const rest = quote.slice(amountIndex).replace(new RegExp(`^(?:${AMOUNT_PATTERN}|[+-]?\\d+(?:\\.\\d+)?\\s*(?:%|percent\\b))`, 'i'), '');
  return { key: label ? metricKey(label) || null : null, change: CHANGE.test(before.slice(-60)) || CHANGE.test(rest.slice(0, 50)) };
}
// Replace period spellings with a hard boundary so they never become part of a metric name.
function periodsSplit(text: string): string { return stripPeriods(text, ' | '); }

// ---- Forward-looking and hedged statements -------------------------------------------------------------------------
const FORWARD = /\b(?:expect(?:s|ed|ing|ation|ations)?|guid(?:ance|ing)|outlook|forecast(?:s|ed|ing)?|anticipat\w+|project(?:s|ed|ing|ion|ions)|probably|possibly|perhaps|maybe|something\s+like|likely|unlikely|should\s+(?:be|come|end|reach|see|get)|will|going\s+to|plans?\s+to|planned|on\s+track|aims?\s+to|aiming|hope[sd]?|hoping|estimate[sd]?|could|might|looking\s+(?:ahead|forward)|next\s+(?:quarter|year)|targets?(?!\s+\d)|targeted|full[-\s]year\s+(?:outlook|guidance))\b/i;
export function forwardLooking(quote: string): boolean { return FORWARD.test(quote); }

// ---- Percent claims -------------------------------------------------------------------------------------------------
export type PercentClaim = { ambiguous: true } | { ambiguous: false; percent: Percent; context: AmountContext };
const PERCENT = /([+-]?\d+(?:\.\d+)?)\s*(?:%|percent\b|per\s*cent\b)/gi;
export function percentClaim(quote: string): PercentClaim | null {
  if (containsMoney(quote)) return null;
  const found = [...quote.matchAll(PERCENT)];
  if (!found.length) return null;
  if (found.length > 1) return { ambiguous: true };
  try { return { ambiguous: false, percent: parsePercent(found[0]![1]!), context: amountContext(quote, found[0]!.index!) }; }
  catch { return { ambiguous: true }; }
}

// ---- Figures in proof documents ----------------------------------------------------------------------------------------
const VALUE = /^\(?[-−]?\$?\d[\d,]*(?:\.\d+)?\)?%?$/;
const PLACEHOLDER = /^(?:NM|N\/M|N\/A|n\/a|—|–|-)$/i;
const RATIO_LABEL = /\b(?:ratio|margin|ROE|ROTCE|ROA|rate|return)\b/i;
interface Row { label: string; values: (string | null)[] }
function tableRow(raw: string): Row | null {
  // PDF text puts a "$" in its own cell ("$ \t5.57"), writes negatives as "$ (7,175)" and percents as "(13)%" or "4 %".
  const line = raw.replace(/\t/g, ' ').replace(/\$\s*\(/g, '($').replace(/\$\s+/g, '$').replace(/([\d)])\s+%/g, '$1%')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ');
  let label: string; let tokens: string[];
  if (line.includes('|')) {
    const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
    label = cells[0] ?? ''; tokens = cells.slice(1);
  } else if (/^[^,]+(?:,[^,\s]+){1,2}$/.test(line) && !/\s\d[\d.]*$/.test(line.slice(0, line.indexOf(',')))) {
    const cells = line.split(',').map(cell => cell.trim());
    label = cells[0]!; tokens = cells.slice(1);
  } else {
    const words = line.trim().split(/\s+/);
    let end = words.length;
    while (end > 1 && (VALUE.test(words[end - 1]!) || PLACEHOLDER.test(words[end - 1]!))) end--;
    label = words.slice(0, end).join(' '); tokens = words.slice(end);
  }
  if (!tokens.length || !tokens.every(token => VALUE.test(token) || PLACEHOLDER.test(token))) return null;
  if (!tokens.some(token => VALUE.test(token)) || !/[A-Za-z]/.test(label) || label.length > 80 || tokens.length > 8) return null;
  if (tokens.length === 1 && /^(?:19|20)\d{2}$/.test(tokens[0]!)) return null;
  return { label, values: tokens.map(token => VALUE.test(token) ? token : null) };
}
// Per share, per common share, per diluted share, per basic share, EPS: already in dollars, never scaled by the heading.
const PER_SHARE = /\bper\s+(?:[a-z]+\s+){0,2}shares?\b|\bEPS\b/i;
// A unit word that is not per-share: "per employee", a share count. Under a scale heading it is anyone's guess.
const OTHER_UNIT = /\bper\b|\bshares?\b/i;
function valueFigure(token: string, label: string, scale: bigint): (Pick<Figure, 'money' | 'percent'> & { unclear: boolean }) | null {
  const negative = token.startsWith('(') || /^\(?[-−]/.test(token);
  const digits = token.replace(/[()$,%\-−]/g, '');
  try {
    if (token.includes('%') || RATIO_LABEL.test(label)) return { money: null, percent: parsePercent(digits, negative), unclear: false };
    const perShare = PER_SHARE.test(label);
    return { money: parseMoney(`${negative ? '-' : ''}${digits}`, perShare ? 1n : scale), percent: null,
      unclear: !perShare && scale !== 1n && OTHER_UNIT.test(label) };
  } catch { return null; }
}
// Segment scope and currency scope are separate: currency belongs to a table
// (heading plus rows), or a prose sentence, never every paragraph in a segment.
interface Section { name: string | null; firmwide: boolean; usd: boolean; other: boolean; from: number }
interface Draft extends Figure { sec: Section; explicit: Currency }
interface DocLine { text: string; start: number }
const SECTION_HEADING = /^[A-Z][A-Z &,.'/-]{5,}(?:\s*\([A-Z0-9]{2,8}\))?$/;
const isHeading = (line: string): boolean => SECTION_HEADING.test(line) && (line.match(/[A-Z]/g) ?? []).length >= 6;
function markers(line: string): { usd: boolean; other: boolean } {
  const other = OTHER_CURRENCY.test(line);
  return { other, usd: currencyOf(line.replace(/\b(?:C|A|HK|NZ|S)\$/gi, '')) === 'USD' };
}
// The sections of a document, shared by every evidence path so that none can see a section differently from another.
function sectionIndex(source: SourceText): { lines: DocLine[]; at(offset: number): Section } {
  const lines: DocLine[] = [...source.text.matchAll(/[^\r\n]+/g)].map(match => {
    const text = match[0].trim();
    return { text, start: match.index! + match[0].indexOf(text) };
  }).filter(line => line.text);
  // Words of the document's opening lines: a section named after the company itself is firmwide, not a segment.
  const firstHeading = lines.findIndex(line => isHeading(line.text));
  const titleWords = new Set(lines.slice(0, Math.min(12, firstHeading < 0 ? 12 : firstHeading))
    .flatMap(line => line.text.toLowerCase().match(/[a-z]{5,}/g) ?? []));
  const sections: Section[] = [{ name: null, firmwide: true, usd: false, other: false, from: 0 }];
  const currencyBlocks = new Map<number, Section>();
  let heading = { usd: false, other: false };
  let table: Section | null = null;
  let lastHeader = false;
  let previousEnd = 0;
  for (const line of lines) {
    const blank = /\r?\n\s*\r?\n/.test(source.text.slice(previousEnd, line.start));
    previousEnd = line.start + line.text.length;
    if (blank) { table = null; lastHeader = false; }
    if (isHeading(line.text)) {
      const words = line.text.toLowerCase().match(/[a-z]{5,}/g) ?? [];
      // A heading on the document's first line is its title, not a segment.
      sections.push({ name: line.text, firmwide: line === lines[0] || words.some(word => titleWords.has(word)) || /\b(?:firmwide|consolidated|group)\b/i.test(line.text),
        usd: false, other: false, from: line.start });
      heading = { usd: false, other: false }; table = null; lastHeader = false;
      continue;
    }
    const current = sections[sections.length - 1]!;
    const seen = markers(line.text);
    const currencyHeader = !/\d/.test(stripPeriods(line.text)) && (seen.usd || seen.other)
      && (unitFromText(line.text) !== null || /^\s*(?:currency\s*:\s*)?(?:USD|EUR|GBP|CAD|JPY|AUD|CHF|CNY|US\$|\$|\u20ac|\u00a3)\s*$/i.test(line.text));
    if (currencyHeader) {
      heading = lastHeader ? { usd: heading.usd || seen.usd, other: heading.other || seen.other } : seen;
      table = { ...current, ...heading }; lastHeader = true;
      currencyBlocks.set(line.start, table);
    } else if (tableRow(line.text) || (table && (/^of\s+which\b/i.test(line.text)
      || (OTHER_CURRENCY.test(line.text) && /\d/.test(line.text) && !completeAssertion(line.text))))) {
      table ??= { ...current, ...heading };
      table.usd ||= seen.usd; table.other ||= seen.other;
      currencyBlocks.set(line.start, table); lastHeader = false;
    } else {
      table = null;
      currencyBlocks.set(line.start, { ...current, ...heading });
      // Period headers may sit between a currency heading and its table.
      if (!periodsInOrder(line.text).length) lastHeader = false;
    }
  }
  return { lines, at: offset => {
    const line = [...lines].reverse().find(line => line.start <= offset);
    return (line && currencyBlocks.get(line.start)) ?? [...sections].reverse().find(section => section.from <= offset) ?? sections[0]!;
  } };
}
// A foreign/mixed heading or table stays ambiguous even if one cell has a dollar sign.
const sectionCurrency = (explicit: Currency, sec: Section): Currency =>
  explicit === 'other' || sec.other ? 'other' : explicit === 'USD' || sec.usd ? 'USD' : 'unknown';
export function filingFigures(source: SourceText): Figure[] {
  const drafts: Draft[] = [];
  const index = sectionIndex(source);
  let scale = 1n; let period: string | null = null; let columns: (string | null)[] | null = null;
  for (const { text: line, start } of index.lines) {
    if (isHeading(line)) continue;
    const section = index.at(start);
    const lineScale = unitFromText(line);
    if (lineScale) scale = lineScale;
    const periods = periodsInOrder(line);
    const relativePeriod = quarterInYearOf(line, period);
    const row = tableRow(line);
    if (row) {
      const key = metricKey(row.label);
      if (!key) continue;
      row.values.forEach((token, position) => {
        if (token === null) return;
        const column = columns && row.values.length >= columns.length ? columns[position] ?? null
          : row.values.length === 1 ? period : null;
        if (!column) return;
        const value = valueFigure(token, row.label, scale);
        if (!value) return;
        drafts.push({ key, money: value.money, percent: value.percent, unitUnclear: value.unclear, basis: basisOf(row.label), currency: 'unknown', explicit: currencyOf(`${row.label} ${token}`),
          period: column, quote: line, source, section: section.name, firmwide: section.firmwide, sec: section });
      });
      continue;
    }
    if (!/\d/.test(stripPeriods(line))) {
      // A heading line: several periods head table columns, one period dates the section that follows.
      if (periods.length > 1) columns = periods;
      else if (periods.length === 1) { period = periods[0] ?? null; columns = null; }
      else if (relativePeriod) { period = relativePeriod; columns = null; }
      continue;
    }
    proseFigures(line, period, section, source, drafts);
  }
  return drafts.map(({ sec, explicit, ...figure }) => ({ ...figure, currency: sectionCurrency(explicit, sec) }));
}
// The older inline matcher ("Revenue USD 100", "revenue,100" rows) as figures, placed in its section like every other
// figure, so that it is validated by exactly the same rules (basis, section, currency, scale) as a table row.
export function legacyFigures(source: SourceText, found: Claim[] = extractClaims(source)): Figure[] {
  const index = sectionIndex(source);
  const out: Figure[] = [];
  for (const claim of found) {
    if (!isMetric(claim.metric) || !claim.money || claim.offset === undefined) continue;
    const section = index.at(claim.offset);
    const lineStart = claim.source.text.lastIndexOf('\n', claim.offset - 1) + 1;
    const lineEnd = claim.source.text.indexOf('\n', claim.offset);
    const line = claim.source.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const explicit = currencyOf(sentenceAt(line, claim.offset - lineStart));
    const resolved = sectionCurrency(explicit, section);
    // Plain records (the starter CSV, "Revenue USD 100") keep their long-standing meaning: an unscaled amount with no
    // marker anywhere is USD. A scaled amount with no marker ("Revenue was 100 million") could be any currency.
    const currency: Currency = resolved === 'unknown' && !hasScaledAmount(claim.quote) ? 'USD' : resolved;
    const before = claim.source.text.slice(lineStart, claim.offset);
    out.push({ key: claim.metric, money: claim.money, percent: null, period: claim.period, quote: claim.quote, source,
      currency, section: section.name, firmwide: section.firmwide,
      unitUnclear: claim.scale !== undefined && claim.scale !== 1n && OTHER_UNIT.test(before) && !PER_SHARE.test(before),
      // A basis word right before the match ("Reported revenue of $50.2 billion") or inside it labels the inline figure.
      basis: basisOf(claim.source.text.slice(Math.max(lineStart, claim.offset - 14), claim.offset + claim.quote.length)) });
  }
  return out;
}
// Both evidence paths, merged. A figure the two paths both found is kept once, in its legacy form.
export function proofFigures(source: SourceText, paths: { legacy?: boolean; filing?: boolean } = {}): Figure[] {
  const legacy = paths.legacy === false ? [] : legacyFigures(source);
  const same = (a: Figure, b: Figure) => a.quote === b.quote && a.key === b.key && a.period === b.period
    && a.money?.cents === b.money?.cents && a.source === b.source;
  const filing = paths.filing === false ? [] : filingFigures(source).filter(figure => !legacy.some(old => same(old, figure)));
  return [...legacy, ...filing];
}
// A claim's metric name without the segment it names: "RTL net income" is "net income" in the RTL section.
export function withoutSections(key: string, all: Figure[]): string {
  let result = ` ${key} `;
  for (const name of new Set(all.filter(f => f.section && !f.firmwide).map(f => f.section!))) {
    const abbreviation = /\(([A-Z0-9]{2,8})\)\s*$/.exec(name)?.[1]?.toLowerCase();
    const plain = name.replace(/\s*\([A-Z0-9]{2,8}\)\s*$/, '').trim().toLowerCase();
    for (const term of [abbreviation, plain]) if (term) result = result.split(` ${term} `).join(' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}
// Segment sections a claim names (by abbreviation or full name); otherwise only firmwide figures apply.
export function scopeFigures(all: Figure[], quote: string): Figure[] {
  const named = [...new Set(all.filter(f => f.section && !f.firmwide).map(f => f.section!))].filter(name => {
    const abbreviation = /\(([A-Z0-9]{2,8})\)\s*$/.exec(name)?.[1];
    const plain = name.replace(/\s*\([A-Z0-9]{2,8}\)\s*$/, '').trim().toLowerCase();
    return (abbreviation !== undefined && new RegExp(`\\b${abbreviation}\\b`).test(quote)) || (plain.length >= 6 && quote.toLowerCase().includes(plain));
  });
  return named.length ? all.filter(f => f.section !== null && named.includes(f.section)) : all.filter(f => f.firmwide);
}
function proseFigures(line: string, sectionPeriod: string | null, sec: Section, source: SourceText, out: Draft[]): void {
  interface Hit { index: number; end: number; money: Money | null; percent: Percent | null }
  const hits: Hit[] = [];
  for (const match of line.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))) {
    if (!containsMoney(match[0]) || unparsedScaleAfter(line.slice(match.index! + match[0].length))) continue;
    try { hits.push({ index: match.index!, end: match.index! + match[0].length, money: parseMoney(match[0]), percent: null }); } catch { /* skip */ }
  }
  for (const match of line.matchAll(PERCENT)) {
    try { hits.push({ index: match.index!, end: match.index! + match[0].length, money: null, percent: parsePercent(match[1]!) }); } catch { /* skip */ }
  }
  hits.sort((left, right) => left.index - right.index);
  const linePeriods = [...new Set(periodsInOrder(line))];
  let previousEnd = 0; let previousKey: string | null = null;
  hits.forEach((hit, position) => {
    const between = line.slice(previousEnd, hit.index);
    const label = labelBefore(periodsSplit(between));
    let key = label ? metricKey(label) || null : null;
    // "net income of $14.4 billion compared with $13.4 billion in 3Q25": the second amount reuses the first name.
    if (!key && previousKey && /\b(?:compared|versus|vs|from|and)\b/i.test(between)) key = previousKey;
    previousEnd = hit.end; previousKey = key ?? previousKey;
    if (!key || CHANGE.test(line.slice(Math.max(0, hit.index - 60), hit.index))) return;
    // The amount's own marker (a few characters either side) beats the heading; both USD and foreign is ambiguous.
    const named = /^\s*(?:U\.?S\.?\s+dollars?|USD|euros?|EUR|pounds?|GBP|yen|JPY|yuan|CNY|francs?|CHF|CAD|AUD|INR)\b/i.exec(line.slice(hit.end))?.[0] ?? '';
    const near = currencyOf(`${line.slice(Math.max(0, hit.index - 4), hit.end)} ${named}`);
    const explicit: Currency = hit.money ? (currencyOf(sentenceAt(line, hit.index)) === 'other' ? 'other' : near) : 'unknown';
    const after = line.slice(hit.end, hits[position + 1]?.index ?? line.length);
    const own = [...new Set(periodsInOrder(after))];
    const before = periodsInOrder(line.slice(0, hit.index));
    const period = own.length === 1 ? own[0]! : linePeriods.length === 1 ? linePeriods[0]! : linePeriods.length === 0 ? quarterInYearOf(line, sectionPeriod) ?? sectionPeriod
      : before[before.length - 1] ?? null;
    if (!period || period === 'AMBIGUOUS') return;
    out.push({ key, money: hit.money, percent: hit.percent, period, quote: line, source, currency: 'unknown', explicit, unitUnclear: false, basis: basisOf(between.slice(-24)),
      section: sec.name, firmwide: sec.firmwide, sec });
  });
}
function sentenceAt(line: string, offset: number): string {
  let start = 0;
  for (const boundary of line.matchAll(/[.!?](?:\s+|$)/g)) {
    const end = boundary.index! + boundary[0].length;
    if (end > offset) return line.slice(start, end);
    start = end;
  }
  return line.slice(start);
}
