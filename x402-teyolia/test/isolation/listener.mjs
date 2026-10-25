// PR-6 (T-12/T-12e): oyentes sintéticos del arnés de aislamiento. Solo loopback y AF_UNIX dentro de un
// netns desechable. Cada conexión aceptada se anuncia en stdout como «ACCEPT <nombre>»; el driver
// cuenta así los intentos que llegan (también los de un socket UNIX abstracto, que ni la DAC ni
// nftables filtran). Uso: node listener.mjs '<json [{name, tcp:{host,port}} | {name, path} | {name, abstract}]>'
import net from 'node:net';
import { chmodSync } from 'node:fs';

const specs = JSON.parse(process.argv[2] ?? '[]');
let pending = specs.length;
for (const s of specs) {
  const srv = net.createServer((c) => {
    process.stdout.write(`ACCEPT ${s.name}\n`);
    c.on('error', () => {});
    c.end(`${s.name}\n`);
  });
  srv.on('error', (e) => { process.stdout.write(`ERROR ${s.name} ${e.code}\n`); process.exit(2); });
  const ready = () => {
    if (s.path && s.mode !== undefined) chmodSync(s.path, s.mode);
    process.stdout.write(`LISTEN ${s.name}\n`);
    if (--pending === 0) process.stdout.write('READY\n');
  };
  if (s.tcp) srv.listen({ host: s.tcp.host, port: s.tcp.port, ipv6Only: s.tcp.host.includes(':') }, ready);
  else if (s.path) srv.listen(s.path, ready);
  else if (s.abstract) srv.listen(`\0${s.abstract}`, ready);
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
