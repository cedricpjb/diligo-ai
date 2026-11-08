import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createJev } from './jev.js';
import { createTranscriber } from './transcribe.js';
import { createClaude } from './claude.js';

try {
  const config = await loadConfig();
  const app = createApp({ jev: createJev(config.jevKey), transcriber: createTranscriber(config.elevenLabsKey), thresholds: config.thresholds, allowedOrigins: config.allowedOrigins,
    claude: createClaude(config.anthropicKey) });
  app.on('error', () => { console.error('API server failed to start.'); process.exitCode = 1; });
  app.listen(config.port, '127.0.0.1', () => console.log(`API listening on http://localhost:${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.close());
} catch { console.error('API configuration is invalid.'); process.exitCode = 1; }
