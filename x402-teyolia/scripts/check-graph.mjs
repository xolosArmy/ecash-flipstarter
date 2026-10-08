#!/usr/bin/env node
// T-11a / T-11b / T-11c sobre el bundle x402 (plan v1.0 §4.5; Auditor P4-L2).
//   T-11a: grafo de imports desde dist/main.js, siguiendo imports estáticos Y dinámicos
//          (incluido `import('./server.js')`). Solo se admiten: archivos propios del paquete,
//          node:* enumerados (scripts/t11-blocklist.json) y paquetes del cierre de
//          producción del package-lock.json propio (no un comodín). Además, la fase 1
//          (cierre estático de main.js) no puede cargar ningún paquete: Express solo
//          después del guard.
//   T-11b: búsqueda de la lista negativa (scripts/t11-blocklist.json) en los archivos propios
//          del grafo.
//   T-11c: cruce con el inventario del commit exacto: ningún módulo marcado (directo o
//          transitivo) aparece en el grafo, ni por ruta real ni como copia (sufijo de ruta).
// Uso: node scripts/check-graph.mjs [dist/main.js] [--json]

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/js-lexer.mjs';
import { INVENTORY_FILE, PACKAGE_ROOT, REPO_ROOT, parseInventory } from './inventory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BLOCKLIST = JSON.parse(readFileSync(path.join(HERE, 't11-blocklist.json'), 'utf8'));
const LEGACY_SRC = path.join(REPO_ROOT, 'backend', 'src');
const RESOLVE_EXT = ['.js', '.mjs', '.cjs', '.json', '.ts', '.mts', '.cts'];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Cierre de producción del lockfile v3: entradas sin `dev: true`. */
export function lockfileClosure(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const root = lock.packages?.[''] ?? {};
  const entries = new Map();
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (key === '' || meta.dev) continue;
    entries.set(key, meta);
  }
  return {
    lockDir: path.dirname(lockPath),
    directDeps: new Set(Object.keys(root.dependencies ?? {})),
    entries,
    names: new Set([...entries.keys()].map((k) => k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length))),
  };
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...RESOLVE_EXT.map((e) => base + e), ...RESOLVE_EXT.map((e) => path.join(base, `index${e}`))];
  if (/\.[cm]?js$/.test(base)) {
    const stem = base.replace(/\.[cm]?js$/, '');
    candidates.push(...['.ts', '.mts', '.cts', '.tsx'].map((e) => stem + e));
  }
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** Extrae imports de un archivo propio. Falla cerrado ante cargas no literales u opacas. */
function scanOwnFile(code) {
  const edges = [];
  const problems = [];
  const staticRes = [
    /(?:^|[;\n}])\s*import\s+(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g,
    /(?:^|[;\n}])\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+(['"])([^'"\n]+)\1/g,
  ];
  for (const re of staticRes) for (const m of code.matchAll(re)) edges.push({ spec: m[2], dynamic: false });
  for (const m of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
    const rest = code.slice(m.index + m[0].length);
    const lit = /^\s*(['"])([^'"\n]+)\1\s*[),]/.exec(rest);
    if (lit) edges.push({ spec: lit[2], dynamic: true });
    else problems.push('import() dinámico con especificador no literal');
  }
  for (const needle of BLOCKLIST.opaqueLoaders) {
    if (code.includes(needle)) problems.push(`carga de código opaca: ${needle}`);
  }
  return { edges, problems };
}

function scanPackageFile(code) {
  const edges = [];
  const warnings = [];
  for (const m of code.matchAll(/(?<![\w$.])require\s*\(\s*([^)]*)\)/g)) {
    const lit = /^\s*(['"])([^'"\n]+)\1\s*$/.exec(m[1]);
    if (lit) edges.push({ spec: lit[2], dynamic: false });
    else warnings.push('require no literal');
  }
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s+(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g)) edges.push({ spec: m[2], dynamic: false });
  return { edges, warnings };
}

/**
 * Construye el grafo desde `entry`.
 * opts.ownRoot: raíz de los archivos propios (por defecto PACKAGE_ROOT).
 * opts.lock: resultado de lockfileClosure() (por defecto el lockfile propio).
 */
export function buildGraph(entry, opts = {}) {
  const ownRoot = path.resolve(opts.ownRoot ?? PACKAGE_ROOT);
  const lock = opts.lock ?? lockfileClosure(path.join(PACKAGE_ROOT, 'package-lock.json'));
  const nodes = new Map();
  const problems = [];
  const entryAbs = path.resolve(entry);
  const queue = [{ file: entryAbs, phase1: true, from: null }];

  const addProblem = (msg) => { if (!problems.includes(msg)) problems.push(msg); };

  while (queue.length > 0) {
    const { file, phase1 } = queue.shift();
    const existing = nodes.get(file);
    if (existing) {
      if (phase1 && !existing.phase1) {
        existing.phase1 = true;
        if (existing.kind === 'package') addProblem(`T-11a fase 1: el paquete ${existing.pkg} se carga antes del guard (import estático desde main)`);
        for (const e of existing.edges) if (!e.dynamic && e.resolved) queue.push({ file: e.resolved, phase1: true });
      }
      continue;
    }
    const inNodeModules = file.split(path.sep).includes('node_modules');
    const own = !inNodeModules && isInside(file, ownRoot);
    const legacy = isInside(file, LEGACY_SRC);
    const node = { file, kind: own ? 'own' : inNodeModules ? 'package' : 'outside', phase1, edges: [], builtins: new Set(), warnings: [] };
    nodes.set(file, node);

    if (node.kind === 'outside') {
      addProblem(`T-11a: módulo fuera del paquete x402: ${toPosix(path.relative(REPO_ROOT, file))}${legacy ? ' (backend legacy)' : ''}`);
      continue;
    }
    if (node.kind === 'package') {
      const segs = file.split(path.sep);
      const idx = segs.lastIndexOf('node_modules');
      const nameParts = segs[idx + 1]?.startsWith('@') ? segs.slice(idx + 1, idx + 3) : segs.slice(idx + 1, idx + 2);
      node.pkg = nameParts.join('/');
      const pkgDir = segs.slice(0, idx + 1 + nameParts.length).join(path.sep);
      const lockKey = toPosix(path.relative(lock.lockDir, pkgDir));
      const meta = lock.entries.get(lockKey);
      if (!meta) addProblem(`T-11a: paquete fuera del cierre de producción del lockfile: ${lockKey}`);
      else {
        try {
          const installed = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
          if (installed !== meta.version) addProblem(`T-11a: versión instalada de ${lockKey} (${installed}) distinta del lockfile (${meta.version})`);
        } catch {
          addProblem(`T-11a: no se pudo leer package.json de ${lockKey}`);
        }
      }
      if (phase1) addProblem(`T-11a fase 1: el paquete ${node.pkg} se carga antes del guard (import estático desde main)`);
      if (file.endsWith('.json')) continue;
    }

    let code;
    try {
      code = stripComments(readFileSync(file, 'utf8'));
    } catch {
      addProblem(`T-11a: no se pudo leer ${toPosix(path.relative(REPO_ROOT, file))}`);
      continue;
    }
    node.raw = readFileSync(file, 'utf8');
    const scan = node.kind === 'own' ? scanOwnFile(code) : scanPackageFile(code);
    if (node.kind === 'own') for (const p of scan.problems) addProblem(`T-11a: ${p} en ${toPosix(path.relative(REPO_ROOT, file))}`);
    else node.warnings.push(...scan.warnings);

    for (const edge of scan.edges) {
      const spec = edge.spec;
      if (spec.startsWith('node:') || isBuiltin(spec)) {
        node.builtins.add(spec);
        if (node.kind === 'own') {
          if (!spec.startsWith('node:')) addProblem(`T-11a: builtin sin prefijo node: (${spec}) en archivo propio`);
          else if (!BLOCKLIST.ownBuiltins.includes(spec)) addProblem(`T-11a: builtin no enumerado en archivo propio: ${spec}`);
        }
        node.edges.push({ ...edge, resolved: null, builtin: true });
        continue;
      }
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolveRelative(file, spec);
        if (!target) {
          addProblem(`T-11a: import no resuelto ${spec} en ${toPosix(path.relative(REPO_ROOT, file))}`);
          node.edges.push({ ...edge, resolved: null });
          continue;
        }
        const real = realpathSync(target);
        node.edges.push({ ...edge, resolved: real });
        queue.push({ file: real, phase1: phase1 && !edge.dynamic });
        continue;
      }
      const name = packageNameOf(spec);
      if (node.kind === 'own' && !lock.directDeps.has(name)) {
        addProblem(`T-11a: paquete no permitido (no es dependencia de producción del lockfile): ${name}`);
        node.edges.push({ ...edge, resolved: null });
        continue;
      }
      let target = null;
      try {
        target = createRequire(file).resolve(spec);
      } catch {
        target = null;
      }
      if (node.kind === 'package' && !lock.names.has(name)) {
        if (target) addProblem(`T-11a: dependencia transitiva fuera del lockfile que SÍ se resuelve (se cargaría desde ${toPosix(path.relative(REPO_ROOT, target))}): ${name}`);
        else node.warnings.push(`require opcional no instalado (no se carga): ${name}`);
        continue;
      }
      if (!target) {
        addProblem(`T-11a: no se pudo resolver el paquete ${spec}`);
        continue;
      }
      const real = realpathSync(target);
      node.edges.push({ ...edge, resolved: real });
      queue.push({ file: real, phase1: phase1 && !edge.dynamic });
    }
  }
  return { entry: entryAbs, ownRoot, nodes, problems };
}

export function checkT11a(graph) {
  return graph.problems.filter((p) => p.startsWith('T-11a'));
}

export function checkT11b(graph, blocklist = BLOCKLIST) {
  const hits = [];
  const idRes = blocklist.identifiers.map((id) => [id, new RegExp(`(?<![A-Za-z0-9_$])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`)]);
  const patRes = (blocklist.patterns ?? []).map((p) => [p, new RegExp(p)]);
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'own' || node.raw === undefined) continue;
    const rel = toPosix(path.relative(REPO_ROOT, node.file));
    for (const [id, re] of idRes) if (re.test(node.raw)) hits.push(`T-11b: símbolo prohibido ${id} en ${rel}`);
    for (const p of blocklist.paths) if (node.raw.includes(p)) hits.push(`T-11b: ruta prohibida ${p} en ${rel}`);
    for (const [p, re] of patRes) if (re.test(node.raw)) hits.push(`T-11b: patrón prohibido /${p}/ en ${rel}`);
  }
  return [...new Set(hits)];
}

