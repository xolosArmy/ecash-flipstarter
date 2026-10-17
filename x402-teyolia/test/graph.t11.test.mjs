// T-11a / T-11b / T-11c con controles negativos (Auditor P4-L2): cada verificador DEBE
// rechazar un fixture construido para violarlo, y el bundle real debe pasar.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { FIXTURES, PACKAGE_ROOT } from './helpers.mjs';
import { BLOCKLIST, buildGraph, checkT11a, checkT11b, checkT11c, loadExceptions, lockfileClosure } from '../scripts/check-graph.mjs';
import { INVENTORY_FILE } from '../scripts/inventory.mjs';

const LOCK = lockfileClosure(path.join(PACKAGE_ROOT, 'package-lock.json'));
const INVENTORY = readFileSync(INVENTORY_FILE, 'utf8');
const fx = (name) => {
  const ownRoot = path.join(FIXTURES, 't11', name);
  // Fixtures sintéticos: lista de excepciones vacía (no alcanzan express/lib/view.js salvo a-phase1-express).
  return buildGraph(path.join(ownRoot, 'main.js'), { ownRoot, lock: LOCK, exceptions: [] });
};

describe('bundle real dist/main.js', () => {
  const graph = buildGraph(path.join(PACKAGE_ROOT, 'dist', 'main.js'));
  test('T-11a: sin problemas; sigue import(\'./server.js\'); Express solo en fase 2', () => {
    assert.deepEqual(checkT11a(graph), []);
    const server = [...graph.nodes.values()].find((n) => n.file.endsWith(path.join('dist', 'server.js')));
    assert.ok(server, 'server.js está en el grafo (import dinámico seguido)');
    assert.equal(server.phase1, false);
    const main = graph.nodes.get(path.join(PACKAGE_ROOT, 'dist', 'main.js'));
    assert.ok(main.edges.some((e) => e.dynamic && e.spec === './server.js'));
    const express = [...graph.nodes.values()].find((n) => n.kind === 'package' && n.pkg === 'express');
    assert.ok(express, 'express alcanzado');
    for (const n of graph.nodes.values()) if (n.kind === 'package') assert.equal(n.phase1, false, `${n.pkg} fuera de fase 1`);
  });
  test('T-11a: los paquetes alcanzados son exactamente parte del cierre de producción del lockfile', () => {
    const pkgs = new Set([...graph.nodes.values()].filter((n) => n.kind === 'package').map((n) => n.pkg));
    for (const p of pkgs) assert.ok(LOCK.names.has(p), p);
    assert.ok(!pkgs.has('typescript') && !pkgs.has('@types/node'));
  });
  test('T-11b: ningún símbolo de la lista negativa', () => assert.deepEqual(checkT11b(graph), []));
  test('T-11c: ningún módulo marcado del inventario', () => assert.deepEqual(checkT11c(graph, INVENTORY), []));
  test('la lista negativa vive fuera de src/ y dist/', () => {
    for (const dir of ['src', 'dist']) {
      for (const f of readdirSync(path.join(PACKAGE_ROOT, dir))) {
        const text = readFileSync(path.join(PACKAGE_ROOT, dir, f), 'utf8');
        for (const id of BLOCKLIST.identifiers) assert.ok(!text.includes(id), `${dir}/${f} contiene ${id}`);
      }
    }
  });
});

describe('T-11a negativos', () => {
  const cases = [
    ['a-legacy-import', /fuera del paquete x402: backend\/src\/services\/RefundService\.ts \(backend legacy\)/],
    ['a-dynamic-pkg', /paquete no permitido.*: dotenv/],
    ['a-nonliteral', /import\(\) dinámico con especificador no literal/],
    ['a-builtin', /builtin no enumerado en archivo propio: node:child_process/],
    ['a-phase1-express', /fase 1: el paquete express se carga antes del guard/],
    ['a-opaque', /carga de código opaca: createRequire/],
  ];
  for (const [name, re] of cases) {
    test(`${name} es rechazado`, () => {
      const problems = checkT11a(fx(name));
      assert.ok(problems.some((p) => re.test(p)), `esperado ${re}; obtenido ${JSON.stringify(problems)}`);
    });
  }
  test('a-dynamic-pkg: el verificador siguió dos import() dinámicos', () => {
    const g = fx('a-dynamic-pkg');
    assert.ok([...g.nodes.keys()].some((f) => f.endsWith('phase2.js')));
  });
});

