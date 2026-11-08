import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp, MAX_REQUEST_BYTES } from '../src/app.js';
import { checkClaims, probabilityDecision, verifyQuotes } from '../src/check.js';
import { ENV_FILE, loadConfig, parseConfig } from '../src/config.js';
import { contractRows, extractClaims, normalizePeriod } from '../src/extract.js';
import { createJev, type Jev, type Transport } from '../src/jev.js';
import { compareMoney, containsMoney, decimal, parseMoney } from '../src/money.js';
import { createMockTranscriber, createTranscriber } from '../src/transcribe.js';
import { AudioStore, createFfmpegRenderer, MAX_RECORDINGS, type Spawn } from '../src/clips.js';
import { recordingDurationMs } from '../src/audio-duration.js';
import { BadInput, parseUploads } from '../src/uploads.js';
import { filingFigures, legacyFigures } from '../src/filing.js';
import { createClaude, explainFinding } from '../src/claude.js';
import { bareMoneyAmount, claimSchema, claimsSchema, createClaimExtractor, signedContractsAssertion, splitChunks, type ExtractionNote } from '../src/extract.js';
import type { CheckResponse, Segment, SourceText } from '../src/types.js';
import { checkableClaim, completeAssertion } from '../src/quality.js';

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
  assert.deepEqual(notes, [{ dropped_claims: 2, chunks: 1, failed_chunks: 0, claims_returned: 3, duplicates: 0, fallback_claims: 0, kept_claims: 1, capped: 0 }]);
  assert.ok(!JSON.stringify(notes).includes('pharmacies')); assert.equal(requests.length, 1);
  const dropped = claudeStub([{ claims: [{ type: 'text', quote: 'invented' }] }]);
  assert.deepEqual((await createClaimExtractor(dropped.claude, () => {})(source('Revenue USD 100.00'))).claims, []);
});

test('Claude: malformed JSON and invalid schemas retry once then fall back to regex', async () => {
  for (const invalid of ['not JSON', { claims: 'invalid' }, { missing: [] }]) {
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
  assert.equal(result.findings[0]!.decision, 'NEEDS_REVIEW'); assert.equal(result.findings[0]!.mocked, false);
  assert.match(result.findings[0]!.explanation, /Jev found no support in the proof/);
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

test('explanations: three workers preserve document order despite reversed completion and retry/fallback', async () => {
  const quotes = Array.from({ length: 14 }, (_, index) => `Revenue USD 100.00 (statement ${index})`);
  const input = source(quotes.join('\n'));
  const pending: (() => void)[] = [];
  const attempts = new Map<string, number>();
  let active = 0; let peak = 0;
  const completed: string[] = [];
  const claude = createClaude('test-only-placeholder', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 256);
    const data = JSON.parse(body.messages[0].content);
    assert.deepEqual(Object.keys(data).sort(), ['claim_quote', 'proof_quote']);
    assert.equal(data.proof_quote, 'revenue,100.00');
    active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => pending.push(resolve));
    active--; completed.push(data.claim_quote);
    const attempt = (attempts.get(data.claim_quote) ?? 0) + 1;
    attempts.set(data.claim_quote, attempt);
    // First finding recovers on retry; second exhausts both attempts.
    const bad = data.claim_quote === quotes[1] || (data.claim_quote === quotes[0] && attempt === 1);
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: bad ? 'bad JSON'
      : JSON.stringify({ explanation: `Explanation of ${data.claim_quote}` }) }] });
  }, () => {});
  const promise = checkClaims([input], [source('revenue,100.00', 'proof.csv')], neverJev,
    { claude, extractor: async () => ({ claims: quotes.map(quote => ({ ...extractClaims(source(quote))[0]!, quote, source: input })), mocked: false }) });
  let settled = false;
  void promise.then(() => { settled = true; });
  for (let turns = 0; !settled && turns < 100; turns++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(active <= 3);
    // Release later calls first; a serial implementation cannot reach peak three.
    const batch = pending.splice(0).reverse();
    batch.forEach(release => release());
  }
  assert.ok(settled, 'all workers finish');
  const result = await promise;
  assert.equal(peak, 3);
  assert.notEqual(completed[0], quotes[0]);
  assert.deepEqual(result.findings.map(f => f.claim), quotes);
  assert.deepEqual(quotes.map(quote => attempts.get(quote)), [2, 2, ...Array(12).fill(1)]);
  for (const [index, finding] of result.findings.entries()) {
    assert.equal(finding.decision, 'YES');
    assert.equal(finding.mocked, index === 1);
    assert.equal(finding.explanation, index === 1 ? 'The proof amount matches the claim at its stated precision.' : `Explanation of ${quotes[index]}`);
  }
});

test('explanations: fixed reasons and missing evidence use quote templates with zero Claude calls', async () => {
  for (const [quote, proof, reason] of [
    ['We expect revenue of USD 100.00.', 'revenue,100.00', /Subjective statement/],
    ['Revenue increased by USD 100.00.', 'revenue,100.00', /change/],
    ['Revenue EUR 100.00', 'revenue,100.00', /could not be read safely as US dollars/],
    ['Revenue USD 100.00', 'Unrelated evidence.', /does not address/],
    ['All material contracts are signed.', 'Unrelated evidence.', /does not address/],
  ] as const) {
    const input = source(quote);
    const { claude, requests } = claudeStub([{ claims: [quote.includes('contracts') ? { type: 'contract', quote }
      : { type: 'money', quote, amount: '100.00', unit: 'USD', period: '' }] }]);
    const result = await checkClaims([input], [source(proof)], neverJev, {
      claude,
    });
    assert.equal(requests.length, 1, 'only extraction; zero explanation calls');
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0]!;
    assert.equal(finding.decision, 'NEEDS_REVIEW'); assert.equal(finding.mocked, false);
    assert.match(finding.explanation, reason); assert.ok(finding.explanation.includes(JSON.stringify(quote)));
  }
});

