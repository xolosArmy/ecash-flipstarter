/**
 * P8G-06 / P7A-04 (E-A): stub fail-closed de http|https|net.
 *
 * APIs stubbeadas: http.request, http.get, https.request, https.get,
 * net.connect, net.createConnection.
 *
 * Regla de destino efectivo (por API; alineada con Node):
 * 1. HTTP(S) request/get: si args = (urlString|URL, options[, cb]), options SOBRESCRIBEN
 *    host/hostname/port de la URL (H8 string, H9 URL object). En options HTTP,
 *    `hostname` tiene prioridad sobre `host` (H8). Overlay solo de claves **propias
 *    enumerables** (como Object.assign / Node; H12): no `in` ni hasOwn a solas.
 *    hostname:undefined propio enumerable limpia el de la URL (H11).
 * 2. net.connect/createConnection: Node lee `host` por [[Get]] (incluye heredado; H13).
 *    own+enumerable es solo para overlay HTTP/Object.assign (H12), NO para destino net.
 *    host > hostname (H10). hostname loopback propio no anula host remoto heredado.
 * 3. H14: getters/Proxy variables — fail-closed (Proxy raíz, accessor own enumerable, o
 *    lecturas [[Get]] inconsistentes). HTTP no confía en un solo muestreo temprano.
 * 4. H15: Proxy en *cualquier* eslabón de la cadena de prototipos → UNTRUSTED. No se
 *    confía en N lecturas finitas: Node puede releer host tras el stub (TOCTOU 5ª).
 *    Estrategia: denegar Proxy en cadena; no materializar snapshot loopback engañoso.
 * 5. H16: `lookup` (y `createConnection` HTTP) custom → UNTRUSTED en http y net.
 *    Un lookup que resuelve localhost→IP remota elude el destino textual.
 * 5b. H17: `options.agent` — si Agent trae lookup/createConnection *propios* (o Agent
 *    no-default distinto de http/https.globalAgent) → UNTRUSTED. H16 solo miraba
 *    options.lookup/createConnection; Node usa Agent.lookup / Agent.createConnection.
 * 5c. H18: Agent *efectivo* = `options.agent` ?? `http|https.globalAgent`. Overrides
 *    own sobre el propio globalAgent (sin options.agent) también → UNTRUSTED.
 * 6. path con prefijo "/" solo es IPC si NO hay host/hostname/port (H6).
 * 7. net.connect(port, host) → host en args[1] (H1).
 * 8. Solo call-through a loopback / IPC / connect(port) sin host.
 * 9. https.request / https.get: siempre denegados (MA8-17 por conteo).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { types as utilTypes } from 'node:util';
import { expect, vi, type MockInstance } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySpy = MockInstance<any, any>;

export type DeniedNetworkSpies = {
  httpRequest: AnySpy;
  httpGet: AnySpy;
  httpsRequest: AnySpy;
  httpsGet: AnySpy;
  netConnect: AnySpy;
  netCreateConnection: AnySpy;
};

/** Semántica de resolución: HTTP prioriza hostname; net prioriza host. */
export type NetTargetKind = 'http' | 'https' | 'net';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);

function isLoopbackHost(h: string): boolean {
  const n = h.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK.has(n) || n.endsWith('.localhost');
}

/** Destino resuelto: host IP/DNS, o null si es loopback implícito / IPC / ausente. */
export type ResolvedNetTarget =
  | { kind: 'host'; host: string }
  | { kind: 'loopback-implicit' } // connect(port) sin host → Node usa localhost
  | { kind: 'ipc' }
  | { kind: 'unknown' };

function isUrlObject(v: unknown): v is URL {
  return typeof URL !== 'undefined' && v instanceof URL;
}

/**
 * Node copia options sobre URL con semántica tipo Object.assign: solo claves
 * **propias y enumerables**. `in` ve heredadas; hasOwn ve no-enumerables; ambos
 * divergen de Node (H12). propertyIsEnumerable ≡ own+enumerable.
 *
 * No delegamos a undici/url.parse aquí: el stub debe decidir deny/allow *antes*
 * de call-through (https siempre denegado); reimplementar el overlay es el mínimo
 * fail-closed alineado con ClientRequest.
 */
