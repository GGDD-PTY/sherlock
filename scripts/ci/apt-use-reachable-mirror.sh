#!/usr/bin/env bash
# Repunta apt a un mirror de Ubuntu alcanzable antes de cualquier `--with-deps`.
#
# El image de los runners Depot trae un mirrorlist (`/etc/apt/apt-mirrors.txt`)
# apuntando a `us-east-1.ec2.archive.ubuntu.com`. Ese host NO es alcanzable
# desde la red de Depot: cada petición de índice termina en `Ign:` tras 20-60s
# de timeout, y apt hace decenas. Medido el 2026-08-18 en el run 32156764741:
# 73 peticiones al mirror EC2 entre 16:00 y 16:40, cero paquetes bajados —
# `playwright install --with-deps` se comió el presupuesto entero del job en
# firefox y en webkit sin llegar a correr un test. Los repos HTTPS de terceros
# (Microsoft, Google, Tailscale) en la MISMA VM responden en milisegundos: el
# problema es el mirror, no el egress.
#
# No subir `timeout-minutes` para esto: un cuelgue consume el presupuesto que
# le des, sea 20 o 40.
#
# Idempotente: no-op en cualquier image cuya config de apt no mencione EC2.
set -euo pipefail

MIRROR='http://archive.ubuntu.com/ubuntu/'
changed=0

if [ -f /etc/apt/apt-mirrors.txt ] && grep -q 'ec2\.archive\.ubuntu\.com' /etc/apt/apt-mirrors.txt; then
  printf '%s\n' "$MIRROR" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
  changed=1
fi

targets=$(grep -rlE 'ec2\.archive\.ubuntu\.com' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null || true)
for f in $targets; do
  sudo sed -i -E "s#https?://[a-z0-9.-]*ec2\.archive\.ubuntu\.com/ubuntu/?#${MIRROR}#g" "$f"
  changed=1
done

if [ "$changed" -eq 1 ]; then
  echo "apt repuntado a ${MIRROR}"
else
  echo "el mirror de apt ya es alcanzable — sin cambios"
fi