test('explanations: HTTP 429 logs a code and waits before the single retry', async () => {
  for (const recover of [true, false]) {
    let calls = 0; const waits: number[] = []; const notes: unknown[] = [];
    const claude = createClaude('test-only-placeholder', async () => {
      calls++;
      if (calls === 1 || !recover) return new Response('private upstream body', { status: 429 });
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"explanation":"The passages agree."}' }] });
    }, note => notes.push(note), async milliseconds => {
      assert.equal(calls, 1, 'retry cannot start before backoff'); waits.push(milliseconds);
    });
    assert.equal(await explainFinding(claude, 'private claim', 'private proof'), recover ? 'The passages agree.' : null);
    assert.equal(calls, 2); assert.deepEqual(waits, [500]);
    assert.deepEqual(notes, Array.from({ length: recover ? 1 : 2 }, (_, index) => ({
      event: 'claude_attempt_failed', label: 'explain', attempt: index + 1, reason: 'http_status', status: 429,
    })));
    assert.ok(!JSON.stringify(notes).includes('private'));
  }
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

test('Claude: repeated truncation has bounded splits; refusal and upstream errors retry once', async () => {
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
    assert.equal(calls, failure === 'truncated' ? 7 : 2);
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

test('Claude: mixed-source fallback marks only the findings that used the fallback as mocked', async () => {
  const first = source('Revenue USD 100.00', 'first.txt');
  const second = source('Cash USD 50.00', 'second.txt');
  const { claude } = claudeStub([{ explanation: 'The amounts match.' }, { explanation: 'The amounts match.' }]);
  const result = await checkClaims([first, second], [source('revenue,100.00\ncash,50.00', 'proof.csv')], neverJev,
    { claude, extractor: async input => ({ claims: extractClaims(input), mocked: input === second }) });
  assert.deepEqual(result.findings.map(finding => [finding.claim_source.name, finding.mocked]).sort(),
    [['first.txt', false], ['second.txt', true]]);
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
    // Audio findings may add start_ms/end_ms (integers or null) and audio_file_id; text findings have none of them.
    const core: Record<string, unknown> = { ...finding };
    delete core.start_ms; delete core.end_ms; delete core.audio_file_id;
    assertObject(core, ['id', 'claim', 'claim_source', 'label', 'decision', 'jev_probability',
      'explanation', 'proof_source', 'claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct',
      'priority', 'next_action', 'mocked']);
    assert.equal(finding.start_ms === undefined, finding.end_ms === undefined, 'start_ms and end_ms appear together');
    for (const offset of [finding.start_ms, finding.end_ms]) if (offset !== undefined) assert.ok(offset === null || Number.isSafeInteger(offset), 'milliseconds');
    if (finding.audio_file_id !== undefined) assert.equal(typeof finding.audio_file_id, 'string');
    for (const field of ['id', 'claim', 'explanation', 'next_action']) assert.equal(typeof finding[field], 'string', field);
    assert.ok(finding.decision === 'YES' || finding.decision === 'NO' || finding.decision === 'NEEDS_REVIEW');
    const labelFor: Record<string, string> = { YES: 'supported', NO: 'discrepancy', NEEDS_REVIEW: 'insufficient' };
    assert.equal(finding.label, labelFor[String(finding.decision)]);
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
  for (const [p, decision] of [[0.2, 'NEEDS_REVIEW'], [0.20001, 'NEEDS_REVIEW'], [0.79999, 'NEEDS_REVIEW'], [0.8, 'YES']] as const) assert.equal(probabilityDecision(p), decision);
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
test('audio: a recorded claim and the same text claim share decision, amounts and explanation', async () => {
  const proof = source('FY2025\nrevenue,1175000.00\ncash,410000.00\ndebt,900000.00\nCT-101,signed\nCT-102,unsigned', 'finance-report.txt');
  const segments: Segment[] = [
    { source: 'recording.m4a', start: 0, end: 4, speaker: 'speaker_0', text: 'FY2025 results.' },
    { source: 'recording.m4a', start: 13.1, end: 18.2, speaker: 'speaker_0', text: 'Revenue was $1,250,000.' },
  ];
  const audio = await checkClaims([{ name: 'recording.m4a', text: segments.map(s => s.text).join('\n'), segments, mocked: false }], [proof], neverJev);
  const text = await checkClaims([source('FY2025 results.\nRevenue was $1,250,000.', 'management-summary.txt')], [proof], neverJev);
  const revenue = (result: CheckResponse) => result.findings.find(f => f.claim.startsWith('Revenue'))!;
  const [a, t] = [revenue(audio), revenue(text)];
  for (const key of ['decision', 'label', 'priority', 'claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct', 'explanation'] as const)
    assert.equal(a[key], t[key], key);
  assert.deepEqual([a.decision, a.claimed_usd, a.proof_usd, a.gap_usd, a.gap_pct], ['NO', '1250000.00', '1175000.00', '75000.00', '6.00']);
  assert.deepEqual([a.claim_source.timestamp_start, a.claim_source.timestamp_end, a.claim_source.speaker], [13.1, 18.2, 'speaker_0']);
});
test('audio: a recorded claim without a period reviews exactly like the same text claim', async () => {
  const proof = source('FY2025\nrevenue,1175000.00', 'finance-report.txt');
  const segment: Segment = { source: 'recording.m4a', start: 13.1, end: 18.2, speaker: 'speaker_0', text: 'Revenue was $1,250,000.' };
  const audio = await checkClaims([{ name: 'recording.m4a', text: segment.text, segments: [segment], mocked: false }], [proof], neverJev);
  const text = await checkClaims([source('Revenue was $1,250,000.', 'claims.txt')], [proof], neverJev);
  const revenue = (result: CheckResponse) => result.findings.find(f => f.claim.startsWith('Revenue'))!;
  const [a, t] = [revenue(audio), revenue(text)];
  assert.equal(a.decision, 'NEEDS_REVIEW');
  for (const key of ['decision', 'label', 'priority', 'claimed_usd', 'proof_usd', 'gap_usd', 'gap_pct', 'explanation'] as const)
    assert.equal(a[key], t[key], key);
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
  // Word offsets are measured in the segment-joined text ("segment\nsegment"), which is the claim source text.
  assert.deepEqual(await service.transcribe(new Blob(['audio']), 'call.m4a'), { mocked: false, segments: [
    { source: 'call.m4a', start: 0, end: 2, speaker: 'speaker_0', text: 'Revenue USD 100. ' }, { source: 'call.m4a', start: 3, end: 4, speaker: null, text: 'Cash USD 50.' },
  ], wordTimings: [{ from: 0, to: 7, start: 0, end: 1 }, { from: 8, to: 16, start: 1, end: 2 }, { from: 18, to: 30, start: 3, end: 4 }] });
  assert.equal('Revenue USD 100. \nCash USD 50.'.slice(18, 30), 'Cash USD 50.');
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
test('CORS: development origins come only from DEV_CORS_ORIGINS and are strictly validated', () => {
  assert.deepEqual(parseConfig('').allowedOrigins, ['http://localhost:3000']);
  assert.deepEqual(parseConfig('DEV_CORS_ORIGINS=   ').allowedOrigins, ['http://localhost:3000']);
  assert.deepEqual(parseConfig('DEV_CORS_ORIGINS=http://localhost:3100').allowedOrigins, ['http://localhost:3000', 'http://localhost:3100']);
  assert.deepEqual(parseConfig('DEV_CORS_ORIGINS=http://localhost:3100, http://localhost:3200').allowedOrigins, ['http://localhost:3000', 'http://localhost:3100', 'http://localhost:3200']);
  for (const bad of ['*', 'https://localhost:3100', 'http://127.0.0.1:3100', 'http://example.com', 'http://localhost:3100/', 'http://localhost:3100,', 'http://localhost:3100,*']) {
    assert.throws(() => parseConfig(`DEV_CORS_ORIGINS=${bad}`), /Invalid development CORS origin/, bad);
  }
});
test('CORS: development permits both localhost origins and keeps unrelated origins disallowed', async () => {
  const allowedOrigins = parseConfig('DEV_CORS_ORIGINS=http://localhost:3100').allowedOrigins;
  await withServer(async url => {
    for (const origin of ['http://localhost:3000', 'http://localhost:3100']) {
      const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(preflight.headers.get('Vary'), 'Origin');
      assert.match(preflight.headers.get('Access-Control-Expose-Headers')!, /X-Clip-Mode/);
    }
    for (const origin of ['https://unrelated.example', 'http://localhost:3200', 'http://127.0.0.1:3100']) {
      assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } })).headers.get('Access-Control-Allow-Origin'), null, origin);
    }
  }, { allowedOrigins });
});
test('CORS: production configuration does not newly permit localhost:3100', async () => {
  const allowedOrigins = parseConfig('').allowedOrigins;
  await withServer(async url => {
    assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } })).headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
    assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3100' } })).headers.get('Access-Control-Allow-Origin'), null);
  }, { allowedOrigins });
});
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
  assert.equal(find('earning per share diluted', '2026-Q3')[0]!.money!.cents, 507n); // per-share rows ignore the millions header
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
    assert.match(finding.explanation, quote.includes('expect') ? /Subjective statement, not verifiable from the proof/ : /forward-looking, not verifiable against reported results/);
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
  assert.equal(state.calls, 1); assert.equal(hit.findings[0]!.decision, 'NEEDS_REVIEW');
  const weak = await callCheck('The office was great.', [{ type: 'text', quote: 'The office was great.' }], proof, jev);
  assert.equal(state.calls, 1); assert.equal(weak.findings[0]!.decision, 'NEEDS_REVIEW');
});

test('claim quality: names, headings, document titles and topic fragments never reach Jev', async () => {
  const fragments = ['Alex Rowan Chief Financial Officer, Example Bank', 'the impact of higher rates on trading',
    'Annual Report on Form 10-K for the year ended December 31, 2027', 'Q3 2028 Financial Results',
    'Prepared Remarks', 'up 4% year-on-year', 'opened in May', 'about the office that was opened', 'The office was', 'The company will'];
  const quote = 'The Denver office opened in May.';
  const input = source([...fragments, quote].join('\n'));
  const { claude, requests } = claudeStub([{ claims: [...fragments, quote].map(quote => ({ type: 'text', quote })) }]);
  const notes: ExtractionNote[] = [];
  let calls = 0;
  const result = await checkClaims([input], [source(quote, 'proof.txt')], { async ask() {
    calls++; return { probability: 0.1, mocked: false };
  } }, { claude, extractor: createClaimExtractor(claude, note => notes.push(note)) });
  assert.equal(calls, 1); assert.equal(requests.length, 1, 'low-support reason skips explanation');
  assert.equal(notes[0]!.non_claims, fragments.length);
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0]!.decision, 'NEEDS_REVIEW');
  assert.match(result.findings[0]!.explanation, /Jev found no support in the proof/);
  assert.match(requests[0]!.system, /complete checkable statements/);
  // The checker also applies the gate to injected/fallback extraction paths.
  const bypass = await checkClaims([input], [source(input.text)], neverJev, {
    extractor: async () => ({ claims: fragments.map(quote => ({ metric: 'text', quote, source: input, period: null, money: null })), mocked: false }),
  });
  assert.deepEqual(bypass.findings, []);
});

test('Jev: only complete assertions can get YES; low scores never set NO', async () => {
  const quote = 'The Denver office opened in May.';
  for (const probability of [0.06, 0.2, 0.5, 0.79999, 0.8, 0.99]) {
    const { claude } = claudeStub([{ claims: [{ type: 'text', quote }] }, { explanation: 'The quotes state that the office opened.' }]);
    const result = await checkClaims([source(quote)], [source(quote)], { async ask() { return { probability, mocked: false }; } }, { claude });
    const finding = result.findings[0]!;
    assert.equal(finding.decision, probability >= 0.8 ? 'YES' : 'NEEDS_REVIEW');
    assert.equal(finding.jev_probability, probability);
    if (probability < 0.8) assert.match(finding.explanation, /^Jev found no support in the proof/);
  }
  assert.equal(completeAssertion('Revenue of $62.7 billion'), false);
  assert.equal(checkableClaim('Revenue of $62.7 billion'), true);
});

test('middle-of-chunk claims: local USD, heading period and per-share scale survive comparative and foreign context', async () => {
  const quotes = ['Revenue of $62.7 billion', 'net income of US$18.6 billion', 'EPS of $6.43'];
  const text = 'Example Bank Q3 2028 earnings call\nCurrency: EUR\n'
    + 'We reported net income of $9.1 billion in Q2 2028 and $8.2 billion in Q3 2027.\n'
    + '($ in millions, except per share data)\n\n' + 'Opening discussion about operations. '.repeat(230)
    + `\nOur European unit settles fees in euros. ${quotes.join(', ')}.\n` + 'Closing discussion. '.repeat(180);
  const chunks = splitChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(text.indexOf(quotes[0]!) > 6000);
  for (const alias of ['3Q28', '3Q 2028', 'third quarter']) {
    const proof = `Example Bank FY2028 results\n($ in millions, except per share data)\n${alias}\nNet revenue 62,700\nNet income 18,600\nDiluted earnings per share $6.43\n\nThe overseas team paid fees in euros.`;
    const { claude } = chunkClaude(chunk => ({ claims: quotes.filter(quote => chunk.includes(quote)).map(quote => ({
      type: 'money', quote, amount: /(?:US)?\$[\d.]+(?: billion)?/.exec(quote)![0], unit: 'USD', period: '3Q28',
    })) }));
    const extraction = await createClaimExtractor(claude, () => {})(source(text, 'invented-call.txt'));
    assert.deepEqual(extraction.claims.map(claim => claim.period), ['2028-Q3', '2028-Q3', '2028-Q3']);
    assert.deepEqual(extraction.claims.map(claim => claim.money?.cents), [6270000000000n, 1860000000000n, 643n]);
    const result = await checkClaims([source(text, 'invented-call.txt')], [source(proof, 'invented-release.txt')], neverJev,
      { claude, extractor: async () => extraction });
    assert.equal(result.period, '2028-Q3');
    assert.deepEqual(result.findings.map(f => f.decision), ['YES', 'YES', 'YES'], alias);
    assert.ok(result.findings.every(f => !f.mocked && f.gap_usd === '0.00'));
  }
});

