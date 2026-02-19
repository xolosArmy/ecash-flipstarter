import {
  CHRONIK_URL,
  USE_CHRONIK,
  USE_MOCK,
  ecashConfig,
} from '../config/ecash';
import { ChronikClient, type ScriptType } from 'chronik-client';
import type { BroadcastResult, Utxo } from './types';
import cashaddr from 'ecashaddrjs';
import { validateAddress } from '../utils/validation';
import { parse as parseProtobuf } from 'protobufjs';

const rpcUrl = ecashConfig.rpcUrl;
const rpcUser = ecashConfig.rpcUsername;
const rpcPass = ecashConfig.rpcPassword;

const effectiveChronikBaseUrl = CHRONIK_URL;
const chronik = new ChronikClient([effectiveChronikBaseUrl]);

const chronikUtxosProto = parseProtobuf(`
syntax = "proto3";

message OutPoint {
  bytes txid = 1;
  uint32 out_idx = 2;
}

message ScriptUtxo {
  OutPoint outpoint = 1;
  int32 block_height = 2;
  bool is_coinbase = 3;
  int64 sats = 4;
  bool is_final = 5;
  bytes token = 6;
  bytes plugins = 8;
}

message ScriptUtxos {
  repeated ScriptUtxo utxos = 1;
  bytes output_script = 2;
}
`).root.lookupType('ScriptUtxos');

export type ChronikUnavailableDetails = {
  url: string;
  status?: number;
  contentType?: string;
};

export class ChronikUnavailableError extends Error {
  details: ChronikUnavailableDetails;

  constructor(message: string, details: ChronikUnavailableDetails) {
    super(message);
    this.name = 'ChronikUnavailableError';
    this.details = details;
  }
}

export function isSpendableXecUtxo(utxo: Utxo): boolean {
  return !utxo.token
    && !utxo.slpToken
    && !utxo.tokenStatus
    && !utxo.plugins?.token;
}

export type TransactionOutput = {
  valueSats: bigint;
  scriptPubKey: string;
};

export type TransactionInfo = {
  txid: string;
  outputs: TransactionOutput[];
  confirmations: number;
  height: number;
};

export function getEffectiveChronikBaseUrl(): string {
  return effectiveChronikBaseUrl;
}

export function normalizeChronikAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.toLowerCase().startsWith('ecash:')) {
    return trimmed.slice('ecash:'.length);
  }
  if (trimmed.toLowerCase().startsWith('bitcoincash:')) {
    return trimmed.slice('bitcoincash:'.length);
  }
  return trimmed;
}

/**
 * Query UTXOs for a given address using Chronik or RPC depending on config.
 */
export async function getUtxosForAddress(address: string): Promise<Utxo[]> {
  if (USE_MOCK) {
    return [
      {
        txid: 'mocked-utxo-txid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        vout: 0,
        value: 500000000n,
        scriptPubKey: '6a',
      },
    ];
  }
  if (USE_CHRONIK) {
    return getUtxosForAddressViaChronik(address);
  }
  return getUtxosForAddressViaRpc(address);
}

export async function getUtxosForScript(
  scriptType: ScriptType,
  scriptHash: string
): Promise<Utxo[]> {
  if (USE_MOCK) {
    return [
      {
        txid: 'mocked-utxo-txid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        vout: 0,
        value: 500000000n,
        scriptPubKey: '6a',
      },
    ];
  }
  if (!USE_CHRONIK) {
    throw new Error('script-utxos-requires-chronik');
  }
  return getUtxosForScriptViaChronik(scriptType, scriptHash);
}

export async function getTipHeight(): Promise<number> {
  if (USE_MOCK) {
    return 0;
  }
  if (USE_CHRONIK) {
    const info = await getBlockchainInfo();
    return info.tipHeight;
  }
  return rpcCall<number>('getblockcount');
}

/**
 * Broadcast a raw transaction using Chronik or RPC depending on config.
 */
