/** P2 / H18: regresión inerte; las fábricas sentinel lanzan antes de abrir sockets. */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import {
  assertHttpTransportBaselinesIntact,
  clearDeniedNetworkSpies,
  expectNetworkDeniedUnused,
  getDenialLog,
  installDeniedNetwork,
  isAllowedLocalTarget,
  isImportTainted,
  resolveNetTarget,
} from './denyNetwork';

const url = 'http://localhost/';
const overloads: [string, () => unknown[]][] = [
  ['string', () => [url]],
  ['URL', () => [new URL(url)]],
  ['string + callback', () => [url, () => {}]],
  ['URL + callback', () => [new URL(url), () => {}]],
  ['string + options', () => [url, {}]],
  ['URL + options', () => [new URL(url), {}]],
  ['options', () => [{ hostname: 'localhost', path: '/' }]],
  ['string + explicit globalAgent', () => [url, { agent: http.globalAgent }]],
  ['URL + explicit globalAgent', () => [new URL(url), { agent: http.globalAgent }]],
  ['options + explicit globalAgent', () => [{ hostname: 'localhost', agent: http.globalAgent }]],
  ['string + agent:null', () => [url, { agent: null }]],
  ['URL + agent:null', () => [new URL(url), { agent: null }]],
  ['options + agent:null', () => [{ hostname: 'localhost', agent: null }]],
];

function restoreOwnProperty(obj: object, key: string, descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(obj, key, descriptor);
  else Reflect.deleteProperty(obj, key);
}

// Respaldo independiente del helper bajo prueba: incluso una mutación vulnerable
// debe detenerse antes de DNS/socket. El candidato no debe alcanzar este respaldo.
// Solo aplica a describes negativos; los positivos abren sockets reales.
let socketAttempts = 0;
let guardSockets = true;

function installSocketGuard(): void {
  socketAttempts = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
    socketAttempts += 1;
    throw new Error('H18_SOCKET_FORBIDDEN');
  });
}

beforeEach(() => {
  if (guardSockets) installSocketGuard();
  else socketAttempts = 0;
});
afterEach(() => {
  try {
    if (guardSockets) expect(socketAttempts).toBe(0);
    assertHttpTransportBaselinesIntact();
  } finally {
    vi.restoreAllMocks();
  }
});

describe('P2 / H18: agente efectivo en todos los overloads HTTP', () => {
  for (const method of ['request', 'get'] as const) {
    it.each(overloads)(`${method}: control Node real %s alcanza la fábrica sentinel`, (_label, makeArgs) => {
      const previous = Object.getOwnPropertyDescriptor(http.globalAgent, 'createConnection');
      const factory = vi.fn(() => { throw new Error('H18_SENTINEL_FACTORY'); });
      try {
        Object.defineProperty(http.globalAgent, 'createConnection', {
          configurable: true, writable: true, value: factory,
        });
        // Sin guard: ejecuta ClientRequest/Agent reales, sin conexión ni DNS.
        expect(() => Reflect.apply(http[method], http, makeArgs())).toThrow('H18_SENTINEL_FACTORY');
        expect(factory).toHaveBeenCalledTimes(1);
      } finally {
        restoreOwnProperty(http.globalAgent, 'createConnection', previous);
      }
    });

    it.each(overloads)(`${method}: guard/resolver/aserción rechazan createConnection en %s`, (_label, makeArgs) => {
      const previous = Object.getOwnPropertyDescriptor(http.globalAgent, 'createConnection');
      const factory = vi.fn(() => { throw new Error('H18_SENTINEL_FACTORY'); });
      try {
        Object.defineProperty(http.globalAgent, 'createConnection', {
          configurable: true, writable: true, value: factory,
        });
        const spies = installDeniedNetwork();
        const args = makeArgs();
        let thrown = '';
        try { Reflect.apply(http[method], http, args); }
        catch (error) { thrown = (error as Error).message; }
        let assertionRejected = false;
        try { expectNetworkDeniedUnused(spies); }
        catch { assertionRejected = true; }
        expect({
          denied: thrown.startsWith(`p8a: http.${method} denegado`),
          factoryCalls: factory.mock.calls.length,
          allowed: isAllowedLocalTarget(resolveNetTarget(args, 'http')),
          assertionRejected,
        }).toEqual({ denied: true, factoryCalls: 0, allowed: false, assertionRejected: true });
      } finally {
        restoreOwnProperty(http.globalAgent, 'createConnection', previous);
      }
    });
  }

  it.each(overloads)('globalAgent.lookup también se rechaza en %s', (_label, makeArgs) => {
    const previous = Object.getOwnPropertyDescriptor(http.globalAgent, 'lookup');
    const lookup = vi.fn(() => { throw new Error('H18_SENTINEL_LOOKUP'); });
    try {
      Object.defineProperty(http.globalAgent, 'lookup', {
        configurable: true, writable: true, value: lookup,
      });
      expect(isAllowedLocalTarget(resolveNetTarget(makeArgs(), 'http'))).toBe(false);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      restoreOwnProperty(http.globalAgent, 'lookup', previous);
    }
  });

  it.each(overloads)('agente estándar conserva clasificación loopback en %s', (_label, makeArgs) => {
    expect(resolveNetTarget(makeArgs(), 'http')).toEqual({ kind: 'host', host: 'localhost' });
  });
});

