// Utilidades de prueba. Todo proceso hijo recibe un `env` EXPLÍCITO (nunca hereda
// process.env) y un `cwd` temporal propio. La única red usada es loopback (127.0.0.1).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const MAIN = path.join(PACKAGE_ROOT, 'dist', 'main.js');
export const FIXTURES = path.join(HERE, 'fixtures');

const created = new Set();
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Directorio temporal propio; se borra al terminar el archivo de prueba. */
export function makeTmp(prefix = 'x402-t10-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.add(dir);
  return { dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }); created.delete(dir); } };
}

/** Entorno limpio mínimo (allowlist): con esto el proceso arranca. */
export function baselineEnv(home) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    NODE_ENV: 'test',
    TEYOLIA_X402_LISTEN: '0',
  };
}

/** Allowlist normativa completa con valores de prueba ficticios (T-10f). */
export function fullAllowlistEnv(home) {
  return {
    ...baselineEnv(home),
    TEYOLIA_X402_PUBLIC_ORIGIN: 'http://127.0.0.1',
    TEYOLIA_X402_STORE_PATH: path.join(home, 'store.sqlite'),
    TEYOLIA_X402_GRANT_DB_PATH: path.join(home, 'grant.sqlite'),
    // xpub ficticio: solo forma, checksum inválido, no deriva nada (Auditor P-4 I-2).
    TEYOLIA_X402_XPUB: `xpub661MyMwAqRbcF${'A'.repeat(94)}`,
    TEYOLIA_X402_CHRONIK_URL: 'https://chronik.invalid',
    TEYOLIA_X402_EXPIRY_SECONDS: '300',
    TEYOLIA_X402_RATE_PER_IP: '10',
    TEYOLIA_X402_RATE_GLOBAL: '120',
    TEYOLIA_X402_MAX_ISSUED: '200',
    TEYOLIA_X402_REDELIVERY_MAX: '10',
    TEYOLIA_X402_REDELIVERY_WINDOW_SECONDS: '86400',
    TEYOLIA_X402_TRUST_PROXY: 'loopback',
    TEYOLIA_X402_ANNOUNCE_PATH: path.join(home, 'announce.json'),
  };
}

/**
 * Lanza `node [execArgv] dist/main.js` con env explícito.
 * Resuelve cuando el proceso termina o cuando anuncia el puerto (si arranca).
 */
export function launch({ env, cwd, execArgv = [], timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, MAIN], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`));
      }
    }, timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = /escuchando en 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (m) {
        finish({
          started: true,
          port: Number(m[1]),
          get stdout() { return stdout; },
          get stderr() { return stderr; },
          stop: () => new Promise((res) => {
            if (child.exitCode !== null || child.signalCode !== null) return res({ code: child.exitCode, signal: child.signalCode });
            child.once('exit', (code, signal) => res({ code, signal }));
            child.kill('SIGTERM');
          }),
        });
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', (code, signal) => finish({ started: false, code, signal, stdout, stderr }));
  });
}

/** Petición HTTP a loopback. */
export function http(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: urlPath, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Extrae las líneas «arranque rechazado: NOMBRE (regla X)». */
export function rejections(stderr) {
  return [...stderr.matchAll(/arranque rechazado: (\S+) \(regla ([A-Z_]+)\)/g)].map((m) => ({ name: m[1], rule: m[2] }));
}
