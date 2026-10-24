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

echo "# arnés PR-6 (T-12/T-12e/T-13/T-06) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
rc=0
unshare --mount --net --pid --fork --mount-proc --propagation private \
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
  ISO_STAGE="$STAGE" ISO_PKG="$PKG" ISO_NODE_SRC="$NODE_BIN" ISO_NFT="$NFT_BIN" \
  bash "$PKG/test/isolation/inner.sh" || rc=$?
if [ -d "$STAGE" ]; then rmdir "$STAGE"; fi

HOST_RULESET_AFTER="$("$NFT_BIN" list ruleset 2>&1 | sha256sum | cut -d' ' -f1)"
PASSWD_AFTER="$(sha256sum /etc/passwd /etc/group | sha256sum | cut -d' ' -f1)"
echo "# ruleset del host después: $HOST_RULESET_AFTER; /etc/passwd+group: $PASSWD_AFTER"
[ "$HOST_RULESET_BEFORE" = "$HOST_RULESET_AFTER" ] || fail "el ruleset del host cambió"
[ "$PASSWD_BEFORE" = "$PASSWD_AFTER" ] || fail "/etc/passwd o /etc/group cambió"
[ "$rc" = "0" ] || fail "el driver reportó fallos (exit $rc)"
echo "# arnés PR-6: OK"
