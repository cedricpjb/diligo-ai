import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { checkClaims, type Thresholds } from './check.js';
import { createJev, type Jev } from './jev.js';
import { createTranscriber, type Transcriber } from './transcribe.js';
import { BadInput, parseUploads } from './uploads.js';
import type { Claude } from './claude.js';
import { AudioStore } from './clips.js';
export const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { chunks.length = 0; reject(new BadInput('Request exceeds 25 MiB.')); }
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new BadInput('Incomplete request.')));
    req.on('aborted', () => reject(new BadInput('Incomplete request.')));
  });
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function createApp(deps: { jev?: Jev; transcriber?: Transcriber; thresholds?: Thresholds; claude?: Claude; audioStore?: AudioStore } = {}) {
  const jev = deps.jev ?? createJev();
  const transcriber = deps.transcriber ?? createTranscriber();
  const audioStore = deps.audioStore ?? new AudioStore();
  const server = createServer({ requestTimeout: 150000, headersTimeout: 15000 }, async (req, res) => {
    const savedAudio: string[] = [];
    res.setHeader('Vary', 'Origin');
    if (req.headers.origin === 'http://localhost:3000') {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'X-Clip-Start-Ms, X-Clip-End-Ms, X-Clip-Mode');
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/api/check' && url.pathname !== '/api/clip') throw new BadInput('Unknown endpoint.');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (url.pathname === '/api/clip') {
        if (req.method !== 'GET') throw new BadInput('Use GET /api/clip.');
        const clip = await audioStore.clip(url.searchParams);
        res.writeHead(200, { 'Content-Type': clip.type, 'Content-Length': clip.bytes.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'X-Clip-Start-Ms': clip.startMs, 'X-Clip-End-Ms': clip.endMs,
          'X-Clip-Mode': clip.whole ? 'whole-file' : 'segment' });
        res.end(clip.bytes); return;
      }
      if (req.method !== 'POST') throw new BadInput('Use POST /api/check.');
      const type = req.headers['content-type'];
      if (!type?.toLowerCase().startsWith('multipart/form-data;')) throw new BadInput('Expected multipart/form-data.');
      if (Number(req.headers['content-length'] ?? 0) > MAX_REQUEST_BYTES) throw new BadInput('Request exceeds 25 MiB.');
      const body = await readBody(req);
      let form: FormData;
      try { form = await new Request('http://localhost/api/check', { method: 'POST', headers: { 'Content-Type': type }, body: new Uint8Array(body) }).formData(); }
      catch { throw new BadInput('Invalid multipart/form-data.'); }
      const { claims, proofs, ticker } = await parseUploads(form, transcriber, async file => {
        const id = await audioStore.save(file);
        if (id !== null) savedAudio.push(id);
        return id;
      });
      const result = await checkClaims(claims, proofs, jev, { ticker, thresholds: deps.thresholds, claude: deps.claude });
      if (!result.findings.length) throw new BadInput('No verifiable claims were found.');
      json(res, 200, result);
    } catch (error) {
      for (const id of savedAudio) audioStore.remove(id);
      // Never echo upstream messages, keys, filenames, or uploaded text in errors/logs.
      json(res, error instanceof BadInput ? 400 : 500, { error: error instanceof BadInput ? error.message : 'Unable to complete the check.' });
      req.resume();
    }
  });
  server.on('close', () => audioStore.dispose());
  return server;
}
