// PR-6 — contrato del arnés de aislamiento y del paso de CI (D-P6-1 (a), PM6-05; Fernando
// 2026-10-24 09:21 CDMX). Corre SIN privilegios dentro de `npm test`: el arnés falla cerrado si no
// es root, y el workflow mantiene un único paso de aislamiento dentro del job requerido.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { PACKAGE_ROOT } from './helpers.mjs';
import { REPO_ROOT } from '../scripts/inventory.mjs';

const ISO = path.join(PACKAGE_ROOT, 'test', 'isolation');
const HARNESS = path.join(ISO, 'harness.sh');
const WORKFLOW = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'x402-ta2.yml'), 'utf8');
const read = (f) => readFileSync(path.join(ISO, f), 'utf8');
const CODE = WORKFLOW.replace(/^\s*#.*$/gm, ''); // sin comentarios YAML de línea completa
const JOBS = CODE.slice(CODE.indexOf('\njobs:\n'));

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

describe('workflow x402-ta2.yml (D-P6-1 (a))', () => {
  test('un solo job requerido con el mismo nombre, runs-on ubuntu-24.04, permisos de solo lectura', () => {
    assert.equal([...JOBS.matchAll(/^  [\w-]+:\s*$/gm)].length, 1, 'un único job');
    assert.match(WORKFLOW, /^    name: x402-teyolia \(Node 22\.13\.1\)$/m);
    assert.match(WORKFLOW, /^    runs-on: ubuntu-24\.04$/m);
    assert.match(WORKFLOW, /^permissions:\n  contents: read\n/m);
    assert.match(WORKFLOW, /persist-credentials: false/);
  });
  test('un único paso de aislamiento, al final, fail-closed, sin secretos y sin npm como root', () => {
    const steps = CODE.split(/\n      - name: /).slice(1);
    const iso = steps.filter((s) => s.includes('test/isolation/harness.sh'));
    assert.equal(iso.length, 1);
    assert.equal(steps.at(-1), iso[0], 'es el último paso');
    assert.ok(!/continue-on-error/.test(CODE));
    assert.ok(!/^\s+if:/m.test(iso[0]), 'sin condición que lo omita');
    assert.ok(!/secrets\./.test(CODE));
    assert.ok(!/sudo[^\n]*\bnpm\b/.test(CODE), 'npm nunca con sudo');
    assert.match(iso[0], /NFT_PIN: '1\.0\.9-1ubuntu0\.1'/);
    assert.match(iso[0], /nftables=\$NFT_PIN/);
    assert.match(iso[0], /if \[ "\$got" != "\$NFT_PIN" \]; then [^\n]*exit 1; fi/);
    assert.match(iso[0], /set -euo pipefail/);
  });
});