describe('T-11b negativos', () => {
  const cases = [
    ['b-broadcast', /símbolo prohibido broadcastRawTx/],
    ['b-sign-dynamic', /símbolo prohibido signHybridPayoutTx en .*late\.js/],
    ['b-routes', /ruta prohibida refund\.routes/],
  ];
  for (const [name, re] of cases) {
    test(`${name} es rechazado (y T-11a no lo detecta: el control es independiente)`, () => {
      const g = fx(name);
      assert.deepEqual(checkT11a(g), []);
      const hits = checkT11b(g);
      assert.ok(hits.some((h) => re.test(h)), `esperado ${re}; obtenido ${JSON.stringify(hits)}`);
    });
  }
});

describe('T-11c negativos', () => {
  test('c-transmite: importa blockchain/ecashClient (marcado TRANSMITE en el inventario)', () => {
    const hits = checkT11c(fx('c-transmite'), INVENTORY);
    assert.ok(hits.some((h) => /módulo marcado blockchain\/ecashClient \[.*TRANSMITE.*\]/.test(h)), JSON.stringify(hits));
  });
  test('a-legacy-import: services/RefundService también lo rechaza T-11c', () => {
    const hits = checkT11c(fx('a-legacy-import'), INVENTORY);
    assert.ok(hits.some((h) => /módulo marcado services\/RefundService/.test(h)), JSON.stringify(hits));
  });
  test('c-copy: copia local con el sufijo de un módulo marcado; T-11a no la ve, T-11c sí', () => {
    // (T-11b también la detecta por el especificador del import: capas superpuestas.)
    const g = fx('c-copy');
    assert.deepEqual(checkT11a(g), []);
    const hits = checkT11c(g, INVENTORY);
    assert.ok(hits.some((h) => /copia del módulo marcado blockchain\/ecashClient/.test(h)), JSON.stringify(hits));
  });
  test('inventario vacío -> falla (no pasa trivialmente)', () => {
    const g = buildGraph(path.join(PACKAGE_ROOT, 'dist', 'main.js'));
    assert.ok(checkT11c(g, '').length > 0);
  });
});

