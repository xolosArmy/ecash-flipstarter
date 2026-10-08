# x402-teyolia — proceso x402 aislado (TA-2, PR-1)

Esqueleto del proceso x402 de Teyolia según INF-045 (ratificado 2026-10-08 16:12 CDMX) y el
plan de implementación TA-2 v1.0, con las correcciones de la revisión P-4 del Auditor.

**Límites de este paquete (no negociables en TA-2):**

* Sin llaves, sin firma, sin broadcast, sin fondos, sin RPC, sin UTXO, sin red real.
* Kill switch `TEYOLIA_X402_ENABLED` **apagado por defecto**; solo el literal `true` lo
  enciende, y solo con `NODE_ENV=test`. En PR-1 todas las rutas `/x402/**` responden
  **503** (OFF: `TEYOLIA_X402_DISABLED`; ON: `TEYOLIA_X402_NOT_IMPLEMENTED`).
* Límites en **cero** (importe por operación, agregado y presupuesto agéntico), constantes
  congeladas en `src/policy.ts` que ninguna variable de entorno cambia.
* No importa nada de `backend/`, `frontend/` ni `contracts/`; no está en los `workspaces`
  del raíz; tiene su propio `package-lock.json`.
* No sirve nada bajo `/proposed/v0.1/` ni toca el esquema `0.1-proposed` ni el paquete INF-023.
* No toca `ENABLE_PUBLIC_REFUNDS` ni el backend legacy.

## Estructura

| Ruta | Qué es |
| :---- | :---- |
| `src/main.ts` | Entrada en dos fases: guard (solo `node:*`) y, si pasa, `await import('./server.js')` |
| `src/env-guard.ts` | Reglas A (lista negativa), B (deny-by-default), C (valores con forma de secreto), `.env` en el cwd y flags de `execArgv` |
| `src/allowlist.ts` | Allowlist normativa (16 nombres, INF-045 §5.1), conjunto de sistema enumerado, lista negativa |
| `src/policy.ts` | Kill switch y límites en cero |
| `src/server.ts` | Express 5 sin body parser: `/teyolia-x402/health` y `/x402/v1/access/demo` (503) |
| `scripts/inventory.mjs` | Inventario de `backend/src` del commit exacto (`inventory/239f9dc.inventory.txt` + `.sha256`) |
| `scripts/check-graph.mjs` | T-11a/b/c sobre `dist/main.js` |
| `scripts/t11-blocklist.json` | Lista negativa de T-11b (fuera de `src/` y `dist/`) |
| `test/*.test.mjs` | `node:test`: T-10a–i, T-11a–c (con negativos), kill switch, rutas, inventario |

## Cómo correrlo

Requiere Node ≥ 22.13 (`engine-strict`).

```sh
cd x402-teyolia
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run check:graph
npm run inventory:check
```

Rutas del proceso (solo `127.0.0.1`, puerto `TEYOLIA_X402_LISTEN`, distinto de 3011):

* `GET /teyolia-x402/health` → `{status, component, x402Enabled, limitsZero}`. No usa
  `/api/health` para no chocar con el health del backend legacy detrás de Nginx.
* `/x402/v1/access/demo` y todo `/x402/**` → 503.
* Cualquier otra ruta → 404.

## Limitaciones conocidas

* **T-10i (Auditor P4-L3):** el guard **detecta** `NODE_OPTIONS`, `--import`, `--require` y
  `--experimental-loader` y rechaza el arranque, pero el código precargado **ya se ejecutó**
  antes de `main.ts` (las pruebas lo demuestran con un marcador). La barrera real es el
  lanzador (unidad con `Environment=` propio, sin `PassEnvironment`, `ExecStart` fijo), en PR-6.
* **Variables de systemd (P4-L6):** el conjunto de sistema no incluye `INVOCATION_ID`,
  `JOURNAL_STREAM`, etc.; bajo systemd el proceso no arrancaría (falla cerrado). Se resuelve en PR-6
  con decisión registrada.
* **T-10 y T-11 no cuentan como verdes** hasta que Xolo Auditor audite el inventario del commit
  exacto (INF-045 §6.2, condición TA2-M1). Un CI verde demuestra que las pruebas pasan, no que
  T-10/T-11 estén cumplidos.
* `debug` (dependencia de Express) intenta un `require('supports-color')` opcional que no está
  instalado: `check-graph` lo reporta como aviso. Si un `node_modules` superior lo tuviera, se
  cargaría y `check-graph` fallaría.
