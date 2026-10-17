// Fixtures sintéticos de PR-4 (DEC-AX-09 (a)). Solo test/: nada de esto existe en src/ ni dist/.
// - TEST_XPUB: xpub PÚBLICO del vector de prueba 1 de BIP32 (cadena m). Es material público de
//   prueba, sin llave privada; Teyolia solo deriva direcciones watch-only (R3).
// - FixtureTxProvider: Chronik por fixtures, sin red. Cada txid se resuelve a una tx sintética,
//   a un error de «no encontrada», a un fallo de disponibilidad o a una respuesta malformada.
import { TxNotFoundError, cashAddressToOutputScriptHex } from '@x402-xec/core';

export const TEST_XPUB = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
export const ORIGIN = 'https://api.teyolia.cash';
export const AMOUNT = '1000';

let n = 0;
/** txid sintético de 64 hex, único por llamada. */
export const nextTxid = () => (++n).toString(16).padStart(64, 'f');

export class FixtureTxProvider {
  #map = new Map();
  calls = 0;
  set(txid, value) { this.#map.set(txid, value); return txid; }
  async getTx(txid) {
    this.calls += 1;
    const v = this.#map.get(txid);
    if (v === undefined) throw new TxNotFoundError(txid);
    if (v === 'UNAVAILABLE') throw new Error('fixture: Chronik no disponible');
    if (typeof v === 'function') return v(this.calls);
    return v;
  }
}

/** Tx sintética que paga `sats` a `payTo` (script P2PKH derivado por el core, no a mano). */
export function payingTx({ txid, payTo, sats = BigInt(AMOUNT), isFinal = true, block, timeFirstSeen, token, extraOutputs = [] }) {
  const out = { sats, outputScript: cashAddressToOutputScriptHex(payTo), ...(token ? { token } : {}) };
  return { txid, outputs: [...extraOutputs, out], isFinal, ...(block ? { block } : {}), timeFirstSeen };
}

export function proofHeader(invoiceHash, txid, extra = {}) {
  return Buffer.from(JSON.stringify({ invoiceHash, network: 'xec:mainnet', txid, x402Version: 1, ...extra })).toString('base64url');
}
