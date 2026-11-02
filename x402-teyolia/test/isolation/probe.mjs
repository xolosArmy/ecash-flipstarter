// PR-6 (T-12/T-13): sonda que corre con el uid que le asigna el driver (setpriv). Una operación por
// invocación; imprime JSON {op, target, result}. result: CONNECTED | SENT | OK | TIMEOUT | <código>.
// Uso: node probe.mjs <tcp|udp|unix|read|readdir|sqlite|create> <destino> [puerto]
import net from 'node:net';
import dgram from 'node:dgram';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const [op, target, portArg] = process.argv.slice(2);
const out = (result) => { process.stdout.write(`${JSON.stringify({ op, target, port: portArg ?? null, result })}\n`); };

function sock(opts) {
  return new Promise((res) => {
    const s = net.connect({ ...opts, timeout: 1500 });
    s.on('connect', () => { s.destroy(); res('CONNECTED'); });
    s.on('timeout', () => { s.destroy(); res('TIMEOUT'); });
    s.on('error', (e) => res(e.code ?? 'ERROR'));
  });
}

try {
  if (op === 'tcp') out(await sock({ host: target, port: Number(portArg) }));
  else if (op === 'unix') out(await sock({ path: target.startsWith('@') ? `\0${target.slice(1)}` : target }));
  else if (op === 'udp') {
    const fam = target.includes(':') ? 'udp6' : 'udp4';
    const s = dgram.createSocket(fam);
    out(await new Promise((res) => {
      s.on('error', (e) => { s.close(); res(e.code ?? 'ERROR'); });
      s.send(Buffer.from('sonda'), Number(portArg), target, (e) => { setTimeout(() => { try { s.close(); } catch {} res(e ? (e.code ?? 'ERROR') : 'SENT'); }, 200); });
    }));
  } else if (op === 'read') { readFileSync(target); out('OK'); }
  else if (op === 'readdir') { readdirSync(target); out('OK'); }
  else if (op === 'create') { writeFileSync(target, 'x', { flag: 'wx' }); out('OK'); }
  else if (op === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(target, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    db.close();
    out('OK');
  } else { out('BAD_OP'); process.exitCode = 2; }
} catch (e) {
  out(e.code ?? e.message);
}
