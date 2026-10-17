// D-1 y P2b-L3 (PR-4): con el kill switch ON el proceso exige --disallow-code-generation-from-strings
// (opción elegida; --jitless documentada y descartada: no bloquea eval/new Function). Prueba de
// 0 construcciones de código desde cadenas en un flujo x402 completo, con control sin el flag.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CODEGEN_FLAG, FIXTURES, PACKAGE_ROOT, baselineEnv, launch, makeTmp, rejections } from './helpers.mjs';

const { evaluateStartup, CODEGEN_FLAG: SRC_FLAG } = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'env-guard.js')).href);
const base = { TEYOLIA_X402_LISTEN: '0', NODE_ENV: 'test' };
const guard = (env, execArgv) => evaluateStartup({ env: { ...base, ...env }, execArgv, cwd: '/', listCwd: () => [] });
const codegen = (r) => r.rejections.filter((x) => x.rule === 'CODEGEN');

function probe(execArgv) {
  const r = spawnSync(process.execPath, ['--no-warnings', ...execArgv, path.join(FIXTURES, 'x402', 'codegen-probe.mjs')], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'test' }, cwd: makeTmp('x402-d1-').dir, encoding: 'utf8', timeout: 30000,
  });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('CODEGEN '));
  assert.ok(line, `sin salida (status ${r.status}): ${r.stderr}`);
  return JSON.parse(line.slice(8));
}

describe('D-1: guard de arranque', () => {
  test('el flag del guard es exactamente --disallow-code-generation-from-strings', () => assert.equal(SRC_FLAG, CODEGEN_FLAG));
  test('positivo: ON con el flag -> sin rechazo CODEGEN; OFF sin flag -> sin rechazo CODEGEN', () => {
    assert.deepEqual(codegen(guard({ TEYOLIA_X402_ENABLED: 'true' }, [CODEGEN_FLAG])), []);
    assert.deepEqual(codegen(guard({}, [])), []);
  });
  test('negativo: ON sin el flag, con --jitless, con la negación o con variantes -> rechazo CODEGEN', () => {
    for (const argv of [[], ['--jitless'], [CODEGEN_FLAG, '--no-disallow-code-generation-from-strings'], ['--disallow_code_generation_from_strings'], [`${CODEGEN_FLAG}=false`], [CODEGEN_FLAG, CODEGEN_FLAG]]) {
      assert.deepEqual(codegen(guard({ TEYOLIA_X402_ENABLED: 'true' }, argv)), [{ name: 'CODEGEN_FLAG', rule: 'CODEGEN' }], JSON.stringify(argv));
    }
  });
});

describe('D-1: proceso real (dist/main.js)', () => {
  test('negativo: ON sin el flag -> exit 78 (regla CODEGEN) antes de cualquier ON: no se crea store ni grant', async () => {
    const home = makeTmp('x402-d1h-').dir;
    const env = { ...baselineEnv(home), TEYOLIA_X402_ENABLED: 'true', TEYOLIA_X402_STORE_PATH: path.join(home, 's.sqlite'), TEYOLIA_X402_GRANT_DB_PATH: path.join(home, 'g.sqlite') };
    const r = await launch({ env, cwd: makeTmp('x402-cwd-').dir });
    if (r.started) { await r.stop(); assert.fail('arrancó'); }
    assert.equal(r.code, 78);
    assert.ok(rejections(r.stderr).some((x) => x.name === 'CODEGEN_FLAG' && x.rule === 'CODEGEN'), r.stderr);
    assert.ok(!existsSync(path.join(home, 's.sqlite')) && !existsSync(path.join(home, 'g.sqlite')));
  });
  test('positivo: ON con el flag -> arranca', async () => {
    const home = makeTmp('x402-d1p-').dir;
    const env = { ...baselineEnv(home), TEYOLIA_X402_ENABLED: 'true', TEYOLIA_X402_STORE_PATH: path.join(home, 's.sqlite'), TEYOLIA_X402_GRANT_DB_PATH: path.join(home, 'g.sqlite') };
    const r = await launch({ env, cwd: makeTmp('x402-cwd-').dir, execArgv: [CODEGEN_FLAG] });
    assert.equal(r.started, true, r.stderr);
    await r.stop();
  });
});

describe('D-1 / P2b-L3: 0 construcciones de código en un flujo x402 completo', () => {
  test('con el flag: 402 + 200, 0 construcciones exitosas; los intentos (zod, get-intrinsic) dan EvalError; %eval% bloqueado', () => {
    const r = probe([CODEGEN_FLAG]);
    assert.equal(r.status402, 402); assert.equal(r.status200, 200);
    assert.equal(r.successes, 0, JSON.stringify(r));
    assert.equal(r.evalErrors, r.attempts, 'todo intento termina en EvalError');
    assert.equal(r.intrinsicEval, 'EvalError', 'P2b-L3: %eval% existe pero no puede ejecutar código');
    assert.equal(r.zodAllowsEval, false, 'zod cae a su ruta sin JIT');
  });
  test('control negativo: sin el flag el mismo flujo SÍ construye código (zod JIT, get-intrinsic) -> el test detecta la diferencia', () => {
    const r = probe([]);
    assert.equal(r.status200, 200);
    assert.ok(r.successes > 0, JSON.stringify(r));
    assert.equal(r.intrinsicEval, '2', 'sin flag %eval% ejecuta código');
    assert.equal(r.zodAllowsEval, true);
  });
  test('--jitless (alternativa documentada) NO basta: new Function y eval siguen ejecutando código; con el flag elegido no', () => {
    const run = (argv) => spawnSync(process.execPath, [...argv, '-e', "let a='x',b='x';try{a=String(new Function('return 2')())}catch(e){a=e.constructor.name}try{b=String((0,eval)('3'))}catch(e){b=e.constructor.name}process.stdout.write(a+','+b)"], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).stdout;
    assert.equal(run(['--jitless']), '2,3');
    assert.equal(run([CODEGEN_FLAG]), 'EvalError,EvalError');
  });
});