test('currency boundaries: USD tables survive unrelated foreign paragraphs/tables; same-table and same-sentence mixes fail closed', async () => {
  const quote = 'Revenue of $62.7 billion';
  const run = async (proof: string, claim = quote, prefix = 'Example Bank Q3 2028 earnings call\n') => {
    const { claude } = chunkClaude(() => ({ claims: [{ type: 'money', quote: claim, amount: /\$[\d.]+(?: billion)?/.exec(claim)![0], unit: '', period: '' }] }));
    return (await checkClaims([source(`${prefix}${claim}.`)], [source(proof)], neverJev, { claude })).findings[0]!;
  };
  const usd = 'Example Bank Q3 2028 results\n($ in millions)\nNet revenue 62,700';
  assert.equal((await run(usd, quote, 'Example Bank Q3 2028 earnings call\nWe settle fees in euros.\n')).decision, 'YES');
  assert.equal((await run(`${usd}\n\nWe settle fees in euros.`)).decision, 'YES');
  assert.equal((await run('Example Bank Q3 2028 results\nWe settle fees in euros.\nNet revenue $62.7 billion')).decision, 'YES');
  assert.equal((await run(`${usd}\n\n(euros in millions)\nOverseas cost 200`)).decision, 'YES');
  const foreign = await run('Example Bank Q3 2028 results\n(\u20ac in millions)\nNet revenue 62,700');
  assert.equal(foreign.decision, 'NEEDS_REVIEW'); assert.equal(foreign.proof_usd, null);
  assert.match(foreign.explanation, /not clearly in US dollars/);
  const tableMix = await run(`${usd}\nOverseas fees EUR 200`);
  assert.equal(tableMix.decision, 'NEEDS_REVIEW'); assert.equal(tableMix.proof_usd, null);
  const sentenceMix = await run(usd, quote, 'Example Bank Q3 2028 earnings call\nFees were paid in euros and we reported ');
  assert.equal(sentenceMix.decision, 'NEEDS_REVIEW'); assert.equal(sentenceMix.claimed_usd, null);
});

test('currency: a "$100 million" claim against "€100 million" proof is NEEDS_REVIEW, not YES, and never reaches Jev', async () => {
  const { jev, state } = countingJev();
  const claim = 'Revenue for Q3 2026 was $100 million';
  for (const proof of ['Q3 2026\nRevenue was €100 million', 'Q3 2026\nRevenue was 100 million euros', 'Q3 2026\nRevenue was EUR 100 million',
    'Q3 2026\nRevenue was 100 million', 'Q3 2026\n(€ in millions)\nNet revenue 100', 'Q3 2026\nNet revenue 100 million', 'Revenue was €100 million']) {
    const result = await callCheck(`${claim}.`, [moneyClaim(claim, '$100 million', 'Q3 2026')], proof, jev);
    const finding = result.findings[0]!;
    assert.equal(finding.decision, 'NEEDS_REVIEW', proof); assert.equal(finding.jev_probability, null);
    assert.equal(finding.proof_usd, null); assert.equal(finding.gap_usd, null);
  }
  const euro = await callCheck(`${claim}.`, [moneyClaim(claim, '$100 million', 'Q3 2026')], 'Q3 2026\nRevenue was €100 million', jev);
  assert.match(euro.findings[0]!.explanation, /not clearly in US dollars/);
  assert.equal(state.calls, 0);
  // Clear USD markers still compare: $, US$, USD, and a "$ in millions" heading.
  for (const proof of ['Q3 2026\nRevenue was $100 million', 'Q3 2026\nRevenue was US$100 million', 'Q3 2026\nRevenue was USD 100 million',
    'Q3 2026\n($ in millions)\nNet revenue 100']) {
    const result = await callCheck(`${claim}.`, [moneyClaim(claim, '$100 million', 'Q3 2026')], proof, jev);
    assert.equal(result.findings[0]!.decision, 'YES', proof);
  }
});

test('per-share rows are never scaled by the table heading; an unclear unit fails closed', async () => {
  const table = 'Q3 2026 results\n($ in millions, except per share data)\nEarnings per common share 5.07';
  const claim = 'Earnings per common share was $5.07 in Q3 2026';
  const { jev, state } = countingJev();
  const yes = await callCheck(`${claim}.`, [moneyClaim(claim, '$5.07', 'Q3 2026')], table, jev);
  assert.equal(yes.findings[0]!.decision, 'YES'); assert.equal(yes.findings[0]!.proof_usd, '5.07'); assert.equal(yes.findings[0]!.gap_usd, '0.00');
  for (const label of ['Earnings per diluted share', 'Earnings per basic share', 'Earnings per share', 'EPS', 'Diluted EPS']) {
    const figure = filingFigures(source(`Q3 2026 results\n($ in millions)\n${label} 5.07`))[0]!;
    assert.equal(figure.money!.cents, 507n, label); assert.equal(figure.unitUnclear, false, label);
  }
  const other = 'Profit per employee was $5.07 in Q3 2026';
  const review = await callCheck(`${other}.`, [moneyClaim(other, '$5.07', 'Q3 2026')], 'Q3 2026 results\n($ in millions)\nProfit per employee 5.07', jev);
  assert.equal(review.findings[0]!.decision, 'NEEDS_REVIEW'); assert.match(review.findings[0]!.explanation, /unit that cannot be told/);
  assert.equal(state.calls, 0);
});

// ---- PDF-style tables (hand-made fixture mimicking pdf-parse output: tab cells, "$" in its own cell) ----------
const pdfRelease = [
  'Example Corp. Reports Third-Quarter 2026 Net Income of $12.4 Billion',
  'EXAMPLE CORP (EXC)',
  'Results for EXC',
  '($ millions, except per share data)\t3Q26\t2Q26\t3Q25\t$ O/(U)\tO/(U) %',
  'Net revenue - reported\t$ 47,310\t$ 49,020\t$ 44,870\t$ (1,710)\t(3)%',
  'Net revenue - managed\t47,886\t49,610\t45,432\t(1,724)\t(12)',
  'Net income\t$ 12,418\t$ 13,902\t$ 11,276\t$ (1,484)\t(11)%',
  'Earnings per share - diluted\t$ \t4.31\t$ \t4.88\t$ \t3.92\t$ \t(0.57)\t(11)%',
  'Return on tangible common equity\t18 %\t21 %\t18 %',
  'RETAIL BANKING (RTL)',
  'Results for RTL',
  '($ millions)\t3Q26\t2Q26\t3Q25\t$ O/(U)\tO/(U) %',
  'Net revenue\t$ 18,460\t$ 17,905\t$ 17,120\t$ 555\t3 %',
  'Net income\t$ 4,930\t$ 4,712\t$ 4,410\t$ 218\t5 %',
].join('\n');
const cases = (text: string, quotes: string[], types: string[] = []) => quotes.map((quote, index) => types[index] === 'text'
  ? { type: 'text', quote } : { type: 'money', quote, amount: /\$?[\d.]+(?: billion)?/.exec(quote.slice(quote.search(/[$\d]/)))![0], unit: '', period: '' }).filter(claim => text.includes(claim.quote));

test('PDF tables: tab cells, "$" cells, parentheses and percent cells are read; revenue matches a row by amount', async () => {
  const figures = filingFigures(source(pdfRelease, 'release.pdf'));
  const pick = (key: string, period: string, section: string | null) => figures.filter(f => f.key === key && f.period === period && f.section === section);
  assert.deepEqual(pick('revenue', '2026-Q3', 'EXAMPLE CORP (EXC)').map(f => [f.basis, f.money!.cents]),
    [['reported', 4731000000000n], ['managed', 4788600000000n]]);
  assert.equal(pick('earning per share diluted', '2025-Q3', 'EXAMPLE CORP (EXC)')[0]!.money!.cents, 392n);
  assert.equal(pick('return on tangible common equity', '2026-Q3', 'EXAMPLE CORP (EXC)')[0]!.percent!.value, 180000n);
  assert.equal(pick('net income', '2026-Q3', 'RETAIL BANKING (RTL)')[0]!.firmwide, false);
  assert.ok(figures.every(f => f.currency === 'USD' && f.period !== null));
  const { jev, state } = countingJev();
  const managed = 'Revenue of $47.9 billion in the third quarter';
  const result = await callCheck(`${managed}.`, [moneyClaim(managed, '$47.9 billion')], pdfRelease, jev);
  assert.equal(result.findings[0]!.decision, 'YES'); assert.equal(result.findings[0]!.proof_usd, '47886000000.00');
  const reported = 'reported revenue of $47.3 billion in the third quarter';
  assert.equal((await callCheck(`${reported}.`, [moneyClaim(reported, '$47.3 billion')], pdfRelease, jev)).findings[0]!.decision, 'YES');
  // Equal to neither basis: unsettled, never a guessed NO.
  const neither = 'Revenue of $45.0 billion in the third quarter';
  const unsettled = await callCheck(`${neither}.`, [moneyClaim(neither, '$45.0 billion')], pdfRelease, jev);
  assert.equal(unsettled.findings[0]!.decision, 'NEEDS_REVIEW'); assert.match(unsettled.findings[0]!.explanation, /reported and managed/);
  assert.equal(state.calls, 0);
});

