import { describe, expect, it } from 'vitest';
import {
  getActivationRawHex,
  getActivationRequestOutpoints,
  parseEcashSignAndBroadcastRequest,
} from './activationPayload';

describe('activationPayload helpers', () => {
  it('prefers provided outpoints when valid', () => {
    const outpoint = `${'a'.repeat(64)}:2`;
    expect(getActivationRequestOutpoints({ outpoints: [outpoint] })).toEqual([outpoint]);
  });

  it('derives outpoints from inputsUsed', () => {
    const txid = 'b'.repeat(64);
    expect(getActivationRequestOutpoints({ inputsUsed: [{ txid, vout: 1 }] })).toEqual([`${txid}:1`]);
  });

  it('rejects malformed provided outpoints', () => {
    expect(() => getActivationRequestOutpoints({ outpoints: ['abc:1'] })).toThrow('Formato inválido');
  });

  it('rejects invalid rawHex', () => {
    expect(() => getActivationRawHex({ rawHex: 'xyz' })).toThrow('rawHex inválido');
  });

  it('parses intent-only payload as intent mode', () => {
    const parsed = parseEcashSignAndBroadcastRequest({
      outputs: [{ address: 'ecash:qz0example', valueSats: 1234 }],
      message: 'hola',
    });
    expect(parsed.mode).toBe('intent');
    expect(parsed.outputs).toEqual([{ address: 'ecash:qz0example', valueSats: 1234 }]);
    expect(parsed.totalSats).toBe(1234);
  });

  it('parses legacy inputsUsed payload as legacy mode', () => {
    const txid = 'c'.repeat(64);
    const parsed = parseEcashSignAndBroadcastRequest({
      inputsUsed: [{ txid, vout: 2 }],
      outputs: [{ address: 'ecash:qz0example', value: '777' }],
    });
    expect(parsed.mode).toBe('legacy');
    expect(parsed.outpoints).toEqual([`${txid}:2`]);
    expect(parsed.totalSats).toBe(777);
  });

  it('throws clear error for malformed legacy inputsUsed outpoint', () => {
    expect(() =>
      parseEcashSignAndBroadcastRequest({
        inputsUsed: ['abc:1'],
        outputs: [{ address: 'ecash:qz0example', valueSats: 777 }],
      }),
    ).toThrow('Formato inválido en inputsUsed: "abc:1". Usa el formato txid:vout.');
  });
});
