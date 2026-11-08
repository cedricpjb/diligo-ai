import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { DEFAULT_THRESHOLDS, validateThresholds } from './check.js';

export const ENV_FILE = new URL('../../.env', import.meta.url); // compiled api/dist/src -> api/.env
const WEB_ORIGIN = 'http://localhost:3000';

/** Local-development origins from DEV_CORS_ORIGINS: comma-separated, each exactly http://localhost:<port>. */
function parseDevOrigins(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  return value.split(',').map(item => {
    const origin = item.trim();
    const url = URL.parse(origin);
    if (!url || url.protocol !== 'http:' || url.hostname !== 'localhost' || url.origin !== origin) {
      throw new Error('Invalid development CORS origin.');
    }
    return origin;
  });
}
export function parseConfig(contents: string) {
  const env = parseEnv(contents);
  for (const name of ['JEV_YES_THRESHOLD', 'JEV_NO_THRESHOLD']) {
    if (env[name] !== undefined && !env[name]!.trim()) throw new Error('Invalid Jev thresholds.');
  }
  const thresholds = {
    yes: env.JEV_YES_THRESHOLD === undefined ? DEFAULT_THRESHOLDS.yes : Number(env.JEV_YES_THRESHOLD),
    no: env.JEV_NO_THRESHOLD === undefined ? DEFAULT_THRESHOLDS.no : Number(env.JEV_NO_THRESHOLD),
  };
  validateThresholds(thresholds);
  const port = env.PORT === undefined ? 3001 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API port.');
  const allowedOrigins = [WEB_ORIGIN, ...parseDevOrigins(env.DEV_CORS_ORIGINS)];
  return { port, thresholds, allowedOrigins, jevKey: env.JEV_API_KEY?.trim() || undefined,
    elevenLabsKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    anthropicKey: env.ANTHROPIC_API_KEY?.trim() || undefined };
}
export async function loadConfig(reader: typeof readFile = readFile) {
  let contents = '';
  try { contents = await reader(ENV_FILE, 'utf8') as string; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read API configuration.'); }
  // Deliberately do not merge process.env or read any other .env file.
  return parseConfig(contents);
}