test('aliases: EPS, total net revenue, managed revenue and ROTCE find their table rows', async () => {
  const text = 'The Firm delivered net income of $12.4 billion, EPS of $4.31, and an ROTCE of 18% in the third quarter.';
  const quotes = ['net income of $12.4 billion', 'EPS of $4.31', 'ROTCE of 18%'];
  const { claude, requests } = claudeStub([{ claims: [moneyClaim(quotes[0]!, '$12.4 billion', ''), moneyClaim(quotes[1]!, '$4.31', ''), { type: 'text', quote: quotes[2] }] }]);
  const { jev, state } = countingJev();
  const result = await checkClaims([source(callHeader + text, 'call.txt')], [source(pdfRelease, 'release.pdf')], jev, { claude });
  assertResponse(result);
  assert.deepEqual(result.findings.map(f => f.decision), ['YES', 'YES', 'YES']);
  assert.equal(result.findings.find(f => f.claim === quotes[1])!.proof_usd, '4.31');
  assert.match(requests[0]!.system, /one metric and one number per claim/); assert.match(requests[0]!.system, /EPS of \$5\.57/);
  assert.equal(state.calls, 0);
  for (const phrase of ['total net revenue of $47.9 billion', 'managed revenue of $47.9 billion']) {
    const alias = await callCheck(`We posted ${phrase} in the third quarter.`, [moneyClaim(phrase, '$47.9 billion', '')], pdfRelease, jev);
    assert.equal(alias.findings[0]!.decision, 'YES', phrase);
  }
});

test('compound claims: a level and its change are split; only the level is checked, the change needs review', async () => {
  const compound = 'Revenue of $47.9 billion, up 3% year-on-year';
  const { jev, state } = countingJev();
  const result = await callCheck(`${compound}.`, [moneyClaim(compound, '$47.9 billion', '')], pdfRelease, jev);
  assert.equal(result.findings.length, 1);
  const level = result.findings.find(f => f.claim === 'Revenue of $47.9 billion')!;
  assert.equal(level.decision, 'YES');
  assert.equal(result.findings.some(f => f.claim === 'up 3% year-on-year'), false, 'subjectless fragment is dropped');
  // A quote Claude adds that is not in the source is dropped by code, as before.
  const dropped = await callCheck('Revenue of $47.9 billion in the third quarter.', [moneyClaim('Revenue of $47.9 billion in Q3', '$47.9 billion', ''),
    moneyClaim('Revenue of $47.9 billion in the third quarter', '$47.9 billion', '')], pdfRelease, jev);
  assert.equal(dropped.findings.length, 1);
  // Change claims are never compared with a level, even when the number happens to equal one.
  for (const quote of ['Revenue was up 3% year-on-year', 'Net income rose 5%', 'Revenue increased by $1.7 billion']) {
    const claim = /\$/.test(quote) ? moneyClaim(quote, '$1.7 billion', '') : { type: 'text', quote };
    const review = await callCheck(`${quote}.`, [claim], pdfRelease, jev);
    assert.equal(review.findings[0]!.decision, 'NEEDS_REVIEW', quote); assert.match(review.findings[0]!.explanation, /change/, quote);
  }
  assert.equal(state.calls, 0);
});

test('segments: a claim that names no segment never becomes a NO from a segment figure, and a named segment uses its own table', async () => {
  const { jev, state } = countingJev();
  const segmentAmount = 'net income of $4.9 billion in the third quarter';
  const unnamed = await callCheck(`We had ${segmentAmount}.`, [moneyClaim(segmentAmount, '$4.9 billion', '')], pdfRelease, jev);
  assert.equal(unnamed.findings[0]!.decision, 'NEEDS_REVIEW'); assert.match(unnamed.findings[0]!.explanation, /different section/);
  const named = 'RTL net income of $4.9 billion in the third quarter';
  assert.equal((await callCheck(`${named}.`, [moneyClaim(named, '$4.9 billion', '')], pdfRelease, jev)).findings[0]!.decision, 'YES');
  const wrong = 'net income of $11.0 billion in the third quarter';
  const no = await callCheck(`We had ${wrong}.`, [moneyClaim(wrong, '$11.0 billion', '')], pdfRelease, jev);
  assert.equal(no.findings[0]!.decision, 'NO'); assert.equal(no.findings[0]!.proof_usd, '12418000000.00');
  assert.equal(state.calls, 0);
});

test('currency per section: a USD heading with bare numbers is compared in code; euro, mixed or no evidence stays NEEDS_REVIEW', async () => {
  const claim = 'Revenue of $47.9 billion in the third quarter';
  const { jev, state } = countingJev();
  const run = async (proof: string, quote = claim, amount = '$47.9 billion') =>
    (await callCheck(`${quote}.`, [moneyClaim(quote, amount, '')], proof, jev)).findings[0]!;
  const usdHeading = 'Third-quarter 2026\n($ in millions)\nNet revenue 47,886\nNet income 12,418';
  assert.equal((await run(usdHeading)).decision, 'YES');
  const no = await run(usdHeading, 'Revenue of $55.0 billion in the third quarter', '$55.0 billion');
  assert.equal(no.decision, 'NO'); assert.equal(no.gap_usd, '7114000000.00');
  assert.equal((await run('Third-quarter 2026\nin millions of dollars\nNet revenue 47,886')).decision, 'YES');
  assert.equal((await run('Third-quarter 2026\nAll amounts in USD millions\nNet revenue 47,886')).decision, 'YES');
  for (const proof of ['Third-quarter 2026\n(€ in millions)\nNet revenue 47,886',
    'Third-quarter 2026\n(in millions of euros)\nNet revenue 47,886',
    'Third-quarter 2026\n($ in millions)\nNet revenue 47,886\nOf which €2 million is FX', // two currencies in one section
    'Third-quarter 2026\n(GBP in millions)\n($ in millions)\nNet revenue 47,886',
    'Third-quarter 2026\nNet revenue 47,886', // no currency evidence at all
  ]) {
    const finding = await run(proof);
    assert.equal(finding.decision, 'NEEDS_REVIEW', proof); assert.equal(finding.proof_usd, null, proof); assert.equal(finding.jev_probability, null);
  }
  // A euro section elsewhere does not poison a USD section.
  assert.equal((await run('Third-quarter 2026\n($ in millions)\nNet revenue 47,886\nEURO AREA (EUR)\n(€ in millions)\nNet revenue 40,000')).decision, 'YES');
  assert.equal(state.calls, 0);
});

test('claim currency: a bare amount takes USD from a $ elsewhere in the source; any other currency marker keeps it NEEDS_REVIEW', async () => {
  const bare = 'Revenue was 47.9 billion for the quarter';
  const run = async (callText: string) => {
    const { claude } = claudeStub([{ claims: [{ type: 'text', quote: bare }] }]);
    const result = await checkClaims([source(`${callHeader}${callText}`, 'call.txt')], [source(pdfRelease, 'release.pdf')], neverJev, { claude });
    assertResponse(result); return result.findings[0]!;
  };
  const usd = await run(`Net income was $12.4 billion.\n${bare}.`);
  assert.equal(usd.decision, 'YES'); assert.equal(usd.claimed_usd, '47900000000.00');
  const mixed = await run(`Net income was $12.4 billion and Europe added €2 billion.\n${bare}.`);
  assert.equal(mixed.decision, 'NEEDS_REVIEW'); assert.equal(mixed.claimed_usd, null); assert.match(mixed.explanation, /could not be read safely as US dollars/);
  const none = await run(`${bare}.`);
  assert.equal(none.decision, 'NEEDS_REVIEW'); assert.equal(none.claimed_usd, null);
});

// ---- One validation for every evidence path (inline/legacy matches and table/prose figures) -------------------
const evidencePaths = [{ name: 'legacy path only', legacy: true, filing: false }, { name: 'figure path only', legacy: false, filing: true },
  { name: 'both paths', legacy: true, filing: true }] as const;
async function pathCheck(path: (typeof evidencePaths)[number], claim: string, claimedAmount: string, proof: string, jev: Jev, period = 'Q3 2026') {
  const { claude } = claudeStub([{ claims: [moneyClaim(claim, claimedAmount, period)] }]);
  const result = await checkClaims([source(`Example Corp Q3 2026 earnings call\nWe posted ${claim}.`, 'call.txt')], [source(proof, 'proof.txt')], jev,
    { claude, evidence: { legacy: path.legacy, filing: path.filing } });
  assertResponse(result);
  return result.findings[0]!;
}

test('legacy inline matches are placed in their section, basis and currency like any other figure', () => {
  const text = 'Example Corp. Q3 2026 results\nManaged revenue of USD 47.9 billion\nRETAIL BANKING (RTL)\nRevenue of USD 18.5 billion';
  const figures = legacyFigures(source(text, 'proof.txt'));
  assert.deepEqual(figures.map(f => [f.key, f.basis, f.section, f.firmwide, f.currency, f.period]),
    [['revenue', 'managed', null, true, 'USD', '2026-Q3'], ['revenue', null, 'RETAIL BANKING (RTL)', false, 'USD', '2026-Q3']]);
});

