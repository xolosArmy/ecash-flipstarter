#!/usr/bin/env node
// Inventario del commit exacto (TA1-M1; INF-045 §4.1; plan v1.0 §4.2.8).
// Recorre backend/src (sin __tests__ ni *.test/*.spec) y produce, de forma determinista:
//   1. lecturas de entorno (directas, por índice, desestructuradas y por nombre pasado a
//      funciones lectoras) con archivo:línea, clase y disposición en el proceso x402;
//   2. accesos dinámicos y CANALES (escrituras en process.env, p. ej. loadDotEnv);
//   3. funciones lectoras de entorno por nombre y sus llamadas;
//   4. nombres de backend/.env.example que el código no lee;
//   5. grafo de imports con marcas FIRMA / TRANSMITE / LEE_LLAVE / LEE_CREDENCIAL / DB_LEGACY / CANAL.
// Uso: node scripts/inventory.mjs --write | --check | --stdout [--src <dir>]
// Requiere `npm run build` previo (usa dist/env-guard.js para la disposición x402).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { balancedBraces, balancedParens, lineOf, stripComments } from './lib/js-lexer.mjs';

export const BASE_COMMIT = '239f9dc9d64361700b798cebde0f30a0dc368e7b';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..');
export const DEFAULT_SRC = path.join(REPO_ROOT, 'backend', 'src');
export const INVENTORY_FILE = path.join(PACKAGE_ROOT, 'inventory', '239f9dc.inventory.txt');
export const INVENTORY_SHA_FILE = `${INVENTORY_FILE}.sha256`;

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const MARKERS = ['FIRMA', 'TRANSMITE', 'LEE_LLAVE', 'LEE_CREDENCIAL', 'DB_LEGACY', 'CANAL'];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function listSourceFiles(srcDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(full);
      } else if (SOURCE_EXT.some((e) => entry.endsWith(e)) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out;
}

function moduleId(srcDir, file) {
  const rel = toPosix(path.relative(srcDir, file));
  return rel.replace(/\.d\.ts$/, '.d').replace(/\.[cm]?[jt]sx?$/, '');
}

function classify(name) {
  if (/PRIVKEY|PRIVATE_KEY|SEED|MNEMONIC|WIF|XPRV|TPRV/.test(name)) return 'secreto (llave/semilla)';
  if (/RPC_USER|RPC_PASS|PASSWORD|SECRET|TOKEN|_PASS$/.test(name)) return 'credencial';
  if (/RPC_URL/.test(name)) return 'url (puede llevar credencial)';
  if (/_PATH$/.test(name)) return 'ruta';
  if (/_URL$|_ORIGINS?$/.test(name)) return 'endpoint/origen no secreto';
  if (/PUBKEY|ADDRESS/.test(name)) return 'identificador no secreto';
  if (/^(ENABLE_|FORCE_)|_ENABLED$/.test(name)) return 'flag de control';
  return 'configuración';
}

async function loadGuard() {
  const guardPath = path.join(PACKAGE_ROOT, 'dist', 'env-guard.js');
  const allowPath = path.join(PACKAGE_ROOT, 'dist', 'allowlist.js');
  if (!existsSync(guardPath) || !existsSync(allowPath)) {
    throw new Error('inventory: falta dist/ (ejecuta `npm run build` antes)');
  }
  const guard = await import(pathToFileURL(guardPath).href);
  const allow = await import(pathToFileURL(allowPath).href);
  return { isRuleANegative: guard.isRuleANegative, normative: new Set(allow.NORMATIVE_ALLOWLIST), system: new Set(allow.SYSTEM_ALLOWLIST) };
}

function disposition(guard, name) {
  if (guard.isRuleANegative(name)) return 'rechazada en x402 (regla A)';
  if (guard.normative.has(name)) return 'admitida en x402 (allowlist normativa)';
  if (guard.system.has(name)) return 'admitida en x402 (conjunto de sistema)';
  return 'rechazada en x402 (regla B)';
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => path.join(base, `index${e}`))];
  if (/\.[cm]?js$/.test(base)) {
    const stem = base.replace(/\.[cm]?js$/, '');
    candidates.push(...SOURCE_EXT.map((e) => stem + e));
  }
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function findImports(code) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g,
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\bimport\s+[\w$]+\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) specs.push(m[2]);
  }
  return [...new Set(specs)];
}

