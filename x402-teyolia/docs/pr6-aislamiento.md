# PR-6 — Aislamiento de TA-2: matriz T-12 / T-12e / T-13 / T-06 (revisada) y precondiciones del gate de TA-3

*Xolo Arquitecto (TA-2) · 24 de octubre de 2026 · horas en CDMX (UTC-6)*

> Viaja con el diff de PR-6. Aplica la decisión de Fernando del 24-oct 09:21 CDMX (D-P6-1 (a),
> D-P6-2 (A), PM6-01..PM6-06 del dictamen del Auditor sobre la matriz) y la división PR-6 / PR-6a.
> **PR-6 no cambia `src/`**: `distManifestSha256` sigue siendo
> `962eea56e9af9ead5484eca0251bef7663b606d9d771387da83d9e2855ba6006`. El proceso x402 sigue en 503 y
> con límites en cero; sin Chronik real, red real, llaves, firma, fondos ni broadcast. El cambio de
> workflow **no está autorizado para push** (espera SHA exacto y PASS del Auditor).

## 1 Cómo se demuestra (EN-2: dos usuarios de SO reales y control de egreso; un mock en proceso no cuenta)

* **Arnés privilegiado** `test/isolation/harness.sh` (root; falla cerrado si no lo es, si falta `nft`,
  `unshare`, `setpriv` o `ip`, o si la política no carga). Registra `nft --version`, `uname -r`,
  `ImageVersion`, uid/gid, versión y sha256 de node, `os-release` y util-linux. Toma el sha256 de
  `nft list ruleset` del host y de `/etc/passwd`+`/etc/group` antes y después y falla si cambian.
* Todo ocurre en `unshare --mount --net --pid --fork --mount-proc --propagation private` sobre un
  tmpfs propio (`inner.sh`): copia del paquete ya construido (npm **nunca** corre como root), uids
  numéricos **2001** (legacy) y **2002** (x402) sin entradas en `/etc/passwd`, `setpriv --reuid
  --regid --clear-groups`. Red del netns: solo `lo` y una ruta por defecto hacia `lo` (un destino no
  local como `192.0.2.1` cruza el hook output y se descarta; nunca sale del netns).
* **Política de egreso** `test/isolation/egress.nft` (tabla propia `inet x402iso`, cadena `out`):
  `meta skuid 2002 ct state new counter` («x402-new»: cuenta TODA conexión nueva del uid x402,
  aceptada o rechazada), `accept` solo hacia el host:puerto de `TEYOLIA_X402_CHRONIK_URL`
  («x402-chronik»; Chronik de fixture en 127.0.0.1:47100, DM-1) y `reject` del resto («x402-deny»).
* **Layout legacy sintético** (contenido falso): release `/srv/teyolia-api/release` (2001, 0750) con
  `.env` 0600 (incluye un `TEYOLIA_REFUND_ORACLE_PRIVKEY` ficticio), unit
  `/etc/systemd/system/teyolia-api.service` (root:2001, 0640), estado
  `/var/lib/teyolia/state-metadata-0defa0b` (0700) con `campaigns.db` (sqlite, 0600), socket
  `/run/teyolia-api/legacy.sock` (dir 0750, socket 0660) y socket abstracto `@teyolia-legacy-ipc`.
  Oyentes legacy (uid 2001): `127.0.0.1:3011`, `[::1]:3011`, `127.0.0.1:47199`, el socket con ruta y
  el abstracto; cada `accept` se cuenta.
* **CI** (D-P6-1 (a)): un único paso final dentro del job requerido «x402-teyolia (Node 22.13.1)»,
  sin workflow ni check nuevos, sin `continue-on-error`, `runs-on: ubuntu-24.04`,
  `permissions: contents: read`, `persist-credentials: false`, sin secretos.