for (const path of evidencePaths) {
  test(`reporting basis (${path.name}): a reported-revenue claim whose only match is a managed-revenue row is NEEDS_REVIEW`, async () => {
    const { jev, state } = countingJev();
    const proof = 'Example Corp. Q3 2026 results\nManaged revenue of USD 47.9 billion';
    const reported = await pathCheck(path, 'reported revenue of $47.9 billion', '$47.9 billion', proof, jev);
    assert.equal(reported.decision, 'NEEDS_REVIEW'); assert.equal(reported.label, 'insufficient');
    assert.match(reported.explanation, /different reporting basis/);
    assert.equal(reported.proof_source, null); assert.equal(reported.proof_usd, null); assert.equal(reported.jev_probability, null);
    // The same row supports a claim that says managed, so the row itself is read correctly.
    const managed = await pathCheck(path, 'managed revenue of $47.9 billion', '$47.9 billion', proof, jev);
    assert.equal(managed.decision, 'YES');
    // And the reverse: a managed claim never rests on a reported row.
    const other = await pathCheck(path, 'managed revenue of $47.9 billion', '$47.9 billion', 'Example Corp. Q3 2026 results\nReported revenue of USD 47.9 billion', jev);
    assert.equal(other.decision, 'NEEDS_REVIEW'); assert.match(other.explanation, /different reporting basis/);
    assert.equal(state.calls, 0);
  });

  test(`section (${path.name}): a firmwide revenue claim whose only match is a segment table row is NEEDS_REVIEW`, async () => {
    const { jev, state } = countingJev();
    const proof = 'Example Corp. Q3 2026 results\nRETAIL BANKING (RTL)\nRevenue of USD 18.5 billion';
    const firmwide = await pathCheck(path, 'revenue of $18.5 billion', '$18.5 billion', proof, jev);
    assert.equal(firmwide.decision, 'NEEDS_REVIEW'); assert.match(firmwide.explanation, /different section/);
    assert.equal(firmwide.proof_source, null); assert.equal(firmwide.jev_probability, null);
    // Not a NO either, whatever the amount: a segment figure says nothing about the firm.
    const different = await pathCheck(path, 'revenue of $20.0 billion', '$20.0 billion', proof, jev);
    assert.equal(different.decision, 'NEEDS_REVIEW'); assert.equal(different.gap_usd, null);
    // A claim that names the segment uses the segment's own figure.
    const named = await pathCheck(path, 'RTL revenue of $18.5 billion', '$18.5 billion', proof, jev);
    assert.equal(named.decision, 'YES');
    assert.equal(state.calls, 0);
  });

  test(`currency per section (${path.name}): an unrelated foreign paragraph does not veto USD amounts`, async () => {
    const { jev, state } = countingJev();
    const mixed = await pathCheck(path, 'revenue of $47.9 billion', '$47.9 billion', 'Example Corp. Q3 2026 results\nRevenue of USD 47.9 billion\nFX cost of €2 million', jev);
    assert.equal(mixed.decision, 'YES');
    const clean = await pathCheck(path, 'revenue of $47.9 billion', '$47.9 billion', 'Example Corp. Q3 2026 results\nRevenue of USD 47.9 billion\nFX cost of $2 million', jev);
    assert.equal(clean.decision, 'YES');
    assert.equal(state.calls, 0);
  });
}

// ---- Chunked extraction for long documents, per-chunk fallback, safe diagnostics ---------------------------------
// Stub transport that answers each chunk from its own text, so tests do not depend on request order.
function chunkClaude(respond: (text: string) => unknown) {
  const requests: string[] = [];
  const failures: Record<string, unknown>[] = [];
  const transport: Transport = async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init?.body)) as { max_tokens: number; messages: { content: string }[] };
    const data = JSON.parse(body.messages[0]!.content) as { text?: string };
    if (data.text === undefined) return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"explanation":"The passages state amounts."}' }] });
    assert.equal(body.max_tokens, 4096);
    requests.push(data.text);
    const out = respond(data.text);
    if (out && typeof out === 'object' && 'stop_reason' in out) return Response.json(out);
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
  };
  return { claude: createClaude('test-only-placeholder', transport, note => failures.push(note)), requests, failures };
}
const filler = 'We continue to invest across the franchise and see healthy client activity in every region. '.repeat(22);
const turnQuote = (index: number) => `Revenue USD ${index + 1}00.00`;
const longCall = 'Example Corp Q3 2026 earnings call\n\n'
  + Array.from({ length: 8 }, (_, index) => `Speaker ${index + 1}:\n${filler}${turnQuote(index)} for the quarter.\n\n`).join('');
const quotesIn = (text: string) => Array.from({ length: 8 }, (_, index) => turnQuote(index)).filter(quote => text.includes(quote))
  .map(quote => ({ type: 'money', quote, amount: /[\d.]+$/.exec(quote)![0], unit: 'USD', period: '' }));

test('chunking: a long transcript is split on paragraph/speaker boundaries, read chunk by chunk and merged in order', async () => {
  const chunks = splitChunks(longCall);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  assert.equal(chunks.map(chunk => chunk.text).join(''), longCall);
  assert.ok(chunks.every(chunk => chunk.text.length <= 6000 && longCall.slice(chunk.start, chunk.end) === chunk.text));
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.text.endsWith('\n\n')), 'chunks end on a blank line between speaker turns');
  assert.deepEqual(splitChunks('short text'), [{ start: 0, end: 10, text: 'short text' }]);
  const { claude, requests, failures } = chunkClaude(text => ({ claims: quotesIn(text) }));
  const notes: ExtractionNote[] = [];
  const result = await createClaimExtractor(claude, note => notes.push(note))(source(longCall, 'call.txt'));
  assert.equal(requests.length, chunks.length); assert.ok(requests.every(text => text.length <= 6000));
  assert.equal(result.mocked, false);
  assert.deepEqual(result.claims.map(claim => claim.quote), Array.from({ length: 8 }, (_, index) => turnQuote(index)));
  assert.ok(result.claims.every(claim => claim.mocked !== true && longCall.slice(claim.offset!, claim.offset! + claim.quote.length) === claim.quote));
  // Amounts are still read against the full source: the heading above the first chunk dates every claim.
  assert.ok(result.claims.every(claim => claim.period === '2026-Q3' && claim.money !== null));
  assert.deepEqual(notes, [{ dropped_claims: 0, chunks: chunks.length, failed_chunks: 0, claims_returned: 8, duplicates: 0, fallback_claims: 0, kept_claims: 8, capped: 0 }]);
  assert.deepEqual(failures, []);
});

test('chunking: a refused chunk falls back to regex for that chunk only; only its findings are mocked; logs carry no text', async () => {
  const chunks = splitChunks(longCall);
  const broken = chunks.findIndex(chunk => chunk.text.includes(turnQuote(3)));
  const { claude, requests, failures } = chunkClaude(text => text === chunks[broken]!.text
    ? { stop_reason: 'refusal', content: [{ type: 'text', text: '' }] } : { claims: quotesIn(text) });
  const notes: ExtractionNote[] = [];
  const result = await createClaimExtractor(claude, note => notes.push(note))(source(longCall, 'call.txt'));
  assert.equal(requests.length, chunks.length + 1, 'the failing chunk is retried once');
  assert.equal(result.mocked, false);
  assert.deepEqual(result.claims.map(claim => claim.quote), Array.from({ length: 8 }, (_, index) => turnQuote(index)));
  const fallbackQuotes = quotesIn(chunks[broken]!.text).map(claim => claim.quote);
  for (const claim of result.claims) assert.equal(claim.mocked === true, fallbackQuotes.includes(claim.quote), claim.quote);
  assert.deepEqual(failures, [1, 2].map(attempt => ({ event: 'claude_attempt_failed', label: `extract ${broken + 1}/${chunks.length}`, attempt,
    reason: 'stop_reason', stop_reason: 'refusal' })));
  assert.equal(notes[0]!.failed_chunks, 1); assert.equal(notes[0]!.fallback_claims, fallbackQuotes.length);
  assert.ok(!/franchise|Revenue|placeholder/.test(JSON.stringify([failures, notes])), 'diagnostics never contain document text or keys');
  // Through the checker: only findings from the failed chunk are marked mocked.
  const checked = await checkClaims([source(longCall, 'call.txt')], [source('Unrelated text.', 'proof.txt')], neverJev,
    { claude, extractor: createClaimExtractor(claude, () => {}) });
  assertResponse(checked);
  for (const finding of checked.findings) assert.equal(finding.mocked, fallbackQuotes.includes(finding.claim), finding.claim);
  // Every chunk failing still falls back for the whole document, exactly as before.
  const allBad = chunkClaude(() => 'not JSON');
  const whole = await createClaimExtractor(allBad.claude, () => {})(source(longCall, 'call.txt'));
  assert.equal(whole.mocked, true); assert.deepEqual(whole.claims, extractClaims(source(longCall, 'call.txt')));
});

test('chunking: an invalid claim is dropped alone with only field paths and counts logged', async () => {
  const chunks = splitChunks(longCall);
  const { claude, failures } = chunkClaude(text => text === chunks[0]!.text
    ? { claims: [...quotesIn(text), { type: 'money', quote: 'private invalid claim', unit: 'USD', period: '' }] } : { claims: quotesIn(text) });
  const notes: ExtractionNote[] = [];
  const result = await createClaimExtractor(claude, note => notes.push(note))(source(longCall, 'call.txt'));
  assert.equal(result.claims.length, 8);
  assert.deepEqual(failures, []);
  assert.equal(notes[0]!.invalid_claims, 1);
  assert.deepEqual(notes[0]!.invalid_fields, [`chunks.0.claims.${quotesIn(chunks[0]!.text).length}.amount`]);
  assert.ok(!JSON.stringify(notes).includes('private'));
});