export function checkT11c(graph, inventoryText) {
  const inv = parseInventory(inventoryText);
  const hits = [];
  if (inv.flagged.size === 0) hits.push('T-11c: el inventario no tiene módulos marcados (¿inventario vacío o ilegible?)');
  for (const node of graph.nodes.values()) {
    const noExt = node.file.replace(/\.(d\.ts|[cm]?[jt]sx?|json)$/, '');
    if (isInside(node.file, LEGACY_SRC)) {
      const id = toPosix(path.relative(LEGACY_SRC, noExt));
      if (inv.flagged.has(id)) hits.push(`T-11c: módulo marcado ${id} [${inv.flagged.get(id).all.join(',')}] en el grafo`);
      continue;
    }
    if (node.kind !== 'own') continue;
    const rel = toPosix(path.relative(graph.ownRoot, noExt));
    for (const [id, info] of inv.flagged) {
      if (!id.includes('/')) continue;
      if (rel === id || rel.endsWith(`/${id}`)) hits.push(`T-11c: copia del módulo marcado ${id} [${info.all.join(',')}] en ${rel}`);
    }
  }
  return [...new Set(hits)];
}

export function summarize(graph) {
  const own = [];
  const pkgs = new Map();
  const builtinsOwn = new Set();
  const builtinsPkg = new Set();
  let dynamicEdges = [];
  const optional = new Set();
  for (const n of graph.nodes.values()) {
    if (n.kind === 'own') {
      own.push(`${toPosix(path.relative(graph.ownRoot, n.file))}${n.phase1 ? ' [fase 1]' : ' [fase 2]'}`);
      n.builtins.forEach((b) => builtinsOwn.add(b));
      for (const e of n.edges) if (e.dynamic) dynamicEdges.push(`${toPosix(path.relative(graph.ownRoot, n.file))} -> import('${e.spec}')`);
    } else if (n.kind === 'package') {
      pkgs.set(n.pkg, (pkgs.get(n.pkg) ?? 0) + 1);
      n.builtins.forEach((b) => builtinsPkg.add(b));
      for (const w of n.warnings) if (w.startsWith('require opcional')) optional.add(`${n.pkg}: ${w}`);
    }
  }
  return {
    own: own.sort(),
    packages: [...pkgs.keys()].sort(),
    builtinsOwn: [...builtinsOwn].sort(),
    builtinsPackages: [...builtinsPkg].sort(),
    dynamicEdges: dynamicEdges.sort(),
    optionalMissing: [...optional].sort(),
  };
}

