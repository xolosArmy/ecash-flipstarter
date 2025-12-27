import fs from 'fs';
import path from 'path';

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    const hasMatchingQuotes =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (hasMatchingQuotes) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  if (process.env.PORT === undefined && process.env.API_PORT !== undefined) {
    process.env.PORT = process.env.API_PORT;
  }
}

loadDotEnv();

const app = require('./app').default as typeof import('./app').default;
const { getEffectiveChronikBaseUrl } = require('./blockchain/ecashClient') as typeof import('./blockchain/ecashClient');
const { ECASH_BACKEND, USE_CHRONIK } = require('./config/ecash') as typeof import('./config/ecash');

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';

app.listen(port, host, () => {
  if (process.env.NODE_ENV !== 'production') {
    const chronikBaseUrl = USE_CHRONIK ? getEffectiveChronikBaseUrl() : 'unused';
    console.log(
      `[config] backendMode=${ECASH_BACKEND} chronikBaseUrl=${chronikBaseUrl}`
    );
  }
  console.log(`Flipstarter backend listening on http://${host}:${port}`);
});
