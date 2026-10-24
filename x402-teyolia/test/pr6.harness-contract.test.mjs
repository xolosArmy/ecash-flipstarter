// PR-6 — contrato del arnés de aislamiento y del paso de CI (D-P6-1 (a), PM6-05; Fernando
// 2026-10-24 09:21 CDMX; P6C-01 endurecido por la decisión de 11:28). Corre SIN privilegios dentro
// de `npm test`: el arnés falla cerrado si no es root, y el workflow mantiene un único paso de
// aislamiento dentro del job requerido; la guarda es test/isolation/workflow-guard.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { PACKAGE_ROOT } from './helpers.mjs';
import { REPO_ROOT } from '../scripts/inventory.mjs';
import { rootScriptViolations, workflowViolations } from './isolation/workflow-guard.mjs';

const ISO = path.join(PACKAGE_ROOT, 'test', 'isolation');
const HARNESS = path.join(ISO, 'harness.sh');
const WORKFLOW = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'x402-ta2.yml'), 'utf8');
const read = (f) => readFileSync(path.join(ISO, f), 'utf8');
// P6D-02: sha256 del archivo de pines. Vive AQUÍ (no en root-pins.sha256 ni en el workflow) para evitar
// la circularidad: root-pins.sha256 fija el workflow y los scripts root; este test fija root-pins.sha256.
// Cualquier cambio del workflow o de un script root obliga a regenerar ambos en el mismo diff auditado.
const ROOT_PINS_SHA256 = 'e2150851112ba799b373d1e4bdb1b74baf11fbeeadf857836bf10ed569042e4b';
const ROOT_PINNED = [
  '../.github/workflows/x402-ta2.yml', 'test/isolation/harness.sh', 'test/isolation/inner.sh', 'test/isolation/driver.mjs',
  'test/isolation/probe.mjs', 'test/isolation/listener.mjs', 'test/isolation/app-adapters.mjs', 'test/isolation/egress.nft',
  'test/isolation/nft-pin.sh', 'test/isolation/nft-pin.lock', 'test/fixtures/x402/c3b-client.mjs', 'test/fixtures/x402/chronik-fixtures.mjs',
];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ROOT_SCRIPTS = ['harness.sh', 'inner.sh', 'driver.mjs', 'probe.mjs', 'listener.mjs', 'app-adapters.mjs', 'nft-pin.sh'];