* **Dependencia (PM6-05; P6C-02, Fernando 2026-10-24 11:28), reproducible por el Auditor:** `nftables`
  fijado por **SHA-256** a `1.0.9-1ubuntu0.1` (noble-updates, amd64) con `test/isolation/nft-pin.sh install`
  y el lock `test/isolation/nft-pin.lock` (formato `<sha256> <paquete> <versión> <arch>
  <requerido|dependencia>`). Requeridos: `nftables` `d648859fccde3c17b8b9b89993427564f91f394a39306db1f67bd5ea3ac42c6e`
  y `libnftables1` `fcaee001747a6adaa0cd9337fef437b3aa7a7a6d5246b62fbd4784d3d6a5009e`. Dependencias
  fijadas por si la imagen no las trae (solo se descargan si `apt-get install -s` las planifica):
  `libnftnl11 1.2.6-2build1`, `libjansson4 2.14-2build2`, `libmnl0 1.0.5-2build1`,
  `libedit2 3.1-20230828-1build1`, `libxtables12 1.8.10-3ubuntu2`, `libgmp10 2:6.3.0+dfsg-2ubuntu6.1`
  (hashes en el lock; todos verificados contra `dists/noble{,-updates}/main/binary-amd64/Packages.gz`).
  Secuencia (usuario del runner; `sudo` solo en `apt-get update` y `dpkg -i`): `apt-get install -s
  --no-install-recommends nftables=<v> libnftables1=<v>` → cada `Inst` del plan debe estar en el lock
  con esa versión exacta (si apt ofrece otra versión o un paquete no fijado: **falla**) → `apt-get
  download` sin privilegios → `verify`: cada `.deb` con `Package/Version/Architecture` (leídos con
  `dpkg-deb -f`) esperado y sha256 igual al del lock, sin `.deb` faltantes ni sobrantes → `sudo dpkg -i`
  de exactamente esos ficheros → `dpkg-query` = versión fijada → registra `nft --version` y el sha256 del
  lock. **Sin fallback** (ni `|| true`, ni apt sin versión, ni `--allow-downgrades`); la guarda P6C-01
  lo impone sobre el script. Pruebas offline: `test/pr6.nft-pin.test.mjs` (.deb sintéticos: hash
  erróneo, byte alterado, faltante, sobrante, plan con paquete no fijado o versión distinta, lock mal
  formado). En local (Debian 13): `nftables 1.1.3-1` (`.deb` sha256
  `2ddfa61baaf3a76e2c499db9e521ba6affb226f85af0b6fef739f346ac5f0c39`); la variante 1.0.9 se reproduce
  con los `.deb` oficiales extraídos (sin instalarlos en el host). Reproducción:
  `npm ci --ignore-scripts && npm run build` (usuario normal) y
  `sudo env NODE_BIN="$(command -v node)" NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh`.
  **Alternativa declarada (no activa):** `iptables -m owner --uid-owner 2002 -m conntrack --ctstate
  NEW` con las mismas tres reglas (contador, ACCEPT al host:puerto de la Chronik, REJECT) en la
  cadena OUTPUT del netns desechable; solo se adoptaría con nueva revisión del Auditor.
* **Pruebas sin privilegios** (en `npm test`, corren en los cuatro escenarios bwrap):
  `test/pr6.t06.isolation.test.mjs`, `test/pr6.t12e.legacy-ipc.test.mjs`,
  `test/pr6.harness-contract.test.mjs` (con la guarda `test/isolation/workflow-guard.mjs`, P6C-01) y
  `test/pr6.nft-pin.test.mjs` (P6C-02).
* **Guarda del contrato (P6C-01):** `workflowViolations()` exige un único job con el nombre del check
  requerido, `on:` exactamente `push:`/`pull_request:` sin filtros, ningún `if:` (job o paso),
  `continue-on-error`, `shell:`, `needs:`/`strategy:`/`matrix`/`container`, ni secretos; en los `run:`
  prohíbe `|| true`/`|| :`/`|| exit 0`/`|| echo`, `||` seguido de espacio, `set +e`/`set +o`, `exit 0`,
  `true`/`:` sueltos, `su`/`doas`/`pkexec`/`runuser`/`nsenter`/`chroot`, todo `sudo` salvo la línea
  exacta del arnés y cualquier `npm`/`npx`/`yarn`/`pnpm`/`corepack` en una línea con `sudo`/`su`; el paso de
  aislamiento debe ser **textualmente** el fijado y el último. `rootScriptViolations()` exige en
  `harness.sh`, `inner.sh` y `nft-pin.sh` `set -euo pipefail` y las mismas prohibiciones, y en todos los
  scripts que corren como root (también `driver.mjs`, `probe.mjs`, `listener.mjs`,
  `app-adapters.mjs`) ningún token de gestor de paquetes de Node; en `nft-pin.sh`, apt solo como
  `update`, `install -s` y `download`, y `sudo` solo en sus dos órdenes fijas. Cada regla tiene control
  negativo en memoria en `npm test` y mutación archivada (MW-xx/MP-xx).

