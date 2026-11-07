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
import { compareMoney, decimal, parseMoney } from '../src/money.js';
import { createTranscriber } from '../src/transcribe.js';
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
