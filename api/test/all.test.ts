import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp, MAX_REQUEST_BYTES } from '../src/app.js';
import { checkClaims, probabilityDecision, verifyQuotes } from '../src/check.js';
import { ENV_FILE, loadConfig, parseConfig } from '../src/config.js';
import { contractRows, extractClaims, normalizePeriod } from '../src/extract.js';
import { createJev, type Jev, type Transport } from '../src/jev.js';
import { compareMoney, containsMoney, decimal, parseMoney } from '../src/money.js';
import { createTranscriber } from '../src/transcribe.js';
import { filingFigures } from '../src/filing.js';
import { createClaude } from '../src/claude.js';
import { bareMoneyAmount, createClaimExtractor, signedContractsAssertion } from '../src/extract.js';
import type { CheckResponse, Segment, SourceText } from '../src/types.js';

// Block real external calls even on a developer machine with installed keys.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.hostname, '127.0.0.1', 'Tests must never call paid APIs.');
  return nativeFetch(input, init);
}) as Transport;
const source = (text: string, name = 'source.txt'): SourceText => ({ text, name, mocked: false });
const neverJev: Jev = { async ask() { assert.fail('Numeric claims or missing evidence must not call Jev.'); } };
const check = (claim: string, proof: string, jev = neverJev) => checkClaims([source(claim, 'claims.txt')], [source(proof, 'proof.txt')], jev);
const fixture = JSON.parse(await readFile(new URL('../../../docs/mock-response.json', import.meta.url), 'utf8')) as CheckResponse;
// Verbatim excerpt from the starter kit's sample contract-register.txt.
const starterRegisterLine = 'Target 01 contract register. CT-100 signed; CT-101 signed; CT-102 unsigned as of September 30, 2026.';

function claudeStub(outputs: unknown[]) {
  const requests: { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] }[] = [];
  const transport: Transport = async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(new Headers(init?.headers).get('anthropic-version'), '2026-10-21');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    requests.push(JSON.parse(String(init?.body)));
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.thinking, { type: 'between_tools' });
    assert.deepEqual(request.output_config, { effort: 'low' });
    const output = outputs.shift();
    assert.notEqual(output, undefined, 'Unexpected Claude request');
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] });
  };
  return { claude: createClaude('test-only-placeholder', transport), requests };
}

test('Claude: unfamiliar prose extracts grounded money; code computes gaps; explanation sees only quotes', async () => {
  const quote = 'In FY2025, we brought revenue to USD 1250000.00 through new channels.';
  const { claude, requests } = claudeStub([
    { claims: [{ type: 'money', quote, amount: '1250000.00', unit: 'USD', period: 'FY2025' }] },
    { explanation: 'The claim and the finance report state different revenue amounts.' },
  ]);
  const result = await checkClaims([source(quote)], [source('FY2025\nrevenue,1175000.00', 'proof.csv')], neverJev, { claude });
  assertResponse(result);
  const finding = result.findings[0]!;
  assert.equal(finding.gap_usd, '75000.00'); assert.equal(finding.gap_pct, '6.00');
  assert.equal(finding.decision, 'NO'); assert.equal(finding.mocked, false);
  assert.equal(finding.claim_source.quote, quote);
  assert.equal(finding.explanation, 'The claim and the finance report state different revenue amounts.');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.model === 'claude-sonnet-5-5'));
  assert.deepEqual(requests.map(request => request.max_tokens), [4096, 256]);
  assert.deepEqual(JSON.parse(requests[1]!.messages[0]!.content), { claim_quote: quote, proof_quote: 'revenue,1175000.00' });
});

test('Claude: hallucinated quotes are dropped, counted without document text, and never replaced by regex', async () => {
  const quote = 'Our product serves independent pharmacies.';
  const { claude, requests } = claudeStub([{ claims: [
    { type: 'text', quote }, { type: 'money', quote: 'Revenue USD 999.00', amount: '999.00', unit: 'USD', period: '' },
    { type: 'text', quote: quote.toUpperCase() },
  ] }]);
  const notes: unknown[] = [];
  const result = await createClaimExtractor(claude, note => notes.push(note))(source(quote));
  assert.equal(result.mocked, false); assert.deepEqual(result.claims.map(claim => claim.quote), [quote]);
  assert.deepEqual(notes, [{ dropped_claims: 2 }]); assert.equal(requests.length, 1);
  const dropped = claudeStub([{ claims: [{ type: 'text', quote: 'invented' }] }]);
  assert.deepEqual((await createClaimExtractor(dropped.claude, () => {})(source('Revenue USD 100.00'))).claims, []);
});

test('Claude: malformed JSON and invalid schemas retry once then fall back to regex', async () => {
  for (const invalid of ['not JSON', { claims: [{ type: 'money', quote: 'Revenue USD 100.00', amount: 100, unit: 'USD', period: '' }] },
    { claims: [{ type: 'text', quote: 'Revenue USD 100.00', citation: 'invented' }] }]) {
    const { claude, requests } = claudeStub([invalid, invalid]);
    const input = source('Revenue USD 100.00');
    const result = await createClaimExtractor(claude)(input);
    assert.equal(result.mocked, true); assert.deepEqual(result.claims, extractClaims(input));
    assert.equal(requests.length, 2);
  }
  const { claude } = claudeStub(['bad', 'bad', { explanation: 'The two passages report the same revenue.' }]);
  const result = await checkClaims([source('Revenue USD 100.00')], [source('revenue,100.00', 'proof.csv')], neverJev, { claude });
  assert.equal(result.findings[0]!.mocked, true);
  assert.equal(result.findings[0]!.decision, 'YES');
});

test('Claude: starter results remain identical with real-path extraction and mocked transport', async () => {
  const input = source(await readFile(new URL('../../starter-claims.txt', import.meta.url), 'utf8'), 'claims.txt');
  const proof = source(await readFile(new URL('../../starter-proof.csv', import.meta.url), 'utf8'), 'proof.csv');
  const baseline = await checkClaims([input], [proof], createJev());
  const claims = extractClaims(input).map(claim => claim.metric === 'contracts'
    ? { type: 'contract', quote: claim.quote }
    : { type: 'money', quote: claim.quote, amount: /\d+\.\d+/.exec(claim.quote)![0], unit: 'USD', period: '' });
  const { claude } = claudeStub([{ claims }, ...claims.map(() => ({ explanation: 'The supplied passages describe the reported position.' }))]);
  const actual = await checkClaims([input], [proof], createJev(), { claude });
  assertResponse(actual);
  const decisions = (result: CheckResponse) => result.findings.map(({ explanation, mocked, ...finding }) => finding);
  assert.deepEqual(decisions(actual), decisions(baseline));
  assert.equal(actual.findings.find(finding => finding.id === 'f-contracts')!.mocked, true);
  assert.equal(actual.findings.find(finding => finding.id === 'f-revenue')!.mocked, false);
});

test('Claude: generic text uses code-selected proof and Jev; missing evidence never calls Jev', async () => {
  const quote = 'The Boston office opened in May.';
  const proof = 'The Boston office remains closed pending permits.';
  const { claude } = claudeStub([{ claims: [{ type: 'text', quote }] }, { explanation: 'The claim says the office opened, but the proof says it remains closed.' }]);
  const result = await checkClaims([source(quote)], [source(proof, 'proof.txt')], { async ask(state, question) {
    assert.equal(state, proof); assert.ok(question.includes(quote)); return { probability: 0.1, mocked: false };
  } }, { claude });
  assert.equal(result.findings[0]!.decision, 'NO'); assert.equal(result.findings[0]!.mocked, false);
  assert.equal(result.findings[0]!.proof_source!.quote, proof);
  const missing = claudeStub([{ claims: [{ type: 'text', quote }] }, { explanation: 'Matching evidence is unavailable.' }]);
  const review = await checkClaims([source(quote)], [source('Unrelated evidence.', 'proof.txt')], neverJev, { claude: missing.claude });
  assert.equal(review.findings[0]!.decision, 'NEEDS_REVIEW');
  assert.equal(review.findings[0]!.proof_source, null);
});

