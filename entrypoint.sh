#!/bin/sh
set -e

echo "[entrypoint] starting Xvfb virtual display on :99 ..."
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &

# Wait for the X socket to appear (max ~10s)
i=0
while [ "$i" -lt 20 ]; do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.5
  i=$((i + 1))
done

if [ -e /tmp/.X11-unix/X99 ]; then
  echo "[entrypoint] virtual display ready"
else
  echo "[entrypoint] WARNING: X display socket not found, continuing anyway"
fi

export DISPLAY=:99
echo "[entrypoint] DISPLAY=$DISPLAY — starting node ..."
exec node dist/api/index.js
