#!/usr/bin/env bash
# PR-6 / P6C-02 (Fernando 2026-10-24 11:28 CDMX): instala nftables desde .deb oficiales de Ubuntu
# VERIFICADOS por SHA-256 contra nft-pin.lock. Falla cerrado si la versión fijada no está disponible,
# si un hash no coincide, si falta un .deb requerido, si aparece uno no fijado o si apt planifica una
# dependencia que no está en el lock. Sin fallback: no hay rama que instale otra versión.
# Uso:
#   nft-pin.sh install                    (CI: usuario del runner; sudo solo para apt-get update y dpkg -i)
#   nft-pin.sh verify <dir> [<plan>]      (sin red ni root: verifica los .deb de <dir>; <plan> = salida
#                                          de `apt-get install -s`; lo usan las pruebas y el runbook)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="${X402_NFT_PIN_LOCK:-$HERE/nft-pin.lock}"
fail() { echo "nft-pin: FALLA: $*" >&2; exit 1; }
[ -f "$LOCK" ] || fail "no existe el lock $LOCK"
for t in sha256sum dpkg-deb awk; do command -v "$t" >/dev/null || fail "$t no disponible"; done

# Entradas del lock: "sha pkg ver arch tipo" (sin comentarios). Se valida la forma de cada línea.
LOCK_LINES="$(grep -v -E '^[[:space:]]*(#|$)' "$LOCK")"
[ -n "$LOCK_LINES" ] || fail "lock vacío"
while read -r sha pkg ver arch kind extra; do
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || fail "sha256 mal formado en el lock: $sha"
  [ -n "$pkg" ] && [ -n "$ver" ] && [ "$arch" = amd64 ] || fail "línea del lock incompleta: $sha $pkg $ver $arch"
  [ "$kind" = requerido ] || [ "$kind" = dependencia ] || fail "tipo inválido en el lock: $kind"
  [ -z "${extra:-}" ] || fail "campos de más en el lock: $pkg"
done <<< "$LOCK_LINES"
REQUIRED="$(awk '$5=="requerido"{print $2"="$3}' <<< "$LOCK_LINES")"
grep -qx "nftables=.*" <<< "$REQUIRED" || fail "el lock no fija nftables como requerido"

lock_has() { awk -v p="$1" -v v="$2" '$2==p && $3==v {f=1} END {exit f?0:1}' <<< "$LOCK_LINES"; }
lock_sha() { awk -v p="$1" -v v="$2" '$2==p && $3==v {print $1}' <<< "$LOCK_LINES"; }

# Paquetes que apt planifica instalar («Inst pkg [vieja] (nueva …)»): todos deben estar en el lock.
planned() {
  sed -n -E 's/^Inst ([^ ]+) (\[[^]]*\] )?\(([^ ]+) .*/\1=\3/p' "$1"
}
check_plan() {
  local pv
  for pv in $(planned "$1"); do
    lock_has "${pv%%=*}" "${pv#*=}" || fail "el plan de instalación incluye un paquete NO fijado en el lock: $pv"
  done
}

# Verifica que <dir> contenga exactamente los .deb esperados (paquete=versión), con su sha256 del lock.
verify_dir() {
  local dir="$1"; shift
  local expected=" $* " seen=" " f pkg ver arch got want
  shopt -s nullglob
  local debs=("$dir"/*.deb)
  [ "${#debs[@]}" -gt 0 ] || fail "no hay .deb en $dir"
  for f in "${debs[@]}"; do
    pkg="$(dpkg-deb -f "$f" Package)"; ver="$(dpkg-deb -f "$f" Version)"; arch="$(dpkg-deb -f "$f" Architecture)"
    [ "$arch" = amd64 ] || fail "$f: arquitectura $arch"
    case "$expected" in *" $pkg=$ver "*) ;; *) fail "$f ($pkg=$ver) no es un .deb esperado/fijado";; esac
    lock_has "$pkg" "$ver" || fail "$pkg=$ver no está en el lock"
    got="$(sha256sum "$f" | cut -d' ' -f1)"; want="$(lock_sha "$pkg" "$ver")"
    [ "$got" = "$want" ] || fail "sha256 de $pkg=$ver: $got != fijado $want"
    echo "nft-pin: OK $pkg=$ver sha256 $got"
    seen="$seen$pkg=$ver "
  done
  for pv in $expected; do case "$seen" in *" $pv "*) ;; *) fail "falta el .deb de $pv";; esac; done
}

expected_set() { printf '%s\n' $REQUIRED $( [ -n "${1:-}" ] && planned "$1" ) | sort -u | tr '\n' ' '; }

case "${1:-}" in
  verify)
    [ -n "${2:-}" ] && [ -d "$2" ] || fail "uso: nft-pin.sh verify <dir> [<plan>]"
    PLAN="${3:-}"
    if [ -n "$PLAN" ]; then check_plan "$PLAN"; fi
    verify_dir "$2" $(expected_set "$PLAN")
    echo "nft-pin: verificación OK (lock sha256 $(sha256sum "$LOCK" | cut -d' ' -f1))"
    ;;
  install)
    [ "$(id -u)" != 0 ] || fail "ejecuta como usuario sin privilegios (la elevación se limita a dos órdenes fijas)"
    command -v apt-get >/dev/null || fail "apt-get no disponible"
    W="$(mktemp -d)"
    sudo apt-get update -o Acquire::Retries=3
    apt-get install -s --no-install-recommends $(printf '%s ' $REQUIRED) > "$W/plan.txt"
    check_plan "$W/plan.txt"
    mkdir "$W/debs"
    ( cd "$W/debs" && apt-get download $(expected_set "$W/plan.txt") )
    verify_dir "$W/debs" $(expected_set "$W/plan.txt")
    sudo dpkg -i "$W"/debs/*.deb
    for pv in $REQUIRED; do
      got="$(dpkg-query -W -f='${Version}' "${pv%%=*}")"
      [ "$got" = "${pv#*=}" ] || fail "${pv%%=*} instalado $got != fijado ${pv#*=}"
      echo "nft-pin: instalado ${pv%%=*} $got"
    done
    echo "nft-pin: nft --version: $(/usr/sbin/nft --version)"
    echo "nft-pin: lock sha256 $(sha256sum "$LOCK" | cut -d' ' -f1)"
    ;;
  *) fail "uso: nft-pin.sh install | verify <dir> [<plan>]";;
esac
