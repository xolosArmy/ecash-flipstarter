#!/usr/bin/env bash
# PR-6 — arnés de aislamiento del SO para T-12 / T-12e / T-13 (y la parte de runtime de T-06).
# D-P6-1 (a), Fernando 2026-10-24 09:21: un único paso dentro del job requerido; fail-closed; registra
# nft --version, uname -r, ImageVersion y uid/gid; namespaces desechables con usuarios de SO separados;
# no modifica /etc/passwd ni el ruleset del host; nunca ejecuta npm como root; sin secretos.
#
# Uso (como root; dist/ ya construido por un usuario sin privilegios):
#   sudo env NODE_BIN="$(command -v node)" [NFT_BIN=/usr/sbin/nft] [ImageVersion=…] bash test/isolation/harness.sh
set -euo pipefail
fail() { echo "arnés PR-6: FALLA: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "requiere root (sudo). No se omite: fail-closed"
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# P6C-01: sin «|| true»; los valores por defecto se resuelven con pruebas explícitas.
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && command -v node >/dev/null; then NODE_BIN="$(command -v node)"; fi
NFT_BIN="${NFT_BIN:-/usr/sbin/nft}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "node no encontrado (NODE_BIN)"
[ -x "$NFT_BIN" ] || fail "nft no disponible (NFT_BIN); instala la versión fijada (ver README §PR-6)"
for t in unshare setpriv ip sha256sum; do command -v "$t" >/dev/null || fail "$t no disponible"; done
[ -f "$PKG/dist/main.js" ] && [ -f "$PKG/dist/build-info.json" ] || fail "falta dist/ (build previo como usuario sin privilegios)"
[ -d "$PKG/node_modules" ] || fail "falta node_modules (instalación previa de dependencias como usuario sin privilegios)"

# P6D-02: número exacto de comprobaciones TAP que debe reportar el driver (plan 1..N, N ok, 0 fallos).
EXPECTED_TESTS=22
# P6D-02: sha256 fijados de los archivos que corren como root (test/isolation/root-pins.sha256; el hash
# del propio root-pins.sha256 lo fija test/pr6.harness-contract.test.mjs, no este script). Se verifican
# ANTES de ejecutarlos; el paso de CI verifica además el workflow y este script antes del sudo.
PINS="$PKG/test/isolation/root-pins.sha256"
[ -f "$PINS" ] || fail "falta $PINS"
PIN_LINES="$(grep -E '^[0-9a-f]{64}  test/' "$PINS")"
[ "$(wc -l <<< "$PIN_LINES")" -ge 10 ] || fail "root-pins.sha256 incompleto"
( cd "$PKG" && sha256sum --check --strict --quiet <<< "$PIN_LINES" ) || fail "sha256 de un script root distinto del fijado"
PINS_SHA="$(sha256sum "$PINS" | cut -d' ' -f1)"

echo "# arnés PR-6 (T-12/T-12e/T-13/T-06) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# root-pins.sha256: $PINS_SHA ($(wc -l <<< "$PIN_LINES") archivos de test/ verificados)"
echo "# nft --version: $("$NFT_BIN" --version)"
echo "# uname -r: $(uname -r)"
echo "# ImageVersion: ${ImageVersion:-<no definido: fuera de GitHub Actions>}"
echo "# os-release: $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "# id (arnés): uid=$(id -u) gid=$(id -g); invocado por SUDO_UID=${SUDO_UID:-?} SUDO_GID=${SUDO_GID:-?}"
echo "# uids del arnés: legacy=2001 x402=2002 (numéricos, sin /etc/passwd)"
echo "# node: $("$NODE_BIN" -v) sha256 $(sha256sum "$NODE_BIN" | cut -d' ' -f1)"
echo "# unshare: $(unshare --version | head -1); setpriv: $(setpriv --version | head -1); ip: $(ip -V)"
echo "# build-info: $(tr -d '\n ' < "$PKG/dist/build-info.json" | cut -c1-200)"

HOST_RULESET_BEFORE="$("$NFT_BIN" list ruleset 2>&1 | sha256sum | cut -d' ' -f1)"
PASSWD_BEFORE="$(sha256sum /etc/passwd /etc/group | sha256sum | cut -d' ' -f1)"
echo "# ruleset del host (sha256, solo lectura) antes: $HOST_RULESET_BEFORE; /etc/passwd+group: $PASSWD_BEFORE"

STAGE="$(mktemp -d /tmp/x402-iso.XXXXXX)"
TAP="$(mktemp /tmp/x402-iso-tap.XXXXXX)"
trap 'rm -f "$TAP"' EXIT
rc=0
unshare --mount --net --pid --fork --mount-proc --propagation private \
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
  ISO_STAGE="$STAGE" ISO_PKG="$PKG" ISO_NODE_SRC="$NODE_BIN" ISO_NFT="$NFT_BIN" ISO_PINS_SHA="$PINS_SHA" \
  bash "$PKG/test/isolation/inner.sh" | tee "$TAP" || rc=$?
if [ -d "$STAGE" ]; then rmdir "$STAGE"; fi

HOST_RULESET_AFTER="$("$NFT_BIN" list ruleset 2>&1 | sha256sum | cut -d' ' -f1)"
PASSWD_AFTER="$(sha256sum /etc/passwd /etc/group | sha256sum | cut -d' ' -f1)"
echo "# ruleset del host después: $HOST_RULESET_AFTER; /etc/passwd+group: $PASSWD_AFTER"
[ "$HOST_RULESET_BEFORE" = "$HOST_RULESET_AFTER" ] || fail "el ruleset del host cambió"
[ "$PASSWD_BEFORE" = "$PASSWD_AFTER" ] || fail "/etc/passwd o /etc/group cambió"
[ "$rc" = "0" ] || fail "el driver reportó fallos (exit $rc)"
# P6D-02: la cuenta real, no solo el código de salida.
grep -Fxq "1..$EXPECTED_TESTS" "$TAP" || fail "plan TAP distinto de 1..$EXPECTED_TESTS"
[ "$(grep -oE '^ok [0-9]+ - ' "$TAP" | awk '{print $2}' | tr '\n' ' ')" = "$(seq -s ' ' 1 "$EXPECTED_TESTS") " ] || fail "las comprobaciones ok no son exactamente 1..$EXPECTED_TESTS"
[ "$(grep -cE '^not ok ' "$TAP")" = "0" ] || fail "hay comprobaciones «not ok»"
grep -Fxq "# pass $EXPECTED_TESTS" "$TAP" || fail "el driver no reporta # pass $EXPECTED_TESTS"
grep -Fxq "# fail 0" "$TAP" || fail "el driver no reporta # fail 0"
echo "# arnés PR-6: OK $EXPECTED_TESTS/$EXPECTED_TESTS"
