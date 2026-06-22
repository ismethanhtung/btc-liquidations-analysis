#!/usr/bin/env bash
set -euo pipefail

# =========================================================
# BTC Liquidation Lab EC2 Spot Deployment & Realtime Cron Setup
# Run from the repository root with AWS CLI configured.
# =========================================================

# ====== CONFIG ======
REGION="${REGION:-ap-east-1}" # Default: Hong Kong (low latency to VN)
AZ="${AZ:-ap-east-1a}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.medium}" # Cheap ARM64 (2 vCPU / 4 GiB RAM) - perfect for lightweight running
KEY_NAME="${KEY_NAME:-btc-lab-key}"
SG_NAME="${SG_NAME:-btc-lab-sg}"
INSTANCE_NAME="${INSTANCE_NAME:-btc-lab-spot}"
PORT="${PORT:-8787}" # Port to expose the web dashboard
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-20}"

REMOTE_APP_DIR="/opt/btc-lab/app"
REMOTE_ARCHIVE="/tmp/btc-lab.tar.gz"
# ====================

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

generate_worker_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1"
    exit 1
  fi
}

require_cmd aws
require_cmd curl
require_cmd tar
require_cmd ssh
require_cmd scp

# Check that we are running from the repository root
if [[ ! -f package.json || ! -d app ]]; then
  echo "Error: Run this script from the btc-liquidation-lab repository root."
  exit 1
fi

aws configure set region "$REGION"
MY_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '\n')/32"

log "Using region: $REGION"
log "Using AZ: $AZ"
log "Using instance type: $INSTANCE_TYPE"
log "Your IP: $MY_IP"

log "Checking AWS identity..."
aws sts get-caller-identity >/dev/null

log "Finding default VPC..."
VPC_ID="$(aws ec2 describe-vpcs \
  --region "$REGION" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"

if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
  echo "No default VPC found in $REGION."
  exit 1
fi

log "Finding subnet in $AZ..."
SUBNET_ID="$(aws ec2 describe-subnets \
  --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=availability-zone,Values=$AZ" \
  --query 'Subnets[0].SubnetId' \
  --output text)"

if [[ "$SUBNET_ID" == "None" || -z "$SUBNET_ID" ]]; then
  echo "No subnet found in $AZ. Try AZ=ap-east-1b or AZ=ap-east-1c."
  exit 1
fi

log "Creating key pair if needed..."
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  aws ec2 create-key-pair \
    --region "$REGION" \
    --key-name "$KEY_NAME" \
    --query 'KeyMaterial' \
    --output text > "${KEY_NAME}.pem"
  chmod 400 "${KEY_NAME}.pem"
  log "Created local key file: ${KEY_NAME}.pem"
elif [[ ! -f "${KEY_NAME}.pem" ]]; then
  echo "AWS key pair $KEY_NAME exists, but ${KEY_NAME}.pem is not in this folder."
  exit 1
fi

log "Creating/reusing security group..."
SG_ID="$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || true)"

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  SG_ID="$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "BTC Liquidation Lab Security Group" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' \
    --output text)"
fi

log "Allowing SSH and web dashboard port from current IP..."
aws ec2 authorize-security-group-ingress \
  --region "$REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP,Description=SSH from current IP}]" \
  >/dev/null 2>&1 || true
aws ec2 authorize-security-group-ingress \
  --region "$REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=$MY_IP,Description=BTC web UI from current IP}]" \
  >/dev/null 2>&1 || true

# Note: If you want to access the dashboard from anywhere (e.g. mobile), uncomment the line below:
# aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=0.0.0.0/0,Description=Web port open to all}]" >/dev/null 2>&1 || true

log "Finding latest Ubuntu 24.04 ARM64 AMI..."
AMI_ID="$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
    "Name=architecture,Values=arm64" \
    "Name=virtualization-type,Values=hvm" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text)"

if [[ "$AMI_ID" == "None" || -z "$AMI_ID" ]]; then
  echo "Could not find Ubuntu 24.04 ARM64 AMI."
  exit 1
fi

USER_DATA_FILE="$(mktemp)"
cat > "$USER_DATA_FILE" <<'EOF_USERDATA'
#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/btc-lab-user-data.log) 2>&1

while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 3; done

apt-get update -y
apt-get install -y ca-certificates curl gnupg git rsync tar unzip build-essential

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p /opt/btc-lab/app
chown -R ubuntu:ubuntu /opt/btc-lab
EOF_USERDATA

log "Launching EC2 Spot instance..."
INSTANCE_ID="$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_SIZE_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --user-data "file://$USER_DATA_FILE" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Project,Value=btc-lab},{Key=Role,Value=web-server}]" \
  --query 'Instances[0].InstanceId' \
  --output text)"
rm -f "$USER_DATA_FILE"

log "Instance: $INSTANCE_ID"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
sleep 10
PUBLIC_IP="$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -i "${KEY_NAME}.pem")
log "Waiting for SSH..."
for _ in {1..60}; do
  if ssh "${SSH_OPTS[@]}" "ubuntu@$PUBLIC_IP" "true" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