test('Claude: money mislabelled as text or contract goes through the money path and never reaches Jev', async () => {
  const dollars = 'In FY2025, revenue reached $1,250,000 across all channels.';
  const words = 'Bookings closed the year at 1.25 million across all channels.';
  const broken = 'Bookings closed the year at $1.2.3 across all channels.';
  const text = [dollars, words, broken].join('\n');
  const { claude } = claudeStub([{ claims: [{ type: 'text', quote: dollars }, { type: 'contract', quote: words }, { type: 'text', quote: broken }] },
    ...[1, 2, 3].map(() => ({ explanation: 'The amounts were compared in code.' }))]);
  // The proof shares words with every claim, so the generic text path would otherwise ask Jev.
  const proof = 'FY2025\nrevenue,1175000.00\nBookings closed the year across all channels strongly.';
  const result = await checkClaims([source(text)], [source(proof, 'proof.csv')], neverJev, { claude });
  assertResponse(result);
  const byQuote = (quote: string) => result.findings.find(f => f.claim_source.quote === quote)!;
  assert.equal(byQuote(dollars).claimed_usd, '1250000.00'); assert.equal(byQuote(dollars).gap_usd, '75000.00');
  assert.equal(byQuote(dollars).decision, 'NO');
  assert.equal(byQuote(words).claimed_usd, '1250000.00'); assert.equal(byQuote(words).decision, 'NEEDS_REVIEW');
  assert.equal(byQuote(broken).claimed_usd, null); assert.equal(byQuote(broken).decision, 'NEEDS_REVIEW');
  assert.ok(result.findings.every(f => f.jev_probability === null));
});

test('Claude: bare amount labelled text uses the USD heading for a code-computed gap; unknown currency needs review', async () => {
  const quote = 'Annual revenue was 100.00.';
  const run = async (text: string) => {
    const { claude } = claudeStub([{ claims: [{ type: 'text', quote }] }, { explanation: 'Compared in code.' }]);
    return checkClaims([source(text)], [source('FY2025\nrevenue,80.00', 'proof.csv')], neverJev, { claude });
  };
  const known = (await run(`Figures in USD\nFY2025\n${quote}`)).findings[0]!;
  assert.equal(known.claimed_usd, '100.00'); assert.equal(known.proof_usd, '80.00');
  assert.equal(known.gap_usd, '20.00'); assert.equal(known.decision, 'NO'); assert.equal(known.jev_probability, null);
  for (const text of [`FY2025\n${quote}`, `Figures in EUR\nFY2025\n${quote}`]) {
    const unknown = (await run(text)).findings[0]!;
    assert.equal(unknown.decision, 'NEEDS_REVIEW'); assert.equal(unknown.claimed_usd, null); assert.equal(unknown.jev_probability, null);
  }
  // Years, counts and percentages are not money.
  assert.equal(bareMoneyAmount('Revenue grew 20% in 2025.'), null);
  assert.equal(bareMoneyAmount('We have 40 customers.'), null);
});

test('Claude: bare amount with period qualifier is money; unparseable qualifier needs review without Jev', async () => {
  const run = async (quote: string, proof = 'FY2025\nrevenue,90.00') => {
    const { claude } = claudeStub([{ claims: [{ type: 'text', quote }] }, { explanation: 'Compared in code.' }]);
    return (await checkClaims([source(`Figures in USD\nFY2025\n${quote}`)], [source(proof, 'proof.csv')], neverJev, { claude })).findings[0]!;
  };
  const finding = await run('Annual revenue was 100.00 for FY2025.');
  assert.equal(finding.claimed_usd, '100.00'); assert.equal(finding.proof_usd, '90.00');
  assert.equal(finding.gap_usd, '10.00'); assert.equal(finding.decision, 'NO'); assert.equal(finding.jev_probability, null);
  for (const quote of ['Annual revenue was 100.00 in Q3.', 'Annual revenue was 100.00 as of 2026-09-30.', 'Annual revenue was 100.00 in 2025.',
    'Annual revenue was 100.00 for the year ended December 31, 2025.']) {
    const result = await run(quote);
    assert.equal(result.claimed_usd, '100.00', quote); assert.equal(result.jev_probability, null, quote);
  }
  for (const quote of ['Annual revenue was 100.00 apiece.', 'Annual revenue was 100.00 across 12 regions for FY2025.']) {
    const result = await run(quote);
    assert.equal(result.decision, 'NEEDS_REVIEW', quote); assert.equal(result.claimed_usd, null, quote); assert.equal(result.jev_probability, null, quote);
  }
});

test('Claude: signed-contracts sentence labelled text still hits the register check', async () => {
  const quote = 'As of 2026-09-30, our CEO confirmed on the call that all material contracts are signed.';
  const { claude } = claudeStub([{ claims: [{ type: 'text', quote }] }, { explanation: 'The register lists CT-102 as unsigned.' }]);
  const result = await checkClaims([source(quote)], [source(starterRegisterLine, 'contract-register.txt')],
    { async ask() { return { probability: 0.99, mocked: false }; } }, { claude });
  const finding = result.findings[0]!;
  assert.equal(finding.id, 'f-contracts'); assert.equal(finding.decision, 'NO'); assert.equal(finding.jev_probability, 0.99);
  assert.match(finding.proof_source!.quote, /CT-102 unsigned/); assert.equal(finding.claim_source.quote, quote);
});

test('Claude: signed-contracts assertion inside a full dated sentence; negation is not an assertion', async () => {
  const quote = 'As of 2026-09-30, our CEO confirmed on the call that all material contracts are signed.';
  const { claude } = claudeStub([{ claims: [{ type: 'contract', quote }] }, { explanation: 'The register lists CT-102 as unsigned.' }]);
  let asked = 0;
  const result = await checkClaims([source(quote)], [source(starterRegisterLine, 'contract-register.txt')],
    { async ask() { asked++; return { probability: 0.99, mocked: false }; } }, { claude });
  assertResponse(result);
  const finding = result.findings[0]!;
  assert.equal(finding.id, 'f-contracts'); assert.equal(finding.decision, 'NO');
  assert.equal(finding.claim_source.quote, quote); assert.equal(finding.jev_probability, 0.99); assert.equal(asked, 1);
  assert.match(finding.proof_source!.quote, /CT-102 unsigned/);
  for (const negated of ['As of 2026-09-30, not all material contracts are signed.', 'Our material contracts are not signed yet.',
    'No contracts are signed.', 'Some contracts remain unsigned, but other contracts are signed.']) {
    assert.equal(signedContractsAssertion(negated), false, negated);
  }
  assert.equal(signedContractsAssertion('We can confirm all of our material contracts have been signed.'), true);
  const negatedQuote = 'As of 2026-09-30, not all material contracts are signed.';
  const negatedRun = claudeStub([{ claims: [{ type: 'contract', quote: negatedQuote }] }]);
  const negatedClaims = (await createClaimExtractor(negatedRun.claude, () => {})(source(negatedQuote))).claims;
  assert.equal(negatedClaims[0]!.metric, 'contract');
});

test('Claude: metadata cannot invent money; omitted suffixes are parsed from the source', async () => {
  for (const [quote, amount, unit, expected] of [
    ['Revenue reached USD 1.25 million.', '1.25', 'USD', 125000000n],
    ['Revenue reached USD 1.25 million.', '1.25', 'million USD', 125000000n],
    ['Revenue reached USD 1.25 million.', '1', 'USD', null],
    ['Revenue reached USD 1.25 million.', '999.00', 'USD', null],
    ['Revenue reached EUR 100.00.', '100.00', '', null],
  ] as const) {
    const { claude } = claudeStub([{ claims: [{ type: 'money', quote, amount, unit, period: '' }] }]);
    const result = await createClaimExtractor(claude, () => {})(source(quote));
    assert.equal(result.claims[0]!.money?.cents ?? null, expected);
  }
  const mixed = claudeStub([{ claims: [{ type: 'money', quote: 'Revenue USD 100.00', amount: '100.00', unit: 'USD', period: '' }] }]);
  assert.equal((await createClaimExtractor(mixed.claude, () => {})(source('Revenue EUR 90.00\nRevenue USD 100.00'))).claims[0]!.money?.cents, 10000n);
  const foreignHeading = claudeStub([{ claims: [{ type: 'money', quote: 'Revenue 100.00', amount: '100.00', unit: '', period: '' }] }]);
  assert.equal((await createClaimExtractor(foreignHeading.claude, () => {})(source('Currency: EUR\nRevenue 100.00'))).claims[0]!.money, null);
});

