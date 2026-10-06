/**
 * Clave pública comprimida de secp256k1 que Tonalli asocia a la cuenta ecash: conectada.
 * La sesión puede traerla como `publicKey` o `pubkey`. La clave simulada de desarrollo no es válida.
 */
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha2';
import cashaddr from 'ecashaddrjs';

const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/;
export const SIMULATED_ECASH_PUBKEY =
  '020000000000000000000000000000000000000000000000000000000000000001';

export const TONALLI_PUBKEY_DISCLOSURE_MESSAGE =
  'Teyolia solicita la clave pública de tu cuenta eCash para registrarla como beneficiario de esta campaña. No se transfiere ningún fondo.';

export const MISSING_TONALLI_PUBKEY_MESSAGE =
  'No hay una clave pública eCash en esta sesión de Tonalli. Desconecta, vuelve a conectar la wallet y autoriza compartir la clave pública. Sin esa clave no se puede crear la campaña.';

export const RECIPIENT_ADDRESS_MISMATCH_LABEL =
  'La dirección no corresponde a la clave pública obtenida de la wallet';

const PUBKEY_FIELD = /pubkey|public[_-]?key/i;

export function normalizeCompressedSecp256k1PublicKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, '');
  if (!COMPRESSED_PUBKEY.test(normalized)) return null;
  if (normalized === SIMULATED_ECASH_PUBKEY) return null;
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNamedPublicKey(source: unknown): string | null {
  if (!isRecord(source)) return null;
  for (const [key, value] of Object.entries(source)) {
    if (!PUBKEY_FIELD.test(key)) continue;
    const parsed = normalizeCompressedSecp256k1PublicKey(value);
    if (parsed) return parsed;
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** SHA256 seguido de RIPEMD160, el hash160 de una clave comprimida. */
export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/**
 * Dirección P2PKH CashAddr (`ecash:q...`) derivada del hash160 de la clave comprimida.
 * Ejemplo de entrada: `034e...`.
 */
export function ecashAddressFromPublicKey(publicKeyHex: string): string {
  const normalized = normalizeCompressedSecp256k1PublicKey(publicKeyHex);
  if (!normalized) {
    throw new Error('invalid-compressed-pubkey');
  }
  return cashaddr.encode('ecash', 'p2pkh', hash160(hexToBytes(normalized)));
}

export function recipientAddressMatchesPublicKey(address: string, publicKeyHex: string): boolean {
  const typed = address.trim();
  if (!typed) return false;
  try {
    return canonicalEcashAccount(typed) === canonicalEcashAccount(ecashAddressFromPublicKey(publicKeyHex));
  } catch {
    return false;
  }
}

function canonicalEcashAccount(value: string): string {
  let next = value.trim().toLowerCase();
  while (next.startsWith('ecash:')) {
    next = next.slice('ecash:'.length);
  }
  return next;
}

export function extractSessionEcashPublicKey(session: unknown): string | null {
  if (!isRecord(session)) return null;

  const fromProperties = readNamedPublicKey(session.sessionProperties);
  if (fromProperties) return fromProperties;

  const namespaces = isRecord(session.namespaces) ? session.namespaces : null;
  const ecash = namespaces && isRecord(namespaces.ecash) ? namespaces.ecash : null;
  if (!ecash) return null;

  const fromNamespace = readNamedPublicKey(ecash);
  if (fromNamespace) return fromNamespace;

  const accounts = Array.isArray(ecash.accounts) ? ecash.accounts : [];
  for (const account of accounts) {
    if (typeof account === 'string') {
      const [namespace] = account.split(':');
      if (namespace !== 'ecash') continue;
      for (const part of account.split(':')) {
        const parsed = normalizeCompressedSecp256k1PublicKey(part);
        if (parsed) return parsed;
      }
      continue;
    }
    const fromAccount = readNamedPublicKey(account);
    if (fromAccount) return fromAccount;
  }

  return null;
}

export function extractWalletPublicKey(result: unknown): string | null {
  const direct = readNamedPublicKey(result);
  if (direct) return direct;
  if (!Array.isArray(result)) return null;
  for (const entry of result) {
    const parsed = normalizeCompressedSecp256k1PublicKey(entry) ?? readNamedPublicKey(entry);
    if (parsed) return parsed;
  }
  return null;
}

export function disclosedAddressMatchesAccounts(result: unknown, accounts: string[]): boolean {
  if (!isRecord(result)) return true;
  const address = result.address;
  if (typeof address !== 'string' || !address.trim()) return true;
  if (accounts.length === 0) return true;
  const expected = canonicalEcashAccount(address);
  if (!expected) return true;
  return accounts.some((account) => canonicalEcashAccount(account) === expected);
}

export function readDisclosedEcashPublicKey(result: unknown, accounts: string[]): {
  publicKey: string | null;
  addressMatches: boolean;
} {
  const publicKey = extractWalletPublicKey(result);
  if (!publicKey) return { publicKey: null, addressMatches: true };
  const addressMatches = disclosedAddressMatchesAccounts(result, accounts);
  return { publicKey, addressMatches };
}

export function shouldReconnectForTonalliPublicKey(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const lower = err.message.toLowerCase();
  if (lower.includes('rechaz') || lower.includes('rejected')) return false;
  return (
    lower.includes('reconecta')
    || lower.includes('sesión walletconnect inválida')
    || lower.includes('sesion walletconnect invalida')
    || lower.includes('no matching key')
    || lower.includes("session topic doesn't exist")
    || lower.includes('método no soportado')
    || lower.includes('method')
  );
}

export function buildTonalliPublicKeyRequest(): {
  method: 'ecash_signMessage';
  params: { message: string; purpose: string };
} {
  return {
    method: 'ecash_signMessage',
    params: {
      message: TONALLI_PUBKEY_DISCLOSURE_MESSAGE,
      purpose: 'teyolia-beneficiary-pubkey',
    },
  };
}

export async function resolveTonalliBeneficiaryPubKey(wallet: {
  publicKey: string | null;
  connect: () => Promise<unknown>;
  resetSession: () => Promise<void>;
  requestAccountPublicKey: () => Promise<string | null>;
}): Promise<string> {
  const cached = normalizeCompressedSecp256k1PublicKey(wallet.publicKey);
  if (cached) return cached;

  const attempt = async () => normalizeCompressedSecp256k1PublicKey(await wallet.requestAccountPublicKey());

  try {
    const first = await attempt();
    if (first) return first;
  } catch (err) {
    if (!shouldReconnectForTonalliPublicKey(err)) throw err;
  }

  await wallet.resetSession();
  const reconnected = await wallet.connect();
  if (!reconnected) {
    throw new Error(MISSING_TONALLI_PUBKEY_MESSAGE);
  }

  const second = await attempt();
  if (!second) {
    throw new Error(MISSING_TONALLI_PUBKEY_MESSAGE);
  }
  return second;
}