test('claims: unknown keys are stripped before grounding and never reach findings', async () => {
  const quote = 'Revenue USD 100.00';
  const raw = { type: 'money', quote, amount: '100.00', unit: 'USD', period: '', decision: 'NO', secretExtra: 'private extra' };
  assert.deepEqual(claimSchema.parse(raw), { type: 'money', quote, amount: '100.00', unit: 'USD', period: '' });
  const { claude, requests } = claudeStub([{ claims: [raw, { type: 'text', quote: 'invented', extra: 'private extra' }] },
    { explanation: 'The passages agree.' }]);
  const notes: ExtractionNote[] = [];
  const result = await checkClaims([source(quote)], [source('revenue,100.00', 'proof.csv')], neverJev,
    { claude, extractor: createClaimExtractor(claude, note => notes.push(note)) });
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0]!.decision, 'YES');
  assert.equal(result.findings[0]!.mocked, false); assert.equal(requests.length, 2);
  assert.equal(notes[0]!.dropped_claims, 1);
  assert.ok(!/secretExtra|private extra/.test(JSON.stringify([result, notes])));
});

test('chunking: truncation splits into halves and retries with full-source periods and order', async () => {
  const text = `Q3 2026\n${turnQuote(0)}\n${' '.repeat(100)}\n${turnQuote(1)}`;
  const { claude, requests, failures } = chunkClaude(chunk => chunk === text
    ? { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'private partial JSON' }] }
    : { claims: quotesIn(chunk) });
  const notes: ExtractionNote[] = [];
  const result = await createClaimExtractor(claude, note => notes.push(note))(source(text));
  assert.equal(requests.length, 3);
  assert.equal(requests.slice(1).join(''), text);
  assert.ok(requests.slice(1).every(part => part.length <= Math.ceil(text.length / 2)));
  assert.deepEqual(result.claims.map(claim => claim.quote), [turnQuote(0), turnQuote(1)]);
  assert.ok(result.claims.every(claim => claim.period === '2026-Q3' && claim.money !== null && !claim.mocked));
  assert.equal(result.mocked, false); assert.equal(notes[0]!.split_chunks, 1); assert.equal(notes[0]!.failed_chunks, 0);
  assert.deepEqual(failures, [{ event: 'claude_attempt_failed', label: 'extract 1/1', attempt: 1, reason: 'stop_reason', stop_reason: 'max_tokens' }]);
  assert.ok(!JSON.stringify([notes, failures]).includes('private'));
});

test('chunking: three worker slots include 429 backoff and retries', async () => {
  let active = 0; let peak = 0; let calls = 0; let waits = 0;
  const attempts = new Map<string, number>();
  const claude = createClaude('test-only-placeholder', async (_url, init) => {
    calls++; active++; peak = Math.max(peak, active);
    const text = JSON.parse(JSON.parse(String(init?.body)).messages[0].content).text as string;
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    const attempt = (attempts.get(text) ?? 0) + 1; attempts.set(text, attempt);
    if (attempt === 1) return new Response(null, { status: 429 });
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ claims: quotesIn(text) }) }] });
  }, () => {}, async milliseconds => { waits++; assert.equal(milliseconds, 500); await new Promise<void>(resolve => setImmediate(resolve)); });
  const result = await createClaimExtractor(claude, () => {})(source(longCall));
  assert.equal(peak, 3); assert.equal(waits, splitChunks(longCall).length); assert.equal(calls, waits * 2);
  assert.equal(result.claims.length, 8); assert.equal(result.mocked, false);
});

test('chunking: a quote returned by two chunks is one claim; a quote that truly repeats in the source stays two claims', async () => {
  const repeated = 'Margins were stable.';
  const text = longCall.replace('Speaker 1:\n', `Speaker 1:\n${repeated} `).replace('Speaker 8:\n', `Speaker 8:\n${repeated} `);
  const chunks = splitChunks(text);
  // Every chunk also echoes the first turn's quote, which only appears in the first chunk.
  const { claude } = chunkClaude(chunk => ({ claims: [...quotesIn(chunk), { type: 'money', quote: turnQuote(0), amount: '100.00', unit: 'USD', period: '' },
    ...(chunk.includes(repeated) ? [{ type: 'text', quote: repeated }] : [])] }));
  const notes: ExtractionNote[] = [];
  const result = await createClaimExtractor(claude, note => notes.push(note))(source(text, 'call.txt'));
  assert.equal(result.claims.filter(claim => claim.quote === turnQuote(0)).length, 1);
  // Every later chunk echoes it once, and the first chunk returns it twice (its own and the echo): all collapse to one.
  assert.equal(notes[0]!.duplicates, chunks.length);
  const stable = result.claims.filter(claim => claim.quote === repeated);
  assert.equal(stable.length, 2); assert.notEqual(stable[0]!.offset, stable[1]!.offset);
});

test('Claude diagnostics: HTTP status, timeout, network and JSON failures are logged as codes only', async () => {
  const cases: [string, Transport, Record<string, unknown>][] = [
    ['http', async () => new Response('secret upstream body', { status: 429 }), { reason: 'http_status', status: 429 }],
    ['timeout', async () => { throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); }, { reason: 'timeout' }],
    ['network', async () => { throw new Error('secret upstream'); }, { reason: 'network' }],
    ['json', async () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'secret not json' }] }), { reason: 'json_parse' }],
  ];
  for (const [name, transport, expected] of cases) {
    const notes: Record<string, unknown>[] = [];
    const claude = createClaude('test-only-placeholder', transport, note => notes.push(note));
    assert.equal(await claude.json(claimsSchema, 'x', { text: 'secret document' }, 4096, 'extract 1/1'), null, name);
    assert.deepEqual(notes, [1, 2].map(attempt => ({ event: 'claude_attempt_failed', label: 'extract 1/1', attempt, ...expected })), name);
    assert.ok(!/secret|placeholder/.test(JSON.stringify(notes)), name);
  }
});

test('financial highlights: firmwide rows retain scale, period, per-share and percent units', async () => {
  const proof = [
    'Example Bank Third Quarter 2026 Results',
    'FINANCIAL HIGHLIGHTS',
    '($ millions, except per share data)    3Q26    2Q26    3Q25',
    'Net revenue                            50,900  49,100  48,200',
    'Net income                             15,300  14,100  13,000',
    'Diluted earnings per share             $5.57   $5.12   $4.84',
    'Return on tangible common equity      20%     19%     18%',
    'Provision for credit losses           (700)   200     300',
  ].join('\n');
  const figures = filingFigures(source(proof));
  const first = (key: string) => figures.find(f => f.key === key && f.period === '2026-Q3')!;
  assert.equal(first('net income').money!.cents, 1530000000000n);
  assert.equal(first('earning per share diluted').money!.cents, 557n);
  assert.equal(first('return on tangible common equity').percent!.value, 200000n);
  assert.equal(first('provision for credit loss').money!.cents, -70000000000n);
  assert.ok(figures.every(f => f.firmwide));
  const quotes = ['The Firm delivered net income of $15.3 billion', 'EPS of $5.57', 'an ROTCE of 20%', 'Revenue of $50.9 billion'];
  const { claude } = claudeStub([{ claims: [moneyClaim(quotes[0]!, '$15.3 billion', ''), moneyClaim(quotes[1]!, '$5.57', ''),
    { type: 'text', quote: quotes[2] }, moneyClaim(quotes[3]!, '$50.9 billion', '')] }]);
  const diagnostics: Record<string, number>[] = [];
  const result = await checkClaims([source('Example Bank Q3 2026 earnings call\n' + quotes.join('. ') + '.', 'call.txt')],
    [source(proof, 'highlights.pdf')], neverJev, { claude, diagnostics: counts => diagnostics.push(counts) });
  assert.deepEqual(result.findings.map(f => f.decision), ['YES', 'YES', 'YES', 'YES']);
  assert.equal(result.findings.find(f => f.claim === quotes[1])!.proof_usd, '5.57');
  assert.equal(result.findings.find(f => f.claim === quotes[2])!.claimed_usd, null);
  assert.equal(diagnostics[0]!.money_match, 3);
  assert.equal(diagnostics[0]!.percent_match, 1);
});

test('financial highlights inside a segment do not support a firmwide claim', async () => {
  const proof = [
    'Example Bank Third Quarter 2026 Results',
    'RETAIL BANKING (RTL)',
    'FINANCIAL HIGHLIGHTS',
    '($ millions)    3Q26    2Q26    3Q25',
    'Net revenue     12,300  11,900  11,500',
  ].join('\n');
  const quote = 'Revenue of $12.3 billion';
  const { claude } = claudeStub([{ claims: [moneyClaim(quote, '$12.3 billion', '')] }]);
  const result = await checkClaims([source(`Example Bank Q3 2026 earnings call\n${quote}.`)],
    [source(proof)], neverJev, { claude, diagnostics: () => {} });
  assert.equal(result.findings[0]!.decision, 'NEEDS_REVIEW');
  assert.equal(result.findings[0]!.proof_usd, null);
  assert.match(result.findings[0]!.explanation, /different section/);
  const segmentFigures = filingFigures(source(proof));
  assert.ok(segmentFigures.length > 0);
  assert.ok(segmentFigures.every(figure => !figure.firmwide && figure.section === 'RETAIL BANKING (RTL)'));
});

test('subjective outlook cannot become Jev-only YES, while a named event can', async () => {
  const quote = 'we can redeploy that capital at very good returns over time';
  const named = 'The Firm launched Project Atlas on October 7, 2026';
  const { claude } = claudeStub([{ claims: [{ type: 'text', quote }, { type: 'text', quote: named }] }]);
  let calls = 0;
  const jev: Jev = { async ask() { calls++; return { probability: 0.99, mocked: false }; } };
  const result = await checkClaims([source(`${quote}. ${named}.`)],
    [source('Project Atlas launched on October 7, 2026.')], jev, { claude, diagnostics: () => {} });
  const subjective = result.findings.find(f => f.claim === quote)!;
  assert.equal(subjective.decision, 'NEEDS_REVIEW');
  assert.match(subjective.explanation, /Subjective statement, not verifiable from the proof/);
  assert.equal(subjective.jev_probability, null);
  assert.equal(result.findings.find(f => f.claim === named)!.decision, 'YES');
  assert.equal(calls, 1);
});

