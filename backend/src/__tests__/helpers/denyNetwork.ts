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
 *    La misma validación aplica a URL string/objeto sin options, con o sin callback.
 *    `_defaultAgent` custom también se deniega; agent:false crea un Agent nuevo.
 * 5d. H19-A: toda firma HTTP(S) (url / URL / cb / options) pasa por Agent efectivo
 *    (mergeUrlAndOptions + hasUntrustedTransportHook); sin early-return loopback.
 * 5e. H19-B: al *cargar el módulo* se capturan globalAgent y Agent.prototype.createConnection
 *    (http/https). UNTRUSTED si createConnection/lookup difiere del original (por
 *    descriptor), si getPrototypeOf(agent) ≠ Agent.prototype, o si globalAgent ≠
 *    capturado / subclase.
 * 5f. OBS-3: cada denegación se registra en el momento de la llamada; expectNetworkDeniedUnused
 *    falla si el log no está vacío aunque try/catch + restore oculten el throw.
 * 5g. H20-A/C01: `agent:false` exige que `(globalAgent).constructor` (por descriptor en
 *    cadena) sea el Agent capturado y que [[Prototype]] de globalAgent sea Agent.prototype.
 * 5h. H20-B/C04–C05: se capturan descriptores de addRequest/createSocket/createConnection/
 *    removeSocket/keepSocketAlive/reuseSocket/getName/constructor y la instantánea de
 *    globalAgent.options (host/hostname/port/lookup/…). Own o descriptor distinto → UNTRUSTED.
 * 5i. H20-C/C06: comprobaciones por descriptor (sin [[Get]] de claves de transporte);
 *    accessor → UNTRUSTED sin invocarlo (TOCTOU).
 * 5j. OBS-6/C19: invariantes al cargar (+ golden en globalThis). Si fallan → *tainted*:
 *    toda llamada http(s) se deniega.
 * 5k. OBS-7/C21 (fuera de contrato E-A): tls.connect, new net.Socket().connect,
 *    new http.ClientRequest y siembra de globalAgent.freeSockets NO están stubbeados;
 *    requieren E-B (aislamiento de red del SO). fetch sigue cubierto con vi.stubGlobal.
 * 5l. H21-dns: no confiar en dns.lookup / dns.promises.lookup si su descriptor o
 *    identidad difiere de la captura al cargar (fail-closed; sin [[Get]] de accessors).
 *    Hostname (incl. localhost) e implícito N1/N2 → DENIED si DNS está taint; literales
 *    127.0.0.1/::1 e IPC siguen permitidos. IPv4-mapped remota (::ffff:203.x) NO es loopback.
 * 5m. E-B: el stub **no sustituye** el aislamiento de red del SO (`bwrap --unshare-net`
 *    o equivalente). warnIfNotIsolated() avisa si hay interfaces no-loopback.
 * 6. path con prefijo "/" solo es IPC si NO hay host/hostname/port (H6).
 * 7. net.connect(port, host) → host en args[1] (H1).
 * 8. Solo call-through a loopback / IPC / connect(port) sin host.
 * 9. https.request / https.get: siempre denegados (MA8-17 por conteo).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import os from 'node:os';
import { types as utilTypes } from 'node:util';
import { expect, vi, type MockInstance } from 'vitest';

// H19-B / H20: golden baselines en globalThis (sobrevive vi.resetModules; OBS-6/C19).
const PROTO_TRANSPORT_KEYS = [
  'addRequest',
  'createSocket',
  'createConnection',
  'removeSocket',
  'keepSocketAlive',
  'reuseSocket',
  'getName',
  'constructor',
] as const;

const OPTIONS_WATCH_KEYS = [
  'host',
  'hostname',
  'port',
  'lookup',
  'socketPath',
  'localAddress',
  'family',
  'createConnection',
  'servername',
] as const;

type ProtoKey = (typeof PROTO_TRANSPORT_KEYS)[number];

type DescSnap = {
  hasGet: boolean;
  hasSet: boolean;
  value: unknown;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
};

type OptionsSnap = {
  names: string[];
  watched: Record<string, DescSnap | { missing: true }>;
};