// ---------------------------------------------------------------------------------------
// PR-2 commit 1: T-11a endurecido (Auditor, dictamen sobre la propuesta T-11a: n1–n8,
// L1P-L3). Los árboles con node_modules se generan en tmp (node_modules está en .gitignore).
// ---------------------------------------------------------------------------------------
const TMP = mkdtempSync(path.join(tmpdir(), 'x402-t11a-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
function write(file, text) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
/** Paquete sintético: main.js (propio) -> import('fakepkg') en fase 2; lockfile propio. */
function synthetic({ fakeIndex, lockExtra = {}, parentPkgs = {}, linkMs = false }) {
  const base = path.join(TMP, `case-${++seq}`);
  const pkg = path.join(base, 'pkg');
  write(path.join(pkg, 'main.js'), "await import('fakepkg');\n");
  const packages = { '': { dependencies: { fakepkg: '1.0.0' } }, 'node_modules/fakepkg': { version: '1.0.0' }, ...lockExtra };
  write(path.join(pkg, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  write(path.join(pkg, 'node_modules', 'fakepkg', 'package.json'), JSON.stringify({ name: 'fakepkg', version: '1.0.0', main: 'index.js' }));
  write(path.join(pkg, 'node_modules', 'fakepkg', 'index.js'), fakeIndex);
  for (const [name, code] of Object.entries(parentPkgs)) {
    write(path.join(base, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    write(path.join(base, 'node_modules', name, 'index.js'), code);
  }
  if (linkMs) {
    write(path.join(base, 'outside', 'ms', 'package.json'), JSON.stringify({ name: 'ms', version: '2.1.3', main: 'index.js' }));
    write(path.join(base, 'outside', 'ms', 'index.js'), 'module.exports = 1;\n');
    symlinkSync(path.join(base, 'outside', 'ms'), path.join(pkg, 'node_modules', 'ms'), 'dir');
  }
  const g = buildGraph(path.join(pkg, 'main.js'), { ownRoot: pkg, containRoot: pkg, lock: lockfileClosure(path.join(pkg, 'package-lock.json')), exceptions: [] });
  return { g, base, pkg };
}
const expectA = (g, re) => {
  const problems = checkT11a(g);
  assert.ok(problems.some((p) => re.test(p)), `esperado ${re}; obtenido ${JSON.stringify(problems)}`);
};

describe('T-11a endurecido (PR-2 commit 1)', () => {
  test('n1: require opcional fuera del lockfile, sin padre -> rechazado (antes: aviso)', () => {
    const { g } = synthetic({ fakeIndex: "try { require('absent-x'); } catch (e) {}\nmodule.exports = 1;\n" });
    expectA(g, /optional-absent no revisado en fakepkg@1\.0\.0:index\.js:1 \(absent-x\)/);
  });
  test('n2: el mismo require con un node_modules padre que lo tiene -> rechazado', () => {
    const { g } = synthetic({ fakeIndex: "try { require('absent-x'); } catch (e) {}\nmodule.exports = 1;\n", parentPkgs: { 'absent-x': 'module.exports = 2;\n' } });
    expectA(g, /fuera del lockfile que SÍ se resuelve.*absent-x/);
  });
  test('n3: require no literal en un paquete, no listado -> rechazado', () => {
    const { g } = synthetic({ fakeIndex: "const m = 'x';\nmodule.exports = require(m);\n" });
    expectA(g, /require-no-literal no revisado en fakepkg@1\.0\.0:index\.js:2 \(m\)/);
  });
  test('n3b: cargador opaco en un paquete (module.require / createRequire / process.mainModule) -> rechazado', () => {
    const { g } = synthetic({ fakeIndex: "module.exports = module.require('fs');\n" });
    expectA(g, /opaque no revisado en fakepkg/);
  });
  // P2-L3 (dictamen Auditor Plan PR-2): createRequire precedido de punto y Module._load.
  for (const [label, code] of [
    ['module.createRequire', "module.exports = module.createRequire(__filename)('fs');\n"],
    ['Module.createRequire', "const Module = require('node:module');\nmodule.exports = Module.createRequire(__filename)('fs');\n"],
    ['Module._load', "const Module = require('node:module');\nmodule.exports = Module._load('fs');\n"],
    ["require('module')._load", "module.exports = require('module')._load('fs');\n"],
  ]) {
    test(`n3c: cargador opaco ${label} en un paquete -> rechazado`, () => {
      const { g } = synthetic({ fakeIndex: code });
      expectA(g, /opaque no revisado en fakepkg@1\.0\.0:index\.js:\d+ \((?:createRequire|_load)\)/);
    });
  }
  // P2a-L2: los 12 casos de load_cases.mjs (sha256 0f93c3e5…25a9) con su resultado esperado bajo el
  // patrón propuesto, más _resolveFilename / _compile. `true` = rechazado como opaque.
  for (const [label, code, rejected] of [
    ['Module._load(', "const M=require('module');M._load('fs')", true],
    ["require('module') . _load ('fs') (espacios)", "require('module') . _load ('fs')", true],
    ["Module['_load']", "const M=require('module');M['_load']('fs')", true],
    ['alias const {_load}', "const {_load}=require('module');_load('fs')", true],
    ['alias l=M._load; l()', "const M=require('module');const l=M._load;l('fs')", true],
    ['globalThis.process.mainModule', "globalThis.process.mainModule.require('fs')", true],
    ["process['mainModule']", "process['mainModule'].require('fs')", true],
    ["Reflect.get(M,'_lo'+'ad') (indetectable estáticamente; residual documentado)", "Reflect.get(require('module'),'_lo'+'ad')('fs')", false],
    ['método de clase this._load( (falso positivo aceptado, fail-closed)', 'class C{_load(x){return x} run(){return this._load(1)}}', true],
    ["string 'x._load(' (falso positivo aceptado, fail-closed)", "const s='x._load(1)'", true],
    ['comentario // M._load(', "// M._load('fs')\nconst a=1", false],
    ['cache._loadAll(', 'cache._loadAll()', false],
    ['Module._resolveFilename', "const M=require('module');M._resolveFilename('fs', null)", true],
    ["Module['_compile']", "const M=require('module');new M()['_compile']('x','f')", true],
    ['m . _compile (espacios)', "module . _compile('x','f')", true],
  ]) {
    test(`P2a-L2 load_cases: ${label} -> ${rejected ? 'rechazado' : 'no rechazado'}`, () => {
      const { g } = synthetic({ fakeIndex: `${code};\nmodule.exports = 1;\n` });
      const opaque = checkT11a(g).some((p) => /opaque no revisado en fakepkg@1\.0\.0/.test(p));
      assert.equal(opaque, rejected);
    });
  }
  test('n4: paquete del lockfile que solo existe en el padre -> resuelto fuera del paquete', () => {
    const { g } = synthetic({
      fakeIndex: "module.exports = require('fakepkg2');\n",
      lockExtra: { 'node_modules/fakepkg2': { version: '1.0.0' } },
      parentPkgs: { fakepkg2: 'module.exports = 3;\n' },
    });
    expectA(g, /resuelto fuera del paquete: .*node_modules\/fakepkg2\/index\.js/);
  });
  test('n5: symlink en el node_modules propio que apunta fuera -> rechazado', () => {
    const { g } = synthetic({ fakeIndex: "module.exports = require('ms');\n", lockExtra: { 'node_modules/ms': { version: '2.1.3' } }, linkMs: true });
    expectA(g, /resuelto fuera del paquete: .*outside\/ms\/index\.js/);
  });
  test('n6: entrada por symlink que apunta fuera -> T-11a falla; T-11b y T-11c fallan con 0 archivos propios', () => {
    const base = path.join(TMP, `case-${++seq}`);
    write(path.join(base, 'outside', 'main.js'), 'export {};\n');
    mkdirSync(path.join(base, 'pkg'), { recursive: true });
    symlinkSync(path.join(base, 'outside', 'main.js'), path.join(base, 'pkg', 'main.js'));
    const g = buildGraph(path.join(base, 'pkg', 'main.js'), { ownRoot: path.join(base, 'pkg'), containRoot: path.join(base, 'pkg'), lock: LOCK, exceptions: [] });
    expectA(g, /resuelto fuera del paquete|módulo fuera del paquete/);
    assert.ok(checkT11b(g).some((h) => /0 archivos propios/.test(h)));
    assert.ok(checkT11c(g, INVENTORY).some((h) => /0 archivos propios/.test(h)));
  });
  test('n6b (positivo): el paquete visto por un directorio symlink da el mismo grafo (realpath de entrada y raíz)', () => {
    const link = path.join(TMP, `case-${++seq}-link`);
    symlinkSync(PACKAGE_ROOT, link, 'dir');
    const g = buildGraph(path.join(link, 'dist', 'main.js'));
    assert.deepEqual(checkT11a(g), []);
    assert.equal([...g.nodes.values()].filter((n) => n.kind === 'own').length, 12); // PR-3: + grant-db, invoice-store, persistence-config; PR-4: + sqlite-wal, reconcile, issuance-limit, trust-proxy
  });
  test('n7: excepción que ya no coincide (SHA-256 o línea) -> falla', () => {
    const [e] = loadExceptions();
    const badSha = buildGraph(path.join(PACKAGE_ROOT, 'dist', 'main.js'), { exceptions: [{ ...e, sha256: '0'.repeat(64) }] });
    expectA(badSha, /excepción que ya no coincide/);
    const badLine = buildGraph(path.join(PACKAGE_ROOT, 'dist', 'main.js'), { exceptions: [{ ...e, line: e.line + 1 }] });
    expectA(badLine, /require-no-literal no revisado en express@5\.2\.1:lib\/view\.js:81/);
  });
  test('n8: excepción que ya no aparece en el grafo -> falla (sin entradas obsoletas)', () => {
    const extra = { package: 'no-existe', version: '1.0.0', file: 'index.js', line: 1, kind: 'opaque', spec: 'x', sha256: '0'.repeat(64), justification: 'n8' };
    const g = buildGraph(path.join(PACKAGE_ROOT, 'dist', 'main.js'), { exceptions: [...loadExceptions(), extra] });
    expectA(g, /excepción obsoleta.*no-existe/);
  });
  test('la lista real de excepciones de la superficie main es exactamente la revisada y se usa entera', () => {
    const g = buildGraph(path.join(PACKAGE_ROOT, 'dist', 'main.js'));
    assert.deepEqual(g.usedExceptions.map((e) => `${e.package}@${e.version}:${e.file}:${e.line}:${e.kind}`).sort(), [
      'depd@2.0.0:index.js:425:codegen',
      'express@5.2.1:lib/view.js:81:require-no-literal',
      'function-bind@1.1.2:implementation.js:74:codegen',
      'get-intrinsic@1.3.0:index.js:23:codegen',
      'get-intrinsic@1.3.0:index.js:91:codegen',
      // PR-3: zod alcanzado desde main por @x402-xec/core/sqlite (mismas entradas que vendor).
      'zod@4.4.3:v4/core/doc.js:28:codegen',
      'zod@4.4.3:v4/core/util.js:156:codegen',
    ]);
  });
  test('supports-color 8.1.1 y has-flag 4.0.0 están en el cierre de producción (require opcional no declarado de debug, src/node.js:32)', () => {
    assert.equal(LOCK.entries.get('node_modules/supports-color')?.version, '8.1.1');
    assert.equal(LOCK.entries.get('node_modules/has-flag')?.version, '4.0.0');
    assert.ok(LOCK.directDeps.has('supports-color'));
  });
});

// ---------------------------------------------------------------------------------------
// PR-2b C4 (dictamen PR-2 P2-L4; I-4): ESM en paquetes, condiciones `import`, codegen y la
// superficie vendorizada. Paquetes ESM sintéticos en tmp.
// ---------------------------------------------------------------------------------------
import { ESM_CONDITIONS, SURFACES, resolveEsm } from '../scripts/check-graph.mjs';

function syntheticEsm({ pkgJson = {}, files, parentPkgs = {}, lockExtra = {}, exceptions = [] }) {
  const base = path.join(TMP, `esm-${++seq}`);
  const pkg = path.join(base, 'pkg');
  write(path.join(pkg, 'main.js'), "await import('fakepkg');\n");
  const packages = { '': { dependencies: { fakepkg: '1.0.0' } }, 'node_modules/fakepkg': { version: '1.0.0' }, ...lockExtra };
  write(path.join(pkg, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  const dir = path.join(pkg, 'node_modules', 'fakepkg');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'fakepkg', version: '1.0.0', type: 'module', ...pkgJson }));
  for (const [f, code] of Object.entries(files)) write(path.join(dir, f), code);
  for (const [name, { json = {}, code }] of Object.entries(parentPkgs)) {
    write(path.join(base, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js', ...json }));
    write(path.join(base, 'node_modules', name, 'index.js'), code);
  }
  const g = buildGraph(path.join(pkg, 'main.js'), { ownRoot: pkg, containRoot: pkg, lock: lockfileClosure(path.join(pkg, 'package-lock.json')), exceptions });
  return { g, base, pkg, dir };
}

describe('T-11a ESM (PR-2b C4)', () => {
  test('e1: import() no literal en un paquete ESM -> rechazado', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "const n = 'x';\nexport default await import(n);\n" } });
    expectA(g, /import-no-literal no revisado en fakepkg@1\.0\.0:index\.js:2 \(n\)/);
  });
  test('e2: export * from un paquete que solo está en el padre -> rechazado (SÍ se resuelve fuera)', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "export * from 'pkg-fuera';\n" }, parentPkgs: { 'pkg-fuera': { code: 'export const a = 1;\n' } } });
    expectA(g, /fuera del lockfile que SÍ se resuelve.*pkg-fuera/);
  });
  test('e2b: export { a } from un paquete del lock presente solo en el padre -> resuelto fuera del paquete', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "export { a } from 'pkg-lock';\n" }, lockExtra: { 'node_modules/pkg-lock': { version: '1.0.0' } }, parentPkgs: { 'pkg-lock': { code: 'export const a = 1;\n' } } });
    expectA(g, /resuelto fuera del paquete: .*node_modules\/pkg-lock\/index\.js/);
  });
  test('e3: import.meta.resolve en un paquete -> rechazado (opaque)', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "export const u = import.meta.resolve('./x.js');\n" } });
    expectA(g, /opaque no revisado en fakepkg@1\.0\.0:index\.js:1 \(import\.meta\.resolve\)/);
  });
  test('e4: module.register / import { register } from node:module en un paquete -> rechazado', () => {
    const a = syntheticEsm({ files: { 'index.js': "import module from 'node:module';\nmodule.register('./hook.js', import.meta.url);\n" } });
    expectA(a.g, /opaque no revisado en fakepkg@1\.0\.0:index\.js:2 \(module\.register\)/);
    const b = syntheticEsm({ files: { 'index.js': "import { register } from 'node:module';\nregister('./hook.js', import.meta.url);\n" } });
    expectA(b.g, /opaque no revisado en fakepkg@1\.0\.0:index\.js:1 \(import \{ register \} from 'node:module'\)/);
  });
  test('e5 (I-4): exports solo con condición require, importado desde ESM -> no resuelve (createRequire sí lo habría resuelto)', () => {
    const { g } = syntheticEsm({ pkgJson: { exports: { '.': { require: './index.cjs' } } }, files: { 'index.cjs': 'module.exports = 1;\n' } });
    expectA(g, /no se pudo resolver el paquete fakepkg/);
  });
  test('e6: generación de código sin excepción (new Function, Function(), alias, eval) -> rechazado', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "export const a = new Function('return 1');\nconst F = Function;\nexport const b = eval('1');\nexport const c = Function('return 2');\n" } });
    for (const [line, spec] of [[1, 'new Function'], [2, '= Function'], [3, 'eval'], [4, 'Function']]) expectA(g, new RegExp(`codegen no revisado en fakepkg@1\\.0\\.0:index\\.js:${line} \\(${spec}\\)`));
  });
  test('e6b: texto "Function(" dentro de un string o comentario no cuenta como codegen', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "// new Function('x')\nexport const s = 'new Function(1)';\n" } });
    assert.deepEqual(checkT11a(g), []);
  });
  // Codex #64 r4295643573 (P2): formas indirectas de Function/eval -> codegen no revisado.
  for (const [label, code] of [
    ['Function.call(null, src)', "export const f = Function.call(null, 'return 1');\n"],
    ['Function.apply(null, [src])', "export const f = Function.apply(null, ['return 1']);\n"],
    ['Function.bind(null)', "export const F = Function.bind(null);\n"],
    ['Function?.call(…) / Function.call?.(…)', "export const f = Function?.call(null, 'return 1');\nexport const g = Function.call?.(null, 'return 1');\n"],
    ['Reflect.construct(Function, [src])', "export const f = Reflect.construct(Function, ['return 1']);\n"],
    ['Reflect.apply(Function, null, [src])', "export const f = Reflect.apply(Function, null, ['return 1']);\n"],
    ['eval?.(src)', "export const v = eval?.('1');\n"],
    ['eval.call(null, src)', "export const v = eval.call(null, '1');\n"],
    ['new Function sin paréntesis', 'export const f = new Function;\n'],
    ['Function?.(src)', "export const f = Function?.('return 1');\n"],
  ]) {
    test(`Codex #64 codegen: ${label} en un paquete -> rechazado`, () => {
      const { g } = syntheticEsm({ files: { 'index.js': code } });
      expectA(g, /codegen no revisado en fakepkg@1\.0\.0:index\.js:1 /);
    });
  }
  test('Codex #64 codegen (controles negativos): código legítimo no cuenta como codegen', () => {
    const { g } = syntheticEsm({ files: { 'index.js': [
      'export const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);',
      'export const bindP = Function.prototype.bind;',
      'export const callP = Function.prototype.call.call(Object.prototype.toString, 1);',
      'export const isFn = (x) => x instanceof Function;',
      'export const t = (f) => typeof f === "function" && f.call(null) && f.apply(null, []);',
      'export const o = { evaluate() { return 1; } };',
      'export const r = Reflect.construct(Date, []);',
      'export const s = "Function.call(null, 1) eval?.(1) Reflect.construct(Function, [])";',
      '// Function.call(null, "x"); eval?.("1")',
      '',
    ].join('\n') } });
    assert.deepEqual(checkT11a(g), []);
  });
  test('e7 (positivo): exports con import/require elige la rama import; patrones * y subrutas', () => {
    const { g, dir } = syntheticEsm({
      pkgJson: { exports: { '.': { require: './cjs.cjs', import: './esm.js' }, './sub/*': { import: './lib/*.js' } } },
      files: { 'esm.js': "export * from 'fakepkg/sub/b';\n", 'cjs.cjs': 'module.exports = 1;\n', 'lib/b.js': 'export const b = 1;\n' },
    });
    assert.deepEqual(checkT11a(g), []);
    const files = [...g.nodes.values()].filter((n) => n.kind === 'package').map((n) => path.relative(dir, n.file)).sort();
    assert.deepEqual(files, ['esm.js', path.join('lib', 'b.js')]);
    assert.deepEqual(ESM_CONDITIONS, ['node', 'import', 'default']);
  });
  test('e8 (n7 codegen): alias o constructLine que ya no coinciden -> falla', () => {
    const code = "const F = Function;\nexport const f = () => new F('return 1');\n";
    const files = { 'index.js': code };
    const ok = { surface: 'main', package: 'fakepkg', version: '1.0.0', file: 'index.js', line: 1, kind: 'codegen', spec: '= Function', alias: 'F', constructLine: 2, justification: 'e8' };
    const sha = createHash('sha256').update(code).digest('hex');
    assert.deepEqual(checkT11a(syntheticEsm({ files, exceptions: [{ ...ok, sha256: sha }] }).g), []);
    expectA(syntheticEsm({ files, exceptions: [{ ...ok, sha256: sha, constructLine: 1 }] }).g, /excepción que ya no coincide \(constructLine 1\)/);
    expectA(syntheticEsm({ files, exceptions: [{ ...ok, sha256: sha, alias: 'G' }] }).g, /excepción que ya no coincide \(constructLine 2\)/);
  });
  test('e9: especificador #imports en un paquete -> falla cerrado', () => {
    const { g } = syntheticEsm({ files: { 'index.js': "import x from '#internal';\nexport default x;\n" } });
    expectA(g, /especificador de imports \(#\) no soportado: #internal/);
  });
  test('resolveEsm resuelve la superficie vendorizada con condiciones import (no CJS)', () => {
    const from = path.join(PACKAGE_ROOT, SURFACES.vendor);
    assert.equal(path.relative(PACKAGE_ROOT, resolveEsm('@x402-xec/express', from)), path.join('node_modules', '@x402-xec', 'express', 'dist', 'index.js'));
    assert.equal(path.relative(PACKAGE_ROOT, resolveEsm('@x402-xec/core/sqlite', from)), path.join('node_modules', '@x402-xec', 'core', 'dist', 'sqlite-invoice-store.js'));
    assert.throws(() => createRequire(from).resolve('@x402-xec/express'), /ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main defined/);
  });
});

