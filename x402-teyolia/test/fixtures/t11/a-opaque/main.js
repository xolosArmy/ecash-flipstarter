// T-11a negativo: carga de código opaca (createRequire).
import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
export const fs = load('node:fs');