* **Forma canónica y pines (P6D-01/P6D-02, dictamen delta f9ea355; decisión 11:28 «corregir antes del
  push»):** sin dependencias nuevas (ni parser YAML: cambiaría lock/vendor). (1) `canonicalForm()` quita
  solo los comentarios de línea completa fuera de bloques `run: |` y el resultado debe ser **idéntico**
  a `CANON` (en `workflow-guard.mjs`): cualquier construcción fuera de la gramática permitida —claves
  entre comillas (`"if": false`), `|+`/`|2`/`>`, flow-style, anclas/merge, escapes, `${{ }}` en `run:`,
  `uses:` distinto de los dos fijados (incl. `docker://` y acciones locales), `env:` distinto de
  `EXPECTED_COMMIT`, `BASH_ENV`/`$GITHUB_ENV`, otro `working-directory` o `timeout-minutes`, pasos
  nuevos— falla; las reglas de §1 (ampliadas: `set +eu`/`+ex`, todo `exit` ≠ `exit 1`, `||/bin/true`,
  `!`, `&`, `if … then` sin `exit 1`, globs, `exec`, `return`, `fail()` canónico, `process.exit(0)` en
  el driver, override del lock) dan además el diagnóstico. (2) `test/isolation/root-pins.sha256` fija el
  sha256 del workflow completo (con comentarios) y de los archivos que corren como root (`harness.sh`,
  `inner.sh`, `driver.mjs`, `probe.mjs`, `listener.mjs`, `app-adapters.mjs`, `egress.nft`, `nft-pin.sh`,
  `nft-pin.lock` y las fixtures que importa el driver). Sin circularidad: el sha256 de
  `root-pins.sha256` vive en `test/pr6.harness-contract.test.mjs`, no en un archivo que él fije. Se
  verifica tres veces: `npm test` (contrato), el paso de CI (`sha256sum --check --strict` antes del
  `sudo`) y `harness.sh`/`inner.sh` (antes de ejecutar; `inner.sh` sobre la copia en tmpfs). (3) El
  arnés exige la cuenta real: plan `1..22`, `ok 1..22` en orden, 0 `not ok`, `# pass 22`, `# fail 0` y
  rc=0, e imprime `# arnés PR-6: OK 22/22`; el paso de CI vuelve a exigir esas líneas en el log. (4)
  `nft-pin.sh` no admite `X402_NFT_PIN_LOCK` (P6D-03): si viene definido falla cerrado; el lock
  explícito solo existe en `verify-lock` (pruebas), que nunca instala. **Límite declarado:** es un
  control de regresiones contra cambios del diff auditado, no una frontera contra un PR deliberado que
  actualice a la vez workflow, pines y contrato; ese caso lo cubre la revisión del Auditor sobre el SHA
  exacto y la protección de `main`. Para actualizar el workflow o un script root:
  `sha256sum` de la lista (orden fijo) → `root-pins.sha256` → `ROOT_PINS_SHA256` del contrato (y `CANON`
  si cambia el workflow), todo en el mismo diff.

### 1.1 Runbook: actualizar la versión fijada de nftables y sus hashes (P6C-02)

Lo ejecuta Xolo Arquitecto en un PR propio (nunca en el paso de CI); lo verifica Xolo Auditor; nada
se instala en el host.

1. Elegir la versión destino en `https://archive.ubuntu.com/ubuntu/dists/noble-updates/main/binary-amd64/Packages.gz`
   (y `noble-security`/`noble` si aplica). Descargar ese índice y su `InRelease`; comprobar la firma
   (`gpgv --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg InRelease`) y que el sha256 de
   `Packages.gz` coincide con el listado en `InRelease`.
2. Para `nftables` y `libnftables1` (misma versión) y cada dependencia que `apt-get install -s
   --no-install-recommends` planifique en un `ubuntu-24.04` limpio (contenedor o VM desechable), tomar
   `Package`, `Version`, `Architecture` y `SHA256` del índice.
