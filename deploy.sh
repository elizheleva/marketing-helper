#!/bin/bash
# Deploy Marketing Helper backend to VPS
# Run on server: cd /root/express-api && ./deploy.sh
# Or from local: ssh root@46.202.194.179 "cd /root/express-api && ./deploy.sh"

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo ">>> Pulling latest from GitHub..."
git pull origin main

echo ">>> Building and restarting express-api..."
cd /root
docker compose build express-api --no-cache
docker compose up -d express-api

echo ">>> Waiting for container to start..."
sleep 5

echo ">>> Checking version..."
curl -s https://api.uspeh.co.uk/api/version 2>/dev/null || echo "(check https://api.uspeh.co.uk/api/version in browser)"

echo ""
echo ">>> Deploy complete."
