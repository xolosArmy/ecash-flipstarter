import { normalizeOutpoints } from './outpoints';

type ActivationBuildLike = {
  rawHex?: string;
  unsignedTxHex?: string;
  outpoints?: string[];
  inputsUsed?: Array<{ txid: string; vout: number }> | string[];
  unsignedTx?: {
    inputs?: Array<{ txid?: string; hash?: string; vout?: number; n?: number }>;
  };
  outputs?: Array<{ address?: string; valueSats?: number; value?: number | string }>;
  message?: string;
};

const OUTPOINT_REGEX = /^[0-9a-f]{64}:[0-9]+$/i;
const HEX_REGEX = /^[0-9a-f]+$/i;

export type ParsedEcashOutput = {
  address: string;
  valueSats: number;
};

export type ParsedEcashSignAndBroadcastRequest = {
  mode: 'legacy' | 'intent';
  outpoints: string[];
  outputs: ParsedEcashOutput[];
  totalSats: number;
  message?: string;
};

function parseOutpointString(
  value: string,
  field: 'outpoints' | 'inputsUsed' | 'unsignedTx.inputs',
): string {
  const normalized = value.trim().toLowerCase();
  if (!OUTPOINT_REGEX.test(normalized)) {
    throw new Error(`Formato inválido en ${field}: "${value}". Usa el formato txid:vout.`);
  }
  return normalized;
}

function parseOutpointObject(
  value: { txid?: string; hash?: string; vout?: number; n?: number },
  field: 'inputsUsed' | 'unsignedTx.inputs',
): string {
  const txidCandidate = typeof value.txid === 'string' ? value.txid : value.hash;
  const voutCandidate = Number.isInteger(value.vout) ? value.vout : value.n;
  if (typeof txidCandidate !== 'string' || !Number.isInteger(voutCandidate)) {
    throw new Error(`Formato inválido en ${field}: ${JSON.stringify(value)}. Usa el formato txid:vout.`);
  }
  return parseOutpointString(`${txidCandidate}:${voutCandidate}`, field);
}

function parseOutputs(outputs: unknown): ParsedEcashOutput[] {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('outputs es requerido y debe contener al menos una salida.');
  }
  return outputs.map((entry, index) => {
    const record = entry as { address?: unknown; valueSats?: unknown; value?: unknown };
    const address = typeof record.address === 'string' ? record.address.trim() : '';
    const valueSource = record.valueSats ?? record.value;
    const valueSats = typeof valueSource === 'string' ? Number(valueSource) : valueSource;
    if (!address) {
      throw new Error(`outputs[${index}].address es inválido.`);
    }
    if (!Number.isInteger(valueSats) || Number(valueSats) <= 0) {
      throw new Error(`outputs[${index}].valueSats/value es inválido.`);
    }
    return { address, valueSats: Number(valueSats) };
  });
}

export function parseEcashSignAndBroadcastRequest(payload: unknown): ParsedEcashSignAndBroadcastRequest {
  const request = (payload ?? {}) as ActivationBuildLike;
  const outpoints: string[] = [];

  if (Array.isArray(request.outpoints) && request.outpoints.length > 0) {
    for (const outpoint of request.outpoints) {
      if (typeof outpoint !== 'string') {
        throw new Error(`Formato inválido en outpoints: "${String(outpoint)}". Usa el formato txid:vout.`);
      }
      outpoints.push(parseOutpointString(outpoint, 'outpoints'));
    }
  }

  if (Array.isArray(request.inputsUsed) && request.inputsUsed.length > 0) {
    for (const input of request.inputsUsed) {
      if (typeof input === 'string') {
        outpoints.push(parseOutpointString(input, 'inputsUsed'));
      } else {
        outpoints.push(parseOutpointObject(input, 'inputsUsed'));
      }
    }
  }

  if (Array.isArray(request.unsignedTx?.inputs) && request.unsignedTx.inputs.length > 0) {
    for (const input of request.unsignedTx.inputs) {
      outpoints.push(parseOutpointObject(input, 'unsignedTx.inputs'));
    }
  }

  const outputs = parseOutputs(request.outputs);
  const totalSats = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  const mode: 'legacy' | 'intent' = outpoints.length > 0 ? 'legacy' : 'intent';
  const message = typeof request.message === 'string' && request.message.trim() ? request.message.trim() : undefined;

  return { mode, outpoints, outputs, totalSats, message };
}

export function getActivationRequestOutpoints(built: ActivationBuildLike): string[] {
  if (Array.isArray(built.outpoints) && built.outpoints.length > 0) {
    return built.outpoints.map((value) => parseOutpointString(value, 'outpoints'));
  }
  const inputs = built.inputsUsed || built.unsignedTx?.inputs || [];
  if (Array.isArray(inputs) && inputs.length > 0 && typeof inputs[0] === 'string') {
    return (inputs as string[]).map((value) => parseOutpointString(value, 'inputsUsed'));
  }
  return normalizeOutpoints(inputs as Array<{ txid: string; vout: number }>);
}

export function getActivationRawHex(built: ActivationBuildLike): string {
  const candidate = (built.rawHex || built.unsignedTxHex || '').trim().toLowerCase();
  if (!candidate || !HEX_REGEX.test(candidate) || candidate.length % 2 !== 0) {
    throw new Error('rawHex inválido para activación.');
  }
  return candidate;
}