3. Descargar cada `.deb` (`apt-get download pkg=ver` o `curl` del `Filename` del índice) y comprobar
   `sha256sum` = `SHA256` del índice y `dpkg-deb -f <deb> Package Version Architecture` = lock.
4. Editar `test/isolation/nft-pin.lock` (una línea por paquete; `requerido` para `nftables` y
   `libnftables1`, `dependencia` para el resto) y actualizar en este documento §1 y en el contrato
   (`test/pr6.nft-pin.test.mjs`, aserción del lock real) los hashes y la versión.
5. `bash test/isolation/nft-pin.sh verify <dir con los .deb> <plan apt-get -s>` → «verificación OK»;
   con un hash alterado en una copia del lock (`nft-pin.sh verify-lock <copia> <dir> [<plan>]`) → debe fallar. `X402_NFT_PIN_LOCK` ya no existe: si viene definido, el script falla cerrado (P6D-03).
6. Ejecutar el arnés con la nueva versión (en local, con los `.deb` extraídos y `NFT_BIN` apuntando a
   un envoltorio) y `npm test`; registrar `nft --version`, los sha256 y el log en la evidencia del PR.
7. El Auditor revisa los hashes contra el índice firmado; el cambio entra solo con su dictamen. Si en
   CI la versión fijada desaparece del espejo, el paso **falla** (no hay fallback): se repite este
   runbook, no se relaja el lock.

## 2 Matriz revisada

| Fila | Requisito | Prueba (positivo) | Par / control negativo | Mutación (parche archivado) |
| :---- | :---- | :---- | :---- | :---- |
| **T-12a** | La **política** permite la Chronik configurada (PM6-07: prueba la política, no el proceso; «alcanza Chronik» del proceso es N/A en TA-2 por DM-1) | sonda uid 2002 → 127.0.0.1:47100 = CONNECTED, «x402-chronik» +1 | resto de filas T-12b/c | MT12-1 (accept a otro puerto) |
| **T-12b** | `127.0.0.1:3011` rechazado | sonda uid 2002 → rechazo, «x402-deny» +1, 0 accepts legacy | uid 2001 al mismo destino = CONNECTED | MT12-2 (sin reject), MT12-3 (sonda con uid legacy) |
| **T-12c** | Otros destinos rechazados | uid 2002: 127.0.0.1:47199, [::1]:3011, 192.0.2.1:443 TCP, UDP 192.0.2.1:53 y 127.0.0.1:53 → rechazo con contador | uid 2001: CONNECTED / SENT (192.0.2.1:443: TIMEOUT, el destino no existe) | MT12-2 |
| **T-12d** | **El proceso x402 real**: CERO conexiones salientes, aceptadas o rechazadas (PM6-02) | `dist/main.js` uid 2002 en OFF y ON sin adaptadores (todas las rutas), y `createApp` de `dist/` con adaptadores + cadena C3B completa (402 → 200 → re-entrega 200) con el cliente FUERA (root) y el pago sintético por stdin: Δ«x402-new» = 0 y Δaccept = 0 en todos los oyentes | T-12a..c demuestran que los contadores funcionan | MT12-4 (fetch a 3011), **MT12-5** (fetch a la Chronik PERMITIDA, PM6-02), MT12e-1 |
| **T-12e (i)** | El legacy solo escucha TCP, sin IPC (PM6-01) | escaneo de `backend/src`: un único `app.listen(port, host)` en `server.ts` (PORT ?? 3011, HOST ?? 127.0.0.1); 0 primitivas IPC | el escáner detecta cada clase de IPC en texto sintético | — |
| **T-12e (ii)** | Socket UNIX con ruta: DAC | uid 2002 → EACCES, 0 accepts | uid 2001 → CONNECTED | MT12e-2 (dir y socket 0777) |
| **T-12e (iii)** | Socket abstracto: control | uid 2002 → CONNECTED (ni DAC ni nft lo cubren: residual, §4) y el contador del oyente lo detecta; «x402-new» 0 | el proceso real no lo usa: accept = 0 dentro de T-12d | MT12e-1 (dist conecta al abstracto) |
| **T-12e (iv)** | Barrera completa contra IPC abstracto / D-Bus | **precondición del gate de TA-3** (§4, G3-06) | — | — |
| **T-13a** | `.env` legacy ilegible | uid 2002 → EACCES | uid 2001 → OK | MT13-1 (o+r), MT13-2 (grupo 2001 + g+r) |
| **T-13b** | Unit ilegible | uid 2002 → EACCES | uid 2001 → OK | MT13-1 |
| **T-13c** | Estado legacy y `campaigns.db` | uid 2002: readdir → EACCES; `node:sqlite` → ERR_SQLITE_ERROR (DAC, no `--permission`; PM6-08) | uid 2001 → OK | MT13-1 |
| **T-13d** | Configuración apuntando al legacy | uid 2002 con STORE/GRANT en el release → exit 78 y el release no cambia | en directorio propio arranca y crea `grant.sqlite` y `store.sqlite` | MT13-3 (release 0777) |
| **T-13e** | Release ilegible | uid 2002 → EACCES | uid 2001 → OK | MT13-1 |
| **T-13f** | `/proc/<pid legacy>/environ` (PM6-10) | uid 2002 → EACCES (el legacy lleva un secreto sintético en su entorno) | uid 2001 → OK | — |
| **T-06a** | Sin alcance estático a finalize / legacy / llaves | T-11a/b/c sobre el grafo real; ningún archivo bajo `backend/` ni fuera del paquete; búsqueda en archivos propios (3011 solo en el rechazo de `env-guard.js`); **lista fijada de capacidades de red cargadas**, incluida la cargada y no invocada `createX402XecMiddleware` / `globalThis.fetch` (`@x402-xec/express/dist/middleware.js:15`) (PM6-04) | dist mutado (import `backend/finalize`, `node:net`, `fetch` a 3011) es detectado. La búsqueda por strings es evadible: el poder discriminante viene de T-11 y de T-12d | MT06-1 |
| **T-06b** | Llaves privadas / refund-oracle | por cada secreto del inventario 239f9dc (12) y cada identificador de la familia, el proceso real no arranca (exit 78, regla A; B para identificadores no secretos); ninguna en las allowlists | par positivo: entorno base arranca | MT06-2a (solo allowlist: rompe la aserción estática; la regla A y las subcadenas siguen rechazando, PM6-03), **MT06-2b** (además se desactivan la regla A y las subcadenas: falla la capa dinámica) |
| **T-06c** | Módulos cargados en runtime | hook `module.register` (load) + `require.cache` durante la cadena C3B completa: todo `file:` dentro del paquete, ninguno bajo `backend/` | módulo cargado desde fuera del paquete es detectado (PM6-04) | MT06-1 |

