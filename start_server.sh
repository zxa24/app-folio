#!/bin/bash
# Start translator webapp server
# Usage: ./start_server.sh [port]
PORT=${1:-8080}
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Starting translator app at http://localhost:$PORT"
echo "Press Ctrl+C to stop"
cd "$DIR" && python3 -m http.server "$PORT"
