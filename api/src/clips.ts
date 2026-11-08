import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { recordingDurationMs } from './audio-duration.js';
import { BadInput } from './uploads.js';

// Recordings are kept in memory only. Nothing here touches the file system, not even temporarily: ffmpeg is fed the
// recording over stdin and read back over stdout. A client refers to a recording by the random ID returned from its
// upload; requests never supply paths or filenames, so nothing outside this store can be served.
export const MAX_CLIP_MS = 60000;
export const MAX_RECORDINGS = 100;
const TTL_MS = 60 * 60 * 1000;
const MAX_RECORDING_BYTES = 15 * 1024 * 1024;
const MAX_CLIP_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Extension = 'mp3' | 'wav' | 'm4a';
const FORMATS: Record<string, { type: string; extension: Extension }> = {
  '.mp3': { type: 'audio/mpeg', extension: 'mp3' },
  '.wav': { type: 'audio/wav', extension: 'wav' },
  '.m4a': { type: 'audio/mp4', extension: 'm4a' },
};
// m4a (MP4) often keeps its index at the end of the file, which ffmpeg cannot read from a pipe. Rather than write the
// recording to disk to make that work, m4a is always served whole with its offsets (X-Clip-Mode: whole-file).
const PIPEABLE: ReadonlySet<Extension> = new Set<Extension>(['mp3', 'wav']);

export interface Clip { bytes: Buffer; type: string; startMs: number; endMs: number; whole: boolean }
// Returns WAV bytes for the requested span, or null when the clip cannot be cut (ffmpeg not installed).
// Throws a BadInput when ffmpeg runs but produces no audio.
export type ClipRenderer = (input: Buffer, extension: Extension, startMs: number, endMs: number) => Promise<Buffer | null>;
export type Spawn = typeof spawn;
export function createFfmpegRenderer(spawnProcess: Spawn = spawn): ClipRenderer {
  return (input, _extension, startMs, endMs) => new Promise<Buffer | null>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
    const child = spawnProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
      '-ss', String(startMs / 1000), '-i', 'pipe:0', '-t', String((endMs - startMs) / 1000),
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '24000', '-f', 'wav', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error('Unable to create audio clip.'))); }, 15000);
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CLIP_BYTES) { child.kill(); finish(() => reject(new Error('Unable to create audio clip.'))); }
      else chunks.push(chunk);
    });
    // ffmpeg may close its input early once it has what it needs; that is not a failure.
    child.stdin.on('error', () => {});
    child.on('error', (error: NodeJS.ErrnoException) => finish(() => error.code === 'ENOENT' ? resolve(null) : reject(new Error('Unable to create audio clip.'))));
    child.on('close', code => finish(() => {
      if (code !== 0) reject(new Error('Unable to create audio clip.'));
      else if (!size) reject(new BadInput('Clip offsets are outside the recording.'));
      else resolve(Buffer.concat(chunks));
    }));
    child.stdin.end(input);
  });
}
export const renderClip: ClipRenderer = createFfmpegRenderer();

interface Stored { bytes: Buffer; type: string; extension: Extension; durationMs: number; expires: number }
export class AudioStore {
  private recordings = new Map<string, Stored>();
  // Slots claimed by uploads that are still being read. Counting them keeps concurrent uploads under the cap.
  private pending = 0;
  constructor(private renderer: ClipRenderer = renderClip, private now: () => number = Date.now) {}
  get size(): number { return this.recordings.size; }
  // Returns an opaque ID for the upload, or null when the recording's duration cannot be read (it is then not kept,
  // because a clip range could not be checked against it). Unsupported types and oversized files are refused.
  async save(file: File): Promise<string | null> {
    this.expire();
    const extension = (/\.[^.]+$/.exec(file.name)?.[0] ?? '').toLowerCase();
    const format = FORMATS[extension];
    if (!format || !file.size || file.size > MAX_RECORDING_BYTES) throw new BadInput('Unsupported audio upload.');
    // Reserve a slot before the first await: the check and the claim happen in one synchronous step, so concurrent
    // uploads cannot all pass the check and then all insert.
    if (this.recordings.size + this.pending >= MAX_RECORDINGS) throw new BadInput('Audio storage is full; retry later.');
    this.pending++;
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      const durationMs = recordingDurationMs(bytes, format.extension);
      if (durationMs === null) return null;
      const id = randomUUID();
      this.recordings.set(id, { bytes, type: format.type, extension: format.extension, durationMs, expires: this.now() + TTL_MS });
      return id;
    } finally { this.pending--; }
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
    // The range must lie inside the recording, in every mode: a span that starts or ends past the end is refused.
    if (endMs > stored.durationMs) throw new BadInput('Clip offsets are outside the recording.');
    const rendered = PIPEABLE.has(stored.extension) ? await this.renderer(stored.bytes, stored.extension, startMs, endMs) : null;
    // Without ffmpeg the whole recording is returned with the requested offsets, flagged so a client can stop at them.
    return { bytes: rendered ?? stored.bytes, type: rendered ? 'audio/wav' : stored.type, startMs, endMs, whole: rendered === null };
  }
  remove(id: string): void { this.recordings.delete(id); }
  dispose(): void { this.recordings.clear(); }
  private expire(): void {
    for (const [id, stored] of this.recordings) if (stored.expires <= this.now()) this.recordings.delete(id);
  }
}