test('Claude: explanation failures preserve deterministic findings and mark mocks', async () => {
  const quote = 'Revenue USD 100.00';
  const { claude, requests } = claudeStub([{ claims: [{ type: 'money', quote, amount: '100.00', unit: 'USD', period: '' }] }, 'bad', { explanation: 42 }]);
  const result = await checkClaims([source(quote)], [source('revenue,90.00', 'proof.csv')], neverJev, { claude });
  assert.equal(result.findings[0]!.mocked, true); assert.equal(result.findings[0]!.gap_usd, '10.00');
  assert.equal(result.findings[0]!.explanation, 'The proof amount differs from the claim after normalizing units and periods.');
  assert.equal(requests.length, 3);
});

test('Claude: one invalid response can recover; missing key never calls transport', async () => {
  const quote = 'We opened an office in Boston.';
  const { claude, requests } = claudeStub(['bad', { claims: [{ type: 'text', quote }] }]);
  assert.equal((await createClaimExtractor(claude, () => {})(source(quote))).mocked, false);
  assert.equal(requests.length, 2);
  const noKey = createClaude(undefined, async () => assert.fail('No-key mode must not call Claude'));
  const input = source('Cash USD 480000.00');
  assert.deepEqual(await createClaimExtractor(noKey)(input), { claims: extractClaims(input), mocked: true });
});

test('Claude: truncation, refusal and upstream errors fall back after exactly two attempts', async () => {
  const input = source('Revenue USD 100.00');
  for (const failure of ['truncated', 'refusal', 'http', 'network']) {
    let calls = 0;
    const claude = createClaude('test-only-placeholder', async () => {
      calls++;
      if (failure === 'network') throw new Error('private upstream content');
      if (failure === 'http') return new Response('private upstream content', { status: 429 });
      return Response.json({ stop_reason: failure === 'truncated' ? 'max_tokens' : 'refusal',
        content: [{ type: 'text', text: '{"claims":[]}' }] });
    });
    assert.deepEqual(await createClaimExtractor(claude)(input), { claims: extractClaims(input), mocked: true });
    assert.equal(calls, 2);
  }
});

test('Claude: repeated transcript quotes retain distinct segment provenance', async () => {
  const quote = 'Revenue USD 100.00';
  const segments: Segment[] = [
    { source: 'call.wav', text: quote, start: 0, end: 2, speaker: 'A' },
    { source: 'call.wav', text: quote, start: 5, end: 7, speaker: 'B' },
  ];
  const claim = { type: 'money', quote, amount: '100.00', unit: 'USD', period: '' };
  const { claude } = claudeStub([{ claims: [claim, claim] },
    { explanation: 'The amounts match.' }, { explanation: 'The amounts match.' }]);
  const result = await checkClaims([{ ...source(`${quote}\n${quote}`, 'call.wav'), segments }],
    [source('revenue,100.00', 'proof.csv')], neverJev, { claude });
  assert.deepEqual(result.findings.map(finding => finding.claim_source.timestamp_start), [0, 5]);
  assert.deepEqual(result.findings.map(finding => finding.claim_source.speaker), ['A', 'B']);
});

test('Claude: mixed-source fallback marks the whole check as mocked', async () => {
  const first = source('Revenue USD 100.00', 'first.txt');
  const second = source('Cash USD 50.00', 'second.txt');
  const { claude } = claudeStub([{ explanation: 'The amounts match.' }, { explanation: 'The amounts match.' }]);
  const result = await checkClaims([first, second], [source('revenue,100.00\ncash,50.00', 'proof.csv')], neverJev,
    { claude, extractor: async input => ({ claims: extractClaims(input), mocked: input === second }) });
  assert.ok(result.findings.every(finding => finding.mocked));
});

function assertObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function assertNumber(value: unknown): asserts value is number {
  assert.equal(typeof value, 'number');
  assert.ok(Number.isFinite(value));
}
function assertNullableString(value: unknown): void {
  assert.ok(value === null || typeof value === 'string');
}
function assertResponse(value: unknown): asserts value is CheckResponse {
  assertObject(value, ['company', 'period', 'findings', 'sources', 'transcript']);
  assert.equal(typeof value.company, 'string');
  assert.equal(typeof value.period, 'string');
  assert.ok(Array.isArray(value.sources));
  const sourceNames = new Set<string>();
  for (const entry of value.sources) {
    assertObject(entry, ['name', 'type', 'date', 'url']);
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.type === 'upload' || entry.type === 'sec');
    assertNullableString(entry.date);
    assertNullableString(entry.url);
    sourceNames.add(entry.name as string);
  }
  assert.ok(Array.isArray(value.findings));
  for (const finding of value.findings) {
    assertObject(finding, ['id', 'claim', 'claim_source', 'label', 'decision', 'jev_probability',
      'explanation', 'proof_source', 'claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct',
      'priority', 'next_action', 'mocked']);
    for (const field of ['id', 'claim', 'explanation', 'next_action']) assert.equal(typeof finding[field], 'string', field);
    assert.ok(finding.decision === 'YES' || finding.decision === 'NO' || finding.decision === 'NEEDS_REVIEW');
    assert.equal(finding.label, { YES: 'supported', NO: 'discrepancy', NEEDS_REVIEW: 'insufficient' }[finding.decision]);
    assert.ok(finding.priority === 'high' || finding.priority === 'medium' || finding.priority === 'low');
    assert.equal(typeof finding.mocked, 'boolean');
    if (finding.jev_probability !== null) {
      assertNumber(finding.jev_probability);
      assert.ok(finding.jev_probability >= 0 && finding.jev_probability <= 1);
    }
    for (const field of ['claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct']) {
      const amount: unknown = finding[field];
      if (amount !== null) {
        assert.equal(typeof amount, 'string', field);
        assert.match(amount as string, /^-?\d+\.\d{2}$/, field);
      }
    }
    assertObject(finding.claim_source, ['name', 'quote', 'timestamp_start', 'timestamp_end', 'speaker']);
    assert.equal(typeof finding.claim_source.name, 'string');
    assert.equal(typeof finding.claim_source.quote, 'string');
    assert.ok(sourceNames.has(finding.claim_source.name as string));
    assertNullableString(finding.claim_source.speaker);
    for (const field of ['timestamp_start', 'timestamp_end']) {
      if (finding.claim_source[field] !== null) assertNumber(finding.claim_source[field]);
    }
    if (finding.proof_source !== null) {
      assertObject(finding.proof_source, ['name', 'quote', 'url']);
      assert.equal(typeof finding.proof_source.name, 'string');
      assert.equal(typeof finding.proof_source.quote, 'string');
      assertNullableString(finding.proof_source.url);
      assert.ok(sourceNames.has(finding.proof_source.name as string));
    }
  }
  if (value.transcript !== null) {
    assertObject(value.transcript, ['segments']);
    assert.ok(Array.isArray(value.transcript.segments));
    for (const segment of value.transcript.segments) {
      assertObject(segment, ['source', 'start', 'end', 'speaker', 'text']);
      assert.equal(typeof segment.source, 'string');
      assert.ok(sourceNames.has(segment.source as string), 'Every segment must reference a sources entry.');
      assertNumber(segment.start);
      assertNumber(segment.end);
      assert.ok(segment.start >= 0 && segment.end >= segment.start);
      assertNullableString(segment.speaker);
      assert.equal(typeof segment.text, 'string');
    }
  }
}