function ownEnumerableKey(obj: object, key: string): boolean {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}

const UNTRUSTED_HOST = '__p8a_untrusted_options__';

function isProxyOptions(o: object): boolean {
  try {
    return utilTypes.isProxy(o);
  } catch {
    return false;
  }
}

/**
 * H15: Proxy puede vivir en el prototipo (options raíz es Object.assign plano).
 * isProxy(options) solo ve la raíz; Node [[Get]] atraviesa el Proxy del proto y
 * puede cambiar en la 5ª lectura. Denegar Proxy en *toda* la cadena relevante —
 * no confiar en muestreo finito del host.
 */
function proxyInPrototypeChain(o: object): boolean {
  let cur: object | null = o;
  const seen = new Set<object>();
  while (cur && cur !== Object.prototype) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if (isProxyOptions(cur)) return true;
    try {
      cur = Object.getPrototypeOf(cur);
    } catch {
      break;
    }
  }
  return false;
}

/** Own function/accessor hook on an object (not prototype method). */
function objectHasOwnFunctionHook(obj: object, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d && (d.get || d.set)) return true;
  return typeof (obj as Record<string, unknown>)[key] === 'function';
}

/**
 * H17/H18: http(s).Agent con lookup/createConnection *own*, o Agent no-default.
 * createConnection en Agent.prototype es método heredado — NO contar eso como custom.
 * «=== globalAgent» NO es bypass total (H18): si globalAgent tiene hooks own → UNTRUSTED.
 * Agent !== http.globalAgent && !== https.globalAgent → UNTRUSTED (H17 no-default).
 * agent:false/null → no Agent (residual OK). agent:true se resuelve antes a globalAgent.
 */
function isUntrustedHttpAgent(agent: unknown): boolean {
  if (agent === undefined || agent === null || agent === false) return false;
  if (typeof agent !== 'object') return true;
  const a = agent as object;
  if (proxyInPrototypeChain(a)) return true;
  // Own hooks primero — aplica también cuando a === globalAgent (H18).
  if (objectHasOwnFunctionHook(a, 'lookup') || objectHasOwnFunctionHook(a, 'createConnection')) {
    return true;
  }
  try {
    if (a !== http.globalAgent && a !== https.globalAgent) return true;
  } catch {
    return true;
  }
  return false;
}

/** H18: Agent efectivo que Node usará (options.agent ?? módulo.globalAgent). */
function effectiveHttpAgent(
  options: Record<string, unknown>,
  mod: 'http' | 'https',
): unknown {
  let raw: unknown;
  try {
    raw = options.agent;
  } catch {
    return UNTRUSTED_HOST; // sentinel: caller treats as untrusted via isUntrusted
  }
  if (raw === false || raw === null) return false;
  if (raw === undefined || raw === true) {
    return mod === 'https' ? https.globalAgent : http.globalAgent;
  }
  return raw;
}

/**
 * H16: lookup custom puede resolver etiqueta loopback a IP remota.
 * createConnection custom (HTTP) es superficie de transporte equivalente.
 * H17: también options.agent.{lookup,createConnection} / Agent no-default.
 * Fail-closed: cualquier función propia presente → UNTRUSTED (http y net).
 */
