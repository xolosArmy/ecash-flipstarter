// PR-6a / P6C-06 (docs/pr6-aislamiento.md §5): el comentario de src/main.ts (limitación P-4/L3) ya no
// atribuye la barrera real a PR-6; la sitúa en el lanzador del host (G3-01 / G3-02, gate de TA-3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { PACKAGE_ROOT } from './helpers.mjs';

const header = () => {
  const src = readFileSync(path.join(PACKAGE_ROOT, 'src', 'main.ts'), 'utf8');
  return src.slice(0, src.indexOf('\nimport '));
};

describe('P6C-06: comentario de src/main.ts (P-4/L3)', () => {
  test('ya no dice que la barrera real sea el lanzador de PR-6', () => {
    const h = header().replace(/\n\/\/ ?/g, ' ');
    assert.ok(!/barrera real es el lanzador \(PR-6\)/.test(h), h);
  });
  test('sitúa la barrera en el lanzador del host: G3-01 y G3-02, precondiciones del gate de TA-3', () => {
    const h = header().replace(/\n\/\/ ?/g, ' ');
    assert.match(h, /P6C-06: la barrera real NO la aporta PR-6/);
    assert.match(h, /lanzador del host/);
    assert.match(h, /\(G3-01\)/);
    assert.match(h, /\(G3-02\)/);
    assert.match(h, /gate de TA-3/);
    assert.match(h, /detecta y rechaza el arranque, pero no lo\s+previene/);
  });
  test('el resto de main.ts no cambia: fase 1 solo node:* y ./env-guard.js', () => {
    const src = readFileSync(path.join(PACKAGE_ROOT, 'src', 'main.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['node:process', './env-guard.js']);
  });
});