test('money: USD, suffixes, inherited units and large values use integer cents', () => {
  for (const text of ['USD 1,250,000', '$1.25M', '1,250 (in thousands)', '1.250 million']) assert.equal(parseMoney(text).cents, 125000000n);
  assert.equal(parseMoney('1250', 1000n).cents, 125000000n);
  assert.equal(parseMoney('USD -1.25M').cents, -125000000n);
  assert.equal(decimal(parseMoney('9007199254740993.01').cents), '9007199254740993.01');
  for (const text of ['1,25', 'EUR 10', '1.001', '1M (in thousands)', 'NaN', '1e9']) assert.throws(() => parseMoney(text));
});
test('money: rounding at claimed precision and exact ties', () => {
  for (const [proof, matches] of [['1245000.00', true], ['1254999.99', true], ['1255000.00', false], ['1244999.99', false]] as const)
    assert.equal(compareMoney(parseMoney('$1.25M'), parseMoney(proof)).matches, matches);
  assert.equal(compareMoney(parseMoney('-1.25M'), parseMoney('-1245000.00')).matches, true);
  assert.equal(compareMoney(parseMoney('100.00'), parseMoney('100.01')).matches, false);
});
test('money: percentage rounding, zero denominator and negative amounts', () => {
  for (const [claim, proof, percent] of [['480000.00', '410000.00', '14.58'], ['200.00', '199.99', '0.01'], ['0.00', '0.00', '0.00'], ['0.00', '1.00', null], ['-100.00', '-90.00', '10.00']] as const)
    assert.equal(compareMoney(parseMoney(claim), parseMoney(proof)).gap_pct, percent);
});
test('starter: revenue, cash, debt and CT-102 reproduce docs/mock-response.json', async () => {
  const transcript = await createTranscriber().transcribe(new Blob(['mock audio']), 'management_call.m4a');
  const result = await checkClaims([{ name: 'management_call.m4a', text: transcript.segments.map(s => s.text).join('\n'), mocked: true, segments: transcript.segments }],
    [source('revenue,1175000.00\ncash,410000.00\ndebt,900000.00\nCT-101,signed\nCT-102,unsigned', 'finance_report.csv')], createJev());
  assertResponse(result);
  for (const expected of fixture.findings) {
    const actual = result.findings.find(f => f.id === expected.id)!;
    assert.ok(actual, expected.id);
    for (const key of ['decision', 'label', 'claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct', 'jev_probability'] as const)
      assert.equal(actual[key], expected[key], `${actual.id}: ${key}`);
    assert.equal(actual.mocked, true);
  }
  assert.deepEqual(result.findings.map(f => f.id), ['f-cash', 'f-revenue', 'f-contracts', 'f-debt']);
  assert.match(result.findings.find(f => f.id === 'f-contracts')!.explanation, /CT-102.*unsigned/);
  assert.deepEqual(result.transcript, { segments: transcript.segments });
});
test('extractor: original substrings, multiple claims and unique repeated IDs', async () => {
  const text = 'Revenue USD 1,250,000. Cash USD 480,000 and Debt USD 900,000.\nRevenue USD 50';
  const claims = extractClaims(source(text)); assert.equal(claims.length, 4);
  for (const claim of claims) assert.ok(text.includes(claim.quote));
  assert.equal(new Set((await check(text, 'revenue,1\ncash,1\ndebt,1')).findings.map(f => f.id)).size, 4);
  for (const invalid of ['not all contracts are signed', 'Revenue EUR 10', 'Revenue USD 1,25']) assert.equal(extractClaims(source(invalid)).length, 0);
});
test('periods: annual and quarter aliases; dollar amounts are not years', () => {
  assert.equal(normalizePeriod('fiscal year 2025'), 'FY2025');
  assert.equal(normalizePeriod('FY 2025'), 'FY2025');
  assert.equal(normalizePeriod('2025 Q1'), normalizePeriod('Q1 2025'));
  assert.equal(normalizePeriod('2025-12-31'), 'ASOF:2025-12-31');
  assert.equal(normalizePeriod('FY2025 and FY2024'), null);
  assert.equal(extractClaims(source('Revenue USD 2025'))[0]!.period, null);
});
test('periods and units: normalize before comparing; mismatches need review', async () => {
  const annual = await check('FY2025\nRevenue USD 1.25M', 'fiscal year 2025\nUSD in thousands\nrevenue,1250');
  assert.equal(annual.findings[0]!.decision, 'YES'); assert.equal(annual.period, 'FY2025');
  assert.equal((await check('Q1 2025\nCash USD 100', '2025 Q1\ncash,100')).findings[0]!.decision, 'YES');
  for (const proof of ['FY2024\nrevenue,100', 'Q1 2025\nrevenue,100', 'revenue,100']) {
    const result = await check('FY2025\nRevenue USD 100', proof);
    assert.equal(result.findings[0]!.decision, 'NEEDS_REVIEW'); assert.equal(result.findings[0]!.proof_usd, null);
  }
});
test('units: one inline amount scale does not leak into other claims', async () => {
  const result = await check('Revenue USD 100.00 and Cash 1 (in thousands)', 'revenue,100.00\ncash,1000.00');
  assert.ok(result.findings.every(f => f.decision === 'YES'));
  assert.equal((await check('Revenue USD 100', 'Currency: EUR\nrevenue,100')).findings[0]!.decision, 'NEEDS_REVIEW');
});
test('CSV: quoted money and explicit period columns are normalized', async () => {
  const result = await check('FY2025\nRevenue USD 1250000.00', 'metric,amount,period\n"revenue","1,250,000.00","2025"');
  assert.equal(result.findings[0]!.decision, 'YES');
  assert.equal(result.findings[0]!.proof_source!.quote, '"revenue","1,250,000.00","2025"');
});
test('contracts: register column headers, quoted values, and unknown status', async () => {
  const result = await check('contracts are signed', 'contract_id,name,status\nCT-101,"Acme, Inc.",signed\n"CT-102",Demo,"unsigned"', createJev());
  assert.equal(result.findings[0]!.decision, 'NO'); assert.match(result.findings[0]!.explanation, /CT-102/);
  const unknown = await check('contracts are signed', 'CT-101,signed\nCT-102,pending', createJev());
  assert.equal(unknown.findings[0]!.decision, 'NEEDS_REVIEW');
});

test('contracts: real starter register extracts every inline entry with its original line', () => {
  const register = source(`FICTIONAL DEAL DOCUMENT\n${starterRegisterLine}\n`, 'contract-register.txt');
  const rows = contractRows(register);
  assert.deepEqual(rows.map(({ id, signed, period }) => ({ id, signed, period })), [
    { id: 'CT-100', signed: true, period: 'ASOF:2026-09-30' },
    { id: 'CT-101', signed: true, period: 'ASOF:2026-09-30' },
    { id: 'CT-102', signed: false, period: 'ASOF:2026-09-30' },
  ]);
  for (const row of rows) { assert.equal(row.quote, starterRegisterLine); assert.equal(row.source, register); }
});

test('contracts: calendar quarter-end register dates match the corresponding quarter', async () => {
  for (const [date, quarter] of [['March 31', 'Q1'], ['June 30', 'Q2'], ['September 30', 'Q3'], ['December 31', 'Q4']]) {
    const result = await check(`2026 ${quarter}. All contracts are signed.`, `CT-102 unsigned as of ${date}, 2026.`, createJev());
    assert.equal(result.findings[0]!.decision, 'NO', date);
  }
  const exact = await check('2026-09-30\nAll contracts are signed.', starterRegisterLine, createJev());
  assert.equal(exact.findings[0]!.decision, 'NO');
});