describe('superficie vendorizada (--surface vendor)', () => {
  const g = buildGraph(path.join(PACKAGE_ROOT, SURFACES.vendor), { surface: 'vendor' });
  test('T-11a/b/c OK; solo los 8 paquetes del cierre vendorizado; todo dentro del paquete', () => {
    assert.deepEqual(checkT11a(g), []);
    assert.deepEqual(checkT11b(g), []);
    assert.deepEqual(checkT11c(g, INVENTORY), []);
    const pkgs = [...new Set([...g.nodes.values()].filter((n) => n.kind === 'package').map((n) => n.pkg))].sort();
    assert.deepEqual(pkgs, ['@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32', '@x402-xec/core', '@x402-xec/express', 'ecashaddrjs', 'zod']);
  });
  test('excepciones de la superficie vendor: exactamente zod doc.js:28→33 y util.js:156→157', () => {
    assert.deepEqual(g.usedExceptions.map((e) => `${e.package}@${e.version}:${e.file}:${e.line}→${e.constructLine}:${e.kind}`).sort(), [
      'zod@4.4.3:v4/core/doc.js:28→33:codegen',
      'zod@4.4.3:v4/core/util.js:156→157:codegen',
    ]);
  });
  test('n8 en vendor: excepción vendor sin uso -> obsoleta', () => {
    const extra = { surface: 'vendor', package: 'zod', version: '4.4.3', file: 'v4/core/no-existe.js', line: 1, kind: 'codegen', spec: 'x', sha256: '0'.repeat(64), justification: 'n8' };
    expectA(buildGraph(path.join(PACKAGE_ROOT, SURFACES.vendor), { surface: 'vendor', exceptions: [...loadExceptions(), extra] }), /excepción obsoleta.*no-existe/);
  });
});