log "Waiting for cloud-init to finish installing dependencies..."
ssh "${SSH_OPTS[@]}" "ubuntu@$PUBLIC_IP" "sudo cloud-init status --wait"

# Load local environment variables from .env to propagate them
ENV_VARS_TO_SYNC=""
if [[ -f .env ]]; then
  log "Reading environment variables from local .env..."
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ ! "$line" =~ ^# && -n "$line" ]]; then
      # Extract key
      key="${line%%=*}"
      val="${line#*=}"
      # Strip outer quotes if any
      val="${val#\"}"
      val="${val%\"}"
      val="${val#\'}"
      val="${val%\'}"
      ENV_VARS_TO_SYNC+="${key}='${val}'"$'\n'
    fi
  done < .env
fi

TMP_ARCHIVE="$(mktemp -t btc-lab.XXXXXX.tar.gz)"
log "Packing current repository into $TMP_ARCHIVE..."
COPYFILE_DISABLE=1 tar \
  --exclude='.git' \
  --exclude='.next' \
  --exclude='node_modules' \
  --exclude='*.pem' \
  --exclude="$TMP_ARCHIVE" \
  -czf "$TMP_ARCHIVE" .

log "Uploading code archive..."
scp "${SSH_OPTS[@]}" "$TMP_ARCHIVE" "ubuntu@$PUBLIC_IP:$REMOTE_ARCHIVE"
rm -f "$TMP_ARCHIVE"

log "Installing dependencies, building and configuring services on EC2..."
ssh "${SSH_OPTS[@]}" "ubuntu@$PUBLIC_IP" \
  "PORT='$PORT' REMOTE_APP_DIR='$REMOTE_APP_DIR' REMOTE_ARCHIVE='$REMOTE_ARCHIVE' ENV_VARS_CONTENT=\"$ENV_VARS_TO_SYNC\" bash -s" <<'EOF_REMOTE'
set -euxo pipefail

sudo rm -rf "$REMOTE_APP_DIR"
sudo mkdir -p "$REMOTE_APP_DIR"
sudo tar -xzf "$REMOTE_ARCHIVE" -C "$REMOTE_APP_DIR"
sudo chown -R ubuntu:ubuntu /opt/btc-lab
cd "$REMOTE_APP_DIR"

# Write environment variables
echo "$ENV_VARS_CONTENT" > .env.production.local
# Expose PORT env var in local file
echo "PORT=$PORT" >> .env.production.local

log_env() {
  echo "Local environment written to .env.production.local"
}
log_env

npm install
npm run build

# Configure systemd service for Next.js app
sudo tee /etc/systemd/system/btc-liquidation-lab.service >/dev/null <<SERVICE
[Unit]
Description=BTC Liquidation Lab Web Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$REMOTE_APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable btc-liquidation-lab
sudo systemctl restart btc-liquidation-lab

# Setup cron job on the EC2 instance to hit the local run API every 5 minutes.
# This keeps the live paper trading updated and collects fresh real-time data continuously.
echo "Setting up crontab on EC2 instance to execute run endpoint every 5 minutes..."
(crontab -l 2>/dev/null | grep -v "/api/phatich5/live-paper/run" || true; echo "*/5 * * * * curl -fsS http://localhost:$PORT/api/phatich5/live-paper/run >> $REMOTE_APP_DIR/data/cron.log 2>&1") | crontab -

EOF_REMOTE

log "Waiting for web server HTTP health check..."
for _ in {1..60}; do
  if curl -fsS "http://$PUBLIC_IP:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

cat <<EOF_DONE

=========================================================
SUCCESSFULLY DEPLOYED TO EC2 SPOT INSTANCE!
=========================================================
Instance ID: $INSTANCE_ID
Public IP: $PUBLIC_IP
Dashboard URL: http://$PUBLIC_IP:$PORT/phatich5
Cron Log: $REMOTE_APP_DIR/data/cron.log
History File: $REMOTE_APP_DIR/data/live-paper-history.json

💡 Dữ liệu hiện tại đang tự động chạy ngầm trên EC2 (cập nhật realtime mỗi 5 phút).
Bạn có thể đóng máy cá nhân của mình hoàn toàn, EC2 sẽ liên tục thu thập và lưu giữ lịch sử.

Để kiểm tra hệ thống trên EC2:
1. Kết nối SSH vào EC2:
   ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP

2. Xem logs dịch vụ Next.js trực tiếp:
   ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP 'sudo journalctl -u btc-liquidation-lab -f'

3. Xem logs cập nhật dữ liệu tự động (cron):
   ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP 'tail -f $REMOTE_APP_DIR/data/cron.log'

4. Ép chạy cập nhật thủ công ngay lập tức:
   curl -fsS http://$PUBLIC_IP:$PORT/api/phatich5/live-paper/run

Chúc bạn giao dịch may mắn!
=========================================================
EOF_DONE
