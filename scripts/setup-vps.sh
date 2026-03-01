#!/usr/bin/env bash
# scripts/setup-vps.sh — One-time VPS provisioning for StreamFlow relay
#
# Usage (run as root on a fresh Ubuntu 22.04+ VPS):
#   bash scripts/setup-vps.sh <your-domain.com> <local-tailscale-machine-name>
#
# Example:
#   bash scripts/setup-vps.sh stream.example.com my-desktop
#
# What this does:
#   1. Installs nginx-full, certbot, Docker, Tailscale
#   2. Creates a non-root deploy user (for GitHub Actions SSH)
#   3. Configures firewall (ufw)
#   4. Deploys nginx/vps.conf with your domain and local machine name substituted
#   5. Obtains a Let's Encrypt TLS certificate
#   6. Clones the repo to /opt/streamflow
#
# After this script completes:
#   - Accept the Tailscale auth prompt to join your tailnet
#   - Run: tailscale ping <local-machine-name>   (should succeed)
#   - Add VPS_HOST, VPS_USER, VPS_SSH_KEY secrets to your GitHub repo
#   - Push to master to trigger CI/CD
set -euo pipefail

DOMAIN="${1:?Usage: $0 <your-domain.com> <local-tailscale-machine-name>}"
LOCAL_MACHINE="${2:?Usage: $0 <your-domain.com> <local-tailscale-machine-name>}"
DEPLOY_USER="deploy"
APP_DIR="/opt/streamflow"
REPO_URL="${REPO_URL:-}"   # set via env or prompted below

# ── Colours ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[setup-vps]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup-vps]${NC} $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash scripts/setup-vps.sh $*"
  exit 1
fi

# ── Step 1: System packages ────────────────────────────────────────────────
info "Installing packages ..."
apt-get update -q
apt-get install -y -q curl git ufw nginx-full certbot python3-certbot-nginx

# ── Step 2: Docker ────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  info "Installing Docker ..."
  curl -fsSL https://get.docker.com | sh
else
  info "Docker already installed"
fi

# ── Step 3: Tailscale ─────────────────────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
  info "Installing Tailscale ..."
  curl -fsSL https://tailscale.com/install.sh | sh
else
  info "Tailscale already installed"
fi
info "Starting Tailscale (follow the auth URL to join your tailnet) ..."
tailscale up

# ── Step 4: Deploy user ───────────────────────────────────────────────────
if ! id "$DEPLOY_USER" &>/dev/null; then
  info "Creating user: $DEPLOY_USER ..."
  useradd -m -s /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

# Set up SSH authorized_keys for GitHub Actions
DEPLOY_SSH_DIR="/home/${DEPLOY_USER}/.ssh"
mkdir -p "$DEPLOY_SSH_DIR"
touch "$DEPLOY_SSH_DIR/authorized_keys"
chmod 700 "$DEPLOY_SSH_DIR"
chmod 600 "$DEPLOY_SSH_DIR/authorized_keys"
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$DEPLOY_SSH_DIR"

warn "Add your GitHub Actions deploy public key to: $DEPLOY_SSH_DIR/authorized_keys"
warn "Generate one with: ssh-keygen -t ed25519 -C 'github-actions-deploy'"

# ── Step 5: Firewall ──────────────────────────────────────────────────────
info "Configuring ufw ..."
ufw allow ssh     > /dev/null
ufw allow 80/tcp  > /dev/null
ufw allow 443/tcp > /dev/null
ufw allow 1935/tcp comment "RTMP ingest"   > /dev/null
ufw allow 8888/tcp comment "HLS playback"  > /dev/null
ufw deny  9997/tcp comment "MediaMTX internal API — never expose" > /dev/null
ufw --force enable > /dev/null
info "Firewall configured"

# ── Step 6: Clone repo ────────────────────────────────────────────────────
if [ -z "$REPO_URL" ]; then
  echo ""
  read -rp "Enter your GitHub repo URL (e.g. https://github.com/owner/streamflow): " REPO_URL
fi

if [ ! -d "$APP_DIR/.git" ]; then
  info "Cloning repo to $APP_DIR ..."
  git clone "$REPO_URL" "$APP_DIR"
else
  info "Repo already cloned — pulling latest ..."
  git -C "$APP_DIR" pull
fi
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$APP_DIR"

# ── Step 7: Deploy nginx config ────────────────────────────────────────────
info "Deploying nginx config ..."
cp "$APP_DIR/nginx/vps.conf" /etc/nginx/sites-available/streamflow
sed -i "s/YOUR_DOMAIN/${DOMAIN}/g"           /etc/nginx/sites-available/streamflow
sed -i "s/LOCAL_MACHINE_NAME/${LOCAL_MACHINE}/g" /etc/nginx/sites-available/streamflow

ln -sf /etc/nginx/sites-available/streamflow /etc/nginx/sites-enabled/streamflow
rm -f /etc/nginx/sites-enabled/default   # remove default placeholder site

nginx -t

# ── Step 8: TLS certificate ───────────────────────────────────────────────
info "Obtaining Let's Encrypt certificate for ${DOMAIN} ..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}"

systemctl reload nginx
info "nginx reloaded"

# ── Step 9: .env for local machine ────────────────────────────────────────
warn "On your LOCAL machine, add to .env:"
warn "  GITHUB_REPOSITORY=<owner>/<repo>   (lowercase, e.g. kevinch3/streamflow)"
warn "  IMAGE_TAG=latest"

# ── Step 10: Summary ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}VPS setup complete!${NC}"
echo ""
echo "  Dashboard:   https://${DOMAIN}"
echo "  RTMP ingest: rtmp://${DOMAIN}:1935/live"
echo "  HLS:         http://${DOMAIN}:8888/live/<key>/index.m3u8"
echo ""
echo "Next steps:"
echo "  1. Verify Tailscale: tailscale ping ${LOCAL_MACHINE}"
echo "  2. Add deploy public key to: $DEPLOY_SSH_DIR/authorized_keys"
echo "  3. Add GitHub secrets: VPS_HOST, VPS_USER, VPS_SSH_KEY"
echo "  4. Push to master to trigger CI/CD"
echo ""
