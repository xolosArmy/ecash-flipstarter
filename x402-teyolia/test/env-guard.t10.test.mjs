// T-10a a T-10i (INF-045 §6.2; T-10i del apéndice delta TA2.1-L1 / comentario 4/6).
// Cada caso negativo = entorno limpio que SÍ arranca + UNA entrada prohibida.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FIXTURES, baselineEnv, fullAllowlistEnv, http, launch, makeTmp, rejections } from './helpers.mjs';

let tmp;
before(() => { tmp = makeTmp(); });
after(() => tmp.cleanup());

async function expectNoStart({ extraEnv = {}, env, execArgv = [], cwd, expectName, expectRules, secretValues = [] }) {
  const runCwd = cwd ?? makeTmp('x402-cwd-').dir;
  const finalEnv = env ?? { ...baselineEnv(tmp.dir), ...extraEnv };
  const r = await launch({ env: finalEnv, cwd: runCwd, execArgv });
  if (r.started) {
    await r.stop();
    assert.fail(`el proceso arrancó y no debía (${expectName})`);
  }
  assert.notEqual(r.code, 0, 'código de salida ≠ 0');
  const rej = rejections(r.stderr);
  if (expectName) {
    const hit = rej.find((x) => x.name === expectName);
    assert.ok(hit, `stderr debe nombrar ${expectName}; stderr=${r.stderr}`);
    if (expectRules) assert.ok(expectRules.includes(hit.rule), `regla ${hit.rule} ∉ ${expectRules.join('/')}`);
  }
  for (const v of [...secretValues, ...Object.values(extraEnv)]) {
    if (typeof v !== 'string' || v.length < 4) continue;
    assert.ok(!r.stderr.includes(v) && !r.stdout.includes(v), 'el valor no aparece en ningún log');
  }
  return { ...r, rej, cwd: runCwd };
}

describe('control: el entorno limpio de base arranca', () => {
  test('baseline arranca con kill switch OFF', async () => {
    const r = await launch({ env: baselineEnv(tmp.dir), cwd: makeTmp('x402-cwd-').dir });
    assert.equal(r.started, true, `stderr=${r.stderr}`);
    await r.stop();
  });
});

const OB02_MIN = [
  'TEYOLIA_BENEFICIARY_PRIVKEY', 'TEYOLIA_BENEFICIARY_SEED', 'TEYOLIA_BENEFICIARY_PUBKEY',
  'BENEFICIARY_PRIVKEY', 'BENEFICIARY_SEED', 'BENEFICIARY_PUBKEY',
  'TEYOLIA_GAS_WALLET_PRIVKEY', 'TEYOLIA_GAS_WALLET_SEED', 'TEYOLIA_GAS_WALLET_ADDRESS',
  'GAS_WALLET_SEED', 'GAS_WALLET_PRIVKEY',
  'TEYOLIA_REFUND_ORACLE_PRIVKEY', 'TEYOLIA_REFUND_ORACLE_SEED', 'REFUND_ORACLE_PRIVKEY', 'REFUND_ORACLE_SEED',
  'ECASH_RPC_USER', 'ECASH_RPC_PASS', 'E_CASH_RPC_USER', 'E_CASH_RPC_PASS',
  'FORCE_RESCUE_CAMPAIGN_ID',
];

describe('T-10a: cada variable de la lista mínima de OB-02 (INF-044 §3.4), una por una', () => {
  for (const [i, name] of OB02_MIN.entries()) {
    test(`T-10a ${name}`, async () => {
      await expectNoStart({ extraEnv: { [name]: `valor-ficticio-t10a-${i}` }, expectName: name, expectRules: ['A'] });
    });
  }
});

const FALTA_42 = ['ECASH_RPC_URL', 'E_CASH_RPC_URL', 'TEYOLIA_SQLITE_PATH', 'ENABLE_PUBLIC_REFUNDS', 'TEYOLIA_MONETARY_FLOWS_ENABLED', 'CHRONIK_URL', 'CHRONIK_BASE_URL', 'TEYOLIA_REFUND_ORACLE_PUBKEY'];

describe('T-10b: columna «Falta» de INF-045 §4.2', () => {
  for (const [i, name] of FALTA_42.entries()) {
    test(`T-10b ${name}`, async () => {
      await expectNoStart({ extraEnv: { [name]: `valor-ficticio-t10b-${i}` }, expectName: name, expectRules: ['A', 'B'] });
    });
  }
});

