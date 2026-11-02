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
  | 'CODEGEN'
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

/**
 * Condición D-1 y P2b-L3 (PR-4): con el kill switch ON el proceso tiene que arrancar con
 * `--disallow-code-generation-from-strings`, de modo que V8 rechaza eval, `new Function`,
 * `Function(...)` y equivalentes ANTES de que se cargue nada de fase 2 (zod `allowsEval`/`Doc.compile`,
 * get-intrinsic `%eval%`/`getEvalledConstructor`, function-bind, depd). Se exige la forma exacta
 * del flag y que ningún otro argumento mencione la generación de código (p. ej. su negación
 * `--no-disallow-code-generation-from-strings` o variantes con `_`). Opción alternativa
 * documentada y NO elegida: `--jitless`, que solo desactiva el JIT y WebAssembly y no bloquea la
 * generación de código desde cadenas. NODE_OPTIONS ya está prohibido (regla B).
 *
 * P4-L2 (PR-4; nota en PR-5): el flag NO cubre `node:vm`. `vm.Script`, `vm.runIn*Context`,
 * `vm.compileFunction` y `vm.SourceTextModule` compilan código desde cadenas sin pasar por el
 * chequeo de V8, y un contexto creado con `codeGeneration: { strings: true }` vuelve a permitir
 * `eval` dentro de él. La barrera contra `node:vm` es estática, no de runtime: T-11a rechaza
 * cualquier builtin fuera de `ownBuiltins` (scripts/t11-blocklist.json) en los archivos propios,
 * y `node:vm` no está en esa lista. En los paquetes de terceros no hay esa barrera; queda como
 * residual LOW documentado (P4-L2 (PR-4)).
 */
export const CODEGEN_FLAG = '--disallow-code-generation-from-strings';

/**
 * PR1-L4 (PR-6a; t117u): execArgv deny-by-default. Solo se admiten los argumentos de esta lista,
 * comparados de forma EXACTA (cadena completa, sin `=valor`, sin variantes con `_`). Cualquier otro
 * argumento de Node (`--import`, `--require`/`-r`, `--loader`, `--env-file*`, `--inspect*`, `--debug*`,
 * `--expose-*`, `--max-old-space-size=…`, `--title=…`, `--permission`, …) -> regla EXEC_ARGV y exit 78.
 * Sustituye a la lista negra anterior (T-10i), que dejaba pasar todo lo no enumerado.
 * Ampliar esta lista (p. ej. `--permission`/`--allow-fs-read` si G3-02 los adopta) es un cambio de
 * control: requiere decisión registrada y re-auditoría.
 */
export const ALLOWED_EXEC_ARGV: readonly string[] = Object.freeze([CODEGEN_FLAG]);

function codegenBlocked(execArgv: readonly string[]): boolean {
  const mentions = execArgv.filter((a) => /code[-_]generation/i.test(a));
  return mentions.length === 1 && mentions[0] === CODEGEN_FLAG;
}

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
  if (input.env['TEYOLIA_X402_ENABLED'] === 'true' && !codegenBlocked(input.execArgv)) {
    reject('CODEGEN_FLAG', 'CODEGEN');
  }
  const listen = input.env['TEYOLIA_X402_LISTEN'];
  if (listen === undefined || !isListenValid(listen)) {
    if (!nameRejected.has('TEYOLIA_X402_LISTEN')) reject('TEYOLIA_X402_LISTEN', 'LISTEN');
  }

  // PR1-L4: deny-by-default. Se registra solo el NOMBRE del flag (antes de '='), nunca su valor.
  for (const arg of input.execArgv) {
    if (typeof arg === 'string' && ALLOWED_EXEC_ARGV.includes(arg)) continue;
    const flag = typeof arg === 'string' ? (arg.split('=', 1)[0] ?? arg) : '';
    reject(/^-{1,2}[A-Za-z0-9-]{1,64}$/.test(flag) ? flag : '<flag>', 'EXEC_ARGV');
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
