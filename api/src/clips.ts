import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadInput } from './uploads.js';

// Recordings are kept in memory only, never on disk: the README's rule that uploads are not written to disk still holds.
// A client refers to a recording by the random ID returned from its upload. Requests never supply paths or filenames,
// so nothing outside this store can be served.
export const MAX_CLIP_MS = 60000;
export const MAX_RECORDINGS = 100;
const TTL_MS = 60 * 60 * 1000;
const MAX_RECORDING_BYTES = 15 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORMATS: Record<string, { type: string; extension: string }> = {
  '.mp3': { type: 'audio/mpeg', extension: 'mp3' },
  '.wav': { type: 'audio/wav', extension: 'wav' },
  '.m4a': { type: 'audio/mp4', extension: 'm4a' },
};

export interface Clip { bytes: Buffer; type: string; startMs: number; endMs: number; whole: boolean }
// Returns WAV bytes for the requested span, null when ffmpeg is not installed. Throws a BadInput when ffmpeg runs
// but produces no audio (for example, the offsets lie past the end of the recording).
export type ClipRenderer = (input: Buffer, extension: string, startMs: number, endMs: number) => Promise<Buffer | null>;
export const renderClip: ClipRenderer = async (input, extension, startMs, endMs) => {
  // The recording is copied into a private temporary directory for ffmpeg and removed straight after, whatever happens.
  const directory = await mkdtemp(join(tmpdir(), 'diligo-clip-'));
  try {
    const path = join(directory, `recording.${extension}`);
    await writeFile(path, input, { mode: 0o600, flag: 'wx' });
    return await new Promise<Buffer | null>((resolve, reject) => {
      execFile('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
        '-ss', String(startMs / 1000), '-i', path, '-t', String((endMs - startMs) / 1000),
        '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '24000', '-f', 'wav', 'pipe:1'],
      { encoding: 'buffer', timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') resolve(null);
        else if (error) reject(new Error('Unable to create audio clip.'));
        else if (!stdout.length) reject(new BadInput('Clip offsets are outside the recording.'));
        else resolve(stdout);
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
};

interface Stored { bytes: Buffer; type: string; extension: string; expires: number }
export class AudioStore {
  private recordings = new Map<string, Stored>();
  constructor(private renderer: ClipRenderer = renderClip, private now: () => number = Date.now) {}
  // Returns an opaque ID for the upload. Unsupported types and oversized files are refused before anything is kept.
  async save(file: File): Promise<string> {
    this.expire();
    const extension = (/\.[^.]+$/.exec(file.name)?.[0] ?? '').toLowerCase();
    const format = FORMATS[extension];
    if (!format || !file.size || file.size > MAX_RECORDING_BYTES) throw new BadInput('Unsupported audio upload.');
    if (this.recordings.size >= MAX_RECORDINGS) throw new BadInput('Audio storage is full; retry later.');
    const id = randomUUID();
    this.recordings.set(id, { bytes: Buffer.from(await file.arrayBuffer()), type: format.type, extension: format.extension,
      expires: this.now() + TTL_MS });
    return id;
  }
  // Only the three documented parameters are accepted, each exactly once. The file must be an ID this store issued.
  async clip(params: URLSearchParams): Promise<Clip> {
    if ([...params.keys()].some(key => !['file', 'start_ms', 'end_ms'].includes(key))
      || ['file', 'start_ms', 'end_ms'].some(key => params.getAll(key).length !== 1)) throw new BadInput('Invalid clip request.');
    const id = params.get('file')!;
    const start = params.get('start_ms')!;
    const end = params.get('end_ms')!;
    if (!ID_PATTERN.test(id) || !/^\d{1,12}$/.test(start) || !/^\d{1,12}$/.test(end)) throw new BadInput('Invalid clip request.');
    const startMs = Number(start); const endMs = Number(end);
    if (endMs <= startMs || endMs - startMs > MAX_CLIP_MS) throw new BadInput('Clip offsets must describe at most 60 seconds.');
    this.expire();
    const stored = this.recordings.get(id);
    if (!stored) throw new BadInput('Unknown or expired audio file.');
    const rendered = await this.renderer(stored.bytes, stored.extension, startMs, endMs);
    // Without ffmpeg the whole recording is returned with the requested offsets, flagged so a client can stop at them.
    return { bytes: rendered ?? stored.bytes, type: rendered ? 'audio/wav' : stored.type, startMs, endMs, whole: rendered === null };
  }
  remove(id: string): void { this.recordings.delete(id); }
  dispose(): void { this.recordings.clear(); }
  private expire(): void {
    for (const [id, stored] of this.recordings) if (stored.expires <= this.now()) this.recordings.delete(id);
  }
}