describe('arnés test/isolation (contrato)', () => {
  test('sin root falla cerrado (exit 1, «requiere root»); no se omite', { skip: process.getuid?.() === 0 && 'corriendo como root' }, () => {
    const r = spawnSync('bash', [HARNESS], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /requiere root/);
  });
  test('harness.sh: set -euo pipefail, namespaces desechables y verificación de host antes/después', () => {
    const h = read('harness.sh');
    assert.match(h, /^set -euo pipefail$/m);
    assert.match(h, /unshare --mount --net --pid --fork --mount-proc --propagation private/);
    for (const v of ['nft --version', 'uname -r', 'ImageVersion', 'uid=']) assert.ok(h.includes(v), v);
    assert.match(h, /HOST_RULESET_BEFORE.*\n[\s\S]*\[ "\$HOST_RULESET_BEFORE" = "\$HOST_RULESET_AFTER" \] \|\| fail/);
    assert.match(h, /\[ "\$PASSWD_BEFORE" = "\$PASSWD_AFTER" \] \|\| fail/);
    // Fuera del netns el arnés solo LEE el ruleset (list ruleset) y la versión.
    const nftCalls = [...h.matchAll(/\$\("\$NFT_BIN" ([^)|]+)/g)].map((m) => m[1].trim());
    assert.deepEqual([...new Set(nftCalls)].sort(), ['--version', 'list ruleset 2>&1']);
    assert.ok(!/(?:^|[;&|]|\$\()\s*(?:sudo\s+|env\s+[^\n]*\s)?npm\s/m.test(h + read('inner.sh')), 'el arnés no ejecuta npm');
    assert.ok(!/useradd|adduser|\/etc\/passwd\s*[<>]|>>\s*\/etc\//.test(h + read('inner.sh')), 'no toca /etc/passwd');
  });
  test('política nft: tabla propia inet x402iso, sin flush global, contador de conexiones nuevas del uid x402', () => {
    const n = read('egress.nft');
    assert.ok(!/flush ruleset/.test(n));
    assert.match(n, /table inet x402iso/);
    assert.match(n, /meta skuid @X402_UID@ ct state new counter/);
    assert.match(n, /reject/);
    const d = read('driver.mjs');
    assert.match(d, /LEGACY_UID = 2001/); assert.match(d, /X402_UID = 2002/);
    assert.match(d, /--clear-groups/);
  });
});

describe('pines sha256 del workflow y de los scripts root (P6D-02)', () => {
  const pinsText = readFileSync(path.join(ISO, 'root-pins.sha256'));
  test('root-pins.sha256 tiene el sha256 fijado en este contrato', () => {
    assert.equal(sha256(pinsText), ROOT_PINS_SHA256);
  });
  test('root-pins.sha256 lista exactamente el workflow y los archivos root, en orden, formato sha256sum', () => {
    const lines = pinsText.toString('utf8').split('\n');
    assert.equal(lines.pop(), '');
    assert.deepEqual(lines.map((l) => l.slice(66)), ROOT_PINNED);
    for (const l of lines) assert.match(l, /^[0-9a-f]{64} {2}\S+$/);
  });
  test('cada archivo fijado coincide con su sha256 (workflow, harness.sh, inner.sh, driver.mjs, nft-pin.sh, …)', () => {
    for (const l of pinsText.toString('utf8').trim().split('\n')) {
      const [h, rel] = [l.slice(0, 64), l.slice(66)];
      assert.equal(sha256(readFileSync(path.join(PACKAGE_ROOT, rel))), h, `pin: ${rel}`);
    }
  });
  test('harness.sh verifica los pines antes de ejecutar y exige 1..22 / # pass 22 / # fail 0; el paso de CI los vuelve a exigir', () => {
    const h = read('harness.sh');
    assert.ok(h.indexOf('sha256sum --check --strict --quiet') < h.indexOf('bash "$PKG/test/isolation/inner.sh"'));
    for (const x of ['EXPECTED_TESTS=22', 'grep -Fxq "1..$EXPECTED_TESTS"', 'grep -Fxq "# fail 0"', 'grep -Fxq "# pass $EXPECTED_TESTS"']) assert.ok(h.includes(x), x);
    assert.match(read('inner.sh'), /sha256sum --check --strict --quiet/);
    for (const x of ["grep -Fx '1..22'", "grep -Fx '# fail 0'", 'sha256sum --check --strict test/isolation/root-pins.sha256']) assert.ok(WORKFLOW.includes(x), x);
  });
});

describe('workflow x402-ta2.yml (D-P6-1 (a); P6C-01)', () => {
  test('workflow real: 0 violaciones de la guarda (job único, nombre, ubuntu-24.04, permisos, paso exacto)', () => {
    assert.deepEqual(workflowViolations(WORKFLOW), []);
  });
  test('scripts root (harness.sh, inner.sh, driver/probe/listener/app-adapters, nft-pin.sh): 0 violaciones', () => {
    for (const f of ROOT_SCRIPTS) assert.deepEqual(rootScriptViolations(f, read(f)), [], f);
  });
  // Controles negativos en memoria: cada regresión de P6C-01 es detectada (y el original pasa arriba).
  const ISO_HARNESS = 'NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh';
  // Si el ancla no existe (workflow ya alterado), el caso falla en su propio test, no al declarar la suite.
  const mutate = (from, to) => (WORKFLOW.includes(from) ? WORKFLOW.replace(from, to) : null);
  const cases = [
    ['|| true en el arnés', mutate(ISO_HARNESS, `${ISO_HARNESS} || true`), ['or-true', 'paso-de-aislamiento-exacto']],
    ['|| true en otro paso', mutate('run: npm test\n', 'run: npm test || true\n'), ['or-true']],
    ['||true sin espacio', mutate('run: npm test\n', 'run: npm test ||true\n'), ['or-true']],
    ['set +e', mutate('          npm run check:dist\n', '          set +e\n          npm run check:dist\n'), ['set+e']],
    ['set +o errexit', mutate('          npm run check:dist\n', '          set +o errexit\n          npm run check:dist\n'), ['set+e']],
    ['exit 0 prematuro', mutate('          npm run check:dist\n', '          [ -n "${SKIP:-x}" ] && exit 0\n          npm run check:dist\n'), ['exit0']],
    ['if: false a nivel de job', mutate('    runs-on: ubuntu-24.04\n', '    if: ${{ false }}\n    runs-on: ubuntu-24.04\n'), ['if:']],
    ['if: false en el paso', mutate('        run: |\n          set -euo pipefail\n          sha256sum --check --strict', '        if: false\n        run: |\n          set -euo pipefail\n          sha256sum --check --strict'), ['if:', 'paso-de-aislamiento-exacto']],
    ['shell: bash {0} (quita -e)', mutate('        run: |\n          set -euo pipefail\n          sha256sum --check --strict', '        shell: bash {0}\n        run: |\n          set -euo pipefail\n          sha256sum --check --strict'), ['shell:']],
    ['continue-on-error', mutate('        run: |\n          set -euo pipefail\n          sha256sum --check --strict', '        continue-on-error: true\n        run: |\n          set -euo pipefail\n          sha256sum --check --strict'), ['continue-on-error']],
    ['on: con paths-ignore', mutate('  pull_request:\n', "  pull_request:\n    paths-ignore: ['x402-teyolia/**']\n"), ['on-sin-filtros']],
    ['sudo npm', mutate('run: npm test\n', 'run: sudo npm test\n'), ['npm-como-root: sudo npm test']],
    ['sudo -E env … bash -c "n\\pm"', mutate('run: npm ci --ignore-scripts\n', 'run: sudo -E env PATH="$PATH" bash -c "n\\pm ci"\n'), ['sudo-no-permitido: sudo -E env PATH="$PATH" bash -c "n\\pm ci"']],
    ['su -c npm', mutate('run: npm ci --ignore-scripts\n', "run: su root -c 'npm ci --ignore-scripts'\n"), ['escalada-root']],
    ['sudo npx', mutate('run: npm run typecheck\n', 'run: sudo -E npx tsc -p .\n'), ['npm-como-root: sudo -E npx tsc -p .']],
    ['saltarse nft-pin con apt directo', mutate('          bash test/isolation/nft-pin.sh install\n', '          sudo apt-get install -y nftables\n'), ['paso-de-aislamiento-exacto']],
  ];
  for (const [name, text, expected] of cases) {
    test(`control negativo P6C-01: ${name}`, () => {
      assert.ok(text !== null, `${name}: ancla ausente en el workflow`);
      const got = workflowViolations(text);
      for (const e of expected) assert.ok(got.some((g) => g === e || g.startsWith(e)), `${name}: esperado ${e}; obtenido ${JSON.stringify(got)}`);
    });
  }
  test('control negativo P6C-01: scripts root con npm, set +e, || true o fallback de apt', () => {
    const h = read('harness.sh');
    assert.ok(rootScriptViolations('harness.sh', h.replace('rc=0\n', 'rc=0\nnpm ci\n')).some((x) => x.endsWith('gestor-de-paquetes-node')));
    assert.ok(rootScriptViolations('harness.sh', h.replace('rc=0\n', 'rc=0\nset +e\n')).some((x) => x.endsWith('set+e')));
    assert.ok(rootScriptViolations('inner.sh', `${read('inner.sh')}cp a b || true\n`).some((x) => x.endsWith('or-true')));
    assert.ok(rootScriptViolations('driver.mjs', `${read('driver.mjs')}\nexecFileSync('npx', ['x']);\n`).some((x) => x.endsWith('gestor-de-paquetes-node')));
    const n = read('nft-pin.sh');
    const fb = n.replace('    verify_dir "$W/debs" $(expected_set "$W/plan.txt")\n', '    verify_dir "$W/debs" $(expected_set "$W/plan.txt") || sudo apt-get install -y nftables\n');
    assert.notEqual(fb, n);
    const fv = rootScriptViolations('nft-pin.sh', fb);
    assert.ok(fv.some((x) => x.includes('apt-no-permitido')) && fv.some((x) => x.includes('sudo-no-permitido')), JSON.stringify(fv));
  });
});
