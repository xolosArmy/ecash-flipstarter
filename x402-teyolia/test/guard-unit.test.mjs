// Pruebas unitarias del guard (regla C por forma; sin falsos positivos en valores normales).

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { PACKAGE_ROOT } from './helpers.mjs';

const guard = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'env-guard.js')).href);
const allow = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'allowlist.js')).href);

describe('allowlist normativa', () => {
  test('16 nombres de INF-045 §5.1; sistema enumerado sin ninguna NODE_*', () => {
    assert.equal(allow.NORMATIVE_ALLOWLIST.length, 16);
    assert.equal(new Set(allow.NORMATIVE_ALLOWLIST).size, 16);
    assert.deepEqual([...allow.SYSTEM_ALLOWLIST].sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'USER']);
    assert.equal(allow.NORMATIVE_ALLOWLIST.filter((n) => n.startsWith('NODE_')).join(','), 'NODE_ENV');
    for (const n of allow.NORMATIVE_ALLOWLIST) assert.equal(guard.isRuleANegative(n), false, `${n} no debe chocar con la regla A`);
  });
});

describe('regla C por forma', () => {
  const positives = [
    'xprv9s21ZrQH143K' + 'A'.repeat(95),
    'prefijo tprv8ZgxMBicQKsP' + 'b'.repeat(30),
    '5H' + 'J'.repeat(49),
    'K' + 'x'.repeat(51),
    'L' + '1'.repeat(51),
    'uno dos tres cuatro cinco seis siete ocho nueve diez once doce',
    'https://u:p@chronik.invalid',
    'postgres://usuario@db.invalid/x',
  ];
  for (const v of positives) test(`rechaza forma: ${v.slice(0, 12)}…`, () => assert.equal(guard.isRuleCValue(v), true));
  const negatives = [
    'xpub661MyMwAqRbcF' + 'A'.repeat(94),
    'https://chronik.invalid',
    'http://127.0.0.1:8080/path?x=1',
    '/usr/local/bin:/usr/bin:/bin',
    'C.UTF-8',
    '300',
    'loopback',
    'uno dos tres cuatro cinco seis siete ocho nueve diez once',
    'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
  ];
  for (const v of negatives) test(`admite: ${v.slice(0, 24)}…`, () => assert.equal(guard.isRuleCValue(v), false));
});

describe('formatRejections no imprime valores ni nombres raros', () => {
  test('solo nombre y regla', () => {
    const r = guard.evaluateStartup({ env: { 'x y=z': 'v', GAS_WALLET_SEED: 'secreto-ficticio', TEYOLIA_X402_LISTEN: '0' }, execArgv: [], cwd: '/', listCwd: () => [] });
    const lines = guard.formatRejections(r).join('\n');
    assert.ok(lines.includes('GAS_WALLET_SEED (regla A)'));
    assert.ok(lines.includes('<nombre-no-imprimible> (regla B)'));
    assert.ok(!lines.includes('secreto-ficticio'));
  });
  test('cwd ilegible -> falla cerrado', () => {
    const r = guard.evaluateStartup({ env: { TEYOLIA_X402_LISTEN: '0' }, execArgv: [], cwd: '/', listCwd: () => { throw new Error('EACCES'); } });
    assert.equal(r.ok, false);
    assert.ok(r.rejections.some((x) => x.rule === 'CWD'));
  });
});
