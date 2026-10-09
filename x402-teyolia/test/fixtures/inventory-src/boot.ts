// Fixture sintético del inventario (no es código real).
import { broadcastTx } from './services/sender';
export function load(pairs: Array<[string, string]>): void {
  for (const [key, value] of pairs) process.env[key] = value;
}
export const b = broadcastTx;