PM6-07: T-12a demuestra la política; para el proceso, «alcanza la Chronik» es N/A en TA-2 (DM-1, sin
cableado) y se demuestra en TA-3. PM6-08: ninguna prueba usa `process.permission.has()` como
evidencia; `--permission` (22.13.1) no es barrera de T-12 ni de T-13. PM6-09: T-13a–c/e prueban la
separación de uids sobre modos que fija el propio arnés, no la configuración real del host (así lo
prevé la fuente: «en TA-2 se ejecuta en un entorno de prueba»); la evidencia real es G3-08. PM6-10:
T-13f añadido; la unit real suele ser 0644 y `systemctl show` (D-Bus) expone `Environment=` a
cualquier usuario: va a la evidencia del operador (G3-08). PM6-11: CoS confirma que el check
requerido «x402-teyolia (Node 22.13.1)» sigue configurado en la protección de rama.

## 3 Cierre de la condición DEC-AX-12 y de T-06 (PM6-06)

* La fila T-06 de la tabla PT v1.1 (`docs/pr5-pt-correspondencia.md`, «falta la rama de red, T-12, y
  la de archivos legacy, T-13») queda cubierta por T-06a/b/c + T-12d + T-13a..f de este PR, con el
  arnés de dos uids reales y egreso controlado en CI (EN-2). La tabla v1.1 no se reescribe; esta
  sección la complementa.
* La condición DEC-AX-12 que dependía de PR-6 se cierra con la demostración de aislamiento (proceso
  real, uids reales, egreso con contador) **en TA-2**. La barrera de lanzador no la cierra PR-6: pasa
  al gate de TA-3 (§4).
