// PR-6 — contrato del arnés de aislamiento y del paso de CI (D-P6-1 (a), PM6-05; Fernando
// 2026-10-24 09:21 CDMX; P6C-01 endurecido por la decisión de 11:28). Corre SIN privilegios dentro de `npm test`: el arnés falla cerrado si no
// es root, y el workflow mantiene un único paso de aislamiento dentro del job requerido.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

describe('workflow x402-ta2.yml (D-P6-1 (a); P6C-01)', () => {
  test('workflow real: 0 violaciones de la guarda (job único, nombre, ubuntu-24.04, permisos, paso exacto)', () => {
    assert.deepEqual(workflowViolations(WORKFLOW), []);
  });
  test('scripts root (harness.sh, inner.sh, driver/probe/listener/app-adapters, nft-pin.sh): 0 violaciones', () => {
    for (const f of ROOT_SCRIPTS) assert.deepEqual(rootScriptViolations(f, read(f)), [], f);
  });
  // Controles negativos en memoria: cada regresión de P6C-01 es detectada (y el original pasa arriba).
  const ISO_HARNESS = 'NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh';
  const mutate = (from, to) => { assert.ok(WORKFLOW.includes(from), `ancla ausente: ${from}`); return WORKFLOW.replace(from, to); };
  const cases = [
    ['|| true en el arnés', mutate(ISO_HARNESS, `${ISO_HARNESS} || true`), ['or-true', 'paso-de-aislamiento-exacto']],
    ['|| true en otro paso', mutate('run: npm test\n', 'run: npm test || true\n'), ['or-true']],
    ['||true sin espacio', mutate('run: npm test\n', 'run: npm test ||true\n'), ['or-true']],
    ['set +e', mutate('          npm run check:dist\n', '          set +e\n          npm run check:dist\n'), ['set+e']],
    ['set +o errexit', mutate('          npm run check:dist\n', '          set +o errexit\n          npm run check:dist\n'), ['set+e']],
    ['exit 0 prematuro', mutate('          npm run check:dist\n', '          [ -n "${SKIP:-x}" ] && exit 0\n          npm run check:dist\n'), ['exit0']],
    ['if: false a nivel de job', mutate('    runs-on: ubuntu-24.04\n', '    if: ${{ false }}\n    runs-on: ubuntu-24.04\n'), ['if:']],
    ['if: false en el paso', mutate('        run: |\n          set -euo pipefail\n          bash test/isolation/nft-pin.sh', '        if: false\n        run: |\n          set -euo pipefail\n          bash test/isolation/nft-pin.sh'), ['if:', 'paso-de-aislamiento-exacto']],
    ['shell: bash {0} (quita -e)', mutate('        run: |\n          set -euo pipefail\n          bash test/isolation/nft-pin.sh', '        shell: bash {0}\n        run: |\n          set -euo pipefail\n          bash test/isolation/nft-pin.sh'), ['shell:']],
    ['continue-on-error', mutate('        run: |\n          set -euo pipefail\n          bash test/isolation/nft-pin.sh', '        continue-on-error: true\n        run: |\n          set -euo pipefail\n          bash test/isolation/nft-pin.sh'), ['continue-on-error']],
    ['on: con paths-ignore', mutate('  pull_request:\n', "  pull_request:\n    paths-ignore: ['x402-teyolia/**']\n"), ['on-sin-filtros']],
    ['sudo npm', mutate('run: npm test\n', 'run: sudo npm test\n'), ['npm-como-root: sudo npm test']],
    ['sudo -E env … bash -c "n\\pm"', mutate('run: npm ci --ignore-scripts\n', 'run: sudo -E env PATH="$PATH" bash -c "n\\pm ci"\n'), ['sudo-no-permitido: sudo -E env PATH="$PATH" bash -c "n\\pm ci"']],
    ['su -c npm', mutate('run: npm ci --ignore-scripts\n', "run: su root -c 'npm ci --ignore-scripts'\n"), ['escalada-root']],
    ['sudo npx', mutate('run: npm run typecheck\n', 'run: sudo -E npx tsc -p .\n'), ['npm-como-root: sudo -E npx tsc -p .']],
    ['saltarse nft-pin con apt directo', mutate('          bash test/isolation/nft-pin.sh install\n', '          sudo apt-get install -y nftables\n'), ['paso-de-aislamiento-exacto']],
  ];
  for (const [name, text, expected] of cases) {
    test(`control negativo P6C-01: ${name}`, () => {
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
