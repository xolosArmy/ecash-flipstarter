// PR-6 / P6C-02 (Fernando 2026-10-24 11:28 CDMX): verificación por SHA-256 de los .deb de nftables
// (test/isolation/nft-pin.sh + nft-pin.lock). Sin red ni root: .deb sintéticos construidos con
// dpkg-deb y el modo `verify-lock`; `install` y `verify` usan siempre nft-pin.lock (P6D-03). Falla cerrado ante hash erróneo, .deb faltante o no fijado, plan de apt
// con un paquete no fijado o una versión distinta (la fijada «no disponible»), y lock mal formado.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { PACKAGE_ROOT, makeTmp } from './helpers.mjs';

const SCRIPT = path.join(PACKAGE_ROOT, 'test', 'isolation', 'nft-pin.sh');
const REAL_LOCK = path.join(PACKAGE_ROOT, 'test', 'isolation', 'nft-pin.lock');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function buildDeb(root, pkg, ver) {
  const d = path.join(root, `src-${pkg}`);
  mkdirSync(path.join(d, 'DEBIAN'), { recursive: true });
  writeFileSync(path.join(d, 'DEBIAN', 'control'), `Package: ${pkg}\nVersion: ${ver}\nArchitecture: amd64\nMaintainer: x402 <x402@localhost.invalid>\nDescription: sintetico PR-6\n`);
  const out = path.join(root, `${pkg}_${ver}_amd64.deb`);
  const r = spawnSync('dpkg-deb', ['--root-owner-group', '-Zgzip', '--build', d, out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}
function verify(lock, dir, plan) {
  const args = [SCRIPT, 'verify-lock', lock, dir, ...(plan ? [plan] : [])];
  return spawnSync('bash', args, { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
}
function fixture() {
  const { dir } = makeTmp('x402-nftpin-');
  const debs = path.join(dir, 'debs'); mkdirSync(debs);
  const a = buildDeb(dir, 'nftables', '9.9.9-sintetico');
  const b = buildDeb(dir, 'libnftables1', '9.9.9-sintetico');
  const c = buildDeb(dir, 'libjansson4', '1.0-sintetico');
  const lockText = (over = {}) => [
    `${over.a ?? sha(a)} nftables 9.9.9-sintetico amd64 requerido`,
    `${sha(b)} libnftables1 9.9.9-sintetico amd64 requerido`,
    `${sha(c)} libjansson4 1.0-sintetico amd64 dependencia`, ''].join('\n');
  const lock = path.join(dir, 'lock'); writeFileSync(lock, lockText());
  const plan = (lines) => { const p = path.join(dir, `plan-${Math.random()}`); writeFileSync(p, `${lines.join('\n')}\n`); return p; };
  return { dir, debs, a, b, c, lock, lockText, plan };
}

describe('P6C-02 — nft-pin.sh verify (fail-closed)', () => {
  test('P6D-03: X402_NFT_PIN_LOCK definido (aunque esté vacío) -> falla cerrado en install, verify y verify-lock', () => {
    const f = fixture(); copyFileSync(f.a, path.join(f.debs, 'x.deb')); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    for (const [args, val] of [[['install'], f.lock], [['verify', f.debs], f.lock], [['verify-lock', f.lock, f.debs], ''], [['install'], '']]) {
      const r = spawnSync('bash', [SCRIPT, ...args], { env: { PATH: '/usr/bin:/bin', X402_NFT_PIN_LOCK: val }, encoding: 'utf8' });
      assert.equal(r.status, 1, `${args[0]}: ${r.stderr}`); assert.match(r.stderr, /X402_NFT_PIN_LOCK no se admite \(P6D-03\)/);
    }
  });
  test('P6D-03: los .deb sintéticos NO pasan `verify` con el lock fijado (el lock alternativo solo existe en verify-lock)', () => {
    const f = fixture(); copyFileSync(f.a, path.join(f.debs, 'x.deb')); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    const r = spawnSync('bash', [SCRIPT, 'verify', f.debs], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /no es un \.deb esperado/);
  });
  test('modo vacío o desconocido -> falla con uso', () => {
    for (const args of [[], ['instalar']]) {
      const r = spawnSync('bash', [SCRIPT, ...args], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      assert.equal(r.status, 1); assert.match(r.stderr, /uso: nft-pin\.sh install/);
    }
  });
  test('lock real: nftables y libnftables1 1.0.9-1ubuntu0.1 requeridos con los sha256 verificados contra el índice de noble-updates', () => {
    const l = readFileSync(REAL_LOCK, 'utf8');
    assert.match(l, /^d648859fccde3c17b8b9b89993427564f91f394a39306db1f67bd5ea3ac42c6e nftables 1\.0\.9-1ubuntu0\.1 amd64 requerido$/m);
    assert.match(l, /^fcaee001747a6adaa0cd9337fef437b3aa7a7a6d5246b62fbd4784d3d6a5009e libnftables1 1\.0\.9-1ubuntu0\.1 amd64 requerido$/m);
    assert.equal([...l.matchAll(/ requerido$/gm)].length, 2);
  });
  test('positivo: .deb requeridos con hash correcto -> OK', () => {
    const f = fixture(); copyFileSync(f.a, path.join(f.debs, 'x.deb')); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    const r = verify(f.lock, f.debs);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /verificación OK/);
  });
  test('positivo: dependencia fijada planificada por apt y presente -> OK', () => {
    const f = fixture(); for (const x of [f.a, f.b, f.c]) copyFileSync(x, path.join(f.debs, path.basename(x)));
    const r = verify(f.lock, f.debs, f.plan(['Inst libjansson4 (1.0-sintetico Ubuntu:24.04/noble [amd64])', 'Inst nftables (9.9.9-sintetico Ubuntu:24.04/noble-updates [amd64])']));
    assert.equal(r.status, 0, r.stderr);
  });
  test('negativo: hash erróneo en el lock -> falla', () => {
    const f = fixture(); writeFileSync(f.lock, f.lockText({ a: '0'.repeat(64) }));
    copyFileSync(f.a, path.join(f.debs, 'x.deb')); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    const r = verify(f.lock, f.debs);
    assert.equal(r.status, 1); assert.match(r.stderr, /sha256 de nftables=9\.9\.9-sintetico: [0-9a-f]{64} != fijado 0{64}/);
  });
  test('negativo: .deb alterado (un byte) -> falla', () => {
    const f = fixture(); const x = path.join(f.debs, 'x.deb'); copyFileSync(f.a, x); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    writeFileSync(x, Buffer.concat([readFileSync(x), Buffer.from([0])]));
    assert.equal(verify(f.lock, f.debs).status, 1);
  });
  test('negativo: falta un .deb requerido -> falla', () => {
    const f = fixture(); copyFileSync(f.a, path.join(f.debs, 'x.deb'));
    const r = verify(f.lock, f.debs); assert.equal(r.status, 1); assert.match(r.stderr, /falta el \.deb de libnftables1/);
  });
  test('negativo: .deb no fijado/no esperado en el directorio -> falla', () => {
    const f = fixture(); for (const x of [f.a, f.b, f.c]) copyFileSync(x, path.join(f.debs, path.basename(x)));
    const r = verify(f.lock, f.debs); assert.equal(r.status, 1); assert.match(r.stderr, /no es un \.deb esperado/);
  });
  test('negativo: apt planifica un paquete no fijado -> falla', () => {
    const f = fixture(); copyFileSync(f.a, path.join(f.debs, 'x.deb')); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    const r = verify(f.lock, f.debs, f.plan(['Inst libfoo0 (2.0 Ubuntu:24.04/noble [amd64])']));
    assert.equal(r.status, 1); assert.match(r.stderr, /NO fijado en el lock: libfoo0=2\.0/);
  });
  test('negativo: la versión fijada ya no es la disponible (apt planifica otra) -> falla, sin fallback', () => {
    const f = fixture(); copyFileSync(f.a, path.join(f.debs, 'x.deb')); copyFileSync(f.b, path.join(f.debs, 'y.deb'));
    const r = verify(f.lock, f.debs, f.plan(['Inst nftables (9.9.9-sintetico2 Ubuntu:24.04/noble-updates [amd64])']));
    assert.equal(r.status, 1); assert.match(r.stderr, /nftables=9\.9\.9-sintetico2/);
  });
  test('negativo: lock mal formado o sin nftables requerido -> falla', () => {
    const f = fixture();
    writeFileSync(f.lock, 'abc nftables 1 amd64 requerido\n'); assert.equal(verify(f.lock, f.debs).status, 1);
    writeFileSync(f.lock, `${sha(f.b)} libnftables1 9.9.9-sintetico amd64 requerido\n`); assert.match(verify(f.lock, f.debs).stderr, /no fija nftables/);
    writeFileSync(f.lock, `${sha(f.a)} nftables 9.9.9-sintetico amd64 opcional\n`); assert.match(verify(f.lock, f.debs).stderr, /tipo inválido/);
  });
});
