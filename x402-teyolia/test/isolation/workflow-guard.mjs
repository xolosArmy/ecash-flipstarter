// PR-6 / P6C-01 (Fernando 2026-10-24 11:28 CDMX; dictamen del Auditor sobre 538b0b3, P08–P12/P11b).
// Guarda del contrato del workflow x402-ta2.yml y de los scripts que corren como root. Devuelve la
// lista de violaciones (vacía = conforme). P6D-01 (dictamen delta f9ea355): además de las reglas, el
// workflow debe coincidir EXACTAMENTE con la forma canónica permitida (CANON: el archivo sin sus
// comentarios de línea completa fuera de bloques `run: |`); cualquier construcción fuera de ella
// (claves entre comillas, `|+`/`|2`, flow-style, escapes, `uses:`/`docker://`, `env:` extra,
// `BASH_ENV`, otros pasos…) falla. Sin dependencias: no hay parser YAML; se compara texto. El
// archivo completo (con comentarios) lo fija además su sha256 en root-pins.sha256 (P6D-02). La usan test/pr6.harness-contract.test.mjs (sobre el
// workflow real y sobre variantes mutadas en memoria) y las mutaciones archivadas MW-xx.

// Texto EXACTO del paso de aislamiento (nombre + run). Cualquier cambio (|| true, set +e, exit 0,
// if:, shell:, continue-on-error, sudo extra, saltarse nft-pin.sh…) lo rompe.
export const ISOLATION_STEP = `      - name: Aislamiento del SO PR-6 (T-12 / T-12e / T-13 / T-06; nft fijado por sha256, fail-closed)
        run: |
          set -euo pipefail
          sha256sum --check --strict test/isolation/root-pins.sha256
          bash test/isolation/nft-pin.sh install
          echo "ImageVersion: \${ImageVersion:-?}"; echo "runner: uid=$(id -u) gid=$(id -g)"
          sudo env ImageVersion="\${ImageVersion:-}" NODE_BIN="$(command -v node)" NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh | tee "$RUNNER_TEMP/pr6-arnes.log"
          grep -Fx '1..22' "$RUNNER_TEMP/pr6-arnes.log"
          grep -Fx '# pass 22' "$RUNNER_TEMP/pr6-arnes.log"
          grep -Fx '# fail 0' "$RUNNER_TEMP/pr6-arnes.log"
          grep -Fx '# arnés PR-6: OK 22/22' "$RUNNER_TEMP/pr6-arnes.log"
`;
// Únicas líneas del workflow que pueden contener sudo.
export const SUDO_ALLOWED = Object.freeze([
  'sudo env ImageVersion="${ImageVersion:-}" NODE_BIN="$(command -v node)" NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh | tee "$RUNNER_TEMP/pr6-arnes.log"',
]);
export const ON_BLOCK = 'on:\n  push:\n  pull_request:\n';
// P6D-01: forma canónica permitida del workflow (canonicalForm del archivo auditado), línea a línea.
export const CANON = [
  "name: x402-ta2",
  "",
  "on:",
  "  push:",
  "  pull_request:",
  "",
  "permissions:",
  "  contents: read",
  "",
  "jobs:",
  "  x402-teyolia:",
  "    name: x402-teyolia (Node 22.13.1)",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 15",
  "    defaults:",
  "      run:",
  "        working-directory: x402-teyolia",
  "    steps:",
  "      - name: Checkout",
  "        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0",
  "        with:",
  "          persist-credentials: false",
  "          ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  "",
  "      - name: Setup Node.js",
  "        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0",
  "        with:",
  "          node-version: '22.13.1'",
  "          package-manager-cache: false",
  "",
  "      - name: Verificar Node >= 22.13 (engines)",
  "        run: node -e \"const [a,b]=process.versions.node.split('.').map(Number); if (a!==22||b<13) { console.error('Se requiere Node 22.13+; hay ' + process.version); process.exit(1); } console.log(process.version)\"",
  "",
  "      - name: Instalar (lockfile propio, sin scripts)",
  "        run: npm ci --ignore-scripts",
  "",
  "      - name: Typecheck",
  "        run: npm run typecheck",
  "",
  "      - name: Build",
  "        run: npm run build",
  "",
  "      - name: Pruebas T-10 / T-11 / kill switch (node:test)",
  "        run: npm test",
  "",
  "      - name: T-11 sobre dist/main.js (check-graph)",
  "        run: npm run check:graph",
  "",
  "      - name: Inventario 239f9dc sin cambios (inventory:check)",
  "        run: npm run inventory:check",
  "",
  "      - name: M5-V1 rebuild limpio y comparación con dist/build-info.json (check:dist)",
  "        env:",
  "          EXPECTED_COMMIT: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  "        run: |",
  "          npm run check:dist",
  "          node scripts/dist-manifest.mjs --print",
  "          got=\"$(node -p \"JSON.parse(require('fs').readFileSync('dist/build-info.json','utf8')).commit\")\"",
  "          if [ \"$got\" != \"$EXPECTED_COMMIT\" ]; then echo \"M5-V1: commit de build-info $got != esperado $EXPECTED_COMMIT\"; exit 1; fi",
  "          echo \"M5-V1: commit de build-info = $EXPECTED_COMMIT (evento $GITHUB_EVENT_NAME)\"",
  "          d=\"$(mktemp -d)\"; cp -R dist \"$d/dist\"; printf ' ' >> \"$d/dist/server.js\"",
  "          if node scripts/dist-manifest.mjs --check \"$d/dist\"; then echo \"control negativo M5-V1: un dist/ mutado NO falló\"; exit 1; fi",
  "          echo \"control negativo M5-V1: dist/ mutado rechazado\"",
  "",
  "      - name: Aislamiento del SO PR-6 (T-12 / T-12e / T-13 / T-06; nft fijado por sha256, fail-closed)",
  "        run: |",
  "          set -euo pipefail",
  "          sha256sum --check --strict test/isolation/root-pins.sha256",
  "          bash test/isolation/nft-pin.sh install",
  "          echo \"ImageVersion: ${ImageVersion:-?}\"; echo \"runner: uid=$(id -u) gid=$(id -g)\"",
  "          sudo env ImageVersion=\"${ImageVersion:-}\" NODE_BIN=\"$(command -v node)\" NFT_BIN=/usr/sbin/nft bash test/isolation/harness.sh | tee \"$RUNNER_TEMP/pr6-arnes.log\"",
  "          grep -Fx '1..22' \"$RUNNER_TEMP/pr6-arnes.log\"",
  "          grep -Fx '# pass 22' \"$RUNNER_TEMP/pr6-arnes.log\"",
  "          grep -Fx '# fail 0' \"$RUNNER_TEMP/pr6-arnes.log\"",
  "          grep -Fx '# arnés PR-6: OK 22/22' \"$RUNNER_TEMP/pr6-arnes.log\"",
  "",
].join('\n');