// ---- Audio: ElevenLabs timings, no-key behaviour, and the clip route (stubbed services, no live calls) -----------
test('audio: without ELEVENLABS_API_KEY the transcriber is the explicit mock and makes no request', async () => {
  const service = createTranscriber(undefined, async () => assert.fail('No key: nothing may be sent to ElevenLabs.'));
  const result = await service.transcribe(new Blob(['audio']), 'call.mp3');
  assert.equal(result.mocked, true); assert.equal(result.wordTimings, undefined);
  assert.equal(result.segments.length, 3);
});

test('audio: ElevenLabs word timings reach the finding as start_ms and end_ms, with the audio file ID', async () => {
  const requests: string[] = [];
  const transport: Transport = async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init!.headers).get('xi-api-key'), 'test-only-credential');
    return Response.json({ text: 'Revenue USD 1250000.00 for the period.', words: [
      { text: 'Revenue', start: 1.2, end: 1.5, type: 'word', speaker_id: 'speaker_0' },
      { text: 'USD', start: 1.6, end: 1.9, type: 'word', speaker_id: 'speaker_0' },
      { text: '1250000.00', start: 2, end: 2.8, type: 'word', speaker_id: 'speaker_0' },
      { text: 'for', start: 3, end: 3.2, type: 'word', speaker_id: 'speaker_0' },
      { text: 'the', start: 3.2, end: 3.4, type: 'word', speaker_id: 'speaker_0' },
      { text: 'period', start: 3.4, end: 3.9, type: 'word', speaker_id: 'speaker_0' },
    ] });
  };
  const body = new FormData();
  body.set('claims_audio', new File([new Uint8Array([1, 2, 3])], 'call.mp3', { type: 'audio/mpeg' }));
  body.set('proof_files', new File(['revenue,1250000.00'], 'proof.csv', { type: 'text/csv' }));
  const { claims, proofs } = await parseUploads(body, createTranscriber('test-only-credential', transport), async () => 'audio-test-id');
  assert.deepEqual(requests, ['https://api.elevenlabs.io/v1/speech-to-text']);
  // The claim text is the segment text the word timings are measured against, so the offsets line up.
  assert.equal(claims[0]!.text, 'Revenue USD 1250000.00 for the period.');
  const result = await checkClaims(claims, proofs, neverJev, { extract: extractClaims });
  assertResponse(result);
  const finding = result.findings.find(item => item.claim === 'Revenue USD 1250000.00')!;
  assert.ok(finding, 'the revenue claim is found');
  assert.equal(finding.start_ms, 1200); assert.equal(finding.end_ms, 2800);
  assert.equal(finding.audio_file_id, 'audio-test-id');
  assert.equal(finding.decision, 'YES'); assert.equal(finding.claimed_usd, '1250000.00');
  assert.equal(finding.claim_source.timestamp_start, 1.2);
});

test('audio: text findings carry no audio fields (start_ms, end_ms, audio_file_id are absent, not null)', async () => {
  const body = new FormData();
  body.set('claims_text', 'Revenue USD 1250000.00');
  body.set('proof_files', new File(['revenue,1250000.00'], 'proof.csv', { type: 'text/csv' }));
  const { claims, proofs } = await parseUploads(body, createMockTranscriber());
  const result = await checkClaims(claims, proofs, neverJev, { extract: extractClaims });
  assertResponse(result);
  assert.equal(result.findings.length, 1);
  assert.ok(!('start_ms' in result.findings[0]!) && !('end_ms' in result.findings[0]!) && !('audio_file_id' in result.findings[0]!));
});

// ---- Clip store: in-memory only, ffmpeg over stdin/stdout, capacity, duration (stubbed; no live services) -------
// Tiny valid recordings built in memory.
function wavBytes(ms: number, marker = ''): Buffer {
  const data = Buffer.alloc(ms * 16); // 8 kHz mono 16-bit: 16 bytes per millisecond
  data.write(marker, 0, 'latin1');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1'); header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function mp3Bytes(frames: number): Buffer { // MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames of 1152 samples
  const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
function mp4Box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(8 + body.length, 0); header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}
function m4aBytes(ms: number): Buffer {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(ms, 16);
  return Buffer.concat([mp4Box('ftyp', Buffer.from('M4A \0\0\0\0M4A isom', 'latin1')), mp4Box('moov', mp4Box('mvhd', mvhd))]);
}
const audioFile = (bytes: Buffer, name: string) => new File([new Uint8Array(bytes)], name);
// A stand-in for the ffmpeg process: records what it was given on stdin and answers on stdout.
function fakeFfmpeg(behaviour: { output?: Buffer; code?: number; error?: string } = {}) {
  const calls: { command: string; args: string[]; options: unknown; stdin: Buffer[] }[] = [];
  const spawnProcess = ((command: string, args: string[], options: unknown) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
    const call = { command, args, options, stdin: [] as Buffer[] }; calls.push(call);
    if (behaviour.error) { setImmediate(() => child.emit('error', Object.assign(new Error('spawn'), { code: behaviour.error }))); return child; }
    child.stdin.on('data', (chunk: Buffer) => call.stdin.push(chunk));
    child.stdin.on('end', () => setImmediate(() => { if (behaviour.output) child.stdout.write(behaviour.output); child.stdout.end(); child.emit('close', behaviour.code ?? 0); }));
    return child;
  }) as unknown as Spawn;
  return { spawnProcess, calls };
}
const query = (id: string | null, start: number, end: number) => new URLSearchParams(`file=${id}&start_ms=${start}&end_ms=${end}`);