function hasUntrustedTransportHook(o: object, api: NetTargetKind): boolean {
  if (proxyInPrototypeChain(o)) return true;
  const keys =
    api === 'http' || api === 'https'
      ? (['lookup', 'createConnection'] as const)
      : (['lookup'] as const);
  for (const key of keys) {
    // Presencia vía [[Get]] / own: si es función, Node puede usarla.
    let cur: object | null = o;
    let found = false;
    let isFn = false;
    while (cur && cur !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        found = true;
        const d = Object.getOwnPropertyDescriptor(cur, key);
        if (d && (d.get || d.set)) {
          // accessor que provee el hook → untrusted
          return true;
        }
        const v = (cur as Record<string, unknown>)[key];
        isFn = typeof v === 'function';
        break;
      }
      cur = Object.getPrototypeOf(cur);
    }
    if (!found) {
      // también [[Get]] por si solo está en Proxy (ya cubierto) o valor heredado sin hasOwn raro
      try {
        const v = (o as Record<string, unknown>)[key];
        if (typeof v === 'function') return true;
      } catch {
        return true;
      }
    } else if (isFn) {
      return true;
    }
  }
  // H17/H18: Agent efectivo (options.agent ?? globalAgent). net no usa http.Agent igual.
  if (api === 'http' || api === 'https') {
    try {
      const eff = effectiveHttpAgent(o as Record<string, unknown>, api);
      // effectiveHttpAgent may return UNTRUSTED_HOST sentinel on throw path
      if (eff === UNTRUSTED_HOST) return true;
      if (isUntrustedHttpAgent(eff)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function ownEnumerableAccessor(obj: object, key: string): boolean {
  if (!ownEnumerableKey(obj, key)) return false;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return !!(d && (d.get || d.set));
}

/** HTTP: propio enumerable estable; accessor / inconsistente → UNTRUSTED (H14). */
function readHttpOwnEnumString(o: object, key: string): string | null | typeof UNTRUSTED_HOST {
  if (!ownEnumerableKey(o, key)) return null;
  if (ownEnumerableAccessor(o, key)) return UNTRUSTED_HOST;
  const reads: unknown[] = [];
  for (let i = 0; i < 4; i += 1) reads.push((o as Record<string, unknown>)[key]);
  const norm = reads.map((v) => (v === undefined || v === null ? '' : String(v)));
  if (new Set(norm).size > 1) return UNTRUSTED_HOST;
  const v = reads[0];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return String(v);
}

function hostFromOptionsHttp(o: Record<string, unknown>): string | null {
  // H8/H12: hostname > host; solo propias enumerables. H14 vía readHttpOwnEnumString.
  const hn = readHttpOwnEnumString(o, 'hostname');
  if (hn === UNTRUSTED_HOST) return UNTRUSTED_HOST;
  if (typeof hn === 'string' && hn.length > 0) return hn;
  const ho = readHttpOwnEnumString(o, 'host');
  if (ho === UNTRUSTED_HOST) return UNTRUSTED_HOST;
  if (typeof ho === 'string' && ho.length > 0) return String(ho).split(':')[0];
  return null;
}

/** Net: [[Get]] ordinario (H13) + fail-closed H14 (Proxy / accessor en cadena / lecturas inestables). */
function readNetOrdinaryString(o: object, key: string): string | null | typeof UNTRUSTED_HOST {
  // H15: Proxy en cadena → UNTRUSTED (no muestrear; Node puede releer tras el stub).
  if (proxyInPrototypeChain(o)) return UNTRUSTED_HOST;
  // Accessor en la cadena de prototipos → Node puede re-leer distinto; no muestrear una sola vez.
  let cur: object | null = o;
  while (cur && cur !== Object.prototype) {
    const d = Object.getOwnPropertyDescriptor(cur, key);
    if (d) {
      if (d.get || d.set) return UNTRUSTED_HOST;
      break;
    }
    cur = Object.getPrototypeOf(cur);
  }
  // Sin Proxy/accessor: una lectura [[Get]] basta (objeto de datos estable).
  // (Muestreo N-finito no cierra H15 si el Proxy está en el proto — ya denegado arriba.)
  try {
    const v = (o as Record<string, unknown>)[key];
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v;
    return String(v);
  } catch {
    return UNTRUSTED_HOST;
  }
}

function hostFromOptionsNet(o: Record<string, unknown>): string | null {
  // H13: [[Get]] de host (heredado incluido). H10: host > hostname.
  // H14: no confiar en un único muestreo frente a getters/Proxy.
  // SW-net-inherited-local: host loopback + hostname remoto → fail-closed UNTRUSTED
  // (dictamen: denegación conservadora; no atenúa H13 donde host remoto gana).
  const host = readNetOrdinaryString(o, 'host');
  if (host === UNTRUSTED_HOST) return UNTRUSTED_HOST;
  const hostname = readNetOrdinaryString(o, 'hostname');
  if (hostname === UNTRUSTED_HOST) return UNTRUSTED_HOST;
  const hostStr =
    typeof host === 'string' && host.length > 0 ? String(host).split(':')[0] : null;
  const hostnameStr =
    typeof hostname === 'string' && hostname.length > 0 ? hostname : null;
  if (hostStr) {
    if (
      isLoopbackHost(hostStr) &&
      hostnameStr &&
      !isLoopbackHost(hostnameStr)
    ) {
      return UNTRUSTED_HOST;
    }
    return hostStr;
  }
  if (hostnameStr) return hostnameStr;
  return null;
}

function targetFromOptionsResolved(
  o: Record<string, unknown>,
  api: NetTargetKind,
): ResolvedNetTarget {
  // H15/H16: Proxy en cadena o hooks de transporte (lookup[/createConnection]).
  if (hasUntrustedTransportHook(o, api)) {
    return { kind: 'host', host: UNTRUSTED_HOST };
  }
  if (api === 'http' || api === 'https') {
    if (proxyInPrototypeChain(o)) return { kind: 'host', host: UNTRUSTED_HOST };
    for (const k of ['hostname', 'host'] as const) {
      const v = readHttpOwnEnumString(o, k);
      if (v === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
    }
  }
  const h = api === 'net' ? hostFromOptionsNet(o) : hostFromOptionsHttp(o);
  if (h === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
  if (h) return { kind: 'host', host: h };
  if (api === 'net') {
    const port = (o as { port?: unknown }).port;
    if (typeof port === 'number' || typeof port === 'string') return { kind: 'loopback-implicit' };
    const path = (o as { path?: unknown }).path;
    if (typeof path === 'string' && (path.startsWith('/') || path.startsWith('\0'))) return { kind: 'ipc' };
    return { kind: 'unknown' };
  }
  if (ownEnumerableKey(o, 'port') && (typeof o.port === 'number' || typeof o.port === 'string')) {
    return { kind: 'loopback-implicit' };
  }
  if (
    ownEnumerableKey(o, 'path') &&
    typeof o.path === 'string' &&
    (o.path.startsWith('/') || o.path.startsWith('\0'))
  ) {
    return { kind: 'ipc' };
  }
  return { kind: 'unknown' };
}

function mergeUrlAndOptions(
  baseHost: string | null,
  options: Record<string, unknown> | null,
  api: NetTargetKind,
): ResolvedNetTarget {
  const merged: Record<string, unknown> = {};
  if (baseHost) {
    if (api === 'net') merged.host = baseHost;
    else merged.hostname = baseHost;
  }
  if (options) {
    if (api === 'http' || api === 'https') {
      if (hasUntrustedTransportHook(options, api)) {
        return { kind: 'host', host: UNTRUSTED_HOST };
      }
      for (const k of ['hostname', 'host', 'port', 'path', 'method'] as const) {
        if (ownEnumerableAccessor(options, k)) return { kind: 'host', host: UNTRUSTED_HOST };
      }
      const hn = readHttpOwnEnumString(options, 'hostname');
      if (hn === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
      if (hn !== null) {
        if (hn.length > 0) merged.hostname = hn;
        else delete merged.hostname;
      }
      const ho = readHttpOwnEnumString(options, 'host');
      if (ho === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
      if (ho !== null) {
        if (ho.length > 0) merged.host = ho;
        else delete merged.host;
      }
      if (ownEnumerableKey(options, 'port')) {
        const pv = readHttpOwnEnumString(options, 'port');
        if (pv === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
        if (pv !== null && pv !== '') merged.port = (options as any).port;
        else delete merged.port;
      }
      if (ownEnumerableKey(options, 'path')) {
        if (typeof (options as any).path === 'string') merged.path = (options as any).path;
        else delete merged.path;
      }
      if (ownEnumerableKey(options, 'method')) {
        if (typeof (options as any).method === 'string') merged.method = (options as any).method;
        else delete merged.method;
      }
    } else {
      // Net: no Object.assign-copy; [[Get]] + H14/H15/H16.
      if (hasUntrustedTransportHook(options, 'net')) {
        return { kind: 'host', host: UNTRUSTED_HOST };
      }
      const host = readNetOrdinaryString(options, 'host');
      if (host === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
      if (typeof host === 'string' && host.length > 0) merged.host = host;
      const hostname = readNetOrdinaryString(options, 'hostname');
      if (hostname === UNTRUSTED_HOST) return { kind: 'host', host: UNTRUSTED_HOST };
      if (typeof hostname === 'string' && hostname.length > 0) merged.hostname = hostname;
      const port = (options as { port?: unknown }).port;
      if (port !== undefined) merged.port = port;
      const path = (options as { path?: unknown }).path;
      if (typeof path === 'string') merged.path = path;
    }
  }
  return targetFromOptionsResolved(merged, api);
}

/**
 * Extrae el destino efectivo de overloads Node.
 * @param api 'http' (request/get) o 'net' (connect/createConnection). Default 'http'
 *            para regresiones H8; pasar 'net' en stubs/aserciones de net (H10).
 */
export function resolveNetTarget(
  args: unknown[],
  api: NetTargetKind = 'http',
): ResolvedNetTarget {
  if (!args.length) return { kind: 'unknown' };
  const a0 = args[0] as any;
  const a1 = args[1] as any;
  const opts =
    a1 && typeof a1 === 'object' && typeof a1 !== 'function'
      ? (a1 as Record<string, unknown>)
      : null;

  // net.connect(port: number[, host][, cb])
  if (typeof a0 === 'number') {
    if (typeof a1 === 'string' && a1.length > 0) {
      return { kind: 'host', host: a1.split(':')[0] };
    }
    return { kind: 'loopback-implicit' };
  }

  // http(s).request/get(urlString[, options][, cb])
  if (typeof a0 === 'string') {
    if (a0.startsWith('/') || a0.startsWith('\0')) return { kind: 'ipc' };
    let baseHost: string | null = null;
    try {
      baseHost = new URL(a0).hostname || null;
    } catch {
      baseHost = a0.includes('://') ? null : a0.split(':')[0];
    }
    if (opts) return mergeUrlAndOptions(baseHost, opts, api);
    if (baseHost) return { kind: 'host', host: baseHost };
    if (a0.includes('/') && !a0.includes('://')) return { kind: 'ipc' };
    return { kind: 'host', host: a0.split(':')[0] };
  }

  // H9: http(s).request/get(new URL(...), options?) — misma fusión que string.
  if (isUrlObject(a0)) {
    const baseHost = a0.hostname || null;
    if (opts) return mergeUrlAndOptions(baseHost, opts, api);
    return baseHost ? { kind: 'host', host: baseHost } : { kind: 'unknown' };
  }

  // options object (HTTP: hostname>host; net: host>hostname)
  if (a0 && typeof a0 === 'object') {
    return targetFromOptionsResolved(a0 as Record<string, unknown>, api);
  }

  return { kind: 'unknown' };
}

export function isAllowedLocalTarget(target: ResolvedNetTarget): boolean {
  if (target.kind === 'loopback-implicit' || target.kind === 'ipc') return true;
  if (target.kind === 'host') return isLoopbackHost(target.host);
  return false;
}

/** @deprecated usar resolveNetTarget; se conserva para tests unitarios del helper */
export function hostFromArgs(args: unknown[]): string | null {
  const t = resolveNetTarget(args);
  return t.kind === 'host' ? t.host : null;
}

export function clearDeniedNetworkSpies(spies: DeniedNetworkSpies): void {
  spies.httpRequest.mockClear();
  spies.httpGet.mockClear();
  spies.httpsRequest.mockClear();
  spies.httpsGet.mockClear();
  spies.netConnect.mockClear();
  spies.netCreateConnection.mockClear();
}

export function installDeniedNetwork(): DeniedNetworkSpies {
  const originalHttpRequest = http.request.bind(http);
  const originalHttpGet = http.get.bind(http);
  const originalNetConnect = net.connect.bind(net);
  const originalNetCreate = net.createConnection.bind(net);

  const denyOrForward = (
    apiName: string,
    args: any[],
    original: (...a: any[]) => any,
    alwaysDeny: boolean,
    kind: NetTargetKind,
  ) => {
    const target = resolveNetTarget(args, kind);
    if (!alwaysDeny && isAllowedLocalTarget(target)) {
      return original(...args);
    }
    const label =
      target.kind === 'host'
        ? target.host
        : target.kind === 'loopback-implicit'
          ? '(loopback-implicit)'
          : target.kind;
    throw new Error(`p8a: ${apiName} denegado en tests (P8G-06) host=${label}`);
  };

  const httpRequest = vi.spyOn(http, 'request').mockImplementation((...args: any[]) =>
    denyOrForward('http.request', args, originalHttpRequest as any, false, 'http'),
  );

  const httpGet = vi.spyOn(http, 'get').mockImplementation((...args: any[]) =>
    denyOrForward('http.get', args, originalHttpGet as any, false, 'http'),
  );

  const httpsRequest = vi.spyOn(https, 'request').mockImplementation((...args: any[]) =>
    denyOrForward(
      'https.request',
      args,
      () => {
        throw new Error('unreachable');
      },
      true,
      'https',
    ),
  );

  const httpsGet = vi.spyOn(https, 'get').mockImplementation((...args: any[]) =>
    denyOrForward(
      'https.get',
      args,
      () => {
        throw new Error('unreachable');
      },
      true,
      'https',
    ),
  );

  const netConnect = vi.spyOn(net, 'connect').mockImplementation((...args: any[]) =>
    denyOrForward('net.connect', args, originalNetConnect as any, false, 'net'),
  );

  const netCreateConnection = vi.spyOn(net, 'createConnection').mockImplementation((...args: any[]) =>
    denyOrForward('net.createConnection', args, originalNetCreate as any, false, 'net'),
  );

  return { httpRequest, httpGet, httpsRequest, httpsGet, netConnect, netCreateConnection };
}

export function expectNetworkDeniedUnused(spies: DeniedNetworkSpies): void {
  expect(spies.httpsRequest, 'https.request no debe llamarse (MA8-17)').not.toHaveBeenCalled();
  expect(spies.httpsGet, 'https.get no debe llamarse (H7 hermana)').not.toHaveBeenCalled();

  const badHttp = [
    ...spies.httpRequest.mock.calls.filter(
      (c: unknown[]) => !isAllowedLocalTarget(resolveNetTarget(c, 'http')),
    ),
    ...spies.httpGet.mock.calls.filter(
      (c: unknown[]) => !isAllowedLocalTarget(resolveNetTarget(c, 'http')),
    ),
  ];
  const badNet = [
    ...spies.netConnect.mock.calls.filter(
      (c: unknown[]) => !isAllowedLocalTarget(resolveNetTarget(c, 'net')),
    ),
    ...spies.netCreateConnection.mock.calls.filter(
      (c: unknown[]) => !isAllowedLocalTarget(resolveNetTarget(c, 'net')),
    ),
  ];
  expect(badHttp, 'http.request/get a host no-loopback (destino efectivo)').toEqual([]);
  expect(badNet, 'net.connect/createConnection a host no-loopback (incl. connect(port, host))').toEqual(
    [],
  );
}

export async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
}