const stripShComments = (t) => t.replace(/^\s*#.*$/gm, '');

// Forma canónica: quita SOLO comentarios de línea completa que estén fuera de un bloque `run: |`
// (dentro del bloque un `#` es contenido y se conserva, así que no coincidiría con CANON).
export function canonicalForm(text) {
  const out = [];
  let blockIndent = -1;
  for (const line of text.split('\n')) {
    const ind = line.search(/\S/);
    if (blockIndent >= 0 && (ind < 0 || ind > blockIndent)) { out.push(line); continue; }
    blockIndent = -1;
    if (/^\s*#/.test(line)) continue;
    out.push(line);
    const m = /^(\s*)(?:-\s+)?run:\s*\|\s*$/.exec(line);
    if (m) blockIndent = m[1].length;
  }
  return out.join('\n');
}
export function canonicalDiff(text) {
  const got = canonicalForm(text).split('\n');
  const exp = CANON.split('\n');
  for (let i = 0; i < Math.max(got.length, exp.length); i++) {
    if (got[i] !== exp[i]) return `canon: línea ${i + 1} (canónica): esperado ${JSON.stringify(exp[i] ?? '<fin>')}, obtenido ${JSON.stringify(got[i] ?? '<fin>')}`;
  }
  return null;
}

// Reglas de shell que enmascaran fallos (P6C-01 + P6D-01). Se aplican a los `run:` y a los scripts root.
export const SHELL_RULES = [
  { id: 'or-true', re: /\|\|\s*(?:\S*\/)?(?:true|false|:|exit\b|echo|printf)(?=\s|;|$|\))/m },
  { id: 'or-espacio', re: /\|\|\s/, workflowOnly: true }, // en run: solo se admite `||` sin espacio (JS de node -e)
  { id: 'set+e', re: /\bset\b[^\n;|&]*\s\+[a-zA-Z]|\bset\s+-o\s+\+|\bset\s+\+o\b/ }, // set +e, +eu, +ex, +o …
  { id: 'exit0', re: /(?:^|[\s;&|])exit(?![\w(])(?!\s+1(?![\w.]))/m }, // todo exit que no sea `exit 1` (00, "0", $x, vacío)
  { id: 'true-suelto', re: /(?:^|[;&|]\s*)(?:\S*\/)?(?:true|:)\s*(?:;|$)/m },
  { id: 'exec', re: /(?:^|[;&|]\s*)\s*exec\b/m, shOnly: true },
  { id: 'return', re: /(?:^|[;&|{]\s*)\s*return\b/m, shOnly: true },
  { id: 'negacion', re: /(?:^|[;&|]\s*)!\s/m },
  { id: 'segundo-plano', re: /[^&|>]&(?![&>])\s*(?:$|;|\))/m },
  { id: 'if-sin-exit', re: /\bif\b(?![^\n]*\bthen\b[^\n]*\bexit 1; fi\s*$)[^\n]*\bthen\b/m, workflowOnly: true },
  { id: 'escape', re: /\\/, workflowOnly: true },
  { id: 'expr-en-run', re: /\$\{\{/, workflowOnly: true },
  { id: 'entorno-peligroso', re: /\b(?:BASH_ENV|ENV|BASH_FUNC_\w*|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|GITHUB_ENV|GITHUB_PATH|PROMPT_COMMAND|SHELLOPTS)\b/ },
];
const ROOT_ESCALATION = /\b(?:su|doas|pkexec|runuser|nsenter|chroot|docker|podman|nerdctl|systemd-run|machinectl)\b/;
const ROOT_ESCALATION_WF = /\b(?:su|doas|pkexec|runuser|nsenter|chroot|docker|podman|nerdctl|systemd-run|machinectl|unshare|setpriv|capsh)\b|docker:\/\//;
const PKG_MANAGERS = /\b(?:npm|npx|yarn|pnpm|corepack)\b/;
const ALLOWED_USES = Object.freeze([
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0',
]);

function runLinesOf(code) {
  const runLines = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?["']?run["']?\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (/^[|>]/.test(m[2])) { // cualquier indicador de bloque (|, |+, |-, |2, >, >-…): se escanea el bloque igual
      const ind = m[1].length;
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > ind); j++) runLines.push(lines[j].trim());
    } else runLines.push(m[2].trim().replace(/^(["'])(.*)\1$/, '$2')); // valor entre comillas: se escanea sin ellas
  }
  return runLines;
}

export function workflowViolations(text) {
  const v = [];
  const cd = canonicalDiff(text);
  if (cd) v.push(cd);
  if (/\r|\t|^\uFEFF/.test(text)) v.push('caracteres-no-canonicos');
  const code = canonicalForm(text);
  const jobsAt = code.indexOf('\njobs:\n');
  if (jobsAt < 0) return [...v, 'sin jobs:'];
  const jobs = code.slice(jobsAt);
  if ([...jobs.matchAll(/^ {2}\S.*:\s*$/gm)].length !== 1) v.push('un-unico-job');
  if (!/^ {4}name: x402-teyolia \(Node 22\.13\.1\)$/m.test(code)) v.push('nombre-del-check');
  if (!/^ {4}runs-on: ubuntu-24\.04$/m.test(code)) v.push('runs-on');
  if (!/^ {8}working-directory: x402-teyolia$/m.test(code)) v.push('working-directory');
  if (!code.includes('\npermissions:\n  contents: read\n')) v.push('permissions');
  if (/^ {4}permissions:/m.test(code)) v.push('permissions-job');
  if (!/persist-credentials: false/.test(code)) v.push('persist-credentials');
  const onBlock = /\non:\n(?:[ \t]+.*\n|\n)*/.exec(code)?.[0].replace(/^\n/, '').replace(/\n+$/, '\n');
  if (onBlock !== ON_BLOCK) v.push('on-sin-filtros');
  // Gramática mínima: claves sin comillas, sin flow-style, sin anclas/alias/merge, bloques solo `|`.
  if (/^\s*(?:-\s+)?["'][^"']*["']\s*:/m.test(code)) v.push('clave-entre-comillas');
  if (/^\s*(?:-\s+)?["']?if["']?\s*:|[{,]\s*["']?if["']?\s*:/m.test(code)) v.push('if:');
  if (/^\s*(?:-\s+)?(?:[^\s:]+:[ \t]*)?[{[]/m.test(code)) v.push('flow-style');
  if (/^[ \t]*(?:-[ \t]+)?<<[ \t]*:|:[ \t]*[&*][\w-]+|^[ \t]*-[ \t]+[&*]/m.test(code)) v.push('ancla/alias/merge');
  if (/:[ \t]*[|>](?![ \t]*$)|:[ \t]*>[ \t]*$/m.test(code)) v.push('bloque-no-canonico');
  if (/^\s*(?:-\s+)?run:[ \t]*["']/m.test(code)) v.push('run-entre-comillas');
  if (/continue-on-error/.test(code)) v.push('continue-on-error');
  if (/^\s*(?:-\s+)?["']?shell["']?\s*:/m.test(code)) v.push('shell:');
  if (/^\s*(?:-\s+)?(?:needs|strategy|matrix|services|container)\s*:/m.test(code)) v.push('needs/strategy/container');
  if (/timeout-minutes:(?! 15$)/m.test(code)) v.push('timeout-minutes');
  if (/secrets\.|GITHUB_TOKEN|github\.token/.test(code)) v.push('secretos');
  for (const m of code.matchAll(/^\s*(?:-\s+)?uses:\s*(.*)$/gm)) if (!ALLOWED_USES.includes(m[1].trim())) v.push(`uses-no-permitido: ${m[1].trim()}`);
  if ((code.match(/^\s*(?:-\s+)?uses:/gm) ?? []).length !== 2) v.push('uses-cuenta');
  for (const m of code.matchAll(/^( +)env:\s*$/gm)) {
    const block = code.slice(m.index + m[0].length + 1).split('\n');
    const keys = [];
    for (const l of block) { if (l.search(/\S/) <= m[1].length) break; keys.push(l.trim().split(':')[0]); }
    if (keys.join(',') !== 'EXPECTED_COMMIT') v.push(`env-no-permitido: ${keys.join(',')}`);
  }
  if (/^[ \t]*env:[ \t]*\S/m.test(code)) v.push('env-no-permitido: en línea');
  const runLines = runLinesOf(code);
  const iso = new Set(ISOLATION_STEP.split('\n').slice(2).map((x) => x.trim()));
  const sh = runLines.join('\n');
  for (const r of SHELL_RULES.filter((x) => !x.shOnly)) if (r.re.test(sh)) v.push(r.id);
  for (const l of runLines.filter((x) => !iso.has(x))) if (/[*?]/.test(l)) v.push(`glob: ${l}`);
  for (const l of runLines.filter((x) => /\bsudo\b/.test(x))) if (!SUDO_ALLOWED.includes(l)) v.push(`sudo-no-permitido: ${l}`);
  if (ROOT_ESCALATION_WF.test(sh)) v.push('escalada-root');
  for (const l of runLines.filter((x) => PKG_MANAGERS.test(x))) {
    if (/\bsudo\b|\bsu\b|\bdoas\b/.test(l)) v.push(`npm-como-root: ${l}`);
  }
  // Paso de aislamiento: texto exacto y último paso.
  const steps = code.split(/\n(?= {6}- name: )/).slice(1).map((x) => `${x.replace(/\n+$/, '')}\n`);
  const isoSteps = steps.filter((x) => x.includes('test/isolation/harness.sh'));
  if (isoSteps.length !== 1) v.push('un-unico-paso-de-aislamiento');
  else {
    if (isoSteps[0] !== ISOLATION_STEP) v.push('paso-de-aislamiento-exacto');
    if (steps.at(-1) !== isoSteps[0]) v.push('aislamiento-ultimo-paso');
  }
  return v;
}

// Scripts que corren como root (o que invocan sudo): fail-closed y sin gestores de paquetes de Node.
export function rootScriptViolations(name, text) {
  const v = [];
  const code = stripShComments(text);
  if (name.endsWith('.sh')) {
    if (!/^set -euo pipefail$/m.test(code)) v.push(`${name}: set -euo pipefail`);
    for (const r of SHELL_RULES.filter((x) => !x.workflowOnly)) if (r.re.test(code)) v.push(`${name}: ${r.id}`);
    // `||` solo hacia fail, rc=$?, otra prueba `[ … ]` o el bloque de error de inner.sh.
    for (const m of code.matchAll(/\|\|\s*(.{0,24})/g)) if (!/^(?:fail\b|rc=\$\?|\[ |\{ echo "inner: )/.test(m[1])) v.push(`${name}: or-no-permitido: || ${m[1]}`);
    if (ROOT_ESCALATION.test(code)) v.push(`${name}: escalada-root`);
  }
  if ((name === 'harness.sh' || name === 'nft-pin.sh') && !new RegExp(`^fail\\(\\) \\{ echo "[^"\\n]*" >&2; exit 1; \\}$`, 'm').test(code)) v.push(`${name}: fail()-no-canonico`);
  if (name === 'driver.mjs' && /process\.exit\(\s*(?!1\s*\))|process\.exitCode\s*=\s*0\b|process\.(?:abort|kill)\(/.test(code)) v.push(`${name}: exit0`);
  if (PKG_MANAGERS.test(code)) v.push(`${name}: gestor-de-paquetes-node`);
  if (name === 'nft-pin.sh') {
    // Sin fallback: apt-get solo para update, simulación (-s) y download; instalación solo dpkg -i de lo verificado.
    for (const l of code.split('\n').filter((x) => /\bapt(?:-get)?\b/.test(x) && !/^\s*command -v apt-get/.test(x))) {
      if (!/apt-get update -o Acquire::Retries=3$|apt-get install -s --no-install-recommends |apt-get download /.test(l)) v.push(`${name}: apt-no-permitido: ${l.trim()}`);
    }
    if (/--allow-downgrades|--force-|--allow-unauthenticated|--no-check/.test(code)) v.push(`${name}: bypass`);
    const sudos = code.split('\n').filter((x) => /\bsudo\b/.test(x)).map((x) => x.trim());
    for (const l of sudos) if (!/^sudo apt-get update -o Acquire::Retries=3$|^sudo dpkg -i "\$W"\/debs\/\*\.deb$/.test(l)) v.push(`${name}: sudo-no-permitido: ${l}`);
    if (!/^\[ -z "\$\{X402_NFT_PIN_LOCK\+definida\}" \] \|\| fail /m.test(code)) v.push(`${name}: override-de-lock (P6D-03)`);
  }
  return v;
}
