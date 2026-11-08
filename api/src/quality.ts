// Conservative English assertion gate. A date, a job title or a topic is not a fact
// merely because it contains a number or a noun. Numeric metric/status assertions
// may omit a copula ("Revenue of $12 billion"); text assertions need a predicate.
import { containsMoney } from './money.js';
const VERB = /\b(?:am|is|are|was|were|has|have|had|will|can|could|should|would|must|does|do|did|remains?|remain|became|becomes?|opened|closed|serves?|supports?|expects?|reported|delivered|posted|generated|recorded|achieved|produced|reached|brought|stands?|stood|rose|fell|grew|increased|decreased|earned|maintains?|operates?|owns?|sells?|sold|provides?|continues?|launched|completed|signed|exceeds?|totaled|totalled)\b/i;
const TITLE = /^(?:(?:annual|quarterly)\s+report\b|(?:report\s+on\s+)?form\s+10[- ]?[kq]\b|(?:table\s+of\s+contents|prepared\s+remarks|questions?\s+and\s+answers?)\s*$)/i;
function subject(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
  return words.some(word => !['the', 'a', 'an', 'of', 'in', 'for', 'on', 'at', 'to', 'and', 'or', 'not', 'all', 'as', 'by'].includes(word))
    && !/^(?:of|on|about|regarding|including|compared\s+with|up|down)\b/i.test(text.trim());
}
export function completeAssertion(quote: string): boolean {
  const text = quote.trim();
  if (!text || TITLE.test(text) || /\?$/.test(text)) return false;
  const verb = VERB.exec(text);
  if (!verb || !subject(text.slice(0, verb.index)) || /\b(?:of|on|about|for|to|including)\s*$/i.test(text.slice(0, verb.index))) return false;
  if (/^(?:am|is|are|was|were|has|have|had|will|can|could|should|would|must|does|do|did)$/i.test(verb[0])) {
    const predicate = text.slice(verb.index + verb[0].length).match(/[a-z0-9]+/gi) ?? [];
    if (!predicate.some(word => !['the', 'a', 'an', 'in', 'on', 'to', 'of', 'for', 'not', 'be', 'been'].includes(word.toLowerCase()))) return false;
  }
  return true;
}
export function checkableClaim(quote: string): boolean {
  if (TITLE.test(quote.trim()) || /\?$/.test(quote.trim())) return false;
  if (completeAssertion(quote)) return true;
  // A numeric assertion requires a named metric/count before a non-date value.
  const numeric = /\b(?:revenue|cash|debt|income|profit|earnings?|EPS|ROTCE|ROE|ratio|margin|sales|bookings|ARR|MRR|expenses?|costs?|funding|capital|assets?|value|customers?|employees?|offices?|branches|contracts?)\b[^.!?\n]{0,60}?(?:\$|USD\s*|EUR\s*|GBP\s*|\u20ac|\u00a3)?[+-]?\d[\d,]*(?:\.\d+)?/i.exec(quote);
  if (numeric && (containsMoney(numeric[0]) || !/\b(?:19|20)\d{2}\b/.test(numeric[0]))
    && subject(numeric[0].replace(/[\d$.,+-]/g, ''))) return true;
  return /\b(?:contracts?|CT-\d+|offices?|branches)\b\s+(?:are\s+)?(?:signed|unsigned|open|closed|active|inactive)\b/i.test(quote);
}

// Jev may support only a concrete, externally checkable text assertion.
export function concreteAssertion(quote: string): boolean {
  if (!completeAssertion(quote)) return false;
  if (/\b\d{1,4}(?:[-\/]\d{1,2}){0,2}\b/.test(quote)) return true;
  // Proper names or stable identifiers after the opening subject can name an item or event.
  return /\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+\b|\b[A-Z]{2,}[-\d][A-Z\d-]*\b/.test(quote);
}