describe('T-10c: prefijo de aplicación fuera de la allowlist', () => {
  for (const name of ['TEYOLIA_FOO', 'TEYOLIA_X402_FOO']) {
    test(`T-10c ${name}=1`, async () => {
      await expectNoStart({ extraEnv: { [name]: '1' }, expectName: name, expectRules: ['B'] });
    });
  }
});

// Valores con FORMA válida y checksum inválido (no son llaves de ningún tipo; Auditor P-4 I-2).
const B58 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
const fake = (prefix, len) => (prefix + B58.repeat(4)).slice(0, len);
const RULE_C_VALUES = {
  xprv: fake('xprv9s21ZrQH143K', 111),
  tprv: fake('tprv8ZgxMBicQKsP', 111),
  'WIF-5': fake('5H', 51),
  'WIF-K': fake('Kx', 52),
  'WIF-L': fake('L1', 52),
  'WIF-c': fake('cV', 52),
  mnemonico: 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce',
  'url-userinfo': 'https://usuario:clave@chronik.invalid',
};

describe('T-10d: valor con forma de material secreto en una variable admitida (regla C)', () => {
  for (const target of ['TEYOLIA_X402_XPUB', 'TEYOLIA_X402_CHRONIK_URL', 'TEYOLIA_X402_PUBLIC_ORIGIN']) {
    for (const [kind, value] of Object.entries(RULE_C_VALUES)) {
      test(`T-10d ${kind} en ${target}`, async () => {
        await expectNoStart({ extraEnv: { [target]: value }, expectName: target, expectRules: ['C'], secretValues: [value, value.slice(4, 30)] });
      });
    }
  }
});

describe('T-10e: entorno igual al del legacy (copia sanitizada)', () => {
  test('no arranca y enumera todos los nombres rechazados', async () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'legacy-env.sanitized.json'), 'utf8')).env;
    const names = Object.keys(fixture);
    assert.ok(names.length >= 43, 'fixture con el inventario completo + .env.example');
    const r = await expectNoStart({ extraEnv: fixture });
    const rejected = new Set(r.rej.map((x) => x.name));
    for (const n of names) assert.ok(rejected.has(n), `falta ${n} en el log`);
  });
});

describe('T-10f: allowlist exacta con valores de prueba (control positivo)', () => {
  test('arranca con kill switch OFF; health sin secretos; ruta x402 en 503', async () => {
    const env = fullAllowlistEnv(tmp.dir);
    assert.equal(Object.keys(env).filter((k) => k.startsWith('TEYOLIA_X402_') || k === 'NODE_ENV').length, 15, '15 de 16 (sin TEYOLIA_X402_ENABLED = OFF)');
    const r = await launch({ env, cwd: makeTmp('x402-cwd-').dir });
    assert.equal(r.started, true, `stderr=${r.stderr}`);
    try {
      const h = await http(r.port, 'GET', '/teyolia-x402/health');
      assert.equal(h.status, 200);
      assert.deepEqual(h.json, { status: 'ok', component: 'x402-teyolia', x402Enabled: false, limitsZero: true });
      const d = await http(r.port, 'GET', '/x402/v1/access/demo');
      assert.equal(d.status, 503);
      assert.deepEqual(d.json, { error: 'TEYOLIA_X402_DISABLED' });
      for (const v of Object.values(env)) if (v.length > 6 && v !== 'C.UTF-8') assert.ok(!h.body.includes(v) && !r.stdout.includes(v));
    } finally {
      await r.stop();
    }
  });
});

describe('T-10g: .env en el WorkingDirectory (opción estricta: no arranca)', () => {
  for (const fileName of ['.env', '.env.local', '.env.production']) {
    test(`T-10g ${fileName}`, async () => {
      const cwd = makeTmp('x402-cwd-').dir;
      writeFileSync(path.join(cwd, fileName), 'GAS_WALLET_SEED=ficticio-no-es-semilla\nECASH_RPC_PASS=clave-ficticia\nPORT=3011\n');
      const r = await expectNoStart({ cwd, expectName: fileName, expectRules: ['ENV_FILE'], secretValues: ['ficticio-no-es-semilla', 'clave-ficticia'] });
      assert.ok(!r.rej.some((x) => x.name === 'GAS_WALLET_SEED'), 'el .env no se cargó (ningún nombre legacy llegó a process.env)');
    });
  }
});