test('contracts: missing, invalid, ambiguous and mismatched register dates still need review', async () => {
  for (const proof of [
    starterRegisterLine.replace('2026', '2025'),
    starterRegisterLine.replace('September 30', 'June 30'),
    starterRegisterLine.replace('September 30', 'September 29'),
    starterRegisterLine.replace('September 30', 'September 31'),
    starterRegisterLine.replace(' as of September 30, 2026', ''),
    `Q2 2026\n${starterRegisterLine.replace('Target 01', 'Q2 2026. Target 01')}`,
  ]) {
    const result = await check('2026 Q3. All contracts are signed.', proof);
    assert.equal(result.findings[0]!.decision, 'NEEDS_REVIEW', proof);
    assert.equal(result.findings[0]!.proof_source, null);
    assert.equal(result.findings[0]!.jev_probability, null);
  }
  const numeric = await check('Q3 2026\nCash USD 100', '2026-09-30\ncash,100');
  assert.equal(numeric.findings[0]!.decision, 'NEEDS_REVIEW', 'Numeric period matching is unchanged.');
});
test('evidence: conflicting or missing amounts require review without Jev', async () => {
  assert.equal((await check('Revenue USD 100', 'revenue,100\nrevenue,90')).findings[0]!.decision, 'NEEDS_REVIEW');
  assert.ok((await check('Debt USD 100\ncontracts are signed', 'cash,100')).findings.every(f => f.decision === 'NEEDS_REVIEW' && f.jev_probability === null));
});
test('quotes: altering either quote downgrades decision and label', async () => {
  const claims = source('Revenue USD 100', 'claims.txt'); const proof = source('revenue,100', 'proof.txt');
  const result = await checkClaims([claims], [proof], neverJev);
  for (const field of ['claim_source', 'proof_source'] as const) {
    const finding = structuredClone(result.findings[0]!); finding[field]!.quote += ' invented';
    verifyQuotes(finding, [claims, proof]); assert.equal(finding.decision, 'NEEDS_REVIEW'); assert.equal(finding.label, 'insufficient');
  }
});
test('priority: NO first and exact percentage gaps with 2x revenue/cash weight', async () => {
  assert.deepEqual((await check('Revenue USD 100.00\nDebt USD 100.00\nCash USD 100.00', 'revenue,90.00\ndebt,85.00\ncash,100.00')).findings.map(f => f.id), ['f-revenue', 'f-debt', 'f-cash']);
  assert.equal((await check('Debt USD 1000000.00\nRevenue USD 1000000.00', 'debt,999999.99\nrevenue,999999.98')).findings[0]!.id, 'f-revenue');
});
test('thresholds: inclusive boundaries live in checking code and are configurable', () => {
  for (const [p, decision] of [[0.2, 'NO'], [0.20001, 'NEEDS_REVIEW'], [0.79999, 'NEEDS_REVIEW'], [0.8, 'YES']] as const) assert.equal(probabilityDecision(p), decision);
  assert.equal(probabilityDecision(0.8, { yes: 0.9, no: 0.1 }), 'NEEDS_REVIEW');
  for (const value of [-1, 2, NaN, Infinity]) assert.throws(() => probabilityDecision(value));
  assert.throws(() => probabilityDecision(0.5, { yes: 0.2, no: 0.8 }));
});
test('contracts: deterministic unsigned status intentionally overrides Jev 0.99 and flags every unsigned row', async () => {
  const result = await check('contracts are signed', 'CT-101,signed\nCT-102,unsigned\nCT-103,unsigned', { async ask() { return { probability: 0.99, mocked: false }; } });
  assert.equal(result.findings[0]!.decision, 'NO'); assert.match(result.findings[0]!.explanation, /CT-102, CT-103/);
});
for (const probability of [0.20, 0.50, 0.80]) {
  for (const [status, decision, label] of [['unsigned', 'NO', 'discrepancy'], ['pending', 'NEEDS_REVIEW', 'insufficient']] as const) {
    test(`contracts: deterministic ${status === 'pending' ? 'unknown' : status} status overrides Jev ${probability.toFixed(2)}`, async () => {
      const result = await check('contracts are signed', `CT-101,signed\nCT-102,${status}`,
        { async ask() { return { probability, mocked: false }; } });
      assertResponse(result);
      const finding = result.findings[0]!;
      assert.equal(finding.jev_probability, probability);
      assert.equal(finding.decision, decision);
      assert.equal(finding.label, label);
    });
  }
}
test('contracts: signed register uses Jev thresholds', async () => {
  for (const p of [0.2, 0.5, 0.8]) assert.equal((await check('contracts are signed', 'CT-101,signed', { async ask() { return { probability: p, mocked: false }; } })).findings[0]!.decision, probabilityDecision(p));
});
test('contracts: Jev receives only rows matching the claim period', async () => {
  const result = await check('FY2025\ncontracts are signed', 'FY2025\nCT-101,signed\nFY2024\nCT-102,unsigned\nFY2025\nCT-103,signed', {
    async ask(state) { assert.equal(state, 'CT-101,signed\nCT-103,signed'); return { probability: 0.96, mocked: false }; },
  });
  assert.equal(result.findings[0]!.decision, 'YES');
});
test('audio: repeated identical claims retain their own segment timestamps', async () => {
  const segments = [
    { source: 'call.wav', text: 'Revenue USD 100.00', start: 0, end: 2, speaker: 'speaker_0' },
    { source: 'call.wav', text: 'Revenue USD 100.00', start: 5, end: 7, speaker: 'speaker_1' },
  ];
  const result = await checkClaims([{ name: 'call.wav', text: segments.map(s => s.text).join('\n'), segments, mocked: false }], [source('revenue,100.00')], neverJev);
  assert.deepEqual(result.findings.map(f => [f.claim_source.timestamp_start, f.claim_source.speaker]), [[0, 'speaker_0'], [5, 'speaker_1']]);
});
test('Jev mock: absent key makes no network call', async () => {
  const service = createJev(undefined, async () => assert.fail('No network in mock mode'));
  assert.deepEqual(await service.ask('CT-102,unsigned', 'Are contracts signed?'), { probability: 0.04, mocked: true });
  assert.equal((await service.ask('CT-101,signed', 'Are contracts signed?')).probability, 0.96);
});
test('Jev adapter: official text-only Noul shape through injected transport', async () => {
  const service = createJev('test-only-credential', async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only-credential');
    assert.deepEqual(JSON.parse(init!.body as string), { model: 'jev-latest', state: 'CT-102,unsigned', questions: { supported: { type: 'noul', instructions: 'Are all contracts signed?' } } });
    return Response.json({ answers: { supported: { type: 'noul', noul: 0.04 } } });
  });
  assert.deepEqual(await service.ask('CT-102,unsigned', 'Are all contracts signed?'), { probability: 0.04, mocked: false });
  await assert.rejects(service.ask(new Blob() as unknown as string, 'Question'), /text only/);
});
test('Jev adapter: invalid probabilities and upstream errors are redacted', async () => {
  for (const body of [{}, { answers: { supported: { type: 'noul', noul: 2 } } }, { answers: { supported: { type: 'noul', noul: '0.5' } } }])
    await assert.rejects(createJev('test-only-credential', async () => Response.json(body)).ask('text', 'question'), /^Error: Jev request failed\.$/);
  await assert.rejects(createJev('test-only-credential', async () => { throw new Error('private document'); }).ask('text', 'question'), /^Error: Jev request failed\.$/);
});
test('transcription mock: source provenance, timestamps and no network', async () => {
  const result = await createTranscriber(undefined, async () => assert.fail('No network in mock mode')).transcribe(new Blob(['audio']), 'call.wav');
  assert.equal(result.mocked, true); assert.ok(result.segments.every(s => s.source === 'call.wav' && s.end >= s.start));
});
test('ElevenLabs adapter: multipart audio, word timestamps and optional speakers', async () => {
  const service = createTranscriber('test-only-credential', async (url, init) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text'); assert.equal(new Headers(init!.headers).get('xi-api-key'), 'test-only-credential');
    const form = init!.body as FormData;
    assert.equal(form.get('model_id'), 'scribe_v2'); assert.equal(form.get('diarize'), 'true'); assert.equal(form.get('timestamps_granularity'), 'word');
    assert.equal((form.get('file') as File).name, 'call.m4a');
    return Response.json({ text: 'Revenue USD 100. Cash USD 50.', words: [
      { text: 'Revenue', start: 0, end: 1, type: 'word', speaker_id: 'speaker_0' }, { text: ' ', start: 1, end: 1, type: 'spacing' },
      { text: 'USD 100.', start: 1, end: 2, type: 'word', speaker_id: 'speaker_0' }, { text: 'Cash USD 50.', start: 3, end: 4, type: 'word' },
    ] });
  });
  assert.deepEqual(await service.transcribe(new Blob(['audio']), 'call.m4a'), { mocked: false, segments: [
    { source: 'call.m4a', start: 0, end: 2, speaker: 'speaker_0', text: 'Revenue USD 100. ' }, { source: 'call.m4a', start: 3, end: 4, speaker: null, text: 'Cash USD 50.' },
  ] });
});
test('ElevenLabs adapter: absent timing or upstream errors are not fabricated', async () => {
  for (const body of [{ text: 'words' }, { text: 'words', words: [] }, { text: 'word', words: [{ text: 'word', start: -1, end: 2 }] }])
    await assert.rejects(createTranscriber('test-only-credential', async () => Response.json(body)).transcribe(new Blob(), 'call.mp3'), /^Error: Transcription request failed\.$/);
});
test('config: only api/.env is read; process keys are ignored', async () => {
  const old = process.env.JEV_API_KEY; process.env.JEV_API_KEY = 'test-process-value-must-not-be-used';
  try {
    const config = await loadConfig((async (path: unknown) => { assert.equal(path, ENV_FILE); assert.match(String(path), /\/api\/\.env$/); return ''; }) as typeof readFile);
    assert.equal(config.jevKey, undefined); assert.equal(config.port, 3001); assert.deepEqual(config.thresholds, { yes: 0.8, no: 0.2 });
    assert.deepEqual(parseConfig('JEV_YES_THRESHOLD=0.9\nJEV_NO_THRESHOLD=0.1').thresholds, { yes: 0.9, no: 0.1 });
    assert.throws(() => parseConfig('JEV_YES_THRESHOLD=0.1\nJEV_NO_THRESHOLD=0.9'));
  } finally { if (old === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = old; }
});

async function withServer(run: (url: string) => Promise<void>, deps: Parameters<typeof createApp>[0] = {}) {
  const server = createApp(deps); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/check`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('HTTP: injected Claude handles new prose without changing response shape', async () => {
  const quote = 'Revenue from our pilots reached USD 1250000.00 in FY2025.';
  const { claude } = claudeStub([
    { claims: [{ type: 'money', quote, amount: '1250000.00', unit: 'USD', period: 'FY2025' }] },
    { explanation: 'The pilot revenue differs from the finance report amount.' },
  ]);
  await withServer(async url => {
    const body = new FormData(); body.set('claims_text', quote);
    body.append('proof_files', new Blob(['FY2025\nrevenue,1175000.00']), 'proof.csv');
    const response = await fetch(url, { method: 'POST', body });
    assert.equal(response.status, 200);
    const result: unknown = await response.json(); assertResponse(result);
    assert.equal(result.findings[0]!.claim_source.quote, quote);
    assert.equal(result.findings[0]!.gap_usd, '75000.00');
    assert.equal(result.findings[0]!.mocked, false);
  }, { claude, jev: neverJev });
});
function form(claims = 'Revenue USD 1250000.00\nCash USD 480000.00\nDebt USD 900000.00\ncontracts are signed') {
  const body = new FormData(); body.set('claims_text', claims);
  body.append('proof_files', new Blob(['revenue,1175000.00\ncash,410000.00\ndebt,900000.00\nCT-102,unsigned']), 'proof.csv'); return body;
}
test('HTTP: starter multipart, response shape, CORS and decimal strings', async () => withServer(async url => {
  const response = await fetch(url, { method: 'POST', body: form(), headers: { Origin: 'http://localhost:3000' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
  const body: unknown = await response.json();
  assertResponse(body);
  assert.equal(body.transcript, null); assert.equal(body.findings.length, 4);
  for (const finding of body.findings) {
    assert.equal(finding.claim_source.timestamp_start, null); assert.equal(finding.claim_source.timestamp_end, null);
    assert.equal(finding.claim_source.speaker, null); assert.equal(finding.mocked, true);
    const expected = fixture.findings.find(f => f.id === finding.id)!;
    for (const field of ['claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct'] as const) assert.equal(finding[field], expected[field], field);
  }
}));

test('HTTP: real starter register returns NO for CT-102 with the original proof line and filename', async () => withServer(async url => {
  const body = new FormData();
  body.append('claims_files', new Blob(['2026 Q3. Management claims all material contracts are signed.']), 'management-summary.txt');
  body.append('proof_files', new Blob([`FICTIONAL DEAL DOCUMENT\n${starterRegisterLine}\n`]), 'contract-register.txt');
  const response = await fetch(url, { method: 'POST', body });
  assert.equal(response.status, 200);
  const result: unknown = await response.json(); assertResponse(result);
  assert.equal(result.period, '2026-Q3'); assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.decision, 'NO'); assert.equal(finding.label, 'discrepancy');
  assert.match(finding.explanation, /CT-102.*unsigned/);
  assert.deepEqual(finding.proof_source, { name: 'contract-register.txt', quote: starterRegisterLine, url: null });
  assert.equal(finding.jev_probability, 0.99, 'An unsigned entry overrides even a high Jev probability.');
}, { jev: { async ask() { return { probability: 0.99, mocked: false }; } } }));
test('HTTP: missing numeric and contract evidence leaves evidence fields null without Jev', async () => withServer(async url => {
  const body = form('Revenue USD 100.00\ncontracts are signed');
  body.set('proof_files', new Blob(['cash,100.00']), 'proof.csv');
  const response = await fetch(url, { method: 'POST', body }); assert.equal(response.status, 200);
  const result: unknown = await response.json(); assertResponse(result);
  assert.equal(result.findings.length, 2); assert.equal(result.transcript, null);
  for (const finding of result.findings) {
    assert.equal(finding.decision, 'NEEDS_REVIEW'); assert.equal(finding.label, 'insufficient');
    for (const field of ['proof_source', 'proof_usd', 'gap_usd', 'gap_pct', 'jev_probability'] as const) assert.equal(finding[field], null, field);
    assert.equal(finding.claimed_usd, finding.id === 'f-revenue' ? '100.00' : null);
  }
}, { jev: neverJev }));
test('HTTP: repeated claim files and optional ticker', async () => withServer(async url => {
  const body = form(); body.delete('claims_text'); body.set('ticker', 'DEMO');
  body.append('claims_files', new Blob(['Revenue USD 1250000.00']), 'claims1.txt'); body.append('claims_files', new Blob(['Cash USD 480000.00']), 'claims2.txt');
  const response = await fetch(url, { method: 'POST', body }); assert.equal(response.status, 200);
  const result: unknown = await response.json(); assertResponse(result);
  assert.equal(result.company, 'DEMO'); assert.equal(result.findings.length, 2); assert.equal(result.sources.length, 3);
}));
function textPdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 40 200 Td (Revenue USD 1250000.00) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
test('HTTP: real text PDF extraction preserves evidence quotes on Node 22', async () => withServer(async url => {
  const body = form(); body.delete('claims_text'); body.append('claims_files', new Blob([textPdf() as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'claims.pdf');
  const response = await fetch(url, { method: 'POST', body }); assert.equal(response.status, 200);
  const result: unknown = await response.json(); assertResponse(result);
  assert.equal(result.findings[0]!.claim_source.quote, 'Revenue USD 1250000.00');
  assert.equal(result.findings[0]!.gap_usd, '75000.00');
}));
test('HTTP: repeated audio preserves transcript source, timestamps and mock flags', async () => withServer(async url => {
  const body = form(); body.delete('claims_text'); body.append('claims_audio', new Blob(['audio']), 'one.mp3'); body.append('claims_audio', new Blob(['audio']), 'two.wav');
  const response = await fetch(url, { method: 'POST', body }); assert.equal(response.status, 200);
  const result: unknown = await response.json(); assertResponse(result);
  assert.equal(result.findings.length, 8); assert.equal(result.transcript!.segments.length, 6);
  for (const finding of result.findings) {
    const segment: Segment | undefined = result.transcript!.segments.find(s => s.source === finding.claim_source.name && s.text.includes(finding.claim_source.quote));
    assert.ok(segment); assert.equal(finding.claim_source.timestamp_start, segment.start);
    assert.equal(finding.claim_source.timestamp_end, segment.end); assert.equal(finding.claim_source.speaker, segment.speaker);
    assert.equal(finding.mocked, true);
  }
}));
test('HTTP: audio with an unknown speaker keeps numeric timestamps and null speaker labels', async () => withServer(async url => {
  const body = form(); body.delete('claims_text'); body.append('claims_audio', new Blob(['audio']), 'unknown.wav');
  const response = await fetch(url, { method: 'POST', body }); assert.equal(response.status, 200);
  const result: unknown = await response.json(); assertResponse(result);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.transcript, { segments: [{ source: 'unknown.wav', start: 0, end: 2, speaker: null, text: 'Revenue USD 1250000.00' }] });
  assert.deepEqual(result.findings[0]!.claim_source, { name: 'unknown.wav', quote: 'Revenue USD 1250000.00', timestamp_start: 0, timestamp_end: 2, speaker: null });
}, { jev: neverJev, transcriber: { async transcribe(_audio, name) {
  return { segments: [{ source: name, start: 0, end: 2, speaker: null, text: 'Revenue USD 1250000.00' }], mocked: false };
} } }));
test('HTTP: CORS preflight and unrelated origin', async () => withServer(async url => {
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('Access-Control-Allow-Methods')!, /POST/);
  assert.equal((await fetch(url, { method: 'POST', body: form(), headers: { Origin: 'https://unrelated.example' } })).headers.get('Access-Control-Allow-Origin'), null);
}));
test('HTTP: invalid uploads return 400 before paid service calls', async () => withServer(async url => {
  const cases: FormData[] = [];
  let body = form(); body.delete('proof_files'); cases.push(body);
  body = form(); body.delete('claims_text'); cases.push(body);
  body = form(); body.append('claims_files', new Blob(['x']), 'wrong.exe'); cases.push(body);
  body = form(); body.append('proof_files', new Blob(['x']), 'proof.csv'); cases.push(body);
  body = form(); body.append('unknown', 'x'); cases.push(body);
  body = form(); body.append('claims_text', 'Debt USD 1'); cases.push(body);
  body = form('No supported claims'); cases.push(body);
  body = form(); body.append('claims_files', new Blob(['not a PDF']), 'broken.pdf'); cases.push(body);
  body = form(); body.append('claims_files', new Blob([]), 'empty.txt'); cases.push(body);
  for (const invalid of cases) {
    const response = await fetch(url, { method: 'POST', body: invalid }); assert.equal(response.status, 400);
    const result = await response.json(); assert.deepEqual(Object.keys(result), ['error']); assert.equal(typeof result.error, 'string');
  }
}, { jev: neverJev, transcriber: { async transcribe() { assert.fail('Invalid uploads must not call services'); } } }));
test('HTTP: wrong method, malformed multipart and size cap return JSON errors', async () => withServer(async url => {
  for (const init of [{ method: 'GET' }, { method: 'POST', body: 'raw text' }, { method: 'POST', body: 'bad form', headers: { 'Content-Type': 'multipart/form-data; boundary=missing' } },
    { method: 'POST', body: new Uint8Array(MAX_REQUEST_BYTES + 1), headers: { 'Content-Type': 'multipart/form-data; boundary=oversize' } }]) {
    const response = await fetch(url, init); assert.equal(response.status, 400); assert.equal(typeof (await response.json()).error, 'string');
  }
}));
test('HTTP: upstream failures return generic 500 without document text', async () => withServer(async url => {
  const response = await fetch(url, { method: 'POST', body: form() }); assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Unable to complete the check.' });
}, { jev: { async ask() { throw new Error('private document and credential'); } } }));

// Real starter files, byte for byte (test/fixtures). Claude is stubbed; Jev must never be called for money claims.
const fixtureText = (name: string) => readFile(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');
// Contract claims may consult Jev (their decision stays deterministic); anything carrying an amount may not.
const jevForbidden: Jev = { async ask(evidence, question) {
  assert.ok(!containsMoney(`${evidence}
${question}`) && !/(?:revenue|cash|debt)/i.test(evidence), 'Jev must not be called for money claims.');
  return { probability: 0.04, mocked: true };
} };
function dispatchingClaude(claims: unknown[]) {
  const transport: Transport = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const output = String(request.system).startsWith('Extract every factual claim') ? { claims }
      : { explanation: 'The claim and the proof quote state amounts.' };
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] });
  };
  return createClaude('test-only-placeholder', transport);
}
async function runStarter(claims: unknown[]) {
  const [summary, finance, register] = await Promise.all(['management-summary.txt', 'finance-report.txt', 'contract-register.txt'].map(fixtureText));
  return checkClaims([source(summary!, 'management-summary.txt')],
    [source(finance!, 'finance-report.txt'), source(register!, 'contract-register.txt')], jevForbidden, { claude: dispatchingClaude(claims) });
}
function assertStarterFindings(result: CheckResponse) {
  assertResponse(result);
  const by = (id: string) => result.findings.find(f => f.id === id)!;
  const cash = by('f-cash'); const debt = by('f-debt'); const revenue = by('f-revenue'); const contracts = by('f-contracts');
  assert.deepEqual([revenue.decision, revenue.claimed_usd, revenue.proof_usd, revenue.gap_usd, revenue.gap_pct],
    ['NO', '1250000.00', '1175000.00', '75000.00', '6.00']);
  assert.deepEqual([cash.decision, cash.claimed_usd, cash.proof_usd, cash.gap_usd, cash.gap_pct],
    ['NO', '480000.00', '410000.00', '70000.00', '14.58']);
  assert.deepEqual([debt.decision, debt.claimed_usd, debt.proof_usd, debt.gap_usd, debt.gap_pct],
    ['YES', '900000.00', '900000.00', '0.00', '0.00']);
  assert.equal(cash.proof_source?.name, 'finance-report.txt');
  assert.equal(cash.proof_source?.quote, 'Cash USD 410,000');
  assert.equal(contracts.decision, 'NO');
  assert.equal(contracts.proof_source?.name, 'contract-register.txt');
  assert.match(contracts.proof_source!.quote, /CT-102 unsigned/);
  for (const finding of [revenue, cash, debt]) assert.equal(finding.jev_probability, null);
}
const sentence = 'Management claims all material contracts are signed.';
for (const [label, period] of [['model leaves period empty', ''], ['model states the period', '2026 Q3']] as const) {
  test(`Starter files: amounts quoted without their period still match proof (${label})`, async () => {
    assertStarterFindings(await runStarter([
      { type: 'money', quote: 'Revenue USD 1,250,000', amount: '1,250,000', unit: 'USD', period },
      { type: 'money', quote: 'Cash USD 480,000', amount: '480,000', unit: 'USD', period },
      { type: 'money', quote: 'Debt USD 900,000', amount: '900,000', unit: 'USD', period },
      { type: 'contract', quote: sentence },
    ]));
  });
}
test('Starter files: a quote spanning several metrics is labelled by the amount it names', async () => {
  const quote = 'Revenue USD 1,250,000. Cash USD 480,000. Debt USD 900,000.';
  const result = await runStarter([{ type: 'money', quote, amount: '480,000', unit: 'USD', period: '2026 Q3' }]);
  assert.equal(result.findings[0]!.id, 'f-cash');
  assert.equal(result.findings[0]!.claimed_usd, '480000.00');
  assert.equal(result.findings[0]!.proof_usd, '410000.00');
});
test('Starter files: deterministic extraction (no Claude) returns all four results', async () => {
  const [summary, finance, register] = await Promise.all(['management-summary.txt', 'finance-report.txt', 'contract-register.txt'].map(fixtureText));
  assertStarterFindings(await checkClaims([source(summary!, 'management-summary.txt')],
    [source(finance!, 'finance-report.txt'), source(register!, 'contract-register.txt')], jevForbidden,
    { claude: createClaude(undefined, undefined) }));
});

// ---- Real-filing matching: scales, tables, period aliases, forward-looking and unmatched claims ----------------
const pressRelease = [
  'JPMorgan Chase Reports Third-Quarter 2026 Net Income of $14.4 billion',
  '($ in millions, except per share data)',
  '                              3Q26      2Q26      3Q25     QoQ    YoY',
  'Net revenue                 46,000    45,300    42,900      2 %    7 %',
  'Net income                  14,393    14,285    13,419      1 %    7 %',
  'Provision for credit losses (1,234)      512       897     NM     NM',
  'CET1 capital ratio            15.7%     15.5%     15.0%',
  'Diluted earnings per share    $5.07     $5.02     $4.51',
].join('\n');
const callHeader = 'JPMorgan Q3 2026 earnings call\n';
function countingJev() {
  const state = { calls: 0 };
  const jev: Jev = { async ask() { state.calls++; return { probability: 0.05, mocked: false }; } };
  return { jev, state };
}
const moneyClaim = (quote: string, amount: string, period = 'third quarter') => ({ type: 'money', quote, amount, unit: '', period });
async function callCheck(claimText: string, claims: unknown[], proof = pressRelease, jev: Jev = neverJev) {
  const { claude } = claudeStub([{ claims }]);
  const result = await checkClaims([source(callHeader + claimText, 'call.txt')], [source(proof, 'release.txt')], jev, { claude });
  assertResponse(result);
  return result;
}

test('money scale: thousand, million, billion and trillion (and k, mm, bn, tn) become integer cents', () => {
  assert.equal(decimal(parseMoney('$1.4 trillion').cents), '1400000000000.00');
  assert.equal(parseMoney('$1.4 trillion').cents, 140000000000000n);
  assert.equal(parseMoney('2 tn').cents, 200000000000000n);
  assert.equal(parseMoney('$2.5 bn').cents, 250000000000n);
  assert.equal(parseMoney('$3 mm').cents, 300000000n);
  assert.equal(parseMoney('750 k').cents, 75000000n);
  assert.equal(parseMoney('$12 thousand').cents, 1200000n);
  assert.ok(containsMoney('assets of 1.4 trillion') && containsMoney('$5 tn'));
});

test('money scale: trillion claim is shown as 1400000000000.00; an unparseable scale word shows no amount and never reaches Jev', async () => {
  const shown = await callCheck('Our balance sheet holds total assets of $1.4 trillion.',
    [moneyClaim('total assets of $1.4 trillion', '$1.4 trillion', '')]);
  assert.equal(shown.findings[0]!.claimed_usd, '1400000000000.00');
  assert.equal(shown.findings[0]!.decision, 'NEEDS_REVIEW');
  const { jev, state } = countingJev();
  const unparsed = await callCheck('Our balance sheet holds total assets of $1.4 tril.',
    [moneyClaim('total assets of $1.4 tril', '$1.4', '')], pressRelease, jev);
  const finding = unparsed.findings[0]!;
  assert.equal(finding.decision, 'NEEDS_REVIEW'); assert.equal(finding.claimed_usd, null);
  assert.equal(finding.jev_probability, null); assert.equal(state.calls, 0);
  assert.match(finding.explanation, /scale word that could not be parsed/);
});

test('periods: 3Q26, Q3 2026, third quarter 2026 and 2026-Q3 are one period', () => {
  for (const alias of ['3Q26', '3Q2026', 'Q3 2026', 'Q3 FY2026', "Q3'26", 'third quarter 2026', 'Third-Quarter 2026', 'third quarter of 2026', '2026-Q3', '2026 Q3'])
    assert.equal(normalizePeriod(alias), '2026-Q3', alias);
  assert.equal(normalizePeriod('3Q25'), '2025-Q3');
  assert.equal(normalizePeriod('FY2026'), 'FY2026');
});

test('tables: "$ in millions" scale, period columns and parenthesised negatives are read in integer cents', () => {
  const figures = filingFigures(source(pressRelease, 'release.txt'));
  const find = (key: string, period: string) => figures.filter(f => f.key === key && f.period === period);
  assert.equal(find('net income', '2026-Q3').find(f => f.quote.startsWith('Net income'))!.money!.cents, 1439300000000n);
  assert.equal(find('net income', '2025-Q3').find(f => f.quote.startsWith('Net income'))!.money!.cents, 1341900000000n);
  assert.equal(find('revenue', '2026-Q3')[0]!.money!.cents, 4600000000000n);
  assert.equal(find('provision for credit loss', '2026-Q3')[0]!.money!.cents, -123400000000n);
  assert.equal(find('diluted earning per share', '2026-Q3')[0]!.money!.cents, 507n); // per-share rows ignore the millions header
  assert.equal(find('cet1 capital ratio', '2026-Q3')[0]!.percent!.value, 157000n);
  assert.equal(figures.some(f => f.period === null), false);
});

test('scaled amount across a table: "$14.4 billion" in the third quarter matches 14,393 (in millions) for 3Q26', async () => {
  const quote = 'net income of $14.4 billion in the third quarter';
  const yes = await callCheck(`We delivered ${quote}.`, [moneyClaim(quote, '$14.4 billion')]);
  const finding = yes.findings[0]!;
  assert.equal(finding.decision, 'YES'); assert.equal(finding.label, 'supported');
  assert.equal(finding.claimed_usd, '14400000000.00'); assert.equal(finding.proof_usd, '14393000000.00');
  assert.equal(finding.gap_usd, '7000000.00'); assert.equal(finding.jev_probability, null);
  assert.ok(finding.proof_source!.quote.startsWith('Net income'));
  const no = await callCheck('We delivered net income of $15.4 billion in 3Q26.', [moneyClaim('net income of $15.4 billion in 3Q26', '$15.4 billion', '3Q26')]);
  assert.equal(no.findings[0]!.decision, 'NO'); assert.equal(no.findings[0]!.gap_usd, '1007000000.00'); assert.equal(no.findings[0]!.gap_pct, '6.54');
  // The figure for another period is never used for this claim.
  const prior = await callCheck('We delivered net income of $14.4 billion in 3Q25.', [moneyClaim('net income of $14.4 billion in 3Q25', '$14.4 billion', '3Q25')]);
  assert.equal(prior.findings[0]!.decision, 'NO'); assert.equal(prior.findings[0]!.proof_usd, '13419000000.00');
});

test('period alias: a "Q3 2026" claim finds the "3Q26" table column', async () => {
  const quote = 'Revenue for Q3 2026 was $46.0 billion';
  const result = await callCheck(`${quote}.`, [moneyClaim(quote, '$46.0 billion', 'Q3 2026')]);
  assert.equal(result.findings[0]!.decision, 'YES'); assert.equal(result.findings[0]!.proof_usd, '46000000000.00');
});

test('forward-looking or hedged claims need review with the stated reason and never reach Jev', async () => {
  const { jev, state } = countingJev();
  for (const quote of ['We expect net income of about $15 billion next quarter', 'Net income will probably be $16.0 billion', 'Something like $50 billion of revenue for the full year is our guidance']) {
    const result = await callCheck(`${quote}.`, [moneyClaim(quote, /\$[\d.]+ billion/.exec(quote)![0])], pressRelease, jev);
    const finding = result.findings[0]!;
    assert.equal(finding.decision, 'NEEDS_REVIEW', quote); assert.equal(finding.label, 'insufficient');
    assert.match(finding.explanation, /forward-looking, not verifiable against reported results/);
    assert.equal(finding.proof_source, null); assert.equal(finding.jev_probability, null);
  }
  const text = await callCheck('We are going to open a new office in Boston.', [{ type: 'text', quote: 'We are going to open a new office in Boston' }],
    'We opened an office in Boston.', jev);
  assert.equal(text.findings[0]!.decision, 'NEEDS_REVIEW'); assert.match(text.findings[0]!.explanation, /forward-looking/);
  assert.equal(state.calls, 0);
});

test('an unmatched claim is NEEDS_REVIEW with the proof-does-not-address explanation and no Jev call', async () => {
  const { jev, state } = countingJev();
  const quote = 'tangible book value of $100 billion in the third quarter';
  const money = await callCheck(`We reported ${quote}.`, [moneyClaim(quote, '$100 billion')], pressRelease, jev);
  assert.equal(money.findings[0]!.decision, 'NEEDS_REVIEW');
  assert.match(money.findings[0]!.explanation, /proof does not address this claim/);
  assert.equal(money.findings[0]!.proof_source, null); assert.equal(money.findings[0]!.gap_usd, null);
  const text = await callCheck('We opened a branch in Singapore.', [{ type: 'text', quote: 'We opened a branch in Singapore' }], pressRelease, jev);
  assert.equal(text.findings[0]!.decision, 'NEEDS_REVIEW'); assert.match(text.findings[0]!.explanation, /proof does not address this claim/);
  assert.equal(state.calls, 0);
  // Missing proof is never a NO, even when the claim's period has no column.
  const period = await callCheck('We reported net income of $14.4 billion in the first quarter.',
    [moneyClaim('net income of $14.4 billion in the first quarter', '$14.4 billion', 'first quarter')], pressRelease, jev);
  assert.equal(period.findings[0]!.decision, 'NEEDS_REVIEW'); assert.equal(state.calls, 0);
});

test('percent claims: compared in code for the same metric and period, otherwise NEEDS_REVIEW without Jev', async () => {
  const { jev, state } = countingJev();
  const yes = await callCheck('Our CET1 capital ratio was 15.7% in the third quarter.',
    [{ type: 'text', quote: 'Our CET1 capital ratio was 15.7% in the third quarter' }], pressRelease, jev);
  assert.equal(yes.findings[0]!.decision, 'YES'); assert.equal(yes.findings[0]!.claimed_usd, null);
  const no = await callCheck('Our CET1 capital ratio was 16.2% in the third quarter.',
    [{ type: 'text', quote: 'Our CET1 capital ratio was 16.2% in the third quarter' }], pressRelease, jev);
  assert.equal(no.findings[0]!.decision, 'NO');
  for (const quote of ['Our CET1 capital ratio was 15.7% in the first quarter', 'Our liquidity coverage ratio was 112% in the third quarter', 'Net income was up 7% in the third quarter']) {
    const review = await callCheck(`${quote}.`, [{ type: 'text', quote }], pressRelease, jev);
    assert.equal(review.findings[0]!.decision, 'NEEDS_REVIEW', quote);
  }
  assert.equal(state.calls, 0);
});

test('text claims reach Jev only when code found a relevant passage', async () => {
  const proof = 'The Boston office remains closed pending permits.\nUnrelated line about weather.';
  const { jev, state } = countingJev();
  const hit = await callCheck('The Boston office opened in May.', [{ type: 'text', quote: 'The Boston office opened in May.' }], proof, jev);
  assert.equal(state.calls, 1); assert.equal(hit.findings[0]!.decision, 'NO');
  const weak = await callCheck('The office was great.', [{ type: 'text', quote: 'The office was great.' }], proof, jev);
  assert.equal(state.calls, 1); assert.equal(weak.findings[0]!.decision, 'NEEDS_REVIEW');
});
