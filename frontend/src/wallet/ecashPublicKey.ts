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

export const DERIVED_COLLECTION_ADDRESS_NOTICE =
  'La dirección de recaudación ha sido ajustada automáticamente para coincidir con la clave pública firmada por tu Tonalli Wallet';

export const DERIVATION_MISMATCH_MESSAGE =
  'La clave pública de Tonalli no corresponde a la misma derivación de la cuenta conectada. Reconecta Tonalli.';

/**
 * Registro de RMZWallet (`src/services/derivationProfiles.ts`).
 * El coin type BIP44 145 no forma parte de ese registro. Los dos perfiles 899
 * comparten `m/44'/899'/0'` pero usan motores distintos, y Cashtab usa
 * `m/44'/1899'/0'`. Sin la semilla este cliente no deriva el otro perfil:
 * solo acepta la clave cuyo hash160 es el pubkeyhash de la cuenta activa.
 */
export const TONALLI_LEGACY_PROFILE_ID = 'tonalli-legacy-899' as const;
export const ECASH_STANDARD_899_PROFILE_ID = 'ecash-standard-899' as const;
export const ECASH_STANDARD_PROFILE_ID = 'ecash-standard-1899' as const;
export const TONALLI_LEGACY_DERIVATION_ENGINE = 'minimal-xec-wallet-2.0.2-compat' as const;
export const ECASH_LIB_DERIVATION_ENGINE = 'ecash-lib-bip32' as const;

export type RmzDerivationProfileId =
  | typeof TONALLI_LEGACY_PROFILE_ID
  | typeof ECASH_STANDARD_899_PROFILE_ID
  | typeof ECASH_STANDARD_PROFILE_ID;

export type RmzDerivationProfile = Readonly<{
  id: RmzDerivationProfileId;
  coinType: 899 | 1899;
  engine: typeof TONALLI_LEGACY_DERIVATION_ENGINE | typeof ECASH_LIB_DERIVATION_ENGINE;
  basePath: string;
}>;

export const RMZ_DERIVATION_PROFILES: Readonly<Record<RmzDerivationProfileId, RmzDerivationProfile>> = Object.freeze({
  [TONALLI_LEGACY_PROFILE_ID]: Object.freeze({
    id: TONALLI_LEGACY_PROFILE_ID,
    coinType: 899,
    engine: TONALLI_LEGACY_DERIVATION_ENGINE,
    basePath: "m/44'/899'/0'",
  }),
  [ECASH_STANDARD_899_PROFILE_ID]: Object.freeze({
    id: ECASH_STANDARD_899_PROFILE_ID,
    coinType: 899,
    engine: ECASH_LIB_DERIVATION_ENGINE,
    basePath: "m/44'/899'/0'",
  }),
  [ECASH_STANDARD_PROFILE_ID]: Object.freeze({
    id: ECASH_STANDARD_PROFILE_ID,
    coinType: 1899,
    engine: ECASH_LIB_DERIVATION_ENGINE,
    basePath: "m/44'/1899'/0'",
  }),
});

const PUBKEY_FIELD = /pubkey|public[_-]?key/i;
const ADDRESS_FIELD = /^(address|xecaddress|ecashaddress)$/i;
const PROFILE_FIELD = /^(derivationprofile|profileid|profile)$/i;
const PATH_FIELD = /^(hdpath|derivationpath|path)$/i;

export function isRmzDerivationProfileId(value: string): value is RmzDerivationProfileId {
  return Object.prototype.hasOwnProperty.call(RMZ_DERIVATION_PROFILES, value);
}

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

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hash160HexOfPublicKey(publicKeyHex: string): string | null {
  const normalized = normalizeCompressedSecp256k1PublicKey(publicKeyHex);
  if (!normalized) return null;
  return bytesToHex(hash160(hexToBytes(normalized)));
}

/** Pubkeyhash P2PKH de una dirección ecash, con o sin el prefijo `ecash:`. */
export function pubkeyHashOfAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const decoded = cashaddr.decode(trimmed, true);
    if (decoded.prefix !== 'ecash' || String(decoded.type).toLowerCase() !== 'p2pkh') return null;
    const hash = typeof decoded.hash === 'string' ? decoded.hash.toLowerCase() : bytesToHex(decoded.hash);
    return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Acepta CashAddr o una cuenta CAIP-10 `ecash:<chain>:<address>`. */
export function pubkeyHashOfAccount(account: string): string | null {
  const direct = pubkeyHashOfAddress(account);
  if (direct) return direct;
  const parts = account.trim().split(':');
  if (parts.length >= 3 && parts[0].toLowerCase() === 'ecash') {
    return pubkeyHashOfAddress(parts.slice(2).join(':'));
  }
  return null;
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
  const typed = pubkeyHashOfAddress(address);
  const derived = hash160HexOfPublicKey(publicKeyHex);
  return Boolean(typed && derived && typed === derived);
}

function canonicalEcashAccount(value: string): string {
  let next = value.trim().toLowerCase();
  while (next.startsWith('ecash:')) {
    next = next.slice('ecash:'.length);
  }
  return next;
}

type IdentityCandidate = {
  publicKey: string;
  address: string | null;
  profileId: string | null;
  hdPath: string | null;
};

function bareCandidate(publicKey: string): IdentityCandidate {
  return { publicKey, address: null, profileId: null, hdPath: null };
}