type ModGolden = {
  globalAgent: http.Agent | https.Agent;
  AgentCtor: typeof http.Agent | typeof https.Agent;
  proto: object;
  protoDescs: Record<string, DescSnap | { missing: true }>;
  options: OptionsSnap;
  createConnection: unknown;
  lookup: unknown;
};

type EaGolden = {
  http: ModGolden;
  https: ModGolden;
  netCreateConnection: typeof net.createConnection;
  dnsLookupDesc: DescSnap | { missing: true };
  dnsPromisesLookupDesc: DescSnap | { missing: true };
  dnsLookup: typeof dns.lookup;
  dnsPromisesLookup: typeof dns.promises.lookup;
};

type GlobalWithGolden = typeof globalThis & { __p8a_ea_golden__?: EaGolden };

function snapDesc(obj: object, key: string): DescSnap | { missing: true } {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return { missing: true };
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return { missing: true };
  return {
    hasGet: typeof d.get === 'function',
    hasSet: typeof d.set === 'function',
    value: d.get || d.set ? undefined : d.value,
    writable: !!d.writable,
    enumerable: !!d.enumerable,
    configurable: !!d.configurable,
  };
}

function snapOptions(opts: object): OptionsSnap {
  const names = Object.getOwnPropertyNames(opts).sort();
  const watched: OptionsSnap['watched'] = {};
  for (const k of OPTIONS_WATCH_KEYS) {
    watched[k] = snapDesc(opts, k);
  }
  return { names, watched };
}

function snapMod(mod: 'http' | 'https'): ModGolden {
  const api = mod === 'https' ? https : http;
  const proto = api.Agent.prototype as object;
  const protoDescs: ModGolden['protoDescs'] = {};
  for (const k of PROTO_TRANSPORT_KEYS) {
    protoDescs[k] = snapDesc(proto, k);
  }
  // lookup may live only as undefined / absent
  protoDescs['lookup'] = snapDesc(proto, 'lookup');
  return {
    globalAgent: api.globalAgent,
    AgentCtor: api.Agent,
    proto,
    protoDescs,
    options: snapOptions((api.globalAgent as { options: object }).options || {}),
    createConnection: (proto as { createConnection?: unknown }).createConnection,
    lookup: (proto as { lookup?: unknown }).lookup,
  };
}

function initGolden(): EaGolden {
  return {
    http: snapMod('http'),
    https: snapMod('https'),
    netCreateConnection: net.createConnection,
    dnsLookupDesc: snapDesc(dns as object, 'lookup'),
    dnsPromisesLookupDesc: snapDesc(dns.promises as object, 'lookup'),
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
  };
}

function getGolden(): EaGolden {
  const g = globalThis as GlobalWithGolden;
  if (!g.__p8a_ea_golden__) {
    g.__p8a_ea_golden__ = initGolden();
  }
  return g.__p8a_ea_golden__;
}

const GOLDEN = getGolden();

/** Capturas de esta carga de módulo (pueden coincidir con GOLDEN o no). */
const CAPTURED_HTTP_GLOBAL_AGENT = http.globalAgent;
const CAPTURED_HTTPS_GLOBAL_AGENT = https.globalAgent;
const CAPTURED_HTTP_AGENT_PROTO_CC = http.Agent.prototype.createConnection;
const CAPTURED_HTTPS_AGENT_PROTO_CC = https.Agent.prototype.createConnection;
const CAPTURED_HTTP_AGENT_PROTO_LOOKUP = (http.Agent.prototype as { lookup?: unknown }).lookup;
const CAPTURED_HTTPS_AGENT_PROTO_LOOKUP = (https.Agent.prototype as { lookup?: unknown }).lookup;

function descsEqual(
  a: DescSnap | { missing: true },
  b: DescSnap | { missing: true },
): boolean {
  if ('missing' in a || 'missing' in b) {
    return 'missing' in a && 'missing' in b;
  }
  if (a.hasGet || a.hasSet || b.hasGet || b.hasSet) {
    // Accessors: solo confiar si ambos son el mismo par get/set capturado (identidad).
    // Cualquier accessor distinto del golden → no-equal (caller trata como UNTRUSTED).
    return (
      a.hasGet === b.hasGet &&
      a.hasSet === b.hasSet &&
      a.value === b.value &&
      a.configurable === b.configurable &&
      a.enumerable === b.enumerable
    );
  }
  return a.value === b.value;
}