function enclosingFunction(code, index) {
  const before = code.slice(0, index);
  const re = /(?:function\s+([\w$]+)\s*\(|(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/g;
  let name = null;
  for (const m of before.matchAll(re)) name = m[1] ?? m[2];
  return name ?? '(nivel de módulo)';
}

export async function generateInventory(srcDir = DEFAULT_SRC) {
  const guard = await loadGuard();
  const files = listSourceFiles(srcDir);
  const fileInfo = new Map();
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    fileInfo.set(file, { id: moduleId(srcDir, file), raw, code: stripComments(raw) });
  }

  const envReads = new Map();
  const addRead = (name, id, line, kind) => {
    if (!envReads.has(name)) envReads.set(name, []);
    envReads.get(name).push(`${id}:${line} (${kind})`);
  };
  const dynamicLines = [];
  const readerFunctions = new Map();
  const moduleDirect = new Map();

  for (const [, info] of fileInfo) {
    const { code, id } = info;
    const marks = new Set();
    for (const m of code.matchAll(/process\.env\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const after = code.slice(m.index + m[0].length, m.index + m[0].length + 4);
      const isWrite = /^\s*=(?!=)/.test(after);
      addRead(m[1], id, lineOf(code, m.index), isWrite ? 'escritura' : 'directa');
      if (isWrite) {
        marks.add('CANAL');
        dynamicLines.push(`CANAL | ${id}:${lineOf(code, m.index)} | escritura process.env.${m[1]} en ${enclosingFunction(code, m.index)}`);
      }
    }
    for (const m of code.matchAll(/process\.env\??\.?\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g)) {
      addRead(m[2], id, lineOf(code, m.index), 'índice literal');
    }
    for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1].split(',')) {
        const nm = part.trim().split(/[:=\s]/)[0];
        if (nm && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) addRead(nm, id, lineOf(code, m.index), 'desestructurada');
      }
    }
    for (const m of code.matchAll(/process\.env\??\.?\[\s*(?!['"`][A-Za-z_][A-Za-z0-9_]*['"`]\s*\])([^\]]+)\]/g)) {
      const line = lineOf(code, m.index);
      const after = code.slice(m.index + m[0].length, m.index + m[0].length + 4);
      const fn = enclosingFunction(code, m.index);
      if (/^\s*=(?!=)/.test(after)) {
        marks.add('CANAL');
        dynamicLines.push(`CANAL | ${id}:${line} | escritura dinámica process.env[${m[1].trim()}] en ${fn} (escribe claves arbitrarias en process.env)`);
      } else {
        dynamicLines.push(`DINAMICO | ${id}:${line} | lectura process.env[${m[1].trim()}] en ${fn}`);
        if (fn !== '(nivel de módulo)') {
          if (!readerFunctions.has(fn)) readerFunctions.set(fn, { def: `${id}:${lineOf(code, code.search(new RegExp(`function\\s+${fn}\\s*\\(`)))}`, calls: [] });
        }
      }
    }
    moduleDirect.set(id, marks);
  }

  for (const [fn, entry] of readerFunctions) {
    for (const [, info] of fileInfo) {
      const { code, id } = info;
      for (const m of code.matchAll(new RegExp(`(?<![\\w$])${fn}\\s*\\(`, 'g'))) {
        const before = code.slice(Math.max(0, m.index - 30), m.index);
        if (/function\s+$/.test(before)) continue;
        const open = m.index + m[0].length - 1;
        const args = balancedParens(code, open);
        const names = [...args.matchAll(/(['"`])([A-Z][A-Z0-9_]*)\1/g)].map((x) => x[2]);
        const line = lineOf(code, m.index);
        if (names.length > 0) {
          for (const nm of names) addRead(nm, id, line, `vía ${fn}`);
          entry.calls.push(`${id}:${line} [${[...new Set(names)].join(', ')}]`);
        } else {
          entry.calls.push(`${id}:${line} [sin nombres literales]`);
        }
      }
    }
  }

  const keyEnv = (name) => classify(name) === 'secreto (llave/semilla)';
  const credEnv = (name) => ['credencial', 'url (puede llevar credencial)'].includes(classify(name));
  for (const [name, reads] of envReads) {
    for (const r of reads) {
      const id = r.slice(0, r.indexOf(':'));
      const marks = moduleDirect.get(id);
      if (keyEnv(name)) marks.add('LEE_LLAVE');
      if (credEnv(name)) marks.add('LEE_CREDENCIAL');
      if (name === 'TEYOLIA_SQLITE_PATH') marks.add('DB_LEGACY');
    }
  }

  const imports = new Map();
  for (const [file, info] of fileInfo) {
    const { code, id } = info;
    const marks = moduleDirect.get(id);
    if (/(?<![\w$])sign[A-Z][\w$]*\s*\(|\b(?:secp256k1|ecc|schnorr|ecdsa)\.sign\s*\(/.test(code)) marks.add('FIRMA');
    if (/(?<![\w$])broadcast(?:Raw)?Tx\s*\(|sendrawtransaction|\.broadcastTx\s*\(/i.test(code)) marks.add('TRANSMITE');
    if (/(?<![\w$])(?:derivePrivKeyFromSeed|resolvePrivateKeyFromEnv)\s*\(/.test(code)) marks.add('LEE_LLAVE');
    if (/\brpc(?:Username|Password)\b/.test(code)) marks.add('LEE_CREDENCIAL');
    if (/(?<![\w$])(?:openDatabase|getDb)\s*\(|campaigns\.db/.test(code)) marks.add('DB_LEGACY');
    const specs = findImports(code);
    const resolved = [];
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        resolved.push(target && fileInfo.has(target) ? fileInfo.get(target).id : `?${spec}`);
      } else {
        if (spec === 'sqlite3' || spec === 'sqlite' || spec === 'better-sqlite3') marks.add('DB_LEGACY');
        resolved.push(`ext:${spec}`);
      }
    }
    imports.set(id, [...new Set(resolved)].sort());
  }

  const reach = new Map();
  const visit = (id, stack = new Set()) => {
    if (reach.has(id)) return reach.get(id);
    if (stack.has(id)) return new Map();
    stack.add(id);
    const acc = new Map();
    for (const dep of imports.get(id) ?? []) {
      if (!moduleDirect.has(dep)) continue;
      for (const mk of moduleDirect.get(dep)) if (!acc.has(mk)) acc.set(mk, dep);
      for (const [mk, via] of visit(dep, stack)) if (!acc.has(mk)) acc.set(mk, via);
    }
    stack.delete(id);
    reach.set(id, acc);
    return acc;
  };

  const examplePath = path.join(srcDir, '..', '.env.example');
  const exampleNames = existsSync(examplePath)
    ? readFileSync(examplePath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => l.slice(0, l.indexOf('=')).trim())
    : [];

  const digestLines = files.map((f) => `${sha256(readFileSync(f))}  ${toPosix(path.relative(srcDir, f))}`).sort();
  const digest = sha256(`${digestLines.join('\n')}\n`);

  const lines = [];
  lines.push('# Inventario TA-2 (TA1-M1, INF-045 §4.1) — xolosArmy/ecash-flipstarter backend/src');
  lines.push('# Generador: x402-teyolia/scripts/inventory.mjs (formato v1). Salida determinista: sin fechas.');
  lines.push(`commit_base: ${BASE_COMMIT}`);
  lines.push('alcance: backend/src (excluye __tests__/, *.test.*, *.spec.*)');
  lines.push(`archivos: ${files.length}`);
  lines.push(`digest_backend_src: sha256:${digest} (sha256 de las líneas "<sha256>  <ruta>" ordenadas, una por archivo)`);
  lines.push('');
  const names = [...envReads.keys()].sort();
  lines.push(`## 1 Variables de entorno leídas (${names.length} nombres)`);
  lines.push('# NOMBRE | clase | disposición en el proceso x402 | lecturas (módulo:línea (tipo))');
  for (const name of names) {
    const key = (r) => {
      const m = /^([^:]+):(\d+)/.exec(r);
      return m ? [m[1], Number(m[2])] : [r, 0];
    };
    const reads = [...new Set(envReads.get(name))].sort((a, b) => {
      const [ma, la] = key(a);
      const [mb, lb] = key(b);
      return ma < mb ? -1 : ma > mb ? 1 : la - lb || (a < b ? -1 : a > b ? 1 : 0);
    });
    lines.push(`ENV ${name} | ${classify(name)} | ${disposition(guard, name)} | ${reads.join('; ')}`);
  }
  lines.push('');
  lines.push('## 2 Accesos dinámicos y canales');
  for (const l of [...new Set(dynamicLines)].sort()) lines.push(l);
  lines.push('');
  lines.push('## 3 Funciones que leen el entorno por nombre recibido');
  for (const fn of [...readerFunctions.keys()].sort()) {
    const e = readerFunctions.get(fn);
    const callKey = (c) => { const m = /^([^:]+):(\d+)/.exec(c); return m ? `${m[1]}:${m[2].padStart(6, '0')}` : c; };
    lines.push(`LECTORA ${fn} | definida en ${e.def} | llamadas: ${[...e.calls].sort((a, b) => (callKey(a) < callKey(b) ? -1 : 1)).join('; ') || '(ninguna)'}`);
  }
  lines.push('');
  lines.push('## 4 backend/.env.example: nombres que el código de backend/src no lee');
  const unread = [...new Set(exampleNames)].filter((n) => !envReads.has(n)).sort();
  for (const n of unread) lines.push(`NO_LEIDA ${n} | ${classify(n)} | ${disposition(guard, n)}`);
  if (unread.length === 0) lines.push('(ninguno)');
  lines.push('');
  lines.push('## 5 Módulos (grafo de imports y marcas)');
  lines.push('# MODULO id | marcas directas | alcanza por imports (marca<-vía) | imports');
  const ids = [...moduleDirect.keys()].sort();
  for (const id of ids) {
    const direct = MARKERS.filter((m) => moduleDirect.get(id).has(m));
    const reached = visit(id);
    const reachedTxt = MARKERS.filter((m) => reached.has(m)).map((m) => `${m}<-${reached.get(m)}`);
    lines.push(`MODULO ${id} | ${direct.join(',') || '-'} | ${reachedTxt.join(',') || '-'} | ${(imports.get(id) ?? []).join(', ') || '-'}`);
  }
  lines.push('');
  lines.push('## 6 Resumen');
  for (const m of MARKERS) {
    const direct = ids.filter((id) => moduleDirect.get(id).has(m));
    lines.push(`MARCA ${m} | directa en ${direct.length}: ${direct.join(', ') || '-'}`);
  }
  const flagged = ids.filter((id) => moduleDirect.get(id).size > 0 || visit(id).size > 0);
  lines.push(`MARCADOS_T11C ${flagged.length} | ${flagged.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

/** Lee un inventario y devuelve nombres de entorno y módulos marcados (directos o transitivos). */
export function parseInventory(text) {
  const envNames = new Set();
  const flagged = new Map();
  for (const line of text.split('\n')) {
    let m = /^ENV ([A-Za-z_][A-Za-z0-9_]*) \|/.exec(line);
    if (m) envNames.add(m[1]);
    m = /^MODULO (\S+) \| ([^|]*) \| ([^|]*) \|/.exec(line);
    if (m) {
      const direct = m[2].trim() === '-' ? [] : m[2].trim().split(',');
      const reached = m[3].trim() === '-' ? [] : m[3].trim().split(',').map((x) => x.split('<-')[0]);
      const all = [...new Set([...direct, ...reached])];
      if (all.length > 0) flagged.set(m[1], { direct, reached, all });
    }
  }
  const commit = /^commit_base: ([0-9a-f]{40})$/m.exec(text)?.[1] ?? null;
  return { commit, envNames, flagged };
}

async function cli(argv) {
  const mode = argv.find((a) => ['--write', '--check', '--stdout'].includes(a)) ?? '--stdout';
  const srcIdx = argv.indexOf('--src');
  const srcDir = srcIdx >= 0 ? path.resolve(argv[srcIdx + 1]) : DEFAULT_SRC;
  const text = await generateInventory(srcDir);
  const digest = sha256(text);
  const shaLine = `${digest}  239f9dc.inventory.txt\n`;
  if (mode === '--stdout') {
    process.stdout.write(text);
    return 0;
  }
  if (mode === '--write') {
    writeFileSync(INVENTORY_FILE, text);
    writeFileSync(INVENTORY_SHA_FILE, shaLine);
    process.stdout.write(`inventory: escrito ${toPosix(path.relative(REPO_ROOT, INVENTORY_FILE))} sha256 ${digest}\n`);
    return 0;
  }
  const archived = existsSync(INVENTORY_FILE) ? readFileSync(INVENTORY_FILE, 'utf8') : null;
  const archivedSha = existsSync(INVENTORY_SHA_FILE) ? readFileSync(INVENTORY_SHA_FILE, 'utf8') : null;
  const problems = [];
  if (archived === null) problems.push('falta el inventario archivado');
  else if (archived !== text) problems.push('el inventario regenerado difiere del archivado (¿cambió backend/src o el guard?)');
  if (archivedSha === null) problems.push('falta el .sha256');
  else if (archived !== null && archivedSha.trim().split(/\s+/)[0] !== sha256(archived)) problems.push('el .sha256 no coincide con el archivo archivado');
  else if (archivedSha !== shaLine) problems.push('el .sha256 no coincide con el regenerado');
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`inventory:check FALLA: ${p}\n`);
    return 1;
  }
  process.stdout.write(`inventory:check OK sha256 ${digest}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`inventory: error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
