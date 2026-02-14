import { validateAddress } from '../utils/validation';

const DEFAULT_TREASURY_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
const DEFAULT_ACTIVATION_FEE_XEC = 800_000;
const SATS_PER_XEC = 100n;

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number): number {
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

export const ACTIVATION_FEE_XEC = parsePositiveIntegerEnv(
  process.env.TEYOLIA_ACTIVATION_FEE_XEC,
  DEFAULT_ACTIVATION_FEE_XEC,
);

export const ACTIVATION_FEE_SATS = BigInt(ACTIVATION_FEE_XEC) * SATS_PER_XEC;

export const TREASURY_ADDRESS = validateAddress(
  process.env.TEYOLIA_TREASURY_ADDRESS || DEFAULT_TREASURY_ADDRESS,
  'TEYOLIA_TREASURY_ADDRESS',
);