* Comentarios que apuntaban a PR-6: README actualizado. El comentario de `src/main.ts` líneas 4–7
  («la barrera real es el lanzador (PR-6)») **no se toca** porque PR-6 no cambia `src/`; se
  actualiza en PR-6a. (Con `removeComments: true` no alteraría el manifiesto, pero la regla «sin
  cambios en `src/`» es literal.)

## 4 Fe de erratas de la reconciliación v2 §7.1 y precondiciones del gate de TA-3 (D-P6-2 (A))

**Errata §7.1:** P-4/L3, la parte `ExecStart` de PR1-L1, P-4/L6, PR4-D (b) y P3-L4 dejan de ser
bloqueadores del PASS de TA-2 y pasan a ser **precondiciones obligatorias del gate de TA-3**
(decisión de Fernando, 2026-10-24 09:21 CDMX). PR1-L4 y P3-L3 pasan a **PR-6a** (hardening con
`src/`, manifiesto nuevo). CoS registra la errata; PR-8 recoge esta lista con PT5-11, C66-A/B y P3-L2.

**Dueños por rol — ACEPTADOS** por Fernando (decisión 2026-10-24 11:28 CDMX, `t120u`, sobre el
dictamen del Auditor, P6C-07): **diseño** Xolo Arquitecto · **ejecución en host** operador del
despliegue (Fernando) · **verificación** Xolo Auditor · **registro** CoS. Rige para G3-01..08: el
Arquitecto diseña la unit/lanzador/política y el procedimiento de prueba; el operador lo ejecuta en
el host y entrega la evidencia sanitizada; el Auditor emite el dictamen; CoS registra el cierre en el
log de decisiones y en la matriz. Una precondición solo **cierra** cuando se cumplen a la vez su
criterio objetivo, el dictamen PASS del Auditor sobre esa evidencia y el registro de CoS; el gate de
TA-3 no abre con ninguna G3 abierta. PR-8 consolida esta tabla (con PT5-11, C66-A/B y P3-L2).

