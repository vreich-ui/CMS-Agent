#!/usr/bin/env bash
# Provision the GCE host for the LibreChat cockpit: a single stateful VM plus a
# firewall that exposes ONLY 443, and only to the IP range(s) you allow.
#
# This does NOT deploy LibreChat — it stands up the host. After it finishes, SSH
# in, clone this repo (or copy deploy/librechat/), fill in .env, and run
# `docker compose up -d`. See README.md for the full runbook.
#
# Requires: gcloud CLI authenticated to a project with billing enabled.
# Nothing here runs from the agent sandbox — it is a copy-paste-ready operator script.
set -euo pipefail

# ── Edit these ───────────────────────────────────────────────────────────────
PROJECT="${PROJECT:?export PROJECT=your-gcp-project-id}"
ZONE="${ZONE:-us-central1-a}"
REGION="${REGION:-us-central1}"
VM_NAME="${VM_NAME:-librechat-cockpit}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
DISK_SIZE="${DISK_SIZE:-50GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"
NETWORK_TAG="${NETWORK_TAG:-librechat}"
# Comma-separated CIDRs allowed to reach 443. Set to your office/VPN egress IP(s).
# NEVER leave this as 0.0.0.0/0 for a private cockpit.
ALLOWED_SOURCE_RANGES="${ALLOWED_SOURCE_RANGES:?export ALLOWED_SOURCE_RANGES=203.0.113.10/32}"
STATIC_IP_NAME="${STATIC_IP_NAME:-${VM_NAME}-ip}"
# ─────────────────────────────────────────────────────────────────────────────

gcloud config set project "$PROJECT"

echo "==> Reserving a static external IP ($STATIC_IP_NAME) in $REGION"
gcloud compute addresses create "$STATIC_IP_NAME" --region "$REGION" 2>/dev/null || true
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --region "$REGION" --format='value(address)')"
echo "    Static IP: $STATIC_IP  (create a DNS A record: your DOMAIN -> $STATIC_IP)"

echo "==> Creating firewall rule: allow 443 (+ ICMP) from $ALLOWED_SOURCE_RANGES only"
gcloud compute firewall-rules create "${NETWORK_TAG}-allow-https" \
  --direction=INGRESS --action=ALLOW \
  --rules=tcp:443,udp:443,icmp \
  --source-ranges="$ALLOWED_SOURCE_RANGES" \
  --target-tags="$NETWORK_TAG" 2>/dev/null || \
  echo "    (rule already exists — leaving as is)"

# NOTE on port 80: the default TLS path (Caddy DNS-01) does NOT need inbound 80,
# so we deliberately do not open it. Only if you switch the Caddyfile to the
# HTTP-01 challenge do you need 80 open to 0.0.0.0/0 (Let's Encrypt must reach it):
#   gcloud compute firewall-rules create "${NETWORK_TAG}-allow-acme-http" \
#     --direction=INGRESS --action=ALLOW --rules=tcp:80 \
#     --source-ranges=0.0.0.0/0 --target-tags="$NETWORK_TAG"

# For SSH, prefer IAP TCP forwarding (no public 22) over a broad rule:
#   gcloud compute firewall-rules create "${NETWORK_TAG}-allow-iap-ssh" \
#     --direction=INGRESS --action=ALLOW --rules=tcp:22 \
#     --source-ranges=35.235.240.0/20 --target-tags="$NETWORK_TAG"
# then: gcloud compute ssh "$VM_NAME" --zone "$ZONE" --tunnel-through-iap

echo "==> Creating VM $VM_NAME ($MACHINE_TYPE, $IMAGE_FAMILY, $DISK_SIZE)"
gcloud compute instances create "$VM_NAME" \
  --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" \
  --image-family "$IMAGE_FAMILY" \
  --image-project "$IMAGE_PROJECT" \
  --boot-disk-size "$DISK_SIZE" \
  --boot-disk-type pd-balanced \
  --address "$STATIC_IP" \
  --tags "$NETWORK_TAG" \
  --metadata=startup-script='#!/bin/bash
set -e
# Install Docker Engine + Compose plugin (official convenience script).
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
# Let the default login user run docker without sudo.
for u in $(getent passwd | awk -F: "\$3>=1000 && \$3<65534 {print \$1}"); do
  usermod -aG docker "$u" || true
done'

echo
echo "==> Done."
echo "    1. Point DNS:   <your DOMAIN>  A  ->  $STATIC_IP"
echo "    2. SSH in:      gcloud compute ssh $VM_NAME --zone $ZONE --tunnel-through-iap"
echo "    3. Copy deploy/librechat/ to the VM, create .env, then: docker compose up -d"
echo "    4. Firewall currently allows 443 from: $ALLOWED_SOURCE_RANGES"