function protoHasAccessor(mod: 'http' | 'https', key: string): boolean {
  const api = mod === 'https' ? https : http;
  const d = Object.getOwnPropertyDescriptor(api.Agent.prototype, key);
  return !!(d && (d.get || d.set));
}

function liveOptionsUntrusted(mod: 'http' | 'https'): boolean {
  const api = mod === 'https' ? https : http;
  const golden = mod === 'https' ? GOLDEN.https : GOLDEN.http;
  let opts: object;
  try {
    opts = (api.globalAgent as { options: object }).options || {};
  } catch {
    return true;
  }
  // Accessors on options itself or watched keys → UNTRUSTED (C06)
  for (const k of Object.getOwnPropertyNames(opts)) {
    const d = Object.getOwnPropertyDescriptor(opts, k);
    if (d && (d.get || d.set)) return true;
  }
  for (const k of OPTIONS_WATCH_KEYS) {
    const live = snapDesc(opts, k);
    const g = golden.options.watched[k] || { missing: true as const };
    if ('missing' in live && 'missing' in g) continue;
    if ('missing' in live || 'missing' in g) return true;
    if (live.hasGet || live.hasSet) return true;
    if (!descsEqual(live, g)) return true;
  }
  // Extra own keys that look like transport overrides
  for (const k of Object.getOwnPropertyNames(opts)) {
    if ((OPTIONS_WATCH_KEYS as readonly string[]).includes(k)) continue;
    // allow stock non-watched keys that were present at golden
    if (!golden.options.names.includes(k)) {
      // new key — if it's a function/host-like, untrusted; be fail-closed for any new own
      return true;
    }
  }
  return false;
}

function liveProtoDescsUntrusted(mod: 'http' | 'https'): boolean {
  const api = mod === 'https' ? https : http;
  const golden = mod === 'https' ? GOLDEN.https : GOLDEN.http;
  const proto = api.Agent.prototype as object;
  const keys = [...PROTO_TRANSPORT_KEYS, 'lookup'] as const;
  for (const k of keys) {
    const live = snapDesc(proto, k);
    const g = golden.protoDescs[k] || { missing: true as const };
    if (protoHasAccessor(mod, k)) {
      // Accessor on proto → UNTRUSTED unless identical to golden accessor (stock none)
      if ('missing' in g || !('hasGet' in g) || !(g.hasGet || g.hasSet)) return true;
      if (!descsEqual(live, g)) return true;
      continue;
    }
    if (!descsEqual(live, g)) return true;
  }
  return false;
}

function agentOwnTransportUntrusted(agent: object): boolean {
  const keys = [...PROTO_TRANSPORT_KEYS, 'lookup'] as const;
  for (const k of keys) {
    if (objectHasOwnFunctionHook(agent, k)) return true;
    if (Object.prototype.hasOwnProperty.call(agent, k)) {
      const d = Object.getOwnPropertyDescriptor(agent, k);
      if (d && (d.get || d.set)) return true;
      // own data override of transport surface
      if (k !== 'constructor' && d && 'value' in d) return true;
    }
  }
  return false;
}

/**
 * Resolve `constructor` via descriptor walk (no [[Get]] of value through accessors).
 * Returns the constructor function or null if untrusted/missing.
 */
function constructorViaDescriptor(agent: object): unknown {
  let cur: object | null = agent;
  while (cur && cur !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(cur, 'constructor')) {
      const d = Object.getOwnPropertyDescriptor(cur, 'constructor');
      if (!d) return null;
      if (d.get || d.set) return null; // accessor → untrusted
      return d.value;
    }
    try {
      cur = Object.getPrototypeOf(cur);
    } catch {
      return null;
    }
  }
  return null;
}

