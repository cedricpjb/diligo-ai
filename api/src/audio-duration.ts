// Duration of a recording, read from its container in memory (no ffprobe, no temporary file).
// Returns whole milliseconds, or null when the bytes are not a readable recording of the claimed type.

function wavMs(bytes: Buffer): number | null {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = bytes.readUInt32LE(at + 16);
    // A streamed or truncated file can announce more data than it holds: count what is actually there.
    if (id === 'data') {
      const available = Math.min(size, bytes.length - (at + 8));
      return byteRate > 0 && available > 0 ? Math.round(available * 1000 / byteRate) : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

function mp4Ms(bytes: Buffer): number | null {
  // Walk top-level boxes to "moov", then to its "mvhd" movie header (timescale and duration).
  const find = (from: number, to: number, wanted: string): [number, number] | null => {
    for (let at = from; at + 8 <= to;) {
      let size = bytes.readUInt32BE(at); let header = 8;
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (size === 1) { if (at + 16 > to) return null; size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; }
      else if (size === 0) size = to - at;
      if (size < header || at + size > to) return null;
      if (type === wanted) return [at + header, at + size];
      at += size;
    }
    return null;
  };
  const moov = find(0, bytes.length, 'moov');
  const mvhd = moov && find(moov[0], moov[1], 'mvhd');
  if (!mvhd) return null;
  const [start, end] = mvhd;
  const version = bytes[start];
  let timescale: number; let duration: number;
  if (version === 1 && end - start >= 32) { timescale = bytes.readUInt32BE(start + 20); duration = Number(bytes.readBigUInt64BE(start + 24)); }
  else if (version === 0 && end - start >= 20) { timescale = bytes.readUInt32BE(start + 12); duration = bytes.readUInt32BE(start + 16); }
  else return null;
  return timescale > 0 && duration > 0 ? Math.round(duration * 1000 / timescale) : null;
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Ms(bytes: Buffer): number | null {
  let at = 0;
  if (bytes.length >= 10 && bytes.toString('latin1', 0, 3) === 'ID3') {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    at = 10 + size + ((bytes[5]! & 0x10) ? 10 : 0);
  }
  let seconds = 0; let frames = 0;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) break;
    const version = (bytes[at + 1]! >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (bytes[at + 1]! >> 1) & 3; // 1 = Layer III
    const bitrateIndex = bytes[at + 2]! >> 4; const rateIndex = (bytes[at + 2]! >> 2) & 3; const padding = (bytes[at + 2]! >> 1) & 1;
    const rates = SAMPLE_RATES[version];
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || !rates) break;
    const bitrate = (version === 3 ? MPEG1_L3 : MPEG2_L3)[bitrateIndex]! * 1000;
    const rate = rates[rateIndex]!;
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + padding;
    seconds += (version === 3 ? 1152 : 576) / rate;
    frames++;
    at += length;
  }
  // A real recording is many frames long; a few stray bytes that look like a header are not a recording.
  return frames >= 3 ? Math.round(seconds * 1000) : null;
}

export function recordingDurationMs(bytes: Buffer, extension: 'mp3' | 'wav' | 'm4a'): number | null {
  try {
    const ms = extension === 'wav' ? wavMs(bytes) : extension === 'm4a' ? mp4Ms(bytes) : mp3Ms(bytes);
    return ms !== null && Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  } catch { return null; }
}
