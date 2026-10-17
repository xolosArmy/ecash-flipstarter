// Proxy de confianza (RQ-12, I-7; T-19). TEYOLIA_X402_TRUST_PROXY: ausente o vacío -> no se confía
// en ningún proxy (X-Forwarded-For se ignora). Si no, lista separada por comas de `loopback` o IPs
// literales (IPv4/IPv6). Cualquier otro valor (subredes, `true`, números de saltos, nombres) se
// rechaza: fail-closed en el arranque, nunca «confiar en todo».


export class TrustProxyConfigError extends Error {}

// Sin node:net (T-11a: builtins propios enumerados): IPv4 decimal estricta; IPv6 vía el parser
// WHATWG de URL (global), aceptada solo si la forma es hexadecimal con ':' y el parser la acepta.
const IPV4 = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
function isIpLiteral(p: string): boolean {
  if (IPV4.test(p)) return true;
  if (!/^[0-9A-Fa-f:.]+$/.test(p) || !p.includes(':')) return false;
  try {
    return new URL(`http://[${p}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function readTrustProxy(env: Readonly<Record<string, string | undefined>>): false | string[] {
  const raw = env['TEYOLIA_X402_TRUST_PROXY'];
  if (raw === undefined || raw === '') return false;
  const parts = raw.split(',').map((p) => p.trim());
  for (const p of parts) {
    if (p !== 'loopback' && !isIpLiteral(p)) throw new TrustProxyConfigError('TEYOLIA_X402_TRUST_PROXY');
  }
  return parts;
}
