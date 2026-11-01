#!/usr/bin/env bash
#
# Run Shapeshifter locally in your default browser — no build, no compiler.
#
# Double-click this file in Finder, or run it from a terminal. It serves the
# editor from this folder and opens it. Nothing is uploaded; the server only
# listens on your own machine.
#
# For a proper Mac app with native Open/Save panels instead, build it once:
#     ./macos/build.sh --install

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-5173}"

# Find a free port, in case something already uses this one.
port_busy() {
  if command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 "$1" >/dev/null 2>&1; else return 1; fi
}
while port_busy "$PORT"; do PORT=$((PORT + 1)); done

URL="http://127.0.0.1:$PORT"

start_node()   { node serve.js; }
start_python() { python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1; }

if command -v node >/dev/null 2>&1; then
  echo "Serving Shapeshifter with Node on $URL"
  PORT="$PORT" start_node &
elif command -v python3 >/dev/null 2>&1; then
  echo "Serving Shapeshifter with Python on $URL"
  start_python &
else
  cat <<'MSG'
Neither Node nor Python 3 was found, so there is nothing to serve the files with.

Either install one of them, or build the real Mac app instead — it needs no
server at all:

    ./macos/build.sh --install

MSG
  exit 1
fi

SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Give the server a moment, then open the browser.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null "$URL" 2>/dev/null; then break; fi
  sleep 0.3
done

if command -v open >/dev/null 2>&1; then open "$URL"; else echo "Open $URL in your browser."; fi

echo
echo "Shapeshifter is running. Close this window or press Ctrl-C to stop it."
wait "$SERVER_PID"
