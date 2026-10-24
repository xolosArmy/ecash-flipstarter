// PR-6 / P6C-01 (Fernando 2026-10-24 11:28 CDMX; dictamen del Auditor sobre 538b0b3, P08–P12/P11b).
// Guarda del contrato del workflow x402-ta2.yml y de los scripts que corren como root. Devuelve la
// lista de violaciones (vacía = conforme). La usan test/pr6.harness-contract.test.mjs (sobre el
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

const stripYamlComments = (t) => t.replace(/^\s*#.*\n/gm, '');
const stripShComments = (t) => t.replace(/^\s*#.*$/gm, '');

// Reglas de shell que enmascaran fallos (P6C-01). Se aplican al workflow y a los scripts root.
export const SHELL_RULES = [
  { id: 'or-true', re: /\|\|\s*(?:true|:|exit\s+0|echo|printf)\b/ },
  { id: 'or-espacio', re: /\|\|\s/, workflowOnly: true }, // en run: solo se admite `||` sin espacio (JS de node -e)
  { id: 'set+e', re: /\bset\s+\+[a-zA-Z]*[eo]\b|\bset\s+-o\s+\+|\bset\s+\+o\b/ },
  { id: 'exit0', re: /\bexit\s+0\b|\bexit\s*$|\breturn\s+0\s*$/m },
  { id: 'true-suelto', re: /(?:^|[;&]\s*)(?:true|:)\s*(?:;|$)/m },
];
const ROOT_ESCALATION = /\b(?:su|doas|pkexec|runuser|nsenter|chroot)\b/;
const PKG_MANAGERS = /\b(?:npm|npx|yarn|pnpm|corepack)\b/;

export function workflowViolations(text) {
  const v = [];
  const code = stripYamlComments(text).replace(/\$\{\{[^}]*\}\}/g, '${{EXPR}}');
  const jobsAt = code.indexOf('\njobs:\n');
  if (jobsAt < 0) return ['sin jobs:'];
  const jobs = code.slice(jobsAt);
  if ([...jobs.matchAll(/^ {2}[\w-]+:\s*$/gm)].length !== 1) v.push('un-unico-job');
  if (!/^ {4}name: x402-teyolia \(Node 22\.13\.1\)$/m.test(code)) v.push('nombre-del-check');
  if (!/^ {4}runs-on: ubuntu-24\.04$/m.test(code)) v.push('runs-on');
  if (!code.includes('\npermissions:\n  contents: read\n')) v.push('permissions');
  if (/^ {4}permissions:/m.test(code)) v.push('permissions-job');
  if (!/persist-credentials: false/.test(code)) v.push('persist-credentials');
  const onBlock = /\non:\n(?:[ \t]+.*\n|\n)*/.exec(code)?.[0].replace(/^\n/, '').replace(/\n+$/, '\n');
  if (onBlock !== ON_BLOCK) v.push('on-sin-filtros');
  if (/^\s*(?:-\s+)?if\s*:/m.test(code)) v.push('if:');
  if (/continue-on-error/.test(code)) v.push('continue-on-error');
  if (/^\s*(?:-\s+)?shell\s*:/m.test(code)) v.push('shell:');
  if (/^\s*(?:-\s+)?(?:needs|strategy|matrix|services|container)\s*:/m.test(code)) v.push('needs/strategy/container');
  if (/timeout-minutes:\s*0\b/.test(code)) v.push('timeout-0');
  if (/secrets\.|GITHUB_TOKEN|github\.token/.test(code)) v.push('secretos');
  // run: líneas de shell (bloques y en línea)
  const runLines = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] === '|' || m[2] === '>' || m[2] === '|-' || m[2] === '>-') {
      const ind = m[1].length;
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > ind); j++) runLines.push(lines[j].trim());
    } else runLines.push(m[2].trim());
  }
  const sh = runLines.join('\n');
  for (const r of SHELL_RULES) if (r.re.test(sh)) v.push(r.id);
  for (const l of runLines.filter((x) => /\bsudo\b/.test(x))) if (!SUDO_ALLOWED.includes(l)) v.push(`sudo-no-permitido: ${l}`);
  if (ROOT_ESCALATION.test(sh)) v.push('escalada-root');
  for (const l of runLines.filter((x) => PKG_MANAGERS.test(x))) {
    if (/\bsudo\b|\bsu\b|\bdoas\b/.test(l)) v.push(`npm-como-root: ${l}`);
  }
  // Paso de aislamiento: texto exacto y último paso.
  const steps = code.split(/\n(?= {6}- name: )/).slice(1).map((s) => `${s.replace(/\n+$/, '')}\n`);
  const iso = steps.filter((s) => s.includes('test/isolation/harness.sh'));
  if (iso.length !== 1) v.push('un-unico-paso-de-aislamiento');
  else {
    if (iso[0] !== ISOLATION_STEP) v.push('paso-de-aislamiento-exacto');
    if (steps.at(-1) !== iso[0]) v.push('aislamiento-ultimo-paso');
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
    if (ROOT_ESCALATION.test(code)) v.push(`${name}: escalada-root`);
  }
  if (PKG_MANAGERS.test(code)) v.push(`${name}: gestor-de-paquetes-node`);
  if (name === 'nft-pin.sh') {
    // Sin fallback: apt-get solo para update, simulación (-s) y download; instalación solo dpkg -i de lo verificado.
    for (const l of code.split('\n').filter((x) => /\bapt(?:-get)?\b/.test(x) && !/^\s*command -v apt-get/.test(x))) {
      if (!/apt-get update -o Acquire::Retries=3$|apt-get install -s --no-install-recommends |apt-get download /.test(l)) v.push(`${name}: apt-no-permitido: ${l.trim()}`);
    }
    if (/--allow-downgrades|--force-|--allow-unauthenticated|--no-check/.test(code)) v.push(`${name}: bypass`);
    const sudos = code.split('\n').filter((x) => /\bsudo\b/.test(x)).map((x) => x.trim());
    for (const l of sudos) if (!/^sudo apt-get update -o Acquire::Retries=3$|^sudo dpkg -i "\$W"\/debs\/\*\.deb$/.test(l)) v.push(`${name}: sudo-no-permitido: ${l}`);
  }
  return v;
}
