// PR-6a / PR1-L4 (t117u; plan PR-2 §10 punto 2): execArgv deny-by-default. Solo
// --disallow-code-generation-from-strings, comparado de forma exacta; cualquier otro argumento de Node
// -> regla EXEC_ARGV y exit 78 antes de la fase 2. Los casos negativos son flags que la lista negra
// anterior (T-10i) dejaba pasar.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CODEGEN_FLAG, PACKAGE_ROOT, baselineEnv, launch, makeTmp, rejections } from './helpers.mjs';

const G = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'env-guard.js')).href);
const base = { TEYOLIA_X402_LISTEN: '0', NODE_ENV: 'test' };
const guard = (execArgv, env = {}) => G.evaluateStartup({ env: { ...base, ...env }, execArgv, cwd: '/', listCwd: () => [] });
const execRej = (r) => r.rejections.filter((x) => x.rule === 'EXEC_ARGV');

// Flags que NO estaban en la lista negra de T-10i (el hueco de PR1-L4), más variantes del flag admitido.
const NOT_IN_OLD_DENYLIST = [
  ['--expose-gc', '--expose-gc'],
  ['--max-old-space-size=64', '--max-old-space-size'],
  ['--stack-size=100', '--stack-size'],
  ['--title=x402-ficticio', '--title'],
  ['--permission', '--permission'],
  ['--allow-fs-read=/', '--allow-fs-read'],
  ['--experimental-vm-modules', '--experimental-vm-modules'],
  ['--no-warnings', '--no-warnings'],
  ['--jitless', '--jitless'],
  ['--frozen-intrinsics', '--frozen-intrinsics'],
  ['--trace-warnings', '--trace-warnings'],
  ['--input-type=module', '--input-type'],
  ['--disallow-code-generation-from-strings=true', '--disallow-code-generation-from-strings'],
  ['--disallow_code_generation_from_strings', '<flag>'],
  [' --disallow-code-generation-from-strings', '<flag>'],
  ['--Disallow-Code-Generation-From-Strings', '--Disallow-Code-Generation-From-Strings'],
];
// Los de la lista negra anterior siguen rechazados.
const OLD_DENYLIST = [
  ['--import=/x.mjs', '--import'], ['--require=/x.cjs', '--require'], ['-r', '-r'], ['--loader=/x.mjs', '--loader'],
  ['--experimental-loader=/x.mjs', '--experimental-loader'], ['--env-file=/x.env', '--env-file'],
  ['--env-file-if-exists=/x.env', '--env-file-if-exists'], ['--inspect', '--inspect'], ['--inspect-brk=0', '--inspect-brk'],
  ['--debug-port=0', '--debug-port'], ['--experimental-preload', '--experimental-preload'],
];

describe('PR1-L4: allowlist exacta de execArgv (unidad, dist/env-guard.js)', () => {
  test('la allowlist es exactamente [--disallow-code-generation-from-strings] y está congelada', () => {
    assert.deepEqual([...G.ALLOWED_EXEC_ARGV], [CODEGEN_FLAG]);
    assert.equal(Object.isFrozen(G.ALLOWED_EXEC_ARGV), true);
  });
  test('positivo: [] y [flag] -> sin rechazo EXEC_ARGV (OFF y ON)', () => {
    assert.deepEqual(execRej(guard([])), []);
    assert.deepEqual(execRej(guard([CODEGEN_FLAG])), []);
    const on = guard([CODEGEN_FLAG], { TEYOLIA_X402_ENABLED: 'true' });
    assert.deepEqual(execRej(on), []);
    assert.deepEqual(on.rejections.filter((x) => x.rule === 'CODEGEN'), []);
  });
  for (const [arg, name] of [...NOT_IN_OLD_DENYLIST, ...OLD_DENYLIST]) {
    test(`negativo: ${JSON.stringify(arg)} -> EXEC_ARGV (${name}), solo o junto al flag admitido`, () => {
      for (const argv of [[arg], [CODEGEN_FLAG, arg], [arg, CODEGEN_FLAG]]) {
        const r = guard(argv);
        assert.equal(r.ok, false, JSON.stringify(argv));
        assert.deepEqual(execRej(r), [{ name, rule: 'EXEC_ARGV' }], JSON.stringify(argv));
      }
    });
  }
  test('el log nombra el flag, nunca su valor', () => {
    const lines = G.formatRejections(guard(['--title=valor-secreto-ficticio-7f3a']));
    assert.ok(lines.some((l) => l.includes('--title (regla EXEC_ARGV)')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('valor-secreto-ficticio-7f3a')));
  });
});

describe('PR1-L4: proceso real (dist/main.js)', () => {
  for (const argv of [['--expose-gc'], ['--max-old-space-size=64'], ['--stack-size=900'], ['--no-warnings']]) {
    test(`OFF con ${argv.join(' ')} -> exit 78 (EXEC_ARGV), no arranca`, async () => {
      const r = await launch({ env: baselineEnv(makeTmp('x402-l4h-').dir), cwd: makeTmp('x402-cwd-').dir, execArgv: argv });
      if (r.started) { await r.stop(); assert.fail('arrancó'); }
      assert.equal(r.code, 78);
      assert.ok(rejections(r.stderr).some((x) => x.name === argv[0].split('=')[0] && x.rule === 'EXEC_ARGV'), r.stderr);
    });
  }
  test('ON con [flag, --expose-gc] -> exit 78 antes de la persistencia: no se crea store ni grant', async () => {
    const home = makeTmp('x402-l4p-').dir;
    const env = { ...baselineEnv(home), TEYOLIA_X402_ENABLED: 'true', TEYOLIA_X402_STORE_PATH: path.join(home, 's.sqlite'), TEYOLIA_X402_GRANT_DB_PATH: path.join(home, 'g.sqlite') };
    const r = await launch({ env, cwd: makeTmp('x402-cwd-').dir, execArgv: [CODEGEN_FLAG, '--expose-gc'] });
    if (r.started) { await r.stop(); assert.fail('arrancó'); }
    assert.equal(r.code, 78);
    assert.ok(rejections(r.stderr).some((x) => x.name === '--expose-gc' && x.rule === 'EXEC_ARGV'), r.stderr);
    assert.ok(!existsSync(path.join(home, 's.sqlite')) && !existsSync(path.join(home, 'g.sqlite')));
  });
  test('control positivo: OFF sin flags y ON con [flag] arrancan', async () => {
    const home = makeTmp('x402-l4c-').dir;
    const off = await launch({ env: baselineEnv(home), cwd: makeTmp('x402-cwd-').dir });
    assert.equal(off.started, true, off.stderr); await off.stop();
    const env = { ...baselineEnv(home), TEYOLIA_X402_ENABLED: 'true', TEYOLIA_X402_STORE_PATH: path.join(home, 's.sqlite'), TEYOLIA_X402_GRANT_DB_PATH: path.join(home, 'g.sqlite') };
    const on = await launch({ env, cwd: makeTmp('x402-cwd-').dir, execArgv: [CODEGEN_FLAG] });
    assert.equal(on.started, true, on.stderr); await on.stop();
  });
});
