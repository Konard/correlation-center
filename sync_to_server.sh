#!/usr/bin/env bash
set -euo pipefail

# Determine script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables from .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
else
  echo "Error: .env file not found in $SCRIPT_DIR"
  exit 1
fi

# Check required variables
: "${RSYNC_USER:?Environment variable RSYNC_USER not set}"
: "${RSYNC_HOST:?Environment variable RSYNC_HOST not set}"
: "${RSYNC_PORT:?Environment variable RSYNC_PORT not set}"
: "${RSYNC_DEST:?Environment variable RSYNC_DEST not set}"
# Optional: path to SSH private key (uncomment if needed)
# SSH_KEY_PATH=/path/to/your/private/key

# Optional: password for SSH authentication (uncomment if using sshpass)
# RSYNC_PASSWORD=your_ssh_password

# Build SSH command with key or password
SSH_OPTIONS=(-p "${RSYNC_PORT}")
if [ -n "${SSH_KEY_PATH:-}" ]; then
  SSH_OPTIONS+=(-i "${SSH_KEY_PATH}")
fi

if [ -n "${RSYNC_PASSWORD:-}" ]; then
  # Use sshpass for password-based SSH
  SSH_CMD="sshpass -p \"${RSYNC_PASSWORD}\" ssh ${SSH_OPTIONS[*]}"
else
  # Use standard SSH (key or agent)
  SSH_CMD="ssh ${SSH_OPTIONS[*]}"
fi

# Perform rsync over SSH
rsync -avz --progress -e "${SSH_CMD}" \
  "${SCRIPT_DIR}/.env" \
  "${SCRIPT_DIR}/db.json" \
  "${RSYNC_USER}@${RSYNC_HOST}:${RSYNC_DEST}"

echo "Rsync of .env and db.json to ${RSYNC_HOST} completed successfully." 