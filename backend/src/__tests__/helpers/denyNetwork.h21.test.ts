/**
 * H21-dns: manipulación de dns.lookup / dns.promises.lookup.
 * RH-1: interferencia harness agent:true/proto (OBS H18) — no confundir con R-3 (lockfile, t212u).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertHttpTransportBaselinesIntact,
  dnsSurfacesTrusted,
  expectNetworkDeniedUnused,
  installDeniedNetwork,
  isAllowedLocalTarget,
  isLoopbackAddress,
  isResolvedAddressListSafe,
  resolveNetTarget,
  targetWouldUseDns,
  warnIfNotIsolated,
} from './denyNetwork';

const REMOTE = '203.0.113.50';
const REMOTE2 = '203.0.113.51';
const MAPPED_REMOTE = '::ffff:203.0.113.50';

let socketAttempts = 0;
let guardSockets = true;

function installSocketGuard(): void {
  socketAttempts = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
    socketAttempts += 1;
    throw new Error('H21_SOCKET_FORBIDDEN');
  });
}

function hostileLookup(_h: unknown, o: unknown, cb?: unknown): void {
  let opts = o;
  let callback = cb as ((...a: unknown[]) => void) | undefined;
  if (typeof opts === 'function') {
    callback = opts as (...a: unknown[]) => void;
    opts = {};
  }
  const all = !!(opts && typeof opts === 'object' && (opts as { all?: boolean }).all);
  if (all) callback?.(null, [{ address: REMOTE, family: 4 }]);
  else callback?.(null, REMOTE, 4);
}

function hostilePromisesLookup(): Promise<dns.LookupAddress> {
  return Promise.resolve({ address: REMOTE, family: 4 });
}

function expectNegative(
  run: () => void,
  spies: ReturnType<typeof installDeniedNetwork>,
  re: RegExp,
): void {
  expect(run).toThrow(re);
  expect(socketAttempts).toBe(0);
  expect(() => expectNetworkDeniedUnused(spies)).toThrow(/denegaciones registradas/);
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

describe('H21-C01 V1 dns.lookup own pre-install', () => {
  it('[H21-C01][V1] http.get S1 localhost pre-install se deniega', () => {
    const prev = dns.lookup;
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = hostileLookup as typeof dns.lookup;
      expect(dnsSurfacesTrusted()).toBe(false);
      expect(isAllowedLocalTarget(resolveNetTarget(['http://localhost/'], 'http'))).toBe(false);
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.get('http://localhost/'),
        spies,
        /p8a: http\.get denegado/,
      );
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });

  it('[H21-C01][V1] http.request S8 + N3 localhost se deniega', () => {
    const prev = dns.lookup;
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = hostileLookup as typeof dns.lookup;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.request({ hostname: 'localhost', path: '/' }),
        spies,
        /p8a: http\.request denegado/,
      );
      expectNegative(
        () => net.connect({ host: 'localhost', port: 9 }),
        spies,
        /p8a: net\.connect denegado/,
      );
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
});

describe('H21-C02 V2 dns.lookup own post-install', () => {
  it('[H21-C02][V2] reemplazo after install se deniega', () => {
    const prev = dns.lookup;
    const spies = installDeniedNetwork();
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = hostileLookup as typeof dns.lookup;
      expectNegative(
        () => http.get('http://localhost/'),
        spies,
        /p8a: http\.get denegado/,
      );
      expectNegative(
        () => net.connect(9), // N1 implícito
        spies,
        /p8a: net\.connect denegado/,
      );
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
});

describe('H21-C03 V3 getter TOCTOU dns.lookup', () => {
  it('[H21-C03][V3] accessor en dns.lookup se deniega sin invocar getter del helper', () => {
    const prev = Object.getOwnPropertyDescriptor(dns, 'lookup')!;
    const orig = prev.value as typeof dns.lookup;
    let reads = 0;
    try {
      Object.defineProperty(dns, 'lookup', {
        configurable: true,
        get() {
          reads += 1;
          const stack = String(new Error().stack);
          return stack.includes('node:net') || stack.includes('node:dns')
            ? hostileLookup
            : orig;
        },
        set() {},
      });
      expect(dnsSurfacesTrusted()).toBe(false);
      const spies = installDeniedNetwork();
      expectNegative(() => http.get('http://localhost/'), spies, /p8a: http\.get denegado/);
      // helper usa descriptor: no debe haber leído el getter para confiar
      expect(reads).toBe(0);
    } finally {
      Object.defineProperty(dns, 'lookup', prev);
    }
  });
});

describe('H21-C04 V4 dns.promises.lookup pre-install', () => {
  it('[H21-C04][V4] promises.lookup own pre-install taint → DENIED', () => {
    const prev = dns.promises.lookup;
    try {
      (dns.promises as { lookup: typeof dns.promises.lookup }).lookup =
        hostilePromisesLookup as unknown as typeof dns.promises.lookup;
      expect(dnsSurfacesTrusted()).toBe(false);
      const spies = installDeniedNetwork();
      expectNegative(() => http.get('http://localhost/'), spies, /p8a: http\.get denegado/);
      expectNegative(
        () => net.connect({ host: 'localhost', port: 9 }),
        spies,
        /p8a: net\.connect denegado/,
      );
    } finally {
      (dns.promises as { lookup: typeof dns.promises.lookup }).lookup = prev;
    }
  });
});

describe('H21-C05 V5 dns.promises.lookup post-install', () => {
  it('[H21-C05][V5] promises.lookup after install → DENIED', () => {
    const prev = dns.promises.lookup;
    const spies = installDeniedNetwork();
    try {
      (dns.promises as { lookup: typeof dns.promises.lookup }).lookup =
        hostilePromisesLookup as unknown as typeof dns.promises.lookup;
      expectNegative(() => http.request('http://localhost/'), spies, /p8a: http\.request denegado/);
    } finally {
      (dns.promises as { lookup: typeof dns.promises.lookup }).lookup = prev;
    }
  });
});

describe('H21-C06 V6 getter TOCTOU dns.promises.lookup', () => {
  it('[H21-C06][V6] accessor en dns.promises.lookup → DENIED', () => {
    const prev = Object.getOwnPropertyDescriptor(dns.promises, 'lookup')!;
    let reads = 0;
    try {
      Object.defineProperty(dns.promises, 'lookup', {
        configurable: true,
        get() {
          reads += 1;
          return hostilePromisesLookup;
        },
        set() {},
      });
      expect(dnsSurfacesTrusted()).toBe(false);
      const spies = installDeniedNetwork();
      expectNegative(() => http.get('http://localhost/'), spies, /p8a: http\.get denegado/);
      expect(reads).toBe(0);
    } finally {
      Object.defineProperty(dns.promises, 'lookup', prev);
    }
  });
});

describe('H21-C07 V7/V8 options.lookup y Agent lookup', () => {
  it('[H21-C07][V7] options.lookup hostil en S5 se deniega', () => {
    const lookup = vi.fn(() => {
      throw new Error('H21_V7_LOOKUP');
    });
    const spies = installDeniedNetwork();
    expectNegative(
      () => http.get('http://localhost/', { lookup: lookup as never }),
      spies,
      /p8a: http\.get denegado/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('[H21-C07][V8] globalAgent own lookup se deniega', () => {
    const prev = Object.getOwnPropertyDescriptor(http.globalAgent, 'lookup');
    const lookup = vi.fn(() => {
      throw new Error('H21_V8_AGENT_LOOKUP');
    });
    try {
      Object.defineProperty(http.globalAgent, 'lookup', {
        configurable: true,
        writable: true,
        value: lookup,
      });
      const spies = installDeniedNetwork();
      expectNegative(() => http.get('http://localhost/'), spies, /p8a: http\.get denegado/);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      if (prev) Object.defineProperty(http.globalAgent, 'lookup', prev);
      else Reflect.deleteProperty(http.globalAgent, 'lookup');
    }
  });
});

describe('H21-C08 V9 family/hints', () => {
  it('[H21-C08][V9] dns.lookup hostil solo con family:6 → DENIED', () => {
    const prev = dns.lookup;
    const orig = prev.bind(dns);
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = ((h: unknown, o: unknown, cb?: unknown) => {
        let opts: Record<string, unknown> = {};
        let callback = cb as ((...a: unknown[]) => void) | undefined;
        if (typeof o === 'function') callback = o as (...a: unknown[]) => void;
        else if (o && typeof o === 'object') opts = o as Record<string, unknown>;
        if (opts.family === 6 || opts.hints) {
          callback?.(null, MAPPED_REMOTE, 6);
        } else {
          return (orig as Function)(h, o, cb);
        }
      }) as typeof dns.lookup;
      const spies = installDeniedNetwork();
      expectNegative(
        () => http.get('http://localhost/', { family: 6 } as never),
        spies,
        /p8a: http\.get denegado/,
      );
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
});

describe('H21-C09 V10 all:true segunda dirección', () => {
  it('[H21-C09][V10] lista all con 2ª remota → DENIED; list helper rechazo', () => {
    expect(
      isResolvedAddressListSafe([
        { address: '127.0.0.1', family: 4 } as { address: string },
        { address: REMOTE2, family: 4 } as { address: string },
      ]),
    ).toBe(false);
    expect(isResolvedAddressListSafe([{ address: '127.0.0.1' }])).toBe(true);

    const prev = dns.lookup;
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = ((h: unknown, o: unknown, cb?: unknown) => {
        let opts: Record<string, unknown> = {};
        let callback = cb as ((...a: unknown[]) => void) | undefined;
        if (typeof o === 'function') callback = o as (...a: unknown[]) => void;
        else if (o && typeof o === 'object') opts = o as Record<string, unknown>;
        if (opts.all) {
          callback?.(null, [
            { address: '127.0.0.1', family: 4 },
            { address: REMOTE2, family: 4 },
          ]);
        } else callback?.(null, REMOTE, 4);
      }) as typeof dns.lookup;
      const spies = installDeniedNetwork();
      expectNegative(() => http.get('http://localhost/'), spies, /p8a: http\.get denegado/);
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
});

describe('H21-C10 V11 IPv4-mapped remota', () => {
  it('[H21-C10][V11] ::ffff:203.0.113.50 no es loopback; dns taint DENIED', () => {
    expect(isLoopbackAddress(MAPPED_REMOTE)).toBe(false);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    const prev = dns.lookup;
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = ((_h, o, cb?: unknown) => {
        let callback = cb as ((...a: unknown[]) => void) | undefined;
        if (typeof o === 'function') callback = o as (...a: unknown[]) => void;
        callback?.(null, MAPPED_REMOTE, 6);
      }) as typeof dns.lookup;
      const spies = installDeniedNetwork();
      expectNegative(() => http.get('http://localhost/'), spies, /p8a: http\.get denegado/);
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
});

describe('H21-C14 matriz https + net implícito', () => {
  it('[H21-C14][V1] https S1 + N1 con dns taint se deniegan', () => {
    const prev = dns.lookup;
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = hostileLookup as typeof dns.lookup;
      const spies = installDeniedNetwork();
      expectNegative(() => https.get('https://localhost/'), spies, /p8a: https\.get denegado/);
      expectNegative(() => net.connect(9), spies, /p8a: net\.connect denegado/);
      expectNegative(() => net.createConnection({ port: 9 }), spies, /p8a: net\.createConnection denegado/);
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
});

describe('H21-C16 mutante anchors', () => {
  it('[H21-C16][M-H21-01] dnsSurfacesTrusted false tras own lookup', () => {
    const prev = dns.lookup;
    try {
      (dns as { lookup: typeof dns.lookup }).lookup = hostileLookup as typeof dns.lookup;
      expect(dnsSurfacesTrusted()).toBe(false);
    } finally {
      (dns as { lookup: typeof dns.lookup }).lookup = prev;
    }
  });
  it('[H21-C16][M-H21-02] dnsSurfacesTrusted false tras promises own', () => {
    const prev = dns.promises.lookup;
    try {
      (dns.promises as { lookup: typeof dns.promises.lookup }).lookup =
        hostilePromisesLookup as unknown as typeof dns.promises.lookup;
      expect(dnsSurfacesTrusted()).toBe(false);
    } finally {
      (dns.promises as { lookup: typeof dns.promises.lookup }).lookup = prev;
    }
  });
  it('[H21-C16][M-H21-05] mapped remota no loopback', () => {
    expect(isLoopbackAddress(MAPPED_REMOTE)).toBe(false);
  });
  it('[H21-C16][M-H21-06] all-list con 2ª remota insegura', () => {
    expect(
      isResolvedAddressListSafe([{ address: '127.0.0.1' }, { address: REMOTE2 }]),
    ).toBe(false);
  });
  it('[H21-C16][M-H21-08] targetWouldUseDns en N1', () => {
    expect(targetWouldUseDns({ kind: 'loopback-implicit' })).toBe(true);
    expect(targetWouldUseDns({ kind: 'host', host: '127.0.0.1' })).toBe(false);
  });
});

describe('H21-C23 E-B warnIfNotIsolated', () => {
  it('[H21-C23][EB] simula eth0 no-loopback → console.warn estable', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnIfNotIsolated(() => ({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      eth0: [
        {
          address: '203.0.113.8',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: null,
        },
      ],
    }));
    expect(spy).toHaveBeenCalled();
    const msg = String(spy.mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/no sustituye el aislamiento de red del SO/);
    expect(msg).toMatch(/unshare-net/);
  });
});
