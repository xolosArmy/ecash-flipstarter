// PR-6 / T-12e (i) (PM6-01; Fernando 2026-10-24 09:21 CDMX): el legacy escucha SOLO por TCP y no
// usa IPC (sockets UNIX con ruta o abstractos, D-Bus, process.send/fork, named pipes). Lectura
// estática de backend/src (solo lectura; backend/ no se modifica). Las partes (ii)/(iii) las ejecuta
// el arnés privilegiado (test/isolation/driver.mjs); (iv) es precondición del gate de TA-3 (D-P6-2).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { stripComments } from '../scripts/lib/js-lexer.mjs';
import { REPO_ROOT } from '../scripts/inventory.mjs';

const LEGACY_SRC = path.join(REPO_ROOT, 'backend', 'src');
export const IPC_PATTERNS = [
  { id: 'listen-ruta', re: /\.listen\(\s*(?:['"`][^'"`]*\/|\{\s*path\s*:)/g },
  { id: 'socketPath', re: /\bsocketPath\b/g },
  { id: 'createConnection/connect con ruta', re: /\b(?:createConnection|connect)\(\s*(?:\{\s*path\s*:|['"`]\/)/g },
  { id: 'socket-abstracto', re: /['"`](?:\\0|\\u0000|\\x00|@)[\w.-]+['"`]\s*[,)]/g },
  { id: '.sock', re: /\.sock\b/g },
  { id: 'named-pipe', re: /\\\\\.\\pipe\\|\bmkfifo\b/g },
  { id: 'dbus', re: /\bd-?bus\b/gi },
  { id: 'process.send / ipc', re: /\bprocess\.send\s*\(|\bstdio\s*:\s*\[[^\]]*['"]ipc['"]/g },
  { id: 'child_process / cluster / worker', re: /['"](?:node:)?(?:child_process|cluster|worker_threads)['"]/g },
  { id: 'dgram', re: /['"](?:node:)?dgram['"]/g },
];
export function scanIpc(text) {
  const code = stripComments(text);
  return IPC_PATTERNS.filter((p) => code.match(p.re)).map((p) => p.id);
}
function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) { if (e !== '__tests__' && e !== 'node_modules') out.push(...sources(f)); }
    else if (/\.(?:[cm]?[jt]s)$/.test(e) && !/\.(?:test|spec)\./.test(e)) out.push(f);
  }
  return out;
}

describe('T-12e (i) — el legacy (backend/src) solo escucha por TCP y no usa IPC', () => {
  const files = sources(LEGACY_SRC);
  test('backend/src existe y tiene fuentes', () => assert.ok(files.length > 10, String(files.length)));
  test('ningún archivo usa primitivas de IPC', () => {
    const hits = files.flatMap((f) => scanIpc(readFileSync(f, 'utf8')).map((id) => `${path.relative(REPO_ROOT, f)}: ${id}`));
    assert.deepEqual(hits, []);
  });
  test('un único listen: server.ts app.listen(port, host) con PORT ?? 3011 y HOST ?? 127.0.0.1 (TCP)', () => {
    const listens = files.flatMap((f) => [...stripComments(readFileSync(f, 'utf8')).matchAll(/\.listen\(/g)].map(() => path.relative(LEGACY_SRC, f)));
    assert.deepEqual(listens, ['server.ts']);
    const s = readFileSync(path.join(LEGACY_SRC, 'server.ts'), 'utf8');
    assert.match(s, /const port = Number\(process\.env\.PORT \?\? 3011\);/);
    assert.match(s, /const host = process\.env\.HOST \?\? '127\.0\.0\.1';/);
    assert.match(s, /app\.listen\(port, host, /);
  });
  test('control negativo: el escáner detecta cada clase de IPC en texto sintético', () => {
    const cases = {
      'listen-ruta': "server.listen('/run/teyolia-api/legacy.sock');",
      socketPath: 'http.request({ socketPath: p });',
      'createConnection/connect con ruta': "net.createConnection({ path: '/run/x' });",
      'socket-abstracto': "net.connect('\\0teyolia-legacy-ipc');",
      '.sock': "const p = 'legacy.sock';",
      'named-pipe': "spawnSync('mkfifo', [p]);",
      dbus: "import dbus from 'dbus-next';",
      'process.send / ipc': "process.send({ ok: 1 });",
      'child_process / cluster / worker': "import { fork } from 'node:child_process';",
      dgram: "import dgram from 'node:dgram';",
    };
    for (const [id, text] of Object.entries(cases)) assert.ok(scanIpc(text).includes(id), `${id} no detectado`);
    assert.deepEqual(scanIpc("app.listen(port, host, () => {});"), [], 'listen TCP no es IPC');
  });
});
