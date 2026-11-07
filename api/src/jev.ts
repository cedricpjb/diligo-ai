export interface JevResult { probability: number; mocked: boolean }
export interface Jev { ask(state: string, question: string): Promise<JevResult> }
export type Transport = typeof fetch;
export function validProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function createMockJev(): Jev {
  return { async ask(state, question) {
    if (typeof state !== 'string' || typeof question !== 'string') throw new Error('Jev accepts text only.');
    return { probability: /\bunsigned\b/i.test(state) ? 0.04 : /\bsigned\b/i.test(state) ? 0.96 : 0.5, mocked: true };
  } };
}
// Official request/response: https://docs.typesafe.ai/primitives/noul
// Endpoint/auth: https://docs.typesafe.ai/introduction/quickstart
export function createJev(apiKey?: string, transport: Transport = fetch): Jev {
  if (!apiKey?.trim()) return createMockJev();
  return { async ask(state, question) {
    if (typeof state !== 'string' || typeof question !== 'string') throw new Error('Jev accepts text only.');
    try {
      const response = await transport('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state, questions: {
          supported: { type: 'noul', instructions: question },
        } }), signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const data = await response.json() as { answers?: { supported?: { type?: unknown; noul?: unknown } } };
      const answer = data?.answers?.supported;
      if (answer?.type !== 'noul' || !validProbability(answer.noul)) throw new Error();
      return { probability: answer.noul, mocked: false };
    } catch { throw new Error('Jev request failed.'); }
  } };
}
