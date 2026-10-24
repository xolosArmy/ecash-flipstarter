# x402-teyolia — proceso x402 aislado (TA-2, PR-1)

Esqueleto del proceso x402 de Teyolia según INF-045 (ratificado 2026-10-08 16:12 CDMX) y el
plan de implementación TA-2 v1.0, con las correcciones de la revisión P-4 del Auditor.

**Nomenclatura de hallazgos.** `P-4/Lx` son los hallazgos de la revisión P-4 del Auditor sobre el
diseño de PR-1; `P4-Lx` (sin guion tras la P) son los del dictamen del Auditor sobre PR-4. Por ejemplo,
`P-4/L3` es la limitación de código precargado (T-10i) y `P4-L3` es «configuración antes de
persistencia» (PR-5).

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
| `src/build-identity.ts` | M5-V1: lee y valida `dist/build-info.json` (identidad **declarada**; no recalcula el manifiesto) |
| `src/server.ts` | Express 5 sin body parser: `/teyolia-x402/health` y `/x402/v1/access/demo` (503) |
| `scripts/inventory.mjs` | Inventario de `backend/src` del commit exacto (`inventory/239f9dc.inventory.txt` + `.sha256`) |
| `scripts/check-graph.mjs` | T-11a/b/c sobre `dist/main.js` |
| `scripts/t11-blocklist.json` | Lista negativa de T-11b (fuera de `src/` y `dist/`) |
| `scripts/dist-manifest.mjs` | M5-V1 / OB-07: manifiesto SHA-256 de `dist/` y `dist/build-info.json`; `--check` y `--rebuild-compare` |
| `test/*.test.mjs` | `node:test`: T-10a–i, T-11a–c (con negativos), kill switch, rutas, inventario |

## Cómo correrlo

Requiere Node ≥ 22.13 (`engine-strict`).

```sh
cd x402-teyolia
npm ci --ignore-scripts
npm run typecheck
npm run build        # tsc + dist/build-info.json (manifiesto de dist/)
npm test
npm run check:graph
npm run check:dist   # M5-V1: recalcula dist/ y lo compara con un rebuild limpio
npm run inventory:check
```

Rutas del proceso (solo `127.0.0.1`, puerto `TEYOLIA_X402_LISTEN`, distinto de 3011):

* `GET /teyolia-x402/health` → `{status, component, x402Enabled, limitsZero, commit, distManifestSha256}`
  (M5-V1, opción A; valores declarados en `dist/build-info.json`; sin build-info válido el proceso no
  arranca, ver abajo). No usa
  `/api/health` para no chocar con el health del backend legacy detrás de Nginx.
* `/x402/v1/access/demo` y todo `/x402/**` → 503.
* Cualquier otra ruta → 404.

## Identidad de artefacto (M5-V1, OB-07; opción A, Fernando 2026-10-23 14:16 CDMX)

* **Conjunto cubierto:** todo archivo regular de `dist/` salvo los archivos de identidad,
  `dist/build-info.json` y `dist/dist-manifest.sha256`, que quedan fuera para evitar circularidad.
  Un enlace simbólico o un tipo no regular en `dist/` es error.
* **Manifiesto** (`dist/dist-manifest.sha256`): `‹sha256›  ‹ruta relativa›` por archivo cubierto,
  en orden de bytes de la ruta (formato de `sha256sum`; `cd dist && sha256sum -c dist-manifest.sha256`).
  `distManifestSha256` = SHA-256 de ese archivo.
* **`npm run build`** (`scripts/dist-manifest.mjs --build`): **borra `dist/`**, determina el commit,
  compila, escribe el manifiesto y `dist/build-info.json` = `{schema: 1, commit, distManifestSha256,
  files}` y verifica con un rebuild limpio en un directorio temporal que el manifiesto coincide (y que
  HEAD no cambió). Si algo falla, sale con 1 y no deja archivos de identidad.
* **`commit` = `git rev-parse HEAD`** en el build, sin variables de entorno (las `GIT_*` del entorno se
  ignoran) y nunca `null`. El build **falla cerrado** si: no hay `git`; no hay repositorio; el
  repositorio no es el de este paquete (tarball extraído dentro de otro repo); HEAD no da 40 hex (repo
  sin commits o con objetos SHA-256); `dist/` está versionado; o el **árbol de trabajo está sucio**
  (`git status --porcelain` no vacío en todo el repositorio: cambios sin commit, preparados o no, o
  archivos sin versionar y no ignorados).