const withOptions: [string, (options: Record<string, unknown>) => unknown[]][] = [
  ['string + options', (options) => [url, options]],
  ['URL + options', (options) => [new URL(url), options]],
  ['options', (options) => [{ hostname: 'localhost', ...options }]],
];

describe('H18: selección efectiva explícita y overlay HTTP', () => {
  for (const method of ['request', 'get'] as const) {
    it.each(['agent', '_defaultAgent', 'createConnection'] as const)(`${method}: URL extendida con %s se rechaza`, async (key) => {
      const custom = new http.Agent();
      const factory = vi.fn(() => { throw new Error('H18_URL_SENTINEL'); });
      custom.createConnection = factory;
      const extended = new URL(url);
      Object.defineProperty(extended, key, {
        enumerable: true, value: key === 'createConnection' ? factory : custom,
      });
      // Node copia extensiones URL. createConnection puede emitir error asíncrono;
      // la fábrica lanza antes de DNS/socket en cualquiera de los casos.
      try {
        const req = http[method](extended);
        req.on('error', () => {});
      } catch (error) {
        expect((error as Error).message).toBe('H18_URL_SENTINEL');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(factory).toHaveBeenCalledTimes(1);
      factory.mockClear();
      const spies = installDeniedNetwork();
      expect(() => {
        const req = http[method](extended);
        req.on('error', () => {}); // También seguro al ejecutar contra el helper vulnerable.
      }).toThrow(`p8a: http.${method} denegado`);
      expect(factory).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow();
    });

    it.each(withOptions)(`${method}: _defaultAgent custom en %s no alcanza transporte`, (_label, makeArgs) => {
      const custom = new http.Agent();
      const factory = vi.fn(() => { throw new Error('H18_DEFAULT_SENTINEL'); });
      custom.createConnection = factory;
      const args = makeArgs({ _defaultAgent: custom });
      // Control discriminante: Node real sí selecciona este transporte.
      expect(() => Reflect.apply(http[method], http, args)).toThrow('H18_DEFAULT_SENTINEL');
      expect(factory).toHaveBeenCalledTimes(1);
      factory.mockClear();
      const spies = installDeniedNetwork();
      expect(() => Reflect.apply(http[method], http, args)).toThrow(`p8a: http.${method} denegado`);
      expect(factory).not.toHaveBeenCalled();
      expect(isAllowedLocalTarget(resolveNetTarget(args, 'http'))).toBe(false);
      expect(() => expectNetworkDeniedUnused(spies)).toThrow();
      expect(isAllowedLocalTarget(resolveNetTarget(makeArgs({ _defaultAgent: custom, agent: false }), 'http'))).toBe(false);
    });

    it.each(withOptions)(`${method}: agent:false + Agent.prototype hostil se deniega (H19-B)`, (_label, makeArgs) => {
      // H19-B: agent:false crea Agent nuevo que hereda prototipo; proto envenenado → UNTRUSTED.
      const orig = http.Agent.prototype.createConnection;
      const protoFactory = vi.fn(() => { throw new Error('H19B_PROTO_SENTINEL'); });
      try {
        http.Agent.prototype.createConnection = protoFactory as typeof orig;
        const args = makeArgs({ agent: false });
        const spies = installDeniedNetwork();
        expect(isAllowedLocalTarget(resolveNetTarget(args, 'http'))).toBe(false);
        expect(() => Reflect.apply(http[method], http, args)).toThrow(`p8a: http.${method} denegado`);
        expect(protoFactory).not.toHaveBeenCalled();
        expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
      } finally {
        http.Agent.prototype.createConnection = orig;
      }
    });
  }

  it('URL extendida con lookup se rechaza sin ejecutar el hook', () => {
    const lookup = vi.fn(() => { throw new Error('H18_URL_LOOKUP_SENTINEL'); });
    const extended = Object.assign(new URL(url), { lookup });
    const spies = installDeniedNetwork();
    expect(() => http.request(extended)).toThrow('p8a: http.request denegado');
    expect(() => http.get(extended)).toThrow('p8a: http.get denegado');
    expect(() => expectNetworkDeniedUnused(spies)).toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['hostname', 'href', 'protocol'])('URL con accessor %s no enumerable se rechaza sin leerlo', (key) => {
    const getter = vi.fn(() => { throw new Error('H18_URL_ACCESSOR'); });
    const extended = new URL(url);
    Object.defineProperty(extended, key, { get: getter });
    installDeniedNetwork();
    expect(() => http.request(extended)).toThrow('p8a: http.request denegado');
    expect(() => http.get(extended)).toThrow('p8a: http.get denegado');
    expect(getter).not.toHaveBeenCalled();
  });

  it('URL subclass se rechaza antes de leer hostname redefinido', () => {
    const getter = vi.fn(() => 'localhost');
    class CustomURL extends URL {
      get hostname() { return getter(); }
    }
    expect(isAllowedLocalTarget(resolveNetTarget([new CustomURL(url)], 'http'))).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  for (const kind of ['inherited', 'non-enumerable', 'accessor'] as const) {
    it(`agent:false ${kind} no elude globalAgent`, () => {
      const previous = Object.getOwnPropertyDescriptor(http.globalAgent, 'createConnection');
      const factory = vi.fn(() => { throw new Error('H18_GLOBAL_SENTINEL'); });
      const getter = vi.fn(() => false);
      try {
        Object.defineProperty(http.globalAgent, 'createConnection', {
          configurable: true, writable: true, value: factory,
        });
        const options = kind === 'inherited' ? Object.create({ agent: false }) : {};
        options.hostname = 'localhost';
        if (kind === 'non-enumerable') Object.defineProperty(options, 'agent', { value: false });
        if (kind === 'accessor') Object.defineProperty(options, 'agent', { get: getter, enumerable: true });
        const spies = installDeniedNetwork();
        for (const first of [url, new URL(url)]) {
          expect(() => http.request(first, options)).toThrow('p8a: http.request denegado');
        }
        expect(() => http.request(options)).toThrow('p8a: http.request denegado');
        // La decisión no ejecuta accessors; el pretty-printer de la aserción puede
        // inspeccionar después los argumentos al construir su diagnóstico.
        expect(getter).not.toHaveBeenCalled();
        expect(() => expectNetworkDeniedUnused(spies)).toThrow();
        expect(factory).not.toHaveBeenCalled();
      } finally {
        restoreOwnProperty(http.globalAgent, 'createConnection', previous);
      }
    });
  }

  it('agent:false rechaza constructor propio en globalAgent', () => {
    const previous = Object.getOwnPropertyDescriptor(http.globalAgent, 'constructor');
    const constructor = vi.fn(() => { throw new Error('H18_CONSTRUCTOR_SENTINEL'); });
    try {
      Object.defineProperty(http.globalAgent, 'constructor', {
        configurable: true, writable: true, value: constructor,
      });
      for (const [, makeArgs] of withOptions) {
        expect(isAllowedLocalTarget(resolveNetTarget(makeArgs({ agent: false }), 'http'))).toBe(false);
      }
      expect(constructor).not.toHaveBeenCalled();
    } finally {
      restoreOwnProperty(http.globalAgent, 'constructor', previous);
    }
  });
});


const H19_OVERLOADS: [string, () => unknown[]][] = [
  ['string', () => [url]],
  ['URL', () => [new URL(url)]],
  ['string + callback', () => [url, () => {}]],
  ['URL + callback', () => [new URL(url), () => {}]],
  ['string + options', () => [url, {}]],
  ['URL + options', () => [new URL(url), {}]],
  ['string + options + callback', () => [url, {}, () => {}]],
  ['options', () => [{ hostname: 'localhost', path: '/' }]],
  ['options + callback', () => [{ hostname: 'localhost', path: '/' }, () => {}]],
];

describe('H19-B: Agent.prototype / subclase / identidad capturada', () => {
  for (const method of ['request', 'get'] as const) {
    it.each(H19_OVERLOADS)(`http.${method}: proto.createConnection hostil deniega en %s`, (_label, makeArgs) => {
      const orig = http.Agent.prototype.createConnection;
      const factory = vi.fn(() => {
        throw new Error('H19B_PROTO_FACTORY');
      });
      try {
        http.Agent.prototype.createConnection = factory as typeof orig;
        const spies = installDeniedNetwork();
        const args = makeArgs();
        expect(() => Reflect.apply(http[method], http, args)).toThrow(`p8a: http.${method} denegado`);
        expect(factory).not.toHaveBeenCalled();
        expect(isAllowedLocalTarget(resolveNetTarget(args, 'http'))).toBe(false);
        expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
      } finally {
        http.Agent.prototype.createConnection = orig;
      }
    });

    it.each(H19_OVERLOADS)(`https.${method}: proto.createConnection hostil clasifica UNTRUSTED en %s`, (_label, makeArgs) => {
      const orig = https.Agent.prototype.createConnection;
      const factory = vi.fn(() => {
        throw new Error('H19B_HTTPS_PROTO');
      });
      try {
        https.Agent.prototype.createConnection = factory as typeof orig;
        const spies = installDeniedNetwork();
        const args = makeArgs().map((a) =>
          typeof a === 'string' ? a.replace('http://', 'https://') : a instanceof URL ? new URL(a.toString().replace('http://', 'https://')) : a,
        );
        // https alwaysDeny; debe denegar + registrar + clasificar no-allowed
        expect(() => Reflect.apply(https[method], https, args)).toThrow(`p8a: https.${method} denegado`);
        expect(factory).not.toHaveBeenCalled();
        expect(isAllowedLocalTarget(resolveNetTarget(args, 'https'))).toBe(false);
        expect(() => expectNetworkDeniedUnused(spies)).toThrow();
      } finally {
        https.Agent.prototype.createConnection = orig;
      }
    });
  }

  it('globalAgent reemplazado por subclase → UNTRUSTED (todas firmas request)', () => {
    const prev = http.globalAgent;
    class HostileAgent extends http.Agent {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createConnection(o: any, cb?: any): never {
        throw new Error('H19B_SUBCLASS');
      }
    }
    try {
      (http as { globalAgent: http.Agent }).globalAgent = new HostileAgent();
      const spies = installDeniedNetwork();
      for (const [, makeArgs] of H19_OVERLOADS) {
        const args = makeArgs();
        expect(isAllowedLocalTarget(resolveNetTarget(args, 'http'))).toBe(false);
        expect(() => Reflect.apply(http.request, http, args)).toThrow(/p8a: http\.request denegado/);
      }
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      (http as { globalAgent: http.Agent }).globalAgent = prev;
    }
  });

  it('setPrototypeOf(globalAgent, protoHostil) → UNTRUSTED', () => {
    const prevProto = Object.getPrototypeOf(http.globalAgent);
    const hostile = {
      createConnection() {
        throw new Error('H19B_SETPROTO');
      },
    };
    Object.setPrototypeOf(hostile, http.Agent.prototype);
    try {
      Object.setPrototypeOf(http.globalAgent, hostile);
      expect(isAllowedLocalTarget(resolveNetTarget(['http://localhost/'], 'http'))).toBe(false);
      const spies = installDeniedNetwork();
      expect(() => http.request('http://localhost/')).toThrow(/p8a: http\.request denegado/);
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      Object.setPrototypeOf(http.globalAgent, prevProto);
    }
  });

  it('proto envenenado ANTES de installDeniedNetwork se deniega (captura al cargar módulo)', () => {
    const orig = http.Agent.prototype.createConnection;
    const factory = vi.fn(() => {
      throw new Error('H19B_BEFORE_INSTALL');
    });
    try {
      http.Agent.prototype.createConnection = factory as typeof orig;
      // install DESPUÉS del envenenamiento — baselines de módulo siguen siendo los originales
      const spies = installDeniedNetwork();
      expect(() => http.get('http://localhost/')).toThrow(/p8a: http\.get denegado/);
      expect(factory).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      http.Agent.prototype.createConnection = orig;
    }
  });

  it('Agent.prototype.lookup hostil → isAllowedLocalTarget=false', () => {
    const proto = http.Agent.prototype as { lookup?: unknown };
    const prev = proto.lookup;
    const hostile = vi.fn((_h: unknown, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '198.51.100.1', 4),
    );
    try {
      proto.lookup = hostile;
      expect(isAllowedLocalTarget(resolveNetTarget(['http://localhost/'], 'http'))).toBe(false);
      const spies = installDeniedNetwork();
      expect(() => http.request('http://localhost/')).toThrow(/p8a: http\.request denegado/);
      expect(hostile).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      if (prev === undefined) delete proto.lookup;
      else proto.lookup = prev;
    }
  });
});

describe('OBS-3: registro en tiempo de llamada', () => {
  it('denegación tragada + restore → expectNetworkDeniedUnused falla', () => {
    const previous = Object.getOwnPropertyDescriptor(http.globalAgent, 'createConnection');
    const factory = vi.fn(() => {
      throw new Error('OBS3_FACTORY');
    });
    const spies = installDeniedNetwork();
    try {
      Object.defineProperty(http.globalAgent, 'createConnection', {
        configurable: true,
        writable: true,
        value: factory,
      });
      try {
        http.request('http://localhost/');
      } catch {
        /* swallowed */
      }
    } finally {
      restoreOwnProperty(http.globalAgent, 'createConnection', previous);
    }
    // Estado global limpio, pero el log de llamada permanece
    expect(getDenialLog().length).toBeGreaterThan(0);
    expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    clearDeniedNetworkSpies(spies);
    expect(getDenialLog()).toEqual([]);
    // Tras clear, ruta limpia
    expect(() => expectNetworkDeniedUnused(spies)).not.toThrow();
  });

  it('https denegación tragada también queda registrada', () => {
    const spies = installDeniedNetwork();
    try {
      https.request('https://localhost/');
    } catch {
      /* alwaysDeny */
    }
    expect(getDenialLog().some((d) => d.api.startsWith('https.'))).toBe(true);
    expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas|https\.request/);
    clearDeniedNetworkSpies(spies);
  });
});

describe('H19 positivos: loopback real / agent:false limpio / net.connect(port)', () => {
  beforeAll(() => { guardSockets = false; });
  afterAll(() => { guardSockets = true; });

  it('http.get a servidor loopback efímero → body ok + aserto PASS', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('ok');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('http.request(new URL(...), cb) a loopback → body ok', async () => {
    const server = http.createServer((_req, res) => {
      res.end('url-ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.request(new URL(`http://127.0.0.1:${port}/`), (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        })
          .on('error', reject)
          .end();
      });
      expect(body).toBe('url-ok');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('agent:false con prototipo intacto a loopback → body ok', async () => {
    const server = http.createServer((_req, res) => {
      res.end('agent-false-ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, { agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('agent-false-ok');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('net.connect(port, host) loopback-explícito se permite', async () => {
    const server = net.createServer((sock) => {
      sock.end('n');
      sock.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const spies = installDeniedNetwork();
    try {
      await new Promise<void>((resolve, reject) => {
        const c = net.connect(port, '127.0.0.1', () => {
          c.end();
          resolve();
        });
        c.on('error', reject);
      });
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});


const H20_SIGS: [string, (proto: 'http' | 'https') => unknown[]][] = [
  ['S1', (p) => [`${p}://localhost/`]],
  ['S2', (p) => [new URL(`${p}://localhost/`)]],
  ['S3', (p) => [`${p}://localhost/`, () => {}]],
  ['S4', (p) => [new URL(`${p}://localhost/`), () => {}]],
  ['S5', (p) => [`${p}://localhost/`, {}]],
  ['S6', (p) => [new URL(`${p}://localhost/`), {}]],
  ['S7', (p) => [`${p}://localhost/`, {}, () => {}]],
  ['S8', (_p) => [{ hostname: 'localhost', path: '/' }]],
  ['S9', (_p) => [{ hostname: 'localhost', path: '/' }, () => {}]],
];

function expectNegative(
  run: () => void,
  factory: { mock?: { calls: unknown[] }; calls?: unknown[] } | ReturnType<typeof vi.fn>,
  spies: ReturnType<typeof installDeniedNetwork>,
  apiMsg: RegExp,
): void {
  const before = typeof (factory as any).mock === 'object'
    ? (factory as any).mock.calls.length
    : ((factory as any).calls?.length ?? 0);
  expect(run).toThrow(apiMsg);
  const after = typeof (factory as any).mock === 'object'
    ? (factory as any).mock.calls.length
    : ((factory as any).calls?.length ?? 0);
  expect(after).toBe(before);
  expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
}

describe('H20-C01 agent:false construction trust', () => {
  it('[H20-C01][V6] setPrototypeOf(globalAgent)+agent:false se deniega', () => {
    const prev = Object.getPrototypeOf(http.globalAgent);
    class Hostile extends http.Agent {
      createConnection(): never {
        throw new Error('H20_V6_FACTORY');
      }
    }
    const factory = vi.spyOn(Hostile.prototype, 'createConnection');
    try {
      Object.setPrototypeOf(http.globalAgent, Hostile.prototype);
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.request('http://localhost/', { agent: false }),
        factory,
        spies,
        /p8a: http\.request denegado/,
      );
    } finally {
      Object.setPrototypeOf(http.globalAgent, prev);
    }
  });

  it('[H20-C01][V7] Agent.prototype.constructor hostil + agent:false se deniega', () => {
    const had = Object.getOwnPropertyDescriptor(http.Agent.prototype, 'constructor');
    class Hostile extends http.Agent {
      createConnection(): never {
        throw new Error('H20_V7_FACTORY');
      }
    }
    const factory = vi.fn(() => {
      throw new Error('H20_V7_FACTORY');
    });
    Hostile.prototype.createConnection = factory as typeof Hostile.prototype.createConnection;
    try {
      Object.defineProperty(http.Agent.prototype, 'constructor', {
        value: Hostile,
        writable: true,
        configurable: true,
      });
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.request('http://localhost/', { agent: false }),
        factory,
        spies,
        /p8a: http\.request denegado/,
      );
    } finally {
      if (had) Object.defineProperty(http.Agent.prototype, 'constructor', had);
    }
  });

  it('[H20-C01][ctor-own] constructor own en globalAgent + agent:false se deniega', () => {
    const prev = Object.getOwnPropertyDescriptor(http.globalAgent, 'constructor');
    const ctor = vi.fn(() => {
      throw new Error('H20_CTOR_OWN');
    });
    try {
      Object.defineProperty(http.globalAgent, 'constructor', {
        configurable: true,
        writable: true,
        value: ctor,
      });
      const spies = installDeniedNetwork();
      expect(() => http.request('http://localhost/', { agent: false })).toThrow(
        /p8a: http\.request denegado/,
      );
      expect(ctor).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      if (prev) Object.defineProperty(http.globalAgent, 'constructor', prev);
      else Reflect.deleteProperty(http.globalAgent, 'constructor');
    }
  });
});

describe('H20-C02 [[Prototype]] globalAgent', () => {
  it('[H20-C02][V6] setPrototypeOf sin agent:false también deniega S1', () => {
    const prev = Object.getPrototypeOf(http.globalAgent);
    class Hostile extends http.Agent {
      createConnection(): never {
        throw new Error('H20_C02');
      }
    }
    try {
      Object.setPrototypeOf(http.globalAgent, Hostile.prototype);
      const spies = installDeniedNetwork();
      expect(() => http.get('http://localhost/')).toThrow(/p8a: http\.get denegado/);
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      Object.setPrototypeOf(http.globalAgent, prev);
    }
  });
});

describe('H20-C04 addRequest/createSocket', () => {
  it('[H20-C04][V3] globalAgent own addRequest se deniega', () => {
    const ga = http.globalAgent as http.Agent & { addRequest?: unknown };
    const factory = vi.fn();
    try {
      ga.addRequest = factory;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.get('http://localhost/'),
        factory,
        spies,
        /p8a: http\.get denegado/,
      );
    } finally {
      delete ga.addRequest;
    }
  });

  it('[H20-C04][V4] Agent.prototype.addRequest parcheado se deniega', () => {
    const proto = http.Agent.prototype as http.Agent & {
      addRequest: (...a: unknown[]) => unknown;
    };
    const orig = proto.addRequest;
    const factory = vi.fn(function (this: http.Agent, ...args: unknown[]) {
      return orig.apply(this, args);
    });
    try {
      proto.addRequest = factory as typeof orig;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.request({ hostname: 'localhost', port: 80 }),
        factory,
        spies,
        /p8a: http\.request denegado/,
      );
    } finally {
      proto.addRequest = orig;
    }
  });

  it('[H20-C04][V5] globalAgent own createSocket se deniega', () => {
    const ga = http.globalAgent as http.Agent & { createSocket?: unknown };
    const factory = vi.fn();
    try {
      ga.createSocket = factory;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.request('http://localhost/'),
        factory,
        spies,
        /p8a: http\.request denegado/,
      );
    } finally {
      delete ga.createSocket;
    }
  });

  it('[H20-C04][V9] Agent.prototype.createSocket parcheado se deniega', () => {
    const proto = http.Agent.prototype as http.Agent & {
      createSocket: (...a: unknown[]) => unknown;
    };
    const orig = proto.createSocket;
    const factory = vi.fn(function (this: http.Agent, ...args: unknown[]) {
      return orig.apply(this, args);
    });
    try {
      proto.createSocket = factory as typeof orig;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.request('http://localhost/', {}),
        factory,
        spies,
        /p8a: http\.request denegado/,
      );
    } finally {
      proto.createSocket = orig;
    }
  });
});

describe('H20-C05 globalAgent.options', () => {
  it('[H20-C05][V1] options.host remoto se deniega', () => {
    const ga = http.globalAgent as http.Agent & { options: Record<string, unknown> };
    const prev = ga.options.host;
    try {
      ga.options.host = '203.0.113.20';
      const spies = installDeniedNetwork();
      expect(() => http.get('http://localhost/')).toThrow(/p8a: http\.get denegado/);
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      if (prev === undefined) delete ga.options.host;
      else ga.options.host = prev;
    }
  });

  it('[H20-C05][V2] options.lookup hostil se deniega', () => {
    const ga = http.globalAgent as http.Agent & { options: Record<string, unknown> };
    const lookup = vi.fn((_h: unknown, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '203.0.113.21', 4),
    );
    try {
      ga.options.lookup = lookup;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.get('http://localhost/'),
        lookup,
        spies,
        /p8a: http\.get denegado/,
      );
    } finally {
      delete ga.options.lookup;
    }
  });
});

describe('H20-C06 TOCTOU descriptor', () => {
  it('[H20-C06][V8] getter TOCTOU en Agent.prototype.createConnection se deniega sin invocar', () => {
    const prev = Object.getOwnPropertyDescriptor(http.Agent.prototype, 'createConnection')!;
    const orig = prev.value as (...a: unknown[]) => unknown;
    let getterReads = 0;
    const hz = vi.fn(() => {
      throw new Error('H20_V8_HOSTILE');
    });
    try {
      Object.defineProperty(http.Agent.prototype, 'createConnection', {
        configurable: true,
        get() {
          getterReads += 1;
          return String(new Error().stack).includes('node:_http_agent') ? hz : orig;
        },
        set() {},
      });
      const spies = installDeniedNetwork();
      expect(() => http.get('http://localhost/')).toThrow(/p8a: http\.get denegado/);
      expect(getterReads).toBe(0);
      expect(hz).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      Object.defineProperty(http.Agent.prototype, 'createConnection', prev);
    }
  });
});

describe('H20-C07 paridad https', () => {
  it.each(H20_SIGS.slice(0, 3))('[H20-C07][V1] https %s options.host → classifiedAllowed=false', (_s, mk) => {
    const ga = https.globalAgent as https.Agent & { options: Record<string, unknown> };
    const prev = ga.options.host;
    try {
      ga.options.host = '203.0.113.20';
      expect(isAllowedLocalTarget(resolveNetTarget(mk('https'), 'https'))).toBe(false);
      const spies = installDeniedNetwork();
      expect(() => Reflect.apply(https.request, https, mk('https'))).toThrow(/p8a: https\.request denegado/);
      expect(() => expectNetworkDeniedUnused(spies)).toThrow();
    } finally {
      if (prev === undefined) delete ga.options.host;
      else ga.options.host = prev;
    }
  });
});

describe('H20-C08 post-install', () => {
  it('[H20-C08][V4] proto.addRequest tras installDeniedNetwork se deniega', () => {
    const spies = installDeniedNetwork();
    const proto = http.Agent.prototype as http.Agent & {
      addRequest: (...a: unknown[]) => unknown;
    };
    const orig = proto.addRequest;
    const factory = vi.fn(function (this: http.Agent, ...args: unknown[]) {
      return orig.apply(this, args);
    });
    try {
      proto.addRequest = factory as typeof orig;
      expectNegative(
        () => http.request('http://localhost/'),
        factory,
        spies,
        /p8a: http\.request denegado/,
      );
    } finally {
      proto.addRequest = orig;
    }
  });
});

describe('H20-C10 positivos', () => {
  beforeAll(() => {
    guardSockets = false;
  });
  afterAll(() => {
    guardSockets = true;
  });

  async function listenHttp(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    host: string,
  ): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, host, r));
    const port = (server.address() as { port: number }).port;
    return { server, port };
  }

  it('[H20-C10][P1] http.get 127.0.0.1 body ok', async () => {
    const { server, port } = await listenHttp((_q, res) => {
      res.end('p1');
    }, '127.0.0.1');
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          const c: Buffer[] = [];
          res.on('data', (b) => c.push(b));
          res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('p1');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('[H20-C10][P2] http.request URL ::1 body ok', async () => {
    const { server, port } = await listenHttp((_q, res) => {
      res.end('p2');
    }, '::1');
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .request(new URL(`http://[::1]:${port}/`), (res) => {
            const c: Buffer[] = [];
            res.on('data', (b) => c.push(b));
            res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
          })
          .on('error', reject)
          .end();
      });
      expect(body).toBe('p2');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('[H20-C10][P3] http.get localhost body ok', async () => {
    const { server, port } = await listenHttp((_q, res) => {
      res.end('p3');
    }, '127.0.0.1');
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://localhost:${port}/`, (res) => {
          const c: Buffer[] = [];
          res.on('data', (b) => c.push(b));
          res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('p3');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('[H20-C10][P4] agent:false limpio body ok', async () => {
    const { server, port } = await listenHttp((_q, res) => {
      res.end('p4');
    }, '127.0.0.1');
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, { agent: false }, (res) => {
          const c: Buffer[] = [];
          res.on('data', (b) => c.push(b));
          res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('p4');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('[H20-C10][P5] IPC socketPath body ok', async () => {
    const sock = path.join(os.tmpdir(), `p8a-h20-${process.pid}.sock`);
    try {
      fs.unlinkSync(sock);
    } catch {
      /* */
    }
    const server = http.createServer((_q, res) => {
      res.end('p5');
    });
    await new Promise<void>((r) => server.listen(sock, r));
    const spies = installDeniedNetwork();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ socketPath: sock, path: '/' }, (res) => {
          const c: Buffer[] = [];
          res.on('data', (b) => c.push(b));
          res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        }).on('error', reject);
      });
      expect(body).toBe('p5');
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      try {
        fs.unlinkSync(sock);
      } catch {
        /* */
      }
    }
  });

  it('[H20-C10][P6] net.connect(port) implícito real', async () => {
    const server = net.createServer((s) => {
      s.end('n');
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const spies = installDeniedNetwork();
    try {
      await new Promise<void>((resolve, reject) => {
        const c = net.connect({ port }, () => {
          c.end();
          resolve();
        });
        c.on('error', reject);
      });
      expectNetworkDeniedUnused(spies);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('[H20-C10][P7] supertest loopback body ok', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const app = express();
    app.get('/ping', (_req, res) => {
      res.status(200).send('p7');
    });
    const spies = installDeniedNetwork();
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.text).toBe('p7');
    expectNetworkDeniedUnused(spies);
  });
});

describe('H20-C11 cobertura negativa pendiente', () => {
  it('[H20-C11][i] https own createConnection × S1 deniega', () => {
    const prev = Object.getOwnPropertyDescriptor(https.globalAgent, 'createConnection');
    const factory = vi.fn(() => {
      throw new Error('H20_C11');
    });
    try {
      Object.defineProperty(https.globalAgent, 'createConnection', {
        configurable: true,
        writable: true,
        value: factory,
      });
      expect(isAllowedLocalTarget(resolveNetTarget(['https://localhost/'], 'https'))).toBe(false);
      const spies = installDeniedNetwork();
      expect(() => https.get('https://localhost/')).toThrow(/p8a: https\.get denegado/);
      expect(factory).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow();
    } finally {
      if (prev) Object.defineProperty(https.globalAgent, 'createConnection', prev);
      else Reflect.deleteProperty(https.globalAgent, 'createConnection');
    }
  });

  it('[H20-C11][ii] subclase globalAgent × get deniega', () => {
    const prev = http.globalAgent;
    class Hostile extends http.Agent {
      createConnection(): never {
        throw new Error('H20_C11_SUB');
      }
    }
    try {
      (http as { globalAgent: http.Agent }).globalAgent = new Hostile();
      const spies = installDeniedNetwork();
      expect(() => http.get('http://localhost/')).toThrow(/p8a: http\.get denegado/);
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      (http as { globalAgent: http.Agent }).globalAgent = prev;
    }
  });

  it('[H20-C11][iii] setPrototypeOf × agent:false (A5) deniega', () => {
    const prev = Object.getPrototypeOf(http.globalAgent);
    class Hostile extends http.Agent {
      createConnection(): never {
        throw new Error('H20_C11_SP');
      }
    }
    try {
      Object.setPrototypeOf(http.globalAgent, Hostile.prototype);
      const spies = installDeniedNetwork();
      expect(() => http.request('http://localhost/', { agent: false })).toThrow(
        /p8a: http\.request denegado/,
      );
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      Object.setPrototypeOf(http.globalAgent, prev);
    }
  });

  it('[H20-C11][iv] lookup proto vía stub+aserto', () => {
    const proto = http.Agent.prototype as { lookup?: unknown };
    const prev = proto.lookup;
    const hostile = vi.fn((_h: unknown, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '198.51.100.1', 4),
    );
    try {
      proto.lookup = hostile;
      const spies = installDeniedNetwork();
      expect(() => http.request('http://localhost/')).toThrow(/p8a: http\.request denegado/);
      expect(hostile).not.toHaveBeenCalled();
      expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
    } finally {
      if (prev === undefined) delete proto.lookup;
      else proto.lookup = prev;
    }
  });
});

describe('H20-C19 OBS-6 import tainted', () => {
  it('[H20-C19] isImportTainted false en carga limpia', () => {
    expect(isImportTainted()).toBe(false);
  });

  for (const [tag, poison, restore] of [
    [
      'V4',
      () => {
        const proto = http.Agent.prototype as http.Agent & {
          addRequest: (...a: unknown[]) => unknown;
        };
        const orig = proto.addRequest;
        proto.addRequest = function (this: http.Agent, ...a: unknown[]) {
          return (orig as Function).apply(this, a);
        } as typeof orig;
        return orig;
      },
      (orig: (...a: unknown[]) => unknown) => {
        (http.Agent.prototype as http.Agent & { addRequest: typeof orig }).addRequest = orig;
      },
    ],
    [
      'V6',
      () => {
        const prev = Object.getPrototypeOf(http.globalAgent);
        class H extends http.Agent {
          createConnection(): never {
            throw new Error('x');
          }
        }
        Object.setPrototypeOf(http.globalAgent, H.prototype);
        return prev;
      },
      (prev: object) => {
        Object.setPrototypeOf(http.globalAgent, prev);
      },
    ],
    [
      'V8',
      () => {
        const prev = Object.getOwnPropertyDescriptor(http.Agent.prototype, 'createConnection')!;
        Object.defineProperty(http.Agent.prototype, 'createConnection', {
          configurable: true,
          get() {
            return prev.value;
          },
          set() {},
        });
        return prev;
      },
      (prev: PropertyDescriptor) => {
        Object.defineProperty(http.Agent.prototype, 'createConnection', prev);
      },
    ],
    [
      'V1',
      () => {
        const ga = http.globalAgent as http.Agent & { options: Record<string, unknown> };
        const prev = ga.options.host;
        ga.options.host = '203.0.113.99';
        return prev;
      },
      (prev: unknown) => {
        const ga = http.globalAgent as http.Agent & { options: Record<string, unknown> };
        if (prev === undefined) delete ga.options.host;
        else ga.options.host = prev as string;
      },
    ],
  ] as const) {
    it(`[H20-C19][${tag}] poison antes de reimport → tainted DENIED`, async () => {
      const token = poison();
      try {
        vi.resetModules();
        const mod = await import('./denyNetwork');
        expect(mod.isImportTainted()).toBe(true);
        const spies = mod.installDeniedNetwork();
        expect(() => http.request('http://localhost/')).toThrow(/p8a: http\.request denegado/);
        expect(() => mod.expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
      } finally {
        restore(token as never);
        vi.resetModules();
        // rehydrate static bindings used by the rest of the file
        await import('./denyNetwork');
      }
    });
  }
});
