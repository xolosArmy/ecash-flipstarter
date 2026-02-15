import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

export function makeTestDbPath(): string {
  return path.join(os.tmpdir(), `teyolia-test-${Date.now()}-${randomUUID()}.sqlite`);
}
