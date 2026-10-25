// PR-6 / P6D-01..03 (dictamen delta f9ea355): variantes naturales que la guarda debe detectar. Fuente
// única para los controles negativos en memoria de test/pr6.harness-contract.test.mjs y para los parches
// archivados MV-xx / MB-xx (mut/make-patches.py replica las mismas sustituciones). [ancla, reemplazo,
// violaciones esperadas (prefijos)]. Toda variante del workflow debe romper además la forma canónica.
export const WORKFLOW_VARIANTS = {
  'MV-01 "if": false (clave entre comillas) a nivel de job': ['    runs-on: ubuntu-24.04\n', '    "if": false\n    runs-on: ubuntu-24.04\n', ['clave-entre-comillas', 'if:']],
  "MV-02 'if': ${{ false }} en el paso de aislamiento": ['        run: |\n          set -euo pipefail\n          sha256sum', "        'if': ${{ false }}\n        run: |\n          set -euo pipefail\n          sha256sum", ['clave-entre-comillas', 'if:', 'paso-de-aislamiento-exacto']],
  'MV-03 <<: {if: false} (merge + flow) en el job': ['    runs-on: ubuntu-24.04\n', '    <<: {if: false}\n    runs-on: ubuntu-24.04\n', ['ancla/alias/merge', 'flow-style', 'if:']],
  'MV-04 set +eu': ['          npm run check:dist\n', '          set +eu\n          npm run check:dist\n', ['set+e']],
  'MV-05 set +ex': ['          npm run check:dist\n', '          set +ex\n          npm run check:dist\n', ['set+e']],
  'MV-06 exit 00': ['          npm run check:dist\n', '          [ -n "${SKIP_M5:-x}" ] && exit 00\n          npm run check:dist\n', ['exit0']],
  'MV-07 exit "0"': ['          npm run check:dist\n', '          [ -n "${SKIP_M5:-x}" ] && exit "0"\n          npm run check:dist\n', ['exit0']],
  'MV-08 ||/bin/true': ['        run: npm test\n', '        run: npm test ||/bin/true\n', ['or-true']],
  "MV-09 ${{ '|| true' }}": ['        run: npm test\n', "        run: npm test ${{ '|| true' }}\n", ['expr-en-run']],
  'MV-10 run: |+ con sudo npm test': ['        run: npm test\n', '        run: |+\n          sudo npm test\n', ['bloque-no-canonico', 'sudo-no-permitido: sudo npm test']],
  'MV-11 run: |2 con || true': ['        run: npm test\n', '        run: |2\n            npm test || true\n', ['bloque-no-canonico', 'or-true']],
  'MV-12 paso en flow-style': ['      - name: Typecheck\n', '      - {name: x, run: "sudo npm ci"}\n      - name: Typecheck\n', ['flow-style']],
  'MV-13 escape YAML \\x75': ['        run: npm ci --ignore-scripts\n', '        run: "s\\x75do npm ci"\n', ['escape']],
  'MV-14 escape de shell s\\udo': ['        run: npm ci --ignore-scripts\n', '        run: s\\udo npm ci\n', ['escape']],
  'MV-15 ${{ join(fromJSON(...)) }}': ['        run: npm ci --ignore-scripts\n', `        run: \${{ join(fromJSON('["sudo","npm","ci"]'),' ') }}\n`, ['expr-en-run']],
  'MV-16 docker run … npm ci': ['        run: npm ci --ignore-scripts\n', '        run: docker run --rm -v "$PWD:/w" -w /w node:22 npm ci\n', ['escalada-root']],
  'MV-17 uses: docker:// + args': ['      - name: Typecheck\n        run: npm run typecheck\n', '      - name: Typecheck\n        uses: docker://node:22\n        with:\n          args: npm ci\n', ['uses-no-permitido: docker://node:22']],
  'MV-18 uses: acción local': ['      - name: Typecheck\n        run: npm run typecheck\n', '      - name: Typecheck\n        uses: ./.github/actions/x\n', ['uses-no-permitido: ./.github/actions/x']],
  'MV-19 env: BASH_ENV a nivel de job': ['    runs-on: ubuntu-24.04\n', '    env:\n      BASH_ENV: /tmp/e\n    runs-on: ubuntu-24.04\n', ['env-no-permitido: BASH_ENV']],
  'MV-20 vaciar harness.sh con un glob': ['        run: npm test\n', '        run: npm test\n\n      - name: x\n        run: cp /bin/true test/isolation/h*ss.sh\n', ['glob: cp /bin/true test/isolation/h*ss.sh']],
  'MV-21 if npm test; then …; fi': ['        run: npm test\n', '        run: if npm test; then echo ok; fi\n', ['if-sin-exit']],
  'MV-22 npm test &': ['        run: npm test\n', '        run: npm test &\n', ['segundo-plano']],
  'MV-23 ! npm test; echo': ['        run: npm test\n', '        run: "! npm test; echo"\n', ['run-entre-comillas', 'negacion']],
  'MV-24 working-directory cambiado': ['        working-directory: x402-teyolia\n', '        working-directory: .\n', ['working-directory']],
  'MV-25 env: X402_NFT_PIN_LOCK': ['        env:\n          EXPECTED_COMMIT:', '        env:\n          X402_NFT_PIN_LOCK: /tmp/l\n          EXPECTED_COMMIT:', ['env-no-permitido: X402_NFT_PIN_LOCK']],
  'MV-26 timeout-minutes: 00': ['    timeout-minutes: 15\n', '    timeout-minutes: 00\n', ['timeout-minutes']],
  'MV-27 BASH_ENV vía $GITHUB_ENV': ['        run: npm test\n', '        run: |\n          echo "BASH_ENV=/tmp/e" >> "$GITHUB_ENV"\n          npm test\n', ['entorno-peligroso']],
};
// Scripts root (B-xx del dictamen): [archivo, ancla, reemplazo, violaciones esperadas].
export const ROOT_VARIANTS = {
  'MB-01 exec true tras la comprobación de root (harness.sh)': ['harness.sh', 'PKG="$(cd', 'exec true\nPKG="$(cd', ['harness.sh: exec']],
  'MB-02 exit 00 (harness.sh)': ['harness.sh', 'STAGE="$(mktemp', 'exit 00\nSTAGE="$(mktemp', ['harness.sh: exit0']],
  'MB-04 set +eu (harness.sh)': ['harness.sh', 'STAGE="$(mktemp', 'set +eu\nSTAGE="$(mktemp', ['harness.sh: set+e']],
  'MB-05 verify_dir con return (nft-pin.sh)': ['nft-pin.sh', '  local dir="$1"; shift\n', '  local dir="$1"; shift\n  return\n', ['nft-pin.sh: return']],
  'MB-06 fail() sin exit (nft-pin.sh)': ['nft-pin.sh', 'fail() { echo "nft-pin: FALLA: $*" >&2; exit 1; }', 'fail() { echo "nft-pin: FALLA: $*" >&2; }', ['nft-pin.sh: fail()-no-canonico']],
  'MB-07 process.exit(0) al inicio (driver.mjs)': ['driver.mjs', "const HERE = path.join(PKG, 'test', 'isolation');\n", "const HERE = path.join(PKG, 'test', 'isolation');\nprocess.exit(0);\n", ['driver.mjs: exit0']],
  'MB-09 override del lock restaurado (nft-pin.sh)': ['nft-pin.sh', '[ -z "${X402_NFT_PIN_LOCK+definida}" ] || fail', '[ -n "${X402_NFT_PIN_LOCK:-}" ] || fail', ['nft-pin.sh: override-de-lock']],
};