function evaluateImportInvariants(): boolean {
  try {
    // createConnection stock === net.createConnection
    if (http.Agent.prototype.createConnection !== GOLDEN.netCreateConnection) {
      // Node wires Agent.prototype.createConnection to net.createConnection
      if (http.Agent.prototype.createConnection !== net.createConnection) return false;
    }
    if (http.Agent.prototype.createConnection !== net.createConnection) return false;
    if (Object.getPrototypeOf(http.globalAgent) !== http.Agent.prototype) return false;
    if (Object.getPrototypeOf(https.globalAgent) !== https.Agent.prototype) return false;
    for (const k of [...PROTO_TRANSPORT_KEYS, 'lookup']) {
      if (protoHasAccessor('http', k)) return false;
      if (protoHasAccessor('https', k)) return false;
    }
    if (agentOwnTransportUntrusted(http.globalAgent)) return false;
    if (agentOwnTransportUntrusted(https.globalAgent)) return false;
    if (liveOptionsUntrusted('http') || liveOptionsUntrusted('https')) return false;
    if (liveProtoDescsUntrusted('http') || liveProtoDescsUntrusted('https')) return false;
    // Identity vs golden (first clean load)
    if (http.globalAgent !== GOLDEN.http.globalAgent) return false;
    if (https.globalAgent !== GOLDEN.https.globalAgent) return false;
    if (http.Agent !== GOLDEN.http.AgentCtor) return false;
    if (https.Agent !== GOLDEN.https.AgentCtor) return false;
    // H21: DNS surfaces al cargar
    if (!dnsSurfacesTrusted()) return false;
    return true;
  } catch {
    return false;
  }
}

/** OBS-6/C19: si las invariantes fallan al cargar, todo http(s) se deniega. */
export const importTainted: boolean = !evaluateImportInvariants();
// Mantener capturas por carga (diagnóstico / paridad H19); la verdad es GOLDEN.
void CAPTURED_HTTP_GLOBAL_AGENT;
void CAPTURED_HTTPS_GLOBAL_AGENT;
void CAPTURED_HTTP_AGENT_PROTO_CC;
void CAPTURED_HTTPS_AGENT_PROTO_CC;
void CAPTURED_HTTP_AGENT_PROTO_LOOKUP;
void CAPTURED_HTTPS_AGENT_PROTO_LOOKUP;

/** OBS-3: denegaciones en tiempo de llamada (sobrevive try/catch + restore). */
export type DenialRecord = {
  api: string;
  label: string;
  kind: string;
};
let denialLog: DenialRecord[] = [];

export function getDenialLog(): readonly DenialRecord[] {
  return denialLog;
}

function recordDenial(api: string, label: string, kind: string): void {
  denialLog.push({ api, label, kind });
}

export function isImportTainted(): boolean {
  return importTainted;
}

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
  if (LOOPBACK.has(n) || n.endsWith('.localhost')) return true;
  // H21-V11: IPv4-mapped remota (::ffff:203.0.113.x) NO es loopback.
  if (n === '::ffff:127.0.0.1' || n === '::ffff:0.0.0.0') return true;
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(n);
  if (m) return isLoopbackHost(m[1]);
  return false;
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

/** H21: dirección IP efectiva (no hostname). */
export function isLoopbackAddress(addr: string): boolean {
  return isLoopbackHost(addr);
}

/** H21-V10: ninguna entrada no-loopback en lista `all`. */
export function isResolvedAddressListSafe(
  entries: ReadonlyArray<{ address?: string } | string>,
): boolean {
  if (!entries || entries.length === 0) return false;
  for (const e of entries) {
    const a = typeof e === 'string' ? e : e && e.address;
    if (typeof a !== 'string' || !isLoopbackAddress(a)) return false;
  }
  return true;
}

function isIpLiteral(h: string): boolean {
  const n = h.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(n)) return true;
  if (n.includes(':')) return true; // IPv6 / mapped
  return false;
}

/**
 * H21-dns: dns.lookup / dns.promises.lookup por descriptor (sin [[Get]]).
 * Accessor o identidad distinta del golden → no confiable.
 */
