// Kill switch TEYOLIA_X402_ENABLED (DEC-AX-08 (a); INF-042 R-14/C-04) y rutas (Auditor P4-L4).

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { PACKAGE_ROOT, baselineEnv, http, launch, makeTmp, rejections } from './helpers.mjs';

let tmp;
before(() => { tmp = makeTmp('x402-ks-'); });
after(() => tmp.cleanup());

const policy = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'policy.js')).href);

async function withServer(extraEnv, fn) {
  const env = { ...baselineEnv(tmp.dir), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = await launch({ env, cwd: makeTmp('x402-cwd-').dir });
  assert.equal(r.started, true, `stderr=${r.stderr}`);
  try {
    await fn(r.port, r);
  } finally {
    await r.stop();
  }
}

describe('kill switch: matriz OFF (todo valor distinto de \'true\' exacto)', () => {
  for (const value of [undefined, '', 'false', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ', 'enabled']) {
    test(`TEYOLIA_X402_ENABLED=${JSON.stringify(value)} -> OFF, 503 TEYOLIA_X402_DISABLED`, async () => {
      await withServer({ TEYOLIA_X402_ENABLED: value }, async (port) => {
        const d = await http(port, 'GET', '/x402/v1/access/demo');
        assert.equal(d.status, 503);
        assert.deepEqual(d.json, { error: 'TEYOLIA_X402_DISABLED' });
        assert.equal(d.headers['cache-control'], 'no-store');
        const h = await http(port, 'GET', '/teyolia-x402/health');
        assert.equal(h.json.x402Enabled, false);
      });
    });
  }
});

describe('kill switch: ON solo con NODE_ENV=test (P4-L5 adelantado)', () => {
  test("'true' + NODE_ENV=test -> arranca y la ruta sigue en 503 TEYOLIA_X402_NOT_IMPLEMENTED", async () => {
    await withServer({ TEYOLIA_X402_ENABLED: 'true' }, async (port) => {
      const d = await http(port, 'GET', '/x402/v1/access/demo');
      assert.equal(d.status, 503);
      assert.deepEqual(d.json, { error: 'TEYOLIA_X402_NOT_IMPLEMENTED' });
      const h = await http(port, 'GET', '/teyolia-x402/health');
      assert.equal(h.json.x402Enabled, true);
    });
  });
  for (const nodeEnv of [undefined, 'production', 'development']) {
    test(`'true' + NODE_ENV=${String(nodeEnv)} -> no arranca`, async () => {
      const env = { ...baselineEnv(tmp.dir), TEYOLIA_X402_ENABLED: 'true' };
      if (nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
      const r = await launch({ env, cwd: makeTmp('x402-cwd-').dir });
      if (r.started) { await r.stop(); assert.fail('arrancó'); }
      assert.notEqual(r.code, 0);
      assert.ok(rejections(r.stderr).some((x) => x.name === 'TEYOLIA_X402_ENABLED' && x.rule === 'KILL_SWITCH'));
    });
  }
});

describe('rutas (P4-L4): todo x402 en 503; health propio; nada en /proposed/v0.1/ ni /api/health', () => {
  test('matriz de rutas con kill switch OFF', async () => {
    await withServer({}, async (port) => {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
        const d = await http(port, method, '/x402/v1/access/demo');
        assert.equal(d.status, 503, `${method} demo`);
      }
      for (const p of ['/x402', '/x402/', '/x402/v1', '/x402/v1/access/otra', '/x402/v0/probe', '/x402/v1/capabilities']) {
        const r = await http(port, 'GET', p);
        assert.equal(r.status, 503, p);
        assert.deepEqual(r.json, { error: 'TEYOLIA_X402_DISABLED' });
      }
      for (const p of ['/api/health', '/api/capabilities', '/proposed/v0.1/', '/proposed/v0.1/manifest.json', '/proposed/v0.1/schema.json', '/health', '/']) {
        const r = await http(port, 'GET', p);
        assert.equal(r.status, 404, p);
      }
      const h = await http(port, 'GET', '/teyolia-x402/health');
      assert.equal(h.status, 200);
      assert.deepEqual(Object.keys(h.json).sort(), ['component', 'limitsZero', 'status', 'x402Enabled']);
      assert.equal(h.headers['x-powered-by'], undefined);
    });
  });
});

describe('límites en cero (DEC-AX-08 (a))', () => {
  test('constantes congeladas en 0 y no configurables por entorno', () => {
    assert.equal(policy.ZERO_LIMITS.maxAmountPerOperationSats, 0n);
    assert.equal(policy.ZERO_LIMITS.maxAggregateSats, 0n);
    assert.equal(policy.ZERO_LIMITS.agentBudgetSats, 0n);
    assert.equal(Object.isFrozen(policy.ZERO_LIMITS), true);
    assert.throws(() => { 'use strict'; policy.ZERO_LIMITS.agentBudgetSats = 1n; });
  });
  test('límites de tasa de M3: se leen (10/120/200 por defecto) y no se aplican en PR-1', () => {
    assert.deepEqual({ ...policy.readRateLimits({}) }, { perIpPerMinute: 10, globalPerMinute: 120, maxIssued: 200 });
    assert.deepEqual({ ...policy.readRateLimits({ TEYOLIA_X402_RATE_PER_IP: 'x' }) }, { perIpPerMinute: 10, globalPerMinute: 120, maxIssued: 200 });
  });
  test('killSwitchState solo acepta el literal exacto', () => {
    assert.equal(policy.killSwitchState({ TEYOLIA_X402_ENABLED: 'true' }), 'ON');
    for (const v of [undefined, '', 'TRUE', '1', 'yes', ' true']) assert.equal(policy.killSwitchState({ TEYOLIA_X402_ENABLED: v }), 'OFF');
  });
});