* **Reproducción:** hay que construir desde un **clon o un bundle** del SHA exacto
  (`git clone x.bundle w && git -C w checkout --detach ‹sha›`). Un tarball de `git archive` (sin
  `.git`) **no se puede construir**: falla cerrado con «no hay repositorio git».
* **`dist/` no se versiona** (`.gitignore` de la raíz): el commit de la build nunca es un HEAD que
  contenga su propia build-info.
* **`npm run check:dist`**: `--check` (build-info y manifiesto coherentes con el `dist/` en disco) y
  `--rebuild-compare` (M5-V1: rebuild limpio igual a `distManifestSha256` y `commit` igual a HEAD).
* **Health — valor declarado, no medido.** El proceso lee `dist/build-info.json` una vez al arrancar
  y valida su forma; **no recalcula el manifiesto**. Un `dist/*.js` alterado con el `build-info.json`
  intacto seguiría reportando el hash original. Es un residual documentado (PT5-04 (iv)); Fernando
  (2026-10-23 17:39) no adopta por ahora el recálculo al arrancar. La verificación vinculante es el
  rebuild determinista y la comparación en CI (M5-V1) y, en mx2, la evidencia M5 externa que hashea
  los archivos de `dist/` sin fiarse del health, antes de TA-3 o de la reconexión.
* **Sin identidad válida, el proceso no arranca** (opción B, Fernando 2026-10-23 17:39; Auditor
  P5-01). `startServer` evalúa la identidad **antes** de abrir la persistencia: si `build-info.json`
  falta, no es JSON o no es estructuralmente verificable (claves exactas, `schema` 1, `commit` de 40
  hex, `distManifestSha256` de 64 hex, `files` ≥ 1), sale con **78** sin abrir, crear ni modificar
  `store.sqlite`, `grant.sqlite` ni sus `-wal`/`-shm`, y lo anota en stderr. `createApp` conserva,
  para los tests unitarios y como defensa en profundidad, el health **503** `{status:
  "build_unverified", component, x402Enabled, limitsZero, error: "TEYOLIA_X402_BUILD_UNVERIFIED"}`,
  sin `commit` ni `distManifestSha256`. Las rutas x402 y el kill switch no cambian (el proceso sigue
  en 503).

## Limitaciones conocidas

* **T-10i (Auditor P-4/L3):** el guard **detecta** `NODE_OPTIONS`, `--import`, `--require` y
  `--experimental-loader` y rechaza el arranque, pero el código precargado **ya se ejecutó**
  antes de `main.ts` (las pruebas lo demuestran con un marcador). La barrera real es el
  lanzador (unidad con `Environment=` propio, sin `PassEnvironment`, `ExecStart` fijo):
  **precondición del gate de TA-3** (D-P6-2 (A), G3-01/G3-02 de `docs/pr6-aislamiento.md` §4).
* **Variables de systemd (P-4/L6):** el conjunto de sistema no incluye `INVOCATION_ID`,
  `JOURNAL_STREAM`, etc.; bajo systemd el proceso no arrancaría (falla cerrado). **Precondición del
  gate de TA-3** (D-P6-2 (A), G3-03): ampliar la allowlist exige decisión registrada y re-auditoría.
* **Rate limit de emisión en memoria (PR4-E, bajo G-12):** los contadores por IP y global de M3
  viven en la memoria del proceso: se reinician con él y no se comparten entre instancias. Vale
  porque G-12 fija una sola instancia; el tope de facturas ISSUED vigentes sí se cuenta en la base.
* **`node:vm` fuera del flag D-1 (P4-L2):** `--disallow-code-generation-from-strings` no bloquea
  `node:vm`. En los archivos propios lo impide T-11a (builtins enumerados); en terceros es residual
  LOW documentado (nota en `src/env-guard.ts`).
* **T-10 y T-11 no cuentan como verdes** hasta que Xolo Auditor audite el inventario del commit
  exacto (INF-045 §6.2, condición TA2-M1). Un CI verde demuestra que las pruebas pasan, no que
  T-10/T-11 estén cumplidos.