export function dnsSurfacesTrusted(): boolean {
  try {
    const live = snapDesc(dns as object, 'lookup');
    const g = GOLDEN.dnsLookupDesc;
    if (!descsEqual(live, g)) return false;
    if (!('missing' in live) && (live.hasGet || live.hasSet)) return false;
    if (!('missing' in live) && !live.hasGet && live.value !== GOLDEN.dnsLookup) return false;

    const liveP = snapDesc(dns.promises as object, 'lookup');
    const gp = GOLDEN.dnsPromisesLookupDesc;
    if (!descsEqual(liveP, gp)) return false;
    if (!('missing' in liveP) && (liveP.hasGet || liveP.hasSet)) return false;
    if (!('missing' in liveP) && !liveP.hasGet && liveP.value !== GOLDEN.dnsPromisesLookup) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** True si el destino efectivo requeriría consultar DNS (hostname o implícito). */
export function targetWouldUseDns(target: ResolvedNetTarget): boolean {
  if (target.kind === 'loopback-implicit') return true;
  if (target.kind === 'ipc') return false;
  if (target.kind === 'unknown') return true;
  if (target.kind === 'host') {
    if (target.host === UNTRUSTED_HOST) return false;
    return !isIpLiteral(target.host);
  }
  return true;
}

/**
 * H21-C23: aviso si hay interfaces no-loopback. Inyectable para el test.
 * El stub **no sustituye** bwrap --unshare-net.
 */
export function warnIfNotIsolated(
  getInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): void {
  try {
    const ifs = getInterfaces();
    for (const addrs of Object.values(ifs || {})) {
      if (!addrs) continue;
      for (const a of addrs) {
        if (a.internal) continue;
        if (a.address && !isLoopbackAddress(a.address)) {
          console.warn(
            'p8a: el stub no sustituye el aislamiento de red del SO (bwrap --unshare-net o equivalente)',
          );
          return;
        }
      }
    }
  } catch {
    console.warn(
      'p8a: el stub no sustituye el aislamiento de red del SO (bwrap --unshare-net o equivalente)',
    );
  }
}


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

function moduleBaselinesIntact(mod: 'http' | 'https'): boolean {
  if (importTainted) return false;
  try {
    const api = mod === 'https' ? https : http;
    const golden = mod === 'https' ? GOLDEN.https : GOLDEN.http;
    if (api.globalAgent !== golden.globalAgent) return false;
    if (Object.getPrototypeOf(api.globalAgent) !== api.Agent.prototype) return false;
    if (api.Agent !== golden.AgentCtor) return false;
    if (liveProtoDescsUntrusted(mod)) return false;
    if (liveOptionsUntrusted(mod)) return false;
    if (agentOwnTransportUntrusted(api.globalAgent)) return false;
    return true;
  } catch {
    return false;
  }
}

/** H20-A: construction trust for agent:false (Node: new globalAgent.constructor()). */
function agentFalseConstructionTrusted(mod: 'http' | 'https'): boolean {
  if (!moduleBaselinesIntact(mod)) return false;
  const api = mod === 'https' ? https : http;
  const golden = mod === 'https' ? GOLDEN.https : GOLDEN.http;
  try {
    if (Object.getPrototypeOf(api.globalAgent) !== api.Agent.prototype) return false;
    if (objectHasOwnFunctionHook(api.globalAgent, 'constructor')) return false;
    const ctor = constructorViaDescriptor(api.globalAgent);
    if (ctor !== golden.AgentCtor) return false;
    // constructor's .prototype must be Agent.prototype
    if (
      ctor &&
      typeof ctor === 'function' &&
      (ctor as { prototype?: unknown }).prototype !== api.Agent.prototype
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * H17/H18/H19-B/H20: Agent efectivo no confiable.
 * Comprueba por descriptor (C06), no por [[Get]] de createConnection/lookup.
 */
function isUntrustedHttpAgent(agent: unknown, mod: 'http' | 'https'): boolean {
  if (importTainted) return true;
  if (!moduleBaselinesIntact(mod)) return true;
  if (agent === undefined || agent === null) return false;
  // agent:false → Node hace new (globalAgent.constructor)(); H20-A exige ctor/proto OK.
  if (agent === false) return !agentFalseConstructionTrusted(mod);
  if (typeof agent !== 'object') return true;
  const a = agent as object;
  if (proxyInPrototypeChain(a)) return true;
  if (agentOwnTransportUntrusted(a)) return true;
  const api = mod === 'https' ? https : http;
  const golden = mod === 'https' ? GOLDEN.https : GOLDEN.http;
  try {
    const proto = Object.getPrototypeOf(a);
    if (proto !== api.Agent.prototype) return true;
  } catch {
    return true;
  }
  // Descriptor-based createConnection / lookup on the agent chain (C03/C06)
  try {
    for (const key of ['createConnection', 'lookup'] as const) {
      let cur: object | null = a;
      while (cur && cur !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(cur, key)) {
          const d = Object.getOwnPropertyDescriptor(cur, key);
          if (!d) return true;
          if (d.get || d.set) return true;
          const g = golden.protoDescs[key];
          if (key === 'createConnection') {
            if (d.value !== golden.createConnection) return true;
          } else if (typeof d.value === 'function') {
            if (!g || 'missing' in g || d.value !== g.value) return true;
          }
          break;
        }
        cur = Object.getPrototypeOf(cur);
      }
    }
  } catch {
    return true;
  }
  try {
    if (a !== golden.globalAgent) return true; // H17 no-default / H19-B reemplazo
  } catch {
    return true;
  }
  return false;
}

/** Expuesto para afterEach de aislamiento (H19/H20 matriz). */
export function assertHttpTransportBaselinesIntact(): void {
  expect(importTainted, 'importTainted debe ser false entre tests').toBe(false);
  expect(dnsSurfacesTrusted(), 'dns.lookup/promises.lookup golden').toBe(true);
  expect(http.globalAgent, 'http.globalAgent identidad').toBe(GOLDEN.http.globalAgent);
  expect(https.globalAgent, 'https.globalAgent identidad').toBe(GOLDEN.https.globalAgent);
  expect(Object.getPrototypeOf(http.globalAgent), 'http.globalAgent [[Prototype]]').toBe(
    http.Agent.prototype,
  );
  expect(Object.getPrototypeOf(https.globalAgent), 'https.globalAgent [[Prototype]]').toBe(
    https.Agent.prototype,
  );
  expect(http.Agent.prototype.createConnection, 'http.Agent.prototype.createConnection').toBe(
    GOLDEN.http.createConnection,
  );
  expect(https.Agent.prototype.createConnection, 'https.Agent.prototype.createConnection').toBe(
    GOLDEN.https.createConnection,
  );
  for (const k of PROTO_TRANSPORT_KEYS) {
    expect(
      descsEqual(snapDesc(http.Agent.prototype, k), GOLDEN.http.protoDescs[k]),
      `http.Agent.prototype.${k} descriptor`,
    ).toBe(true);
  }
  expect(liveOptionsUntrusted('http'), 'http.globalAgent.options snap').toBe(false);
  expect(liveOptionsUntrusted('https'), 'https.globalAgent.options snap').toBe(false);
  for (const key of ['createConnection', 'lookup', 'addRequest', 'createSocket'] as const) {
    expect(
      Object.prototype.hasOwnProperty.call(http.globalAgent, key),
      `http.globalAgent own ${key}`,
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(https.globalAgent, key),
      `https.globalAgent own ${key}`,
    ).toBe(false);
  }
}

/** H18: Agent efectivo que Node usará (options.agent ?? módulo.globalAgent). */
function effectiveHttpAgent(
  options: Record<string, unknown>,
  mod: 'http' | 'https',
): unknown {
  try {
    // ClientRequest copia solo propiedades propias enumerables. No ejecutar getters
    // de selección de agente ni confiar en agent:false heredado/no enumerable.
    for (const key of ['agent', '_defaultAgent'] as const) {
      if (ownEnumerableAccessor(options, key)) return UNTRUSTED_HOST;
    }
    const globalAgent = mod === 'https' ? https.globalAgent : http.globalAgent;
    const defaultAgent = ownEnumerableKey(options, '_defaultAgent')
      ? options._defaultAgent || globalAgent
      : globalAgent;
    // `_defaultAgent` es otra entrada al transporte (incluido agent:false).
    if (defaultAgent !== globalAgent) return UNTRUSTED_HOST;
    const raw = ownEnumerableKey(options, 'agent') ? options.agent : undefined;
    if (raw === false) {
      // Node crea new defaultAgent.constructor(); un constructor own no es seguro.
      if (objectHasOwnFunctionHook(globalAgent, 'constructor')) return UNTRUSTED_HOST;
      return false;
    }
    if (raw === undefined || raw === null || raw === true) return globalAgent;
    return raw;
  } catch {
    return UNTRUSTED_HOST; // sentinel: caller treats as untrusted via isUntrusted
  }
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
      if (isUntrustedHttpAgent(eff, api)) return true;
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
      // Conservar selección efectiva al validar el objeto fusionado. Omitir agent
      // reintroduciría globalAgent incluso cuando Node usará un Agent nuevo (false).
      for (const key of ['agent', '_defaultAgent'] as const) {
        if (ownEnumerableKey(options, key)) merged[key] = options[key];
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
    // H18/P2: URL sin options también usa globalAgent; no retornar antes del guard.
    if (opts || api !== 'net') return mergeUrlAndOptions(baseHost, opts, api);
    if (baseHost) return { kind: 'host', host: baseHost };
    if (a0.includes('/') && !a0.includes('://')) return { kind: 'ipc' };
    return { kind: 'host', host: a0.split(':')[0] };
  }

  // H9: http(s).request/get(new URL(...), options?) — misma fusión que string.
  if (isUrlObject(a0)) {
    // Node urlToHttpOptions copia extensiones enumerables de URL. No ignorar
    // transportes ocultos en el objeto URL, incluso sin options separado.
    // Fail-closed: solo URL estándar, sin extensiones propias de string. Incluye
    // accessors hostname/href no enumerables, que Node puede releer al copiar URL.
    if (api !== 'net') {
      if (proxyInPrototypeChain(a0)) return { kind: 'host', host: UNTRUSTED_HOST };
      if (Object.getPrototypeOf(a0) !== URL.prototype || Object.getOwnPropertyNames(a0).length > 0) {
        return { kind: 'host', host: UNTRUSTED_HOST };
      }
    }
    const baseHost = a0.hostname || null;
    if (opts || api !== 'net') return mergeUrlAndOptions(baseHost, opts, api);
    return baseHost ? { kind: 'host', host: baseHost } : { kind: 'unknown' };
  }

  // options object (HTTP: hostname>host; net: host>hostname)
  if (a0 && typeof a0 === 'object') {
    return targetFromOptionsResolved(a0 as Record<string, unknown>, api);
  }

  return { kind: 'unknown' };
}

export function isAllowedLocalTarget(target: ResolvedNetTarget): boolean {
  // H21: no clasificar ALLOWED un hostname loopback si dns.* está manipulado.
  if (!dnsSurfacesTrusted() && targetWouldUseDns(target)) return false;
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
  denialLog = [];
  spies.httpRequest.mockClear();
  spies.httpGet.mockClear();
  spies.httpsRequest.mockClear();
  spies.httpsGet.mockClear();
  spies.netConnect.mockClear();
  spies.netCreateConnection.mockClear();
}

export function installDeniedNetwork(): DeniedNetworkSpies {
  // H21-C23: aviso E-B si hay interfaces no-loopback (no aborta la suite).
  warnIfNotIsolated();
  // Cada instalación arranca con log limpio (OBS-3); evita fugas entre tests.
  denialLog = [];
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
    // OBS-6/C19: módulo tainted → denegar todo http(s) (net sigue reglas normales).
    const forceDeny = alwaysDeny || (importTainted && (kind === 'http' || kind === 'https'));
    const target = forceDeny && importTainted && (kind === 'http' || kind === 'https')
      ? ({ kind: 'host', host: UNTRUSTED_HOST } as ResolvedNetTarget)
      : resolveNetTarget(args, kind);
    // H21: denegar ANTES de cualquier connect si DNS está taint y el destino usaría DNS.
    if (
      !forceDeny &&
      !dnsSurfacesTrusted() &&
      targetWouldUseDns(target)
    ) {
      recordDenial(apiName, 'dns-untrusted', kind);
      throw new Error(`p8a: ${apiName} denegado en tests (P8G-06) host=dns-untrusted`);
    }
    if (!forceDeny && isAllowedLocalTarget(target)) {
      return original(...args);
    }
    const label =
      target.kind === 'host'
        ? target.host
        : target.kind === 'loopback-implicit'
          ? '(loopback-implicit)'
          : target.kind;
    // OBS-3: registrar en el momento de la llamada (antes del throw).
    recordDenial(apiName, String(label), kind);
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
  // OBS-3: fallar si hubo denegaciones registradas en tiempo de llamada
  // (p. ej. tragadas por try/catch + restore), aunque mock.calls se re-resuelvan limpios.
  expect(denialLog, 'denegaciones registradas en tiempo de llamada (OBS-3)').toEqual([]);

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
