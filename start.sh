#!/usr/bin/env bash
# Launch the Seeker Discord bot with the whisper sidecar.
set -euo pipefail
cd "$(dirname "$0")"

# Whisper transcription sidecar (faster-whisper, Seeker's venv).
if ! curl -sf -m 2 http://127.0.0.1:18771/health >/dev/null 2>&1; then
  echo "[start] launching whisper sidecar"
  nohup /home/infinite/Projects/seeker/.venv/bin/python transcriber.py 18771 \
    >> /tmp/seeker-transcriber.log 2>&1 &
fi

set -a
. ./.env
set +a
echo "[start] launching bot"
exec node bot.js
