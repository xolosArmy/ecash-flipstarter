// T-11a / T-11b / T-11c con controles negativos (Auditor P4-L2): cada verificador DEBE
// rechazar un fixture construido para violarlo, y el bundle real debe pasar.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { FIXTURES, PACKAGE_ROOT } from './helpers.mjs';
import { BLOCKLIST, buildGraph, checkT11a, checkT11b, checkT11c, lockfileClosure } from '../scripts/check-graph.mjs';
import { INVENTORY_FILE } from '../scripts/inventory.mjs';

const LOCK = lockfileClosure(path.join(PACKAGE_ROOT, 'package-lock.json'));
const INVENTORY = readFileSync(INVENTORY_FILE, 'utf8');
const fx = (name) => {
  const ownRoot = path.join(FIXTURES, 't11', name);
  return buildGraph(path.join(ownRoot, 'main.js'), { ownRoot, lock: LOCK });
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