describe('T-10h: variable desconocida SIN prefijo', () => {
  for (const [name, value, rules] of [['API_KEY', 'x', ['A', 'B']], ['DATABASE_URL', 'sqlite:///tmp/x', ['B']], ['PORT', '1', ['B']]]) {
    test(`T-10h ${name}`, async () => {
      await expectNoStart({ extraEnv: { [name]: value }, expectName: name, expectRules: rules });
    });
  }
});

describe('T-10i: NODE_* y flags de arranque (TA2.1-L1, comentario 4/6)', () => {
  const marker = path.join(FIXTURES, 'preload', 'marker.mjs');
  const markerCjs = path.join(FIXTURES, 'preload', 'marker.cjs');

  for (const [name, value] of [
    ['NODE_PATH', '/tmp/ruta-ficticia'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['NODE_DEBUG', 'http'],
    ['NODE_EXTRA_CA_CERTS', '/ruta/ficticia/ca.pem'],
    ['NODE_OPTIONS', '--inspect=127.0.0.1:0'],
    ['NODE_OPTIONS', '--max-old-space-size=64'],
  ]) {
    test(`T-10i env ${name}=${value}`, async () => {
      // Regla B (ninguna NODE_* salvo NODE_ENV); NODE_TLS_REJECT_UNAUTHORIZED cae antes por regla A (subcadena AUTH).
      await expectNoStart({ extraEnv: { [name]: value }, expectName: name, expectRules: ['A', 'B'] });
    });
  }

  for (const [label, opt] of [
    ['--import', `--import=${marker}`],
    ['--experimental-loader', `--experimental-loader=${marker}`],
    ['--require', `--require=${markerCjs}`],
  ]) {
    test(`T-10i env NODE_OPTIONS=${label}: no arranca; el marcador de precarga SÍ aparece (limitación P4-L3)`, async () => {
      const r = await expectNoStart({ extraEnv: { NODE_OPTIONS: opt }, expectName: 'NODE_OPTIONS', expectRules: ['B'] });
      assert.equal(existsSync(path.join(r.cwd, 'preload-marker.txt')), true, 'P4-L3: el código precargado se ejecutó antes del guard (detección, no prevención)');
    });
  }

  for (const [flag, argv, precarga] of [
    ['--inspect', ['--inspect=127.0.0.1:0'], false],
    ['--import', [`--import=${marker}`], true],
    ['--require', [`--require=${markerCjs}`], true],
    ['--experimental-loader', [`--experimental-loader=${marker}`], true],
  ]) {
    test(`T-10i execArgv ${flag}`, async () => {
      const r = await expectNoStart({ execArgv: argv, expectName: flag, expectRules: ['EXEC_ARGV'] });
      assert.equal(existsSync(path.join(r.cwd, 'preload-marker.txt')), precarga);
    });
  }

  test('T-10i execArgv --env-file: no arranca y las variables del archivo se rechazan', async () => {
    const envFile = path.join(makeTmp('x402-envfile-').dir, 'legacy.env');
    writeFileSync(envFile, 'GAS_WALLET_SEED=ficticio-no-es-semilla\n');
    const r = await expectNoStart({ execArgv: [`--env-file=${envFile}`], expectName: '--env-file', expectRules: ['EXEC_ARGV'], secretValues: ['ficticio-no-es-semilla'] });
    assert.ok(r.rej.some((x) => x.name === 'GAS_WALLET_SEED' && x.rule === 'A'));
  });
});

describe('guard: validaciones adicionales (fail-closed)', () => {
  test('TEYOLIA_X402_LISTEN ausente, inválido o :3011 -> no arranca', async () => {
    for (const value of [undefined, 'abc', '3011', '70000', '127.0.0.1:0']) {
      const env = baselineEnv(tmp.dir);
      if (value === undefined) delete env.TEYOLIA_X402_LISTEN; else env.TEYOLIA_X402_LISTEN = value;
      await expectNoStart({ env, expectName: 'TEYOLIA_X402_LISTEN', expectRules: ['LISTEN'] });
    }
  });
  test('NODE_ENV distinto de test -> no arranca (INF-045 l.219: test en TA-2)', async () => {
    await expectNoStart({ env: { ...baselineEnv(tmp.dir), NODE_ENV: 'production' }, expectName: 'NODE_ENV', expectRules: ['NODE_ENV'] });
  });
});
