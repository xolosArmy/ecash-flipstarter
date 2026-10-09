// Guard de arranque (fase 1). Solo importa node:* y la allowlist propia.
// Se ejecuta ANTES de cargar Express (main.ts hace `await import('./server.js')` solo si pasa).
// Registra solo NOMBRES, nunca valores (INF-045 §5.1).

import { readdirSync } from 'node:fs';
import {
  NEGATIVE_EXACT,
  NEGATIVE_PREFIXES,
  NEGATIVE_SUBSTRINGS,
  NORMATIVE_ALLOWLIST,
  SYSTEM_ALLOWLIST,
} from './allowlist.js';

export type RejectionRule =
  | 'A'
  | 'B'
  | 'C'
  | 'NODE_ENV'
  | 'KILL_SWITCH'
  | 'LISTEN'
  | 'ENV_FILE'
  | 'EXEC_ARGV'
  | 'CWD';

export interface Rejection {
  readonly name: string;
  readonly rule: RejectionRule;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly rejections: readonly Rejection[];
}

export interface GuardInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly listCwd?: (cwd: string) => readonly string[];
}

const ALLOWED = new Set<string>([...NORMATIVE_ALLOWLIST, ...SYSTEM_ALLOWLIST]);
const NEGATIVE = new Set<string>(NEGATIVE_EXACT);

/** Flags de execArgv prohibidos (T-10g estricto y T-10i). Se compara el nombre antes de '='. */
const FORBIDDEN_EXEC_FLAGS: readonly string[] = [
  '--env-file',
  '--env-file-if-exists',
  '--require',
  '-r',
  '--import',
  '--experimental-loader',
  '--loader',
  '--experimental-preload',
];
const FORBIDDEN_EXEC_PREFIXES: readonly string[] = ['--inspect', '--debug'];

export function isRuleANegative(name: string): boolean {
  if (NEGATIVE.has(name)) return true;
  for (const prefix of NEGATIVE_PREFIXES) if (name.startsWith(prefix)) return true;
  const upper = name.toUpperCase();
  for (const sub of NEGATIVE_SUBSTRINGS) if (upper.includes(sub)) return true;
  return false;
}

const BASE58 = '1-9A-HJ-NP-Za-km-z';
// Regla C por FORMA, sin validar checksum (Auditor P-4 I-2).
const EXTENDED_PRIVATE = new RegExp(`(?:^|[^${BASE58}])[xt]prv[${BASE58}]{20,}`);
const WIF = new RegExp(`(?:^|[^${BASE58}])(?:[5][${BASE58}]{50}|[KLc][${BASE58}]{51}|[9][${BASE58}]{50})(?![${BASE58}])`);
const URL_USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s@]*@/;

function looksLikeMnemonic(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  let run = 0;
  for (const token of tokens) {
    if (/^[a-z]{3,8}$/.test(token)) {
      run += 1;
      if (run >= 12) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

export function isRuleCValue(value: string): boolean {
  return (
    EXTENDED_PRIVATE.test(value) ||
    WIF.test(value) ||
    URL_USERINFO.test(value) ||
    looksLikeMnemonic(value)
  );
}

function defaultListCwd(cwd: string): readonly string[] {
  return readdirSync(cwd);
}

function isListenValid(raw: string): boolean {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(raw)) return false;
  const port = Number(raw);
  return port <= 65535 && port !== 3011;
}

export function evaluateStartup(input: GuardInput): GuardResult {
  const rejections: Rejection[] = [];
  const rejected = new Set<string>();
  const reject = (name: string, rule: RejectionRule): void => {
    const key = `${rule}:${name}`;
    if (rejected.has(key)) return;
    rejected.add(key);
    rejections.push({ name, rule });
  };

  const names = Object.keys(input.env).sort();
  const nameRejected = new Set<string>();
  for (const name of names) {
    if (isRuleANegative(name)) {
      reject(name, 'A');
      nameRejected.add(name);
    } else if (!ALLOWED.has(name)) {
      reject(name, 'B');
      nameRejected.add(name);
    }
  }
  for (const name of names) {
    const value = input.env[name];
    if (typeof value === 'string' && isRuleCValue(value) && !nameRejected.has(name)) {
      reject(name, 'C');
      nameRejected.add(name);
    }
  }

  const nodeEnv = input.env['NODE_ENV'];
  if (nodeEnv !== undefined && nodeEnv !== 'test' && !nameRejected.has('NODE_ENV')) {
    reject('NODE_ENV', 'NODE_ENV');
  }
  if (input.env['TEYOLIA_X402_ENABLED'] === 'true' && nodeEnv !== 'test') {
    reject('TEYOLIA_X402_ENABLED', 'KILL_SWITCH');
  }
  const listen = input.env['TEYOLIA_X402_LISTEN'];
  if (listen === undefined || !isListenValid(listen)) {
    if (!nameRejected.has('TEYOLIA_X402_LISTEN')) reject('TEYOLIA_X402_LISTEN', 'LISTEN');
  }

  for (const arg of input.execArgv) {
    const flag = arg.split('=', 1)[0] ?? arg;
    if (FORBIDDEN_EXEC_FLAGS.includes(flag) || FORBIDDEN_EXEC_PREFIXES.some((p) => flag.startsWith(p))) {
      reject(/^-{1,2}[A-Za-z0-9-]{1,64}$/.test(flag) ? flag : '<flag>', 'EXEC_ARGV');
    }
  }

  let entries: readonly string[] = [];
  try {
    entries = (input.listCwd ?? defaultListCwd)(input.cwd);
  } catch {
    reject('cwd', 'CWD');
  }
  for (const entry of entries) {
    if (entry === '.env' || entry.startsWith('.env.')) {
      reject(/^\.env[A-Za-z0-9._-]{0,64}$/.test(entry) ? entry : '.env*', 'ENV_FILE');
    }
  }

  return { ok: rejections.length === 0, rejections };
}

const PRINTABLE_NAME = /^[A-Za-z_.\-][A-Za-z0-9_.\-]{0,127}$/;

/** Líneas de log: solo el nombre y la regla, nunca el valor. */
export function formatRejections(result: GuardResult): string[] {
  return result.rejections.map((r) => {
    const name = PRINTABLE_NAME.test(r.name) ? r.name : '<nombre-no-imprimible>';
    return `x402-teyolia: arranque rechazado: ${name} (regla ${r.rule})`;
  });
}
