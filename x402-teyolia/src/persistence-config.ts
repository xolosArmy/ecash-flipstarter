// Configuración de persistencia x402 (PR-3; INF-045 §5.1 y §5.3 RQ-04; T-18).
// El store de facturas (TEYOLIA_X402_STORE_PATH) y la DB del grant (TEYOLIA_X402_GRANT_DB_PATH)
// son archivos propios y distintos. Falla cerrado (por configuración) si alguno apunta a la DB
// legacy (`campaigns.db`) o vive en un directorio que la contiene, si no es una ruta absoluta de
// archivo, si es volátil (`:memory:`, URI `file:`) o si los dos coinciden.
// P3-L3 (PR-6a; t117u): también si el archivo YA existe y tiene más de un enlace duro (nlink > 1):
// un hardlink a `campaigns.db` (u otra DB) en otro directorio no lo detectan ni el nombre ni
// realpath. Se comprueba aquí, antes de abrir o crear nada: openPersistence llama a
// readPersistenceConfig antes de crear el store o el grant, y en startServer eso corre después de
// la identidad de build (M5-V1 opción B, exit 78) y de validateAppConfig.

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const STORE_PATH_VAR = 'TEYOLIA_X402_STORE_PATH';
export const GRANT_DB_PATH_VAR = 'TEYOLIA_X402_GRANT_DB_PATH';
export const LEGACY_DB_BASENAME = 'campaigns.db';

export interface PersistenceConfig {
  readonly storePath: string;
  readonly grantDbPath: string;
}

export class PersistenceConfigError extends Error {
  readonly variable: string;
  readonly reason: string;
  constructor(variable: string, reason: string) {
    super(`${variable}: ${reason}`);
    this.variable = variable;
    this.reason = reason;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function resolveOne(env: Env, variable: string): string {
  const raw = env[variable];
  if (raw === undefined || raw === '') throw new PersistenceConfigError(variable, 'obligatoria con el kill switch ON');
  if (raw !== raw.trim() || raw.includes('\0')) throw new PersistenceConfigError(variable, 'ruta con espacios o NUL');
  if (raw === ':memory:' || /^file:/i.test(raw)) throw new PersistenceConfigError(variable, 'ruta volátil o URI prohibida');
  if (!path.isAbsolute(raw)) throw new PersistenceConfigError(variable, 'debe ser una ruta absoluta');
  const base = path.basename(raw);
  if (base.toLowerCase() === LEGACY_DB_BASENAME) throw new PersistenceConfigError(variable, 'apunta a la DB legacy campaigns.db (T-18)');
  const dir = path.dirname(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new PersistenceConfigError(variable, 'el directorio no existe');
  const realDir = realpathSync(dir);
  if (existsSync(path.join(realDir, LEGACY_DB_BASENAME))) {
    throw new PersistenceConfigError(variable, 'el directorio contiene la DB legacy campaigns.db (T-18)');
  }
  const full = path.join(realDir, base);
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (path.basename(real).toLowerCase() === LEGACY_DB_BASENAME) throw new PersistenceConfigError(variable, 'enlace hacia la DB legacy campaigns.db (T-18)');
    const st = statSync(real);
    if (!st.isFile()) throw new PersistenceConfigError(variable, 'no es un archivo regular');
    if (st.nlink > 1) throw new PersistenceConfigError(variable, 'archivo existente con más de un enlace duro (nlink > 1; P3-L3)');
    return real;
  }
  return full;
}

export function readPersistenceConfig(env: Env): PersistenceConfig {
  const storePath = resolveOne(env, STORE_PATH_VAR);
  const grantDbPath = resolveOne(env, GRANT_DB_PATH_VAR);
  const side = (p: string): string[] => [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];
  if (side(storePath).some((p) => side(grantDbPath).includes(p))) {
    throw new PersistenceConfigError(GRANT_DB_PATH_VAR, 'debe ser un archivo distinto del store de facturas (RQ-04)');
  }
  return Object.freeze({ storePath, grantDbPath });
}