| ID | Origen | Rol accountable (cierre) | Evidencia requerida | Criterio objetivo de cierre (antes de TA-3) |
| :---- | :---- | :---- | :---- | :---- |
| **G3-01** | P-4/L3 | Ejecución: operador (Fernando); diseño de la unit: Arquitecto | Unit `teyolia-x402.service` versionada (sha256); salida de `systemctl show teyolia-x402 -p User,Group,Environment,EnvironmentFile,PassEnvironment,UnsetEnvironment`; log de la prueba de precarga con el marcador | Unit propia con `User=`/`Group=` propios (≠ legacy) y entorno solo por `Environment=`/`EnvironmentFile=` del servicio; `PassEnvironment` vacío; ninguna `NODE_OPTIONS` ni `NODE_*` no autorizada; con `NODE_OPTIONS=--import <marcador>` en el entorno del gestor, el marcador **no** se ejecuta (0 líneas del marcador) |
| **G3-02** | PR1-L1 (`ExecStart`) | Ejecución: operador; diseño: Arquitecto | `ExecStart` literal de `systemctl cat`; sha256 del binario node; `systemd-analyze security teyolia-x402` completo; log de T-11d repetido en el host | `ExecStart` absoluto y sin variables: `/<node verificado por sha256> --disallow-code-generation-from-strings [--permission --allow-fs-read=<raíz>] <raíz>/dist/main.js`; `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=` solo el directorio OB-05; T-11d PASS en el host |
| **G3-03** | P-4/L6 | Decisión: Fernando; diseño: Arquitecto; re-auditoría: Auditor | Lista de variables que systemd inyecta (`INVOCATION_ID`, `JOURNAL_STREAM`, …) observada bajo la unit; log de arranque; si hay ampliación, fila del log de decisiones y dictamen de re-auditoría | O bien el proceso arranca bajo la unit **sin** ampliar la allowlist (y falla cerrado si no), o bien la ampliación está registrada por Fernando **y** re-auditada con PASS |
| **G3-04** | PR4-D (b) | Decisión: Fernando; diseño: Arquitecto | Fila del log de decisiones; `ExecStart` resultante; prueba en el host (OFF con y sin la bandera) | Decisión registrada (exigir `--disallow-code-generation-from-strings` también con OFF, o justificación de no hacerlo) y prueba en el host coherente con ella |
| **G3-05** | P3-L4 | Ejecución: operador; diseño: Arquitecto | `findmnt -T <dir OB-05>`; permisos/propietario del directorio; rutas de store/grant en la unit | Directorio OB-05 en disco persistente (FSTYPE ≠ tmpfs), propiedad del uid x402, 0700; store y grant dentro de él; si se rechaza tmpfs en código, ese cambio lleva su propia re-auditoría |
| **G3-06** | PM6-01 (iv); P6C-05 | Ejecución: operador; diseño: Arquitecto | Unit (`RestrictAddressFamilies=` o netns); log de la **pareja**: (a) conexión a un socket abstracto sintético y al bus D-Bus del sistema desde el uid x402 bajo la unit; (b) consulta a la Chronik configurada desde el mismo proceso | **Negativo:** (a) falla (`EAFNOSUPPORT`/`ECONNREFUSED`, 0 accepts en el oyente sintético). **Positivo:** (b) la Chronik responde. Barrera aceptada: `RestrictAddressFamilies=AF_INET AF_INET6` (sin `AF_UNIX`) **o** un netns propio con egreso solo hacia la Chronik. `PrivateNetwork=yes` **no** basta como solución única: deja solo `lo` y corta también la Chronik (P6C-05). Mount/pid ns, DAC y `meta skuid` no aíslan el espacio abstracto |
| **G3-07** | T-12/T-13 en host (EN-2; fila **T-13** de la matriz INF-045 —«la comprobación en mx2 es evidencia sanitizada del operador, fuera de TA-2»— y **TA2-R6**; corrige la cita «INF-045 §6.2», P6C-07) | Ejecución: operador; verificación: Auditor | Política de egreso del host (reglas sanitizadas) para el uid x402; log de T-12/T-13 repetidos en mx2 con contadores | Desde el uid x402 solo la Chronik configurada es alcanzable (resto rechazado y contado); T-12/T-13 PASS en mx2; ruleset del resto del host sin cambios no previstos |
| **G3-08** | barrera fs/launcher; PM6-09/PM6-10 | Ejecución: operador; diseño del lanzador: Arquitecto | Log de T-13 en mx2 (lecturas del uid x402 sobre release, estado, `campaigns.db`, `.env` legacy y `/proc/<pid legacy>/environ`); `systemctl show <legacy> -p Environment`; permisos de la unit legacy | Todas esas lecturas = `EACCES`; la unit legacy y `systemctl show -p Environment` sin secretos (secretos solo en `EnvironmentFile=` 0600); cualquier ampliación del allowlist o del `--allow-fs-read` con re-auditoría PASS |

## 5 Residuales de PR-6

* **T-12e (iii):** en TA-2 el socket abstracto del legacy es alcanzable por el uid x402 (ni DAC ni
  `meta skuid` lo cubren); el proceso x402 real no lo usa (0 accepts) y el legacy real no lo abre
  (T-12e (i)). Barrera: G3-06.
* **Conexiones de respuesta** (`ct state established`) no se cuentan: solo cuenta lo que el uid x402
  inicia. Los servidores del proceso (listen en loopback) no son egreso.
* **CI no ejecutado todavía:** el paso se probó en local (Debian 13, nft 1.1.3, kernel 6.12); en
  `ubuntu-24.04` con nft 1.0.9 se verá en el primer run tras el push autorizado.
* **P6C-04 (registrado como residual):** la capa dinámica de T-12d es por ventana temporal y por
  oyente: un egreso diferido más allá de la ventana o un intento IPC hacia un socket sin oyente
  sintético no lo ve el arnés; sí lo ve T-06a (estático, mismo job). La cobertura es la combinación
  estática + dinámica.
* **P6C-03 (corregido en `test/`):** el driver mata a sus hijos y sale con 1 ante cualquier error, con
  vigía global de 300 s.
* **P6C-06:** el comentario de `src/main.ts` l.4–7 se corrige en PR-6a (regla «sin cambios en src/»).
* **P6C-10:** la reproducción local de nft 1.0.9 es híbrida (binario y libnftables de Ubuntu sobre
  libnftnl/libmnl/kernel de Debian); no sustituye al run en `ubuntu-24.04`.
* **PR1-L1 (parte de evidencia `--permission`):** no se incluye; solo tiene valor si el `ExecStart`
  adopta `--permission` (G3-02), y se verifica allí. T-11d sigue cubriendo la fuga de resolución.
