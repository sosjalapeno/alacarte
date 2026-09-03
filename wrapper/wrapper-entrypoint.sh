#!/bin/sh
set -eu

mkdir -p /app/rootfs/etc
cp /etc/resolv.conf /app/rootfs/etc/resolv.conf

exec /app/wrapper "$@"