function readStringField(source: Record<string, unknown>, pattern: RegExp): string | null {
  for (const [key, value] of Object.entries(source)) {
    if (!pattern.test(key) || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function pushIdentity(source: unknown, into: IdentityCandidate[]): void {
  if (!isRecord(source)) {
    const parsed = normalizeCompressedSecp256k1PublicKey(source);
    if (parsed) into.push(bareCandidate(parsed));
    return;
  }
  const publicKey = readNamedPublicKey(source);
  if (!publicKey) return;
  into.push({
    publicKey,
    address: readStringField(source, ADDRESS_FIELD),
    profileId: readStringField(source, PROFILE_FIELD),
    hdPath: readStringField(source, PATH_FIELD),
  });
}

function collectFromSession(session: Record<string, unknown>, into: IdentityCandidate[]): void {
  pushIdentity(session.sessionProperties, into);
  const namespaces = isRecord(session.namespaces) ? session.namespaces : null;
  const ecash = namespaces && isRecord(namespaces.ecash) ? namespaces.ecash : null;
  if (!ecash) return;
  pushIdentity(ecash, into);
  const accounts = Array.isArray(ecash.accounts) ? ecash.accounts : [];
  for (const account of accounts) {
    if (typeof account === 'string') {
      const [namespace] = account.split(':');
      if (namespace.toLowerCase() !== 'ecash') continue;
      for (const part of account.split(':')) {
        const parsed = normalizeCompressedSecp256k1PublicKey(part);
        if (parsed) into.push(bareCandidate(parsed));
      }
      continue;
    }
    pushIdentity(account, into);
  }
}

function collectFromSource(source: unknown, into: IdentityCandidate[]): void {
  if (Array.isArray(source)) {
    for (const entry of source) collectFromSource(entry, into);
    return;
  }
  if (!isRecord(source)) {
    pushIdentity(source, into);
    return;
  }
  if ('namespaces' in source || 'sessionProperties' in source || 'peer' in source) {
    collectFromSession(source, into);
    return;
  }
  pushIdentity(source, into);
}

function readSessionAccountStrings(session: Record<string, unknown>): string[] {
  const namespaces = isRecord(session.namespaces) ? session.namespaces : null;
  const ecash = namespaces && isRecord(namespaces.ecash) ? namespaces.ecash : null;
  const accounts = ecash && Array.isArray(ecash.accounts) ? ecash.accounts : [];
  const addresses: string[] = [];
  for (const account of accounts) {
    if (typeof account === 'string') {
      addresses.push(account);
      continue;
    }
    if (!isRecord(account)) continue;
    const address = readStringField(account, ADDRESS_FIELD);
    if (address) addresses.push(address);
  }
  return addresses;
}

function activeAccountHashes(accounts: readonly string[]): string[] {
  const hashes: string[] = [];
  for (const account of accounts) {
    const hash = pubkeyHashOfAccount(account);
    if (hash && !hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}

/**
 * Elige la clave comprimida del mismo perfil que la cuenta activa.
 * Si la dirección decodifica, descarta claves de otro hash160. Si ninguna
 * dirección decodifica, conserva la clave solo cuando todas las candidatas coinciden.
 */
export function reconcileActiveEcashPublicKey(
  accounts: readonly string[],
  ...sources: unknown[]
): string | null {
  const candidates: IdentityCandidate[] = [];
  for (const source of sources) collectFromSource(source, candidates);
  if (candidates.length === 0) return null;

  const hashes = activeAccountHashes(accounts);
  if (hashes.length === 0) {
    const unique = new Set(candidates.map((candidate) => candidate.publicKey));
    return unique.size === 1 ? candidates[0].publicKey : null;
  }

  let best: IdentityCandidate | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const keyHash = hash160HexOfPublicKey(candidate.publicKey);
    if (!keyHash || !hashes.includes(keyHash)) continue;
    let score = 1;
    if (candidate.address) {
      const addressHash = pubkeyHashOfAccount(candidate.address);
      if (addressHash && hashes.includes(addressHash)) score += 2;
    }
    if (candidate.profileId && isRmzDerivationProfileId(candidate.profileId)) score += 1;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best?.publicKey ?? null;
}

export function publicKeyMatchesAccounts(publicKey: string, accounts: readonly string[]): boolean {
  const normalized = normalizeCompressedSecp256k1PublicKey(publicKey);
  if (!normalized) return false;
  const hashes = activeAccountHashes(accounts);
  if (hashes.length === 0) return true;
  const keyHash = hash160HexOfPublicKey(normalized);
  return keyHash !== null && hashes.includes(keyHash);
}

export function extractSessionEcashPublicKey(session: unknown): string | null {
  if (!isRecord(session)) return null;
  return reconcileActiveEcashPublicKey(readSessionAccountStrings(session), session);
}

export function selectAccountPublicKey(
  accounts: readonly string[],
  session: unknown,
  injected?: unknown,
): string | null {
  const fromSession = extractSessionEcashPublicKey(session);
  if (fromSession) return fromSession;
  const injectedAddress = isRecord(injected) ? readStringField(injected, ADDRESS_FIELD) : null;
  const bound = accounts.length > 0 ? accounts : injectedAddress ? [injectedAddress] : [];
  if (injected == null) return null;
  return reconcileActiveEcashPublicKey(bound, injected);
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
  const raw = extractWalletPublicKey(result);
  const reconciled = reconcileActiveEcashPublicKey(accounts, result);
  const addressMatches = disclosedAddressMatchesAccounts(result, accounts)
    && (reconciled !== null || (raw !== null && publicKeyMatchesAccounts(raw, accounts)));
  if (reconciled && addressMatches) return { publicKey: reconciled, addressMatches: true };
  if (!raw) return { publicKey: null, addressMatches: true };
  if (!addressMatches) return { publicKey: raw, addressMatches: false };
  return { publicKey: raw, addressMatches: true };
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