* **`PAYMENT-SIGNATURE` (H2A v2) se ignora (PT-01b):** el servidor solo entiende `payment-proof`
  C3B v1. La cabecera H2A v2 nunca se acepta como pago (sola da 402 con la oferta C3B), pero tampoco
  se rechaza con un 4xx. Ni sola ni transportando una prueba C3B válida produce grant, PAID ni
  consulta a Chronik. **M4-S (PR-5b, RQ-13):** el cliente C3B sintético de
  `test/fixtures/x402/c3b-client.mjs` (solo tests; sin llaves, firma, red ni fondos) recorre la
  cadena oferta → recibo → prueba → 200 y **rechaza** las ofertas `PAYMENT-SIGNATURE` y H2A v2
  (`xec-prepaid-utxo`, x402Version 2) sin pagar (`test/pr5b.m4s.c3b-client.test.mjs`). Con esto
  PT-01 queda cubierto; la tabla PT v1.1 (`docs/`) no se reescribe.
* **Reorg después de la concesión (PT-05b, residual TA-3):** no hay revocación. Si la tx desaparece o
  pierde la finalidad, la reentrega vuelve a consultar Chronik y da 402, pero el grant y la factura
  PAID persisten. Sin riesgo de fondos en TA-2 (límites en cero); la finalidad ante reorg pasa a las
  precondiciones del gate de TA-3 (PT5-11): A-02 concede con un bloque sin finalidad Avalanche y,
  tras un reorg, el grant y PAID persisten sin revocación; allí se decide si con recursos reales se
  exige `isFinal: true` antes de conceder.
* **T-06 cubierto por PR-6:** T-06a/b/c (`test/pr6.t06.isolation.test.mjs`) más T-12 (egreso),
  T-12e (IPC) y T-13 (archivos del legacy) con dos uids reales y egreso controlado en el arnés
  `test/isolation/` (EN-2). Matriz, residuales y precondiciones del gate de TA-3:
  `docs/pr6-aislamiento.md`. El socket UNIX abstracto no tiene barrera en TA-2 (G3-06).
* Correspondencia PT-01..PT-07 ↔ INF-042 §11 ↔ tests: `docs/pr5-pt-correspondencia.md` (tabla PT v1.1).
* `debug` (dependencia de Express) intenta un `require('supports-color')` opcional que no está
  instalado: `check-graph` lo reporta como aviso. Si un `node_modules` superior lo tuviera, se
  cargaría y `check-graph` fallaría.

## Corridas locales: host sin `/node_modules` (P2a-L3)

T-11d verifica la precondición P2-L8: ningún `node_modules` fuera del paquete (en `/`, en los
ancestros del checkout, en `$HOME/.node_modules` ni en `$HOME/.node_libraries`) puede resolver
dependencias del proceso. En un host con `/node_modules` (o con esos directorios) T-11d **falla a
propósito**. Para correr las pruebas en local, usa un host limpio o un sandbox `bwrap` que monte
solo `/usr`, `/etc`, la cadena de herramientas de Node verificada por SHA-256 y el checkout, con
`/tmp` y `HOME` vacíos (`--tmpfs /tmp --clearenv --setenv HOME /tmp/home`). El CI (`x402-ta2`)
corre en un runner sin `/node_modules`.

## Aislamiento del SO (PR-6): `test/isolation/`

Arnés privilegiado para T-12 / T-12e / T-13 y la parte de runtime de T-06 (D-P6-1 (a)). Construye
primero como usuario normal y luego ejecuta el arnés como root (npm nunca corre como root):

```sh
npm ci --ignore-scripts && npm run build
sudo env NODE_BIN="$(command -v node)" NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh
```

Requiere `nftables` (CI: `1.0.9-1ubuntu0.1` fijado en `ubuntu-24.04`), `unshare`/`setpriv`
(util-linux) e `ip` (iproute2). Todo corre en namespaces desechables (mount, net, pid) sobre un
tmpfs, con uids numéricos 2001 (legacy) y 2002 (x402) sin tocar `/etc/passwd`; el ruleset nft vive
solo en el netns y el arnés verifica que el del host no cambia. Sin root falla cerrado.
