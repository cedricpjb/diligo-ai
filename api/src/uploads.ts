import type { SourceText } from './types.js';
import type { Transcriber } from './transcribe.js';
export class BadInput extends Error {}
const TEXT_LIMIT = 1000000;
const FILE_LIMIT = 15 * 1024 * 1024;
function checkedText(text: string): string {
  if (!text.trim() || text.length > TEXT_LIMIT || text.includes('\0')) throw new BadInput('Upload must contain readable text within the size limit.');
  return text;
}
async function readText(file: File): Promise<string> {
  if (/\.pdf$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new BadInput('Invalid PDF upload.');
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: bytes, verbosity: 0 });
    try {
      const info = await parser.getInfo();
      if (info.total > 100) throw new BadInput('PDF uploads are limited to 100 pages.');
      return checkedText((await parser.getText()).text);
    } catch { throw new BadInput('PDF must contain extractable text and at most 100 pages.'); }
    finally { await parser.destroy(); }
  }
  try { return checkedText(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
  catch { throw new BadInput('Text uploads must contain valid UTF-8 text within the size limit.'); }
}
export async function parseUploads(form: FormData, transcriber: Transcriber, saveAudio?: (file: File) => Promise<string | null>) {
  const allowed: Record<string, RegExp> = { claims_files: /\.(txt|pdf)$/i, proof_files: /\.(txt|pdf|csv)$/i, claims_audio: /\.(mp3|wav|m4a)$/i };
  const claims: SourceText[] = []; const proofs: SourceText[] = [];
  const names = new Set<string>();
  let ticker: string | undefined;
  let files = 0;
  const entries = [...form.entries()];
  // Validate the entire envelope before invoking any paid service.
  for (const [field, value] of entries) {
    if (field === 'claims_text' || field === 'ticker') {
      if (typeof value !== 'string' || form.getAll(field).length !== 1) throw new BadInput('Text fields must be single strings.');
      if (field === 'claims_text' && value.trim()) checkedText(value);
      if (field === 'ticker' && value.length > 128) throw new BadInput('Ticker is too long.');
    } else {
      const extension = allowed[field];
      if (!extension || typeof value === 'string') throw new BadInput('Unexpected upload field.');
      if (!extension.test(value.name) || /[\\/\x00-\x1f]/.test(value.name) || value.name.length > 200)
        throw new BadInput('Unsupported upload filename or file type.');
      if (!value.size || value.size > FILE_LIMIT) throw new BadInput('File is empty or exceeds 15 MiB.');
      if (names.has(value.name) || value.name === 'claims_text') throw new BadInput('Upload filenames must be unique.');
      names.add(value.name);
      if (++files > 20) throw new BadInput('At most 20 files are allowed.');
    }
  }
  if (!form.getAll('proof_files').length) throw new BadInput('At least one proof file is required.');
  if (!(String(form.get('claims_text') ?? '').trim() || form.getAll('claims_files').length || form.getAll('claims_audio').length))
    throw new BadInput('At least one claim text, file, or audio upload is required.');
  // Decode documents before transcription, so malformed proofs cannot cause paid calls.
  for (const [field, value] of entries) {
    if (field === 'ticker') ticker = (value as string).trim() || undefined;
    else if (field === 'claims_text' && (value as string).trim()) claims.push({ name: 'claims_text', text: value as string, mocked: false });
    else if (field === 'claims_files' || field === 'proof_files') {
      const file = value as File;
      const source = { name: file.name, text: await readText(file), mocked: false };
      (field === 'claims_files' ? claims : proofs).push(source);
    }
  }
  for (const value of form.getAll('claims_audio')) {
    const file = value as File;
    const result = await transcriber.transcribe(file, file.name);
    // Claim text is the segments joined with newlines: exactly the text the word timings are measured against.
    const text = checkedText(result.segments.length ? result.segments.map(s => s.text).join('\n') : result.text ?? '');
    // No ID when the recording could not be kept (unreadable duration): the check still runs, without clip playback.
    const audioFileId = saveAudio ? await saveAudio(file) ?? undefined : undefined;
    claims.push({ name: file.name, text, segments: result.segments, wordTimings: result.wordTimings,
      audioFileId, mocked: result.mocked });
  }
  return { claims, proofs, ticker };
}
