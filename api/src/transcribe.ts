import type { Segment } from './types.js';
import type { Transport } from './jev.js';
export interface Transcription { segments: Segment[]; mocked: boolean }
export interface Transcriber { transcribe(audio: Blob, name: string): Promise<Transcription> }
export function createMockTranscriber(): Transcriber {
  return { async transcribe(_audio, name) {
    // Explicit demo output, never represented as a transcription of the uploaded bytes.
    return { mocked: true, segments: [
      { source: name, start: 0, end: 4.2, speaker: 'speaker_0', text: 'Revenue for the period was $1,250,000.00.' },
      { source: name, start: 4.2, end: 9.6, speaker: 'speaker_0', text: 'Cash on hand was $480,000.00 and total debt was $900,000.00.' },
      { source: name, start: 9.6, end: 12.3, speaker: 'speaker_0', text: 'I can also confirm that all material contracts are signed.' },
    ] };
  } };
}
interface Word { text: string; start: number; end: number; speaker_id?: string | null; type: string }
// https://elevenlabs.io/docs/api-reference/speech-to-text/convert
export function createTranscriber(apiKey?: string, transport: Transport = fetch): Transcriber {
  if (!apiKey?.trim()) return createMockTranscriber();
  return { async transcribe(audio, name) {
    try {
      const form = new FormData();
      form.set('file', audio, name);
      form.set('model_id', 'scribe_v2');
      form.set('diarize', 'true');
      form.set('timestamps_granularity', 'word');
      form.set('tag_audio_events', 'false');
      const response = await transport('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': apiKey }, body: form,
        signal: AbortSignal.timeout(120000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { text?: unknown; words?: Word[] };
      if (typeof body?.text !== 'string' || !Array.isArray(body.words)) throw new Error();
      const segments: Segment[] = [];
      let cursor = 0;
      for (const word of body.words) {
        if (typeof word?.text !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end)
          || word.start < 0 || word.end < word.start || (word.speaker_id != null && typeof word.speaker_id !== 'string')) throw new Error();
        const index = body.text.indexOf(word.text, cursor);
        if (index < 0) throw new Error();
        const prefix = body.text.slice(cursor, index);
        const previous = segments.at(-1);
        const speaker = word.speaker_id ?? null;
        if (word.type === 'spacing') {
          if (previous) previous.text += prefix + word.text;
        } else if (previous && previous.speaker === speaker) {
          previous.text += prefix + word.text;
          previous.end = Math.max(previous.end, word.end);
        } else {
          if (previous) previous.text += prefix;
          segments.push({ source: name, start: word.start, end: word.end, speaker, text: word.text });
        }
        cursor = index + word.text.length;
      }
      if (body.text.trim() && !segments.length) throw new Error();
      if (segments.length) segments.at(-1)!.text += body.text.slice(cursor);
      return { segments, mocked: false };
    } catch { throw new Error('Transcription request failed.'); }
  } };
}
