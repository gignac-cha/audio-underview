#!/bin/sh
# Starts the Vite dev server of applications/web for the docker environment.
# compose sets the VITE_* variables, the Google client ID among them (GOOGLE_CLIENT_ID of
# docker/.env.docker); variables already in the environment take precedence over the web's .env files.
set -eu

if [ -z "${VITE_GOOGLE_CLIENT_ID:-}" ]; then
  echo "GOOGLE_CLIENT_ID is not set in docker/.env.docker; Google sign-in will not work" >&2
fi

cd /workspace/applications/web
exec node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5174 --strictPort
