#!/bin/sh
set -e

echo "[vidora] Starting bgutil POT provider on :4416 ..."
cd /opt/bgutil/server
node build/main.js --host 127.0.0.1 --port 4416 &
POT_PID=$!

# Give the POT server a moment to bind
sleep 1

if ! kill -0 "$POT_PID" 2>/dev/null; then
  echo "[vidora] WARNING: POT provider failed to start — continuing without it"
else
  echo "[vidora] POT provider ready (pid $POT_PID)"
fi

echo "[vidora] Starting API ..."
cd /app
exec npx tsx src/index.ts