async function cli(argv) {
  const entry = path.resolve(argv.find((a) => !a.startsWith('--')) ?? path.join(PACKAGE_ROOT, 'dist', 'main.js'));
  if (!existsSync(entry)) {
    process.stderr.write(`check-graph: no existe ${entry} (ejecuta npm run build)\n`);
    return 2;
  }
  const graph = buildGraph(entry);
  const inventoryText = readFileSync(INVENTORY_FILE, 'utf8');
  const a = checkT11a(graph);
  const b = checkT11b(graph);
  const c = checkT11c(graph, inventoryText);
  const s = summarize(graph);
  const out = [];
  out.push(`check-graph: entrada ${toPosix(path.relative(REPO_ROOT, entry))}`);
  out.push(`  archivos propios (${s.own.length}): ${s.own.join(', ')}`);
  out.push(`  imports dinámicos seguidos: ${s.dynamicEdges.join('; ') || '-'}`);
  out.push(`  builtins en archivos propios: ${s.builtinsOwn.join(', ') || '-'}`);
  out.push(`  paquetes alcanzados (${s.packages.length}, todos en el cierre de producción del lockfile): ${s.packages.join(', ')}`);
  out.push(`  builtins usados por paquetes: ${s.builtinsPackages.join(', ') || '-'}`);
  out.push(`  avisos: ${s.optionalMissing.join('; ') || '-'}`);
  out.push(`  T-11a: ${a.length === 0 ? 'OK' : `FALLA (${a.length})`}`);
  out.push(`  T-11b: ${b.length === 0 ? 'OK' : `FALLA (${b.length})`}`);
  out.push(`  T-11c: ${c.length === 0 ? `OK (inventario ${parseInventory(inventoryText).commit}, ${parseInventory(inventoryText).flagged.size} módulos marcados)` : `FALLA (${c.length})`}`);
  for (const p of [...a, ...b, ...c]) out.push(`  - ${p}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return a.length + b.length + c.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`check-graph: error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