test('duration: read from the WAV, MP3 and M4A containers in memory; anything else is unreadable', () => {
  assert.equal(recordingDurationMs(wavBytes(1500), 'wav'), 1500);
  assert.equal(recordingDurationMs(mp3Bytes(100), 'mp3'), 2612); // 100 x 1152 / 44100 s
  assert.equal(recordingDurationMs(Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a', 'latin1'), Buffer.alloc(10), mp3Bytes(100)]), 'mp3'), 2612);
  assert.equal(recordingDurationMs(m4aBytes(3000), 'm4a'), 3000);
  // A WAV that announces more data than it holds counts only what is there.
  const truncated = wavBytes(1000); truncated.writeUInt32LE(0xffffffff, 40);
  assert.equal(recordingDurationMs(truncated, 'wav'), 1000);
  for (const [bytes, extension] of [[Buffer.from('mock audio'), 'm4a'], [Buffer.from('mock audio'), 'mp3'], [Buffer.from('mock audio'), 'wav'],
    [mp3Bytes(2), 'mp3'], [wavBytes(1000).subarray(0, 30), 'wav'], [Buffer.alloc(0), 'mp3']] as const)
    assert.equal(recordingDurationMs(bytes, extension), null, extension);
});

test('clip store: only IDs this store issued are served; paths, traversal and malformed requests are rejected', async () => {
  const store = new AudioStore(async () => Buffer.from('WAV'));
  const id = await store.save(audioFile(wavBytes(5000), 'call.wav'));
  assert.ok(id);
  for (const text of [
    `file=../../api/.env&start_ms=0&end_ms=1000`, `file=..%2F..%2Fsecret&start_ms=0&end_ms=1000`,
    `file=${encodeURIComponent('/etc/passwd')}&start_ms=0&end_ms=1000`, `file=${encodeURIComponent('C:\\Windows\\win.ini')}&start_ms=0&end_ms=1000`,
    `file=00000000-0000-4000-8000-000000000000&start_ms=0&end_ms=1000`, // well-formed, but never issued here
    `file=${id}&file=${id}&start_ms=0&end_ms=1000`, `file=${id}&start_ms=-1&end_ms=1000`, `file=${id}&start_ms=1.5&end_ms=1000`,
    `file=${id}&start_ms=2000&end_ms=2000`, `file=${id}&start_ms=0&end_ms=60001`, `file=${id}&start_ms=0`,
    `file=${id}&start_ms=0&end_ms=1000&path=/etc/passwd`,
  ]) await assert.rejects(store.clip(new URLSearchParams(text)), BadInput, text);
  assert.equal((await store.clip(query(id, 0, 1000))).bytes.toString(), 'WAV');
});

test('clip ranges are checked against the recording duration in both modes, and a range past the end is refused', async () => {
  const original = wavBytes(1500);
  const modes: [string, AudioStore][] = [
    ['ffmpeg segment mode', new AudioStore(async () => Buffer.from('RIFF'))],
    ['whole-file mode (no ffmpeg)', new AudioStore(async () => null)],
    ['whole-file mode (m4a is never piped)', new AudioStore(async () => Buffer.from('RIFF'))],
  ];
  for (const [mode, store] of modes) {
    const id = await store.save(mode.includes('m4a') ? audioFile(m4aBytes(1500), 'call.m4a') : audioFile(original, 'call.wav'));
    assert.ok(id, mode);
    const inside = await store.clip(query(id, 500, 1500)); // ends exactly at the end: allowed
    assert.equal(inside.whole, mode.startsWith('whole'), mode);
    for (const [start, end] of [[500, 1501], [1000, 2500], [1500, 2000], [2000, 3000], [1501, 1502]] as const)
      await assert.rejects(store.clip(query(id, start, end)), (error: unknown) => error instanceof BadInput, `${mode}: ${start}-${end}`);
  }
  // Through HTTP the same refusals are 400 JSON errors.
  const store = new AudioStore(async () => Buffer.from('RIFF'));
  const id = (await store.save(audioFile(original, 'call.wav')))!;
  await withServer(async url => {
    const endpoint = url.replace('/api/check', '/api/clip');
    assert.equal((await fetch(`${endpoint}?file=${id}&start_ms=500&end_ms=1500`)).status, 200);
    for (const range of ['start_ms=500&end_ms=1501', 'start_ms=2000&end_ms=3000']) {
      const refused = await fetch(`${endpoint}?file=${id}&${range}`);
      assert.equal(refused.status, 400, range); assert.equal(typeof ((await refused.json()) as { error?: unknown }).error, 'string');
    }
  }, { audioStore: store, jev: neverJev });
});

test('clip store: never more than 100 recordings, even when far more uploads arrive at once', async () => {
  const store = new AudioStore(async () => null);
  const recording = wavBytes(100);
  const results = await Promise.allSettled(Array.from({ length: 150 }, () => store.save(audioFile(recording, 'call.wav'))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, MAX_RECORDINGS);
  assert.equal(store.size, MAX_RECORDINGS);
  const refused = results.filter(result => result.status === 'rejected');
  assert.equal(refused.length, 50);
  assert.ok(refused.every(result => (result as PromiseRejectedResult).reason instanceof BadInput));
  // Slots claimed by uploads that fail are released, so failures never use up capacity.
  const fresh = new AudioStore(async () => null);
  const unreadable = await Promise.all(Array.from({ length: 150 }, () => fresh.save(audioFile(Buffer.from('mock audio'), 'call.mp3')).catch(() => 'full')));
  assert.equal(unreadable.filter(result => result === null).length, MAX_RECORDINGS, 'the first 100 claimed slots; each was released');
  assert.equal(fresh.size, 0);
  const afterwards = await Promise.allSettled(Array.from({ length: 100 }, () => fresh.save(audioFile(recording, 'call.wav'))));
  assert.ok(afterwards.every(result => result.status === 'fulfilled' && result.value !== null));
  assert.equal(fresh.size, MAX_RECORDINGS);
});

test('ffmpeg renderer: the recording is piped over stdin and read from stdout; nothing is passed as a path', async () => {
  const marker = `marker-${randomBytes(12).toString('hex')}`;
  const recording = wavBytes(5000, marker);
  const fake = fakeFfmpeg({ output: Buffer.from('RIFFCLIP') });
  const store = new AudioStore(createFfmpegRenderer(fake.spawnProcess));
  const id = await store.save(audioFile(recording, 'call.wav'));
  const clip = await store.clip(query(id, 1200, 4500));
  assert.deepEqual([clip.type, clip.whole, clip.bytes.toString()], ['audio/wav', false, 'RIFFCLIP']);
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call!.command, 'ffmpeg');
  assert.deepEqual(Buffer.concat(call!.stdin), recording);
  assert.ok(call!.args.includes('pipe:0') && call!.args.includes('pipe:1'));
  assert.equal(call!.args[call!.args.indexOf('-ss') + 1], '1.2'); assert.equal(call!.args[call!.args.indexOf('-t') + 1], '3.3');
  assert.ok(call!.args.every(argument => !/[\\/]/.test(argument.replace(/^pipe:[01]$/, ''))), 'no argument is a file path');
  assert.ok(!call!.args.join(' ').includes(marker));
  // m4a cannot be read reliably from a pipe, so it is served whole instead of being written to disk.
  const m4a = await store.save(audioFile(m4aBytes(5000), 'call.m4a'));
  const whole = await store.clip(query(m4a, 0, 1000));
  assert.deepEqual([whole.whole, whole.type], [true, 'audio/mp4']); assert.equal(fake.calls.length, 1, 'ffmpeg was not started for m4a');
});

test('ffmpeg renderer: a missing binary means whole-file; failures are generic; empty output is a 400', async () => {
  const recording = wavBytes(5000);
  const missing = new AudioStore(createFfmpegRenderer(fakeFfmpeg({ error: 'ENOENT' }).spawnProcess));
  const whole = await missing.clip(query(await missing.save(audioFile(recording, 'call.wav')), 0, 1000));
  assert.deepEqual([whole.whole, whole.type], [true, 'audio/wav']); assert.deepEqual(whole.bytes, recording);
  const failing = new AudioStore(createFfmpegRenderer(fakeFfmpeg({ output: Buffer.from('x'), code: 1 }).spawnProcess));
  await assert.rejects(failing.clip(query(await failing.save(audioFile(recording, 'call.wav')), 0, 1000)), (error: unknown) => error instanceof Error && !(error instanceof BadInput));
  const silent = new AudioStore(createFfmpegRenderer(fakeFfmpeg({}).spawnProcess));
  await assert.rejects(silent.clip(query(await silent.save(audioFile(recording, 'call.wav')), 0, 1000)), BadInput);
});

test('no temporary file: a render creates nothing under any OS temp directory, and clips.ts has no file-system code', async () => {
  const marker = `marker-${randomBytes(16).toString('hex')}`;
  const directories = [...new Set([tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR, '/tmp'].filter((entry): entry is string => !!entry))];
  const snapshot = async () => {
    const paths = new Map<string, boolean>();
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        paths.set(`${directory}/${entry.name}`, entry.isDirectory());
        if (entry.isDirectory()) for (const inner of await readdir(`${directory}/${entry.name}`, { withFileTypes: true }).catch(() => []))
          paths.set(`${directory}/${entry.name}/${inner.name}`, inner.isDirectory());
      }
    }
    return paths;
  };
  const before = await snapshot();
  const store = new AudioStore(createFfmpegRenderer(fakeFfmpeg({ output: Buffer.from('RIFFCLIP') }).spawnProcess));
  const id = await store.save(audioFile(wavBytes(5000, marker), 'call.wav'));
  await store.clip(query(id, 0, 1000));
  const after = await snapshot();
  const created = [...after].filter(([path, directory]) => !before.has(path) && !directory).map(([path]) => path);
  for (const path of created) {
    const content = await readFile(path).catch(() => Buffer.alloc(0));
    assert.ok(!content.includes(marker), 'the recording was written to a temporary file');
  }
  assert.ok([...after.keys()].every(path => before.has(path) || !/^diligo-/.test(path.split('/').pop()!)), 'no temp entry named for this feature');
  // And structurally: the module cannot write files, because it does not import anything that can.
  const source = await readFile(new URL('../../src/clips.ts', import.meta.url), 'utf8');
  assert.ok(!/node:fs|node:os|mkdtemp|writeFile|createWriteStream|tmpdir|unlink/.test(source), 'clips.ts must not use the file system');
});

test('clip store: ffmpeg output is served as WAV; without ffmpeg the whole recording is served with its offsets', async () => {
  const original = wavBytes(5000);
  const withFfmpeg = new AudioStore(async (input, extension, start, end) => { assert.deepEqual(input, original); assert.equal(extension, 'wav'); assert.equal(start, 1200); assert.equal(end, 4500); return Buffer.from('RIFF'); });
  const rendered = await withFfmpeg.clip(query(await withFfmpeg.save(audioFile(original, 'call.wav')), 1200, 4500));
  assert.deepEqual([rendered.type, rendered.whole, rendered.startMs, rendered.endMs, rendered.bytes.toString()], ['audio/wav', false, 1200, 4500, 'RIFF']);
  const without = new AudioStore(async () => null);
  const mp3 = mp3Bytes(200); // 5.2 seconds
  const whole = await without.clip(query(await without.save(audioFile(mp3, 'call.mp3')), 1200, 4500));
  assert.deepEqual([whole.type, whole.whole, whole.bytes], ['audio/mpeg', true, mp3]);
});

test('clip store: unsupported and unreadable uploads are not kept, and recordings expire after an hour', async () => {
  let clock = 1_000_000;
  const store = new AudioStore(async () => Buffer.from('WAV'), () => clock);
  await assert.rejects(store.save(new File(['x'], 'payload.html', { type: 'text/html' })), BadInput);
  await assert.rejects(store.save(new File([], 'empty.mp3', { type: 'audio/mpeg' })), BadInput);
  assert.equal(await store.save(audioFile(Buffer.from('mock audio'), 'call.m4a')), null, 'bytes that are not an M4A are not kept');
  assert.equal(store.size, 0);
  const id = await store.save(audioFile(wavBytes(2000), 'call.wav'));
  clock += 60 * 60 * 1000 + 1;
  await assert.rejects(store.clip(query(id, 0, 1000)), BadInput);
  assert.equal(store.size, 0);
});

test('HTTP: GET /api/clip serves an uploaded span and rejects anything outside the store with JSON errors', async () => {
  const store = new AudioStore(async () => Buffer.from('RIFFWAVE'));
  const id = await store.save(audioFile(wavBytes(5000), 'call.wav'));
  const base = (url: string) => url.replace('/api/check', '/api/clip');
  await withServer(async url => {
    const ok = await fetch(`${base(url)}?file=${id}&start_ms=1200&end_ms=4500`);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'audio/wav');
    assert.equal(ok.headers.get('x-clip-start-ms'), '1200'); assert.equal(ok.headers.get('x-clip-end-ms'), '4500');
    assert.equal(ok.headers.get('x-clip-mode'), 'segment'); assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'RIFFWAVE');
    for (const text of ['file=..%2F..%2Fapi%2F.env&start_ms=0&end_ms=1000', `file=${encodeURIComponent('/etc/passwd')}&start_ms=0&end_ms=1000`,
      `file=${id}&start_ms=0&end_ms=99999`]) {
      const rejected = await fetch(`${base(url)}?${text}`);
      assert.equal(rejected.status, 400, text);
      assert.equal(rejected.headers.get('content-type'), 'application/json');
      assert.equal(typeof ((await rejected.json()) as { error?: unknown }).error, 'string');
    }
    const post = await fetch(`${base(url)}?file=${id}&start_ms=0&end_ms=1000`, { method: 'POST' });
    assert.equal(post.status, 400);
  }, { audioStore: store, jev: neverJev });
});
