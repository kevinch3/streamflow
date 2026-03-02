#!/usr/bin/env bash
# scripts/setup.sh — First-time LAN setup for StreamFlow
# Idempotent: safe to run multiple times.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Colours ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*" >&2; }

# ── Step 1: Verify Docker is available ────────────────────────────────────
if ! docker info > /dev/null 2>&1; then
  error "Docker is not running. Start Docker and try again."
  exit 1
fi
if ! docker compose version > /dev/null 2>&1; then
  error "Docker Compose v2 is required (docker compose, not docker-compose)."
  exit 1
fi
info "Docker OK"

# ── Step 2: Generate .env if it doesn't exist ─────────────────────────────
ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — skipping secret generation"
else
  info "Creating .env from .env.example ..."
  cp "$ROOT/.env.example" "$ENV_FILE"

  TOKEN="$(openssl rand -base64 28)"
  RTMP_KEY="$(openssl rand -base64 21)"

  sed -i "s|^STREAM_API_TOKEN=.*|STREAM_API_TOKEN=${TOKEN}|" "$ENV_FILE"
  sed -i "s|^RTMP_PUBLISH_KEY=.*|RTMP_PUBLISH_KEY=${RTMP_KEY}|" "$ENV_FILE"

  info "Generated STREAM_API_TOKEN and RTMP_PUBLISH_KEY"
fi

# ── Step 3: Detect LAN IP ──────────────────────────────────────────────────
LAN_IP="$(ip route get 1 2>/dev/null | awk '{print $7; exit}')"
if [ -z "$LAN_IP" ]; then
  warn "Could not detect LAN IP automatically"
  LAN_IP="<your-machine-ip>"
fi

# ── Step 4: Configure firewall (optional, gated on ufw/firewalld presence) ─
if command -v ufw > /dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Configuring ufw firewall rules ..."
  sudo ufw allow 80/tcp   comment "StreamFlow dashboard"  > /dev/null
  sudo ufw allow 1935/tcp comment "RTMP ingest"           > /dev/null
  sudo ufw allow 8888/tcp comment "HLS playback"          > /dev/null
  sudo ufw deny  9997/tcp comment "MediaMTX internal API" > /dev/null
  info "ufw rules applied"
elif command -v firewall-cmd > /dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  info "Configuring firewalld rules ..."
  sudo firewall-cmd --permanent --add-port=80/tcp    > /dev/null
  sudo firewall-cmd --permanent --add-port=1935/tcp  > /dev/null
  sudo firewall-cmd --permanent --add-port=8888/tcp  > /dev/null
  sudo firewall-cmd --reload                         > /dev/null
  info "firewalld rules applied"
else
  warn "No active firewall detected — skipping firewall config"
  warn "Manually open ports 80, 1935, 8888 if needed, and block 9997"
fi

# ── Step 5: Summary ────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "  Dashboard:   http://${LAN_IP}:8080"
echo "  RTMP ingest: rtmp://${LAN_IP}:1935/live"
echo "  HLS:         http://${LAN_IP}:8888/live/<stream-key>/index.m3u8"
echo ""
echo "Next steps:"
echo "  1. make up          — build and start StreamFlow"
echo "  2. make status      — get the API token for dashboard login"
echo "  3. Open http://${LAN_IP} in your browser"
echo ""
