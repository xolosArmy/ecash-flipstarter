#!/usr/bin/env bash
# PR-6 — parte interna del arnés: ya dentro de unshare --mount --net --pid (namespaces desechables).
# Monta un tmpfs propio, copia el paquete (dist/, node_modules/, test/, package.json) y el binario de
# node, y ejecuta el driver como root del namespace. Todo desaparece al salir.
set -euo pipefail
mount -t tmpfs -o mode=0755,size=1g x402iso "$ISO_STAGE"
mkdir -p "$ISO_STAGE/pkg" "$ISO_STAGE/bin"
for p in dist node_modules test package.json; do cp -a "$ISO_PKG/$p" "$ISO_STAGE/pkg/"; done
cp "$ISO_NODE_SRC" "$ISO_STAGE/bin/node"
chown -R 0:0 "$ISO_STAGE/pkg" "$ISO_STAGE/bin"
chmod -R a+rX,go-w "$ISO_STAGE/pkg" "$ISO_STAGE/bin"
echo "# staging: tmpfs $(findmnt -n -o SOURCE,FSTYPE "$ISO_STAGE" | tr -s ' ')"
echo "# ruleset del netns antes de cargar la política: $("$ISO_NFT" list ruleset | wc -l) líneas"
ISO_ROOT="$ISO_STAGE" ISO_NODE="$ISO_STAGE/bin/node" ISO_NFT="$ISO_NFT" "$ISO_STAGE/bin/node" "$ISO_STAGE/pkg/test/isolation/driver.mjs"
