// Fixture sintético del inventario (no es código real).
import { rpc } from '../config/net';
export async function broadcastTx(hex: string): Promise<string> {
  return `${String(rpc.url)}:${hex}`;
}