export async function broadcastTx(rawTxHex: string): Promise<BroadcastResult> {
  if (USE_MOCK) {
    return { txid: `mock-txid-${Date.now().toString(16)}` };
  }
  if (USE_CHRONIK) {
    return broadcastRawTxViaChronik(rawTxHex);
  }
  return broadcastRawTxViaRpc(rawTxHex);
}

export async function broadcastRawTx(rawTxHex: string): Promise<BroadcastResult> {
  return broadcastTx(rawTxHex);
}

export async function getTransactionOutputs(txid: string): Promise<TransactionOutput[]> {
  if (USE_MOCK) {
    return [];
  }
  if (USE_CHRONIK) {
    return getTransactionOutputsViaChronik(txid);
  }
  return getTransactionOutputsViaRpc(txid);
}

export async function getTransactionInfo(txid: string): Promise<TransactionInfo> {
  if (USE_MOCK) {
    return { txid, outputs: [], confirmations: 0, height: -1 };
  }
  if (USE_CHRONIK) {
    return getTransactionInfoViaChronik(txid);
  }
  return getTransactionInfoViaRpc(txid);
}

async function getUtxosForAddressViaChronik(address: string): Promise<Utxo[]> {
  const normalizedAddress = normalizeChronikAddress(address);
  const cleanBaseUrl = effectiveChronikBaseUrl.replace(/\/+$/, '');
  const path = `/address/${normalizedAddress}/utxos`;
  const requestUrl = `${cleanBaseUrl}${path}`;
  console.log(`[chronik] baseUrl=${cleanBaseUrl}`);
  console.log(`[chronik] utxosPath=${path}`);

  let response: Response;
  try {
    response = await fetch(requestUrl);
  } catch (err) {
    throw new ChronikUnavailableError('chronik-network-error', {
      url: requestUrl,
      contentType: undefined,
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  console.log(`[chronik] contentType=${contentType || 'unknown'}`);
  if (!response.ok) {
    throw new ChronikUnavailableError('chronik-http-error', {
      url: requestUrl,
      status: response.status,
      contentType: contentType || undefined,
    });
  }

  if (contentType.toLowerCase().includes('application/x-protobuf')) {
    const raw = new Uint8Array(await response.arrayBuffer());
    type DecodedChronikUtxos = {
      utxos?: Array<{
        outpoint?: { txid?: Uint8Array; outIdx?: number };
        sats?: string | number | bigint;
        token?: Uint8Array;
        plugins?: Uint8Array;
      }>;
      outputScript?: Uint8Array;
    };
    let decoded: DecodedChronikUtxos;
    try {
      decoded = chronikUtxosProto.toObject(chronikUtxosProto.decode(raw), {
        longs: String,
        bytes: Array,
      }) as DecodedChronikUtxos;
    } catch (_err) {
      throw new ChronikUnavailableError('chronik-decode-error', {
        url: requestUrl,
        status: response.status,
        contentType: contentType || undefined,
      });
    }
    const outputScript = bytesToHex(decoded.outputScript);
    return (decoded.utxos ?? []).map((u) => ({
      txid: bytesToHex(u.outpoint?.txid),
      vout: typeof u.outpoint?.outIdx === 'number' ? u.outpoint.outIdx : 0,
      value: toBigIntSats(u.sats),
      scriptPubKey: outputScript,
      token: u.token && u.token.length > 0 ? u.token : undefined,
      plugins: u.plugins && u.plugins.length > 0 ? { token: u.plugins } : undefined,
    }));
  }

  let payload: {
    utxos?: Array<Record<string, unknown>>;
    outputScript?: string;
    output_script?: string;
  };
  try {
    payload = await response.json();
  } catch (_err) {
    throw new ChronikUnavailableError('chronik-json-parse-error', {
      url: requestUrl,
      status: response.status,
      contentType: contentType || undefined,
    });
  }

  const outputScript = payload.outputScript ?? payload.output_script ?? '';
  return (payload.utxos ?? []).map((u) => ({
    txid: String((u.outpoint as { txid?: string } | undefined)?.txid ?? ''),
    vout: Number((u.outpoint as { outIdx?: number; out_idx?: number } | undefined)?.outIdx ?? (u.outpoint as { out_idx?: number } | undefined)?.out_idx ?? 0),
    value: toBigIntSats(u.sats ?? u.value),
    scriptPubKey: String(outputScript),
    token: u.token,
    slpToken: u.slpToken,
    tokenStatus: u.tokenStatus,
    plugins: u.plugins as { token?: unknown; [key: string]: unknown } | undefined,
  }));
}

async function getUtxosForScriptViaChronik(
  scriptType: ScriptType,
  scriptHash: string
): Promise<Utxo[]> {
  const scriptUtxos = await chronikRequest(
    `script utxos for ${scriptType}:${scriptHash}`,
    () => chronik.script(scriptType, scriptHash).utxos()
  );
  return scriptUtxos.utxos.map((u) => {
    const chronikUtxo = u as unknown as Record<string, unknown>;
    return {
      txid: u.outpoint.txid,
      vout: u.outpoint.outIdx,
      value: u.sats,
      scriptPubKey: scriptUtxos.outputScript,
      token: chronikUtxo.token,
      slpToken: chronikUtxo.slpToken,
      tokenStatus: chronikUtxo.tokenStatus,
      plugins: chronikUtxo.plugins as { token?: unknown; [key: string]: unknown } | undefined,
    };
  });
}

async function broadcastRawTxViaChronik(rawTxHex: string): Promise<BroadcastResult> {
  const data = await chronikRequest('broadcast tx', () => chronik.broadcastTx(rawTxHex));
  return { txid: data.txid };
}

async function getTransactionOutputsViaChronik(txid: string): Promise<TransactionOutput[]> {
  const tx = await chronikRequest(`tx ${txid}`, () => chronik.tx(txid));
  const outputs = (tx as { outputs?: Array<{ sats?: unknown; outputScript?: unknown }> }).outputs ?? [];
  return outputs.map((output) => ({
    valueSats: toBigIntSats(output.sats),
    scriptPubKey: typeof output.outputScript === 'string' ? output.outputScript.toLowerCase() : '',
  }));
}

async function getTransactionInfoViaChronik(txid: string): Promise<TransactionInfo> {
  const tx = await chronikRequest(`tx ${txid}`, () => chronik.tx(txid));
  const txRecord = tx as {
    outputs?: Array<{ sats?: unknown; outputScript?: unknown }>;
    block?: { height?: unknown };
  };
  const outputs = (txRecord.outputs ?? []).map((output) => ({
    valueSats: toBigIntSats(output.sats),
    scriptPubKey: typeof output.outputScript === 'string' ? output.outputScript.toLowerCase() : '',
  }));
  const heightRaw = txRecord.block?.height;
  const height = typeof heightRaw === 'number' && Number.isFinite(heightRaw) ? Math.floor(heightRaw) : -1;
  return {
    txid,
    outputs,
    confirmations: height >= 0 ? 1 : 0,
    height,
  };
}

export async function getChronikBlockchainInfo() {
  return getBlockchainInfo();
}

export async function getBlockchainInfo() {
  if (USE_MOCK) {
    return { tipHeight: 0 };
  }
  if (!USE_CHRONIK) {
    throw new Error('blockchain-info-requires-chronik');
  }
  return chronikRequest('blockchain info', () => chronik.blockchainInfo());
}

/**
 * Perform a JSON-RPC call against the configured eCash node.
 */
export async function rpcCall<T = any>(method: string, params: any[] = []): Promise<T> {
  const auth = Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64');
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body,
    });
    const json = await res.json();
    if (json.error) {
      console.error(`RPC error ${method}:`, json.error);
      throw new Error(json.error.message || 'rpc-error');
    }
    return json.result as T;
  } catch (err) {
    console.error(`RPC call failed for ${method}:`, err);
    throw new Error(
      `rpc ${method} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function addressToScriptPubKey(address: string): Promise<string> {
  if (USE_MOCK) {
    return '6a';
  }
  try {
    const normalized = validateAddress(address, 'contributorAddress');
    const decoded = cashaddr.decode(normalized, true);
    const hashHex =
      typeof decoded.hash === 'string'
        ? decoded.hash
        : Buffer.from(decoded.hash).toString('hex');
    const type = decoded.type.toLowerCase();
    if (type === 'p2pkh') {
      return `76a914${hashHex}88ac`;
    }
    if (type === 'p2sh') {
      return `a914${hashHex}87`;
    }
    console.error(`Tipo de address no soportado para ${address}: ${decoded.type}`);
  } catch (err) {
    console.error(`Error derivando scriptPubKey de ${address}:`, err);
    throw new Error('invalid-address');
  }
  throw new Error('invalid-address');
}

async function getUtxosForAddressViaRpc(address: string): Promise<Utxo[]> {
  const utxos = await rpcCall<any[]>('listunspent', [0, 9999999, [address]]);
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(Math.round(u.amount * 1e8)), // assume amount in XEC float
    scriptPubKey: u.scriptPubKey,
  }));
}

async function broadcastRawTxViaRpc(rawTxHex: string): Promise<BroadcastResult> {
  const txid = await rpcCall<string>('sendrawtransaction', [rawTxHex]);
  return { txid };
}

async function getTransactionOutputsViaRpc(txid: string): Promise<TransactionOutput[]> {
  const tx = await rpcCall<{ vout?: Array<{ value?: unknown; scriptPubKey?: { hex?: unknown } }> }>(
    'getrawtransaction',
    [txid, true],
  );
  const outputs = tx.vout ?? [];
  return outputs.map((output) => {
    const scriptPubKey =
      output.scriptPubKey && typeof output.scriptPubKey.hex === 'string'
        ? output.scriptPubKey.hex.toLowerCase()
        : '';
    const valueSats =
      typeof output.value === 'number'
        ? BigInt(Math.round(output.value * 100_000_000))
        : toBigIntSats(output.value);
    return { valueSats, scriptPubKey };
  });
}

async function getTransactionInfoViaRpc(txid: string): Promise<TransactionInfo> {
  const tx = await rpcCall<{
    vout?: Array<{ value?: unknown; scriptPubKey?: { hex?: unknown } }>;
    confirmations?: unknown;
    blockhash?: unknown;
  }>('getrawtransaction', [txid, true]);
  const outputs = (tx.vout ?? []).map((output) => {
    const scriptPubKey =
      output.scriptPubKey && typeof output.scriptPubKey.hex === 'string'
        ? output.scriptPubKey.hex.toLowerCase()
        : '';
    const valueSats =
      typeof output.value === 'number'
        ? BigInt(Math.round(output.value * 100_000_000))
        : toBigIntSats(output.value);
    return { valueSats, scriptPubKey };
  });
  const confirmations =
    typeof tx.confirmations === 'number' && Number.isFinite(tx.confirmations)
      ? Math.max(0, Math.floor(tx.confirmations))
      : 0;
  return {
    txid,
    outputs,
    confirmations,
    height: tx.blockhash ? 1 : -1,
  };
}

async function chronikRequest<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const message = formatChronikError(err);
    throw new Error(`chronik ${label} failed for ${effectiveChronikBaseUrl}: ${message}`);
  }
}

function formatChronikError(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      message?: string;
      response?: { data?: any; status?: number };
    };
    const responseData = anyErr.response?.data;
    if (responseData) {
      const parts: string[] = [];
      if (typeof responseData.msg === 'string') {
        parts.push(responseData.msg);
      } else if (typeof responseData.error === 'string') {
        parts.push(responseData.error);
      }
      if (typeof responseData.code === 'number' || typeof responseData.code === 'string') {
        parts.push(`code ${responseData.code}`);
      }
      if (typeof anyErr.response?.status === 'number') {
        parts.push(`status ${anyErr.response.status}`);
      }
      if (parts.length) {
        return parts.join(' ');
      }
      return JSON.stringify(responseData);
    }
    if (typeof anyErr.message === 'string') {
      return anyErr.message;
    }
  }
  return String(err);
}

function toBigIntSats(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function bytesToHex(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    return Buffer.from(value).toString('hex');
  }
  return '';
}
